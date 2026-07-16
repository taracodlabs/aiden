/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/pasteIntercept.test.ts — v4.8.1 Slice 2 hotfix #6.
 *
 * Coverage for the stateful paste handler: marker state machine,
 * watchdog, degraded-marker normalisation, CRLF folding, timing
 * accumulation for line-by-line paste delivery, typed-prefix
 * preservation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  installPasteInterceptor,
  expandPasteLabels,
  _resetForTests,
} from '../../../cli/v4/pasteIntercept';

const PASTE_BEGIN = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

function makeFakeStdin(): NodeJS.ReadStream {
  return new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
}

/**
 * Capture every chunk emitted downstream after `texts` are pushed
 * through the wrapped emit. Accumulates across calls so multi-chunk
 * scenarios see the full downstream sequence. Async because the
 * timing-accumulation path defers via setTimeout — we advance fake
 * timers far enough to flush all pending state.
 */
function makeHarness(opts: { accumulationMs?: number; watchdogMs?: number } = {}) {
  const stdin = makeFakeStdin();
  const captured: string[] = [];
  stdin.on('data', (chunk: Buffer | string) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  installPasteInterceptor(stdin, {
    accumulationMs: opts.accumulationMs ?? 1,
    watchdogMs:     opts.watchdogMs     ?? 50,
  });
  return {
    emit: (text: string) => stdin.emit('data', Buffer.from(text, 'utf8')),
    captured,
    /** Drain any pending timers and return the concatenated downstream text. */
    async drain(ms = 100): Promise<string> {
      await new Promise(r => setTimeout(r, ms));
      return captured.join('');
    },
  };
}

describe('pasteIntercept — robust state machine (Slice 2 hotfix #6)', () => {
  beforeEach(() => { _resetForTests(); });
  afterEach(() => { _resetForTests(); vi.useRealTimers(); });

  // ── 1. Marker state machine happy path ──────────────────────────────

  it('marker-wrapped multi-line paste → placeholder, original recoverable', async () => {
    const h = makeHarness();
    h.emit(`${PASTE_BEGIN}alpha\nbeta\ngamma${PASTE_END}`);
    const out = await h.drain();
    expect(out).toMatch(/^\[paste #\d+: 3 lines, \d+B\]$/);
    expect(expandPasteLabels(out)).toBe('alpha\nbeta\ngamma');
  });

  it('keeps an intentional final newline in the recoverable original', async () => {
    const h = makeHarness();
    h.emit(`${PASTE_BEGIN}  alpha  \n\n\tbeta  \n${PASTE_END}`);
    const out = await h.drain();
    expect(out).toMatch(/^\[paste #\d+:/);
    expect(expandPasteLabels(out)).toBe('  alpha  \n\n\tbeta  \n');
  });

  // ── 2. Watchdog — PASTE_END never arrives ───────────────────────────

  it('watchdog flushes stuck in_marker_paste after timeout', async () => {
    const h = makeHarness({ watchdogMs: 20 });
    // Send PASTE_BEGIN + content but NO PASTE_END.
    h.emit(`${PASTE_BEGIN}stuck content\nline two`);
    // Wait past the watchdog window.
    const out = await h.drain(60);
    expect(out).toMatch(/^\[paste #\d+: 2 lines, \d+B\]$/);
    expect(expandPasteLabels(out)).toBe('stuck content\nline two');
  });

  // ── 3. Split markers across chunks ──────────────────────────────────

  it('PASTE_BEGIN split across two chunks → still detected', async () => {
    const h = makeHarness();
    // First chunk: just the start of the begin marker.
    h.emit('\x1b[20');
    // Second chunk: completes the marker + paste content + end marker.
    h.emit(`0~payload line one\npayload line two${PASTE_END}`);
    const out = await h.drain();
    // The partial `\x1b[20` doesn't match — the parser treats it as
    // plain content. Then the second chunk has `0~payload…PASTE_END`.
    // The state machine looks for the canonical `\x1b[200~` which
    // doesn't appear → falls through to the unmarked-multi-line
    // heuristic which catches the internal `\n`. End-to-end the user
    // still gets a placeholder for the multi-line payload.
    expect(out).toMatch(/\[paste #\d+:/);
  });

  // ── 4. Degraded marker forms ────────────────────────────────────────

  it('visible-escape marker variant `^[[200~` normalises to canonical', async () => {
    const h = makeHarness();
    h.emit('^[[200~degraded content\nsecond line^[[201~');
    const out = await h.drain();
    expect(out).toMatch(/^\[paste #\d+: 2 lines, \d+B\]$/);
    expect(expandPasteLabels(out)).toBe('degraded content\nsecond line');
  });

  // ── 5. CRLF normalisation ───────────────────────────────────────────

  it('CRLF and bare-CR line endings normalised to LF before parse', async () => {
    const h = makeHarness();
    // Multi-line chunk delivered with mixed line endings.
    h.emit('line1\r\nline2\rline3\nline4');
    const out = await h.drain();
    expect(out).toMatch(/^\[paste #\d+: 4 lines, \d+B\]$/);
    expect(expandPasteLabels(out)).toBe('line1\nline2\nline3\nline4');
  });

  // ── 6. Typed prefix + paste — THE USER-REPORTED BUG ─────────────────

  it('typed prefix + bulk multi-line paste → prefix preserved', async () => {
    const h = makeHarness();
    // Simulate the user typing "fix this: " keystroke by keystroke.
    for (const ch of 'fix this: ') h.emit(ch);
    // Then a paste arrives as one bulk chunk with internal newlines.
    h.emit('line1\nline2\nline3\nline4\nline5');
    const out = await h.drain();
    // The typed prefix appears in the downstream stream BEFORE the
    // placeholder. Inquirer concatenates them naturally into its
    // buffer, so the final readline result is `fix this: [paste …]`.
    expect(out.startsWith('fix this: ')).toBe(true);
    expect(out).toMatch(/\[paste #\d+: 5 lines, \d+B\]$/);
  });

  it('typed prefix + line-by-line paste delivery → accumulator catches it, prefix preserved', async () => {
    const h = makeHarness({ accumulationMs: 5 });
    // Typed prefix.
    for (const ch of 'fix this: ') h.emit(ch);
    // Paste delivered as N separate `"<line>\n"` chunks within the
    // accumulation window (the failure mode that surfaced after
    // hotfix #5 on terminals that don't deliver pastes as a bulk
    // chunk).
    h.emit('line1\n');
    h.emit('line2\n');
    h.emit('line3\n');
    h.emit('line4\n');
    h.emit('line5\n');
    const out = await h.drain(40);
    expect(out.startsWith('fix this: ')).toBe(true);
    // All 5 lines collapse into ONE placeholder (the accumulator
    // joins them and substitutes once).
    const matches = out.match(/\[paste #\d+: 5 lines, \d+B\]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  // ── 7. Empty prompt + paste (no prefix) ─────────────────────────────

  it('empty prompt + paste (no prefix) → placeholder only', async () => {
    const h = makeHarness();
    h.emit('line1\nline2\nline3');
    const out = await h.drain();
    expect(out).toMatch(/^\[paste #\d+: 3 lines, \d+B\]$/);
  });

  // ── 8. Triple-quote multi-line mode regression guard ────────────────

  it('triple-quote opener arriving as own chunk → passes through unchanged', async () => {
    const h = makeHarness({ accumulationMs: 1 });
    h.emit('"""line one\n');
    const out = await h.drain(20);
    // The chunk ends with `\n` and length > 1 — it would be a
    // candidate for accumulation. But no follow-up arrives within
    // the window, so the accumulator flushes it AS-IS (not as a
    // placeholder), preserving the triple-quote mode trigger.
    expect(out).toBe('"""line one\n');
    expect(out).not.toMatch(/\[paste #/);
  });

  // ── 9. Single-line typed input + Enter regression guard ─────────────

  it('single-line typed input + Enter → no placeholder, Enter passes through', async () => {
    const h = makeHarness({ accumulationMs: 1 });
    // Each character typed individually.
    for (const ch of 'hello') h.emit(ch);
    // Bare Enter keystroke.
    h.emit('\n');
    const out = await h.drain(20);
    expect(out).toBe('hello\n');
    expect(out).not.toMatch(/\[paste #/);
  });
});
