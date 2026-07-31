/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * The single-owner variable-height borderless bottom region. Proves
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
    expect(out).toContain(`${ESC}[1;18r`);
    expect(out).toContain(`${ESC}[19;1H${ESC}[2K${'─'.repeat(79)}`);
    expect(out).toContain(`${ESC}[20;1H${ESC}[2K▲ You`);
    expect(out).toContain(`${ESC}[21;1H${ESC}[2K${'─'.repeat(21)}`);
    expect(out).toContain(`${ESC}[22;1H${ESC}[2KEnter → steer`);
    expect(out).toContain(`${ESC}[23;1H${ESC}[2K${'─'.repeat(79)}`);
    expect(out).toContain(`${ESC}[24;1H${ESC}[2Kprovider`);
    // reserve happens before the first paint
    expect(out.indexOf('[1;18r')).toBeLessThan(out.indexOf('[19;1H'));
  });

  it('keeps the status row inside the physical width budget', () => {
    const s = mockSink(24, 48);
    const lane = new ComposerLane(s);
    lane.activate(
      'Type your message',
      '◆ custom_openai:custom-default │ ◉ 0% │ ⧖ 0ms',
    );
    const painted = s.text()
      .split(`${ESC}[24;1H${ESC}[2K`).at(-1)!
      .split(`${ESC}[22;`)[0]
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    expect(stringWidth(painted)).toBeLessThanOrEqual(47);
  });

  it('paint with the same text reasserts the cursor without duplicating the frame', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('steer ▸ hi');
    const before = s.text().split(`${ESC}[2K▲ You`).length - 1;
    lane.paint('steer ▸ hi');
    expect(s.text().split(`${ESC}[2K▲ You`).length - 1).toBe(before);
  });

  it('paint with NEW text repaints the lane (typed input updates in place)', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('Enter → steer');
    lane.paint('steer ▸ deploy');
    expect(s.text()).toContain('steer ▸ deploy');
  });

  it('routes transcript output through the saved scroll cursor and restores draft insertion', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('Enter → steer');
    lane.writeAbove('tool output\n');
    const out = s.text();
    expect(out).toContain(`${ESC}[utool output\n${ESC}[s`);
    expect(out).toMatch(/\x1b\[22;\d+H\x1b\[\?25h$/);
  });

  it('restores the volatile surface after a modal without replaying durable transcript', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('Type your message');
    lane.writeAbove('  ▲ You  run a slow safe tool\n');
    lane.deactivate();
    lane.writeAbove('Approval required\nDecision: Once\n');

    const beforeResume = s.text().length;
    lane.activate('Enter → queue', 'provider · model');
    const resumedOutput = s.text().slice(beforeResume);

    expect(resumedOutput).not.toContain('run a slow safe tool');
    expect(resumedOutput).not.toContain('Approval required');
    expect(s.text().match(/run a slow safe tool/gu)).toHaveLength(1);
    expect(s.text().match(/Approval required/gu)).toHaveLength(1);
  });

  it('does not replay transcript bytes for a status-only refresh', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('Type your message', 'provider · 0ms');
    lane.writeAbove('one durable transcript row\n');
    const beforeStatus = s.text().length;

    lane.paintStatus('provider · 1s');

    expect(s.text().slice(beforeStatus)).not.toContain('one durable transcript row');
  });

  it('clears only the viewport projection and never replays it after resize', async () => {
    const s = mockSink(24, 80);
    const lane = new ComposerLane(s);
    lane.activate('draft remains', 'provider · model');
    lane.writeAbove('old conversation row\n');
    lane.clearTranscript();
    const afterClear = s.text().length;
    s.setCols(44);
    s.fireResize(24);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const resized = s.text().slice(afterClear);
    expect(resized).not.toContain('old conversation row');
    expect(resized).toContain('draft remains');
    expect(resized).toContain('provider');
  });

  it('physically resets the viewport once and preserves transcript behind an epoch boundary', () => {
    const s = mockSink(24, 80);
    const lane = new ComposerLane(s);
    lane.activate({ draft: '', mode: 'idle' }, 'provider · model · ready');
    lane.writeAbove('startup row\nprior user row\nprior assistant row\n');
    lane.scrollTranscript(12);
    const before = s.text().length;

    lane.clearTranscript();

    const clearOutput = s.text().slice(before);
    expect(clearOutput).toContain(`${ESC}[3J${ESC}[2J${ESC}[H`);
    expect(clearOutput).not.toContain('startup row');
    expect(clearOutput).not.toContain('prior assistant row');
    expect(clearOutput.match(/\x1b\[2K▲ You/gu)).toHaveLength(1);
    expect(clearOutput.match(/provider/gu)).toHaveLength(1);
    expect(lane.viewportSnapshot()).toMatchObject({
      epoch: 1,
      scrollOffset: 0,
      stickyTail: true,
      selectedRow: null,
      cachedWidth: 80,
      cachedHeight: 24,
      retainedTranscriptRows: 3,
      visibleTranscriptRows: 0,
    });
  });

  it('discards a trailing resize repaint captured before the viewport epoch changed', async () => {
    const s = mockSink(24, 80);
    const lane = new ComposerLane(s);
    lane.activate({ draft: '', mode: 'idle' }, 'provider · model · ready');
    lane.writeAbove('must stay hidden\n');
    s.setCols(44);
    s.fireResize(24);
    lane.clearTranscript();
    const afterClear = s.text().length;

    await new Promise<void>((resolve) => setImmediate(resolve));

    const lateOutput = s.text().slice(afterClear);
    expect(lateOutput).not.toContain('must stay hidden');
    expect(lane.viewportSnapshot()).toMatchObject({ epoch: 1, cachedWidth: 44, cachedHeight: 24 });
  });

  it('resize re-reserves the region for the new height and repaints in place', async () => {
    const s = mockSink(24);
    const lane = new ComposerLane(s);
    lane.activate('Enter → steer');
    (s as any).fireResize(30);   // terminal grew to 30 rows
    await new Promise<void>((resolve) => setImmediate(resolve));
    const out = s.text();
    expect(out).toContain(`${ESC}[1;24r`);
    expect(out).toContain(`${ESC}[25;1H`);
  });

  it('restores the full draft after a narrow-to-wide resize', async () => {
    const s = mockSink(24, 16);
    const lane = new ComposerLane(s);
    lane.activate('queue ▸ preserve the complete draft');
    expect(s.text()).not.toContain('queue ▸ preserve');
    s.setCols(80);
    s.fireResize(24);
    await new Promise<void>((resolve) => setImmediate(resolve));
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

  it('keeps transcript ownership in the main buffer across modal pause and teardown', () => {
    const s = mockSink(24);
    const lane = new ComposerLane(s);
    lane.activate('Type your message', 'provider · model');
    expect(s.text()).not.toContain(`${ESC}[?1049h`);

    lane.deactivate();
    expect(s.text()).not.toContain(`${ESC}[?1049l`);
    lane.activate('Type your message', 'provider · model');
    expect(s.text()).not.toContain(`${ESC}[?1049h`);

    lane.deactivate();
    expect(s.text()).not.toContain(`${ESC}[?1049l`);
  });

  it('flushes transcript accepted during a resize before a modal takes ownership', () => {
    const s = mockSink(24, 100);
    const lane = new ComposerLane(s);
    lane.activate('Type your message', 'provider · model');
    s.setCols(44);
    s.fireResize(24);
    lane.writeAbove('Approval boundary remains durable\n');

    lane.deactivate();

    expect(s.text().match(/Approval boundary remains durable/gu)).toHaveLength(1);
  });

  it('activate is idempotent — a second activate repaints without re-reserving', () => {
    const s = mockSink();
    const lane = new ComposerLane(s);
    lane.activate('a');
    const reserves1 = s.text().split('[1;18r').length - 1;
    lane.activate('b');
    const reserves2 = s.text().split('[1;18r').length - 1;
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
