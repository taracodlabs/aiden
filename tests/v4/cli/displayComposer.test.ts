/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * The live during-turn composer uses one owned bottom surface. Verifies:
 * setComposer paints the draft + mode label, tool calls do not swallow the
 * input surface, and clearing removes it without stray writes.
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeDisplay(): { d: Display; chunks: string[] } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  }) as Writable & { isTTY?: boolean; columns?: number };
  out.isTTY = true;
  out.columns = 80;
  const skin = new SkinEngine({ forceMono: true });
  return { d: new Display({ stdout: out as unknown as NodeJS.WriteStream, skin }), chunks };
}

describe('Display composer — live during-turn paint', () => {
  it('setComposer weaves the mode label + typed text into the indicator row', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setComposer('deploy now', 'redirect');
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('▲ You · steer mode');
    expect(painted).toContain('│ deploy now');
    ind.stop();
  });

  it('a keystroke update repaints in place (erase + repaint), not a blind append', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setComposer('a', 'queue');
    // Fixed-region discipline: the draft is inside the boxed content row.
    expect(chunks.join('')).toMatch(/\x1b\[22;1H\x1b\[2K/);
    expect(stripAnsi(chunks.join(''))).toContain('▲ You · queue mode');
    expect(stripAnsi(chunks.join(''))).toContain('│ a');
    ind.stop();
  });

  it('an identical setComposer is a no-op (no redundant repaint)', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    d.setComposer('hi', 'queue');
    chunks.length = 0;
    d.setComposer('hi', 'queue');   // same buffer + mode
    expect(chunks.join('')).toBe('');
    ind.stop();
  });

  it('survives a tool call without moving the composer into the tool row', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    d.setComposer('hold on', 'queue');
    // Tool starts: indicator pauses, tool row takes the bottom.
    ind.pause();
    const row = d.toolRow('web_search', { query: 'q' });
    chunks.length = 0;
    // A keystroke DURING the tool call must repaint the TOOL row (indicator
    // is paused) — this is the whole point of Slice 2c.
    d.setComposer('hold on!', 'queue');
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('▲ You · queue mode');
    expect(painted).toContain('│ hold on!');
    row.ok(120);
    ind.stop();
  });

  it('hands the composer back to the indicator after the tool settles', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    ind.pause();
    const row = d.toolRow('web_search', { query: 'q' });
    row.ok(80);            // tool settles → stopTick restores the indicator repaint
    ind.resume();          // indicator reclaims the bottom
    chunks.length = 0;
    d.setComposer('back', 'redirect');
    expect(stripAnsi(chunks.join(''))).toContain('▲ You · steer mode');
    expect(stripAnsi(chunks.join(''))).toContain('│ back');
    ind.stop();
  });

  it('clearComposer removes the suffix from the live row', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    d.setComposer('typing…', 'queue');
    chunks.length = 0;
    d.clearComposer();
    const painted = stripAnsi(chunks.join(''));
    expect(painted).not.toContain('typing…');
    expect(painted).not.toContain('▲ You');
    ind.stop();
  });

  it('clearComposer when already empty is a no-op (no stray write)', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.clearComposer();
    expect(chunks.join('')).toBe('');
    ind.stop();
  });

  it('after the indicator stops, the independent composer lane still repaints', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    ind.stop();
    chunks.length = 0;
    d.setComposer('next message', 'queue');
    expect(stripAnsi(chunks.join(''))).toContain('▲ You · queue mode');
    expect(stripAnsi(chunks.join(''))).toContain('│ next message');
  });

  it('pasted text shows clean (no paste markers reach the row)', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    // chatSession passes an already-stripped buffer; the row shows it verbatim.
    d.setComposer('npm run build', 'redirect');
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('▲ You · steer mode');
    expect(painted).toContain('│ npm run build');
    expect(painted).not.toContain('[200~');
    expect(painted).not.toContain('[201~');
    ind.stop();
  });
});

