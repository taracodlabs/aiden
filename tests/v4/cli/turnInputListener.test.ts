/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 2a — the during-turn keypress source: the pure key
 * handler + the attach/detach lifecycle (raw-mode set + CLEAN restore).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  makeKeypressHandler,
  attachTurnInputListener,
  type RawStdinLike,
} from '../../../cli/v4/turnInputListener';

function cbs() {
  return { onLine: vi.fn(), onEscape: vi.fn(), onCtrlC: vi.fn() };
}
const key = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });
const PASTE_BEGIN = '\x1b[200~';
const PASTE_END = '\x1b[201~';

describe('makeKeypressHandler — bracketed paste is stripped, not leaked', () => {
  it('paste-marker keypresses are skipped (no literal [200~ / [201~ in the line)', () => {
    const cb = cbs();
    const h = makeKeypressHandler(cb);
    h(PASTE_BEGIN, { sequence: PASTE_BEGIN });        // begin marker as a keypress seq
    for (const ch of 'pasted') h(ch, key(ch));
    h(PASTE_END, { sequence: PASTE_END });            // end marker
    h(undefined, key('return'));
    expect(cb.onLine).toHaveBeenCalledWith('pasted');
  });

  it('a multi-char paste BURST is accepted, embedded markers stripped', () => {
    const cb = cbs();
    const h = makeKeypressHandler(cb);
    // readline can deliver the whole paste as one str incl. the markers.
    h(`${PASTE_BEGIN}npm run build${PASTE_END}`, { sequence: `${PASTE_BEGIN}npm run build${PASTE_END}` });
    h(undefined, key('return'));
    expect(cb.onLine).toHaveBeenCalledWith('npm run build');
  });

  it('a newline INSIDE a paste is literal text, not a submit', () => {
    const cb = cbs();
    const h = makeKeypressHandler(cb);
    h(PASTE_BEGIN, { sequence: PASTE_BEGIN });
    for (const ch of 'line1') h(ch, key(ch));
    h('\r', key('return'));                            // Enter during paste → literal \n
    for (const ch of 'line2') h(ch, key(ch));
    expect(cb.onLine).not.toHaveBeenCalled();          // did NOT submit mid-paste
    h(PASTE_END, { sequence: PASTE_END });
    h(undefined, key('return'));                       // real Enter submits
    expect(cb.onLine).toHaveBeenCalledWith('line1\nline2');
  });

  it('a CSI sequence (arrow) is NOT mistaken for a cancel; only a BARE esc cancels', () => {
    const cb = cbs();
    const h = makeKeypressHandler(cb);
    h(undefined, { name: 'escape', sequence: '\x1b[A' });  // arrow-up (CSI) — not cancel
    expect(cb.onEscape).not.toHaveBeenCalled();
    h(undefined, { name: 'escape', sequence: '\x1b' });    // bare ESC — cancel
    expect(cb.onEscape).toHaveBeenCalledOnce();
  });
});

describe('makeKeypressHandler — line buffer + key routing', () => {
  it('accumulates printable chars, Enter flushes the line', () => {
    const cb = cbs();
    const h = makeKeypressHandler(cb);
    for (const ch of 'hi there') h(ch, key(ch === ' ' ? 'space' : ch));
    h(undefined, key('return'));
    expect(cb.onLine).toHaveBeenCalledWith('hi there');
    // buffer resets after Enter.
    h('x', key('x')); h(undefined, key('return'));
    expect(cb.onLine).toHaveBeenLastCalledWith('x');
  });

  it('esc fires onEscape and DISCARDS the buffer', () => {
    const cb = cbs();
    const h = makeKeypressHandler(cb);
    h('a', key('a')); h('b', key('b'));
    h(undefined, key('escape'));
    expect(cb.onEscape).toHaveBeenCalledOnce();
    h(undefined, key('return'));
    expect(cb.onLine).toHaveBeenCalledWith('');   // buffer was cleared by esc
  });

  it('Ctrl+C routes to onCtrlC (raw mode suppresses the kernel signal)', () => {
    const cb = cbs();
    const h = makeKeypressHandler(cb);
    h('c', key('c', { ctrl: true }));
    expect(cb.onCtrlC).toHaveBeenCalledOnce();
    expect(cb.onLine).not.toHaveBeenCalled();
  });

  it('backspace edits the buffer; nav / modified keys are ignored', () => {
    const cb = cbs();
    const h = makeKeypressHandler(cb);
    for (const ch of 'abc') h(ch, key(ch));
    h(undefined, key('backspace'));               // -> 'ab'
    h(undefined, key('up'));                       // ignored
    h(undefined, key('left'));                     // ignored
    h('z', key('z', { meta: true }));              // modified — ignored
    h(undefined, key('return'));
    expect(cb.onLine).toHaveBeenCalledWith('ab');
  });
});

