/**
 * v4.5 Phase 5a — fire-rate limiter tests.
 *
 * Covers:
 *   1. Unlimited (limit null/0) → always allowed, never records
 *   2. Cap enforced — Nth fire allowed, (N+1)th blocked + reason populated
 *   3. Sliding window: stale fires drop off, new fires allowed again
 *   4. Per-trigger isolation: two trigger ids have independent windows
 */
import { describe, it, expect } from 'vitest';
import { createFireRateLimiter } from '../../../../core/v4/daemon/dispatcher/fireRateLimiter';

describe('createFireRateLimiter', () => {
  it('null/undefined limit → unlimited; nothing recorded', () => {
    const l = createFireRateLimiter({ windowMs: 1_000 });
    for (let i = 0; i < 50; i++) {
      const r = l.check('t1', null);
      expect(r.allowed).toBe(true);
      expect(r.windowCount).toBe(0);    // unlimited path skips recording
    }
  });

  it('cap enforced: Nth fire allowed, (N+1)th blocked', () => {
    const l = createFireRateLimiter({ windowMs: 1_000 });
    const limit = 3;
    expect(l.check('t1', limit).allowed).toBe(true);
    expect(l.check('t1', limit).allowed).toBe(true);
    expect(l.check('t1', limit).allowed).toBe(true);
    const blocked = l.check('t1', limit);
    expect(blocked.allowed).toBe(false);
    expect(blocked.windowCount).toBe(3);
    expect(blocked.reason).toMatch(/fire-rate cap exceeded/);
  });

  it('sliding window: stale fires drop, new fires allowed', () => {
    const l = createFireRateLimiter({ windowMs: 1_000 });
    const limit = 2;
    const t0 = 1_000_000;
    expect(l.check('t1', limit, t0).allowed).toBe(true);
    expect(l.check('t1', limit, t0 + 100).allowed).toBe(true);
    expect(l.check('t1', limit, t0 + 200).allowed).toBe(false);
    // Advance past window. Both prior fires fall off.
    expect(l.check('t1', limit, t0 + 1_500).allowed).toBe(true);
  });

  it('isolates trigger ids — t1 quota does not affect t2', () => {
    const l = createFireRateLimiter({ windowMs: 1_000 });
    const limit = 2;
    expect(l.check('t1', limit).allowed).toBe(true);
    expect(l.check('t1', limit).allowed).toBe(true);
    expect(l.check('t1', limit).allowed).toBe(false);
    // t2 still has full quota.
    expect(l.check('t2', limit).allowed).toBe(true);
    expect(l.check('t2', limit).allowed).toBe(true);
  });

  it('peek() inspects window count without recording', () => {
    const l = createFireRateLimiter({ windowMs: 1_000 });
    expect(l.check('t1', 5).allowed).toBe(true);
    expect(l.peek('t1')).toBe(1);
    expect(l.peek('t1')).toBe(1);   // peek is idempotent
  });

  it('reset(triggerId) clears the window', () => {
    const l = createFireRateLimiter({ windowMs: 1_000 });
    expect(l.check('t1', 2).allowed).toBe(true);
    expect(l.check('t1', 2).allowed).toBe(true);
    expect(l.check('t1', 2).allowed).toBe(false);
    l.reset('t1');
    expect(l.check('t1', 2).allowed).toBe(true);
  });
});
