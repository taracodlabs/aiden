/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/ui/banner.ts — ONB1 slice 2 (v4.7 onboarding rework).
 *
 * Auto-width banner block builder used by the disclaimer + success
 * screens. Re-uses the existing ANSI-Shadow AIDEN ASCII art shipped
 * in cli/v4/display.ts (constant `AIDEN_BANNER`) but composes it
 * inside a centred panel with tagline, version, and credit lines —
 * with no dependency on the skin engine.
 *
 * Layout @ ≥80 cols:
 *
 *     ╔══════════════════════════════════════════════════════════════╗
 *     ║                                                              ║
 *     ║                ▀▀▀█▀▀  ▀▀█ ▀▀█▀▀  ▄▄▄▄  ▄▄▄                  ║
 *     ║                  █  █▄▄▄█    █  █    █    █                  ║
 *     ║                  ...AIDEN ASCII (block style, brand orange)  ║
 *     ║                                                              ║
 *     ╚══════════════════════════════════════════════════════════════╝
 *
 *       Autonomous AI Engine · Local-first · v4.6.0
 *
 *       Built solo · By Taracod · White Lotus
 *
 * Narrow (<60 cols): collapses to a single-line title.
 *
 * Pure renderer — returns the composed string. Callers own the write.
 * No stateful spinners / inquirer prompts here.
 */

import { c, dim, termWidth, getColorDepth } from './theme';

/**
 * The block-style AIDEN ASCII. Copied from cli/v4/display.ts so this
 * module has zero coupling to the skin-engine display surface. 6 rows,
 * widest row = 36 cells.
 */
const AIDEN_ART = String.raw`
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝
`.trim().split('\n');

const ART_WIDTH = 36;

export interface BannerOptions {
  /** Aiden runtime version — rendered as `v{version}`. */
  version: string;
  /** Tagline line, e.g. 'Autonomous AI Engine'. */
  tagline?: string;
  /** Credits line, e.g. 'Built solo · By Taracod · White Lotus'. */
  credits?: string;
  /**
   * When true, render the panel border. Default: true. When false,
   * the banner art is emitted with no outer panel chrome (used for
   * the in-REPL hint banner).
   */
  framed?: boolean;
  /** Width override; defaults to `termWidth()` capped at 80. */
  width?: number;
}

/** Pad `s` to length `n` with spaces on the right. ANSI-safe-ish — */
/** assumes the caller has not yet wrapped colour codes around the    */
/** padded segment.                                                   */
function rpad(s: string, n: number): string {
  const len = s.length;
  if (len >= n) return s;
  return s + ' '.repeat(n - len);
}

/** Centre `s` within width `w` (no colour codes in `s`). */
function centre(s: string, w: number): string {
  if (s.length >= w) return s;
  const total = w - s.length;
  const left = Math.floor(total / 2);
  return ' '.repeat(left) + s + ' '.repeat(total - left);
}

/**
 * Build the framed banner block as a single string with trailing
 * newline. Truecolor → 256 → 16 / mono all handled by `theme.c.*`.
 */
export function renderBanner(opts: BannerOptions): string {
  const w = Math.max(40, Math.min(opts.width ?? termWidth(), 80));
  const narrow = w < 60;
  const tagline = opts.tagline ?? 'Autonomous AI Engine';
  const credits = opts.credits ?? 'Built solo · By Taracod · White Lotus';
  const versionLine = `${tagline} · Local-first · v${opts.version}`;

  // Narrow layout: single-line title + tagline + credits.
  if (narrow) {
    const out: string[] = [];
    out.push('');
    out.push(centre(c.primary('A I D E N'), w));
    out.push('');
    out.push(centre(c.muted(versionLine), w));
    out.push(centre(c.muted(credits), w));
    out.push('');
    return out.join('\n') + '\n';
  }

  // Wide layout: framed panel with ASCII art inside, taglines below.
  const inner = w - 2;
  const artPad = Math.max(0, Math.floor((inner - ART_WIDTH) / 2));
  const framed = opts.framed !== false;

  const horiz = '═'.repeat(inner);
  const top    = framed ? c.rule(`╔${horiz}╗`) : '';
  const bottom = framed ? c.rule(`╚${horiz}╝`) : '';
  const blank  = framed
    ? `${c.rule('║')}${' '.repeat(inner)}${c.rule('║')}`
    : ' '.repeat(w);

  const lines: string[] = [];
  lines.push('');
  if (framed) lines.push(top);
  lines.push(blank);
  for (const row of AIDEN_ART) {
    const padded = rpad(' '.repeat(artPad) + row, inner);
    const coloured = c.primary(padded);
    lines.push(framed ? `${c.rule('║')}${coloured}${c.rule('║')}` : `  ${coloured}`);
  }
  lines.push(blank);
  if (framed) lines.push(bottom);
  lines.push('');
  lines.push('  ' + dim(c.muted(versionLine)));
  lines.push('');
  lines.push('  ' + dim(c.muted(credits)));
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * Single-line title for use inside slash-command hints / tour pages
 * where the full banner would be too tall. Bright primary + version.
 */
export function renderTitleLine(version: string): string {
  return `${c.primary('AIDEN')} ${c.muted(`v${version}`)}`;
}

/** Diagnostic — exposes detected depth for smoke tests. */
export function bannerDiagnostic(): { width: number; depth: ReturnType<typeof getColorDepth> } {
  return { width: termWidth(), depth: getColorDepth() };
}
