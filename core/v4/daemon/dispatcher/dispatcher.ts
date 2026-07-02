/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/dispatcher.ts — v4.5 Phase 5a.
 *
 * The bus consumer. Bridges the durable trigger queue
 * (`triggerBus`) to the agent loop (`DaemonAgentRunner`).
 *
 * Loop body (workerCount-bounded, default 1 per Q-P5-1):
 *
 *   1. `triggerBus.claim({ownerId, leaseMs})` — atomic claim.
 *   2. Read trigger spec row (`triggers` table) for fire_rate_limit /
 *      prompt_template / deliver_only. Missing row → defaults
 *      (no template, not deliver-only, no fire-rate cap).
 *   3. Build sessionId via `buildTriggerSessionId`.
 *   4. Render prompt template (if any) with payload vars. Missing
 *      vars + non-empty template → markFailed with
 *      `trigger_misconfigured` classification hint.
 *   5. Start lease-renew timer (default 60s cadence, extends by
 *      `leaseMs`). Runs for the lifetime of the invocation.
 *   6. Invoke runner. Catch any throw.
 *   7. On clean return → `markDone(eventId, claimToken, runId)`.
 *      On throw or error finish-reason → `markFailed` which auto-
 *      transitions to `dead_letter` after `maxAttempts`.
 *   8. Renew timer cleared.
 *
 * Concurrency: a semaphore (in-flight count vs workerCount)
 * guards the claim loop. Each claim spawns an async worker that
 * decrements the semaphore on exit. The poll interval is short
 * (250ms) when no event was claimed; it ratchets up via the
 * adaptive backoff inside `_pollOnce` when the bus is empty.
 *
 * Shutdown: `stop(timeoutMs)` flips an `_stopping` flag, then
 * awaits the in-flight worker promises (race against
 * `timeoutMs`). Workers that exceed the deadline are NOT killed
 * (the runner contract is cooperative-stop; runs eventually
 * land in `markFailed` via the claim-lease-expired path on the
 * next instance).
 */

import { randomUUID } from 'node:crypto';

import type { TriggerBus } from '../triggerBus';
import type { RunStore } from '../runStore';
import type { ClaimedEvent, TriggerSource } from '../types';
import type { Db } from '../db/connection';
import type { TriggerRowSql } from '../db/schema/v1.spec';
import {
  buildTriggerSessionId,
} from './sessionId';
import {
  renderPromptTemplate,
  flattenPayloadToVars,
} from './promptTemplate';
import {
  buildInitialHistory,
  deliverOnlyStub,
} from './agentRunner';
import type {
  DaemonAgentInput,
  DaemonAgentResult,
  DaemonAgentRunner,
  TriggerInvocationContext,
} from './agentRunner';
import { computeRetryCooldownMs } from './realAgentRunner';

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_WORKER_COUNT      = 1;
const DEFAULT_POLL_IDLE_MS      = 250;
const DEFAULT_POLL_BUSY_MS      = 0;            // immediate re-poll while events drain
const DEFAULT_LEASE_MS          = 5 * 60_000;
const DEFAULT_RENEW_MS          = 60_000;
const DEFAULT_MAX_ATTEMPTS      = 3;
const DEFAULT_STOP_TIMEOUT_MS   = 30_000;

// ── Types ──────────────────────────────────────────────────────────────────

export type DispatcherLogFn = (level: 'info' | 'warn' | 'error', msg: string) => void;

export interface CreateDispatcherOptions {
  triggerBus:    TriggerBus;
  runStore:      RunStore;
  /** SQLite db handle — used to read `triggers` table for spec lookup. */
  db:            Db;
  /** Owner id stamped on each claim (typically the instanceId). */
  ownerId:       string;
  /** Instance id stamped on `runs.instance_id`. */
  instanceId:    string;
  /**
   * Runner factory. Called once on `start()`. Tests pass a stub
   * factory that returns a deterministic runner.
   *
   * Bootstrap will pass a factory that constructs an AidenAgent +
   * provider + toolExecutor.
   */
  runnerFactory: () => DaemonAgentRunner;
  workerCount?:  number;
  leaseMs?:     number;
  renewMs?:     number;
  maxAttempts?: number;
  pollIdleMs?:  number;
  log?:          DispatcherLogFn;
}

export interface DispatcherInflight {
  eventId:   number;
  sessionId: string;
  source:    TriggerSource;
  startedAt: number;
}

