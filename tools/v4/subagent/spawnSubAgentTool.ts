/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/subagent/spawnSubAgentTool.ts — v4.6 Phase 1.
 *
 * LLM-callable wrapper for the `spawn_sub_agent` primitive. JSON
 * schema and description text are verbatim from
 * `docs/v4.6/phase-1-design.md` §4. The handler:
 *
 *   1. Reads the parent agent's current AbortSignal via the
 *      Flag 1 pattern (`parentAgent.getCurrentSignal()` captured
 *      reference, not a widened executor signature).
 *   2. Validates and clamps arguments.
 *   3. Calls `spawnSubAgent` from `core/v4/subagent/spawnSubAgent.ts`.
 *   4. Returns the result envelope as the tool result body.
 *
 * Q9 — additive to the existing `subagent_fanout` tool. Both
 * coexist in Phase 1; Phase 2 will refactor `subagent_fanout` to
 * call this primitive N times.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { ToolSchema } from '../../../providers/v4/types';
import type { AidenAgent } from '../../../core/v4/aidenAgent';
import type { Logger } from '../../../core/v4/logger/logger';
import { noopLogger } from '../../../core/v4/logger/factory';
import {
  spawnSubAgent,
  type SubAgentSpec,
  type SpawnSubAgentDeps,
} from '../../../core/v4/subagent/spawnSubAgent';
// v4.6 Phase 3A — operator kill-switch. Checked at handler entry
// BEFORE any work (no run row written, no child built, no provider
// call). In-flight children continue uninterrupted; only NEW spawns
// are blocked. Singleton initialised by REPL/daemon/MCP boot wiring.
import { getSpawnPause } from '../../../core/v4/subagent/spawnPause';

// ── Factory dependencies ───────────────────────────────────────────────────

/**
 * Factory inputs the runtime supplies once at REPL bootstrap. The
 * parent agent reference is captured here so the handler can read the
 * current signal at dispatch time (Flag 1 pattern, locked in Dispatch
 * 2D / 2E spec).
 */
export interface SpawnSubAgentFactoryOptions extends SpawnSubAgentDeps {
  /**
   * The parent agent whose `runConversation` invokes this tool.
   * Captured at factory construction; the handler reads
   * `parentAgent.getCurrentSignal()` to wire the child's cancellation
   * chain to the parent's in-flight signal.
   */
  parentAgent: AidenAgent;
  /**
   * Optional parent run identifier — populated when the parent's turn
   * has a `runs` row written (daemon-fired turns always; REPL turns
   * may not). When set, the child's `spawned_from_run_id` points here.
   */
  resolveParentRunId?: () => number | undefined;
  /**
   * Optional parent session identifier. When set, the child's
   * `spawned_from_session_id` is populated with this value.
   */
  resolveParentSessionId?: () => string | undefined;
  /**
   * v4.6 Phase 1 observability — optional logger for the spawn
   * tool's own info-level traces (parsed spec at invocation,
   * child-built confirmation, completion summary). Plumbed into
   * `spawnSubAgent` so internal stages can also log. Defaults to
   * `noopLogger()` — REPL wiring at `cli/v4/aidenCLI.ts` injects
   * `bootLogger.child('subagent')` to land in the standard log
   * sinks.
   */
  logger?: Logger;
}

// ── Pause helper (v4.6 Phase 3A) ──────────────────────────────────────────

/**
 * Safe pause read for the handler entry guard. Catches the
 * "not initialized" error from `getSpawnPause()` and returns
 * `{paused: false, status: {paused: false}}` — wiring-order bugs
 * (handler firing before `initSpawnPause` ran) must NOT take down
 * the spawn surface. Production boot wiring always inits first,
 * so this only matters for tests that omit the init step.
 */
function safeReadPause(): {
  paused: boolean;
  status: ReturnType<import('../../../core/v4/subagent/spawnPause').SpawnPauseState['status']>;
} {
  try {
    const state = getSpawnPause();
    const status = state.status();
    return { paused: status.paused, status };
  } catch {
    return { paused: false, status: { paused: false } };
  }
}

// ── Schema description (verbatim from design doc §4) ───────────────────────