describe('makeKeypressHandler — onBufferChange fires per keystroke (Slice 2c)', () => {
  it('fires once per printable char with the CURRENT buffer', () => {
    const cb = { ...cbs(), onBufferChange: vi.fn() };
    const h = makeKeypressHandler(cb);
    for (const ch of 'hey') h(ch, key(ch));
    expect(cb.onBufferChange.mock.calls.map((c) => c[0])).toEqual(['h', 'he', 'hey']);
  });

  it('fires on backspace with the shortened buffer', () => {
    const cb = { ...cbs(), onBufferChange: vi.fn() };
    const h = makeKeypressHandler(cb);
    for (const ch of 'ab') h(ch, key(ch));
    cb.onBufferChange.mockClear();
    h(undefined, key('backspace'));
    expect(cb.onBufferChange).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('fires with the empty buffer after Enter submits (reset → clears composer)', () => {
    const cb = { ...cbs(), onBufferChange: vi.fn() };
    const h = makeKeypressHandler(cb);
    for (const ch of 'go') h(ch, key(ch));
    cb.onBufferChange.mockClear();
    h(undefined, key('return'));
    expect(cb.onLine).toHaveBeenCalledWith('go');
    expect(cb.onBufferChange).toHaveBeenCalledExactlyOnceWith('');
  });

  it('fires with the empty buffer after esc cancels', () => {
    const cb = { ...cbs(), onBufferChange: vi.fn() };
    const h = makeKeypressHandler(cb);
    for (const ch of 'x') h(ch, key(ch));
    cb.onBufferChange.mockClear();
    h(undefined, key('escape', { sequence: '\x1b' }));
    expect(cb.onBufferChange).toHaveBeenCalledExactlyOnceWith('');
  });

  it('does NOT fire for a nav key that leaves the buffer unchanged', () => {
    const cb = { ...cbs(), onBufferChange: vi.fn() };
    const h = makeKeypressHandler(cb);
    h('a', key('a'));
    cb.onBufferChange.mockClear();
    h(undefined, key('up'));      // nav — buffer unchanged
    h(undefined, key('left'));    // nav — buffer unchanged
    expect(cb.onBufferChange).not.toHaveBeenCalled();
  });

  it('fires with the paste-stripped buffer for a paste burst', () => {
    const cb = { ...cbs(), onBufferChange: vi.fn() };
    const h = makeKeypressHandler(cb);
    h(`${PASTE_BEGIN}pasted${PASTE_END}`, { sequence: `${PASTE_BEGIN}pasted${PASTE_END}` });
    expect(cb.onBufferChange).toHaveBeenLastCalledWith('pasted');
  });
});

// ── attach/detach lifecycle with a fake stdin ────────────────────────────────

function fakeStdin(over: Partial<RawStdinLike> = {}): RawStdinLike & { rawState: boolean; listeners: number } {
  const state = { rawState: false, listeners: 0 };
  const stdin: any = {
    isTTY: true,
    get isRaw() { return state.rawState; },
    setRawMode: vi.fn((m: boolean) => { state.rawState = m; }),
    on: vi.fn(() => { state.listeners += 1; }),
    removeListener: vi.fn(() => { state.listeners -= 1; }),
    ...over,
  };
  Object.defineProperty(stdin, 'rawState', { get: () => state.rawState });
  Object.defineProperty(stdin, 'listeners', { get: () => state.listeners });
  return stdin;
}

describe('attachTurnInputListener — lifecycle', () => {
  it('non-TTY stdin → no-op (never touches raw mode)', () => {
    const stdin = fakeStdin({ isTTY: false });
    const detach = attachTurnInputListener({ cb: cbs(), stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(() => detach()).not.toThrow();
  });

  it('TTY: sets raw mode + attaches, detach restores prior mode + removes listener', () => {
    const stdin = fakeStdin();                     // starts non-raw
    const emit = vi.fn();
    const detach = attachTurnInputListener({ cb: cbs(), stdin, emitKeypressEvents: emit, onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    expect(emit).toHaveBeenCalledWith(stdin);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.rawState).toBe(true);
    expect(stdin.listeners).toBe(1);
    detach();
    expect(stdin.rawState).toBe(false);            // restored to prior (non-raw)
    expect(stdin.listeners).toBe(0);
  });

  it('detach is idempotent; a process-exit hook is registered + removed', () => {
    const stdin = fakeStdin();
    let exitFn: (() => void) | null = null;
    const onExit = vi.fn((fn: () => void) => { exitFn = fn; });
    const offExit = vi.fn();
    const detach = attachTurnInputListener({ cb: cbs(), stdin, emitKeypressEvents: vi.fn(), onProcessExit: onExit, offProcessExit: offExit });
    expect(onExit).toHaveBeenCalledOnce();
    // the exit hook restores raw mode (crash safety).
    stdin.setRawMode!(true);
    exitFn!();
    expect(stdin.rawState).toBe(false);
    detach();
    detach();                                      // idempotent
    expect(offExit).toHaveBeenCalledOnce();
    expect(stdin.removeListener).toHaveBeenCalledTimes(1);
  });

  it('preserves a stdin that was ALREADY in raw mode', () => {
    const stdin = fakeStdin();
    stdin.setRawMode!(true);                        // already raw before attach
    const detach = attachTurnInputListener({ cb: cbs(), stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    detach();
    expect(stdin.rawState).toBe(true);             // left as it found it (raw)
  });
});
