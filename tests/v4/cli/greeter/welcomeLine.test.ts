/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 UX polish (Bug 1) — buildWelcomeLine pure-function coverage.
 *
 * Three tiers: recall (summary known) → human time-gap (never raw hours) →
 * rotated friendly fallback (no useful history). Pure: identical ctx ⇒
 * identical string; the fallback rotation is a deterministic function of the
 * seed, not randomness.
 */
import { describe, it, expect } from 'vitest';

import {
  buildWelcomeLine, humanGap, WELCOME_FALLBACKS,
} from '../../../../cli/v4/greeter/welcomeLine';

const NOW = new Date(2026, 6, 4, 12, 0, 0);   // local noon, 2026-07-04
const paint = {
  paintMuted:  (s: string) => `<m>${s}</m>`,
  paintAccent: (s: string) => `<a>${s}</a>`,
};
const hoursAgoIso = (h: number): string => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();
const daysAgoIso  = (d: number): string => hoursAgoIso(d * 24);

const base = { now: NOW, ...paint } as const;

// ── Tier 1: recall ─────────────────────────────────────────────────────────
describe('buildWelcomeLine — recall tier', () => {
  it('renders the warm recall line when a summary is known', () => {
    const line = buildWelcomeLine({ ...base, lastSessionAt: hoursAgoIso(50), recallSummary: 'sql migration' });
    expect(line).toBe('Welcome back! Last time: <m>sql migration</m>. Continue, or something new?');
  });

  it('recall wins over the time-gap even when both are available', () => {
    const line = buildWelcomeLine({ ...base, lastSessionAt: daysAgoIso(40), recallSummary: 'ship the parser' });
    expect(line).toContain('ship the parser');
    expect(line).not.toContain('been a while');
  });

  it('clamps a very long summary so the line stays width-safe', () => {
    const long = 'refactor the entire provider fallback chain and the retry budget accounting across every adapter';
    const line = buildWelcomeLine({ ...base, lastSessionAt: null, recallSummary: long });
    expect(line).toContain('…');
    // the clamped summary (inside <m>…</m>) is bounded well under the raw length
    expect(line.length).toBeLessThan(long.length + 60);
  });

  it('a whitespace-only summary is treated as no recall (falls to time-gap)', () => {
    const line = buildWelcomeLine({ ...base, lastSessionAt: hoursAgoIso(30), recallSummary: '   ' });
    expect(line).toContain('Welcome back —');
  });
});

// ── Tier 2: human time-gap (never raw hours) ───────────────────────────────
describe('buildWelcomeLine — time-gap tier (human words only)', () => {
  it('23h ago → "earlier today"', () => {
    expect(humanGap(hoursAgoIso(23), NOW)).toBe('earlier today');
    expect(buildWelcomeLine({ ...base, lastSessionAt: hoursAgoIso(23), recallSummary: null }))
      .toContain('earlier today');
  });

  it('30h ago → "yesterday"', () => {
    expect(humanGap(hoursAgoIso(30), NOW)).toBe('yesterday');
  });

  it('3 days ago → "a few days ago"', () => {
    expect(humanGap(daysAgoIso(3), NOW)).toBe('a few days ago');
  });

  it('10 days ago → "last week"', () => {
    expect(humanGap(daysAgoIso(10), NOW)).toBe('last week');
  });

  it('40 days ago → "been a while"', () => {
    expect(humanGap(daysAgoIso(40), NOW)).toBe('been a while');
    expect(buildWelcomeLine({ ...base, lastSessionAt: daysAgoIso(40), recallSummary: null }))
      .toContain("been a while");
  });

  it('NEVER shows raw hours in any bucket', () => {
    for (const h of [23, 30, 72, 240, 960]) {
      const line = buildWelcomeLine({ ...base, lastSessionAt: hoursAgoIso(h), recallSummary: null });
      expect(line).not.toMatch(/\d+\s*h\b/);
      expect(line).not.toMatch(/\d+\s*hours?/);
    }
  });

  it('unparseable / missing timestamp → no gap (null), not a fake phrase', () => {
    expect(humanGap('not-a-date', NOW)).toBeNull();
    expect(humanGap(null, NOW)).toBeNull();
  });
});

// ── Tier 3: rotated fallback ───────────────────────────────────────────────
describe('buildWelcomeLine — no-history fallback', () => {
  it('rotates a friendly line by seed (deterministic, not random)', () => {
    const l0 = buildWelcomeLine({ ...base, lastSessionAt: null, recallSummary: null, rotateSeed: 0 });
    const l1 = buildWelcomeLine({ ...base, lastSessionAt: null, recallSummary: null, rotateSeed: 1 });
    expect(l0).toBe(WELCOME_FALLBACKS[0]);
    expect(l1).toBe(WELCOME_FALLBACKS[1]);
    expect(l0).not.toBe(l1);
  });

  it('wraps around the fallback list and is stable for a given seed', () => {
    const n = WELCOME_FALLBACKS.length;
    const a = buildWelcomeLine({ ...base, lastSessionAt: null, recallSummary: null, rotateSeed: n + 2 });
    const b = buildWelcomeLine({ ...base, lastSessionAt: null, recallSummary: null, rotateSeed: 2 });
    expect(a).toBe(b);                       // wrap-around
    expect(a).toBe(buildWelcomeLine({ ...base, lastSessionAt: null, recallSummary: null, rotateSeed: n + 2 }));
  });

  it('defaults to the first line when no seed is supplied', () => {
    expect(buildWelcomeLine({ ...base, lastSessionAt: null, recallSummary: null })).toBe(WELCOME_FALLBACKS[0]);
  });
});
