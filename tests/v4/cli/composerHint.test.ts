/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Fixed-composer contract:
 *   Issue 1 — actionable helper prose never becomes a second composer row.
 *   The bounded surface communicates ownership through its mode label, and
 *   typed drafts wrap upward without truncating the insertion end.
 *   Issue 2 — the legacy Inquirer hint predicate remains available only when
 *   the fixed Display-owned surface is not active.
 */
import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { shouldShowIdleHint } from '../../../cli/v4/aidenPrompt';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
function makeDisplay(columns: number) {
  const chunks: string[] = [];
  const out = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } }) as Writable & { isTTY?: boolean; columns?: number };
  out.isTTY = true; out.columns = columns;
  return { d: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out as unknown as NodeJS.WriteStream }), chunks };
}

describe('busy hint — fixed-surface ownership (Issue 1)', () => {
  const HINT = 'Enter → steer · /busy to change · Ctrl+C stop';

  it('a WIDE terminal uses the mode label without floating helper prose', () => {
    const { d, chunks } = makeDisplay(100);
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setBusyHint(HINT);
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('▲ You · steer mode');
    expect(painted).not.toContain(HINT);
    ind.stop();
  });

  it('a NARROW terminal keeps the bounded mode label and omits helper fragments', () => {
    const { d, chunks } = makeDisplay(40);
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setBusyHint(HINT);
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('▲ You · steer mode');
    expect(painted).not.toContain('Enter →');
    expect(painted).not.toContain('Ctrl+C stop');
    ind.stop();
  });

  it('long typed text wraps upward without a truncation ellipsis', () => {
    const { d, chunks } = makeDisplay(50);
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setComposer('a very long message the user is typing right now', 'redirect');
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('a very long message');
    expect(painted).toContain('right');
    expect(painted).toContain('now');
    expect(painted).not.toContain('…');
    ind.stop();
  });
});

// ── Bug 1 (Phase 5 sibling-fix) — hint stays in ONE lane during a burst ──────
//
// The busy hint is composed into a tool row's live repaint (composerSuffix).
// A fast multi-tool burst can leave an earlier tool's 1s ticker alive after a
// newer row took the bottom. Without a single-owner guard that stale ticker
// would eraseLast() the WRONG line and repaint its own row — hint included —
// bleeding the composer lane into tool-activity rows. The fix gates the ticker
// on `composerRepaintIs(repaintRunning)`, so only the current bottom owner
// ever repaints. This mirrors the indicator's existing release-guard.
describe('busy hint — single-owner ticker (Bug 1: burst bleed)', () => {
  const HINT = 'Enter → steer · /busy to change · Ctrl+C stop';

  it('a stale (non-owner) tool ticker does not repaint the hint into activity rows', () => {
    const previous = process.env.AIDEN_COMPOSER_LANE;
    process.env.AIDEN_COMPOSER_LANE = '0';
    vi.useFakeTimers();
    try {
      const { d, chunks } = makeDisplay(100);
      d.setBusyHint(HINT);
      const a = d.toolRow('file_read', { path: 'alpha' });   // A claims the bottom
      const b = d.toolRow('file_read', { path: 'bravo' });   // B takes over; A now stale
      chunks.length = 0;
      vi.advanceTimersByTime(1000);                          // fire BOTH 1s tickers
      const painted = stripAnsi(chunks.join(''));
      // Exactly one repaint carries the hint — the current owner (B). The stale
      // ticker (A) must no-op (2 = the pre-fix bleed; 0 = owner wrongly gated).
      const hintCount = painted.split('Enter →').length - 1;
      expect(hintCount).toBe(1);
      a.ok(1); b.ok(1);
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.AIDEN_COMPOSER_LANE;
      else process.env.AIDEN_COMPOSER_LANE = previous;
    }
  });
});

describe('shouldShowIdleHint — persistent idle hint (Issue 2)', () => {
  const HINT = 'Type your message · /help · /mode';
  it('shows when idle, a hint is set, and no ghost/dropdown owns the footer', () => {
    expect(shouldShowIdleHint(false, HINT, 'idle')).toBe(true);
  });
  it('hidden when a ghost/dropdown already owns the footer', () => {
    expect(shouldShowIdleHint(true, HINT, 'idle')).toBe(false);
  });
  it('hidden when not idle (submitting/done)', () => {
    expect(shouldShowIdleHint(false, HINT, 'done')).toBe(false);
  });
  it('hidden when no hint is configured', () => {
    expect(shouldShowIdleHint(false, undefined, 'idle')).toBe(false);
    expect(shouldShowIdleHint(false, '', 'idle')).toBe(false);
  });
});
