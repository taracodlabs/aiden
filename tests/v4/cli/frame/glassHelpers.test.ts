/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 1 — footer hints, N-behind segment, cost throttle.
 */
import { describe, it, expect } from 'vitest';
import { renderFooter, formatNBehind, CostTicker } from '../../../../cli/v4/frame/glassHelpers';

describe('renderFooter', () => {
  it('empty when not busy', () => {
    expect(renderFooter({ busy: false, activeSubagents: 0 })).toBe('');
  });
  it('shows esc=cancel while busy', () => {
    expect(renderFooter({ busy: true, activeSubagents: 0 })).toContain('esc = cancel turn');
  });
  it('adds a cancel-subagent hint when children are in flight', () => {
    const f = renderFooter({ busy: true, activeSubagents: 3 });
    expect(f).toContain('esc = cancel turn');
    expect(f).toContain('ctrl+k = cancel 1 of 3 subagents');
  });
});

describe('formatNBehind', () => {
  it('silent (null) when up to date / unknown / failed', () => {
    expect(formatNBehind(null)).toBeNull();
    expect(formatNBehind(undefined)).toBeNull();
    expect(formatNBehind({ installed: '4.12.0', updateAvailable: false })).toBeNull();
    expect(formatNBehind({ installed: '4.12.0', updateAvailable: true, latest: null })).toBeNull();
  });
  it('shows the newer version when behind', () => {
    expect(formatNBehind({ installed: '4.12.0', latest: '4.13.0', updateAvailable: true })).toBe('4.13.0 ↑');
  });
});

describe('CostTicker — ≤1/sec, never per token', () => {
  it('first call passes; subsequent within the interval are throttled', () => {
    const t = new CostTicker(1000);
    expect(t.shouldEmit(0)).toBe(true);       // first always emits
    expect(t.shouldEmit(200)).toBe(false);    // 200ms later — throttled
    expect(t.shouldEmit(900)).toBe(false);
    expect(t.shouldEmit(1000)).toBe(true);    // 1s since last emit → passes
    expect(t.shouldEmit(1400)).toBe(false);
  });
  it('reset() forces the next emit (e.g. a final reading at turn end)', () => {
    const t = new CostTicker(1000);
    expect(t.shouldEmit(0)).toBe(true);
    expect(t.shouldEmit(100)).toBe(false);
    t.reset();
    expect(t.shouldEmit(120)).toBe(true);
  });
});
