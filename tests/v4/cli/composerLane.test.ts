/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * The single-owner fixed two-row bottom region. Proves
 * the pure escape-sequence builders and the owner's lifecycle: reserving the
 * region protects composer and status rows, painting is cursor-safe + de-duplicated (no
 * flicker), resize re-anchors, teardown restores full-screen scrolling. The
 * live cursor behaviour on a real terminal is the Shiva smoke.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  reserveSeq, paintSeq, teardownSeq, fitLane, ComposerLane, composerLaneEnabled,
  type LaneSink,
} from '../../../cli/v4/composerLane';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (value: string) => number = require('string-width');

const ESC = '\x1b';

describe('escape-sequence builders (pure)', () => {
  it('reserveSeq confines scrolling above the two-row region', () => {
    expect(reserveSeq(24)).toBe(`${ESC}[1;22r${ESC}[22;1H`);
  });
  it('reserveSeq clamps a tiny terminal to a valid region', () => {
    expect(reserveSeq(1)).toBe(`${ESC}[1;1r${ESC}[1;1H`);
  });
  it('paintSeq targets status and composer rows independently', () => {
    expect(paintSeq(24, 'Enter → steer')).toBe(`${ESC}7${ESC}[24;1H${ESC}[2KEnter → steer${ESC}8`);
    expect(paintSeq(24, 'Enter → steer', 1)).toBe(`${ESC}7${ESC}[23;1H${ESC}[2KEnter → steer${ESC}8`);
  });
  it('teardownSeq restores full-screen scrolling and clears both rows', () => {
    expect(teardownSeq(24)).toBe(
      `${ESC}[r${ESC}7${ESC}[23;1H${ESC}[2K${ESC}[24;1H${ESC}[2K${ESC}8`,
    );
  });
  it('fitLane tail-fits with a FRONT ellipsis (keeps the cursor end visible)', () => {
    expect(fitLane('short', 80)).toBe('short');
    const fit = fitLane('abcdefghijklmnopqrstuvwxyz', 10);
    expect(fit.length).toBe(10);
    expect(fit.startsWith('…')).toBe(true);
    expect(fit.endsWith('z')).toBe(true);   // most-recent chars kept
  });
  it('fitLane budgets wide terminal glyphs without wrapping', () => {
    const fit = fitLane('prefix ⌛ preserve-the-end', 12);
    expect(stringWidth(fit)).toBeLessThanOrEqual(12);
    expect(fit).toMatch(/the-end$/);
  });
});

// ── a capturing sink ─────────────────────────────────────────────────────────
function mockSink(rows = 24, cols = 80) {
  const writes: string[] = [];
  let resizeCb: (() => void) | null = null;
  const sink: LaneSink & {
    fireResize: (r: number) => void;
    text: () => string;
    setRows: (r: number) => void;
    setCols: (c: number) => void;
  } = {
    write: (s) => writes.push(s),
    rows: () => rows,
    cols: () => cols,
    onResize: (fn) => { resizeCb = fn; return () => { resizeCb = null; }; },
    setRows: (r) => { rows = r; },
    setCols: (c) => { cols = c; },
    fireResize: (r) => { rows = r; resizeCb?.(); },
    text: () => writes.join(''),
  };
  return sink;
}

