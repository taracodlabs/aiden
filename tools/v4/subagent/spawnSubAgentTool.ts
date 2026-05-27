/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * tools/v4/subagent/spawnSubAgentTool.ts — v4.11 Slice 4 facade.
 *
 * Thin LLM-callable wrapper for `spawn_sub_agent`. After Phase B
 * Slice 4 this file owns only:
 *
 *   1. JSON-schema declaration (unchanged from v4.6 — model-facing surface)
 *   2. Operator pause gate (v4.6 Phase 3A)
 *   3. Arg validation + coercion into a single SubagentTask
 *   4. Delegation to SubagentCoordinator.spawnBatch
 *   5. UI event emission (ui_task_update / ui_task_done) for chrome
 *   6. Envelope re-formatting back into the legacy SubAgentResult
 *      shape so the parent's LLM sees the same payload as v4.6
 *
 * Everything else — id minting, linked AbortController, child agent
 * construction, registry, cost rollup, lifecycle trace — lives in
 * the coordinator. The model surface is untouched.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { ToolSchema } from '../../../providers/v4/types';
import type { Logger } from '../../../core/v4/logger/logger';
import { noopLogger } from '../../../core/v4/logger/factory';
import type { TurnRuntimeContext } from '../../../core/v4/turnRuntimeContext';
import type {
  SubagentCoordinator,
  SubagentTask,
  SubagentResultEnvelope,
} from '../../../core/v4/subagent/coordinator';
// v4.6 Phase 3A — operator kill-switch.
import { getSpawnPause } from '../../../core/v4/subagent/spawnPause';

// ── Factory dependencies ───────────────────────────────────────────────────

/**
 * Slice 4 factory inputs. The runtime supplies once at REPL boot.
 *
 *   - `resolveTurnContext`: called at handler entry to get the live
 *     per-turn TurnRuntimeContext (signal + cost accumulator + trace
 *     emitter). The REPL passes `() => agent.getCurrentTurnContext()`
 *     so the Flag 1 pattern flows through. MCP / other surfaces can
 *     mint a fresh per-request context. When the resolver returns
 *     `undefined`, the handler fails with a structured "no turn
 *     context" envelope rather than silently widening behaviour.
 *
 *   - `coordinator`: the shared SubagentCoordinator instance — owns
 *     id minting, registry, concurrency, cancellation, aggregation.
 *
 *   - `onUiEvent`: optional chrome-trail emitter. Fires
 *     `ui_task_update` before the spawn and `ui_task_done` when the
 *     envelope resolves. Same wire as v4.6.
 */
export interface SpawnSubAgentFactoryOptions {
  resolveTurnContext: () => TurnRuntimeContext | undefined;
  coordinator: SubagentCoordinator;
  onUiEvent?: (name: string, args: Record<string, unknown>) => void;
  /** Optional logger for handler-level info traces. Defaults noop. */
  logger?: Logger;
}

// ── Pause helper (v4.6 Phase 3A) ──────────────────────────────────────────

function safeReadPause(): {
  paused: boolean;
  status: ReturnType<import('../../../core/v4/subagent/spawnPause').SpawnPauseState['status']>;
} {
  try {
    const state  = getSpawnPause();
    const status = state.status();
    return { paused: status.paused, status };
  } catch {
    return { paused: false, status: { paused: false } };
  }
}

