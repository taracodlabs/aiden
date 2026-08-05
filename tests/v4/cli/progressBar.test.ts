/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/progressBar.test.ts — Phase v4.1.4 Part 1.6.
 *
 * Coverage for the per-turn token progress bar:
 *   - Renders `▓▓▓░░░░░░░  412/4096 tokens` style line
 *   - Ratio math: 0%, 50%, 100% all snap to expected cell counts
 *   - Dedup: identical updates don't repaint
 *   - hide() erases the line + freezes further updates
 *   - Non-TTY: zero writes
 *   - Honest degradation: no maxTokens → "N tokens" label without denom
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createProgressBar } from '../../../cli/v4/display/progressBar';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeStream(tty: boolean): {
  out: NodeJS.WriteStream;
  chunks: string[];
} {
  const chunks: string[] = [];
  const w = new Writable({
    write(c, _e, cb) { chunks.push(c.toString()); cb(); },
  }) as Writable & { isTTY?: boolean; columns?: number };
  w.isTTY = tty;
  w.columns = 80;
  return { out: w as unknown as NodeJS.WriteStream, chunks };
}

describe('createProgressBar (v4.1.4 Part 1.6)', () => {
  it('TTY: first update paints the bar with both filled and empty cells', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(200, 1000);
    const full = stripAnsi(chunks.join(''));
    // 200/1000 = 20% → 2 filled cells, 8 empty cells
    expect(full).toContain('▓▓░░░░░░░░');
    // formatCompactTokens converts 1000 → "1K" (compact notation).
    expect(full).toContain('200/1K tokens');
  });

  it('TTY: 50% fill renders 5 filled / 5 empty', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(2048, 4096);
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('▓▓▓▓▓░░░░░');
  });

  it('TTY: 100% fill renders all filled, none empty', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(4096, 4096);
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('▓▓▓▓▓▓▓▓▓▓');
    expect(full).not.toContain('░');
  });

  it('TTY: 0 tokens with maxTokens renders all-empty', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(0, 4096);
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('░░░░░░░░░░');
    // 4096 → "4.1K" via formatCompactTokens.
    expect(full).toContain('0/4.1K tokens');
  });

  it('TTY: above-budget (overshoot) clamps to all-filled', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(5000, 4096); // overshoot
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('▓▓▓▓▓▓▓▓▓▓');
    expect(full).not.toContain('░');
  });

  it('TTY: no maxTokens → "N tokens" without denominator', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(412);
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('412 tokens');
    expect(full).not.toContain('/');
    // Without denom, the bar shows all-empty (no fill ratio to compute).
    expect(full).toContain('░░░░░░░░░░');
  });

  it('TTY: dedup — repeating the same count doesn\'t repaint', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(100, 1000);
    const writesAfterFirst = chunks.length;
    bar.update(100, 1000); // same count
    bar.update(100, 1000); // same count
    expect(chunks.length).toBe(writesAfterFirst);
  });

  it('TTY: increasing count repaints', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(100, 1000);
    const after100 = chunks.length;
    bar.update(200, 1000);
    expect(chunks.length).toBeGreaterThan(after100);
  });

  it('routes owned interactive updates without writing cursor controls to the stream', () => {
    const { out, chunks } = makeStream(true);
    const projected: string[] = [];
    let cleared = 0;
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin, {
      update: (line) => { projected.push(line); return true; },
      clear: () => { cleared += 1; return true; },
      settle: () => false,
    });

    bar.update(100, 1_000);
    bar.update(200, 1_000);
    bar.hide();

    expect(projected).toHaveLength(2);
    expect(stripAnsi(projected.at(-1)!)).toContain('200/1K tokens');
    expect(cleared).toBe(1);
    expect(chunks).toEqual([]);
  });

  it('Non-TTY: completely silent — no writes regardless of updates', () => {
    const { out, chunks } = makeStream(false);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(100, 1000);
    bar.update(500, 1000);
    bar.hide();
    expect(chunks.length).toBe(0);
  });

  it('hide() walks up + erases the bar row (v4.1.5 Issue M)', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(100, 1000);
    chunks.length = 0;
    bar.hide();
    // v4.1.5 Part 1a Issue M: bar owns a row, cursor parked below.
    // hide() walks up + erases that row. ANSI: \x1b[1A\x1b[2K.
    expect(chunks.join('')).toContain('\x1b[1A\x1b[2K');
    expect(bar.isHidden()).toBe(true);
    // Further updates ignored.
    chunks.length = 0;
    bar.update(500, 1000);
    expect(chunks.length).toBe(0);
  });

  it('first paint ends with newline (v4.1.5 Issue M flush gate)', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(100, 1000);
    // First paint must end with `\n` so Windows ConPTY flushes the
    // buffered bar to the terminal.
    expect(chunks.join('').endsWith('\n')).toBe(true);
    bar.hide();
  });

  it('subsequent update repaints with walk-up + erase + newline (v4.1.5 Issue M)', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(100, 1000);
    chunks.length = 0;
    bar.update(200, 1000);
    const second = chunks.join('');
    expect(second).toContain('\x1b[1A\x1b[2K');
    expect(second.endsWith('\n')).toBe(true);
    bar.hide();
  });

  it('rejects malformed inputs gracefully (NaN, negative, non-finite)', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    // Set a valid baseline first.
    bar.update(100, 1000);
    chunks.length = 0;
    // None of these should advance the counter.
    bar.update(NaN as unknown as number, 1000);
    bar.update(-50, 1000);
    bar.update(Infinity, 1000);
    // The dedup gate will skip if outputTokens stayed at 100.
    // No new writes expected.
    expect(chunks.length).toBe(0);
    const state = bar.getTokens();
    expect(state.output).toBe(100);
  });

  it('getTokens reports the current state', () => {
    const { out } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(412, 4096);
    expect(bar.getTokens()).toEqual({ output: 412, max: 4096 });
  });

  it('integer-floor: fractional inputs floor to int', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: true });
    const bar = createProgressBar(out, skin);
    bar.update(100.7, 1000.9);
    const state = bar.getTokens();
    expect(state.output).toBe(100);
    expect(state.max).toBe(1000);
    const full = stripAnsi(chunks.join(''));
    // formatCompactTokens: 1000 → "1K".
    expect(full).toContain('100/1K tokens');
  });

  it('uses warm-muted color for the empty cells (Aiden palette)', () => {
    const { out, chunks } = makeStream(true);
    const skin = new SkinEngine({ forceMono: false }); // coloured
    const bar = createProgressBar(out, skin);
    bar.update(200, 1000);
    const raw = chunks.join('');
    // v4.1.4 muted = #b8a89a = rgb 184,168,154
    expect(raw).toContain('\x1b[38;2;184;168;154m');
    // Brand orange for filled cells = #FF6B35 = rgb 255,107,53
    expect(raw).toContain('\x1b[38;2;255;107;53m');
  });
});
