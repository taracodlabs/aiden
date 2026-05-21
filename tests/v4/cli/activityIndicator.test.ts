/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/activityIndicator.test.ts — Phase v4.1.4 Part 1.6.
 *
 * Coverage for the new `Display.activityIndicator()` API and the
 * `verbForActivity()` pure mapper.
 *
 * Contract:
 *   - TTY: indicator paints `▲ {verb}{dots}` immediately, ticks every
 *     400ms, surfaces `(Ns)` once N>=1.
 *   - Non-TTY: completely silent — no paint, no ticks, no erases.
 *   - pause(): erases line, stops tick; resume() re-paints + restarts.
 *   - stop(): terminal — refuses further pause/resume.
 *   - Elapsed time is wall-clock cumulative; preserved across pauses.
 *   - "▸▸ Ctrl+C cancel" hint folded into the line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { Display, verbForActivity } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeDisplay(opts: { tty?: boolean } = {}): {
  d: Display;
  chunks: string[];
} {
  const chunks: string[] = [];
  const out = new Writable({
    write(c, _e, cb) { chunks.push(c.toString()); cb(); },
  }) as Writable & { isTTY?: boolean; columns?: number };
  out.isTTY = opts.tty ?? true;
  out.columns = 80;
  const skin = new SkinEngine({ forceMono: true }); // deterministic
  return {
    d: new Display({ stdout: out as unknown as NodeJS.WriteStream, skin }),
    chunks,
  };
}

describe('verbForActivity (v4.1.4 Part 1.6)', () => {
  it('pre-tools phase → "thinking" regardless of toolName', () => {
    expect(verbForActivity(undefined, 'pre-tools')).toBe('thinking');
    expect(verbForActivity('web_search', 'pre-tools')).toBe('thinking');
  });

  it('post-all phase → "drafting" regardless of toolName', () => {
    expect(verbForActivity(undefined, 'post-all')).toBe('drafting');
    expect(verbForActivity('file_read', 'post-all')).toBe('drafting');
  });

  it('search-class tools → "searching"', () => {
    expect(verbForActivity('web_search')).toBe('searching');
    expect(verbForActivity('fetch_url')).toBe('searching');
    expect(verbForActivity('scrape_page')).toBe('searching');
  });

  it('read-class tools → "reading"', () => {
    expect(verbForActivity('file_read')).toBe('reading');
    expect(verbForActivity('file_list')).toBe('reading');
    expect(verbForActivity('get_thread')).toBe('reading');
    expect(verbForActivity('system_info')).toBe('reading');
  });

  it('write-class tools → "drafting"', () => {
    expect(verbForActivity('file_write')).toBe('drafting');
    expect(verbForActivity('file_patch')).toBe('drafting');
    expect(verbForActivity('memory_add')).toBe('thinking'); // no add-match in regex — falls through
    expect(verbForActivity('create_branch')).toBe('drafting');
  });

  it('shell/exec/launch tools → "analyzing"', () => {
    expect(verbForActivity('shell_exec')).toBe('analyzing');
    expect(verbForActivity('execute_code')).toBe('analyzing');
    expect(verbForActivity('app_launch')).toBe('analyzing');
  });

  it('unknown tool defaults to "thinking"', () => {
    expect(verbForActivity('weird_unknown_xyz')).toBe('thinking');
    expect(verbForActivity('')).toBe('thinking');
    expect(verbForActivity(undefined)).toBe('thinking');
  });

  it('priority order: search beats read for tool names containing both', () => {
    // Hypothetical "web_search_read" → search wins (higher priority).
    expect(verbForActivity('web_search_read')).toBe('searching');
  });
});