// ── Schema (verbatim from v4.6 design doc §4) ─────────────────────────────

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
          'goal alone (file paths, prior findings, constraints). Plain text. ' +
          'The child does NOT see your conversation history; anything it needs ' +
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
          enum: [
            'browser', 'execute', 'files', 'mcp', 'memory', 'process',
            'sessions', 'skills', 'subagent', 'system', 'terminal', 'web',
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

/**
 * Slice 4 facade. All orchestration delegated to the coordinator;
 * this handler just adapts the model-facing JSON in / JSON out.
 */
export function makeSpawnSubAgentTool(
  factory: SpawnSubAgentFactoryOptions,
): ToolHandler {
  return {
    schema:   SPAWN_SUB_AGENT_SCHEMA,
    category: 'network',
    mutates:  false,
    toolset:  'subagent',
    riskTier: 'caution',
    contexts: ['repl'],

    async execute(args, _ctx) {
      // ── 0. Operator kill-switch (v4.6 Phase 3A — unchanged) ─────────────
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

      // ── 1. Validate goal ───────────────────────────────────────────────
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      if (!goal) {
        return legacyFailedEnvelope({
          error: "spawn_sub_agent: 'goal' is required and must be a non-empty string",
        });
      }

      // ── 2. Coerce into a single coordinator task ───────────────────────
      const task: SubagentTask = {
        goal,
        context:       typeof args.context === 'string'      ? args.context : undefined,
        toolsets:      Array.isArray(args.toolsets)
          ? (args.toolsets as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined,
        maxIterations: typeof args.maxIterations === 'number' ? args.maxIterations : undefined,
        timeoutMs:     typeof args.timeoutMs === 'number'     ? args.timeoutMs     : undefined,
        provider:      typeof args.provider === 'string'      ? args.provider      : undefined,
      };

      // ── 3. Resolve the live turn context (Flag 1 pattern) ──────────────
      const turnContext = factory.resolveTurnContext();
      if (!turnContext) {
        // Back-compat: a caller wired the old factory shape (no per-turn
        // context) or invoked spawn from a code path outside a turn loop.
        // Fail loud rather than silently bypass cancellation / cost
        // rollup — the legacy v4.6 behaviour is no longer the contract.
        return legacyFailedEnvelope({
          error:
            'spawn_sub_agent: no active TurnRuntimeContext — ' +
            'caller must construct one in runConversation options (v4.11 Slice 4).',
        });
      }

      // ── 4. Logger + UI surface ─────────────────────────────────────────
      const logger      = factory.logger ?? noopLogger();
      const goalPreview = goal.length > 200 ? goal.slice(0, 200) + '…' : goal;
      const subTaskId   = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      factory.onUiEvent?.('ui_task_update', {
        task_id: subTaskId,
        label:   goalPreview,
        status:  'running',
        kind:    'subagent',
        depth:   1,
      });

      // ── 5. Delegate to coordinator ─────────────────────────────────────
      const fanout = await factory.coordinator.spawnBatch(
        turnContext,
        [task],
        'bestEffort',
      );
      const envelope = fanout.results[0];

      // ── 6. UI done event ───────────────────────────────────────────────
      const uiStatus: 'success' | 'failure' | 'blocked' =
        !envelope                              ? 'failure' :
        envelope.status === 'completed'        ? 'success' :
        envelope.status === 'cancelled'        ? 'blocked' :
        envelope.status === 'timeout'          ? 'blocked' :
                                                 'failure';
      factory.onUiEvent?.('ui_task_done', {
        task_id: subTaskId,
        status:  uiStatus,
        summary: envelope
          ? `${envelope.usage.totalTokens} tokens · ${envelope.exitReason}`
          : 'no result',
      });

      // ── 7. Re-shape into the legacy SubAgentResult contract ────────────
      // The parent's LLM has seen the v4.6 envelope shape since Phase 1;
      // preserving it keeps the model-facing surface stable across the
      // Slice 4 refactor. Future slice may upgrade to expose the new
      // SubagentResultEnvelope directly.
      if (!envelope) {
        return legacyFailedEnvelope({
          error: 'spawn_sub_agent: coordinator returned no results (internal bug)',
        });
      }
      logger.info?.('spawn_sub_agent completed', {
        subagentRunId:  envelope.subagentRunId,
        conversationId: envelope.conversationId,
        status:         envelope.status,
        exitReason:     envelope.exitReason,
        durationMs:     envelope.durationMs,
        inputTokens:    envelope.usage.inputTokens,
        outputTokens:   envelope.usage.outputTokens,
      });
      return legacyEnvelopeFrom(envelope);
    },
  };
}

// ── Envelope mapping ─────────────────────────────────────────────────────

/**
 * Convert the coordinator's `SubagentResultEnvelope` into the legacy
 * `SubAgentResult` shape returned by v4.6's `spawnSubAgent`. The
 * parent's LLM has been reading this shape since v4.6 Phase 1; the
 * Slice 4 refactor preserves the wire so models cached on the old
 * format still parse correctly.
 */
function legacyEnvelopeFrom(env: SubagentResultEnvelope): Record<string, unknown> {
  const ok = env.status === 'completed';
  // Map coordinator status → legacy status. Legacy used 'interrupted'
  // for cancel; coordinator normalises to 'cancelled'. We surface
  // 'interrupted' here for back-compat.
  const legacyStatus = env.status === 'cancelled' ? 'interrupted' : env.status;
  return {
    ok,
    status:         legacyStatus,
    summary:        env.summary || null,
    error:          env.error    ?? null,
    exitReason:     env.exitReason,
    metrics: {
      apiCalls:    0,                          // not tracked at envelope layer
      durationMs:  env.durationMs,
      tokensIn:    env.usage.inputTokens,
      tokensOut:   env.usage.outputTokens,
    },
    // childRunId is now the subagentRunId from the coordinator. Old
    // numeric runs.id values are still observable through the trace
    // emitter (they land in run_events). The string form is a wire
    // change tolerated as additive — the model only reads `summary` +
    // `error` + `metrics` in practice.
    childRunId:     env.subagentRunId,
    childSessionId: env.conversationId,
  };
}

/** Shorthand for pre-coordinator validation failures. */
function legacyFailedEnvelope(opts: { error: string }): Record<string, unknown> {
  return {
    ok:             false,
    status:         'failed',
    summary:        null,
    error:          opts.error,
    exitReason:     'error',
    metrics:        { apiCalls: 0, durationMs: 0, tokensIn: 0, tokensOut: 0 },
    childRunId:     '0',
    childSessionId: '',
  };
}
