/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/fireRateLimiter.ts — v4.5 Phase 5a.
 *
 * Per-trigger sliding-window fire-rate cap.
 *
 * Q-P5-5(c): unlimited by default. Each trigger spec carries an
 * optional `fireRateLimit` (rows-per-window). When set, this
 * module enforces a per-triggerId sliding window of size
 * `windowMs` (default 1 hour). The Nth fire within the window is
 * the LAST one allowed; the (N+1)th and beyond are blocked.
 *
 * Behaviour when blocked:
 *   - `check()` returns `false` + populates `reason` field
 *   - producer chooses what to do (typical: insert event + immediately
 *     dead-letter so the operator has forensic visibility via
 *     `/api/daemon/triggers/<id>/stats`)
 *
 * Anti-thrash motivation (from the prior-systems learning batch): a
 * misconfigured webhook upstream can fire 60k times per minute. A
 * busted file watcher on a temp directory can fire 1000 times per
 * second. The producer-side cap stops the bus from inflating and
 * keeps the operator's ability to query "what blew up" intact.
 *
 * Storage: in-memory `Map<triggerId, number[]>` of fire timestamps
 * within the active window. Pruned lazily on each `check()` —
 * old timestamps drop off the front when they fall outside `now -
 * windowMs`. Bounded by max-fires-per-window (no unbounded growth
 * even if the producer keeps hammering — once over the cap,
 * incoming attempts are rejected immediately without recording).
 *
 * Idempotent reset via `__resetForTests()`.
 */

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;     // 1 hour

/** Sliding-window primitive. Public for tests + producer integration. */
export interface FireRateLimiter {
  /**
   * Consult the limiter for `triggerId`. When `limit` is `null` /
   * `undefined`, the limiter is bypassed (returns `{allowed:true}`).
   * Otherwise, prune the window then either:
   *   - record the fire + return `allowed:true`, OR
   *   - return `allowed:false` + a structured reason
   *
   * Side-effect: when allowed, the current `now` timestamp is
   * appended to the window. Callers should treat `check` as
   * "consume one fire slot if available".
   */
  check(triggerId: string, limit: number | null | undefined, now?: number): {
    allowed: boolean;
    /** Number of fires recorded in the active window (post-prune). */
    windowCount: number;
    /** Limit applied (mirrors input). */
    limit: number | null | undefined;
    /** Populated when allowed=false. */
    reason?: string;
  };
  /** Diagnostic — current window count without recording. */
  peek(triggerId: string, now?: number): number;
  /** Diagnostic — drop a triggerId's window (e.g. after delete). */
  reset(triggerId: string): void;
  /** Test-only — clear all windows. */
  __resetForTests(): void;
}

export interface CreateFireRateLimiterOptions {
  /** Sliding-window size in ms. Default 1 hour. */
  windowMs?: number;
}

export function createFireRateLimiter(
  opts: CreateFireRateLimiterOptions = {},
): FireRateLimiter {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const windows: Map<string, number[]> = new Map();

  function prune(triggerId: string, now: number): number[] {
    const cutoff = now - windowMs;
    const list = windows.get(triggerId);
    if (!list) return [];
    // Find the first timestamp >= cutoff and slice. Most-common case:
    // few or zero entries to drop, so iterate from the front.
    let i = 0;
    while (i < list.length && list[i] < cutoff) i++;
    if (i > 0) {
      const kept = list.slice(i);
      if (kept.length === 0) windows.delete(triggerId);
      else                    windows.set(triggerId, kept);
      return kept;
    }
    return list;
  }

  return {
    check(triggerId, limit, now = Date.now()) {
      // Unlimited path — bypass entirely. No window recording.
      if (limit === null || limit === undefined || limit <= 0) {
        return { allowed: true, windowCount: 0, limit };
      }
      const list = prune(triggerId, now);
      if (list.length >= limit) {
        return {
          allowed:     false,
          windowCount: list.length,
          limit,
          reason:      `fire-rate cap exceeded: ${list.length}/${limit} per ${Math.round(windowMs / 1000)}s window`,
        };
      }
      // Allowed — record the fire.
      const next = [...list, now];
      windows.set(triggerId, next);
      return { allowed: true, windowCount: next.length, limit };
    },
    peek(triggerId, now = Date.now()) {
      return prune(triggerId, now).length;
    },
    reset(triggerId) {
      windows.delete(triggerId);
    },
    __resetForTests() {
      windows.clear();
    },
  };
}

// Process-wide singleton — most call sites (producer-side fire
// gates) want a shared limiter. Tests instantiate their own.
let _singleton: FireRateLimiter | null = null;

/** Return the process-wide limiter, creating it on first call. */
export function getFireRateLimiter(): FireRateLimiter {
  if (!_singleton) _singleton = createFireRateLimiter();
  return _singleton;
}

/** Test-only — reset the singleton. */
export function __resetFireRateLimiterSingletonForTests(): void {
  if (_singleton) _singleton.__resetForTests();
  _singleton = null;
}
