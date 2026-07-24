import type { SkipAwareCache } from './skipState';

export const UPDATE_FAILURE_BACKOFF_MS = [
  60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
] as const;

export interface FailureAwareCache extends SkipAwareCache {
  failedVersion?: string;
  failureCount?: number;
  retryAfter?: number;
}

export function applyUpdateFailure(
  cache: FailureAwareCache,
  version: string,
  now: number = Date.now(),
): FailureAwareCache {
  const priorCount = cache.failedVersion === version ? cache.failureCount ?? 0 : 0;
  const failureCount = priorCount + 1;
  const delay = UPDATE_FAILURE_BACKOFF_MS[
    Math.min(failureCount - 1, UPDATE_FAILURE_BACKOFF_MS.length - 1)
  ];
  return {
    ...cache,
    failedVersion: version,
    failureCount,
    retryAfter: now + delay,
  };
}

export function isUpdateFailureBackedOff(
  cache: FailureAwareCache,
  version: string,
  now: number = Date.now(),
): boolean {
  return cache.failedVersion === version &&
    typeof cache.retryAfter === 'number' &&
    now < cache.retryAfter;
}

export function clearUpdateFailure(cache: FailureAwareCache): FailureAwareCache {
  const next = { ...cache };
  delete next.failedVersion;
  delete next.failureCount;
  delete next.retryAfter;
  return next;
}
