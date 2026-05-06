/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/aidenTUI.ts — Aiden v4.0.0 (Phase 15)
 *
 * Full-screen TUI rendering layer. Wraps `blessed` with three regions:
 * scrollable history (~70%), single-row status line, multi-line input box
 * with border. Modal overlays for slash command picker, approval prompts,
 * and skill proposal prompts. Mouse selection + scroll wheel + paste
 * detection (timing heuristic) come for free from blessed.
 *
 * The agent loop, providers, tools, moat — all unchanged from Phase 14c.
 * This is a pure rendering layer that drives the same `ChatSession`
 * engine via a swapped Display surface and a TUI-flavoured promptApi.
 *
 * Hermes reference: prompt_toolkit `Application` full-screen mode +
 * Hermes `HermesCLI.run()` modal flow. Translated into blessed widgets.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { ChatSession } from './chatSession';
import type { ChatSessionOptions, ChatPromptApi } from './chatSession';
import type { CommandRegistry } from './commandRegistry';

export interface TuiOptions {
  /** Pre-built ChatSessionOptions (same shape Phase 14c hands ChatSession). */
  sessionOpts: ChatSessionOptions;
  /** Skin name (passed for status-line formatting only — not yet themed). */
  skinName?: string;
  /** Test injection: stub blessed module. */
  blessedModule?: any;
  /** Test injection: stub ChatSession ctor. */
  chatSessionCtor?: any;
  /** Test injection: bypass screen.render() for headless tests. */
  noRender?: boolean;
}

/** Public: launch TUI with graceful fallback to classic CLI. */
export async function runTuiMode(opts: TuiOptions): Promise<void> {
  if (!process.stdout.isTTY && !opts.blessedModule) {
    process.stdout.write(
      'TUI mode requires a TTY. Falling back to classic CLI.\n',
    );
    await runClassic(opts);
    return;
  }

  let tui: AidenTUI;
  try {
    tui = new AidenTUI(opts);
  } catch (err) {
    if (isTuiInitFailure(err)) {
      process.stdout.write(
        `TUI failed to initialize (${(err as Error).message}). Falling back to classic CLI.\n`,
      );
      await runClassic(opts);
      return;
    }
    throw err;
  }

  await tui.run();
}

async function runClassic(opts: TuiOptions): Promise<void> {
  const Ctor = opts.chatSessionCtor ?? ChatSession;
  const session = new Ctor(opts.sessionOpts);
  await session.run();
}

export function isTuiInitFailure(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return (
    msg.includes('Error opening terminal') ||
    msg.includes('terminfo') ||
    msg.includes('smartCSR') ||
    msg.includes('no TTY')
  );
}

/** Internal: full-screen blessed-driven renderer. */
export class AidenTUI {
  // Public for tests — these are blessed widget handles.
  screen: any;
  historyBox: any;
  statusLine: any;
  inputBox: any;
  overlays: any[] = [];

  private blessed: any;
  private session: any;
  private session_run_promise: Promise<void> | null = null;
  private pendingResolve: ((value: string | null) => void) | null = null;
  private pendingSelectResolve: ((value: string | null) => void) | null = null;
  private spinnerTimer: NodeJS.Timeout | null = null;

  constructor(private opts: TuiOptions) {
    this.blessed = opts.blessedModule ?? require('blessed');
    this.buildScreen();
    this.wireKeyboard();
    this.wireMouse();
    this.setupPasteDetection();

    const Ctor = opts.chatSessionCtor ?? ChatSession;

    // Build a TUI-flavoured promptApi + display proxy and inject them
    // into the existing ChatSession so the engine is reused unchanged.
    const tuiPromptApi: ChatPromptApi = {
      readLine: (prompt) => this.readLineViaInput(prompt),
      selectSlashCommand: (source) => this.selectSlashViaOverlay(source),
    };

    const sessionOpts: ChatSessionOptions = {
      ...opts.sessionOpts,
      promptApi: tuiPromptApi,
      installSignalHandler: false, // we own SIGINT in TUI mode
    };

    // Patch the display methods so any text the chat engine emits flows
    // into the history pane instead of stdout.
    sessionOpts.display = this.wrapDisplay(sessionOpts.display) as any;

    this.session = new Ctor(sessionOpts);
  }

  /** Full-screen takeover. Resolves when the session ends. */
  async run(): Promise<void> {
    if (!this.opts.noRender) this.screen.render();
    try {
      this.session_run_promise = this.session.run();
      await this.session_run_promise;
    } finally {
      if (this.spinnerTimer) clearInterval(this.spinnerTimer);
      try {
        this.screen.destroy();
      } catch {
        // already destroyed
      }
    }
  }

