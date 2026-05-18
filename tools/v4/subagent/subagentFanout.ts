/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/subagent/subagentFanout.ts — `subagent_fanout` wrapper.
 *
 * Phase v4.1-subagent. Spawns N parallel agent instances against the
 * same problem (or a partition of it), then merges results via the
 * chosen strategy. The orchestrator lives at
 * `core/v4/subagent/fanout.ts`; this file is the agent-callable
 * adapter that:
 *
 *   1. Validates the LLM's call args against the schema.
 *   2. Builds a per-child runner (closure over the parent runtime)
 *      that wraps an AidenAgent run.
 *   3. Filters mutating tools out of each child's schema array
 *      unless `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1`.
 *   4. Returns the merged output + raw N results + diagnostics.
 *
 * The factory pattern (`makeSubagentFanoutTool`) mirrors
 * `lookup_tool_schema` — the runtime constructs it with a closure
 * over registry / providers / paths that the schema can't carry.
 *
 * Tool category is `network` not `write` — the tool itself doesn't
 * touch disk; it only spends LLM tokens. That keeps it default-
 * exposed in MCP under the read-only env (mutates: false).
 *
 * The description bakes a hard-learned lesson from prior multi-agent
 * systems: "Self-reports are not verified facts" — the parent must
 * verify any side-effects children report rather than trust the
 * summary. Children's tool calls are executed in isolated contexts;
 * a child claiming "wrote file X" or "ran command Y" must be
 * verified by the parent before the parent acts on that claim.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { ProviderAdapter } from '../../../providers/v4/types';
import type { Logger } from '../../../core/v4/logger/logger';
import { noopLogger } from '../../../core/v4/logger/factory';
import {
  runFanout,
  type FanoutMode,
  type FanoutOptions,
  type PartitionTask,
} from '../../../core/v4/subagent/fanout';
import {
  resolveAggregatorOverride,
  type MergeStrategy,
} from '../../../core/v4/subagent/merger';
import type { ProviderOption } from '../../../core/v4/subagent/providerRotation';
import type { SpawnSubAgentDeps } from '../../../core/v4/subagent/spawnSubAgent';
// v4.6 Phase 3A — operator kill-switch. Same check the
// `spawn_sub_agent` tool runs, applied here at fanout's handler
// entry. Locked decision (§12): check ONCE at entry, not inside
// the spawn loop — atomicity is per-call. A pause applied
// mid-fanout leaves the in-flight Promise.all to complete
// naturally; only the NEXT fanout call hits the rejection.
import { getSpawnPause } from '../../../core/v4/subagent/spawnPause';

/** Caller-supplied factory inputs. The runtime supplies these once at
 *  boot from the closure scope (provider list, parent's active model,
 *  aggregator adapter, run-child callback). */
export interface SubagentFanoutFactoryOptions {
  /** Resolves provider options at call time — env may have changed
   *  since boot. Caller is the runtime; production reads
   *  `config.yaml` + env. */
  resolveProviders: () => ProviderOption[];
  /** Resolves the parent's active model — used as default aggregator
   *  unless `AIDEN_SUBAGENT_AGGREGATOR_MODEL` overrides. */
  resolveActiveModel: () => { providerId: string; modelId: string };
  /** Adapter used for aggregator calls. Production threads the
   *  parent's adapter; tests inject a stub. */
  aggregatorAdapter: ProviderAdapter;
  /**
   * v4.6 Phase 2Q-A — deps for `spawnSubAgent` (the primitive the
   * fanout layer calls N times). Same shape as
   * `SpawnSubAgentFactoryOptions extends SpawnSubAgentDeps` in
   * `spawnSubAgentTool.ts`. Production wires this from REPL boot.
   *
   * OPTIONAL at construction time so the boot-time stub (registered
   * in `tools/v4/index.ts` before the runtime resolves real deps)
   * can be created without fabricating placeholder deps. The handler
   * fails loudly with a clear "tool not wired" error if `spawnDeps`
   * is missing AND `resolveProviders()` returns providers — which
   * only happens with a half-wired runtime.
   */
  spawnDeps?: SpawnSubAgentDeps;
  /**
   * v4.6 Phase 2Q — optional resolver for the parent's current
   * `runs.id`. Mirror of `SpawnSubAgentFactoryOptions.resolveParentRunId`.
   * Called at handler-dispatch time so REPL turns can populate
   * child rows' `spawned_from_run_id` link.
   */
  resolveParentRunId?:     () => number | undefined;
  /**
   * v4.6 Phase 2Q — optional resolver for the parent's session id.
   * Mirror of `SpawnSubAgentFactoryOptions.resolveParentSessionId`.
   */
  resolveParentSessionId?: () => string | undefined;
  /** Optional logger — defaults to noop. */
  logger?: Logger;
}

