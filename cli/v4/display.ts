/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display.ts — Aiden v4.0.0 (Phase 14a)
 *
 * Aiden's CLI display layer.
 *
 * Responsibilities:
 *   - render the welcome banner
 *   - render markdown to ANSI for the terminal (marked + marked-terminal)
 *   - format user/agent/tool/error turns with skin-aware colour
 *   - drive a lightweight spinner that works on Windows ConPTY
 *
 * Hermes reference: hermes_cli/banner.py + agent/display.py.
 */

import { marked } from 'marked';
// marked-terminal exports a CommonJS factory.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer: new (opts?: unknown) => unknown = require('marked-terminal').default ?? require('marked-terminal');

import { SkinEngine, getSkinEngine } from './skinEngine';

export interface SpinnerHandle {
  stop(finalText?: string): void;
  setText(text: string): void;
}

export interface AgentTurnOptions {
  /** Render markdown via `markdown()` before printing. Default: true. */
  markdown?: boolean;
  /** Optional reasoning preface (rendered muted). */
  reasoning?: string;
}

const AIDEN_BANNER = String.raw`
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝
`;

export class Display {
  private skin: SkinEngine;
  private out: NodeJS.WriteStream;
  private err: NodeJS.WriteStream;

  constructor(opts: { skin?: SkinEngine; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}) {
    this.skin = opts.skin ?? getSkinEngine();
    this.out = opts.stdout ?? process.stdout;
    this.err = opts.stderr ?? process.stderr;
    try {
      marked.setOptions({ renderer: new TerminalRenderer() as never });
    } catch {
      // marked-terminal optional — markdown() falls back to raw text below
    }
  }

  /** Build the welcome banner string (does not write). */
  banner(version = '4.0.0'): string {
    const sk = this.skin;
    const lines = AIDEN_BANNER.split('\n').map((l) => sk.applyColors(l, 'brand'));
    const tagline = sk.applyColors(`Aiden v${version} — your local-first agent`, 'muted');
    const hint = sk.applyColors('Type /help to see what I can do.', 'muted');
    return `${lines.join('\n')}\n  ${tagline}\n  ${hint}\n`;
  }

  /** Print the banner. */
  printBanner(version?: string): void {
    this.out.write(this.banner(version));
  }

