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

import { PASTE_BEGIN, PASTE_END, stripAllPasteMarkers } from './bracketedPaste';

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
  /**
   * v4.12.1 Slice 2c — fired on EVERY buffer change (each keystroke,
   * backspace, paste, and the reset to '' after submit/cancel) with the
   * current buffer, so the live composer can repaint what the user typed.
   */
  onBufferChange?: (buffer: string) => void;
}

/** Non-text keys that must never land in the line buffer. */
const NAV_KEYS = new Set([
  'up', 'down', 'left', 'right', 'tab', 'pageup', 'pagedown', 'home', 'end',
  'delete', 'insert', 'f1', 'f2', 'f3', 'f4', 'escape', 'return', 'enter', 'backspace',
]);

/**
 * Build the keypress handler over a private line buffer. Pure — no I/O; drive
 * it with synthetic `(str, key)` in tests exactly as `readline` emits.
 *
 * v4.12.1 — bracketed-paste safe. When paste mode is on, the terminal wraps a
 * paste in `\x1b[200~`…`\x1b[201~`. Those markers must never leak into the
 * buffer (the literal `[200~` bug) nor be mis-read as a bare ESC (which would
 * cancel the turn). We: (1) skip paste-marker keypresses + set a `pasting`
 * flag; (2) only treat `escape` as cancel for a BARE ESC (`\x1b`), not a CSI
 * like `\x1b[200~` or an arrow; (3) accept multi-char paste bursts, stripping
 * any embedded markers + control chars; (4) while pasting, a newline is
 * literal text, not a submit.
 */
export function makeKeypressHandler(cb: TurnInputCallbacks): (str: string | undefined, key: TurnKey) => void {
  let buffer = '';
  let pasting = false;
  // Fire onBufferChange only when the buffer actually changed (so a nav key
  // never triggers a needless composer repaint).
  const notify = (prev: string): void => { if (buffer !== prev) cb.onBufferChange?.(buffer); };
  return (str, key) => {
    const k = key ?? {};
    const seq = k.sequence ?? '';
    const prev = buffer;
    // ── bracketed-paste markers — never keys; toggle the paste state ────────
    if (seq === PASTE_BEGIN || k.name === 'paste-start') { pasting = true;  return; }
    if (seq === PASTE_END   || k.name === 'paste-end')   { pasting = false; return; }

    if (k.ctrl && k.name === 'c') { buffer = ''; pasting = false; cb.onCtrlC(); notify(prev); return; }
    // Only a BARE ESC cancels — a CSI sequence (paste marker, arrow) does not.
    if (k.name === 'escape' && (seq === '\x1b' || seq === '')) { buffer = ''; pasting = false; cb.onEscape(); notify(prev); return; }
    if (k.name === 'return' || k.name === 'enter') {
      if (pasting) { buffer += '\n'; notify(prev); return; }   // newline inside a paste is literal
      const line = stripAllPasteMarkers(buffer); buffer = ''; cb.onLine(line); notify(prev); return;
    }
    if (k.name === 'backspace')    { buffer = buffer.slice(0, -1); notify(prev); return; }
    // Ignore control / navigation / modified keys (but NOT a paste burst,
    // which has no key.name and a multi-char str).
    if ((k.ctrl || k.meta) && !(typeof str === 'string' && str.length > 1)) return;
    if (k.name && NAV_KEYS.has(k.name)) return;
    // Printable content — a single char OR a paste burst. Strip any embedded
    // paste markers, drop control chars, keep the rest (incl. spaces/newlines).
    if (typeof str === 'string' && str.length > 0) {
      // eslint-disable-next-line no-control-regex
      const clean = stripAllPasteMarkers(str).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      if (clean.length > 0) buffer += clean;
    }
    notify(prev);
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
