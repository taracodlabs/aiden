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
 * Below the canonical identity width, callers receive only the startup width
 * requirement and wait for a resize before continuing.
 *
 * Pure renderer — returns the composed string. Callers own the write.
 * No stateful spinners / inquirer prompts here.
 */

import { c, dim, termWidth, getColorDepth } from './theme';
import {
  AIDEN_BOOT_MIN_COLUMNS,
  AIDEN_LOGO_CELL_WIDTH,
  AIDEN_LOGO_LINES,
} from './identity';

/**
 * The canonical block-style AIDEN ASCII. Six rows, widest row = 37 cells.
 */
const AIDEN_ART = AIDEN_LOGO_LINES;

const ART_WIDTH = AIDEN_LOGO_CELL_WIDTH;

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

/**
 * Build the framed banner block as a single string with trailing
 * newline. Truecolor → 256 → 16 / mono all handled by `theme.c.*`.
 */
export function renderBanner(opts: BannerOptions): string {
  const w = Math.max(1, Math.min(opts.width ?? termWidth(), 80));
  const tagline = opts.tagline ?? 'Autonomous AI Engine';
  const credits = opts.credits ?? 'Built solo · By Taracod · White Lotus';
  const versionLine = `${tagline} · Local-first · v${opts.version}`;

  if (w < AIDEN_BOOT_MIN_COLUMNS) {
    return [
      `Aiden requires at least ${AIDEN_BOOT_MIN_COLUMNS} columns to display its boot interface.`,
      'Widen the terminal to continue.',
      '',
    ].join('\n');
  }

  // v4.8.0 Slice 10b — wide layout flows the AIDEN art without the
  // heavy `╔══╗` frame (legacy chrome). The art carries its own
  // visual weight as the boot-card identity anchor; framing it
  // inside a closed box collides with the asymmetric orange-bar
  // language used by every other v4.8.0 surface.
  //
  const inner = w - 2;
  const artPad = Math.max(0, Math.floor((inner - ART_WIDTH) / 2));

  const lines: string[] = [];
  lines.push('');
  for (const row of AIDEN_ART) {
    const padded = rpad(' '.repeat(artPad) + row, inner);
    lines.push(`  ${c.primary(padded)}`);
  }
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
