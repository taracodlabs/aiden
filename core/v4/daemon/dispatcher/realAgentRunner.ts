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
import type { ResourceRegistry } from '../resourceRegistry';
import type { TriggerRowSql } from '../db/schema/v1.spec';
import type {
  DaemonAgentInput,
  DaemonAgentResult,
  DaemonAgentRunner,
} from './agentRunner';
import { buildInitialHistory } from './agentRunner';
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
        opts.runStore.emitEvent(runId, 'dispatcher:rejected', {
          reason:        verdict.reason ?? 'trigger_quota',
          dailySnapshot: verdict.daily,
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

      // ── 5: run row + dispatcher:invoked event ─────────────────────────
      const runId = opts.runStore.create({
        sessionId:      input.sessionId,
        instanceId:     input.instanceId,
        triggerEventId: input.triggerEventId,
        status:         'running',
      });
      opts.runStore.emitEvent(runId, 'dispatcher:invoked', {
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
            onToolCall: (call, phase, result) => emitToolEvent(opts.runStore, runId, call, phase, result, startedAt, now),
            onBudgetWarning: (level, turn, max) => {
              opts.runStore.emitEvent(runId, 'budget_warning', { level, turn, max });
            },
          },
          abortSignal: perTurnWatcher.signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('error', `[real-runner] agentBuilder threw eventId=${input.triggerEventId}: ${msg}`);
        opts.runStore.emitEvent(runId, 'dispatcher:builder_failed', { error: msg });
        opts.runStore.setStatus(runId, 'failed', { finishReason: 'error' });
        return { runId, finishReason: 'error', error: msg };
      }

      // ── 8: invoke runConversation ─────────────────────────────────────
      let result: AidenAgentResult | null = null;
      let invocationError: string | null = null;
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
          // v4.8.0 Phase 2.2 — uiOnly events on the daemon side are
          // dropped here. Phase 2.4 will serialize them into the
          // dispatcher's run_events stream.
          onUiEvent: () => { /* no-op stub — Phase 2.4 serializes to run_events */ },
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
      opts.runStore.emitEvent(runId, 'dispatcher:completed', {
        finishReason,
        totalTokens:   perTurnWatcher.used(),
        durationMs:    now() - startedAt,
        dailySnapshot: finalSnapshot,
        perTurnBudgetHit: perTurnWatcher.hit(),
        perTurnReason: perTurnWatcher.reason(),
        invocationError: invocationError ? invocationError.slice(0, 200) : null,
      });

      // ── 10: map result → DaemonAgentResult ────────────────────────────
      const runStatus =
        finishReason === 'stop'              ? 'completed' :
        finishReason === 'budget_exhausted'  ? 'failed'    :
        finishReason === 'error'             ? 'failed'    :
        finishReason === 'tool_loop'         ? 'failed'    : 'completed';
      opts.runStore.setStatus(runId, runStatus, { finishReason });

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
  runStore: RunStore,
  runId:    number,
  call:     ToolCallRequest,
  phase:    'before' | 'after',
  result:   ToolCallResult | undefined,
  startedAt: number,
  now:      () => number,
): void {
  try {
    if (phase === 'before') {
      const argsSummary = safeShortJson(call.arguments, 200);
      runStore.emitEvent(runId, 'tool_call_started', {
        toolName: call.name,
        args:     argsSummary,
        ts:       now(),
      });
      return;
    }
    runStore.emitEvent(runId, 'tool_call_completed', {
      toolName:  call.name,
      error:     result?.error ?? null,
      hasResult: result?.result !== undefined && result?.result !== null,
      durationMs: now() - startedAt,
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