const SCHEMA_DESC =
  'Spawn N parallel agent children against the same problem (ensemble) or a partitioned task list, ' +
  'then merge results via the chosen strategy. Use this for multi-perspective research, ' +
  'provider-diverse fact-checking, or analyzing N independent inputs in parallel. ' +
  'IMPORTANT: self-reports from children are not verified facts — if a child claims it ' +
  'wrote a file, ran a command, or completed a side-effect, you (the parent) MUST verify ' +
  'independently before trusting that claim.';

export function makeSubagentFanoutTool(
  factory: SubagentFanoutFactoryOptions,
): ToolHandler {
  return {
    schema: {
      name: 'subagent_fanout',
      description: SCHEMA_DESC,
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            description:
              "'partition' = each child gets a different goal from `tasks`. " +
              "'ensemble' = every child gets the same `query`.",
            enum: ['partition', 'ensemble'],
          },
          n: {
            type: 'number',
            description:
              'Number of children to spawn. Default 3, hard cap 5. ' +
              'Higher N hits provider RPM limits and inflates tail latency.',
          },
          query: {
            type: 'string',
            description:
              'Same input given to every child (ensemble mode only).',
          },
          tasks: {
            type: 'array',
            description:
              'Per-child task list (partition mode only). Length must equal n.',
            // Schema mirrors PartitionTask interface in
            // core/v4/subagent/fanout.ts:70-75. If you change one, change
            // the other. OpenAI Codex backend strictly validates schemas
            // and rejects `type: "array"` declarations missing `items`,
            // so the inner shape must be explicit here.
            items: {
              type: 'object',
              description: 'One unit of work for a partition-mode child.',
              properties: {
                goal: {
                  type: 'string',
                  description:
                    'The task this child should accomplish.',
                },
                context: {
                  type: 'string',
                  description:
                    'Optional shared context for the child.',
                },
                role: {
                  type: 'string',
                  description:
                    'Optional role tag, diagnostic only.',
                },
              },
              required: ['goal'],
            },
          },
          merge: {
            type: 'string',
            description:
              "'all' = return raw N results, no aggregator (FREE). " +
              "'vote' = LLM judge picks one verbatim (+1 call). " +
              "'pick-best' = LLM judge picks one with reasoning (+1 call). " +
              "'combine' = LLM synthesizes one unified answer (+1 call).",
            enum: ['all', 'vote', 'pick-best', 'combine'],
          },
          timeoutMs: {
            type: 'number',
            description:
              'Per-child wall-clock timeout (ms). Default 90000. ' +
              'Outer wall-clock cap is 5x this value.',
          },
        },
        required: ['mode'],
      },
    },
    // mutates: false because the tool itself only spends tokens — disk /
    // process side-effects, if any, happen INSIDE child agents whose
    // toolsets are filtered to read-only by default. This keeps the
    // tool default-exposed in MCP under the read-only env.
    category: 'network',
    mutates: false,
    toolset: 'subagent',
  riskTier: 'caution',   // v4.4 Phase 1
    async execute(args, _ctx) {
      // ── Operator kill-switch (v4.6 Phase 3A) ────────────────────
      // Top of handler — before parsing, provider resolution, or
      // rotation. Reject the WHOLE call if paused; spawn loop never
      // fires, so partial fanouts are impossible.
      try {
        const pauseStatus = getSpawnPause().status();
        if (pauseStatus.paused) {
          const reasonSuffix = pauseStatus.reason ? ` (reason: ${pauseStatus.reason})` : '';
          return {
            success:    false,
            errorCode:  'SUBAGENT_SPAWN_PAUSED',
            message:
              `subagent_fanout: spawning is paused${reasonSuffix}. ` +
              'Run /spawn-pause off to resume.',
            pausedAt:   pauseStatus.pausedAt   ?? null,
            reason:     pauseStatus.reason     ?? null,
            pausedBy:   pauseStatus.pausedBy   ?? null,
            durationMs: pauseStatus.durationMs ?? null,
          };
        }
      } catch {
        // getSpawnPause() throws when not initialized — let the
        // fanout proceed rather than blocking on a wiring bug.
        // Production boot always inits before any tool handler
        // can fire; this catch only matters for unit tests.
      }

      const logger = factory.logger ?? noopLogger();

      // ── Coerce args ────────────────────────────────────────────
      const mode = (args.mode === 'partition' || args.mode === 'ensemble')
        ? args.mode as FanoutMode
        : null;
      if (!mode) {
        return {
          success: false,
          error: "subagent_fanout: 'mode' must be 'partition' or 'ensemble'",
        };
      }

      const n = typeof args.n === 'number' && Number.isInteger(args.n)
        ? args.n
        : 3;
      const merge: MergeStrategy =
        (args.merge === 'all' || args.merge === 'vote'
          || args.merge === 'pick-best' || args.merge === 'combine')
          ? args.merge as MergeStrategy
          : 'combine';

      const query  = typeof args.query === 'string' ? args.query : undefined;
      const tasks  = Array.isArray(args.tasks)
        ? (args.tasks as PartitionTask[])
        : undefined;
      const timeoutMs = typeof args.timeoutMs === 'number'
        && args.timeoutMs > 0
        ? args.timeoutMs
        : undefined;

      // ── Resolve providers + aggregator at call time ───────────
      const providers = factory.resolveProviders();
      if (providers.length === 0) {
        return {
          success: false,
          error: 'subagent_fanout: no providers configured — run `aiden setup` first',
        };
      }

      const aggOverride = resolveAggregatorOverride();
      const aggregatorModel = aggOverride ?? factory.resolveActiveModel();

      // v4.6 Phase 2Q — spawnDeps absent means we're still bound to
      // the boot-time stub (the runtime hasn't replaced the
      // registration with the real factory yet). Surface the same
      // "tool not wired" failure shape MCP / REPL surface in their
      // own pre-wired states.
      if (!factory.spawnDeps) {
        return {
          success: false,
          error:
            'subagent_fanout: tool not wired — runtime did not supply spawnDeps. ' +
            'Call register(makeSubagentFanoutTool({...spawnDeps})) after buildAgentRuntime.',
        };
      }

      // v4.6 Phase 2Q — resolve parent identity at dispatch time so
      // REPL turns that opened a run row between boot and now still
      // link children to the right parent.
      const parentRunId     = factory.resolveParentRunId?.();
      const parentSessionId = factory.resolveParentSessionId?.();

      const fanoutOpts: FanoutOptions = {
        mode,
        query,
        tasks,
        n,
        merge,
        providers,
        spawnDeps:          factory.spawnDeps,
        parentRunId,
        parentSessionId,
        aggregatorAdapter:  factory.aggregatorAdapter,
        aggregatorModel,
        timeoutMs,
        logger,
      };

      try {
        const result = await runFanout(fanoutOpts);
        return {
          success:    true,
          merged:     result.merged,
          results:    result.results,
          diagnostics: result.diagnostics,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    },
  };
}