const SCHEMA_DESC =
  'Spawn a focused child agent to handle one delegated sub-task synchronously. ' +
  'The child runs with no access to your conversation history, an intersected ' +
  'toolset (cannot exceed your capabilities), and a fresh system prompt built ' +
  'from the goal + optional context. Returns a structured result envelope with ' +
  "the child's summary, metrics, and exit reason. Use this when a sub-task " +
  'benefits from isolated context (e.g. exploring a separate codebase area, ' +
  'running a focused investigation, drafting an artifact without polluting your ' +
  'main turn). Do NOT use for long-running or scheduled work — use daemon ' +
  'triggers for that. Spawning is bounded: max 1 child at a time in Phase 1, ' +
  'no nested spawning, max 200 iterations per child. Each spawn pays full ' +
  'agent-startup cost (system prompt build, tool catalog ship) and roughly ' +
  'doubles token spend for that sub-task. Prefer inline work for anything you ' +
  'can answer in 1-3 of your own iterations. Spawn when isolation, focus, or ' +
  'a restricted toolset actually helps.';

// ── Schema constant (shared by real factory + boot-time stub) ─────────────

/**
 * v4.6 Phase 1 — module-level schema constant so the boot-time stub
 * (`makeSpawnSubAgentStub`) advertises the SAME JSON-schema surface
 * the real factory ships. Both register under name `spawn_sub_agent`
 * with `contexts: ['repl']`, so the model sees a consistent surface
 * regardless of whether the stub or the real handler is active.
 */
export const SPAWN_SUB_AGENT_SCHEMA: ToolSchema = {
  name:        'spawn_sub_agent',
  description: SCHEMA_DESC,
  inputSchema: {
    type: 'object',
    required: ['goal'],
    properties: {
      goal: {
        type: 'string',
        description:
          'The single concrete task for the child. Phrase as an imperative ' +
          'outcome — what should be done, not how. The child cannot ask ' +
          'follow-up questions; if the goal is ambiguous, refine it before ' +
          'spawning.',
      },
      context: {
        type: 'string',
        description:
          "Optional background the child needs but couldn't infer from the " +
          "goal alone (file paths, prior findings, constraints). Plain text. " +
          "The child does NOT see your conversation history; anything it needs " +
          'must be here or discoverable via its toolset.',
      },
      toolsets: {
        type: 'array',
        description:
          'OPTIONAL — when present, RESTRICTS the child to specific toolsets. ' +
          'OMIT this field to let the child inherit your full toolset (recommended ' +
          'for most cases — children inherit your capabilities minus the hard ' +
          'blocklist). Each entry MUST be one of the enumerated valid names ' +
          'below; invalid names get stripped, and if every requested name is ' +
          'invalid the child falls back to inheriting your full toolset (with a ' +
          'warning logged). The child can never exceed your capabilities — this ' +
          'parameter only narrows them.',
        items: {
          type: 'string',
          // v4.6 Phase 1 — enum reflects the actual toolset string
          // values registered in tools/v4/. Kept in sync with the
          // registry; new toolsets ship by being added to a tool's
          // `toolset` field AND to this list.
          enum: [
            'browser',
            'execute',
            'files',
            'mcp',
            'memory',
            'process',
            'sessions',
            'skills',
            'subagent',
            'system',
            'terminal',
            'web',
          ],
        },
      },
      maxIterations: {
        type: 'integer',
        description:
          'Maximum tool-call iterations the child may run. Clamped to [1, 200]. ' +
          'Choose tight bounds for narrow tasks (5-15) and looser for ' +
          'exploration (50-100). Default 50.',
      },
      timeoutMs: {
        type: 'integer',
        description:
          'Hard wall-clock timeout in milliseconds. Default 10 minutes. The ' +
          "child is signalled to interrupt on timeout; if it doesn't yield " +
          'cooperatively, the worker leaks but the parent stays responsive.',
      },
      provider: {
        type: 'string',
        description:
          "OPTIONAL — override the child's provider. Pass a provider ID like " +
          "'groq', 'chatgpt-plus', 'anthropic'. Omit to inherit the parent's " +
          'provider (recommended for most callers). Mainly used by ' +
          "`subagent_fanout`'s rotation for provider diversity. Validated " +
          "against the parent's available pool at dispatch — an unknown name " +
          "produces a failed envelope with `exitReason: 'provider_not_found'` " +
          'and lists the valid names in the error message. Single-provider ' +
          '(non-FallbackAdapter) parents reject this field with an error.',
      },
    },
  },
};