describe('Display.activityIndicator (v4.1.4 Part 1.6)', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('TTY: initial paint contains shimmer block + verb (Slice 11 — █ replaces ⌛)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const out = stripAnsi(chunks.join(''));
    // v4.8.0 Slice 11 — activity indicator's leading glyph cluster is
    // a 4-cell `█` segment sliding on a `─` track. Replaces the static
    // `⌛` hourglass (Slice 10) which itself replaced the brand triangle
    // (Slice 0). The triangle stays as the user-prompt + status-footer
    // identity glyph.
    expect(out).toContain('█');
    expect(out).toContain('─');
    expect(out).toContain('thinking');
    // Slice 11 regression sentinels.
    expect(out).not.toContain('⌛');
    expect(out).not.toContain('▓'); // legacy wave-bar glyphs
    expect(out).not.toContain('░');
    // Issue F: the Ctrl+C cancel hint was visually noisy on the
    // activity line and collided with planner-debug dim writes.
    // Dropped in Phase 3b'. Sentinel against regression.
    expect(out).not.toContain('▸▸ Ctrl+C cancel');
    expect(out).not.toContain('Ctrl+C');
    handle.stop();
  });

  it('TTY: no elapsed time on initial paint (< 1s)', () => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const initial = stripAnsi(chunks.join(''));
    // No `(0s)` flash.
    expect(initial).not.toMatch(/\(0s\)/);
    expect(initial).not.toMatch(/\(\ds\)/);
    handle.stop();
    nowSpy.mockRestore();
  });

  it('TTY: elapsed time appears once wall-clock >= 1s', () => {
    let now = 1_000_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    // Advance wall-clock + tick clock to 1.2s.
    now += 1200;
    vi.advanceTimersByTime(1200); // multiple ticks at 400ms cadence
    const out = stripAnsi(chunks.join(''));
    expect(out).toMatch(/\(1s\)/);
    handle.stop();
    nowSpy.mockRestore();
  });

  it('TTY: dot pulse cycles 0→1→2→3→0 at 250ms cadence (Issue G)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    // Phase 3b' Issue G: tick cadence is 250ms (was 400ms). 5 ticks
    // = 1.25s — at least one paint must show the "thinking..." state
    // (dotFrame=3) within that window.
    vi.advanceTimersByTime(250 * 5);
    const full = stripAnsi(chunks.join(''));
    expect(full).toMatch(/thinking\.\.\.\s/);
    handle.stop();
  });

  it('TTY: pulse cadence is 250ms (not 400ms) — Issue G sentinel', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const writesBefore = chunks.length;
    // Advance exactly 300ms — at 400ms cadence, NO tick fires; at
    // 250ms cadence, ONE tick fires. Counting writes proves the rate.
    vi.advanceTimersByTime(300);
    const writesAfter = chunks.length;
    expect(writesAfter - writesBefore).toBeGreaterThanOrEqual(1);
    handle.stop();
  });

  it('Non-TTY: zero writes — completely silent', () => {
    const { d, chunks } = makeDisplay({ tty: false });
    const handle = d.activityIndicator('thinking');
    expect(chunks.length).toBe(0);
    // Even after ticks would have fired, no writes.
    vi.advanceTimersByTime(2000);
    expect(chunks.length).toBe(0);
    handle.stop();
    expect(chunks.length).toBe(0);
  });

  it('pause() then resume() preserves cumulative elapsed time', () => {
    let now = 1_000_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    now += 2000; // 2s pass before pause
    handle.pause();
    expect(handle.isPaused()).toBe(true);
    now += 5000; // 5s pass while paused (would not count toward "running")
    handle.resume('drafting');
    expect(handle.isPaused()).toBe(false);
    // Tick once to repaint with elapsed time.
    vi.advanceTimersByTime(400);
    const full = stripAnsi(chunks.join(''));
    // Wall-clock since start = 7s. Test asserts the indicator surfaces
    // total wall-clock, not paused-time-subtracted.
    expect(full).toMatch(/\(7s\)/);
    expect(full).toContain('drafting');
    handle.stop();
    nowSpy.mockRestore();
  });

  it('pause() emits ANSI walk-up + line-erase (v4.1.5 Issue M)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0; // reset
    handle.pause();
    const after = chunks.join('');
    // v4.1.5 Part 1a Issue M: the indicator now OWNS one terminal row
    // with cursor parked on the row below. Pause walks up + erases
    // (no trailing newline — caller will write on this row next).
    // ANSI: \x1b[1A (up 1) + \x1b[2K (clear current line).
    expect(after).toContain('\x1b[1A\x1b[2K');
    handle.stop();
  });

  it('stop() is terminal — pause/resume become no-ops afterward', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    handle.stop();
    expect(handle.isStopped()).toBe(true);
    chunks.length = 0;
    handle.pause();
    handle.resume('drafting');
    expect(chunks.length).toBe(0); // no further writes
  });

  it('setVerb() swaps verb without pausing', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.setVerb('searching');
    // Next tick reflects the new verb.
    vi.advanceTimersByTime(400);
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('searching');
    expect(full).not.toContain('thinking');
    handle.stop();
  });

  it('stop() walks up + erases the indicator row (v4.1.5 Issue M)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.stop();
    expect(chunks.join('')).toContain('\x1b[1A\x1b[2K');
  });

  it('initial paint ends with newline (v4.1.5 Issue M flush gate)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const initial = chunks.join('');
    // First write must end with `\n` so Windows ConPTY flushes the
    // buffered indicator to the terminal. The whole Issue M fix
    // hinges on this trailing newline.
    expect(initial.endsWith('\n')).toBe(true);
    handle.stop();
  });

  it('tick writes walk up + erase + repaint + newline (v4.1.5 Issue M)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    // Advance one tick (250ms cadence).
    vi.advanceTimersByTime(250);
    const tickWrite = chunks.join('');
    // Tick must include the walk-up + erase sequence (otherwise it
    // would paint a second indicator below the first instead of
    // overwriting). And it must end with `\n` for buffer flush.
    expect(tickWrite).toContain('\x1b[1A\x1b[2K');
    expect(tickWrite.endsWith('\n')).toBe(true);
    handle.stop();
  });

  // ── v4.8.0 Slice 11 — sliding-block shimmer coverage ──────────────────
  //
  // The shimmer is a single-row 10-cell `█`/`─` track that replaces
  // the prior 2-row (verb + wave-bar) layout. A 4-cell `█` segment
  // slides right by 1 cell per tick, wrapping at the right edge.
  // Same 250ms cadence as the verb dot pulse — one timer drives
  // both motion cues.

  it('shimmer default ON: initial paint emits 1 row with █/─ track (Slice 11)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const initial = stripAnsi(chunks.join(''));
    expect(initial).toContain('thinking');
    // v4.8.0 Slice 11 — shimmer uses `█` (U+2588 FULL BLOCK) on a `─`
    // (U+2500 BOX DRAWING LIGHT HORIZONTAL) track. Both CP437-safe.
    // At frame 0 the leading 4-cell block sits at positions 0..3.
    expect(initial).toContain('████──────');
    // Regression sentinels: legacy wave-bar + glyph palettes must NOT appear.
    expect(initial).not.toContain('▓');
    expect(initial).not.toContain('░');
    expect(initial).not.toContain('▰');
    expect(initial).not.toContain('▱');
    expect(initial).not.toContain('⌛');
    handle.stop();
  });

  it('shimmer: 4-cell █ block slides across 10 cells (Slice 11)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    vi.advanceTimersByTime(500); // 2 ticks at 250ms
    const tick2 = stripAnsi(chunks.join(''));
    // shimmerFrame=2 → block at cells 2,3,4,5.
    expect(tick2).toMatch(/──████────/);
    handle.stop();
  });

  it('shimmer: wraps at right edge (frame 8 → block straddles)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    vi.advanceTimersByTime(250 * 8); // shimmerFrame=8
    const tick8 = stripAnsi(chunks.join(''));
    // Block straddles the wrap: cells 0,1 filled at the head, cells 8,9 filled at the tail.
    expect(tick8).toMatch(/██──────██/);
    handle.stop();
  });

  it('shimmer opt-out: { waveBar: false } produces bare-verb paint', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking', { waveBar: false });
    const initial = stripAnsi(chunks.join(''));
    expect(initial).toContain('thinking');
    // Shimmer glyphs must NOT appear when explicitly opted out.
    expect(initial).not.toContain('█');
    // Legacy wave-bar glyphs must not appear either.
    expect(initial).not.toContain('▓');
    expect(initial).not.toContain('░');
    handle.stop();
  });

  it('Slice 2 hotfix #4: stop() without prior pause walks up TWO rows', () => {
    // v4.8.1 Slice 2 hotfix #4 — stop() consumes BOTH the indicator
    // row AND the leading blank above it when the indicator never
    // moved (no pause/resume). This keeps the post-stop layout at
    // exactly 1 blank between user input and `▎ Aiden`.
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.stop();
    const after = chunks.join('');
    const occurrences = (after.match(/\x1b\[1A\x1b\[2K/g) ?? []).length;
    expect(occurrences).toBe(2);
  });

  it('Slice 2 hotfix #4: stop() AFTER pause walks up only ONE row', () => {
    // After a pause/resume cycle the leading blank is far above the
    // current indicator row — consuming it would erase tool-row
    // content. Stop falls back to single-row erase.
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    handle.pause();
    handle.resume();
    chunks.length = 0;
    handle.stop();
    const after = chunks.join('');
    const occurrences = (after.match(/\x1b\[1A\x1b\[2K/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('v4.1.6 Polish 1: erase output ends with newline (breathing-space gutter)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.stop();
    const after = chunks.join('');
    expect(after.endsWith('\n')).toBe(true);
  });

  it('Slice 2 hotfix #4: opt-out (waveBar: false) stop erase ends with newline + 2 walk-ups', () => {
    // Same Slice 2 hotfix #4 behaviour applies to the opt-out path:
    // stop() without prior pause consumes the leading blank.
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking', { waveBar: false });
    chunks.length = 0;
    handle.stop();
    const after = chunks.join('');
    expect(after.endsWith('\n')).toBe(true);
    const occurrences = (after.match(/\x1b\[1A\x1b\[2K/g) ?? []).length;
    expect(occurrences).toBe(2);
  });

  it('v4.1.6 Polish 1: pause() erase also includes the breathing gutter', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.pause();
    const after = chunks.join('');
    expect(after.endsWith('\n')).toBe(true);
    handle.stop();
  });

  it('shimmer setVerb mutates verb row, shimmer continues animating', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.setVerb('refreshing memory');
    vi.advanceTimersByTime(250);
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('refreshing memory');
    // Shimmer still present in the same tick output (Slice 11 glyphs).
    expect(full).toMatch(/█{1,4}/);
    handle.stop();
  });

  it('Slice 2 hotfix #4: initial paint prepends a blank `\\n` for breathing space', () => {
    // v4.8.1 Slice 2 hotfix #4 — leading `\n` restored after the
    // chatSession dim rule was removed in hotfix #3. Without it the
    // indicator butts flush against the user-prompt row. The matching
    // stop() walks up 2 rows so the gap is consumed cleanly when
    // `▎ Aiden` takes over.
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const initial = chunks.join('');
    expect(initial.startsWith('\n')).toBe(true);
    expect(initial.endsWith('\n')).toBe(true);
    handle.stop();
  });

  it('initial paint includes brand-paint shimmer block (Slice 11 — █)', () => {
    // v4.1.4 Phase 3b' Issue F: the muted "▸▸ Ctrl+C cancel" hint was
    // dropped from the line, so the brand-orange paint on initial
    // render (elapsed < 1s) is the leading shimmer block. v4.8.0
    // Slice 11 swapped that block from ⌛ → 4-cell sliding `█`.
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) { chunks.push(c.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY = true;
    out.columns = 80;
    const skin = new SkinEngine({ forceMono: false });
    const d = new Display({ stdout: out as unknown as NodeJS.WriteStream, skin });
    const handle = d.activityIndicator('thinking');
    const initial = chunks.join('');
    // Brand orange = #FF6B35 = rgb 255,107,53.
    expect(initial).toContain('\x1b[38;2;255;107;53m');
    expect(initial).toContain('█');
    expect(initial).not.toContain('⌛');
    handle.stop();
  });
});
