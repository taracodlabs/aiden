/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * tools/v4/subagent/subagentFanout.ts — v4.11 Slice 4 facade.
 *
 * Thin LLM-callable wrapper for `subagent_fanout`. After Slice 4 the
 * orchestration (concurrency, ordering, cancellation, cost rollup)
 * lives in `SubagentCoordinator`; this file owns:
 *
 *   1. JSON-schema declaration (model-facing surface — unchanged)
 *   2. Operator pause gate (v4.6 Phase 3A)
 *   3. Arg validation + coercion into `SubagentTask[]`
 *   4. Provider-rotation hint (per-task provider override)
 *   5. Delegation to `SubagentCoordinator.spawnBatch`
 *   6. Optional aggregator merge via the existing `mergeResults`
 *   7. Re-shape into the legacy fanout return body
 *
 * The N-children Promise.all that lived here pre-Slice-4 is gone;
 * the coordinator owns it. The `runFanout` orchestrator in
 * `core/v4/subagent/fanout.ts` stays available for the operator CLI
 * (`aiden fanout`) — that path will migrate in a follow-up slice.
 *
 * Self-reports lesson preserved verbatim in the schema description:
 * children's tool-call CLAIMS are not verified facts — the parent
 * agent must verify side-effects independently.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { ProviderAdapter } from '../../../providers/v4/types';
import type { Logger } from '../../../core/v4/logger/logger';
import { noopLogger } from '../../../core/v4/logger/factory';
import type { TurnRuntimeContext } from '../../../core/v4/turnRuntimeContext';
import type {
  SubagentCoordinator,
  SubagentTask,
  SubagentResultEnvelope,
} from '../../../core/v4/subagent/coordinator';
import {
  mergeResults,
  resolveAggregatorOverride,
  type MergeStrategy,
  type SubagentResult as MergerSubagentResult,
} from '../../../core/v4/subagent/merger';
import {
  rotateProviders,
  type ProviderOption,
} from '../../../core/v4/subagent/providerRotation';
import { AIDEN_SUBAGENT_BUILD, type FanoutDiagnostics } from '../../../core/v4/subagent/diagnostics';
import { getSpawnPause } from '../../../core/v4/subagent/spawnPause';

// ── Factory inputs ────────────────────────────────────────────────────────

export interface SubagentFanoutFactoryOptions {
  /**
   * Read at handler entry to resolve the live TurnRuntimeContext.
   * REPL passes `() => agent.getCurrentTurnContext()`; MCP / other
   * surfaces mint a fresh per-request context. Returning `undefined`
   * fails the call with a structured envelope.
   */
  resolveTurnContext: () => TurnRuntimeContext | undefined;
  /** Shared coordinator instance — owns all orchestration. */
  coordinator: SubagentCoordinator;
  /** Resolves provider options at call time — env may change since boot. */
  resolveProviders: () => ProviderOption[];
  /** Parent's active model — default aggregator. */
  resolveActiveModel: () => { providerId: string; modelId: string };
  /** Adapter used for aggregator calls (single-shot, no agent loop). */
  aggregatorAdapter: ProviderAdapter;
  /** Optional logger — defaults to noop. */
  logger?: Logger;
}

// ── Schema ────────────────────────────────────────────────────────────────
//
// v4.11 hi-budget fix — description compression. Per-param prose
// trimmed to operational facts; enums + required + types unchanged.
// Self-report verification warning is preserved (it's the load-bearing
// safety note — children's tool-call claims need parent verification).

