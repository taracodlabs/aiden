/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the Ink render tree's PURE helpers: the settled/live transcript split
 * (settled → Static/scrollback, live tail re-rendered) and the per-item line
 * rendering. Plus the AIDEN_INK opt-in flag (default OFF).
 */
import { describe, it, expect } from 'vitest';
import { splitTranscript, itemLine } from '../../../../cli/v4/frame/inkApp';
import { inkEnabled } from '../../../../cli/v4/frame/inkRuntime';
import type { TranscriptItem } from '../../../../cli/v4/frame/frameReducer';

const user  = (t: string): TranscriptItem => ({ kind: 'user', id: 'u', text: t });
const asst  = (t: string): TranscriptItem => ({ kind: 'assistant', id: 'a', text: t });
const tool  = (s: 'running' | 'ok' | 'error'): TranscriptItem => ({ kind: 'tool', id: 't', name: 'web_research', status: s, detail: 'q' });

describe('splitTranscript — settled (scrollback) vs live (tail)', () => {
  it('IDLE → everything is settled (flows to scrollback), nothing live', () => {
    const { settled, live } = splitTranscript([user('hi'), asst('done')], 'idle');
    expect(settled).toHaveLength(2);
    expect(live).toHaveLength(0);
  });

  it('BUSY with a streaming assistant at the tail → that assistant is LIVE', () => {
    const { settled, live } = splitTranscript([user('hi'), asst('typing…')], 'busy');
    expect(settled.map((i) => i.kind)).toEqual(['user']);
    expect(live.map((i) => i.kind)).toEqual(['assistant']);
  });

  it('a RUNNING tool at the tail is live; a completed one settles', () => {
    expect(splitTranscript([asst('x'), tool('running')], 'busy').live.map((i) => i.kind)).toEqual(['tool']);
    expect(splitTranscript([asst('x'), tool('ok')], 'busy').live).toHaveLength(0);   // settled tool → scrollback
  });

  it('settled items are a stable PREFIX (only grows) — Static-safe', () => {
    const t = [user('a'), asst('b'), tool('running')];
    const { settled } = splitTranscript(t, 'busy');
    expect(settled).toEqual([t[0], t[1]]);   // prefix, in order
  });
});

describe('itemLine — per-row rendering', () => {
  it('renders each kind with its glyph', () => {
    expect(itemLine(user('hello'))).toBe('▲ hello');
    expect(itemLine(asst('hi there'))).toBe('┃ hi there');
    expect(itemLine({ kind: 'note', id: 'n', text: 'queued (1)' })).toBe('  queued (1)');
    expect(itemLine(tool('running'))).toBe('  ⋯ web_research — q');
    expect(itemLine(tool('ok'))).toBe('  ✓ web_research — q');
    expect(itemLine(tool('error'))).toBe('  ✗ web_research — q');
  });
});

describe('inkEnabled — opt-in (default OFF)', () => {
  it('reads AIDEN_INK', () => {
    const prev = process.env.AIDEN_INK;
    try {
      delete process.env.AIDEN_INK;
      expect(inkEnabled()).toBe(false);         // safe default: legacy path untouched
      process.env.AIDEN_INK = '1';
      expect(inkEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AIDEN_INK; else process.env.AIDEN_INK = prev;
    }
  });
});
