/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/replyRenderer.test.ts — Phase v4.1.4 reply-quality polish.
 *
 * Coverage for Fix C: `renderer.list` over-flattens via
 * `parser.parse(it.tokens)`. Marked v15 wraps each tight-list item's
 * inline content in an OUTER `text`-type token whose `.tokens` array
 * holds the actual inline tokens (strong, em, codespan…). The block
 * parser dispatched the wrapper to `renderer.text` which returned
 * the RAW `**bold**` source string — never recursing into the inline
 * children. Result: literal asterisks in every bullet that contained
 * inline emphasis.
 *
 * Fix dispatches by token type:
 *   - `text` with nested .tokens  → parseInline(tokens)
 *   - `paragraph`                  → parseInline(tokens) + '\n'
 *   - `list` / `code` / other      → parser.parse([token])
 *   - `text` without nested tokens → fall through to raw text
 */
import { describe, it, expect } from 'vitest';
import { getReplyRenderer, _resetForTests, normalizeBlankLines } from '../../../cli/v4/replyRenderer';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// ANSI sentinels we expect when paintEmphasis fires.
// v4.5 TUI polish: dropped underline from bold (was making list items
// look like clickable links). Bold-on/off are the only sentinels now.
const BOLD_ON  = '\x1b[1m';
const BOLD_OFF = '\x1b[22m';
// Underline sentinel retained ONLY for negative assertions — paintEmphasis
// must never emit it again.
const UNDERLINE_ON = '\x1b[4m';

describe('replyRenderer — Fix C (list-item inline expansion)', () => {
  // Renderer is module-cached; reset between describe blocks so any
  // skin-engine state changes elsewhere don't leak in.
  _resetForTests();

  it('numbered list with **bold**: every bullet renders ANSI bold (no underline)', () => {
    const r = getReplyRenderer();
    const out = r.render('1. **First**\n2. **Second**\n3. **Third**');
    // Bold-on present at least once per bullet (= 3 times).
    const onCount = out.split(BOLD_ON).length - 1;
    expect(onCount).toBeGreaterThanOrEqual(3);
    expect(out).toContain(BOLD_OFF);
    // v4.5 TUI polish — underline must NOT appear (was the cause of
    // "bullets look like links" user feedback).
    expect(out).not.toContain(UNDERLINE_ON);
    // Critically: NO literal `**` survives in the rendered bytes.
    expect(out).not.toContain('**');
  });

  it('bullet list with **bold**: same fix applies to unordered lists', () => {
    const r = getReplyRenderer();
    const out = r.render('- **alpha**\n- **bravo**');
    expect(out).toContain(BOLD_ON);
    expect(out).not.toContain('**');
  });

  it('mixed inline emphasis in a list item: bold AND italic AND codespan', () => {
    const r = getReplyRenderer();
    const out = r.render('1. **bold** and *italic* and `code-span` together');
    // Bold-on must fire.
    expect(out).toContain(BOLD_ON);
    // No literal `**` or backticks survive (codespan strips backticks).
    expect(out).not.toContain('**');
    expect(stripAnsi(out)).not.toContain('`code-span`');
    expect(stripAnsi(out)).toContain('code-span'); // content survived stripped
  });

  it('plain list items (no emphasis) still render correctly', () => {
    const r = getReplyRenderer();
    const out = r.render('1. plain text\n2. another plain');
    const stripped = stripAnsi(out);
    expect(stripped).toContain('plain text');
    expect(stripped).toContain('another plain');
  });

  it('nested list with bold in both levels: depth counter + inline expand both work', () => {
    const r = getReplyRenderer();
    const out = r.render(
      '- **outer bold**\n' +
      '  - **inner bold**\n' +
      '  - inner plain',
    );
    // Both outer and inner bold render — TWO bold-on sequences.
    const onCount = out.split(BOLD_ON).length - 1;
    expect(onCount).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain('**');
    // v4.8.0 Slice 8 — bullets are now token-sourced: filled ● for
    // top-level, hollow ○ for nested. Both painted in brand orange.
    const stripped = stripAnsi(out);
    expect(stripped).toContain('●');
    expect(stripped).toContain('○');
  });

  it('paragraph (no list): inline bold still works (regression sentinel)', () => {
    // Plain prose worked before Fix C — assert we didn't regress it.
    const r = getReplyRenderer();
    const out = r.render('a paragraph with **bold inline** text');
    expect(out).toContain(BOLD_ON);
    expect(out).not.toContain('**');
  });

  it('loose list (blank line between items): paragraph dispatch still expands bold', () => {
    // Loose lists wrap item content in `paragraph` tokens, not `text`.
    // The token-type dispatch must handle both paths.
    const r = getReplyRenderer();
    const out = r.render(
      '- **first paragraph in item 1**\n' +
      '\n' +
      '- **first paragraph in item 2**',
    );
    expect(out).toContain(BOLD_ON);
    expect(out).not.toContain('**');
  });
});

