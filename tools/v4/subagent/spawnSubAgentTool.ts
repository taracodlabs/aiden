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
  /** Optional logger for handler-level info traces. Defaults noop. */
  logger?: Logger;
  // v4.11 regression patch — `onUiEvent` removed. UI emission is now
  // owned by the coordinator (single source of truth); the boot
  // wiring passes the display sink directly into
  // `new SubagentCoordinator({ ..., onUiEvent })`.
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

// ── Schema ────────────────────────────────────────────────────────────────
//
// v4.11 hi-budget fix — description compression. Pre-v4.11 SCHEMA_DESC
// was 1.4KB of design-doc prose; per-tool measurement showed it as the
// single largest tool in the catalog (~729 cl100k tokens). Trimmed
// here to the operational facts the model needs at call time:
//   - what it does (one sentence)
//   - the hard bounds (1 child, no nesting, 200 iters cap)
//   - when NOT to use it
// Functional schema (param types, required, enum) is UNCHANGED — only
// the prose narrative shrinks.

const SCHEMA_DESC =
  'Spawn one focused child agent to handle a delegated sub-task synchronously. ' +
  'Isolated: no parent history, intersected toolset. Returns an evidence-checked ' +
  'envelope with a `trust` label the runtime computes by re-checking the child’s ' +
  'own tool evidence: verified = concrete handles (path/exit/id) re-validated → treat ' +
  'as fact; unverified = success CLAIMED with no checkable handle → re-check before ' +
  'trusting; advisory = pure reasoning, no artifact; verification_failed = claimed ' +
  'artifact absent on re-check → reject. Max 1 child, no nesting, ≤200 iterations. ' +
  'Prefer inline work for 1-3 iteration tasks.';

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
          'Concrete imperative outcome for the child. Child cannot ask ' +
          'follow-ups — disambiguate before spawning.',
      },
      context: {
        type: 'string',
        description:
          'Optional background (paths, prior findings, constraints). Child ' +
          "does NOT see your history; anything it needs goes here.",
      },
      toolsets: {
        type: 'array',
        description:
          'Optional. Restricts child to listed toolsets. Omit to inherit ' +
          'your full toolset (minus the hard blocklist). Invalid names ' +
          'are stripped; all-invalid falls back to your full set.',
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
          'Tool-call iteration cap. Clamped to [1, 200]. Default 50.',
      },
      timeoutMs: {
        type: 'integer',
        description:
          'Hard wall-clock timeout (ms). Default 600000 (10 min); ' +
          'env AIDEN_SUBAGENT_TIMEOUT_MS overrides default; this field ' +
          'overrides both.',
      },
      provider: {
        type: 'string',
        description:
          "Optional. Override child's provider (e.g. 'groq', 'anthropic'). " +
          "Omit to inherit. Unknown names fail with exitReason: " +
          "'provider_not_found'. Rejected on single-provider parents.",
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

      // ── 4. Logger ──────────────────────────────────────────────────────
      // v4.11 regression patch — UI event emission MOVED into the
      // SubagentCoordinator (single source of truth). The pre-Slice-4
      // pair this facade used to emit (`subagent-${ts}-${rand}` task_id)
      // collided with the gap that left fanout children unannounced.
      // Now BOTH facades route their per-child UI events through the
      // coordinator's emitUi*; the task_id is the coordinator's
      // `subagentRunId` so display rows correlate to trace events.
      const logger = factory.logger ?? noopLogger();

      // ── 5. Delegate to coordinator (it emits the UI pair internally) ──
      const fanout = await factory.coordinator.spawnBatch(
        turnContext,
        [task],
        'bestEffort',
      );
      const envelope = fanout.results[0];

      // ── 6. Re-shape into the legacy SubAgentResult contract ───────────
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
  // v4.12.1 Pillar 3 — `ok` is VERIFIED completion, not a clean loop exit.
  // A child that finished cleanly but whose claimed side-effect failed the
  // parent-side handle re-check has verdict 'verification_failed' → ok:false.
  // When the primitive supplied no verdict (older path), fall back to status.
  const verdict = env.verdict ?? (env.status === 'completed' ? 'completed' : null);
  const ok = verdict === 'completed';
  // Map coordinator status → legacy status. Legacy used 'interrupted'
  // for cancel; coordinator normalises to 'cancelled'. We surface
  // 'interrupted' here for back-compat.
  const legacyStatus = env.status === 'cancelled' ? 'interrupted' : env.status;
  const verified      = env.verified === true;
  const reasoningOnly = env.reasoningOnly === true;
  const handles       = env.handles ?? [];
  return {
    ok,
    status:         legacyStatus,
    summary:        env.summary || null,
    error:          env.error    ?? null,
    exitReason:     env.exitReason,
    // ── v4.12.1 Pillar 3 — evidence-required surface the parent MODEL reads ──
    verdict,
    verified,
    reasoningOnly,
    /** Concrete artifact handles that re-checked clean on the parent side. */
    handles,
    /**
     * The honest trust label for the parent's reasoning:
     *   verified        — backed by re-checked handles; treat as fact.
     *   unverified      — summary is a CLAIM with no checkable handle; re-check
     *                     the artifact yourself before relying on it.
     *   advisory        — pure-reasoning answer, no artifact possible.
     *   verification_failed — a claimed artifact was NOT there on re-check.
     */
    trust:
      verdict === 'verification_failed' ? 'verification_failed'
      : verified                        ? 'verified'
      : reasoningOnly                   ? 'advisory'
      : 'unverified',
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