  // ─── Screen construction ──────────────────────────────────────────

  private buildScreen(): void {
    const blessed = this.blessed;

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Aiden v4.0.0',
      mouse: true,
      cursor: { artificial: true, blink: true, shape: 'line' },
      fullUnicode: true,
    });

    this.historyBox = blessed.log({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-4',
      tags: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      scrollbar: { ch: ' ', track: { bg: 'gray' }, style: { bg: 'white' } },
      style: { fg: 'white' },
    });

    this.statusLine = blessed.box({
      parent: this.screen,
      bottom: 3,
      left: 0,
      width: '100%',
      height: 1,
      content: '',
      tags: true,
      style: { fg: 'gray' },
    });

    this.inputBox = blessed.textbox({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      inputOnFocus: true,
      mouse: true,
      keys: true,
      border: { type: 'line' },
      label: ' input ',
      style: {
        border: { fg: '#ff6b35' },
        fg: 'white',
        focus: { border: { fg: '#ff6b35' } },
      },
    });

    this.inputBox.focus();
  }

  // ─── Keyboard / mouse / paste ─────────────────────────────────────

  private wireKeyboard(): void {
    // Ctrl+C and Ctrl+D both quit cleanly.
    this.screen.key(['C-c', 'C-d'], () => {
      this.appendHistory('{gray-fg}Goodbye.{/gray-fg}');
      // If session.run() is awaiting input, resolve it with empty string
      // and tag a follow-up exit. Cleanest path: just exit the process.
      try {
        this.screen.destroy();
      } catch {
        // ignore
      }
      process.exit(0);
    });
  }

  private wireMouse(): void {
    // History pane scroll wheel and click are wired by `mouse: true` in
    // the log widget config. Right-click context menus are deferred to
    // v4.1 — the spec explicitly defers them.
    /* no-op for now */
  }

  /**
   * Paste detection via keypress timing heuristic. When many printable
   * chars arrive with <10ms gaps, treat the run as pasted text. blessed
   * itself doesn't fire a "paste" event, but inserts the chars normally,
   * so detection is observational only — useful for status hints.
   */
  private setupPasteDetection(): void {
    let lastKeyTime = 0;
    let burstChars = 0;
    let pasteFlagged = false;

    if (!this.inputBox.on) return;
    this.inputBox.on('keypress', (ch: string) => {
      if (!ch || ch.length !== 1) return;
      const now = Date.now();
      const dt = now - lastKeyTime;
      lastKeyTime = now;

      if (dt < 10) {
        burstChars += 1;
        if (burstChars >= 30 && !pasteFlagged) {
          pasteFlagged = true;
          this.statusLine.setContent(
            '{yellow-fg}(paste detected — submit with enter){/yellow-fg}',
          );
          if (!this.opts.noRender) this.screen.render();
        }
      } else if (dt > 100) {
        burstChars = 0;
        pasteFlagged = false;
      }
    });
  }

  // ─── ChatSession <-> TUI bridge ──────────────────────────────────

  /** Wraps a Display so its writes stream to history pane, not stdout. */
  private wrapDisplay(display: any): any {
    const append = (msg: string) => this.appendHistory(msg);

    return {
      // Direct methods the chat engine calls.
      printBanner: () => {
        // Banner replaced with chrome — the box border IS the chrome.
        append('{#ff6b35-fg}Aiden v4.0.0 — TUI mode{/}');
      },
      info: (msg: string) => append(`{cyan-fg}› ${msg}{/cyan-fg}`),
      success: (msg: string) => append(`{green-fg}✓ ${msg}{/green-fg}`),
      warn: (msg: string) => append(`{yellow-fg}! ${msg}{/yellow-fg}`),
      error: (msg: string, suggestion?: string) => {
        const out = `{red-fg}error:{/red-fg} ${msg}`;
        return suggestion ? `${out}\n{yellow-fg}hint:{/yellow-fg} ${suggestion}` : out;
      },
      printError: (msg: string, suggestion?: string) => {
        append(`{red-fg}error:{/red-fg} ${msg}`);
        if (suggestion) append(`{yellow-fg}hint:{/yellow-fg} ${suggestion}`);
      },
      dim: (msg: string) => append(`{gray-fg}${msg}{/gray-fg}`),
      line: (_w?: number) => append('{gray-fg}─────────────────{/gray-fg}'),
      write: (msg: string) => append(stripAnsi(msg)),
      writeError: (msg: string) => append(`{red-fg}${stripAnsi(msg)}{/red-fg}`),

      // Renderers the chat engine calls and re-emits via write().
      banner: () => '',
      markdown: (text: string) => text, // blessed handles its own tags
      userTurn: (text: string) => `{#ff6b35-fg}you{/} ${text}`,
      agentTurn: (text: string) => `{cyan-fg}Aiden{/cyan-fg}\n${text}`,
      toolPreview: (name: string, args: unknown) => {
        const argStr = safeJson(args).slice(0, 200);
        return `{gray-fg}→ ${name} ${argStr}{/gray-fg}`;
      },

      startSpinner: (text: string) => this.startTuiSpinner(text),

      // Forwarded rarely-used helpers from the underlying Display so any
      // sibling code that reaches into `display.foo()` still works.
      _underlying: display,
    };
  }

  private appendHistory(content: string): void {
    if (!this.historyBox || typeof this.historyBox.log !== 'function') return;
    this.historyBox.log(content);
    if (!this.opts.noRender) this.screen.render();
  }

  private startTuiSpinner(text: string): { stop: () => void; setText: (t: string) => void } {
    let frame = 0;
    let current = text;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = setInterval(() => {
      this.statusLine.setContent(
        `{cyan-fg}${frames[frame++ % frames.length]}{/cyan-fg} ${current}`,
      );
      if (!this.opts.noRender) this.screen.render();
    }, 90);
    return {
      stop: () => {
        if (this.spinnerTimer) clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
        this.statusLine.setContent('');
        if (!this.opts.noRender) this.screen.render();
      },
      setText: (t: string) => {
        current = t;
      },
    };
  }

  // ─── Input prompt API ────────────────────────────────────────────

  private readLineViaInput(_prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      // textbox.readInput resolves once the user hits enter (or escape).
      this.inputBox.clearValue();
      this.inputBox.readInput((err: any, value: string | null) => {
        const next = this.pendingResolve;
        this.pendingResolve = null;
        if (err) {
          next?.('');
          return;
        }
        if (value == null) {
          next?.('');
          return;
        }
        // Trigger / overlay synchronously when the line begins with `/`
        // and registry has multiple matches. Implementation detail: we
        // just return the raw line — chatSession.readUserInput owns the
        // logic of dispatching to selectSlashCommand for picking.
        next?.(value);
      });
      if (!this.opts.noRender) this.screen.render();
    });
  }

  /** Render the slash-command floating list and resolve with picked name. */
  private async selectSlashViaOverlay(
    source: (input: string | undefined) => Promise<
      Array<{ name: string; value: string; description?: string }>
    >,
  ): Promise<string | null> {
    const items = await source(undefined);
    if (items.length === 0) return null;
    return new Promise((resolve) => {
      this.pendingSelectResolve = resolve;
      const overlay = this.blessed.list({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: '60%',
        height: '50%',
        label: ' commands ',
        border: { type: 'line' },
        style: {
          border: { fg: '#ff6b35' },
          selected: { bg: '#ff6b35', fg: 'black' },
        },
        keys: true,
        mouse: true,
        vi: true,
        items: items.map((it) =>
          it.description ? `${it.name.padEnd(18)} ${it.description}` : it.name,
        ),
      });
      this.overlays.push(overlay);

      const cleanup = () => {
        try {
          overlay.destroy();
        } catch {
          /* ignore */
        }
        this.overlays = this.overlays.filter((o) => o !== overlay);
        this.inputBox.focus();
        if (!this.opts.noRender) this.screen.render();
      };

      overlay.on('select', (_item: any, idx: number) => {
        const picked = items[idx]?.value ?? null;
        cleanup();
        const r = this.pendingSelectResolve;
        this.pendingSelectResolve = null;
        r?.(picked);
      });

      overlay.key(['escape', 'C-g'], () => {
        cleanup();
        const r = this.pendingSelectResolve;
        this.pendingSelectResolve = null;
        r?.(null);
      });

      overlay.focus();
      if (!this.opts.noRender) this.screen.render();
    });
  }

  // ─── Status line ────────────────────────────────────────────────

  /** Refresh status line using ChatSession-derived fields. */
  updateStatusLine(text: string): void {
    this.statusLine.setContent(text);
    if (!this.opts.noRender) this.screen.render();
  }

  /** Test seam: list overlays. */
  getOverlayCount(): number {
    return this.overlays.length;
  }

  /** Test seam: get filtered command labels via the command registry. */
  getFilteredCommandLabels(prefix: string): string[] {
    const reg = this.opts.sessionOpts.commandRegistry as CommandRegistry;
    const cmds = reg.filter(prefix);
    return cmds.map((c) => `${c.icon ?? ' '} /${c.name.padEnd(15)} ${c.description}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
