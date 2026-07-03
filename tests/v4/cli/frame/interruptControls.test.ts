/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 1 — interrupt controls over EXISTING plumbing.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  requestTurnCancel,
  listCancelableSubagents,
  cancelOneSubagent,
  type CancelableCoordinator,
} from '../../../../cli/v4/frame/interruptControls';

describe('requestTurnCancel — turn-scoped abort (REPL survives)', () => {
  it('aborts a live controller once; idempotent afterwards', () => {
    const ctrl = new AbortController();
    expect(requestTurnCancel(ctrl)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    expect(requestTurnCancel(ctrl)).toBe(false);   // already aborted
    expect(requestTurnCancel(null)).toBe(false);   // nothing to cancel
  });
});

/** A fake coordinator over an in-memory active-children set. */
function fakeCoord(children: Array<{ subagentRunId: string; goal: string; startedAt: number }>): {
  coord: CancelableCoordinator; cancelled: string[];
} {
  const live = new Map(children.map((c) => [c.subagentRunId, c]));
  const cancelled: string[] = [];
  const coord: CancelableCoordinator = {
    listActiveChildren: () => [...live.values()],
    cancelChild: (id) => { if (!live.has(id)) return false; live.delete(id); cancelled.push(id); return true; },
  };
  return { coord, cancelled };
}

describe('cancelOneSubagent — cancels one, never cascades', () => {
  it('cancels exactly the picked child; siblings continue', () => {
    const { coord, cancelled } = fakeCoord([
      { subagentRunId: 's1', goal: 'a', startedAt: 10 },
      { subagentRunId: 's2', goal: 'b', startedAt: 20 },
      { subagentRunId: 's3', goal: 'c', startedAt: 30 },
    ]);
    const r = cancelOneSubagent(coord, 1, 's2');
    expect(r.cancelled).toBe(true);
    expect(r.id).toBe('s2');
    expect(r.remaining).toBe(2);                  // s1 + s3 untouched
    expect(cancelled).toEqual(['s2']);            // ONLY s2 was cancelled
    expect(listCancelableSubagents(coord, 1).map((c) => c.subagentRunId).sort()).toEqual(['s1', 's3']);
  });

  it('no id → cancels the OLDEST child', () => {
    const { coord, cancelled } = fakeCoord([
      { subagentRunId: 'young', goal: 'y', startedAt: 99 },
      { subagentRunId: 'old',   goal: 'o', startedAt: 1 },
    ]);
    const r = cancelOneSubagent(coord, 1);
    expect(r.id).toBe('old');
    expect(cancelled).toEqual(['old']);
  });

  it('unknown id / empty registry → no-op', () => {
    const { coord } = fakeCoord([{ subagentRunId: 's1', goal: 'a', startedAt: 1 }]);
    expect(cancelOneSubagent(coord, 1, 'nope').cancelled).toBe(false);
    const empty = fakeCoord([]);
    expect(cancelOneSubagent(empty.coord, 1).cancelled).toBe(false);
  });
});
