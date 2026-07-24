/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/ui/progressBar.ts — v4.9.1 reusable progress animation.
 * Auto-detects TTY / NO_COLOR / TERM=dumb / CI to pick render mode
 * (block glyphs vs `#-`, color vs plain, animated vs once-per-second
 * non-TTY lines). Cursor hidden during animation, restored on exit.
 */

import { Writable } from 'node:stream';

export interface ProgressBarOptions {
  /** Top-line label, e.g. "Installing aiden-runtime v4.9.1...". */
  label:    string;
  /** Ordered phase names. `setPhase` must use one of these. */
  phases:   ReadonlyArray<string>;
  /** Bar cell count. Default 28. */
  width?:   number;
  /** Output stream (defaults to process.stdout). Tests inject a mock. */
  out?:     NodeJS.WriteStream | Writable;
  /** Override TTY detection (tests). When unset, reads `out.isTTY`. */
  isTTY?:   boolean;
  /** Override env for tests; defaults to process.env. */
  env?:     NodeJS.ProcessEnv;
  /** Render-tick interval (ms). Default 100. */
  tickMs?:  number;
}

export interface ProgressBar {
  setPhase(name: string): void;
  setPercent(p: number): void;
  /** Closing the bar successfully — replaces the line with the final message. */
  complete(message: string): void;
  /** Closing with failure — replaces the line with a red `✗` + message. */
  fail(message: string): void;
}

export interface PhaseIndicator {
  setPhase(name: string): void;
  complete(message: string): void;
  fail(message: string): void;
  cancel(message: string): void;
}

const DEFAULT_WIDTH   = 28;
const DEFAULT_TICK_MS = 100;
/** Minimum elapsed before we paint anything — avoids flicker on sub-300ms ops. */
const PAINT_AFTER_MS  = 300;

const ANSI_HIDE_CURSOR = '\x1b[?25l';
const ANSI_SHOW_CURSOR = '\x1b[?25h';
const ANSI_CLEAR_LINE  = '\r\x1b[2K';
const ANSI_BRAND       = '\x1b[38;2;255;107;53m';  // RGB 255,107,53 (Aiden orange)
const ANSI_MUTED       = '\x1b[38;2;106;106;106m';
const ANSI_SUCCESS     = '\x1b[38;2;127;194;139m';
const ANSI_ERROR       = '\x1b[38;2;224;90;90m';
const ANSI_RESET       = '\x1b[0m';

interface RenderMode {
  /** ANSI on/off. */
  color:    boolean;
  /** Block-glyph (`█░`) vs ASCII (`#-`). */
  blocks:   boolean;
  /** Live in-place rendering vs once-per-second plain text. */
  animated: boolean;
}

/** Detect the right render mode from TTY + env. Pure function. */
export function detectRenderMode(
  isTTY: boolean,
  env:   NodeJS.ProcessEnv = process.env,
): RenderMode {
  if (!isTTY)                                       return { color: false, blocks: false, animated: false };
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const dumb    = env.TERM === 'dumb' || env.CI === 'true' || env.CI === '1';
  return {
    color:    !noColor && !dumb,
    blocks:   !dumb,
    animated: true,
  };
}

/**
 * Build the rendered line (without trailing newline). Pure so tests
 * can assert byte-for-byte without timing.
 */
export function renderLine(opts: {
  width:   number;
  percent: number;
  phase:   string;
  elapsedMs: number;
  mode:    RenderMode;
}): string {
  const pct    = Math.max(0, Math.min(100, Math.round(opts.percent)));
  const filled = Math.round((pct / 100) * opts.width);
  const empty  = opts.width - filled;
  const full   = opts.mode.blocks ? '█' : '#';
  const blank  = opts.mode.blocks ? '░' : '-';
  const elapsed = `${(opts.elapsedMs / 1000).toFixed(1)}s`;
  const bar = full.repeat(filled) + blank.repeat(empty);
  if (opts.mode.color) {
    return `${ANSI_BRAND}[${bar}]${ANSI_RESET} ${pct}%  ${ANSI_MUTED}${opts.phase}${ANSI_RESET}  ${ANSI_MUTED}${elapsed}${ANSI_RESET}`;
  }
  return `[${bar}] ${pct}%  ${opts.phase}  ${elapsed}`;
}

/**
 * Start a progress bar. Returns a controller object. Never throws —
 * any I/O failure on output degrades the bar to a silent no-op while
 * still honoring `complete` / `fail` semantics for the caller.
 */