// ── v4.14 BUG 2 — the ALWAYS-visible input lane (persistent hint) ────────────
describe('Display composer — persistent busy hint (input lane always visible)', () => {
  it('setBusyHint shows a labeled empty composer before any keystroke', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setBusyHint('Enter → steer · /busy to change · Ctrl+C stop');   // turn start, nothing typed
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('▲ You · steer mode');
    expect(painted).not.toContain('Enter → steer');
    expect(painted).toContain('│ ');
    ind.stop();
  });

  it('typing fills the box; clearing restores a labeled empty composer', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    d.setBusyHint('Enter → queue · /busy to change · Ctrl+C stop');
    d.setComposer('hello', 'queue');
    expect(stripAnsi(chunks.join(''))).toContain('│ hello');
    chunks.length = 0;
    d.setComposer('', 'queue');                                       // user cleared their line
    expect(stripAnsi(chunks.join(''))).toContain('▲ You · queue mode');
    expect(stripAnsi(chunks.join(''))).not.toContain('Enter → queue');
    expect(stripAnsi(chunks.join(''))).not.toContain('hello');
    ind.stop();
  });

  it('the labeled empty composer survives a tool call without helper text', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    d.setBusyHint('Enter → steer · /busy to change · Ctrl+C stop');
    ind.pause();
    const row = d.toolRow('web_research', { query: 'q' });
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('▲ You · steer mode');
    expect(painted).not.toContain('Enter → steer');
    row.ok(120);
    ind.stop();
  });

  it('clearComposer drops the hint too (turn end hands back to the normal prompt)', () => {
    const { d, chunks } = makeDisplay();
    const ind = d.activityIndicator('thinking');
    d.setBusyHint('Enter → steer · /busy to change · Ctrl+C stop');
    chunks.length = 0;
    d.clearComposer();
    expect(stripAnsi(chunks.join(''))).not.toContain('Enter → steer');
    ind.stop();
  });
});

// ── Fixed bottom surface with compatibility opt-out ───────────────────────
describe('Display composer — fixed bottom surface compatibility opt-out', () => {
  it('setBusyHint reserves the scroll region and pins the boxed composer', () => {
    const prev = process.env.AIDEN_COMPOSER_LANE;
    process.env.AIDEN_COMPOSER_LANE = '1';
    try {
      const { d, chunks } = makeDisplay();   // 80 cols; rows falls back to 24
      chunks.length = 0;
      d.setBusyHint('Enter → steer · /queue · Ctrl+C stop');
      const raw = chunks.join('');
      expect(raw).toContain('\x1b[1;20r');                 // boxed composer + status protected
      expect(raw).toContain('\x1b[21;1H');                 // labeled top border
      expect(raw).toContain('\x1b[22;1H');                 // composer content row
      expect(raw).toContain('▲ You · queue mode');
      expect(raw).not.toContain('Enter → steer');
      // turn end tears the region back down.
      d.clearComposer();
      expect(chunks.join('')).toContain('\x1b[r');          // full-screen scrolling restored
    } finally {
      if (prev === undefined) delete process.env.AIDEN_COMPOSER_LANE; else process.env.AIDEN_COMPOSER_LANE = prev;
    }
  });

  it('releases the reserved row for a modal and restores the exact draft afterward', () => {
    const { d, chunks } = makeDisplay();
    d.setBusyHint('Enter → queue · /queue · Ctrl+C stop');
    d.setComposer('draft survives', 'queue');
    chunks.length = 0;

    d.pauseComposerSurface();
    expect(chunks.join('')).toContain('\x1b[r');
    expect(stripAnsi(chunks.join(''))).not.toContain('draft survives');

    chunks.length = 0;
    d.resumeComposerSurface();
    expect(chunks.join('')).toContain('\x1b[1;20r');
    expect(stripAnsi(chunks.join(''))).toContain('draft survives');
    d.clearComposer();
  });
});
