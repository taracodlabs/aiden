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
 */

import { marked } from 'marked';
// marked-terminal exports a CommonJS factory.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer: new (opts?: unknown) => unknown = require('marked-terminal').default ?? require('marked-terminal');

import { SkinEngine, getSkinEngine } from './skinEngine';
import { visibleLength, truncateVisible } from './box';

export interface SpinnerHandle {
  stop(finalText?: string): void;
  setText(text: string): void;
}

/**
 * Phase 26.2.4 — a labelled section for the boot card's two-column
 * Environment/Capabilities block. `key` is rendered in muted, `value`
 * in default text. Title is rendered in brand orange.
 */
export interface ColumnSection {
  title: string;
  rows: Array<{ key: string; value: string }>;
}

/**
 * Phase 26.2.6 — pool of fun spinner phrases that the chat REPL
 * picks from per-turn. Replaces the static "Initializing agent…"
 * text with a touch of personality. Single-pick-per-turn (not a
 * mid-spin rotation) — keeps the line stable while the model thinks.
 */
export const SPINNER_PHRASES: readonly string[] = [
  'Thinking',
  'Pondering',
  'Brewing',
  'Cogitating',
  'Reasoning',
  'Computing',
  'Reflecting',
  'Considering',
  'Processing',
  'Brain yakka',
  'Untangling',
  'Synthesizing',
  'Working',
  'Crunching',
  'Plotting',
  'Hatching plans',
  'Caffeinating',
  'Thinking hard',
  'Smelting',
  'Conjuring',
];

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

  /**
   * Build the welcome banner string (does not write).
   *
   * Phase 23.6 (v3 visual style port): banner is the AIDEN block ASCII
   * art only, in brand orange, indented two columns to match the rest
   * of the boot card.  Status / session / version / ready lines are
   * emitted by chatSession.renderStartupCard so the banner stays a
   * typographic anchor, not a catalog.  `opts.tip` is accepted for
   * backward compat but ignored.
   */
  banner(_version = '4.0.0', _opts: { tip?: string } = {}): string {
    const sk = this.skin;
    const lines = AIDEN_BANNER.split('\n').map((l) =>
      l ? `  ${sk.applyColors(l, 'brand')}` : '',
    );
    return `${lines.join('\n')}\n`;
  }

  /** Print the banner. `opts.tip` accepted for backward compat; unused. */
  printBanner(version?: string, opts: { tip?: string } = {}): void {
    this.out.write(this.banner(version, opts));
  }

  // ── Phase 23.6 — v3 visual primitives ──────────────────────────────────
  // Pure renderers (return strings, don't write) so chatSession can
  // compose the boot card and turn rhythm without owning ANSI escapes.

  /** Terminal column count clamped to 100 — matches v3 width discipline. */
  cols(): number {
    return Math.min(this.out.columns ?? 80, 100);
  }

  /**
   * Thin horizontal rule (`──…──`) in muted colour, full visible width
   * minus the 2-column indent the boot card / turn render uses.  Returns
   * the line WITHOUT a trailing newline; caller adds one + the leading
   * 2-space indent.
   */
  rule(width?: number): string {
    const w = Math.max(8, (width ?? this.cols()) - 2);
    return this.skin.applyColors('─'.repeat(w), 'muted');
  }

  /** Render `▲` (brand-orange filled triangle) — Aiden's identity motif. */
  triangle(): string {
    return this.skin.applyColors('▲', 'brand');
  }

  /** Render `●` filled dot in success green (active state). */
  dotOn(): string {
    return this.skin.applyColors('●', 'success');
  }

  /** Render `○` hollow dot in muted (inactive state). */
  dotOff(): string {
    return this.skin.applyColors('○', 'muted');
  }

  /** Wrap text in success colour. */
  success_(text: string): string {
    return this.skin.applyColors(text, 'success');
  }

  /** Wrap text in warn colour. */
  warn_(text: string): string {
    return this.skin.applyColors(text, 'warn');
  }

  /** Wrap text in error colour. */
  error_(text: string): string {
    return this.skin.applyColors(text, 'error');
  }

  /**
   * Phase 26.2.3 — single-line assistant header in the Hermes
   * `┃ Aiden` style. `┃` (U+2503 heavy vertical) and `Aiden` are
   * both brand-orange. The thin rule that previously sat under the
   * label is gone — the per-turn separator (printed BEFORE the user
   * prompt by chatSession) carries that visual weight now.
   *
   * Returns one indented line with a trailing newline.
   */
  agentHeader(): string {
    const bar = this.skin.applyColors('┃', 'brand');
    const head = this.skin.applyColors('Aiden', 'brand');
    return `  ${bar} ${head}\n`;
  }

  /**
   * Phase 26.2.3 — turn boundary marker. Writes a thin muted rule
   * followed by a blank line. Called by `chatSession` BEFORE each
   * user-input read except the first (boot card already emits a
   * rule + blank). Single canonical separator for the conversation
   * surface.
   */
  printTurnSeparator(): void {
    this.out.write(`  ${this.rule()}\n\n`);
  }

  /**
   * Render the v3-style boot status line:
   *
   *   ● <provider> <model>  ·  ● 56/72 skills  ·  43 tools  ·  ○ 0 mem
   *
   * Dots colour-graded: green ● when count > 0, muted ○ when 0.  Provider
   * dot also tracks "active" — green when provider is reachable, error
   * red otherwise (caller passes `providerOk`).
   */
  bootStatusLine(args: {
    provider: string;
    model: string;
    providerOk?: boolean;
    skillsLoaded: number;
    skillsTotal?: number;
    tools: number;
    memCount?: number;
  }): string {
    const sk = this.skin;
    const sep = sk.applyColors(' · ', 'muted');
    const provDot = args.providerOk === false
      ? sk.applyColors('●', 'error')
      : this.dotOn();
    const skillsDot = args.skillsLoaded > 0 ? this.dotOn() : this.dotOff();
    const memCount = args.memCount ?? 0;
    const memDot = memCount > 0 ? this.dotOn() : this.dotOff();
    const provModel =
      `${provDot} ${sk.applyColors(args.provider, 'brand')} ` +
      `${sk.applyColors(args.model, 'muted')}`;
    const skillCount =
      typeof args.skillsTotal === 'number' && args.skillsTotal !== args.skillsLoaded
        ? `${args.skillsLoaded}/${args.skillsTotal}`
        : `${args.skillsLoaded}`;
    const skillsSeg = `${skillsDot} ${sk.applyColors(`${skillCount} skills`, 'muted')}`;
    const toolsSeg = sk.applyColors(`${args.tools} tools`, 'muted');
    const memSeg = `${memDot} ${sk.applyColors(`${memCount} mem`, 'muted')}`;
    return `  ${provModel}${sep}${skillsSeg}${sep}${toolsSeg}${sep}${memSeg}`;
  }

  // ── Phase 26.2.4 — neofetch-style sectioned boot card helpers ─────
  // Four pure renderers used by chatSession.renderStartupCard. Each
  // returns a string with no trailing newline so the caller controls
  // vertical rhythm. None of them branch on detection — chatSession
  // is responsible for collecting the data; Display just paints it.

  /**
   * Status pills row — one line, four pills separated by 4 spaces.
   * Format: `● core online    ● mode auto    ● model X    ● memory active`.
   * Dot is success-green when on, muted when off. Label is muted, value
   * is rendered in `agent` (off-white) for legibility without competing
   * with the banner orange.
   */
  statusPillsRow(args: {
    coreOnline: boolean;
    mode: string;
    model: string;
    memoryActive: boolean;
  }): string {
    const sk = this.skin;
    const dot = (on: boolean): string => sk.applyColors('●', on ? 'success' : 'muted');
    const lab = (s: string): string => sk.applyColors(s, 'muted');
    const val = (s: string): string => sk.applyColors(s, 'agent');
    const pill = (on: boolean, label: string, value: string): string =>
      `${dot(on)} ${lab(label)} ${val(value)}`;
    return (
      '  ' +
      [
        pill(args.coreOnline, 'core', args.coreOnline ? 'online' : 'starting'),
        pill(true, 'mode', args.mode),
        pill(true, 'model', args.model),
        pill(args.memoryActive, 'memory', args.memoryActive ? 'active' : 'off'),
      ].join('    ')
    );
  }

  /**
   * Two-column block (Environment + Capabilities). Side-by-side when
   * `cols() >= 80`, stacked vertically below that. Title in brand,
   * keys in muted (padded to 11 visible chars), values in `agent`.
   */
  twoColumnBlock(left: ColumnSection, right: ColumnSection): string {
    const sk = this.skin;
    const cols = this.cols();
    const stacked = cols < 80;
    const indent = '  ';
    const KEY_PAD = 11;

    const renderRows = (sec: ColumnSection): string[] => {
      const rows = [sk.applyColors(sec.title, 'brand')];
      for (const r of sec.rows) {
        const k = sk.applyColors(r.key.padEnd(KEY_PAD), 'muted');
        const v = sk.applyColors(r.value, 'agent');
        rows.push(`${k}${v}`);
      }
      return rows;
    };

    if (stacked) {
      const out: string[] = [];
      for (const ln of renderRows(left)) out.push(`${indent}${ln}`);
      out.push('');
      for (const ln of renderRows(right)) out.push(`${indent}${ln}`);
      return out.join('\n');
    }

    // Side-by-side. Each column capped at 40 visible chars; separator
    // is 4 spaces. At cols=80 the right column has 32 chars to work
    // with, which fits all hardcoded capability values.
    const colW = Math.min(40, Math.floor((cols - indent.length - 4) / 2));
    const sep = '    ';
    const leftRows = renderRows(left);
    const rightRows = renderRows(right);
    const maxRows = Math.max(leftRows.length, rightRows.length);
    const out: string[] = [];
    for (let i = 0; i < maxRows; i += 1) {
      const l = leftRows[i] ?? '';
      const r = rightRows[i] ?? '';
      const lVis = visibleLength(l);
      const lPadded = lVis < colW ? l + ' '.repeat(colW - lVis) : l;
      out.push(`${indent}${lPadded}${sep}${r}`);
    }
    return out.join('\n');
  }

  /**
   * Phase 26.2.5 — parchment-shaped credits footer. Replaces the
   * earlier scroll ASCII whose diagonals wouldn't align reliably in
   * a monospace cell. Layout:
   *
   *       ___________________________________________________________
   *      |                                                           |
   *      |   ♥  Built solo                                           |
   *      |   GitHub:  github.com/taracodlabs/aiden                   |
   *      |   Web:     aiden.taracod.com                              |
   *      |   Contact: contact@taracod.com                            |
   *      |___________________________________________________________|
   *
   * Top underscore lid floats one column past the left wall (the lid
   * sits *between* the pipes, not over them) — gives the parchment a
   * lifted-corner feel without using corner glyphs. Bottom is sealed.
   *
   * Width-responsive:
   *   cols >= 80 → full parchment (interior 63 chars)
   *   cols <  80 → plain 4-line text fallback (no border)
   *
   * Colours: borders in muted, ♥ in brand, field labels in brand,
   * field values in `agent` (off-white). Each colour span is its own
   * SGR open/close — no nesting — so the closing reset doesn't bleed
   * across lines.
   */
  scrollFooter(): string {
    const sk = this.skin;
    const m = (s: string): string => sk.applyColors(s, 'muted');
    const lab = (s: string): string => sk.applyColors(s, 'brand');
    const val = (s: string): string => sk.applyColors(s, 'agent');
    const heart = sk.applyColors('♥', 'brand');

    if (this.cols() < 80) {
      // Plain 4-line fallback (no border).
      return [
        `  ${heart}  ${val('Built solo')}`,
        `  ${lab('GitHub:')}  ${val('github.com/taracodlabs/aiden')}`,
        `  ${lab('Web:')}     ${val('aiden.taracod.com')}`,
        `  ${lab('Contact:')} ${val('contact@taracod.com')}`,
      ].join('\n');
    }

    // Parchment.
    const INTERIOR = 63;
    const wallIndent = '     ';     // 5 spaces — column where the | sits
    const lidIndent = '      ';     // 6 spaces — lid floats one past the wall
    const pipe = m('|');
    const lid = m('_'.repeat(INTERIOR));

    const padInner = (text: string): string => {
      const v = visibleLength(text);
      if (v >= INTERIOR) return truncateVisible(text, INTERIOR);
      return text + ' '.repeat(INTERIOR - v);
    };

    return [
      lidIndent + lid,
      wallIndent + pipe + ' '.repeat(INTERIOR) + pipe,
      wallIndent + pipe + padInner(`   ${heart}  ${val('Built solo')}`) + pipe,
      wallIndent + pipe + padInner(`   ${lab('GitHub:')}  ${val('github.com/taracodlabs/aiden')}`) + pipe,
      wallIndent + pipe + padInner(`   ${lab('Web:')}     ${val('aiden.taracod.com')}`) + pipe,
      wallIndent + pipe + padInner(`   ${lab('Contact:')} ${val('contact@taracod.com')}`) + pipe,
      wallIndent + pipe + lid + pipe,
    ].join('\n');
  }

  /**
   * Bottom prompt hint that replaces the prior `ready ▸  /help` +
   * `✦ Tip:` lines. `▲` in brand, body in muted.
   */
  bottomPromptHint(): string {
    const sk = this.skin;
    const tri = sk.applyColors('▲', 'brand');
    const text = sk.applyColors(
      'Type your message · /help for commands · /skills to add more',
      'muted',
    );
    return `  ${tri} ${text}`;
  }

  /**
   * v3-style "ready" line:
   *
   *   ready ▸  /help for commands
   *
   * "ready" + ▸ in brand orange; trailing hint in muted.
   */
  readyLine(hint = '/help for commands'): string {
    const sk = this.skin;
    const ready = sk.applyColors('ready', 'brand');
    const arrow = sk.applyColors('▸', 'brand');
    return `  ${ready} ${arrow}  ${sk.applyColors(hint, 'muted')}`;
  }

  /**
   * v3-style post-turn status footer:
   *
   *   ▲ groq · llama-3.3-70b  │  ▓▓▓░░░░░░░ 12.4K/128K  │  2s
   *
   * Width-bounded (10-cell context bar), always one line.  Provider
   * appears in muted, model bold, ctx bar colour-graded by % full,
   * elapsed in muted.  Returns string sans trailing newline.
   */
  statusFooter(args: {
    provider: string;
    model: string;
    ctxUsed: number;
    ctxMax: number;
    elapsedMs: number;
  }): string {
    const sk = this.skin;
    const SEP = sk.applyColors(' │ ', 'muted');
    const tri = this.triangle();
    const provModel =
      `${tri} ${sk.applyColors(args.provider, 'muted')}` +
      `${sk.applyColors(' · ', 'muted')}` +
      sk.applyColors(args.model, 'agent');

    const pct = args.ctxMax > 0
      ? Math.min(100, Math.round((args.ctxUsed / args.ctxMax) * 100))
      : 0;
    const barW = 10;
    const filled = Math.round((pct / 100) * barW);
    const ctxKind: 'success' | 'warn' | 'error' =
      pct < 60 ? 'success' : pct < 85 ? 'warn' : 'error';
    const bar =
      sk.applyColors('▓'.repeat(filled), ctxKind) +
      sk.applyColors('░'.repeat(barW - filled), 'muted');
    const ctxLabel = `${formatCompactTokens(args.ctxUsed)}/${formatCompactTokens(args.ctxMax)}`;
    const ctxSeg = `${bar} ${sk.applyColors(ctxLabel, ctxKind)}`;

    const elapsed = sk.applyColors(formatElapsedShort(args.elapsedMs), 'muted');

    return `  ${provModel}${SEP}${ctxSeg}${SEP}${elapsed}`;
  }

  /**
   * Optional provider-switch indicator line — emitted only when this
   * turn ran on a different provider than the previous one.  Format
   * matches v3:
   *
   *   groq ──→ openrouter
   */
  providerSwitchLine(prev: string, next: string): string {
    return `  ${this.skin.applyColors(`${prev} ──→ ${next}`, 'muted')}`;
  }

  /**
   * Inquirer prompt prefix — "▲ " in brand orange (Phase 26.2.6 lock:
   * reverted from the brief Phase 26.2.3 `●` swap to keep the prompt
   * glyph aligned with the bottom hint's `▲ Type your message …` and
   * with Aiden's brand mark from v3). Inquirer prepends its own
   * padding, so we only ship the bare 2-char prefix.
   */
  promptPrefix(): string {
    return `${this.skin.applyColors('▲', 'brand')} `;
  }

  /**
   * Phase 26.2.6 — pick a random phrase from `SPINNER_PHRASES`,
   * append `…`, and wrap in brand orange. `rand` is injectable so
   * tests can pin the selection (and the chat REPL passes the
   * default Math.random for live use).
   */
  thinkingPhrase(rand: () => number = Math.random): string {
    const idx = Math.floor(rand() * SPINNER_PHRASES.length);
    const phrase = SPINNER_PHRASES[Math.max(0, Math.min(SPINNER_PHRASES.length - 1, idx))];
    return this.skin.applyColors(`${phrase}…`, 'brand');
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
      // Phase 23.5: spinner glyph in soft cyan (muted), not brand orange.
      // Quiet color, not loud — Hermes principle 6.
      const glyph = skin.applyColors(frames[frame % frames.length], 'muted');
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

  // ── Phase 23.5 — Hermes-style tool event row ──────────────────────────
  // One line per tool call: a "·" gutter, the keyword `tool`, the
  // tool name (soft cyan, padded), a brief truncated arg preview, and
  // a single right-side bracket cluster carrying state. Bracket
  // mutates in place: [running] → [ok 220ms] / [fail 1.4s] / [retry
  // 1/2 …] / product-specific terminals. No multi-line spew, no raw
  // JSON deltas.
  //
  // On non-TTY stdout (pipes, CI logs) the row is deferred until
  // completion so each line in the log carries the final state — no
  // ANSI cursor games on a dumb sink.

  toolRow(name: string, args: unknown): ToolRowHandle {
    const sk = this.skin;
    const argStr = previewToolArgs(args);
    const padded = name.length > TOOL_ROW_NAME_PAD
      ? name.slice(0, TOOL_ROW_NAME_PAD)
      : name.padEnd(TOOL_ROW_NAME_PAD);
    const left =
      `  ${sk.applyColors('·', 'muted')} ` +
      `${sk.applyColors('tool', 'muted')} ` +
      `${sk.applyColors(padded, 'tool')} ` +
      `${sk.applyColors(argStr, 'muted')}`;

    const renderBracket = (text: string, kind: ColorKindForBracket): string => {
      const colored = sk.applyColors(`[${text}]`, kind);
      return `${left} ${colored}\n`;
    };

    const isTty = !!this.out.isTTY;
    let printed = false;

    const writeFinal = (text: string, kind: ColorKindForBracket): void => {
      if (isTty && printed) {
        // Move up one line, clear it, then write the final row.
        this.out.write('\x1b[1A\x1b[2K\r');
      }
      this.out.write(renderBracket(text, kind));
      printed = true;
    };

    if (isTty) {
      this.out.write(renderBracket('running', 'warn'));
      printed = true;
    }
    // On non-TTY we hold off entirely until the caller signals completion.

    return {
      ok(durationMs: number, retries = 0) {
        const text =
          retries > 0
            ? `ok ${formatToolDuration(durationMs)} after ${retries} ${retries === 1 ? 'retry' : 'retries'}`
            : `ok ${formatToolDuration(durationMs)}`;
        writeFinal(text, 'success');
      },
      fail(durationMs: number, retries = 0) {
        const text =
          retries > 0
            ? `fail ${formatToolDuration(durationMs)} after ${retries} ${retries === 1 ? 'retry' : 'retries'}`
            : `fail ${formatToolDuration(durationMs)}`;
        writeFinal(text, 'error');
      },
      retry(n: number, m: number) {
        writeFinal(`retry ${n}/${m} …`, 'warn');
      },
      blocked() {
        writeFinal('blocked', 'warn');
      },
      emptyRetry() {
        writeFinal('empty retry', 'warn');
      },
      emptyFail() {
        writeFinal('empty fail', 'error');
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

  /**
   * Format an agent turn in the Phase 23.6 v3-style:
   *
   *     Aiden                       (bold orange label)
   *     ─────────────────────…      (muted thin rule)
   *     <body>                       (rendered markdown / plain text)
   *
   * Body is indented 2 columns to match the boot card and footer.
   * Trailing newline included so the caller can stack a status footer
   * directly underneath.
   */
  agentTurn(text: string, opts: AgentTurnOptions = {}): string {
    const sk = this.skin;
    const useMd = opts.markdown !== false;
    const rawBody = useMd ? this.markdown(text).trimEnd() : text;
    const indented = rawBody
      .split('\n')
      .map((ln) => (ln ? `  ${ln}` : ''))
      .join('\n');
    const reasoning = opts.reasoning
      ? `  ${sk.applyColors(opts.reasoning.trim(), 'muted')}\n`
      : '';
    return `${this.agentHeader()}${reasoning}${indented}\n`;
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

  /**
   * Wrap `text` with the active skin's brand colour (orange #FF6B35 in
   * the default skin). Used by boxed framing for major UX moments —
   * setup-complete, /doctor results, critical errors. Returns a string
   * so callers can compose lines; does not write.
   */
  brand(text: string): string {
    return this.skin.applyColors(text, 'brand');
  }

  /**
   * Wrap `text` with the active skin's muted colour (soft cyan #6FB3D2
   * in the default skin) and return the string. Companion to `brand` —
   * use when composing partially-coloured lines like the status bar
   * where some segments are coloured separately. `dim()` writes a full
   * line; `muted()` returns a fragment.
   */
  muted(text: string): string {
    return this.skin.applyColors(text, 'muted');
  }

  /**
   * Wrap `text` with a semantic colour and return the string. Used by
   * the status bar's right-most state segment (ready/generating/exec/
   * approve/retry) where each state has a distinct colour.
   */
  paint(text: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted'): string {
    return this.skin.applyColors(text, kind);
  }

  /**
   * Phase 26.2.1 — render a tight pill: `‹label VALUE›` (with leading
   * space-separated label) or `‹VALUE›` when label is empty. The
   * `‹›` glyphs (U+2039 / U+203A) sit in `muted`; the label sits in
   * `muted`; the value sits in `kind` (default `brand`). Pure — returns
   * a string with no trailing newline so callers can compose multiple
   * pills on a single line.
   *
   * Used by the boot card (single `‹v4.0.0›` pill) and Phase 26.2.2's
   * status-bar pill row.
   */
  pill(label: string, value: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted' = 'brand'): string {
    const open = this.skin.applyColors('‹', 'muted');
    const close = this.skin.applyColors('›', 'muted');
    const lbl = label ? `${this.skin.applyColors(label, 'muted')} ` : '';
    const val = this.skin.applyColors(value, kind);
    return `${open}${lbl}${val}${close}`;
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
   * partial code fences as broken HTML; pattern of
   * showing raw streamed text and reformatting on completion only when
   * the full body is in hand.
   */
  streamPartial(text: string): void {
    if (!text) return;
    if (!this.streamHeaderShown) {
      // Phase 26.2.3 — share the single-line `┃ Aiden` header with
      // non-streaming agentTurn so streamed and non-streamed responses
      // open identically.
      this.out.write(this.agentHeader());
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

// ── Phase 23.5 — tool row helpers ─────────────────────────────────────

/** Width the tool name is padded to so brackets line up across rows. */
const TOOL_ROW_NAME_PAD = 16;
/** Args preview cap. Args longer than this get truncated with "…". */
const TOOL_ROW_ARG_CAP = 40;

type ColorKindForBracket = 'success' | 'warn' | 'error';

/**
 * Handle returned by `Display.toolRow()`. Mutates the row's bracket in
 * place once the tool resolves. Each method writes the row exactly once;
 * subsequent calls would double-print.
 */
export interface ToolRowHandle {
  ok(durationMs: number, retries?: number): void;
  fail(durationMs: number, retries?: number): void;
  retry(n: number, m: number): void;
  blocked(): void;
  emptyRetry(): void;
  emptyFail(): void;
}

/**
 * Build a compact, single-line preview of the tool's arguments. Picks
 * the most informative scalar fields when the args are an object, then
 * truncates with an ellipsis at TOOL_ROW_ARG_CAP. Pure — no side
 * effects, deterministic for a given input.
 */
export function previewToolArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return truncToolArg(args);
  if (typeof args !== 'object') return truncToolArg(String(args));
  const obj = args as Record<string, unknown>;
  // Prefer obvious "first" fields the user can recognise without
  // reading JSON. Fall back to the full JSON otherwise.
  const preferKeys = [
    'query', 'q', 'url', 'path', 'file', 'name', 'command', 'cmd',
    'message', 'text', 'content', 'prompt',
  ];
  for (const k of preferKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      return truncToolArg(k === 'url' || k === 'path' || k === 'file'
        ? v
        : `"${v}"`);
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch {
    serialized = String(obj);
  }
  return truncToolArg(serialized);
}

function truncToolArg(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= TOOL_ROW_ARG_CAP) return flat;
  return flat.slice(0, TOOL_ROW_ARG_CAP - 1) + '…';
}

/**
 * Render a tool-call duration in the bracket cluster. Sub-second
 * durations show ms; ≥1s shows one decimal place of seconds. Pure.
 */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  return `${Math.round(sec)}s`;
}

// ── Phase 23.6 — token / elapsed formatters for the status footer ──────

/** "12345" → "12.3K"; "1234567" → "1.2M". Used by statusFooter. */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "850" → "850ms"; "2300" → "2.3s"; "75000" → "1m 15s". */
export function formatElapsedShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1).replace(/\.0$/, '')}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec - mins * 60);
  return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
}

let _global: Display | null = null;
export function getDisplay(): Display {
  if (!_global) _global = new Display();
  return _global;
}
export function resetDisplayForTests(): void {
  _global = null;
}