export interface Dispatcher {
  start(): void;
  stop(timeoutMs?: number): Promise<void>;
  /** Diagnostic — currently in-flight claims. */
  inflight(): DispatcherInflight[];
  /** Diagnostic — total claims processed since start. */
  stats(): {
    claimed:     number;
    succeeded:   number;
    failed:      number;
    deadLetter:  number;
    deliverOnly: number;
    misconfigured: number;
  };
  /**
   * v4.5 Phase 7c — atomic runner swap. Called by
   * `installDaemonAgentBuilder()` once the CLI's REPL agent is
   * built. The dispatcher's poll loop reads `runner` on each
   * `_pumpOnce` so the swap takes effect immediately on the next
   * claim. In-flight claims continue on the previous runner.
   */
  installRunner(next: DaemonAgentRunner): void;
  /**
   * v4.5 Phase 7c — diagnostic. Reports which runner is currently
   * active. Useful for `aiden daemon status` and tests.
   */
  runnerKind(): 'placeholder' | 'real' | 'none';
  /**
   * Test-only — run a single claim/dispatch cycle synchronously.
   * Returns the event id processed (or null if nothing was claimed).
   * Lets tests assert behaviour without driving the poll loop.
   */
  _pumpOnce(): Promise<number | null>;
}

// ── Implementation ─────────────────────────────────────────────────────────

