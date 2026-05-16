/**
 * v4.5 Phase 3 — webhookRateLimit tests.
 */
import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../../../../core/v4/daemon/triggers/webhookRateLimit';

describe('createRateLimiter', () => {
  it('allows up to perMinute requests within window', () => {
    let now = 1_000_000;
    const r = createRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) expect(r.allow('r1', 5)).toBe(true);
    expect(r.allow('r1', 5)).toBe(false);
  });

  it('window slides after 60s — old entries pruned', () => {
    let now = 1_000_000;
    const r = createRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) expect(r.allow('r1', 5)).toBe(true);
    expect(r.allow('r1', 5)).toBe(false);
    // Advance past the 60s window.
    now += 60_001;
    expect(r.allow('r1', 5)).toBe(true);
  });

  it('per-route isolation', () => {
    let now = 1_000_000;
    const r = createRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) expect(r.allow('a', 5)).toBe(true);
    expect(r.allow('a', 5)).toBe(false);
    expect(r.allow('b', 5)).toBe(true);
  });

  it('stats reports count + oldest', () => {
    let now = 1_000_000;
    const r = createRateLimiter({ now: () => now });
    r.allow('r1', 5);
    now += 100;
    r.allow('r1', 5);
    const s = r.stats('r1');
    expect(s.count).toBe(2);
    expect(s.oldestMs).toBe(1_000_000);
  });

  it('reset(routeId) clears one window', () => {
    let now = 1_000_000;
    const r = createRateLimiter({ now: () => now });
    r.allow('r1', 1);
    expect(r.allow('r1', 1)).toBe(false);
    r.reset('r1');
    expect(r.allow('r1', 1)).toBe(true);
  });

  it('reset() with no arg clears all', () => {
    let now = 1_000_000;
    const r = createRateLimiter({ now: () => now });
    r.allow('a', 1); r.allow('b', 1);
    expect(r.allow('a', 1)).toBe(false);
    expect(r.allow('b', 1)).toBe(false);
    r.reset();
    expect(r.allow('a', 1)).toBe(true);
    expect(r.allow('b', 1)).toBe(true);
  });
});