// ── v4.1.4 Part 1.6 Issue I — collapse excess vertical spacing ─────────────
//
// `opts.paragraph` + `renderCodeBlock` + marked-terminal's between-block
// dispatch each emit their own `\n\n`, producing 4 newlines (3 blank
// lines) between paragraphs. `normalizeBlankLines` collapses runs of
// 3+ newlines down to exactly 2 (one blank line). Pure helper; tested
// directly here AND end-to-end via `getReplyRenderer().render()` below.

describe('normalizeBlankLines (v4.1.4 Issue I)', () => {
  it('collapses 4 newlines (1+3 blanks) to 2 (1+1 blank)', () => {
    expect(normalizeBlankLines('A\n\n\n\nB')).toBe('A\n\nB');
  });

  it('collapses 5+ newlines to 2', () => {
    expect(normalizeBlankLines('A\n\n\n\n\nB')).toBe('A\n\nB');
    expect(normalizeBlankLines('A\n\n\n\n\n\n\nB')).toBe('A\n\nB');
  });

  it('preserves single blank line (2 newlines) unchanged', () => {
    expect(normalizeBlankLines('A\n\nB')).toBe('A\n\nB');
  });

  it('preserves single newline (no blank line) unchanged', () => {
    expect(normalizeBlankLines('A\nB')).toBe('A\nB');
  });

  it('preserves trailing single newline', () => {
    expect(normalizeBlankLines('A\n')).toBe('A\n');
  });

  it('collapses trailing run of 3+ newlines', () => {
    expect(normalizeBlankLines('A\n\n\n\n')).toBe('A\n\n');
  });

  it('handles multiple separate runs independently', () => {
    expect(normalizeBlankLines('A\n\n\n\nB\n\nC\n\n\n\nD')).toBe('A\n\nB\n\nC\n\nD');
  });

  it('empty input → empty output', () => {
    expect(normalizeBlankLines('')).toBe('');
  });
});

