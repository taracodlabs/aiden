/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/realAgentRunner.ts — v4.5 Phase 7.
 *
 * Replaces the Phase 5a placeholder runner with a real
 * `AidenAgent.runConversation` invocation.
 *
 * Why this is a *factory* + *injectable agent builder* rather than
 * a direct `new AidenAgent(...)` call: the daemon module sits
 * BELOW the CLI in the import graph — pulling provider /
 * toolExecutor / plannerGuard / honesty / skillTeacher / ...
 * construction into `core/v4/daemon` would invert the dependency
 * direction. Instead, the CLI (which already owns agent
 * construction for the REPL) injects an `AgentBuilder` function
 * the runner calls per turn. Tests pass stubs.
 *
 * Bootstrap wiring (in `bootstrap.ts`):
 *
 *   - When AIDEN_DAEMON=1 AND an `agentBuilder` is provided →
 *     `createRealAgentRunner({ ..., agentBuilder })` is the
 *     dispatcher's runner factory.
 *   - When no builder is provided → falls back to the Phase 5a
 *     placeholder (still useful for rails-only integration tests
 *     and for environments where the user has no provider
 *     configured yet).
 *
 * Lifecycle per claim:
 *
 *   1. evaluatePreTurn — global daily budget check; reject with
 *      `trigger_quota` tag when exhausted.
 *   2. resolveDaemonModel — trigger spec → env → persisted chain.
 *   3. buildDaemonApprovalCallbacks — non-interactive auto-decide
 *      per Q-P7-1a policy.
 *   4. createPerTurnBudgetWatcher — per-trigger soft cap; AbortSignal
 *      threads into the agent invocation.
 *   5. runStore.create() → runId; emit `dispatcher:invoked` with
 *      sessionId, model, modelSource, policy, dailySnapshot.
 *   6. Build initial history via buildInitialHistory(input).
 *   7. agentBuilder({...}) → AidenAgent (caller-injected).
 *   8. agent.runConversation(history) — major events emitted via
 *      onToolCall + onBudgetWarning hooks → run_events.
 *   9. Post-turn: consumePostTurn updates daily tracker; emit
 *      `dispatcher:completed` with finishReason + totalTokens +
 *      classification + retry decision.
 *  10. Map AidenAgentResult → DaemonAgentResult.
 *
 * Failure handling: any throw or `finishReason: 'error'` is
 * surfaced via DaemonAgentResult — the dispatcher (caller) maps
 * to triggerBus.markFailed / deadLetter per the retry matrix.
 */

import type {
  AidenAgent,
  AidenAgentResult,
} from '../../aidenAgent';
import type { Message, ToolCallRequest, ToolCallResult } from '../../../../providers/v4/types';
import type { Db } from '../db/connection';
import type { RunStore } from '../runStore';
// v4.10 Slice 10.2b — shared (category, kind) taxonomy.
import { categorizeEvent } from '../eventCategories';
import type { ResourceRegistry } from '../resourceRegistry';
import type { TriggerRowSql } from '../db/schema/v1.spec';
import type {
  DaemonAgentInput,
  DaemonAgentResult,
  DaemonAgentRunner,
} from './agentRunner';
import { buildInitialHistory } from './agentRunner';
import { computeTaskFinalization } from '../../taskVerification';
import { emitArtifactVerified, emitCostUpdated, type PillarEventSink } from '../../pillarEvents';
import type { TaskStore } from '../taskStore';
import {
  resolveDaemonModel,
} from './resolveModel';
import type { ResolvedDaemonModel } from './resolveModel';
import {
  buildDaemonApprovalCallbacks,
  DEFAULT_DAEMON_APPROVAL_POLICY,
  isDaemonApprovalPolicy,
} from './daemonApproval';
import type { DaemonApprovalPolicy } from './daemonApproval';
import {
  createDailyBudgetTracker,
  type DailyBudgetTracker,
} from './dailyBudgetTracker';
import {
  evaluatePreTurn,
  consumePostTurn,
  createPerTurnBudgetWatcher,
} from './budgetGate';

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Caller-injected builder. Receives the per-turn context + a set
 * of pre-built hooks the runner wants the agent to expose; returns
 * a fully-constructed AidenAgent the runner can call
 * `runConversation` on.
 *
 * The builder is responsible for plumbing:
 *   - provider (resolved per-turn via input.resolvedModel)
 *   - toolExecutor (full surface for Phase 7 per Q-P7-5a)
 *   - tools (full surface)
 *   - approval engine wired with input.approvalCallbacks
 *   - sessionId set on the agent
 *   - onToolCall wired to input.hooks.onToolCall
 *   - onBudgetWarning wired to input.hooks.onBudgetWarning
 *
 * Everything else (memory, planner-guard, honesty, skills) is at
 * the builder's discretion — daemon-mode CAN reuse the same moat
 * pieces the REPL does, or skip them for speed. That choice lives
 * in `bootstrap.ts` / the CLI's `installDaemonAgentBuilder()` hook.
 */
