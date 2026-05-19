/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/ui/theme.ts — ONB1 (v4.7 onboarding rework).
 *
 * Self-contained theme module for the redesigned first-run experience.
 * Lives alongside, NOT instead of, the existing skin engine
 * (cli/v4/skinEngine.ts). The skin engine drives the REPL / boot card
 * / every post-onboarding surface; this theme drives only the
 * onboarding screens (slices 1–10 of dispatch ONB1).
 *
 * Why a separate module:
 *   - Onboarding palette is specified to a different muted/text spec
 *     than the existing skin (e.g. cool-grey #71717A vs warm-tan
 *     #B8A89A). Swapping the skin would re-paint every chat turn the
 *     user sees afterwards, surprising the eye on the *second* boot.
 *   - Onboarding is a single-shot surface — no per-user customisation,
 *     no YAML loader, no `monochrome`/`light` variants needed beyond
 *     graceful colour-depth degradation.
 *
 * Truecolor → 256 → 16 detection runs once at module load and is
 * cached. Set `AIDEN_FORCE_COLOR_DEPTH=truecolor|256|16|none` to
 * override (smoke tests rely on this).
 */

export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

/**
 * The 8-colour onboarding palette. Hex strings are the source of
 * truth; the emit functions below convert per detected depth.
 */
export const PALETTE = {
  primary: '#FF6B35', // brand orange — Aiden hero
  accent:  '#FFB088', // light orange — highlights
  success: '#4ADE80', // green checkmarks
  warning: '#FBBF24', // amber warnings
  error:   '#EF4444', // red errors
  text:    '#F5F5F5', // bright white — headers/titles
  muted:   '#71717A', // dim grey — secondary text/hints
  rule:    '#27272A', // dark grey — separators
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** Parse a `#RRGGBB` hex string into [r,g,b]. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Map a 24-bit RGB triple to the closest xterm-256 colour index.
 * Uses the standard 6×6×6 cube + grey-ramp approximation.
 */
function rgbTo256(r: number, g: number, b: number): number {
  // Grey-ramp fast path: when r==g==b within 8, prefer the 24-step ramp.
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number): number => Math.round(v / 51);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/**
 * Map a 24-bit RGB triple to a low-fidelity 16-colour ANSI code
 * (30–37 / 90–97). Picks the closest of the 16 standard slots.
 */
function rgbTo16(r: number, g: number, b: number): number {
  const STD: Array<[number, number, number, number]> = [
    [30, 0, 0, 0],       [31, 205, 49, 49],   [32, 13, 188, 121],  [33, 229, 229, 16],
    [34, 36, 114, 200],  [35, 188, 63, 188],  [36, 17, 168, 205],  [37, 229, 229, 229],
    [90, 102, 102, 102], [91, 241, 76, 76],   [92, 35, 209, 139],  [93, 245, 245, 67],
    [94, 59, 142, 234],  [95, 214, 112, 214], [96, 41, 184, 219],  [97, 229, 229, 229],
  ];
  let best = STD[0];
  let bestDist = Infinity;
  for (const cand of STD) {
    const [, cr, cg, cb] = cand;
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) { bestDist = d; best = cand; }
  }
  return best[0];
}

/** Detect the terminal's effective colour depth. Cached at module load. */
function detectColorDepth(): ColorDepth {
  const forced = process.env.AIDEN_FORCE_COLOR_DEPTH?.toLowerCase();
  if (forced === 'truecolor' || forced === '256' || forced === '16' || forced === 'none') {
    return forced;
  }
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '') return 'none';
  if (!process.stdout.isTTY) return 'none';
  const ct = (process.env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  const term = (process.env.TERM ?? '').toLowerCase();
  if (term.includes('256')) return '256';
  if (term === 'dumb' || term === '') return 'none';
  return '16';
}

const COLOR_DEPTH: ColorDepth = detectColorDepth();

/** Public: report the depth (smoke tests + diagnostics). */
export function getColorDepth(): ColorDepth { return COLOR_DEPTH; }

/** Wrap `text` in the SGR sequence for `kind`, degrading per depth. */
export function paint(text: string, kind: PaletteKey): string {
  if (COLOR_DEPTH === 'none') return text;
  const [r, g, b] = hexToRgb(PALETTE[kind]);
  if (COLOR_DEPTH === 'truecolor') return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  if (COLOR_DEPTH === '256') return `\x1b[38;5;${rgbTo256(r, g, b)}m${text}\x1b[39m`;
  return `\x1b[${rgbTo16(r, g, b)}m${text}\x1b[39m`;
}

/** Convenience helpers — one per palette key. */
export const c = {
  primary: (s: string): string => paint(s, 'primary'),
  accent:  (s: string): string => paint(s, 'accent'),
  success: (s: string): string => paint(s, 'success'),
  warning: (s: string): string => paint(s, 'warning'),
  error:   (s: string): string => paint(s, 'error'),
  text:    (s: string): string => paint(s, 'text'),
  muted:   (s: string): string => paint(s, 'muted'),
  rule:    (s: string): string => paint(s, 'rule'),
} as const;

/** SGR helpers for emphasis. Italic gracefully degrades when unsupported. */
export const bold   = (s: string): string => (COLOR_DEPTH === 'none' ? s : `\x1b[1m${s}\x1b[22m`);
export const italic = (s: string): string => (COLOR_DEPTH === 'none' ? s : `\x1b[3m${s}\x1b[23m`);
export const dim    = (s: string): string => (COLOR_DEPTH === 'none' ? s : `\x1b[2m${s}\x1b[22m`);

/**
 * Common ornaments — single source so onboarding screens share rhythm.
 */
export const SEP_HEAVY  = '━';
export const SEP_LIGHT  = '─';

/** Render a full-width separator in RULE colour, optionally heavy. */
export function separator(width: number, heavy = true): string {
  const w = Math.max(8, Math.min(width, 100));
  const ch = heavy ? SEP_HEAVY : SEP_LIGHT;
  return c.rule(ch.repeat(w));
}

/** Effective terminal width clamped to a sane band. */
export function termWidth(): number {
  const raw = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(raw, 100));
}
