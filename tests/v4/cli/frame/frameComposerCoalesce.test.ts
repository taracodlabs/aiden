/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the ONE composer's state→view mapping (idle vs busy submit policy +
 * plain-language hint) and the render coalescer (batch deltas, never drop
 * content). Both pure + deterministic.
 */
import { describe, it, expect } from 'vitest';
import { composerView } from '../../../../cli/v4/frame/composerModel';
import { makeCoalescer } from '../../../../cli/v4/frame/coalescer';

describe('composerView — ONE composer, two policies', () => {
  it('IDLE → send, calm plain-language hint', () => {
    const v = composerView({ phase: 'idle', busyMode: 'queue', paused: false });
    expect(v.submit).toBe('send');
    expect(v.hint).toBe('Type your message · /help · /mode to change');
  });

  it('BUSY reflects the active mode as Enter action, plain-language (never cryptic)', () => {
    expect(composerView({ phase: 'busy', busyMode: 'redirect', paused: false }))
      .toEqual({ submit: 'steer', hint: 'Enter → steer · Ctrl+Enter queue · Ctrl+C stop' });
    expect(composerView({ phase: 'busy', busyMode: 'queue', paused: false }))
      .toEqual({ submit: 'queue', hint: 'Enter → queue · Ctrl+Enter queue · Ctrl+C stop' });
    expect(composerView({ phase: 'busy', busyMode: 'interrupt', paused: false }))
      .toEqual({ submit: 'stop', hint: 'Enter → stop · Ctrl+Enter queue · Ctrl+C stop' });
  });

  it('PAUSED (busy) → resume-first hint, Enter still does the mode action', () => {
    const v = composerView({ phase: 'busy', busyMode: 'redirect', paused: true });
    expect(v.submit).toBe('steer');
    expect(v.hint).toBe('Paused · /resume to continue · Ctrl+C stop');
  });

  it('no cryptic tokens anywhere (no "msg=", no "mode:")', () => {
    for (const mode of ['queue', 'interrupt', 'redirect'] as const) {
      for (const phase of ['idle', 'busy'] as const) {
        const { hint } = composerView({ phase, busyMode: mode, paused: false });
        expect(hint).not.toMatch(/msg=|mode:|=interrupt/);
      }
    }
  });
});

describe('makeCoalescer — batch frames, never drop content', () => {
  it('accumulates deltas and flushes the WHOLE buffer (no content lost)', () => {
    const c = makeCoalescer(24);
    c.push('Hel'); c.push('lo');
    expect(c.pending()).toBe(true);
    expect(c.flush(100)).toBe('Hello');
    expect(c.pending()).toBe(false);
  });

  it('shouldFlush respects the interval (coalesces bursts into ~1 frame)', () => {
    const c = makeCoalescer(24);
    c.push('a');
    expect(c.shouldFlush(0)).toBe(true);      // first content, lastFlush=-Inf → paint
    c.flush(0);
    c.push('b');
    expect(c.shouldFlush(10)).toBe(false);    // only 10ms since last paint → hold
    expect(c.shouldFlush(24)).toBe(true);     // 24ms passed → paint
  });

  it('shouldFlush is false with an empty buffer (no empty frames)', () => {
    const c = makeCoalescer(24);
    expect(c.shouldFlush(1000)).toBe(false);
  });

  it('the accumulated content across a fast burst is byte-complete on flush', () => {
    const c = makeCoalescer(24);
    const parts = ['The ', 'quick ', 'brown ', 'fox'];
    for (const p of parts) c.push(p);
    expect(c.flush(50)).toBe('The quick brown fox');   // nothing dropped, only batched
  });
});