export function startProgressBar(opts: ProgressBarOptions): ProgressBar {
  const width = opts.width ?? DEFAULT_WIDTH;
  const out   = opts.out   ?? process.stdout;
  const env   = opts.env   ?? process.env;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isTTY = opts.isTTY ?? Boolean((out as any).isTTY);
  const mode  = detectRenderMode(isTTY, env);

  const startedAt = Date.now();
  let phase   = opts.phases[0] ?? '';
  let percent = 0;
  let painted = false;
  let closed  = false;

  const write = (s: string): void => {
    try { out.write(s); } catch { /* swallow — never break caller */ }
  };

  // SIGINT: restore cursor + clear the partial line before bubbling.
  const onSigint = (): void => {
    try { write(ANSI_CLEAR_LINE + ANSI_SHOW_CURSOR); } catch { /* noop */ }
  };
  if (mode.animated) {
    try { process.once('SIGINT', onSigint); } catch { /* noop */ }
  }

  // Label line paints once, immediately.
  write(`${mode.color ? ANSI_MUTED : ''}${opts.label}${mode.color ? ANSI_RESET : ''}\n`);

  const paint = (): void => {
    if (closed) return;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs < PAINT_AFTER_MS) return;
    const line = renderLine({ width, percent, phase, elapsedMs, mode });
    if (mode.animated) {
      if (!painted) { write(ANSI_HIDE_CURSOR); painted = true; }
      write(ANSI_CLEAR_LINE + line);
    } else {
      write(line + '\n');
    }
  };
  let timer: NodeJS.Timeout | null = null;
  if (mode.animated) {
    timer = setInterval(paint, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const close = (icon: string, color: string, message: string): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    try { process.removeListener('SIGINT', onSigint); } catch { /* noop */ }
    const finalLine = mode.color
      ? `${color}${icon}${ANSI_RESET} ${message}`
      : `${icon} ${message}`;
    if (mode.animated && painted) write(ANSI_CLEAR_LINE);
    write(finalLine + '\n');
    if (mode.animated) write(ANSI_SHOW_CURSOR);
  };

  return {
    setPhase(name: string)   { phase = name; if (!mode.animated) paint(); },
    setPercent(p: number)    { percent = p;  if (!mode.animated) paint(); },
    complete(message: string){ close('✓', ANSI_SUCCESS, message); },
    fail(message: string)    { close('✗', ANSI_ERROR,   message); },
  };
}

/**
 * Indeterminate phase indicator for operations whose underlying tool
 * exposes lifecycle phases but no measurable completion percentage.
 */
export function startPhaseIndicator(opts: ProgressBarOptions): PhaseIndicator {
  const out = opts.out ?? process.stdout;
  const env = opts.env ?? process.env;
  const tickMs = opts.tickMs ?? 120;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isTTY = opts.isTTY ?? Boolean((out as any).isTTY);
  const mode = detectRenderMode(isTTY, env);
  const startedAt = Date.now();
  const frames = mode.blocks ? ['◐', '◓', '◑', '◒'] : ['|', '/', '-', '\\'];
  let frame = 0;
  let phase = opts.phases[0] ?? 'working';
  let painted = false;
  let closed = false;

  const write = (value: string): void => {
    try { out.write(value); } catch { /* output failure must not break update */ }
  };
  const format = (): string => {
    const elapsed = `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`;
    const glyph = frames[frame++ % frames.length];
    return mode.color
      ? `${ANSI_BRAND}${glyph}${ANSI_RESET} ${phase}  ${ANSI_MUTED}${elapsed}${ANSI_RESET}`
      : `${glyph} ${phase}  ${elapsed}`;
  };
  const paint = (): void => {
    if (closed) return;
    const line = format();
    if (mode.animated) {
      if (!painted) {
        write(ANSI_HIDE_CURSOR);
        painted = true;
      }
      write(ANSI_CLEAR_LINE + line);
    } else {
      write(line + '\n');
    }
  };
  const onSigint = (): void => {
    if (mode.animated && painted) write(ANSI_CLEAR_LINE + ANSI_SHOW_CURSOR);
  };
  if (mode.animated) process.once('SIGINT', onSigint);

  write(`${mode.color ? ANSI_MUTED : ''}${opts.label}${mode.color ? ANSI_RESET : ''}\n`);
  paint();
  const timer = mode.animated ? setInterval(paint, tickMs) : null;
  timer?.unref?.();

  const close = (icon: string, color: string, message: string): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    process.removeListener('SIGINT', onSigint);
    if (mode.animated && painted) write(ANSI_CLEAR_LINE);
    const line = mode.color
      ? `${color}${icon}${ANSI_RESET} ${message}`
      : `${icon} ${message}`;
    write(line + '\n');
    if (mode.animated) write(ANSI_SHOW_CURSOR);
  };

  return {
    setPhase(name: string) {
      if (closed || name === phase) return;
      phase = name;
      paint();
    },
    complete(message: string) { close('✓', ANSI_SUCCESS, message); },
    fail(message: string) { close('✗', ANSI_ERROR, message); },
    cancel(message: string) { close('!', ANSI_MUTED, message); },
  };
}

/** npm install phase → default percent. Best-effort bar shaping. */
export function npmInstallPhasePercent(phase: string): number {
  switch (phase) {
    case 'spawning':    return 0;
    case 'resolving':   return 15;
    case 'downloading': return 50;
    case 'extracting':  return 85;
    case 'verifying':   return 97;
    case 'installed':   return 100;
    case 'failed':      return 100;
    default:            return 0;
  }
}

/** Detect npm phase from a stdout/stderr line. Checks ordered for npm 9/10/11. */
export function detectNpmPhase(line: string): string | null {
  const l = line.toLowerCase();
  if (l.includes('added ') && l.includes('package'))   return 'verifying';
  if (l.includes('http fetch'))                         return 'downloading';
  if (l.includes('extracting') || l.includes('extract'))return 'extracting';
  if (l.includes('reify:'))                             return 'downloading';
  if (l.includes('resolved') || l.includes('audit'))    return 'resolving';
  return null;
}
