/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/runs/retryPolicy.ts — v4.9.0 Slice 8.
 *
 * Pure policy primitives — `shouldRetry` + `computeBackoffMs`. The
 * orchestrator (`runWithRetry`) lives next door; this module is
 * test-friendly with no side effects.
 *
 * Defaults chosen to match the implicit policy across the rest of
 * v4: max 3 attempts, exponential backoff with full jitter capped
 * at 30s. NetworkError / TimeoutError / ResourceExhausted are
 * retryable; auth + permission + validation are terminal.
 */

export type JitterMode = 'full' | 'equal' | 'none';

export interface RetryPolicy {
  maxAttempts:              number;
  baseDelayMs:              number;
  maxDelayMs:               number;
  jitter:                   JitterMode;
  retryableErrorClasses:    readonly string[];
  nonRetryableErrorClasses: readonly string[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts:              3,
  baseDelayMs:              1_000,
  maxDelayMs:               30_000,
  jitter:                   'full',
  retryableErrorClasses:    ['NetworkError', 'TimeoutError', 'ResourceExhausted'],
  nonRetryableErrorClasses: ['AuthError', 'PermissionDenied', 'ValidationError'],
};

/**
 * Decide whether to retry given the error class + attempt number.
 *
 * Precedence:
 *   1. attemptNumber >= maxAttempts  → false (cap reached)
 *   2. nonRetryableErrorClasses hit  → false (terminal)
 *   3. retryableErrorClasses hit     → true
 *   4. unknown error class           → false (fail closed)
 *
 * Treating unknown errors as non-retryable matches Aiden's safety
 * stance: a retry burst on an unknown failure can multiply damage.
 */
export function shouldRetry(
  errorClass:    string,
  attemptNumber: number,
  policy:        RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  if (attemptNumber >= policy.maxAttempts) return false;
  if (policy.nonRetryableErrorClasses.includes(errorClass)) return false;
  if (policy.retryableErrorClasses.includes(errorClass))    return true;
  return false;
}

/**
 * Exponential backoff with optional jitter, capped at `maxDelayMs`.
 *   attemptNumber=1 → base
 *   attemptNumber=2 → base*2
 *   attemptNumber=3 → base*4
 * Jitter modes:
 *   'none'  — exact value
 *   'equal' — value/2 + random(0..value/2)
 *   'full'  — random(0..value)
 */
export function computeBackoffMs(
  attemptNumber: number,
  policy:        RetryPolicy = DEFAULT_RETRY_POLICY,
  rng:           () => number = Math.random,
): number {
  if (attemptNumber < 1) return 0;
  const exp = policy.baseDelayMs * Math.pow(2, attemptNumber - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  switch (policy.jitter) {
    case 'none':  return capped;
    case 'equal': return Math.floor(capped / 2 + rng() * (capped / 2));
    case 'full':  return Math.floor(rng() * capped);
  }
}