  /**
   * Start a spinner. The implementation is a tiny custom one (no `ora`
   * dependency) so it survives non-TTY pipes and Windows ConPTY without
   * extra config. When stdout is not a TTY the spinner becomes a no-op
   * apart from emitting `text\n` once.
   */
  startSpinner(text: string): SpinnerHandle {
    const skin = this.skin;
    const frames = skin.getActive().glyphs?.spinner ?? ['|', '/', '-', '\\'];
    const isTty = !!this.out.isTTY;
    let current = text;
    let stopped = false;
    let frame = 0;
    let timer: NodeJS.Timeout | null = null;

    const render = (): void => {
      if (!isTty || stopped) return;
      const glyph = skin.applyColors(frames[frame % frames.length], 'accent');
      this.out.write(`\r${glyph} ${current}   `);
      frame += 1;
    };

    if (isTty) {
      render();
      timer = setInterval(render, 90);
    } else {
      this.out.write(`${text}\n`);
    }

    return {
      setText(next: string): void {
        current = next;
      },
      stop: (finalText?: string): void => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        if (isTty) {
          // clear the spinner line and write the final text on its own line
          this.out.write('\r\x1b[K');
        }
        if (finalText) this.out.write(`${finalText}\n`);
      },
    };
  }

  /**
   * Pretty-print a tool call before it executes. Args are JSON-stringified
   * with a 200-char hard cap so megabyte arguments don't flood the screen.
   */
  toolPreview(name: string, args: unknown): string {
    const sk = this.skin;
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      serialized = String(args);
    }
    if (serialized.length > 200) serialized = `${serialized.slice(0, 197)}...`;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';
    return `${sk.applyColors(arrow, 'tool')} ${sk.applyColors(name, 'tool')} ${sk.applyColors(serialized, 'muted')}`;
  }

  /** Render markdown to ANSI; falls back to raw text if marked-terminal failed to wire. */
  markdown(text: string): string {
    try {
      const out = marked.parse(text);
      return typeof out === 'string' ? out : String(out);
    } catch {
      return text;
    }
  }

  /** Format a user turn (e.g. echoed back from history). */
  userTurn(text: string): string {
    const sk = this.skin;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';
    return `${sk.applyColors(`${arrow} you`, 'user')}\n${text}\n`;
  }

  /** Format an agent turn — renders markdown by default. */
  agentTurn(text: string, opts: AgentTurnOptions = {}): string {
    const sk = this.skin;
    const useMd = opts.markdown !== false;
    const body = useMd ? this.markdown(text).trimEnd() : text;
    const head = sk.applyColors('Aiden', 'agent');
    const reasoning = opts.reasoning
      ? `${sk.applyColors(opts.reasoning.trim(), 'muted')}\n`
      : '';
    return `${head}\n${reasoning}${body}\n`;
  }

  /**
   * Format a recoverable error with optional remediation suggestion.
   * Output goes through the caller (returned as string), not stderr.
   */
  error(message: string, suggestion?: string): string {
    const sk = this.skin;
    const head = sk.applyColors('error:', 'error');
    const body = `${head} ${message}`;
    if (!suggestion) return `${body}\n`;
    return `${body}\n${sk.applyColors('hint:', 'warn')} ${suggestion}\n`;
  }

  /** Direct write helpers used by callers that already formatted text. */
  write(text: string): void {
    this.out.write(text);
  }
  writeError(text: string): void {
    this.err.write(text);
  }

  // ── Phase 14b helpers ─────────────────────────────────────────────────
  // Thin wrappers that print colour-prefixed lines via `write()`. These
  // exist so the slash-command handlers and CLI callbacks don't have to
  // hand-roll ANSI strings every time they want to emit a status line.
  // They always emit a trailing newline.

  /** Informational line, e.g. "Switching model…". */
  info(text: string): void {
    this.out.write(`${this.skin.applyColors('›', 'accent')} ${text}\n`);
  }

  /** Success line, e.g. "Switched to anthropic:claude-opus-4-7". */
  success(text: string): void {
    this.out.write(`${this.skin.applyColors('✓', 'success')} ${text}\n`);
  }

  /** Warning line, e.g. "Verbose mode requires restart." */
  warn(text: string): void {
    this.out.write(`${this.skin.applyColors('!', 'warn')} ${text}\n`);
  }

  /** Muted ("dim") line for low-priority diagnostics. */
  dim(text: string): void {
    this.out.write(`${this.skin.applyColors(text, 'muted')}\n`);
  }

  /** Horizontal rule for grouping CLI output. */
  line(width = 60): void {
    const ch = this.skin.getActive().glyphs?.bullet === '*' ? '-' : '─';
    this.out.write(`${this.skin.applyColors(ch.repeat(width), 'muted')}\n`);
  }

  /** Convenience: format an error and write it directly to stdout. */
  printError(message: string, suggestion?: string): void {
    this.out.write(this.error(message, suggestion));
  }

  // ── Phase 16c: streaming surface ─────────────────────────────────────
  // Tracks whether a streaming "Aiden" header has been written for the
  // current turn. `streamPartial` writes the header on the first call,
  // then appends every subsequent delta directly. `streamComplete`
  // closes the line so the next non-stream `agentTurn`/`info` call
  // starts on its own line.

  private streamHeaderShown = false;
  private streamLastEndedNewline = false;

  /**
   * Append a streamed text fragment. Writes a styled "Aiden" header on
   * the first call of a turn, then writes raw text directly via the
   * underlying `write` so token boundaries remain visible. Markdown
   * rendering is deferred — applying `marked` per-token would render
   * partial code fences as broken HTML; matches Hermes's pattern of
   * showing raw streamed text and reformatting on completion only when
   * the full body is in hand.
   */
  streamPartial(text: string): void {
    if (!text) return;
    if (!this.streamHeaderShown) {
      const head = this.skin.applyColors('Aiden', 'agent');
      this.out.write(`${head}\n`);
      this.streamHeaderShown = true;
    }
    this.out.write(text);
    this.streamLastEndedNewline = text.endsWith('\n');
  }

  /**
   * Mark the end of a streaming turn. Adds a trailing newline if the
   * stream didn't end with one so the next CLI line doesn't visually
   * butt up against the model's last token. Resets the per-turn state
   * so the next `streamPartial` re-emits the header.
   */
  streamComplete(): void {
    if (!this.streamHeaderShown) return;
    if (!this.streamLastEndedNewline) this.out.write('\n');
    this.streamHeaderShown = false;
    this.streamLastEndedNewline = false;
  }

  /**
   * Inline tool indicator. Printed between deltas when a tool call
   * surfaces during streaming so the user sees activity instead of a
   * stalled cursor. Always lands on its own line — adds a leading
   * newline if the prior delta ran past column N without one.
   */
  streamToolIndicator(name: string): void {
    const sk = this.skin;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';
    const prefix = this.streamLastEndedNewline ? '' : '\n';
    this.out.write(`${prefix}${sk.applyColors(`${arrow} ${name}…`, 'tool')}\n`);
    this.streamLastEndedNewline = true;
  }
}

let _global: Display | null = null;
export function getDisplay(): Display {
  if (!_global) _global = new Display();
  return _global;
}
export function resetDisplayForTests(): void {
  _global = null;
}