// ── Boot-time stub (registered before runtime deps are resolved) ──────────

/**
 * v4.6 Phase 1 — stub handler used until the REPL wiring at
 * `cli/v4/aidenCLI.ts` replaces it with the real factory. Returns
 * the SAME schema surface so `toolRegistry.getSchemas(undefined,
 * 'repl')` at agent construction sees `spawn_sub_agent` and the
 * LLM can address the tool by name. If called before the real
 * wiring lands, returns a clear "not wired" error envelope so the
 * model gets a structured error rather than a crash.
 *
 * Mirrors `makeSubagentFanoutStub` in `tools/v4/index.ts`.
 */
export function makeSpawnSubAgentStub(): ToolHandler {
  return {
    schema:   SPAWN_SUB_AGENT_SCHEMA,
    category: 'network',
    mutates:  false,
    toolset:  'subagent',
    riskTier: 'caution',
    contexts: ['repl'],
    async execute() {
      return {
        ok:             false,
        status:         'failed' as const,
        summary:        null,
        error:
          'spawn_sub_agent: tool not wired — runtime did not replace the stub. ' +
          'Call register(makeSpawnSubAgentTool({...})) after buildAgentRuntime.',
        exitReason:     'error' as const,
        metrics:        { apiCalls: 0, durationMs: 0, tokensIn: 0, tokensOut: 0 },
        childRunId:     '0',
        childSessionId: '',
      };
    },
  };
}

// ── Implementation ────────────────────────────────────────────────────────

