/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the Ink frame's single UI store. Proves "every event → one pure
 * reducer → FrameState": turn lifecycle, streaming deltas accumulate, tool rows
 * start/progress/complete, status, and — the load-bearing invariant — turnId
 * discipline: LATE events from a finished/interrupted turn are IGNORED, never
 * resurrected.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  frameReducer, initialFrameState, _resetFrameIds,
  type FrameState, type FrameEvent,
} from '../../../../cli/v4/frame/frameReducer';

beforeEach(() => _resetFrameIds());
const run = (s: FrameState, evs: FrameEvent[]): FrameState => evs.reduce(frameReducer, s);
const start = initialFrameState();

describe('frameReducer — turn lifecycle', () => {
  it('turn/start goes busy with the turn id; turn/end returns to idle', () => {
    const busy = frameReducer(start, { type: 'turn/start', turnId: 1 });
    expect(busy.phase).toBe('busy');
    expect(busy.turnId).toBe(1);
    const idle = frameReducer(busy, { type: 'turn/end', turnId: 1 });
    expect(idle.phase).toBe('idle');
    expect(idle.turnId).toBeNull();
  });

  it('turn/interrupt closes any still-running tool (never left lingering)', () => {
    const s = run(start, [
      { type: 'turn/start', turnId: 1 },
      { type: 'tool/start', turnId: 1, id: 't1', name: 'web_research' },
      { type: 'turn/interrupt', turnId: 1 },
    ]);
    expect(s.phase).toBe('idle');
    const tool = s.transcript.find((t) => t.kind === 'tool');
    expect(tool).toMatchObject({ status: 'error', detail: 'interrupted' });
  });
});

describe('frameReducer — streaming + tools become transcript items', () => {
  it('stream deltas ACCUMULATE onto one assistant item (canonical raw content)', () => {
    const s = run(start, [
      { type: 'turn/start', turnId: 1 },
      { type: 'stream/delta', turnId: 1, text: 'Hel' },
      { type: 'stream/delta', turnId: 1, text: 'lo w' },
      { type: 'stream/delta', turnId: 1, text: 'orld' },
    ]);
    const asst = s.transcript.filter((t) => t.kind === 'assistant');
    expect(asst).toHaveLength(1);
    expect((asst[0] as { text: string }).text).toBe('Hello world');
  });

  it('tool start → running, progress updates detail, complete sets status', () => {
    const s = run(start, [
      { type: 'turn/start', turnId: 1 },
      { type: 'tool/start', turnId: 1, id: 't1', name: 'web_search', detail: 'q' },
      { type: 'tool/progress', turnId: 1, id: 't1', detail: '3 results' },
      { type: 'tool/complete', turnId: 1, id: 't1', status: 'ok', detail: 'done' },
    ]);
    expect(s.transcript.find((t) => t.kind === 'tool')).toMatchObject({ name: 'web_search', status: 'ok', detail: 'done' });
  });

  it('user message + note land as transcript items in order', () => {
    const s = run(start, [
      { type: 'user/message', text: 'hi' },
      { type: 'turn/start', turnId: 1 },
      { type: 'note', turnId: 1, text: 'queued (1 pending)' },
    ]);
    expect(s.transcript.map((t) => t.kind)).toEqual(['user', 'note']);
  });
});

describe('frameReducer — turnId discipline (LATE events ignored, not resurrected)', () => {
  it('a stream delta from a FINISHED turn is dropped', () => {
    let s = run(start, [
      { type: 'turn/start', turnId: 1 },
      { type: 'stream/delta', turnId: 1, text: 'a' },
      { type: 'turn/end', turnId: 1 },
    ]);
    const before = s;
    // Late delta from turn 1 arrives after it ended → must be ignored.
    s = frameReducer(s, { type: 'stream/delta', turnId: 1, text: 'ZOMBIE' });
    expect(s).toBe(before);                                   // unchanged reference
    expect(JSON.stringify(s.transcript)).not.toContain('ZOMBIE');
  });

  it('a tool event from a PREVIOUS turn is dropped once turn 2 is active', () => {
    let s = run(start, [
      { type: 'turn/start', turnId: 1 },
      { type: 'turn/end', turnId: 1 },
      { type: 'turn/start', turnId: 2 },
    ]);
    s = frameReducer(s, { type: 'tool/start', turnId: 1, id: 'old', name: 'stale' });
    expect(s.transcript.find((t) => t.kind === 'tool')).toBeUndefined();  // turn-1 tool never appears
  });

  it('a turn-scoped event while IDLE (turnId null) is dropped', () => {
    const s = frameReducer(start, { type: 'stream/delta', turnId: 7, text: 'x' });
    expect(s).toBe(start);
  });

  it('a stale turn/end for a non-active turn does not clobber the active one', () => {
    const s = run(start, [
      { type: 'turn/start', turnId: 2 },
      { type: 'turn/end', turnId: 1 },   // stale end for turn 1
    ]);
    expect(s.phase).toBe('busy');        // turn 2 still active
    expect(s.turnId).toBe(2);
  });
});

describe('frameReducer — non-turn events apply in any state (incl. idle)', () => {
  it('composer/set, busyMode/set, pause/set, overlay/set work while idle', () => {
    const s = run(start, [
      { type: 'composer/set', buffer: 'draft', cursor: 5 },
      { type: 'busyMode/set', mode: 'redirect' },
      { type: 'pause/set', paused: true },
      { type: 'overlay/set', overlay: { kind: 'slash', items: ['/help', '/mode'], selected: 0 } },
    ]);
    expect(s.composer).toEqual({ buffer: 'draft', cursor: 5 });
    expect(s.busyMode).toBe('redirect');
    expect(s.paused).toBe(true);
    expect(s.overlay).toMatchObject({ kind: 'slash', selected: 0 });
  });

  it('the composer draft SURVIVES an interrupt (typed text is not lost)', () => {
    const s = run(start, [
      { type: 'turn/start', turnId: 1 },
      { type: 'composer/set', buffer: 'half-typed', cursor: 4 },
      { type: 'turn/interrupt', turnId: 1 },
    ]);
    expect(s.composer.buffer).toBe('half-typed');   // draft preserved across interrupt
    expect(s.phase).toBe('idle');
  });
});
