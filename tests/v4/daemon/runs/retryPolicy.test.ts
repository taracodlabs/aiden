/**
 * tests/v4/daemon/runs/retryPolicy.test.ts — v4.9.0 Slice 8.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldRetry,
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
} from '../../../../core/v4/daemon/runs/retryPolicy';

describe('shouldRetry — Slice 8', () => {
  it('returns false when attempt cap reached', () => {
    expect(shouldRetry('NetworkError', DEFAULT_RETRY_POLICY.maxAttempts, DEFAULT_RETRY_POLICY)).toBe(false);
    expect(shouldRetry('NetworkError', DEFAULT_RETRY_POLICY.maxAttempts + 5, DEFAULT_RETRY_POLICY)).toBe(false);
  });

  it('returns true for retryable error class within cap', () => {
    expect(shouldRetry('NetworkError', 1, DEFAULT_RETRY_POLICY)).toBe(true);
    expect(shouldRetry('TimeoutError', 1, DEFAULT_RETRY_POLICY)).toBe(true);
    expect(shouldRetry('ResourceExhausted', 1, DEFAULT_RETRY_POLICY)).toBe(true);
  });

  it('returns false for non-retryable error class', () => {
    expect(shouldRetry('AuthError', 1, DEFAULT_RETRY_POLICY)).toBe(false);
    expect(shouldRetry('PermissionDenied', 1, DEFAULT_RETRY_POLICY)).toBe(false);
    expect(shouldRetry('ValidationError', 1, DEFAULT_RETRY_POLICY)).toBe(false);
  });

  it('returns false for unknown error class (fail closed)', () => {
    expect(shouldRetry('SomeRandomError', 1, DEFAULT_RETRY_POLICY)).toBe(false);
  });

  it('non-retryable precedence beats retryable when listed in both (shouldnt happen, but)', () => {
    const policy = { ...DEFAULT_RETRY_POLICY,
      retryableErrorClasses:    ['Foo'],
      nonRetryableErrorClasses: ['Foo'] };
    expect(shouldRetry('Foo', 1, policy)).toBe(false);
  });
});

describe('computeBackoffMs — Slice 8', () => {
  const fixedRng = (): number => 0.5;
  const policyNone   = { ...DEFAULT_RETRY_POLICY, jitter: 'none'  as const };
  const policyEqual  = { ...DEFAULT_RETRY_POLICY, jitter: 'equal' as const };
  const policyFull   = { ...DEFAULT_RETRY_POLICY, jitter: 'full'  as const };

  it('attempt 0 returns 0', () => {
    expect(computeBackoffMs(0, policyNone)).toBe(0);
  });

  it('exponential progression with jitter=none', () => {
    expect(computeBackoffMs(1, policyNone)).toBe(1000);
    expect(computeBackoffMs(2, policyNone)).toBe(2000);
    expect(computeBackoffMs(3, policyNone)).toBe(4000);
    expect(computeBackoffMs(4, policyNone)).toBe(8000);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoffMs(20, policyNone)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('equal jitter: in [cap/2, cap]', () => {
    const v = computeBackoffMs(2, policyEqual, fixedRng);
    expect(v).toBeGreaterThanOrEqual(1000);
    expect(v).toBeLessThanOrEqual(2000);
  });

  it('full jitter: in [0, cap]', () => {
    const v = computeBackoffMs(2, policyFull, fixedRng);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(2000);
  });
});
