/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/turnInputListener.ts — v4.12.1 Pillar 4 Slice 2a.
 *
 * The during-turn keypress SOURCE — the load-bearing new piece. While a turn
 * runs, the prompt is unmounted (both renderers), so stdin is free. This
 * attaches a raw-mode keypress listener at turn-start, feeds a line buffer,
 * and detaches CLEANLY at turn-end (and on process exit) so the terminal is
 * never left in raw mode. It is renderer-agnostic — frame and legacy both use
 * it, feeding the one DuringTurnInput controller.
 *
 * ★ Ctrl+C caveat: raw mode disables the kernel's SIGINT generation, so Ctrl+C
 * arrives here as a keypress instead of a signal. The handler routes it to
 * `onCtrlC` so chatSession's existing two-press interrupt/force-quit logic is
 * preserved exactly. `esc` is the single-press cancel (keeps the queue).
 *
 * The keypress HANDLER is pure (testable with synthetic key events); the
 * attach/detach lifecycle degrades to a no-op when stdin is not a TTY (piped
 * input, CI) so it can never corrupt a non-interactive terminal.
 */

export interface TurnKey {
  name?:     string;
  ctrl?:     boolean;
  meta?:     boolean;
  sequence?: string;
}

export interface TurnInputCallbacks {
  /** Enter pressed — the accumulated line (may be empty). */
  onLine:   (text: string) => void;
  /** esc pressed — single-press turn cancel (buffer is discarded). */
  onEscape: () => void;
  /** Ctrl+C pressed — route to the existing SIGINT two-press logic. */
  onCtrlC:  () => void;
}

/** Non-text keys that must never land in the line buffer. */
const NAV_KEYS = new Set([
  'up', 'down', 'left', 'right', 'tab', 'pageup', 'pagedown', 'home', 'end',
  'delete', 'insert', 'f1', 'f2', 'f3', 'f4', 'escape', 'return', 'enter', 'backspace',
]);

/**
 * Build the keypress handler over a private line buffer. Pure — no I/O; drive
 * it with synthetic `(str, key)` in tests exactly as `readline` emits.
 */
export function makeKeypressHandler(cb: TurnInputCallbacks): (str: string | undefined, key: TurnKey) => void {
  let buffer = '';
  return (str, key) => {
    const k = key ?? {};
    if (k.ctrl && k.name === 'c') { buffer = ''; cb.onCtrlC(); return; }
    if (k.name === 'escape')       { buffer = ''; cb.onEscape(); return; }
    if (k.name === 'return' || k.name === 'enter') {
      const line = buffer; buffer = ''; cb.onLine(line); return;
    }
    if (k.name === 'backspace')    { buffer = buffer.slice(0, -1); return; }
    // Ignore every other control / navigation / modified key.
    if (k.ctrl || k.meta) return;
    if (k.name && NAV_KEYS.has(k.name)) return;
    // Accept a single printable character.
    if (typeof str === 'string' && str.length === 1 && str >= ' ' && str !== '\x7f') {
      buffer += str;
    }
  };
}

/** A stdin-like stream (subset used here — real process.stdin or a fake). */
export interface RawStdinLike {
  isTTY?:  boolean;
  isRaw?:  boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'keypress', h: (str: string | undefined, key: TurnKey) => void): unknown;
  removeListener(event: 'keypress', h: (str: string | undefined, key: TurnKey) => void): unknown;
}

export interface AttachOptions {
  cb:     TurnInputCallbacks;
  /** Defaults to process.stdin. */
  stdin?: RawStdinLike;
  /** Injected for tests: emitKeypressEvents + a process-exit registrar. */
  emitKeypressEvents?: (stdin: RawStdinLike) => void;
  onProcessExit?:      (fn: () => void) => void;
  offProcessExit?:     (fn: () => void) => void;
}

/**
 * Attach the during-turn listener; returns an idempotent `detach()`. On a
 * non-TTY stdin it's a no-op (input stays blocked, today's behaviour) — this
 * guards CI / piped input from a stuck raw mode. `detach()` restores the
 * prior raw-mode state and removes the listener; a process-exit hook restores
 * raw mode even if `detach()` never runs (crash safety).
 */
export function attachTurnInputListener(opts: AttachOptions): () => void {
  const stdin = (opts.stdin ?? (process.stdin as unknown as RawStdinLike));
  if (!stdin || !stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return () => { /* no-op: not an interactive TTY */ };
  }
  const handler = makeKeypressHandler(opts.cb);
  const wasRaw = stdin.isRaw === true;
  try {
    (opts.emitKeypressEvents ?? defaultEmitKeypress)(stdin);
    stdin.setRawMode(true);
    stdin.on('keypress', handler);
  } catch {
    // Setup failed — best-effort restore, then behave as a no-op.
    try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
    return () => {};
  }
  const restore = (): void => { try { stdin.setRawMode!(wasRaw); } catch { /* ignore */ } };
  const onExit = () => restore();
  (opts.onProcessExit ?? ((fn) => process.once('exit', fn)))(onExit);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    try { stdin.removeListener('keypress', handler); } catch { /* ignore */ }
    restore();
    try { (opts.offProcessExit ?? ((fn) => process.removeListener('exit', fn)))(onExit); } catch { /* ignore */ }
  };
}

function defaultEmitKeypress(stdin: RawStdinLike): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const readline = require('node:readline') as typeof import('node:readline');
  readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadableStream);
}
