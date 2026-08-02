import { describe, it, expect } from 'vitest';

import {
  boxTop,
  boxBottom,
  boxLine,
  boxTopTitled,
  visibleLength,
  truncateVisible,
  truncateVisibleAtWord,
} from '../../../cli/v4/box';

const ORANGE = '\x1b[38;2;255;107;53m';
const RESET = '\x1b[39m';

describe('cli/v4/box helpers', () => {
  // Phase v4.1-tier3.1: corners flipped from rounded ╭╮╰╯ to sharp
  // ┌┐└┘ to match Aiden's locked visual identity.
  it('boxTop renders sharp corners and exact width fill', () => {
    const top = boxTop(5);
    expect(top).toBe('┌─────┐');
  });

  it('boxBottom renders sharp corners and exact width fill', () => {
    expect(boxBottom(5)).toBe('└─────┘');
  });

  it('boxLine pads short content with a leading gutter space', () => {
    const line = boxLine('hi', 6);
    // 1 gutter space + "hi" + 3 trailing spaces = 6 inner chars
    expect(line).toBe('│ hi   │');
  });

  it('boxLine truncates content that overflows the cell width', () => {
    const line = boxLine('thiswillnotfit', 6);
    expect(line.length).toBe(8); // 6 inner + 2 verticals
    expect(line.startsWith('│')).toBe(true);
    expect(line.endsWith('│')).toBe(true);
  });

  it('boxTopTitled embeds the title between dashes after the corner', () => {
    const top = boxTopTitled('Setup Complete', 50);
    expect(top.startsWith('┌── Setup Complete ')).toBe(true);
    expect(top.endsWith('┐')).toBe(true);
    // Width budget honoured: total visible width = 50 inner + 2 corners.
    expect(top.length).toBe(52);
  });

  // ── Phase 22 Group C smoke-fix: ANSI-aware width ──────────────────

  it('visibleLength strips ANSI CSI sequences before counting', () => {
    expect(visibleLength(`${ORANGE}✓${RESET}`)).toBe(1);
    expect(visibleLength(`${ORANGE}hello${RESET}`)).toBe(5);
    expect(visibleLength('plain')).toBe(5);
    expect(visibleLength('')).toBe(0);
  });

  it('boxLine right border lands on the box width even with coloured content', () => {
    // Coloured row: visible content is `✓ ok` (4 chars). Pre-fix this
    // measured ~26 bytes and pushed the right vertical inside the
    // visible width; now both should render at exactly width-2 visible.
    const W = 30;
    const coloured = boxLine(`${ORANGE}✓${RESET} ok`, W);
    const plain = boxLine('✓ ok', W);
    expect(visibleLength(coloured)).toBe(W + 2); // verticals + W inner
    expect(visibleLength(plain)).toBe(W + 2);
    // Both must end with `│` — i.e. the closing vertical isn't lost.
    expect(coloured.endsWith('│')).toBe(true);
    expect(plain.endsWith('│')).toBe(true);
  });

  it('boxLine width matches plain and coloured input identically', () => {
    const plain = boxLine('hi', 10);
    const coloured = boxLine(`${ORANGE}hi${RESET}`, 10);
    expect(visibleLength(plain)).toBe(visibleLength(coloured));
  });

  it('truncateVisible preserves ANSI sequences but caps visible chars', () => {
    const out = truncateVisible(`${ORANGE}abcdef${RESET}`, 3);
    expect(visibleLength(out)).toBe(3);
    // Original ORANGE prefix preserved (so colour applies to abc).
    expect(out.startsWith(ORANGE)).toBe(true);
    // Reset appended so caller's next char isn't tinted.
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });

  it('truncateVisible leaves plain-text input unchanged in length', () => {
    const out = truncateVisible('thiswillnotfit', 6);
    // No ANSI in input → no reset appended; length matches the cap.
    expect(out).toBe('thiswi');
  });

  it('measures wide Unicode glyphs by terminal columns', () => {
    expect(visibleLength('A界B')).toBe(4);
    expect(visibleLength(`${ORANGE}A界B${RESET}`)).toBe(4);
  });

  it('never splits a wide Unicode glyph or an ANSI sequence', () => {
    const out = truncateVisible(`${ORANGE}A界B${RESET}`, 3);
    expect(visibleLength(out)).toBe(3);
    expect(out).toContain('A界');
    expect(out).not.toContain('B');
    expect(out.startsWith(ORANGE)).toBe(true);
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });

  it.each([44, 80, 100, 120, 160])(
    'keeps a complete activity phrase at a %i-column boundary',
    (width) => {
      const phrase = `${ORANGE}Still working — checking the result before reporting repository validation details${RESET}`;
      const out = truncateVisibleAtWord(phrase, width);
      expect(visibleLength(out)).toBeLessThanOrEqual(width);
      expect(out).not.toMatch(/\b(?:work|check|resul|repo|validat)…(?:\x1b\[[0-9;]*m)?$/u);
      expect(out.endsWith('…') || /\x1b\[(?:0|39)m$/u.test(out)).toBe(true);
    },
  );

  it('boxTopTitled uses visible length so coloured titles dont skew the dashes', () => {
    const plain = boxTopTitled('Health Check', 50);
    const coloured = boxTopTitled(`${ORANGE}Health Check${RESET}`, 50);
    expect(visibleLength(plain)).toBe(visibleLength(coloured));
  });
});