export type AgentBuilder = (input: {
  sessionId:        string;
  resolvedModel:    ResolvedDaemonModel;
  approvalPolicy:   DaemonApprovalPolicy;
  approvalCallbacks: ReturnType<typeof buildDaemonApprovalCallbacks>;
  hooks: {
    onToolCall:        (call: ToolCallRequest, phase: 'before' | 'after', result?: ToolCallResult) => void;
    onBudgetWarning:   (level: 'caution' | 'warning', turn: number, max: number) => void;
  };
  abortSignal:      AbortSignal;
}) => Promise<AidenAgent> | AidenAgent;

export interface CreateRealAgentRunnerOptions {
  db:                Db;
  runStore:          RunStore;
  /**
   * v4.13 Gap 4 — when provided, every daemon run gets a durable task
   * row (the job-card): created at claim (or reused on resume), then
   * finalized through the same verify-before-done gate the REPL uses
   * (computeTaskFinalization). Optional so rails-only tests and
   * placeholder environments keep working unchanged.
   */
  taskStore?:        TaskStore;
  resourceRegistry?: ResourceRegistry;
  log?:              (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Builds AidenAgent per turn (caller-injected). */
  agentBuilder:      AgentBuilder;
  /** Override the persisted-default model. Tests pass a stub. */
  persistedDefault?: { provider: string; model: string };
  /** Override global daily budget (null = unlimited; reads AIDEN_DAEMON_DAILY_BUDGET when omitted). */
  dailyBudget?:      number | null;
  /** Test-only override clock. */
  now?:              () => number;
}

// ── Implementation ─────────────────────────────────────────────────────────

const ENV_DAEMON_MODEL  = 'AIDEN_DAEMON_MODEL';
const ENV_DAILY_BUDGET  = 'AIDEN_DAEMON_DAILY_BUDGET';

export function createRealAgentRunner(
  opts: CreateRealAgentRunnerOptions,
): DaemonAgentRunner {
  const log = opts.log ?? (() => { /* silent */ });
  const now = opts.now ?? Date.now;
  const tracker: DailyBudgetTracker = createDailyBudgetTracker({
    db:     opts.db,
    budget: opts.dailyBudget ?? readDailyBudgetFromEnv(),
  });

  return {
    async invoke(input: DaemonAgentInput): Promise<DaemonAgentResult> {
      const dailyBudget = opts.dailyBudget ?? readDailyBudgetFromEnv();

      // ── 1: pre-turn budget gate ────────────────────────────────────────
      const verdict = evaluatePreTurn({ tracker, dailyBudget, now: now() });
      if (!verdict.allowed) {
        // Reject without invoking the agent. Surface as trigger_quota.
        const runId = opts.runStore.create({
          sessionId:      input.sessionId,
          instanceId:     input.instanceId,
          triggerEventId: input.triggerEventId,
          status:         'running',
        });
        // v4.10 Slice 10.2b — rich emission with the daemon taxonomy.
        opts.runStore.emitEventRich({
          runId,
          category:  'dispatcher',
          kind:      'dispatcher.rejected',
          name:      'dispatcher:rejected',
          sessionId: input.sessionId,
          status:    'blocked',
          summary:   `rejected: ${verdict.reason ?? 'trigger_quota'}`,
          payload: {
            reason:        verdict.reason ?? 'trigger_quota',
            dailySnapshot: verdict.daily,
          },
          visibility: 'system',
          source:     'daemon',
        });
        opts.runStore.setStatus(runId, 'failed', { finishReason: 'budget_exhausted' });
        log('warn', `[real-runner] rejected eventId=${input.triggerEventId}: ${verdict.reason}`);
        return {
          runId,
          finishReason: 'error',
          error:        verdict.reason ?? 'trigger_quota: daily budget exhausted',
        };
      }

      // ── 2: resolve model from chain ───────────────────────────────────
      const triggerSpec = readTriggerSpec(opts.db, input.triggerContext.triggerId);
      const resolved = resolveDaemonModel({
        triggerSpec: {
          provider: triggerSpec?.provider ?? null,
          model:    triggerSpec?.model    ?? null,
        },
        envOverride: process.env[ENV_DAEMON_MODEL],
        persistedDefault: opts.persistedDefault ?? { provider: '', model: '' },
      });

      // ── 3: approval callbacks ─────────────────────────────────────────
      const approvalPolicy: DaemonApprovalPolicy =
        triggerSpec?.daemonApproval && isDaemonApprovalPolicy(triggerSpec.daemonApproval)
          ? triggerSpec.daemonApproval
          : DEFAULT_DAEMON_APPROVAL_POLICY;

      // ── 4: per-turn budget watcher ────────────────────────────────────
      const perTurnWatcher = createPerTurnBudgetWatcher({
        maxTokensPerFire: triggerSpec?.maxTokensPerFire ?? null,
      });

      // ── 5: task row (job-card) + run row + dispatcher:invoked event ───
      //
      // v4.13 Gap 4 — daemon runs now carry the same durable job-card the
      // REPL writes: created fresh per run, or REUSED when this is a
      // resume (the card accumulates evidence across attempts). Best-
      // effort — a card failure never blocks dispatch.
      let taskId: string | null = null;
      if (opts.taskStore) {
        try {
          if (input.resume?.taskId && opts.taskStore.get(input.resume.taskId)) {
            taskId = input.resume.taskId;
            opts.taskStore.setStatus(taskId, 'active');   // card wakes with the run
          } else {
            taskId = opts.taskStore.create({
              title:     input.initialMessage,
              goal:      input.initialMessage,
              sessionId: input.sessionId,
              channelId: 'daemon',
              status:    'active',
            });
          }
        } catch { taskId = null; }
      }
      const runId = opts.runStore.create({
        sessionId:      input.sessionId,
        instanceId:     input.instanceId,
        triggerEventId: input.triggerEventId,
        status:         'running',
        ...(taskId ? { taskId } : {}),
      });
      opts.runStore.emitEventRich({
        runId,
        category:  'dispatcher',
        kind:      'dispatcher.invoked',
        name:      'dispatcher:invoked',
        sessionId: input.sessionId,
        summary:   `${input.triggerContext.source}/${input.triggerContext.triggerId}`,
        payload: {
          source:        input.triggerContext.source,
          triggerId:     input.triggerContext.triggerId,
          eventId:       input.triggerEventId,
          sessionId:     input.sessionId,
          templated:     input.triggerContext.promptTemplate !== null,
          messageLen:    input.initialMessage.length,
          attempt:       input.triggerContext.attempt,
          maxAttempts:   input.triggerContext.maxAttempts,
          model:         resolved.model,
          provider:      resolved.provider,
          modelSource:   resolved.source,
          approvalPolicy,
          dailySnapshot: verdict.daily,
          maxTokensPerFire: triggerSpec?.maxTokensPerFire ?? null,
        },
        visibility: 'system',
        source:     'daemon',
      });

      const approvalCallbacks = buildDaemonApprovalCallbacks({
        policy:   approvalPolicy,
        runStore: opts.runStore,
        runId,
        log:      (lvl, msg) => log(lvl, msg),
      });

      // ── 6: initial history ────────────────────────────────────────────
      const history: Message[] = buildInitialHistory(input);

      // ── 7: build agent via injected factory ───────────────────────────
      let agent: AidenAgent;
      const startedAt = now();
      try {
        agent = await opts.agentBuilder({
          sessionId:        input.sessionId,
          resolvedModel:    resolved,
          approvalPolicy,
          approvalCallbacks,
          hooks: {
            onToolCall: (call, phase, result) => emitToolEvent(opts.runStore, runId, input.sessionId, call, phase, result, startedAt, now),
            onBudgetWarning: (level, turn, max) => {
              opts.runStore.emitEventRich({
                runId,
                category:  'dispatcher',
                kind:      'dispatcher.budget_warning',
                name:      'budget_warning',
                sessionId: input.sessionId,
                status:    'warn',
                summary:   `budget ${level}: turn=${turn} max=${max}`,
                payload:   { level, turn, max },
                visibility:'system',
                source:    'daemon',
              });
            },
          },
          abortSignal: perTurnWatcher.signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('error', `[real-runner] agentBuilder threw eventId=${input.triggerEventId}: ${msg}`);
        opts.runStore.emitEventRich({
          runId,
          category:  'dispatcher',
          kind:      'dispatcher.builder_failed',
          name:      'dispatcher:builder_failed',
          sessionId: input.sessionId,
          status:    'failed',
          summary:   `agentBuilder threw: ${msg.slice(0, 120)}`,
          payload:   { error: msg },
          visibility:'system',
          source:    'daemon',
        });
        opts.runStore.setStatus(runId, 'failed', { finishReason: 'error' });
        return { runId, finishReason: 'error', error: msg };
      }

      // ── 8: invoke runConversation ─────────────────────────────────────
      let result: AidenAgentResult | null = null;
      let invocationError: string | null = null;
      // v4.13 Gap 4 — the model's own done-declaration (ui_task_done
      // status) feeds the verify-before-done gate below, same as the REPL.
      let declaredTaskStatus: string | null = null;
      try {
        result = await agent.runConversation(history, {
          // The agent honours its own abort signal via per-tool aborts;
          // tools that respect AbortSignal (shell_exec, fetch_*) will
          // bail when perTurnWatcher trips.
          //
          // Note: runConversation doesn't currently take an abort
          // signal in its options — the budget watcher is best-effort
          // observability via tally(). Future enhancement: thread the
          // signal into the loop body via options.
          //
          // v4.10 Slice 10.2 — closes the Phase 2.4 comment debt:
          // serialize ui_* events to the dispatcher's run_events
          // stream keyed on the active runId. Daemon-fired turns have
          // no human watching, so no render call here (matches the
          // pre-Slice-10.2 no-render contract). Persistence-only.
          // try/catch matches the chatSession + aidenCLI sites — a
          // locked DB or schema drift must not crash dispatch.
          onUiEvent: (name: string, args: Record<string, unknown>) => {
            if (name === 'ui_task_done' && typeof args.status === 'string') {
              declaredTaskStatus = args.status;   // last one wins
            }
            // v4.10 Slice 10.2b — rich emission via the shared
            // categoriser so daemon-fired UI events line up with
            // REPL-fired ones in trace_query results.
            try {
              const tags = categorizeEvent(name);
              opts.runStore.emitEventRich({
                runId,
                category:  tags.category,
                kind:      tags.kind,
                name,
                sessionId: input.sessionId,
                payload:   args,
                visibility:'model',
                source:    'daemon',
              });
            } catch { /* persistence faults must never break dispatch */ }
          },
        });
        // Stamp the actual token usage onto the watcher for the
        // post-turn snapshot below.
        const tokens = extractTokens(result);
        if (tokens > 0) perTurnWatcher.tally(tokens);
      } catch (e) {
        invocationError = e instanceof Error ? (e.stack ?? e.message) : String(e);
        log('error', `[real-runner] runConversation threw eventId=${input.triggerEventId}: ${invocationError.slice(0, 500)}`);
      }

      // ── 9: post-turn budget consume + dispatcher:completed ─────────────
      const finalSnapshot = consumePostTurn({
        tracker,
        actualTokens: perTurnWatcher.used(),
        dailyBudget,
        now:          now(),
      });

      const finishReason = pickFinishReason(result, invocationError, perTurnWatcher.hit());
      opts.runStore.emitEventRich({
        runId,
        category:  'dispatcher',
        kind:      'dispatcher.completed',
        name:      'dispatcher:completed',
        sessionId: input.sessionId,
        // 'delivered' / 'stop' are the agent's successful finish reasons;
        // map them to 'ok' for consumers. Everything else (error,
        // budget_exhausted, tool_loop) surfaces verbatim as the status.
        status:    (finishReason === 'delivered' || finishReason === 'stop') ? 'ok' : finishReason,
        durationMs: now() - startedAt,
        summary:   `finish=${finishReason} tokens=${perTurnWatcher.used()}`,
        payload: {
          finishReason,
          totalTokens:   perTurnWatcher.used(),
          durationMs:    now() - startedAt,
          dailySnapshot: finalSnapshot,
          perTurnBudgetHit: perTurnWatcher.hit(),
          perTurnReason: perTurnWatcher.reason(),
          invocationError: invocationError ? invocationError.slice(0, 200) : null,
        },
        visibility: 'system',
        source:     'daemon',
      });

      // ── 10: map result → DaemonAgentResult ────────────────────────────
      const runStatus =
        finishReason === 'stop'              ? 'completed' :
        finishReason === 'budget_exhausted'  ? 'failed'    :
        finishReason === 'error'             ? 'failed'    :
        finishReason === 'tool_loop'         ? 'failed'    : 'completed';
      opts.runStore.setStatus(runId, runStatus, { finishReason });

      // v4.13 Gap 4 — finalize the job-card through the SAME verify-
      // before-done gate the REPL uses (computeTaskFinalization): a
      // daemon task can no more complete on prose than a REPL one.
      // pending_verification lands first (crash honesty), then the
      // verdict + evidence + card in one UPDATE. Best-effort.
      if (opts.taskStore && taskId) {
        try {
          const fin = computeTaskFinalization(
            {
              // 'delivered' is a successful non-agent finish; treat as clean.
              finishReason:   finishReason === 'delivered' ? 'stop' : finishReason,
              toolCallTrace:  result?.toolCallTrace,
              declaredStatus: declaredTaskStatus,
            },
            { approvalMode: approvalPolicy, now: now() },
          );
          opts.taskStore.setStatus(taskId, 'pending_verification');
          opts.taskStore.finalizeVerification(taskId, fin.status, fin.evidence, fin.jobCard);
          // v4.14 Pillar 5 Slice C — artifact_verified onto the run's stream.
          try {
            emitArtifactVerified(
              { runStore: opts.runStore as unknown as PillarEventSink['runStore'], runId },
              {
                verdict:  fin.status,
                verified: fin.status === 'completed' || fin.status === 'completed_unverified',
                handles:  fin.evidence.handles?.length ?? 0,
                taskId:   taskId ?? undefined,
              },
            );
          } catch { /* telemetry must never break dispatch */ }
        } catch { /* card write must never break dispatch */ }
      }

      // v4.14 Pillar 5 Slice C — cost_updated: the run's token spend. The daemon
      // watcher tracks a single total (no in/out split), so report it as total.
      const spentTokens = perTurnWatcher.used();
      if (spentTokens > 0) {
        try {
          emitCostUpdated(
            { runStore: opts.runStore as unknown as PillarEventSink['runStore'], runId },
            { inputTokens: 0, outputTokens: 0, totalTokens: spentTokens },
          );
        } catch { /* telemetry must never break dispatch */ }
      }

      return {
        runId,
        finishReason,
        totalTokens: perTurnWatcher.used() > 0 ? perTurnWatcher.used() : undefined,
        error: invocationError ?? (perTurnWatcher.hit() ? perTurnWatcher.reason() ?? undefined : undefined),
      };
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Read the trigger spec row + extract Phase 7 spec fields. */
function readTriggerSpec(db: Db, triggerId: string): {
  provider?:        string;
  model?:           string;
  daemonApproval?:  string;
  maxTokensPerFire?: number;
} | null {
  try {
    const row = db.prepare(
      `SELECT spec_json FROM triggers WHERE id = ?`,
    ).get(triggerId) as { spec_json: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.spec_json) as Record<string, unknown>;
    return {
      provider:         typeof parsed.provider         === 'string' ? parsed.provider         : undefined,
      model:            typeof parsed.model            === 'string' ? parsed.model            : undefined,
      daemonApproval:   typeof parsed.daemonApproval   === 'string' ? parsed.daemonApproval   : undefined,
      maxTokensPerFire: typeof parsed.maxTokensPerFire === 'number' ? parsed.maxTokensPerFire : undefined,
    };
  } catch { return null; }
}

/** Read AIDEN_DAEMON_DAILY_BUDGET, parse as positive integer; null otherwise. */
function readDailyBudgetFromEnv(): number | null {
  const raw = process.env[ENV_DAILY_BUDGET];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Major-events run_event emitter for tool calls. Truncated payload. */
function emitToolEvent(
  runStore:  RunStore,
  runId:     number,
  sessionId: string,
  call:      ToolCallRequest,
  phase:     'before' | 'after',
  result:    ToolCallResult | undefined,
  startedAt: number,
  now:       () => number,
): void {
  try {
    // v4.10 Slice 10.2b — emit through emitEventRich with the shared
    // categoriser. tool_call_started and tool_call_completed share
    // toolCallId so consumers can pair them.
    if (phase === 'before') {
      const argsSummary = safeShortJson(call.arguments, 200);
      const tags = categorizeEvent('tool_call_started');
      runStore.emitEventRich({
        runId,
        category:  tags.category,
        kind:      tags.kind,
        name:      'tool_call_started',
        sessionId,
        toolCallId: call.id ?? null,
        status:    'started',
        summary:   call.name,
        payload: {
          toolName: call.name,
          args:     argsSummary,
          ts:       now(),
        },
        visibility: 'system',
        source:     'daemon',
      });
      return;
    }
    const tags = categorizeEvent('tool_call_completed');
    runStore.emitEventRich({
      runId,
      category:  tags.category,
      kind:      tags.kind,
      name:      'tool_call_completed',
      sessionId,
      toolCallId: call.id ?? null,
      status:    result?.error ? 'failed' : 'ok',
      durationMs: now() - startedAt,
      summary:   `${call.name}${result?.error ? ' (failed)' : ''}`,
      payload: {
        toolName:  call.name,
        error:     result?.error ?? null,
        hasResult: result?.result !== undefined && result?.result !== null,
        durationMs: now() - startedAt,
      },
      visibility: 'system',
      source:     'daemon',
    });
  } catch { /* never let observability crash the agent loop */ }
}

function safeShortJson(value: unknown, maxBytes: number): string {
  try {
    const s = JSON.stringify(value);
    return s.length > maxBytes ? s.slice(0, maxBytes) + '…' : s;
  } catch {
    return String(value).slice(0, maxBytes);
  }
}

/**
 * Pull the total-tokens count off an AidenAgentResult. The agent
 * exposes per-turn token usage via its result's `usage` field
 * (mirrors provider conventions). Falls back to 0 when missing.
 */
function extractTokens(result: AidenAgentResult | null): number {
  if (!result) return 0;
  const r = result as unknown as { usage?: { totalTokens?: number; total?: number } };
  return r.usage?.totalTokens ?? r.usage?.total ?? 0;
}

/**
 * Map the agent's finishReason + invocation outcome → the
 * DaemonAgentResult finishReason vocab the dispatcher expects.
 */
function pickFinishReason(
  result:           AidenAgentResult | null,
  invocationError:  string | null,
  perTurnHit:       boolean,
): DaemonAgentResult['finishReason'] {
  if (invocationError) return 'error';
  if (perTurnHit)      return 'budget_exhausted';
  if (!result)         return 'error';
  const fr = (result as unknown as { finishReason?: string }).finishReason;
  if (fr === 'stop')             return 'stop';
  if (fr === 'tool_loop')        return 'tool_loop';
  if (fr === 'budget_exhausted') return 'budget_exhausted';
  if (fr === 'error')            return 'error';
  // Default conservative — the dispatcher will markDone unless we
  // say error; treat unknown finishes as success for forward-compat.
  return 'stop';
}

/**
 * v4.5 Phase 7 — retry decision matrix.
 *
 * Maps a failure category to whether the dispatcher should re-queue
 * the event (with backoff cooldown) OR move it to dead_letter
 * immediately. Conservative `other` defaults to dead_letter so
 * unknowns surface instead of thrashing budget.
 */
import type { FailureCategory } from '../../failureClassifier';

export const RETRY_DECISION: Readonly<Record<FailureCategory, 'retry' | 'dead_letter'>> = Object.freeze({
  // Transient — retry with backoff
  timeout:                 'retry',
  network:                 'retry',
  rate_limit:              'retry',
  dependency_missing:      'retry',
  hallucination:           'retry',
  stale_ref:               'retry',
  // Permanent — dead-letter immediately
  auth:                    'dead_letter',
  permission:              'dead_letter',
  sandbox_violation:       'dead_letter',
  manual_blocker:          'dead_letter',
  trigger_misconfigured:   'dead_letter',
  trigger_quota:           'dead_letter',
  trigger_dead_lettered:   'dead_letter',
  invalid_input:           'dead_letter',
  not_found:               'dead_letter',
  other:                   'dead_letter',
});

/**
 * Compute the cooldown to wait before re-claiming a transient
 * failure. Formula: `min(2^attempts * 1000, 60000)` ms.
 * Exposed as a pure function so tests can assert the schedule:
 *
 *   attempts=1 → 2_000 ms
 *   attempts=2 → 4_000 ms
 *   attempts=3 → 8_000 ms
 *   attempts=6 → 60_000 ms (capped)
 */
export function computeRetryCooldownMs(attempts: number): number {
  const expo = Math.pow(2, Math.max(1, attempts)) * 1000;
  return Math.min(expo, 60_000);
}