describe('ComposerLane — lifecycle', () => {
  it('activate reserves the region and paints composer above status', () => {
    const s = mockSink(24);
    const lane = new ComposerLane(s);
    lane.activate('Enter → steer · /queue · Ctrl+C stop', 'provider · model · ctx · 1s');
    expect(lane.isActive()).toBe(true);
    const out = s.text();
    expect(out).toContain(`${ESC}[1;22r`);
    expect(out).toContain(`${ESC}[23;1H${ESC}[2KEnter → steer`);
    expect(out).toContain(`${ESC}[24;1H${ESC}[2Kprovider`);
    // reserve happens before the first paint
    expect(out.indexOf('[1;22r')).toBeLessThan(out.indexOf('[23;1H'));
  });

  it('keeps the status row inside the physical width budget', () => {
    const s = mockSink(24, 48);
    const lane = new ComposerLane(s);
    lane.activate(
      'Type your message',
      '  custom_openai:custom-default │ ctx0% │ ⌛ 0ms',
    );
    const painted = s.text()
      .split(`${ESC}[24;1H${ESC}[2K`).at(-1)!
      .split(ESC + '8')[0]
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    expect(stringWidth(painted)).toBeLessThanOrEqual(46);
  });

  it('paint with the SAME text is a no-op — no flicker on redundant repaints', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('steer ▸ hi');
    const before = s.text().length;
    lane.paint('steer ▸ hi');   // identical
    expect(s.text().length).toBe(before);   // nothing written
  });

  it('paint with NEW text repaints the lane (typed input updates in place)', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('Enter → steer');
    lane.paint('steer ▸ deploy');
    expect(s.text()).toContain('steer ▸ deploy');
  });

  it('output written between paints never targets the lane row (region protects it)', () => {
    // The owner only ever writes to the bottom row via paintSeq; assert every
    // lane write is cursor-save-wrapped (so the flowing output cursor is intact).
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('Enter → steer');
    lane.paint('steer ▸ x');
    // Every paint is bracketed by save/restore → the output cursor is never lost.
    const paints = s.text().split(`${ESC}7`).slice(1).filter((p) => p.includes(';1H'));
    for (const p of paints) expect(p).toContain(ESC + '8');
  });

  it('resize re-reserves the region for the new height and repaints in place', () => {
    const s = mockSink(24);
    const lane = new ComposerLane(s);
    lane.activate('Enter → steer');
    (s as any).fireResize(30);   // terminal grew to 30 rows
    const out = s.text();
    expect(out).toContain(`${ESC}[1;28r`);
    expect(out).toContain(`${ESC}[29;1H`);
  });

  it('restores the full draft after a narrow-to-wide resize', () => {
    const s = mockSink(24, 16);
    const lane = new ComposerLane(s);
    lane.activate('queue ▸ preserve the complete draft');
    expect(s.text()).not.toContain('queue ▸ preserve');
    s.setCols(80);
    s.fireResize(24);
    expect(s.text()).toContain('queue ▸ preserve the complete draft');
  });

  it('deactivate restores full-screen scrolling + clears the lane (idempotent)', () => {
    const s = mockSink(24);
    const lane = new ComposerLane(s);
    lane.activate('Enter → steer');
    lane.deactivate();
    expect(lane.isActive()).toBe(false);
    expect(s.text()).toContain(`${ESC}[r`);                // region reset
    lane.deactivate();                                     // idempotent, no throw
  });

  it('activate is idempotent — a second activate repaints without re-reserving', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('a');
    const reserves1 = s.text().split('[1;22r').length - 1;
    lane.activate('b');
    const reserves2 = s.text().split('[1;22r').length - 1;
    expect(reserves1).toBe(1);
    expect(reserves2).toBe(1);          // still one reserve
    expect(s.text()).toContain('b');    // repainted
  });
});

describe('composerLaneEnabled — interactive default with compatibility opt-out', () => {
  it('reads AIDEN_COMPOSER_LANE', () => {
    const prev = process.env.AIDEN_COMPOSER_LANE;
    try {
      delete process.env.AIDEN_COMPOSER_LANE;
      expect(composerLaneEnabled()).toBe(true);
      process.env.AIDEN_COMPOSER_LANE = '0';
      expect(composerLaneEnabled()).toBe(false);
      process.env.AIDEN_COMPOSER_LANE = '1';
      expect(composerLaneEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AIDEN_COMPOSER_LANE; else process.env.AIDEN_COMPOSER_LANE = prev;
    }
  });
});