export function makeSpawnSubAgentTool(
  factory: SpawnSubAgentFactoryOptions,
): ToolHandler {
  return {
    schema: SPAWN_SUB_AGENT_SCHEMA,
    // The tool itself spends tokens. Disk / process side effects, if
    // any, happen INSIDE the child agent whose toolset is intersected
    // with the parent's and stripped of the v4.6 blocklist.
    category: 'network',
    mutates:  false,
    toolset:  'subagent',
    riskTier: 'caution',
    // v4.6 Phase 1 — REPL-only execution context per Q6.
    // Daemon-fired agents must not initiate sub-agent spawns in
    // Phase 1: the spawn factory captured the REPL agent reference
    // at construction, so a daemon-fired turn invoking this tool
    // would route its child's signal chain through the REPL agent's
    // state rather than the daemon turn's. Tagging it `['repl']`
    // here causes `toolRegistry.getSchemas(_, 'daemon')` (used by
    // daemonAgentBuilder.ts:130) to exclude `spawn_sub_agent` from
    // the daemon agent's tool catalog, so the model never sees it
    // when running in daemon mode. Phase 3+ may add a daemon-mode
    // spawn factory tied to the daemon agent's own reference.
    contexts: ['repl'],

    async execute(args, _ctx) {
      // ── 0. Operator kill-switch (v4.6 Phase 3A) ─────────────────────────
      // First thing — before arg validation, run-row insertion, or
      // any child build. A paused state must short-circuit cleanly
      // with NO side effects (no `runs` row, no log noise beyond
      // the rejection). Locked decision: paused calls are operator-
      // induced, NOT real failures; they don't pollute `aiden runs
      // list`. Envelope intentionally drops the standard SubAgentResult
      // shape because (a) no childRunId exists (no row was written)
      // and (b) the error class is qualitatively different from a
      // spawn that ran and failed.
      const pauseGate = safeReadPause();
      if (pauseGate.paused) {
        const s = pauseGate.status;
        const reasonSuffix = s.reason ? ` (reason: ${s.reason})` : '';
        return {
          success:    false,
          errorCode:  'SUBAGENT_SPAWN_PAUSED',
          message:
            `spawn_sub_agent: spawning is paused${reasonSuffix}. ` +
            'Run /spawn-pause off to resume.',
          pausedAt:   s.pausedAt   ?? null,
          reason:     s.reason     ?? null,
          pausedBy:   s.pausedBy   ?? null,
          durationMs: s.durationMs ?? null,
        };
      }

      // ── 1. Validate + coerce ─────────────────────────────────────────────
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      if (!goal) {
        return {
          ok:             false,
          status:         'failed' as const,
          summary:        null,
          error:          "spawn_sub_agent: 'goal' is required and must be a non-empty string",
          exitReason:     'error' as const,
          metrics:        { apiCalls: 0, durationMs: 0, tokensIn: 0, tokensOut: 0 },
          childRunId:     '0',
          childSessionId: '',
        };
      }

      const spec: SubAgentSpec = {
        goal,
        context:        typeof args.context === 'string'  ? args.context : undefined,
        toolsets:       Array.isArray(args.toolsets)
          ? (args.toolsets as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined,
        maxIterations:  typeof args.maxIterations === 'number' ? args.maxIterations : undefined,
        timeoutMs:      typeof args.timeoutMs === 'number'     ? args.timeoutMs     : undefined,
        // v4.6 Phase 2P — per-spawn provider override (per design doc §12.2).
        // Validation happens in childBuilder against the parent's FallbackAdapter
        // provider pool; an unknown name produces a failed envelope.
        provider:       typeof args.provider === 'string'      ? args.provider      : undefined,
      };

      // v4.6 Phase 1 observability — log the parsed spec so the next
      // smoke test can correlate "what the model asked for" with the
      // child's actual behaviour. Goal is truncated to keep the log
      // line readable. The parent's sessionId (read off the agent
      // instance) is included so logs from one user turn cluster.
      const logger = factory.logger ?? noopLogger();
      const goalPreview = spec.goal.length > 200 ? spec.goal.slice(0, 200) + '…' : spec.goal;
      logger.info('spawn_sub_agent invoked', {
        parentSessionId: factory.parentAgent.getCurrentSignal !== undefined
          ? (factory.parentAgent as unknown as { sessionId?: string }).sessionId ?? null
          : null,
        goalPreview,
        goalLen:         spec.goal.length,
        contextLen:      spec.context?.length ?? 0,
        toolsets:        spec.toolsets ?? null,
        maxIterations:   spec.maxIterations ?? null,
        timeoutMs:       spec.timeoutMs ?? null,
      });

      // ── 2. Read the parent's current signal (Flag 1 pattern) ─────────────
      const parentSignal = factory.parentAgent.getCurrentSignal();

      // ── 3. Resolve optional parent run / session identifiers ─────────────
      const parentRunId     = factory.resolveParentRunId?.();
      const parentSessionId = factory.resolveParentSessionId?.();

      // ── 4. Invoke the primitive. NEVER throws — always envelope. ─────────
      const result = await spawnSubAgent(
        spec,
        {
          // ChildBuilderDeps fields:
          toolRegistry:        factory.toolRegistry,
          parentToolContext:   factory.parentToolContext,
          parentProvider:      factory.parentProvider,
          parentProviderId:    factory.parentProviderId,
          parentModelId:       factory.parentModelId,
          resolveVerifiedFlag: factory.resolveVerifiedFlag,
          resolveToolset:      factory.resolveToolset,
          resolveMutates:      factory.resolveMutates,
          // Persistence:
          runStore:            factory.runStore,
          instanceId:          factory.instanceId,
          // v4.6 Phase 1 observability:
          logger,
        },
        {
          signal:           parentSignal,
          parentRunId,
          parentSessionId,
        },
      );

      // Completion log — pairs with "spawn_sub_agent invoked" so a
      // grep on parentSessionId surfaces invoke → complete in order.
      logger.info('spawn_sub_agent completed', {
        childRunId:     result.childRunId,
        childSessionId: result.childSessionId,
        status:         result.status,
        exitReason:     result.exitReason,
        ok:             result.ok,
        apiCalls:       result.metrics.apiCalls,
        durationMs:     result.metrics.durationMs,
        tokensIn:       result.metrics.tokensIn,
        tokensOut:      result.metrics.tokensOut,
        summaryLen:     result.summary?.length ?? 0,
        errorPreview:   result.error?.slice(0, 200) ?? null,
      });

      // The envelope IS the tool result body. The agent loop's tool-
      // result handling will JSON-stringify this and feed it back to
      // the parent's LLM as the tool message content.
      return result;
    },
  };
}
