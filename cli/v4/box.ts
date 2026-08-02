/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/box.ts — sharp + double-line box drawing helpers.
 *
 * Tier-3.1 (v4.1-tier3.1) replaced the rounded set (╭╮╰╯) with
 * sharp corners (┌┐└┘) for the default box and added a second
 * double-line variant (╔╗╚╝═║) for emphasis surfaces (e.g. the
 * approval/escalation banner). The default `box*` exports continue
 * to point at the sharp variant so existing callers compile
 * unchanged; `boxSharp*` and `boxDouble*` are explicit aliases for
 * call sites that want to declare intent.
 *
 * Width counts the inner cell only (between the verticals). Content
 * is padded to width-1 so a single leading space gives the box a
 * visual gutter.
 *
 * ANSI awareness: per-row coloured content (orange ✓ icons, soft-
 * cyan labels) inflates `String.length` from ~50 visible chars to
 * ~120 bytes per row, so byte-based padding under-fills and the
 * closing vertical drifts inside the visible borders. The helpers
 * below measure / truncate against the visible (post-strip)
 * length, so coloured content frames identically to plain content.
 */

// ── Sharp (default) ──────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (value: string) => number = require('string-width');

const SHARP = {
  TL: '┌',
  TR: '┐',
  BL: '└',
  BR: '┘',
  H:  '─',
  V:  '│',
} as const;

// ── Double-line (emphasis) ───────────────────────────────────────
const DOUBLE = {
  TL: '╔',
  TR: '╗',
  BL: '╚',
  BR: '╝',
  H:  '═',
  V:  '║',
} as const;

interface GlyphSet {
  TL: string;
  TR: string;
  BL: string;
  BR: string;
  H:  string;
  V:  string;
}

/**
 * Strip ANSI CSI escape sequences and return physical terminal columns.
 * Wide glyphs, combining characters, and emoji sequences are measured by
 * `string-width`; ANSI colour bytes remain zero-width.
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g;
export function visibleLength(s: string): number {
  return stringWidth(s.replace(ANSI_REGEX, ''));
}

/**
 * Truncate `s` to `maxVisible` visible columns, preserving any ANSI
 * sequences encountered along the way. When the input contained ANSI
 * codes, an SGR reset is appended so the closing vertical doesn't
 * inherit the truncated content's colour.
 */
export function truncateVisible(s: string, maxVisible: number): string {
  if (visibleLength(s) <= maxVisible) return s;
  let out = '';
  let plain = '';
  let i = 0;
  let sawAnsi = false;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 0x1b && s[i + 1] === '[') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        sawAnsi = true;
        continue;
      }
    }
    const codePoint = s.codePointAt(i);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (stringWidth(plain + character) > maxVisible) break;
    out += character;
    plain += character;
    i += character.length;
  }
  return sawAnsi ? out + '\x1b[0m' : out;
}

// ── Generic primitives ───────────────────────────────────────────

function renderTop(g: GlyphSet, width: number): string {
  return g.TL + g.H.repeat(width) + g.TR;
}

function renderBottom(g: GlyphSet, width: number): string {
  return g.BL + g.H.repeat(width) + g.BR;
}

function renderLine(g: GlyphSet, content: string, width: number): string {
  const inner = ' ' + content;
  const visible = visibleLength(inner);
  if (visible >= width) {
    return g.V + truncateVisible(inner, width) + g.V;
  }
  return g.V + inner + ' '.repeat(width - visible) + g.V;
}

function renderTopTitled(g: GlyphSet, title: string, width: number): string {
  const lhs = `${g.TL}${g.H}${g.H} ${title} `;
  const visibleLhs = 2 + 1 + visibleLength(title) + 1;
  const remaining = Math.max(0, width - visibleLhs);
  return `${lhs}${g.H.repeat(remaining)}${g.TR}`;
}

// ── Sharp variant (default) ──────────────────────────────────────

export function boxTop(width: number): string {
  return renderTop(SHARP, width);
}

export function boxBottom(width: number): string {
  return renderBottom(SHARP, width);
}

export function boxLine(content: string, width: number): string {
  return renderLine(SHARP, content, width);
}

export function boxTopTitled(title: string, width: number): string {
  return renderTopTitled(SHARP, title, width);
}

// Explicit sharp aliases (for call sites that want to declare intent).
export const boxSharpTop        = boxTop;
export const boxSharpBottom     = boxBottom;
export const boxSharpLine       = boxLine;
export const boxSharpTopTitled  = boxTopTitled;

// ── Double-line variant ──────────────────────────────────────────

export function boxDoubleTop(width: number): string {
  return renderTop(DOUBLE, width);
}

export function boxDoubleBottom(width: number): string {
  return renderBottom(DOUBLE, width);
}

export function boxDoubleLine(content: string, width: number): string {
  return renderLine(DOUBLE, content, width);
}

export function boxDoubleTopTitled(title: string, width: number): string {
  return renderTopTitled(DOUBLE, title, width);
}

/**
 * Convenience: wrap an array of content rows with double-line
 * borders and an optional title. Returns the full multi-line box
 * as a single string with `\n` separators.
 */
export function boxDouble(rows: string[], width: number, title?: string): string {
  const top = title ? boxDoubleTopTitled(title, width) : boxDoubleTop(width);
  const body = rows.map((r) => boxDoubleLine(r, width)).join('\n');
  const bottom = boxDoubleBottom(width);
  return [top, body, bottom].filter(Boolean).join('\n');
}

/**
 * Convenience: wrap an array of content rows with sharp borders
 * and an optional title.
 */
export function boxSharp(rows: string[], width: number, title?: string): string {
  const top = title ? boxTopTitled(title, width) : boxTop(width);
  const body = rows.map((r) => boxLine(r, width)).join('\n');
  const bottom = boxBottom(width);
  return [top, body, bottom].filter(Boolean).join('\n');
}