describe('getReplyRenderer().render() — Issue I end-to-end (v4.1.4)', () => {
  it('two-paragraph source renders with single blank line (not triple)', () => {
    const r = getReplyRenderer();
    const out = r.render('First paragraph.\n\nSecond paragraph.');
    // No run of 3+ newlines should remain.
    expect(out).not.toMatch(/\n{3,}/);
    // The single-blank-line gap (`\n\n`) between paragraphs is preserved.
    expect(out).toContain('First paragraph.\n\nSecond paragraph.');
  });

  it('three-paragraph source: single blank between each', () => {
    const r = getReplyRenderer();
    const out = r.render('First.\n\nSecond.\n\nThird.');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('paragraph then code block: single blank line between them', () => {
    const r = getReplyRenderer();
    const out = r.render('Para before.\n\n```js\nconst x = 1;\n```\n\nPara after.');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('paragraph then heading: heading spacing unchanged (already correct)', () => {
    const r = getReplyRenderer();
    const out = r.render('## Section\n\nProse below.');
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe('replyRenderer v4.8.0 Slice 8 — list polish', () => {
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  }

  it('top-level bullets render as ● (filled circle)', () => {
    const r = getReplyRenderer();
    const out = stripAnsi(r.render('- alpha\n- bravo\n- charlie'));
    // 3 top-level items → 3 filled circles.
    const filled = (out.match(/●/g) ?? []).length;
    expect(filled).toBe(3);
    expect(out).toContain('alpha');
    expect(out).toContain('charlie');
  });

  it('nested bullets render as ○ (hollow circle) at depth 2', () => {
    const r = getReplyRenderer();
    const out = stripAnsi(r.render('- parent\n  - child1\n  - child2'));
    // 1 parent (●) + 2 children (○).
    expect((out.match(/●/g) ?? []).length).toBe(1);
    expect((out.match(/○/g) ?? []).length).toBe(2);
  });

  it('task list checked → ✔ marker; unchecked → ○ marker', () => {
    const r = getReplyRenderer();
    const out = stripAnsi(r.render('- [x] done one\n- [x] done two\n- [ ] pending'));
    // 2 checks for done items; 1 hollow circle for pending.
    expect((out.match(/✔/g) ?? []).length).toBe(2);
    expect((out.match(/○/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(out).toContain('done one');
    expect(out).toContain('pending');
    // Raw `[x]` / `[ ]` syntax should NOT leak through to visible output.
    expect(out).not.toContain('[x]');
    expect(out).not.toContain('[ ]');
  });

  it('numbered list right-pads numbers in a 3-char column for alignment', () => {
    const r = getReplyRenderer();
    const out = stripAnsi(r.render(
      Array.from({ length: 11 }, (_, i) => `${i + 1}. item ${i + 1}`).join('\n'),
    ));
    // 1./10./11. all present; padStart(3) means ' 1.' / '10.' / '11.'.
    expect(out).toMatch(/ 1\. item 1/);
    expect(out).toMatch(/10\. item 10/);
    expect(out).toMatch(/11\. item 11/);
  });

  it('bullet glyph paints in brand orange (#FF6B35)', () => {
    const r = getReplyRenderer();
    const out = r.render('- alpha');
    // brand orange = #FF6B35 → rgb 255, 107, 53.
    expect(out).toContain('\x1b[38;2;255;107;53m');
  });
});

describe('replyRenderer v4.8.0 Slice 9 — code block chrome', () => {
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  }

  // Slice 9 hotfix: chrome flipped from `▎` left-rail (every line) to
  // `── lang ──` top-divider only. Body content indents below the
  // divider with no per-line rail so the dark-bg syntax highlight
  // owns the visual weight.
  it('code block uses top-divider chrome (NOT every-line rail)', () => {
    const r = getReplyRenderer();
    const out = stripAnsi(r.render('```python\nprint("hi")\n```'));
    // First non-empty line is the divider with language label.
    const lines = out.split('\n').filter(l => l.trim().length > 0);
    expect(lines[0]).toMatch(/^  ── python ─+$/);
    // No per-line `▎` rail anymore.
    expect(out).not.toMatch(/^  ▎/m);
    // No per-line `│` rail either.
    expect(out).not.toMatch(/^  │/m);
  });

  it('header divider includes the language label between two `─` segments', () => {
    const r = getReplyRenderer();
    const out = stripAnsi(r.render('```typescript\nconst x = 1;\n```'));
    expect(out).toMatch(/^  ── typescript ─+$/m);
  });

  it('code block has NO closing bottom border (asymmetric chrome)', () => {
    const r = getReplyRenderer();
    const out = stripAnsi(r.render('```\nfoo\n```'));
    // No trailing horizontal-rule line.
    const trimmedLines = out.trim().split('\n');
    const lastLine = trimmedLines[trimmedLines.length - 1];
    expect(lastLine).not.toMatch(/^  ─+$/);
  });

  it('CODE_BG envelope still wraps body content (this-is-code affordance preserved)', () => {
    const r = getReplyRenderer();
    const out = r.render('```\nfoo\n```');
    // Slice 9 keeps the 24-bit dark background for body lines.
    // CODE_BG_ON = \x1b[48;2;50;50;60m, CODE_BG_OFF = \x1b[49m.
    expect(out).toContain('\x1b[48;2;50;50;60m');
    expect(out).toContain('\x1b[49m');
  });

  it('language label paints brand orange (#FF6B35)', () => {
    const r = getReplyRenderer();
    const out = r.render('```python\nfoo\n```');
    // Slice 9 hotfix — language label still painted brand orange
    // inside the muted top-divider segments.
    expect(out).toContain('\x1b[38;2;255;107;53m');
  });

  it('code with no language label renders full-width divider', () => {
    const r = getReplyRenderer();
    const out = stripAnsi(r.render('```\nplain\n```'));
    // Header row is just the divider (no label between segments).
    const lines = out.split('\n').filter(l => l.trim().length > 0);
    expect(lines[0]).toMatch(/^  ─+$/);
    expect(out).toContain('plain');
  });
});
