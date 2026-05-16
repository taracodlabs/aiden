/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/webhookRateLimit.ts — v4.5 Phase 3.
 *
 * Per-route fixed-window rate limiter. In-memory only — daemon
 * restart resets the counters (acceptable).
 *
 * Window: 60 seconds. Per-route cap configured by spec.rateLimit.perMinute.
 *
 * Critical ordering: called AFTER HMAC verification so an
 * unauthenticated attacker cannot burn the legitimate quota with
 * bad-signature spam.
 */

const WINDOW_MS = 60_000;

export interface RateLimiter {
  /** Returns true when the request is within quota; false to deny. */
  allow(routeId: string, perMinute: number): boolean;
  /** Diagnostic. */
  stats(routeId: string): { count: number; oldestMs: number | null };
  /** Test helper. */
  reset(routeId?: string): void;
}

export function createRateLimiter(opts: { now?: () => number } = {}): RateLimiter {
  const now = opts.now ?? (() => Date.now());
  const windows: Map<string, number[]> = new Map();

  return {
    allow(routeId: string, perMinute: number): boolean {
      const t = now();
      let w = windows.get(routeId);
      if (!w) { w = []; windows.set(routeId, w); }
      // Prune entries older than the window.
      const cutoff = t - WINDOW_MS;
      while (w.length > 0 && w[0] < cutoff) w.shift();
      if (w.length >= perMinute) return false;
      w.push(t);
      return true;
    },
    stats(routeId: string) {
      const w = windows.get(routeId);
      if (!w || w.length === 0) return { count: 0, oldestMs: null };
      return { count: w.length, oldestMs: w[0] };
    },
    reset(routeId?: string): void {
      if (routeId === undefined) windows.clear();
      else windows.delete(routeId);
    },
  };
}