const SCHEMA_DESC =
  'Spawn N parallel children against the same problem (ensemble) or partitioned tasks, ' +
  'then merge via chosen strategy. Use for multi-perspective research or N independent ' +
  'inputs in parallel. WARNING: child self-reports are not verified — if a child claims ' +
  'a side-effect (file write, command run), you MUST verify independently.';

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
              "'partition' = each child gets a different goal from `tasks`; " +
              "'ensemble' = every child gets the same `query`.",
            enum: ['partition', 'ensemble'],
          },
          n: {
            type: 'number',
            description: 'Children to spawn. Default 3, hard cap 5.',
          },
          query: {
            type: 'string',
            description: 'Shared input for every child (ensemble mode only).',
          },
          tasks: {
            type: 'array',
            description:
              'Per-child task list (partition mode only). Length must equal n.',
            items: {
              type: 'object',
              description: 'One unit of work for a partition-mode child.',
              properties: {
                goal:    { type: 'string', description: 'Task this child accomplishes.' },
                context: { type: 'string', description: 'Optional shared context.' },
                role:    { type: 'string', description: 'Optional role tag (diagnostic).' },
              },
              required: ['goal'],
            },
          },
          merge: {
            type: 'string',
            description:
              "'all' = raw N results, no aggregator. " +
              "'vote' = LLM picks one verbatim (+1 call). " +
              "'pick-best' = LLM picks one with reasoning (+1 call). " +
              "'combine' = LLM synthesizes unified answer (+1 call).",
            enum: ['all', 'vote', 'pick-best', 'combine'],
          },
          timeoutMs: {
            type: 'number',
            description:
              'Per-child wall-clock timeout (ms). Default 600000 (10 min); ' +
              'env AIDEN_SUBAGENT_TIMEOUT_MS overrides default; this field ' +
              'overrides both.',
          },
        },
        required: ['mode'],
      },
    },
    category: 'network',
    mutates:  false,
    toolset:  'subagent',
    riskTier: 'caution',

    async execute(args, _ctx) {
      // ── Operator kill-switch (v4.6 Phase 3A — unchanged) ────────────
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
      } catch { /* not initialised — let dispatch proceed */ }

      const logger = factory.logger ?? noopLogger();

      // ── Args ────────────────────────────────────────────────────────
      const mode = (args.mode === 'partition' || args.mode === 'ensemble')
        ? (args.mode as 'partition' | 'ensemble')
        : null;
      if (!mode) {
        return { success: false, error: "subagent_fanout: 'mode' must be 'partition' or 'ensemble'" };
      }
      const n = typeof args.n === 'number' && Number.isInteger(args.n) ? args.n : 3;
      const merge: MergeStrategy =
        (args.merge === 'all' || args.merge === 'vote'
          || args.merge === 'pick-best' || args.merge === 'combine')
          ? (args.merge as MergeStrategy) : 'combine';
      const query = typeof args.query === 'string' ? args.query : undefined;
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : undefined;
      const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
        ? args.timeoutMs : undefined;

      if (mode === 'ensemble' && !query) {
        return { success: false, error: 'subagent_fanout: ensemble mode requires a `query`' };
      }
      if (mode === 'partition' && (!rawTasks || rawTasks.length === 0)) {
        return { success: false, error: 'subagent_fanout: partition mode requires `tasks[]`' };
      }
      if (mode === 'partition' && rawTasks!.length !== n) {
        return {
          success: false,
          error: `subagent_fanout: partition tasks.length (${rawTasks!.length}) must equal n (${n})`,
        };
      }

      // ── Provider rotation hint ─────────────────────────────────────
      const providers = factory.resolveProviders();
      if (providers.length === 0) {
        return {
          success: false,
          error: 'subagent_fanout: no providers configured — run `aiden setup` first',
        };
      }
      const rotation = rotateProviders(n, providers);
      if (rotation.singleProviderWarning) {
        logger.warn?.('subagent_fanout: single-provider fanout — diversity ≈ temperature variation',
          { providers: providers.length, n });
      }

      // ── Turn context (live, Flag 1) ────────────────────────────────
      const turnContext = factory.resolveTurnContext();
      if (!turnContext) {
        return {
          success: false,
          error:
            'subagent_fanout: no active TurnRuntimeContext — ' +
            'caller must construct one in runConversation options (v4.11 Slice 4).',
        };
      }

      // ── Build coordinator tasks ────────────────────────────────────
      const tasks: SubagentTask[] = [];
      for (let i = 0; i < n; i += 1) {
        const provider = rotation.assignments[i]!;
        const partitionTask = mode === 'partition'
          ? (rawTasks![i] as { goal: string; context?: string; role?: string })
          : null;
        const goal = mode === 'ensemble' ? query! : partitionTask!.goal;
        const role = partitionTask?.role;
        tasks.push({
          // Prepend role tag when present so the child's system prompt
          // carries it (mirrors the pre-Slice-4 `runFanout` shape).
          goal:     role ? `[role: ${role}] ${goal}` : goal,
          context:  partitionTask?.context,
          timeoutMs,
          // Only forward per-spawn provider override when rotation has
          // real diversity — single-provider pools trip the v4.6 Phase
          // 2P "single-provider configuration" rejection in non-
          // FallbackAdapter parents. Mirrors the pre-Slice-4 guard
          // (`fanout.ts:318-325`).
          provider: rotation.singleProviderWarning ? undefined : provider.providerId,
          role,
        });
      }

      logger.info?.('subagent_fanout: dispatching to coordinator', {
        build: AIDEN_SUBAGENT_BUILD,
        mode, n, merge,
        singleProviderWarning: rotation.singleProviderWarning,
      });

      // ── Delegate to coordinator ────────────────────────────────────
      const startedAt = Date.now();
      const fanout    = await factory.coordinator.spawnBatch(turnContext, tasks, 'bestEffort');
      const totalMs   = Date.now() - startedAt;

      // ── Optional aggregator merge ──────────────────────────────────
      // Reuse the existing single-shot merger — no agent loop, just a
      // text-in / text-out judge call. Only completed children with
      // non-empty summaries are usable; failures land as
      // `output: ''` so the merger filters them out (same shape as
      // v4.6).
      const mergerInput: MergerSubagentResult[] = fanout.results.map((env) => ({
        index:      env.taskIndex,
        providerId: env.provider,
        modelId:    env.model,
        output:     env.status === 'completed' ? env.summary : '',
        error:      env.error,
        elapsedMs:  env.durationMs,
      }));
      const aggOverride     = resolveAggregatorOverride();
      const aggregatorModel = aggOverride ?? factory.resolveActiveModel();
      const userQuery       = mode === 'ensemble'
        ? query!
        : rawTasks!.map((t, i) => `(${i + 1}) ${(t as { goal: string }).goal}`).join('\n');

      const mergeOutput = await mergeResults(mergerInput, {
        strategy:          merge,
        aggregatorAdapter: factory.aggregatorAdapter,
        aggregatorModel,
        userQuery,
        logger,
        signal:            turnContext.signal,
      });

      // ── Diagnostics (mirrors the pre-Slice-4 shape) ────────────────
      const diagnostics: FanoutDiagnostics = {
        build:                 AIDEN_SUBAGENT_BUILD,
        launched:              fanout.results.length,
        succeeded:             fanout.results.filter((r) => r.status === 'completed' && r.summary.length > 0).length,
        failed:                fanout.results.filter((r) => r.status !== 'completed' || r.summary.length === 0).length,
        totalMs,
        perSubagentMs:         fanout.results.map((r) => r.durationMs),
        providerDistribution:  fanout.results.map((r) => r.provider),
        singleProviderWarning: rotation.singleProviderWarning,
        aggregator:            mergeOutput.aggregator,
      };

      return {
        success:     true,
        merged:      mergeOutput.merged,
        results:     fanout.results.map(envelopeToLegacyChild),
        diagnostics,
      };
    },
  };
}

/**
 * Re-shape a coordinator envelope into the legacy `SubagentResult`
 * the v4.1-subagent fanout return body carried. The model's downstream
 * synthesis prompts have been seeing this shape since the
 * v4.1-subagent ship; preserving it keeps the Slice 4 refactor
 * model-transparent.
 */
function envelopeToLegacyChild(env: SubagentResultEnvelope): {
  index:      number;
  providerId: string;
  modelId:    string;
  output:     string;
  error?:     string;
  elapsedMs:  number;
} {
  return {
    index:      env.taskIndex,
    providerId: env.provider,
    modelId:    env.model,
    output:     env.status === 'completed' ? env.summary : '',
    error:      env.error,
    elapsedMs:  env.durationMs,
  };
}
