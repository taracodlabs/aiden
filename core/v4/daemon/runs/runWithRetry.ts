/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/runs/runWithRetry.ts — v4.9.0 Slice 8.
 *
 * Attempt orchestration on top of Slice 5's `run_attempts` table.
 * Caller supplies an existing run row id + a `RetryPolicy`; this
 * function creates one `run_attempts` row per attempt, runs `fn`
 * inside an incrementing-attempt context, and on retryable error
 * sleeps + tries again. On non-retryable error OR max-attempts cap,
 * returns `'dead_letter'` so the caller can route to a poison queue.
 *
 * The "what's retryable" decision lives in `retryPolicy.ts` so the
 * orchestrator stays small + testable.
 */

import type { Db } from '../db/connection';
import { createAttempt, completeAttempt, type AttemptStatus } from './attemptStore';
import { shouldRetry, computeBackoffMs, type RetryPolicy } from './retryPolicy';
import type { ExecutionContext } from '../../identity';

export type RetryOutcome<T> =
  | { outcome: 'completed';  value: T;     attempts: number }
  | { outcome: 'failed';     attempts: number; lastError: Error }
  | { outcome: 'dead_letter'; attempts: number; lastError: Error };

export interface RunWithRetryOptions {
  runId:         number;
  incarnationId: string;
  policy:        RetryPolicy;
  /** Test seam — clock injection. */
  now?:          () => number;
  /** Test seam — sleep injection (default `setTimeout`). */
  sleep?:        (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `fn` with retry policy. Each attempt gets its own `run_attempts`
 * row + an incremented `ctx.attempt` value visible to the callee.
 */
export async function runWithRetry<T>(
  db:    Db,
  ctx:   ExecutionContext,
  opts:  RunWithRetryOptions,
  fn:    (ctx: ExecutionContext, attemptNumber: number) => Promise<T>,
): Promise<RetryOutcome<T>> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: Error = new Error('runWithRetry: no attempts made');
  let attemptCount = 0;

  for (let attemptNumber = 1; attemptNumber <= opts.policy.maxAttempts; attemptNumber += 1) {
    attemptCount = attemptNumber;
    const attemptId = createAttempt(db, {
      runId:         opts.runId,
      incarnationId: opts.incarnationId,
    });
    const attemptCtx: ExecutionContext = { ...ctx, attempt: attemptNumber };
    try {
      const value = await fn(attemptCtx, attemptNumber);
      completeAttempt(db, { attemptId, status: 'completed' });
      return { outcome: 'completed', value, attempts: attemptNumber };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      const errorClass = error.name || 'Error';
      const terminalStatus: AttemptStatus = 'failed';
      completeAttempt(db, {
        attemptId,
        status:       terminalStatus,
        errorClass,
        errorMessage: error.message,
      });

      // Three cases:
      //   (a) Class is in nonRetryableErrorClasses     → dead_letter (terminal class)
      //   (b) Class is in retryableErrorClasses        → retry IF cap not reached; else dead_letter (exhausted)
      //   (c) Class is unknown                         → failed (caller introspects; no auto-retry)
      const isNonRetryable = opts.policy.nonRetryableErrorClasses.includes(errorClass);
      const isRetryable    = opts.policy.retryableErrorClasses.includes(errorClass);
      if (isNonRetryable) {
        return { outcome: 'dead_letter', attempts: attemptNumber, lastError: error };
      }
      if (!isRetryable) {
        return { outcome: 'failed',      attempts: attemptNumber, lastError: error };
      }
      if (attemptNumber >= opts.policy.maxAttempts) {
        return { outcome: 'dead_letter', attempts: attemptNumber, lastError: error };
      }
      // Retryable + cap not reached: back off and try again.
      await sleep(computeBackoffMs(attemptNumber, opts.policy));
    }
  }
  // Defensive fallback — loop exited without explicit return.
  return { outcome: 'dead_letter', attempts: attemptCount, lastError };
}