export function createDispatcher(opts: CreateDispatcherOptions): Dispatcher {
  const workerCount = opts.workerCount ?? DEFAULT_WORKER_COUNT;
  const leaseMs     = opts.leaseMs     ?? DEFAULT_LEASE_MS;
  const renewMs     = opts.renewMs     ?? DEFAULT_RENEW_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pollIdleMs  = opts.pollIdleMs  ?? DEFAULT_POLL_IDLE_MS;
  const log         = opts.log         ?? (() => { /* silent */ });

  let runner:   DaemonAgentRunner | null = null;
  // v4.5 Phase 7c — `runnerKind` lets diagnostics + tests distinguish
  // the placeholder-runner phase from the real-agent-runner phase.
  // The factory-bound initial runner is tagged 'placeholder' by
  // default; `installRunner` flips to 'real'.
  let _runnerKind: 'placeholder' | 'real' | 'none' = 'none';
  let _started = false;
  let _stopping = false;
  let _pollTimer: NodeJS.Timeout | null = null;
  const _inflight = new Map<number, DispatcherInflight>();
  const _workerPromises = new Set<Promise<unknown>>();

  const _stats = {
    claimed:       0,
    succeeded:     0,
    failed:        0,
    deadLetter:    0,
    deliverOnly:   0,
    misconfigured: 0,
  };

  // ── Trigger spec lookup ─────────────────────────────────────────────────
  function readTriggerSpec(sourceKey: string): TriggerRowSql | null {
    try {
      const row = opts.db
        .prepare('SELECT * FROM triggers WHERE id = ?')
        .get(sourceKey) as TriggerRowSql | undefined;
      return row ?? null;
    } catch (e) {
      log('warn', `[dispatcher] failed to read trigger spec ${sourceKey}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // ── Build TriggerInvocationContext ──────────────────────────────────────
  function buildContext(
    event: ClaimedEvent,
    spec:  TriggerRowSql | null,
  ): TriggerInvocationContext {
    return {
      triggerId:     event.sourceKey,
      source:        event.source,
      sourceKey:     event.sourceKey,
      fireReason:    typeof event.payload.fireReason === 'string'
                       ? event.payload.fireReason
                       : 'trigger_fired',
      eventId:       event.id,
      attempt:       event.attempts,
      maxAttempts,
      promptTemplate: spec?.prompt_template ?? null,
    };
  }

  // ── Render initial message ──────────────────────────────────────────────
  /**
   * Returns the rendered message + missing-vars list. When no
   * template is set, falls back to a structured JSON dump of the
   * payload — the agent gets a readable initial prompt even
   * without operator-supplied templates.
   */
  function renderInitialMessage(
    event: ClaimedEvent,
    template: string | null,
  ): { message: string; missing: string[] } {
    // v4.13 Gap 4 — a resume event carries its FULL prompt verbatim
    // (revalidation preamble + original goal, built by the resume
    // sweep). Never templated, never payload-dumped.
    const resumePrompt = (event.payload as { resume?: { prompt?: unknown } } | null)?.resume?.prompt;
    if (typeof resumePrompt === 'string' && resumePrompt.length > 0) {
      return { message: resumePrompt, missing: [] };
    }
    if (template && template.length > 0) {
      const vars = flattenPayloadToVars(event.payload);
      // Inject a couple of dispatcher-known fields so templates can
      // reference {{eventId}} / {{source}} / {{attempt}} / etc.
      vars.eventId   = event.id;
      vars.source    = event.source;
      vars.sourceKey = event.sourceKey;
      vars.attempt   = event.attempts;
      const { rendered, missing } = renderPromptTemplate(template, vars);
      return { message: rendered, missing };
    }
    // Fallback: structured payload header so the model knows the
    // source + can reason over the JSON body. Keeps the initial
    // message useful when the operator skipped the template.
    return {
      message: defaultInitialMessage(event),
      missing: [],
    };
  }

  function defaultInitialMessage(event: ClaimedEvent): string {
    const header = `Trigger fired: ${event.source} (id=${event.sourceKey})`;
    let body: string;
    try { body = JSON.stringify(event.payload, null, 2); }
    catch { body = '<payload not serialisable>'; }
    return `${header}\n\nPayload:\n\`\`\`json\n${body}\n\`\`\``;
  }

  // ── Lease renewal ───────────────────────────────────────────────────────
  function startRenewTimer(eventId: number, claimToken: string): NodeJS.Timeout {
    const t = setInterval(() => {
      try {
        const ok = opts.triggerBus.renewClaim(eventId, claimToken, leaseMs);
        if (!ok) {
          log('warn', `[dispatcher] renew failed eventId=${eventId} — claim invalidated`);
          clearInterval(t);
        }
      } catch (e) {
        log('warn', `[dispatcher] renew threw eventId=${eventId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, renewMs);
    if (typeof t.unref === 'function') t.unref();
    return t;
  }

  // ── Process one claim ───────────────────────────────────────────────────
  async function processClaim(event: ClaimedEvent): Promise<void> {
    const spec    = readTriggerSpec(event.sourceKey);
    const context = buildContext(event, spec);
    const sessionId = buildTriggerSessionId({
      source:         event.source,
      sourceKey:      event.sourceKey,
      idempotencyKey: event.idempotencyKey,
    });

    // Record in-flight.
    const inflightRow: DispatcherInflight = {
      eventId:   event.id,
      sessionId,
      source:    event.source,
      startedAt: Date.now(),
    };
    _inflight.set(event.id, inflightRow);

    // Start renew timer; clean up on every exit path.
    const renewTimer = startRenewTimer(event.id, event.claimToken);

    try {
      // Render initial message + check missing vars.
      const { message, missing } = renderInitialMessage(event, spec?.prompt_template ?? null);
      if (missing.length > 0 && spec?.prompt_template) {
        const reason = `trigger_misconfigured: template references undefined vars: ${missing.join(', ')}`;
        log('warn', `[dispatcher] ${reason} (eventId=${event.id} trigger=${event.sourceKey})`);
        // misconfigured = permanent failure; no cooldown needed since
        // retry won't help, but we still call markFailed (which will
        // dead-letter after maxAttempts).
        opts.triggerBus.markFailed(event.id, event.claimToken, reason, { maxAttempts });
        _stats.misconfigured += 1;
        _stats.failed        += 1;
        // markFailed may transition to dead_letter when attempts >= maxAttempts.
        if (event.attempts >= maxAttempts) _stats.deadLetter += 1;
        return;
      }

      // Build the input + branch on deliverOnly.
      const deliverOnly = spec?.deliver_only === 1;
      // v4.13 Gap 4 — resume passthrough: the sweep's trigger event
      // carries {taskId, ofRunId, attempt} so the runner reuses the
      // existing job-card instead of minting a new one.
      const resumeRaw = (event.payload as {
        resume?: { taskId?: unknown; ofRunId?: unknown; attempt?: unknown };
      } | null)?.resume;
      const resume =
        resumeRaw
        && typeof resumeRaw.taskId === 'string'
        && typeof resumeRaw.ofRunId === 'number'
          ? {
              taskId:  resumeRaw.taskId,
              ofRunId: resumeRaw.ofRunId,
              attempt: typeof resumeRaw.attempt === 'number' ? resumeRaw.attempt : 1,
            }
          : undefined;
      const input: DaemonAgentInput = {
        sessionId,
        instanceId:     opts.instanceId,
        triggerEventId: event.id,
        triggerContext: context,
        initialMessage: message,
        deliverOnly,
        ...(resume ? { resume } : {}),
      };

      let result: DaemonAgentResult;
      if (deliverOnly) {
        result = deliverOnlyStub(input, opts.runStore);
        _stats.deliverOnly += 1;
      } else {
        if (!runner) {
          // Safety net — start() guarantees runner is set, but be
          // defensive in case of test misuse.
          throw new Error('dispatcher: runnerFactory has not been invoked');
        }
        // Discard return — we just need it to not be unused.
        void buildInitialHistory;
        result = await runner.invoke(input);
      }

      // Map finishReason to bus action.
      if (result.finishReason === 'error') {
        const errMsg = result.error ?? 'agent reported error finish';
        opts.triggerBus.markFailed(event.id, event.claimToken, errMsg, {
          maxAttempts,
          cooldownMs: computeRetryCooldownMs(event.attempts),
        });
        _stats.failed += 1;
        if (event.attempts >= maxAttempts) _stats.deadLetter += 1;
        return;
      }

      // Success — markDone with the runId.
      opts.triggerBus.markDone(event.id, event.claimToken, result.runId);
      _stats.succeeded += 1;
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      log('error', `[dispatcher] worker threw eventId=${event.id}: ${msg}`);
      try {
        opts.triggerBus.markFailed(event.id, event.claimToken, msg.slice(0, 500), {
          maxAttempts,
          cooldownMs: computeRetryCooldownMs(event.attempts),
        });
      } catch { /* bus may be in a weird state; swallow */ }
      _stats.failed += 1;
      if (event.attempts >= maxAttempts) _stats.deadLetter += 1;
    } finally {
      clearInterval(renewTimer);
      _inflight.delete(event.id);
    }
  }

  // ── Worker semaphore + claim loop ───────────────────────────────────────
  async function _pollOnce(): Promise<number | null> {
    if (_stopping) return null;
    if (_inflight.size >= workerCount) return null;
    const event = opts.triggerBus.claim({ ownerId: opts.ownerId, leaseMs });
    if (!event) return null;
    _stats.claimed += 1;
    log('info', `[dispatcher] claimed eventId=${event.id} source=${event.source} attempt=${event.attempts}/${maxAttempts}`);
    const p = processClaim(event).finally(() => {
      _workerPromises.delete(p);
    });
    _workerPromises.add(p);
    return event.id;
  }

  function _schedulePoll(): void {
    if (_stopping) return;
    if (_pollTimer) return;
    _pollTimer = setTimeout(async () => {
      _pollTimer = null;
      try {
        const claimedId = await _pollOnce();
        // Adaptive: if we just claimed something, re-poll immediately
        // (drain bus); otherwise wait `pollIdleMs`.
        const next = claimedId !== null ? DEFAULT_POLL_BUSY_MS : pollIdleMs;
        if (!_stopping) {
          _pollTimer = setTimeout(_schedulePollFromTimer, next);
          if (_pollTimer && typeof _pollTimer.unref === 'function') _pollTimer.unref();
        }
      } catch (e) {
        log('error', `[dispatcher] poll threw: ${e instanceof Error ? e.message : String(e)}`);
        if (!_stopping) {
          _pollTimer = setTimeout(_schedulePollFromTimer, pollIdleMs);
          if (_pollTimer && typeof _pollTimer.unref === 'function') _pollTimer.unref();
        }
      }
    }, pollIdleMs);
    if (typeof _pollTimer.unref === 'function') _pollTimer.unref();
  }

  function _schedulePollFromTimer(): void {
    _pollTimer = null;
    _schedulePoll();
  }

  return {
    start() {
      if (_started) return;
      _started = true;
      runner = opts.runnerFactory();
      // Initial runner from the factory is the placeholder unless the
      // factory itself returned a real runner. The CLI's two-phase
      // bootstrap (Phase 7c) starts with a placeholder factory and
      // calls `installRunner` later with the real one.
      _runnerKind = 'placeholder';
      log('info', `[dispatcher] starting workerCount=${workerCount} leaseMs=${leaseMs} runner=placeholder`);
      _schedulePoll();
    },
    installRunner(next: DaemonAgentRunner) {
      // Atomic swap — JS single-threaded execution means the read in
      // _pumpOnce / processClaim can never see a half-installed runner.
      runner = next;
      _runnerKind = 'real';
      log('info', `[dispatcher] runner swapped → real (next claim uses new runner)`);
    },
    runnerKind() {
      return _runnerKind;
    },
    async stop(timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
      _stopping = true;
      if (_pollTimer) {
        clearTimeout(_pollTimer);
        _pollTimer = null;
      }
      // Race in-flight drain against the timeout.
      const drain = Promise.allSettled([..._workerPromises]);
      const deadline = new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      });
      await Promise.race([drain, deadline]);
      log('info', `[dispatcher] stopped — inflight=${_inflight.size} processed=${_stats.claimed}`);
    },
    inflight() {
      return [..._inflight.values()];
    },
    stats() {
      return { ..._stats };
    },
    async _pumpOnce() {
      if (!runner) runner = opts.runnerFactory();
      const event = opts.triggerBus.claim({ ownerId: opts.ownerId, leaseMs });
      if (!event) return null;
      _stats.claimed += 1;
      // Track the worker promise so stop() can wait on it.
      const p = processClaim(event);
      _workerPromises.add(p);
      try {
        await p;
      } finally {
        _workerPromises.delete(p);
      }
      return event.id;
    },
  };
}

// Unique id helper (kept here so dispatchers in tests can use the
// same util their producers do when fabricating event ids).
export function _dispatcherOwnerId(prefix = 'disp'): string {
  return `${prefix}-${randomUUID()}`;
}
