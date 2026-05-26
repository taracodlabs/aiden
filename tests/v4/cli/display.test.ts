import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  Display,
  countNewlines,
  splitAtUnclosedBold,
  isPreFramedLine,
  TRAIL_HIDE_TOOLS,
  makeNoOpToolRowHandle,
} from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

// Strip ANSI escape sequences so assertions stay terminal-agnostic.
function stripAnsi(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[A-Za-z]/g,
    '',
  );
}

describe('SkinEngine', () => {
  let engine: SkinEngine;

  beforeEach(() => {
    engine = new SkinEngine({ forceMono: false });
  });

  it('exposes the bundled default skin', () => {
    expect(engine.getActive().name).toBe('default');
    expect(engine.listSkins()).toEqual(
      expect.arrayContaining(['default', 'light', 'monochrome']),
    );
  });

  it('applyColors wraps text with ANSI for the default skin', () => {
    const out = engine.applyColors('hi', 'brand');
    expect(out).not.toBe('hi'); // ANSI codes added
    expect(stripAnsi(out)).toBe('hi');
  });

  it('switching to monochrome strips colour', () => {
    engine.setActive('monochrome');
    expect(engine.applyColors('hi', 'brand')).toBe('hi');
  });

  it('switching skins changes colour bytes', () => {
    const a = engine.applyColors('x', 'brand');
    engine.setActive('light');
    const b = engine.applyColors('x', 'brand');
    expect(a).not.toEqual(b);
  });

  it('forceMono disables colour entirely', () => {
    const mono = new SkinEngine({ forceMono: true });
    expect(mono.applyColors('hi', 'brand')).toBe('hi');
  });

  it('unknown skin name keeps the active skin and reports via onError', () => {
    const errors: string[] = [];
    const e = new SkinEngine({ onError: (m) => errors.push(m) });
    e.setActive('does-not-exist');
    expect(e.getActive().name).toBe('default');
    expect(errors[0]).toMatch(/unknown skin/i);
  });

  it('loadSkin reads custom yaml from skinsDir', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skin-'));
    await fs.writeFile(
      path.join(tmp, 'neon.yaml'),
      'description: neon\ncolors:\n  brand: [255, 0, 255]\n',
    );
    const e = new SkinEngine({ skinsDir: tmp });
    const s = await e.loadSkin('neon');
    expect(s.name).toBe('neon');
    expect(s.colors.brand).toEqual([255, 0, 255]);
  });

  it('loadSkin missing file falls back to default + onError', async () => {
    const errors: string[] = [];
    const e = new SkinEngine({
      skinsDir: path.join(os.tmpdir(), 'aiden-no-such-dir'),
      onError: (m) => errors.push(m),
    });
    const s = await e.loadSkin('ghost');
    expect(s.name).toBe('default');
    expect(errors[0]).toMatch(/failed to load/i);
  });
});

describe('Display', () => {
  let display: Display;
  let skin: SkinEngine;

  beforeEach(() => {
    skin = new SkinEngine({ forceMono: true }); // deterministic output
    display = new Display({ skin });
  });

  it('banner emits the AIDEN ASCII block (Phase 23.6 v3 visual style port)', () => {
    // Banner is ASCII art only — no inline version, no tagline, no
    // /help hint, no tip.  Those moved to chatSession.renderStartupCard.
    const b = stripAnsi(display.banner('4.2.1'));
    // ASCII block uses heavy box-drawing chars; assert the top edge.
    expect(b).toMatch(/█████╗/);
  });

  it('banner does not include /help, tagline, or tip line', () => {
    const b = stripAnsi(display.banner('4.2.1'));
    expect(b).not.toMatch(/✦ Tip:/);
    expect(b).not.toMatch(/\/help/);
    expect(b).not.toMatch(/local-first agent/);
    // Version no longer rendered in the banner — chatSession boot card
    // owns it now.
    expect(b).not.toMatch(/v4\.2\.1/);
  });

  it('banner ignores a tip option (Phase 23.5: tip moved to boot card)', () => {
    const b = stripAnsi(
      display.banner('4.2.1', { tip: 'Type /help to see what I can do.' }),
    );
    expect(b).not.toMatch(/✦ Tip:/);
  });

  it('userTurn formats with a "you" marker', () => {
    const out = stripAnsi(display.userTurn('hello'));
    expect(out).toMatch(/you/);
    expect(out).toContain('hello');
  });

  it('agentTurn renders markdown by default', () => {
    const out = stripAnsi(display.agentTurn('# Title\n- item'));
    expect(out).toMatch(/Aiden/);
    // marked-terminal upper-cases headers and renders bullets
    expect(out).toMatch(/Title/i);
  });

  it('agentTurn with markdown:false leaves text alone', () => {
    const out = stripAnsi(display.agentTurn('raw text', { markdown: false }));
    expect(out).toContain('raw text');
  });

  it('toolPreview formats name and args', () => {
    const out = stripAnsi(display.toolPreview('read_file', { path: '/tmp/x' }));
    expect(out).toContain('read_file');
    expect(out).toContain('/tmp/x');
  });

  it('toolPreview truncates very long args', () => {
    const big = { blob: 'x'.repeat(2000) };
    const out = stripAnsi(display.toolPreview('huge', big));
    expect(out.length).toBeLessThan(260);
    expect(out).toContain('...');
  });

  it('error includes suggestion when provided', () => {
    const out = stripAnsi(display.error('missing api key', 'run aiden setup'));
    expect(out).toContain('missing api key');
    expect(out).toContain('run aiden setup');
  });

  it('error without suggestion omits the hint line', () => {
    const out = stripAnsi(display.error('boom'));
    expect(out).toContain('boom');
    expect(out).not.toMatch(/hint/);
  });

  it('startSpinner returns a handle that stops cleanly without errors', () => {
    // stdout in vitest is not a TTY, so spinner is a no-op apart from one write
    const h = display.startSpinner('thinking…');
    expect(typeof h.stop).toBe('function');
    expect(typeof h.setText).toBe('function');
    h.setText('still thinking');
    h.stop('done');
    h.stop(); // double stop is a no-op
  });

  it('markdown() handles plain text without throwing', () => {
    const out = display.markdown('plain text');
    expect(typeof out).toBe('string');
    expect(stripAnsi(out)).toContain('plain text');
  });
});

describe('Display Phase 14b helpers', () => {
  function captureDisplay() {
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ skin, stdout: out });
    return { d, chunks };
  }

  it('info writes a single line with trailing newline', () => {
    const { d, chunks } = captureDisplay();
    d.info('hello');
    const joined = chunks.join('');
    expect(joined).toMatch(/hello\n$/);
  });

  it('success writes a checkmark prefix', () => {
    const { d, chunks } = captureDisplay();
    d.success('done');
    expect(chunks.join('')).toContain('done');
    expect(chunks.join('')).toMatch(/✓/);
  });

  it('warn writes a bang prefix', () => {
    const { d, chunks } = captureDisplay();
    d.warn('careful');
    expect(chunks.join('')).toContain('careful');
    expect(chunks.join('')).toMatch(/^!/);
  });

  it('dim writes the muted line with a newline', () => {
    const { d, chunks } = captureDisplay();
    d.dim('quiet');
    expect(chunks.join('')).toBe('quiet\n');
  });

  it('line draws a horizontal rule of the requested width', () => {
    const { d, chunks } = captureDisplay();
    d.line(10);
    const joined = chunks.join('');
    // mono skin uses '─' for default-style and '-' for monochrome glyphs.
    expect(joined.length).toBe(11); // 10 chars + newline
    expect(joined).toMatch(/─{10}\n|-{10}\n/);
  });
});

// ── v4.1.3-repl-polish tool trail tests ────────────────────────────────
//
// New trail format: ┊ {icon} {verb:12} {detail:40}
//
// Key semantic changes from Phase 23.5:
//   ok()  → SILENT on success (no output at all on non-TTY; erase on TTY)
//   fail()  → row persists in error (red / plain on mono)
//   degraded() → row persists in degraded yellow / plain on mono
//   blocked() → row persists in warn
//   retry()  → row printed / updated with N/M counter
//   ok(ms, retries>0) → row in warn with "after N retry/retries"
//
// All tests force AIDEN_UI_ICONS=0 so emoji don't sneak into assertions.
describe('Display v4.1.3-repl-polish toolRow', () => {
  function captureDisplay(opts: { tty: boolean }) {
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    (out as unknown as { isTTY: boolean }).isTTY = opts.tty;
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ skin, stdout: out });
    return { d, chunks };
  }

  beforeEach(() => {
    // Disable icons for deterministic assertions (no emoji width surprises).
    process.env.AIDEN_UI_ICONS = '0';
  });
  afterEach(() => {
    delete process.env.AIDEN_UI_ICONS;
  });

  // ── Success is SILENT ───────────────────────────────────────────────

  // v4.1.5 Issue N — persistent tool trail in scrollback.
  //
  // Prior behaviour: clean success silently erased the running row,
  // leaving no record in scrollback. Issue N changes this: clean
  // success now writes a completed row painted entirely in muted
  // colour (`#b8a89a`), surviving past the rerender + reply so the
  // user can scroll up after the turn and see the action timeline.
  // Failed / degraded / retry outcomes are unchanged — they already
  // wrote coloured outcome rows.

  it('non-TTY ok (v4.1.5 Issue N): completed row written for log persistence', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    const row = d.toolRow('web_search', { query: 'bollywood top hindi songs' });
    expect(chunks.join('')).toBe(''); // nothing during execution (deferred)
    row.ok(220);
    const out = chunks.join('');
    // A completed row IS now written on non-TTY so log scrollback
    // records the action + duration.
    expect(out.length).toBeGreaterThan(0);
    expect(stripAnsi(out)).toContain('fetching');
    expect(stripAnsi(out)).toContain('220ms');
  });

  it('TTY ok (v4.1.5 Issue N): completed row replaces running row', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    const row = d.toolRow('web_search', { query: 'Sahiba Jasleen Royal' });
    const first = chunks.join('');
    expect(first).toContain('┊');
    expect(stripAnsi(first)).toContain('fetching');
    chunks.length = 0;
    row.ok(180);
    const second = chunks.join('');
    // Erase ANSI (running row removed) AND a new completed row written.
    expect(second).toMatch(/\x1b\[1A\x1b\[2K\r/);
    expect(stripAnsi(second)).toContain('fetching');
    expect(stripAnsi(second)).toContain('180ms');
  });

  it('TTY ok (v4.1.5 Issue N): completed row paints in muted on coloured skin', () => {
    // Separate test with a coloured skin so the muted RGB triplet
    // is actually emitted (the forceMono captureDisplay helper
    // strips colours for deterministic output).
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) { chunks.push(c.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY = true;
    out.columns = 80;
    const skin = new SkinEngine({ forceMono: false }); // coloured
    const d = new Display({ stdout: out as unknown as NodeJS.WriteStream, skin });
    const row = d.toolRow('web_search', { query: 'q' });
    chunks.length = 0;
    row.ok(180);
    // Whole row paints in muted color: #b8a89a = rgb 184,168,154.
    expect(chunks.join('')).toContain('\x1b[38;2;184;168;154m');
  });

  it('Issue N: completed row survives past streamComplete (persistence sentinel)', () => {
    // Sequence: streamPartial → tool fires → tool completes (clean ok)
    // → more streamPartial → streamComplete. The completed tool row
    // should be present in the cumulative chunks AFTER streamComplete.
    const { d, chunks } = captureDisplay({ tty: true });
    d.streamPartial('Some preamble. ');
    const row = d.toolRow('web_search', { query: 'q' });
    row.ok(150); // clean success — must write completed row
    d.streamPartial('More content.\n');
    d.streamComplete();
    const full = stripAnsi(chunks.join(''));
    // Completed row text remains in scrollback (not erased by stream).
    expect(full).toContain('fetching');
    expect(full).toContain('150ms');
  });

  // ── v4.1.3-essentials: live tool indicator ──────────────────────────
  //
  // Long-running tools (web_fetch on slow URLs, app_launch with Spotify
  // cold-boot ~21s, GSMTC roundtrips) used to leave the user staring at
  // a frozen running row. The live indicator updates the row every 1s
  // with the elapsed time so the user has continuous feedback.
  //
  // Tests use vitest fake timers to advance wall-clock past the 1s tick
  // without burning real seconds. `Date.now()` and `setInterval` both
  // honor `vi.useFakeTimers()` — the row renderer reads `Date.now()` for
  // the elapsed calculation so advancing fake time gets the suffix.

  it('TTY live indicator: sub-second ok shows no running suffix', () => {
    vi.useFakeTimers();
    try {
      const { d, chunks } = captureDisplay({ tty: true });
      const row = d.toolRow('web_search', { query: 'fast call' });
      // Initial running row prints without the elapsed suffix.
      const first = stripAnsi(chunks.join(''));
      expect(first).not.toMatch(/running \d+/);
      // Tool completes before the 1s tick fires.
      vi.advanceTimersByTime(400);
      row.ok(400);
      // No "running …" suffix ever appeared.
      const total = stripAnsi(chunks.join(''));
      expect(total).not.toMatch(/running \d+/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTY live indicator: row updates with elapsed at 1s, 2s, 3s', () => {
    vi.useFakeTimers();
    try {
      const { d, chunks } = captureDisplay({ tty: true });
      d.toolRow('app_launch', { app: 'spotify' });
      chunks.length = 0;

      // Advance to the 1s tick — interval fires, eraseLast + rewrite.
      vi.advanceTimersByTime(1000);
      let flat = stripAnsi(chunks.join(''));
      expect(flat).toMatch(/running 1\.0s…|running 1000ms…/);

      // 2s tick.
      chunks.length = 0;
      vi.advanceTimersByTime(1000);
      flat = stripAnsi(chunks.join(''));
      expect(flat).toMatch(/running 2\.0s…|running 2000ms…/);

      // 3s tick.
      chunks.length = 0;
      vi.advanceTimersByTime(1000);
      flat = stripAnsi(chunks.join(''));
      expect(flat).toMatch(/running 3\.0s…|running 3000ms…/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTY live indicator: ok() stops the tick (no leaked timer)', () => {
    vi.useFakeTimers();
    try {
      const { d, chunks } = captureDisplay({ tty: true });
      const row = d.toolRow('web_search', { query: 'q' });
      vi.advanceTimersByTime(1500);  // one tick fired
      chunks.length = 0;
      row.ok(1500);                   // SUCCESS path — silent + stop tick
      // Advance another 5 seconds; no further writes should land.
      vi.advanceTimersByTime(5000);
      // Only the erase escape from ok() is allowed; no further "running"
      // suffix writes from a leaked interval.
      const post = stripAnsi(chunks.join(''));
      expect(post).not.toMatch(/running \d+/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTY live indicator: fail() stops the tick and shows final row', () => {
    vi.useFakeTimers();
    try {
      const { d, chunks } = captureDisplay({ tty: true });
      const row = d.toolRow('web_search', { query: 'q' });
      vi.advanceTimersByTime(2500);
      chunks.length = 0;
      row.fail(2500);
      // Final row carries the fail suffix, not "running …".
      const post = stripAnsi(chunks.join(''));
      expect(post).toMatch(/fail/);
      // Advance — no further writes.
      chunks.length = 0;
      vi.advanceTimersByTime(5000);
      expect(stripAnsi(chunks.join(''))).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTY live indicator: degraded() stops the tick and shows partial row', () => {
    vi.useFakeTimers();
    try {
      const { d, chunks } = captureDisplay({ tty: true });
      const row = d.toolRow('media_transport', { target: 'spotify' });
      vi.advanceTimersByTime(1200);
      chunks.length = 0;
      row.degraded(1200, 'launched; PID unknown');
      const post = stripAnsi(chunks.join(''));
      expect(post).toMatch(/partial/);
      // Tick should be cleared — no leaked writes.
      chunks.length = 0;
      vi.advanceTimersByTime(3000);
      expect(stripAnsi(chunks.join(''))).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTY live indicator: retry() stops the tick (retry counter holds static)', () => {
    vi.useFakeTimers();
    try {
      const { d, chunks } = captureDisplay({ tty: true });
      const row = d.toolRow('web_search', { query: 'q' });
      vi.advanceTimersByTime(1100);
      chunks.length = 0;
      row.retry(1, 3);
      const post = stripAnsi(chunks.join(''));
      // Retry counter present.
      expect(post).toMatch(/retry 1\/3/);
      // Tick MUST be stopped — racing tick would overwrite the retry
      // counter with `running Ns…` on the next 1s. v4.1.3-essentials
      // contract: retry is a state announcement; the counter should
      // hold until the next state change (next retry / final outcome).
      chunks.length = 0;
      vi.advanceTimersByTime(3000);
      expect(stripAnsi(chunks.join(''))).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-TTY: no live indicator scheduled (no "running …" ever appears)', () => {
    vi.useFakeTimers();
    try {
      const { d, chunks } = captureDisplay({ tty: false });
      d.toolRow('web_search', { query: 'q' });
      // Non-TTY paths don't print the running row; advancing time
      // must not surface any "running …" suffix from a tick interval
      // that should never have been scheduled.
      vi.advanceTimersByTime(5000);
      const flat = stripAnsi(chunks.join(''));
      expect(flat).not.toMatch(/running \d+/);
      expect(flat).toBe('');  // truly silent until completion
    } finally {
      vi.useRealTimers();
    }
  });

  // ── v4.1.3-essentials: per-chunk commit-and-rerender (replaces the
  //    Option A streamInterrupted-skip pattern) ────────────────────────
  //
  // Old pattern: any tool/indicator firing during a stream set a flag;
  // streamComplete checked the flag and SKIPPED the markdown rerender
  // entirely → tool-using turns got raw streamed text forever.
  //
  // New pattern (Option C): each interrupt point eagerly rerenders the
  // pre-interrupt chunk in place, then resets the per-chunk window.
  // Multi-chunk turns get every chunk rerendered as markdown.

  it('tool-less turn: streamComplete rerenders markdown (regression guard)', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    // Stream a chunk WITH markdown structure (heading + list) so the
    // rerender heuristic engages.
    d.streamPartial('# Title\n');
    d.streamPartial('- item 1\n');
    d.streamPartial('- item 2\n');
    chunks.length = 0;
    d.streamComplete();
    const total = chunks.join('');
    // Eraser ANSI fires (\x1b[<n>F\x1b[J).
    expect(total).toMatch(/\x1b\[\d+F\x1b\[J/);
    // Rerendered output contains the formatted body (indented per the
    // streamComplete pattern). The exact format depends on marked but
    // the heading text must survive.
    const stripped = stripAnsi(total);
    // Markdown renderer uppercases headings — match case-insensitively.
    expect(stripped.toLowerCase()).toContain('title');
    expect(stripped).toContain('item 1');
  });

  it('tool-using turn: pre-tool chunk rerenders on toolRow interrupt', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    // Pre-tool chunk with markdown structure — the kind of body the
    // model says before calling a tool ("Here's what I'll do: ...").
    d.streamPartial('# Plan\n');
    d.streamPartial('- step 1\n');
    d.streamPartial('- step 2\n');
    chunks.length = 0;
    // Tool fires — should rerender the chunk in place before the row.
    d.toolRow('web_search', { query: 'q' });
    const total = chunks.join('');
    // Eraser fired (chunk got rerendered).
    expect(total).toMatch(/\x1b\[\d+F\x1b\[J/);
    // Rerendered markdown survives. Heading uppercased by the renderer.
    const stripped = stripAnsi(total);
    expect(stripped.toLowerCase()).toContain('plan');
    // Tool row landed below.
    expect(stripped).toMatch(/┊/);
    expect(stripped).toMatch(/fetching/);
  });

  it('multi-chunk turn: each chunk gets its own rerender on tool interrupts', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    // Chunk 1: pre-tool prose with structure.
    d.streamPartial('# Chunk 1\n');
    d.streamPartial('- a\n');
    // Tool 1 interrupts → commit-and-rerender chunk 1.
    const row1 = d.toolRow('web_search', { query: 'q1' });
    row1.degraded(50, 'cached');
    // Chunk 2: post-tool prose with structure.
    d.streamPartial('# Chunk 2\n');
    d.streamPartial('- b\n');
    // Tool 2 interrupts → commit-and-rerender chunk 2.
    const row2 = d.toolRow('web_search', { query: 'q2' });
    row2.degraded(50, 'cached');
    // Chunk 3: final prose.
    d.streamPartial('# Chunk 3\n');
    d.streamPartial('- c\n');
    chunks.length = 0;
    d.streamComplete();
    // Final chunk rerendered too — eraser ANSI present in the streamComplete output.
    const totalAtCompletion = chunks.join('');
    expect(totalAtCompletion).toMatch(/\x1b\[\d+F\x1b\[J/);
    // Heading uppercased by renderer; match case-insensitively.
    expect(stripAnsi(totalAtCompletion).toLowerCase()).toContain('chunk 3');
  });

  it('plain prose (no structure): no eraser fires on tool interrupt or streamComplete', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    // No headers, lists, fences, blockquotes — heuristic should bail.
    d.streamPartial('just some plain prose without any structure\n');
    chunks.length = 0;
    d.toolRow('web_search', { query: 'q' });
    // No eraser fired for the chunk — saves a flicker on short replies.
    const afterToolRow = chunks.join('');
    expect(afterToolRow).not.toMatch(/\x1b\[\d+F\x1b\[J/);
    // But the trail row still printed (interrupt path still fenced
    // the chunk with a newline so the row landed cleanly).
    expect(stripAnsi(afterToolRow)).toMatch(/┊/);
  });

  // ── v4.1.3-essentials post-ship: inline markdown in heuristic ──────
  //
  // Bug: plain prose with ONLY inline `**bold**` (no headings / lists /
  // code blocks) skipped tryRerenderInPlace's structure-check → marked
  // was never invoked → `paintBoldWhite` was never called → literal
  // `**` asterisks stayed in the user-visible output. Same gap existed
  // for inline `` `code` ``. Fix added both to the heuristic.

  it('plain prose with inline **bold**: rerender fires, ANSI bold + underline emitted, asterisks gone', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.streamPartial('Here is some **bold text** in plain prose.\n');
    chunks.length = 0;
    d.streamComplete();
    const total = chunks.join('');
    // Rerender fired (eraser ANSI present).
    expect(total).toMatch(/\x1b\[\d+F\x1b\[J/);
    // v4.5 TUI polish — paintEmphasis emits bold-on (\x1b[1m) and
    // bold-off (\x1b[22m) only. Underline was dropped (was making
    // bulleted list items look like clickable links per v4.5 polish
    // feedback). Bold-on/off must appear; underline must NOT.
    expect(total).toMatch(/\x1b\[1m/);
    expect(total).toMatch(/\x1b\[22m/);
    expect(total).not.toMatch(/\x1b\[4m/);
    expect(total).not.toMatch(/\x1b\[24m/);
    // Literal asterisks REPLACED by the rendered form.
    expect(stripAnsi(total)).not.toMatch(/\*\*bold text\*\*/);
    // Word still present (just no longer wrapped in asterisks).
    expect(stripAnsi(total)).toContain('bold text');
  });

  it('plain prose with inline `code`: rerender fires', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.streamPartial('Run `npm test` to verify.\n');
    chunks.length = 0;
    d.streamComplete();
    const total = chunks.join('');
    // Rerender fired.
    expect(total).toMatch(/\x1b\[\d+F\x1b\[J/);
    // `npm test` content survives the rerender (renderer wraps it in
    // accent-colored backticks but the inner text is preserved).
    expect(stripAnsi(total)).toContain('npm test');
  });

  it('math expression "2 ** 3": NOT a false positive (no rerender)', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    // Bare `2 ** 3` — looks like bold opener but the `**` is followed
    // by space, which the heuristic explicitly rejects (\S right after
    // the **). No rerender should fire.
    d.streamPartial('The result is 2 ** 3 = 8.\n');
    // Don't clear chunks here — we want to assert the streamPartial
    // output passed through verbatim AND no eraser fired on completion.
    const beforeComplete = chunks.length;
    d.streamComplete();
    const completionOnly = chunks.slice(beforeComplete).join('');
    // streamComplete should write nothing extra — no rerender fired.
    expect(completionOnly).not.toMatch(/\x1b\[\d+F\x1b\[J/);
    // Original prose, including the literal `**`, present in the
    // streamPartial output that came before.
    expect(stripAnsi(chunks.join(''))).toContain('2 ** 3');
  });

  it('no inline markers anywhere: rerender still skipped (no flicker regression)', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.streamPartial('Just a sentence with no markdown at all.\n');
    chunks.length = 0;
    d.streamComplete();
    const total = chunks.join('');
    expect(total).not.toMatch(/\x1b\[\d+F\x1b\[J/);
  });

  it('triple-backtick fence (existing pattern) takes precedence over inline-code: no double-trigger', () => {
    // Mainly a sanity check — fence and inline-code patterns coexist
    // in the heuristic; either being true is sufficient. This test
    // confirms the fenced path still works as before.
    const { d, chunks } = captureDisplay({ tty: true });
    d.streamPartial('```ts\nconst x = 1;\n```\n');
    chunks.length = 0;
    d.streamComplete();
    const total = chunks.join('');
    expect(total).toMatch(/\x1b\[\d+F\x1b\[J/);
  });

  it('markdown parse failure: raw text fallback prevents body from vanishing', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    // Spy on the markdown method (defined on the Display instance) and
    // make it throw — simulating a marked.parse() failure on
    // pathological input.
    const spy = vi.spyOn(d, 'markdown').mockImplementation(() => {
      throw new Error('simulated marked failure');
    });
    try {
      d.streamPartial('# Important content\n');
      d.streamPartial('- must not vanish\n');
      chunks.length = 0;
      d.streamComplete();
      const total = stripAnsi(chunks.join(''));
      // Eraser fired BUT the raw buffered text was written back —
      // the body did not vanish into the void.
      expect(total).toContain('Important content');
      expect(total).toContain('must not vanish');
    } finally {
      spy.mockRestore();
    }
  });

  it('streamComplete with empty buffer (all chunks already committed): no-op', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.streamPartial('# Pre-tool\n');
    d.streamPartial('- a\n');
    d.toolRow('web_search', { query: 'q' });   // commits chunk 1
    // No streamPartial after the tool — final chunk is empty.
    chunks.length = 0;
    d.streamComplete();
    // No second rerender (buffer was empty). The output should be
    // empty or at most a trailing newline cleanup — definitely no
    // eraser sequence.
    const total = chunks.join('');
    expect(total).not.toMatch(/\x1b\[\d+F\x1b\[J/);
  });

  it('non-TTY: commitStreamChunk never fires the eraser even with structure', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.streamPartial('# Heading\n');
    d.streamPartial('- list\n');
    d.toolRow('web_search', { query: 'q' });
    // tryRerenderInPlace early-returns on !isTTY — no eraser written
    // and the raw streamed text stays as the only output for that chunk.
    expect(chunks.join('')).not.toMatch(/\x1b\[\d+F\x1b\[J/);
  });

  // ── Fail row ────────────────────────────────────────────────────────

  it('non-TTY fail: trail row with "fail Ns" suffix', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('open_url', { url: 'https://example.com/x' }).fail(1500);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/┊/);
    expect(flat).toMatch(/fetching/);
    expect(flat).toMatch(/fail 1\.5s/);
  });

  // ── Degraded row ─────────────────────────────────────────────────────

  it('non-TTY degraded: trail row with "partial Nms" suffix', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('recall_session', { session_id: 'abc' }).degraded(320, 'cached');
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/┊/);
    expect(flat).toMatch(/partial 320ms/);
    expect(flat).toContain('cached');
  });

  // ── Blocked row ──────────────────────────────────────────────────────

  it('blocked: trail row with "blocked" suffix', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('open_url', { url: 'https://www.youtube.com/watch?v=abc' }).blocked();
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/blocked/);
    expect(flat).toMatch(/┊/);
  });

  // ── Retry row ───────────────────────────────────────────────────────

  it('retry: trail row with N/M counter', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('web_search', { query: 'foo' }).retry(1, 2);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/retry 1\/2 …/);
  });

  // ── ok-after-retries ────────────────────────────────────────────────

  it('ok with retries>0: trail row in warn with "after N retry"', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('web_search', { query: 'foo' }).ok(4200, 1);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/ok 4\.2s after 1 retry/);
    expect(flat).toMatch(/┊/);
  });

  // ── Truncation ──────────────────────────────────────────────────────

  it('detail field truncates long args with "…" at 40 chars', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    const longUrl = 'https://www.youtube.com/watch?v=' + 'X'.repeat(80) + '&list=PL';
    // Use fail() so the row is printed (success is silent)
    d.toolRow('open_url', { url: longUrl }).fail(90);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toMatch(/…/);
    // Extract the detail field (between verb+spaces and the suffix)
    // Detail is capped at 40 chars including the ellipsis
    const detailMatch = flat.match(/fetching\s+(\S+)/);
    expect(detailMatch?.[1]?.length ?? 0).toBeLessThanOrEqual(40);
  });

  // ── v4.1.4-media — empty-args + per-tool preview surface ───────────

  it('empty args object renders no detail (not "{}")', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    // media_sessions has no args by schema. fail() so the row prints.
    d.toolRow('media_sessions', {}).fail(50);
    const flat = stripAnsi(chunks.join(''));
    // Must NOT contain the literal "{}" — the v4.1.4-media fix.
    expect(flat).not.toMatch(/\{\}/);
    // Must still contain the verb (it's the trail's identity anchor).
    expect(flat).toMatch(/media\s/);
  });

  it('media_transport row previews target arg (not raw JSON)', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('media_transport', { action: 'pause', target: 'spotify' }).fail(80);
    const flat = stripAnsi(chunks.join(''));
    // buildToolPreview routes media_transport via TOOL_PRIMARY_ARG to
    // the `target` field — should surface "spotify" verbatim, NOT the
    // serialized {"action":"pause","target":"spotify"} JSON.
    expect(flat).toContain('spotify');
    expect(flat).not.toMatch(/"action":/);
  });

  it('media_key row previews action arg (no target to show)', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('media_key', { action: 'play_pause' }).fail(40);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toContain('play_pause');
  });

  it('app_input row previews app arg', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.toolRow('app_input', { app: 'chrome', keys: '{SPACE}' }).fail(60);
    const flat = stripAnsi(chunks.join(''));
    expect(flat).toContain('chrome');
    // SendKeys grammar shouldn't leak into the trail — only the app
    // identifier matters at a glance.
    expect(flat).not.toContain('{SPACE}');
  });

  // ── Verb padding ────────────────────────────────────────────────────

  it('verb column is padded to 12 chars so detail fields align', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    // 'foo' → fallback verb 'calling' (7 chars), padded to 12
    d.toolRow('foo', { query: 'q' }).fail(10);
    const flat = stripAnsi(chunks.join(''));
    // "calling" padded to 12 => 5 trailing spaces before the detail
    expect(flat).toMatch(/calling {5}/);
  });
});

// ── v4.1.3-essentials boldwrap-fix — pure helpers ──────────────────────────
//
// Regression coverage for the bold-split-across-chunk fix in
// commitStreamChunk. Both helpers are pure, exported for test access.

describe('countNewlines (v4.1.3-essentials)', () => {
  it('returns 0 for the empty string', () => {
    expect(countNewlines('')).toBe(0);
  });

  it('returns 0 when the buffer has no newlines', () => {
    expect(countNewlines('plain prose with no line breaks')).toBe(0);
  });

  it('counts a single trailing newline', () => {
    expect(countNewlines('one line\n')).toBe(1);
  });

  it('counts multiple newlines exactly', () => {
    expect(countNewlines('a\nb\nc\n')).toBe(3);
  });

  it('counts blank lines (consecutive newlines)', () => {
    expect(countNewlines('a\n\n\nb')).toBe(3);
  });
});

describe('splitAtUnclosedBold (v4.1.3-essentials)', () => {
  it('fast path: no `**` at all → carry empty, whole buffer rerenderable', () => {
    const r = splitAtUnclosedBold('plain text with no bold markers');
    expect(r.carry).toBe('');
    expect(r.rerenderable).toBe('plain text with no bold markers');
  });

  it('balanced `**bold**` → carry empty', () => {
    const r = splitAtUnclosedBold('this is **bold** text');
    expect(r.carry).toBe('');
    expect(r.rerenderable).toBe('this is **bold** text');
  });

  it('multiple balanced `**bold**` pairs → carry empty', () => {
    const r = splitAtUnclosedBold('**a** and **b** and **c**');
    expect(r.carry).toBe('');
    expect(r.rerenderable).toBe('**a** and **b** and **c**');
  });

  it('unmatched trailing `**` → carry starts at the unmatched marker', () => {
    const r = splitAtUnclosedBold('finished part **carry-start');
    expect(r.rerenderable).toBe('finished part ');
    expect(r.carry).toBe('**carry-start');
  });

  it('one closed pair + one open trailing → carry is the open tail', () => {
    const r = splitAtUnclosedBold('**closed** and **open-tail');
    expect(r.rerenderable).toBe('**closed** and ');
    expect(r.carry).toBe('**open-tail');
  });

  it('`***` (three stars) does not double-count: still balanced', () => {
    // `***` = one `**` pair start, plus a stray `*`. Single pair → odd.
    // Then a closing `**` balances it. Final count = 2 (even).
    const r = splitAtUnclosedBold('***bold and italic** rest');
    expect(r.carry).toBe('');
  });

  it('code-fence safety: open ``` defers entire buffer', () => {
    const r = splitAtUnclosedBold('prose\n```ts\ncode with **stars** inside');
    expect(r.rerenderable).toBe('');
    expect(r.carry).toBe('prose\n```ts\ncode with **stars** inside');
  });

  it('code-fence safety: closed ``` ... ``` does NOT defer', () => {
    const r = splitAtUnclosedBold('```ts\ncode\n```\nthen **bold** text');
    expect(r.carry).toBe('');
  });

  it('inline-backtick safety: `**` inside an open `…` defers', () => {
    // Single backtick before unmatched `**` on same line → literal code.
    const r = splitAtUnclosedBold('see `inline **stars defers');
    expect(r.rerenderable).toBe('');
    expect(r.carry).toBe('see `inline **stars defers');
  });

  it('inline-backtick safety: balanced `code` before `**bold` does NOT defer', () => {
    const r = splitAtUnclosedBold('see `inline` code then **bold-open');
    expect(r.rerenderable).toBe('see `inline` code then ');
    expect(r.carry).toBe('**bold-open');
  });

  it('regression: tool-firing-mid-bold pattern preserves split semantics', () => {
    // Real-world repro from visual smoke: heading bold opens mid-chunk,
    // tool fires before the close arrives.
    const chunk = '**Live tool indi';
    const r = splitAtUnclosedBold(chunk);
    expect(r.rerenderable).toBe('');
    expect(r.carry).toBe('**Live tool indi');
  });

  it('regression: carry concatenates with next chunk to render cleanly', () => {
    // After tool completes, the carry+next-chunk should be balanced.
    const next = '**Live tool indi' + 'cator** working';
    const r = splitAtUnclosedBold(next);
    expect(r.carry).toBe('');
    expect(r.rerenderable).toBe('**Live tool indicator** working');
  });
});

// ── v4.1.4 reply-quality polish — frame integration via Display ────────────
//
// agentTurn and tryRerenderInPlace now route through frame.ts for both
// indent (gutter = 3 cols) and ANSI-aware soft wrap. Tests below assert
// the visible left edge at the gutter and that resetStreamFrameForResize
// neutralises the per-chunk row counter for the resize-reflow path.

describe('Display v4.1.4 frame integration', () => {
  function captureDisplay(opts: { tty?: boolean; columns?: number } = {}): {
    d: Display;
    chunks: string[];
  } {
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY  = opts.tty ?? true;
    out.columns = opts.columns ?? 80;
    const skin = new SkinEngine({ forceMono: true });
    return {
      d: new Display({ stdout: out as unknown as NodeJS.WriteStream, skin }),
      chunks,
    };
  }

  it('agentTurn body lines start at the 2-col gutter', () => {
    // v4.8.0 Slice 7 hotfix #2: agentTurn body indent moved from 3
    // (frame.GUTTER) to 2 cols so reply content aligns under the
    // ▎ panel bar in agentHeader. Frame GUTTER stays at 3 for
    // markdown lists / blockquotes / code blocks.
    const { d } = captureDisplay({ columns: 80 });
    const turn = stripAnsi(d.agentTurn('alpha bravo charlie', { markdown: false }));
    const lines = turn.split('\n').filter((l) => l.includes('alpha'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^  alpha/); // exactly 2 leading spaces
  });

  it('agentTurn wraps long prose at bodyWidth and re-indents continuation', () => {
    const { d } = captureDisplay({ columns: 40 });
    const long = 'the quick brown fox jumps over the lazy dog and then keeps running far past the river bend';
    const turn = stripAnsi(d.agentTurn(long, { markdown: false }));
    const bodyLines = turn.split('\n').filter((l) => l.trimStart().length > 0 && !/^Aiden$/i.test(l.trim()) && !/^─+$/.test(l.trim()));
    // At least 2 wrapped body lines (long prose at 40-col terminal).
    // Slice 7 hotfix #2: indent is 2 cols, not 3.
    const wrappedLines = bodyLines.filter((l) => l.startsWith('  ') && !l.startsWith('   '));
    expect(wrappedLines.length).toBeGreaterThanOrEqual(2);
  });

  it('resetStreamFrameForResize is idempotent and safe with no active stream', () => {
    const { d } = captureDisplay();
    // No header shown yet — call should be a no-op.
    expect(() => {
      (d as unknown as { resetStreamFrameForResize: () => void }).resetStreamFrameForResize();
    }).not.toThrow();
  });

  it('resetStreamFrameForResize zeros internal counters mid-stream', () => {
    const { d } = captureDisplay({ tty: true });
    d.streamPartial('first chunk text\nsecond line\n');
    // Internal state must show non-zero line count + buffer.
    type StreamFields = {
      streamLineCount: number;
      streamBuffer:    string;
      streamHeaderShown: boolean;
    };
    const inner = d as unknown as StreamFields;
    expect(inner.streamLineCount).toBeGreaterThan(0);
    expect(inner.streamBuffer.length).toBeGreaterThan(0);
    expect(inner.streamHeaderShown).toBe(true);

    (d as unknown as { resetStreamFrameForResize: () => void }).resetStreamFrameForResize();

    // After reset: counters zeroed; header flag dropped so next
    // streamPartial re-emits the "Aiden" label.
    expect(inner.streamLineCount).toBe(0);
    expect(inner.streamBuffer).toBe('');
    expect(inner.streamHeaderShown).toBe(false);
  });

  it('cols() respects the 100-col cap even on wide terminals', () => {
    const { d: dWide } = captureDisplay({ columns: 200 });
    const { d: d80 }   = captureDisplay({ columns: 80 });
    expect(dWide.cols()).toBe(100);
    expect(d80.cols()).toBe(80);
  });

  it('rule() spans body width, not terminal width', () => {
    const { d } = captureDisplay({ columns: 80 });
    const r = stripAnsi(d.rule());
    // bodyWidth(80) = 75 → rule = 75 chars of `─`.
    expect(r.length).toBe(75);
    expect(r).toMatch(/^─+$/);
  });
});

// ── v4.1.4 reply-quality polish — F1 detect-and-skip predicate ─────────────
//
// isPreFramedLine determines which lines from the rendered markdown
// output should be passed through the agentTurn / tryRerenderInPlace
// indent+wrap pass unchanged. False-positives here are visually
// catastrophic (prose drifts right by 3 cols, lists nest wrong);
// false-negatives are catastrophic the other way (code-block rail
// breaks across wrap continuation). Coverage targets both directions.

describe('isPreFramedLine (v4.1.4 F1)', () => {
  it('code-block body line (24-bit bg) → pre-framed', () => {
    const line = '   \x1b[38;5;240m│\x1b[39m \x1b[48;2;50;50;60m const x = 1; \x1b[49m';
    expect(isPreFramedLine(line)).toBe(true);
  });

  it('plain code-rail at frame gutter → pre-framed', () => {
    expect(isPreFramedLine('   │ raw code text')).toBe(true);
  });

  it('blockquote rail at gutter → pre-framed', () => {
    expect(isPreFramedLine('   ┃ quoted text')).toBe(true);
  });

  it('top-level bullet (renderer.list 2-space indent) → pre-framed', () => {
    expect(isPreFramedLine('  • first item')).toBe(true);
  });

  it('nested bullet (renderer.list 4-space indent) → pre-framed', () => {
    expect(isPreFramedLine('    ▸ nested item')).toBe(true);
  });

  it('numbered bullet with bold ANSI → pre-framed', () => {
    // v4.5 TUI polish — paintEmphasis dropped the underline pair.
    // The pre-framed detector still recognises numbered bullets with
    // bold-only emphasis ANSI.
    const line = '  1. \x1b[1mIt targets the thing\x1b[22m';
    expect(isPreFramedLine(line)).toBe(true);
  });

  it('code-block fence rule (top/bottom ──) → pre-framed', () => {
    expect(isPreFramedLine('   ──────────────────────')).toBe(true);
    expect(isPreFramedLine('   ── js ─────────────────')).toBe(true);
  });

  it('plain prose → NOT pre-framed', () => {
    expect(isPreFramedLine('this is plain prose with no chrome')).toBe(false);
  });

  it('heading (bold + brand) → NOT pre-framed (agentTurn should indent)', () => {
    // Headings carry bold ANSI but no rail / bg / list-bullet marker.
    const heading = '\x1b[1m\x1b[38;2;255;107;53mPLAN\x1b[39m\x1b[22m';
    expect(isPreFramedLine(heading)).toBe(false);
  });

  it('inline-codespan prose (Issue D regression) → NOT pre-framed', () => {
    // v4.1.4 reply-quality polish — Fix D. Inline `` `code` `` paints
    // the bg with the same `\x1b[48;…` envelope as code blocks. Before
    // Fix D the predicate matched on bg presence alone and incorrectly
    // classified prose-with-inline-code as pre-framed, causing it to
    // bypass the indent + wrap pass and terminal-natural-wrap past
    // bodyWidth. Predicate now requires the gutter+rail prefix
    // (`   │ `) so only true code-block body lines trip the rule.
    const line = 'services named by developers long gone: \x1b[48;2;50;50;60m \x1b[33mLegacyBridge\x1b[39m \x1b[49m, MaybeUser, more prose';
    expect(isPreFramedLine(line)).toBe(false);
  });

  it('code-block body line with bg AND rail prefix → still pre-framed', () => {
    // Sanity: Fix D didn't break the code-block detection. The
    // `   │ ` prefix is the new reliable signal.
    const line = '   │ \x1b[48;2;50;50;60m const x = 1; \x1b[49m';
    expect(isPreFramedLine(line)).toBe(true);
  });

  it('empty string → NOT pre-framed', () => {
    expect(isPreFramedLine('')).toBe(false);
  });
});

// ── v4.1.4 reply-quality polish — F-B1 wrap-aware row counter ──────────────
//
// streamPartial now counts terminal-natural-wrap rows so the eraser
// walks back enough rows to clear raw streamed markup before the
// rerender writes formatted output below it.

describe('Display v4.1.4 F-B1 wrap-aware row counter', () => {
  function captureDisplay(opts: { columns?: number } = {}): {
    d: Display;
    chunks: string[];
  } {
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY  = true;
    out.columns = opts.columns ?? 80;
    const skin = new SkinEngine({ forceMono: true });
    return {
      d: new Display({ stdout: out as unknown as NodeJS.WriteStream, skin }),
      chunks,
    };
  }

  function findEraserCount(s: string): number | null {
    // eslint-disable-next-line no-control-regex
    const m = s.match(/\x1b\[(\d+)F\x1b\[J/);
    return m ? parseInt(m[1]!, 10) : null;
  }

  it('long bullet list with bold: eraser counts wrapped rows, not just newlines', () => {
    const { d, chunks } = captureDisplay({ columns: 80 });
    // 3 bullets, each ~100 chars → each wraps to 2 rows on 80-col → 6 rows
    const bullet = (n: number) =>
      `${n}. **It targets the thing users feel immediately and compounds across every workflow they touch**`;
    d.streamPartial(`${bullet(1)}\n${bullet(2)}\n${bullet(3)}\n`);
    d.streamComplete();
    const eraserN = findEraserCount(chunks.join(''));
    expect(eraserN).not.toBeNull();
    // boundaries crossed = 2 wraps × 3 bullets + 3 newlines = 9
    expect(eraserN).toBeGreaterThanOrEqual(6);
  });

  it('short content (no wrap) — counter matches newline count (back-compat)', () => {
    const { d, chunks } = captureDisplay({ columns: 80 });
    d.streamPartial('# Heading\n- item\n');
    d.streamComplete();
    const eraserN = findEraserCount(chunks.join(''));
    expect(eraserN).not.toBeNull();
    // 2 newlines, no wrap → count exactly 2
    expect(eraserN).toBe(2);
  });

  it('counter survives undefined columns (non-TTY fallback)', () => {
    // No assertion on eraser count (non-TTY path skips rerender) —
    // just that streamPartial doesn't throw and internal state is sane.
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) { chunks.push(c.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY  = true;
    // columns deliberately left unset
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ stdout: out as unknown as NodeJS.WriteStream, skin });
    expect(() => {
      d.streamPartial('a long line that would wrap if columns were known');
      d.streamComplete();
    }).not.toThrow();
  });
});


// ── v4.1.5 Phase 1d (Q-Q2-a) — TRAIL_HIDE_TOOLS suppression ────────────────
//
// Tools listed in TRAIL_HIDE_TOOLS are agent-plumbing (e.g.
// `lookup_tool_schema`) and shouldn't pollute the visible tool trail.
// `Display.toolRow(name)` returns a no-op handle when `name` is in the
// set, so writes are suppressed but the handle still satisfies the
// ToolRowHandle contract for callers downstream.

describe('TRAIL_HIDE_TOOLS (v4.1.5 Phase 1d Q-Q2-a)', () => {
  it('exposes lookup_tool_schema as a hidden tool by default', () => {
    expect(TRAIL_HIDE_TOOLS.has('lookup_tool_schema')).toBe(true);
  });

  it('Display.toolRow returns no-op handle for hidden tools (zero writes)', () => {
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) { chunks.push(c.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY = true;
    out.columns = 80;
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ stdout: out as unknown as NodeJS.WriteStream, skin });
    chunks.length = 0;
    const row = d.toolRow('lookup_tool_schema', { toolName: 'skill_view' });
    // No bytes hit stdout — row is fully suppressed.
    expect(chunks.length).toBe(0);
    // All terminal methods still callable (contract satisfied).
    expect(() => row.ok(0)).not.toThrow();
    expect(() => row.fail(0)).not.toThrow();
    expect(() => row.degraded(0, 'reason')).not.toThrow();
    expect(() => row.retry(1, 3)).not.toThrow();
    expect(() => row.blocked()).not.toThrow();
    expect(() => row.emptyRetry()).not.toThrow();
    expect(() => row.emptyFail()).not.toThrow();
    // Still nothing in chunks after all those calls.
    expect(chunks.length).toBe(0);
  });

  it('VISIBLE tools (not in set) still produce real rows', () => {
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) { chunks.push(c.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY = true;
    out.columns = 80;
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ stdout: out as unknown as NodeJS.WriteStream, skin });
    // eslint-disable-next-line no-control-regex
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    chunks.length = 0;
    const row = d.toolRow('web_search', { query: 'q' });
    // Real running row was written.
    expect(chunks.length).toBeGreaterThan(0);
    expect(strip(chunks.join(''))).toMatch(/fetching/);
    row.ok(100);
  });

  it('makeNoOpToolRowHandle satisfies ToolRowHandle contract', () => {
    const handle = makeNoOpToolRowHandle();
    // All methods exist and are callable with no side effects.
    expect(typeof handle.ok).toBe('function');
    expect(typeof handle.fail).toBe('function');
    expect(typeof handle.degraded).toBe('function');
    expect(typeof handle.retry).toBe('function');
    expect(typeof handle.blocked).toBe('function');
    expect(typeof handle.emptyRetry).toBe('function');
    expect(typeof handle.emptyFail).toBe('function');
    // None throws.
    expect(() => {
      handle.ok(123);
      handle.fail(456);
      handle.degraded(789, 'partial');
      handle.retry(1, 3);
      handle.blocked();
      handle.emptyRetry();
      handle.emptyFail();
    }).not.toThrow();
  });

  it('runtime mutation: adding a tool name to the set hides it too', () => {
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) { chunks.push(c.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY = true;
    out.columns = 80;
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ stdout: out as unknown as NodeJS.WriteStream, skin });
    // 'skill_view' is normally VISIBLE.
    TRAIL_HIDE_TOOLS.add('skill_view');
    try {
      chunks.length = 0;
      const row = d.toolRow('skill_view', { name: 'demo' });
      expect(chunks.length).toBe(0);
      row.ok(50);
      expect(chunks.length).toBe(0);
    } finally {
      // Restore default state so other tests aren't affected.
      TRAIL_HIDE_TOOLS.delete('skill_view');
    }
  });
});

describe('Display v4.8.0 ui_* event renderers', () => {
  function captureDisplay(opts: { tty: boolean }) {
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    }) as unknown as NodeJS.WriteStream;
    (out as unknown as { isTTY: boolean }).isTTY = opts.tty;
    const skin = new SkinEngine({ forceMono: true });
    const d = new Display({ skin, stdout: out });
    return { d, chunks };
  }

  // ── Dispatch gates ────────────────────────────────────────────────────

  it('non-TTY: every ui_* event is silent', () => {
    const { d, chunks } = captureDisplay({ tty: false });
    d.renderUiEvent('ui_task_update', { task_id: 't1', label: 'x', status: 'running' });
    d.renderUiEvent('ui_task_done',   { task_id: 't1', status: 'success' });
    d.renderUiEvent('ui_command_result',   { command: 'ls' });
    d.renderUiEvent('ui_test_result',      { framework: 'vitest', passed: 1, failed: 0 });
    d.renderUiEvent('ui_approval_request', { prompt: 'go?', risk_tier: 'medium' });
    d.renderUiEvent('ui_toast',            { message: 'hi', kind: 'info' });
    d.renderUiEvent('ui_artifact_created', { path: '/x', kind: 'file' });
    expect(chunks.join('')).toBe('');
  });

  it('unknown event name silent-ignores (no crash)', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    expect(() => d.renderUiEvent('ui_does_not_exist', { foo: 'bar' })).not.toThrow();
    expect(chunks.join('')).toBe('');
  });

  // ── ui_task_update ────────────────────────────────────────────────────

  it('ui_task_update paints gutter + glyph + label', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.renderUiEvent('ui_task_update', { task_id: 't1', label: 'researching', status: 'running' });
    const out = stripAnsi(chunks.join(''));
    expect(out).toContain('┊');
    expect(out).toContain('⟳');
    expect(out).toContain('researching');
  });

  it('ui_task_update silent on missing task_id or label', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.renderUiEvent('ui_task_update', { label: 'x', status: 'running' });
    d.renderUiEvent('ui_task_update', { task_id: 't1', status: 'running' });
    expect(chunks.join('')).toBe('');
  });

  it('ui_task_update subagent kind indents inside gutter by depth', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.renderUiEvent('ui_task_update', {
      task_id: 's1', label: 'nested', status: 'running', kind: 'subagent', depth: 2,
    });
    const out = stripAnsi(chunks.join(''));
    // `┊ ` then 4-space indent (depth 2 × 2 spaces) then glyph + label
    expect(out).toMatch(/┊ {5}⟳ nested/);
  });

  // ── ui_task_done ──────────────────────────────────────────────────────

  it('ui_task_done resolves label from prior update + appends summary', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.renderUiEvent('ui_task_update', { task_id: 't1', label: 'researching', status: 'running' });
    chunks.length = 0;
    d.renderUiEvent('ui_task_done', { task_id: 't1', status: 'success', summary: 'found 3' });
    const out = stripAnsi(chunks.join(''));
    expect(out).toContain('✓');
    expect(out).toContain('researching');
    expect(out).toContain('found 3');
  });

  it('ui_task_done with no prior update falls back to task_id as label', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.renderUiEvent('ui_task_done', { task_id: 'orphan', status: 'failure' });
    const out = stripAnsi(chunks.join(''));
    expect(out).toContain('✗');
    expect(out).toContain('orphan');
  });

  // ── ui_command_result ─────────────────────────────────────────────────

  it('ui_command_result paints header + stdout + exit row on failure', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    d.renderUiEvent('ui_command_result', {
      command: 'npm test', stdout: 'one\ntwo', stderr: 'boom', exit_code: 2,
    });
    const out = stripAnsi(chunks.join(''));
    expect(out).toContain('▸ npm test');
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).toContain('boom');
    expect(out).toContain('(exit 2)');
    // Every physical line carries the gutter.
    for (const line of out.split('\n').filter(Boolean)) {
      expect(line.startsWith('┊')).toBe(true);
    }
  });

  it('ui_command_result caps stdout/stderr at 5 lines each', () => {
    const { d, chunks } = captureDisplay({ tty: true });
    const long = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n');
    d.renderUiEvent('ui_command_result', { command: 'spam', stdout: long });
    const out = stripAnsi(chunks.join(''));
    expect(out).toContain('line0');
    expect(out).toContain('line4');
    expect(out).not.toContain('line5');
  });

  // ── ui_test_result ────────────────────────────────────────────────────

  it('ui_test_result: glyph + skipped + duration based on counts', () => {
    const a = captureDisplay({ tty: true });
    a.d.renderUiEvent('ui_test_result', { framework: 'vitest', passed: 12, failed: 0, skipped: 2, duration_ms: 450 });
    const greenOut = stripAnsi(a.chunks.join(''));
    expect(greenOut).toContain('✓ vitest:');
    expect(greenOut).toContain('12 passed');
    expect(greenOut).toContain('2 skipped');
    expect(greenOut).toContain('in 450ms');
    const b = captureDisplay({ tty: true });
    b.d.renderUiEvent('ui_test_result', { framework: 'pytest', passed: 3, failed: 1 });
    expect(stripAnsi(b.chunks.join(''))).toContain('✗ pytest:');
  });

  // ── ui_approval_request ───────────────────────────────────────────────

  it('ui_approval_request is a renderer-side no-op (v4.8.1 Slice 1)', () => {
    // v4.8.1 Slice 1 — `renderUiApprovalRequest` became a silent no-op.
    // The Phase 2.5 wiring fires both this event AND the framed approval
    // panel via callbacks.promptApproval, which read as a visual
    // duplicate in live smoke. The panel is the canonical surface; this
    // event-row paint is now suppressed. The engine still fires the
    // event for telemetry / daemon-side subscribers — only the chat
    // surface paint is gone.
    const { d, chunks } = captureDisplay({ tty: true });
    d.renderUiEvent('ui_approval_request', {
      prompt: 'delete logs', risk_tier: 'medium', reason: 'cleanup task',
    });
    expect(chunks.join('')).toBe('');
  });

  // ── ui_toast ──────────────────────────────────────────────────────────

  it('ui_toast picks glyph from kind', () => {
    for (const [kind, glyph] of [['info', 'ℹ'], ['success', '✓'], ['warning', '⚠'], ['error', '✗']] as const) {
      const { d, chunks } = captureDisplay({ tty: true });
      d.renderUiEvent('ui_toast', { message: 'msg', kind });
      expect(stripAnsi(chunks.join(''))).toContain(`${glyph} msg`);
    }
  });

  // ── ui_artifact_created ───────────────────────────────────────────────

  it('ui_artifact_created paints kind-glyph + path + optional preview; kind:skill uses 🛠', () => {
    const a = captureDisplay({ tty: true });
    a.d.renderUiEvent('ui_artifact_created', { path: '/tmp/hello.py', kind: 'file', preview: 'print(1)' });
    const fileOut = stripAnsi(a.chunks.join(''));
    expect(fileOut).toContain('📄 Created: /tmp/hello.py');
    expect(fileOut).toContain('print(1)');
    const b = captureDisplay({ tty: true });
    b.d.renderUiEvent('ui_artifact_created', { path: 'mySkill', kind: 'skill' });
    expect(stripAnsi(b.chunks.join(''))).toContain('🛠 Created: mySkill');
  });
});

describe('Display v4.8.0 Slice 7 statusFooter — packed info density', () => {
  // Width-aware footer needs us to stub process.stdout.columns for each
  // case so progressive disclosure deterministically picks the tier.
  function withCols<T>(cols: number, fn: () => T): T {
    const orig = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    try { return fn(); }
    finally { Object.defineProperty(process.stdout, 'columns', { value: orig, configurable: true }); }
  }

  const BASE = {
    provider: 'chatgpt-plus', model: 'gpt-5',
    ctxUsed:  6400, ctxMax: 272_000,
    elapsedMs: 16_000,
    turnCount: 4, sessionMs: 8 * 60_000 + 29_000,
    state:    'ok' as const,
  };

  // v4.8.0 Slice 7 hotfix #3 — tier detection now uses the `│`
  // separator count (3-tier disclosure: compact=2 seps, medium=3,
  // wide=4) instead of asserting specific glyphs. `⌘`/`⏱` got swapped
  // for `#`/empty in the hotfix because hex/clover glyphs rendered
  // as boxes on many fonts. The `●` glyph is now used by BOTH the
  // context bar (filled cells) and the state dot, so literal-glyph
  // assertions are ambiguous.
  const sepCount = (s: string): number => (s.match(/│/g) || []).length;

  it('narrow (<100 cols): compact tier — 2 separators (prov│ctx│elapsed)', () => {
    withCols(80, () => {
      const d = new Display({ skin: new SkinEngine({ forceMono: true }) });
      const out = stripAnsi(d.statusFooter(BASE));
      expect(out).toContain('chatgpt-plus');
      expect(out).toContain('gpt-5');
      expect(out).toContain('%');
      expect(sepCount(out)).toBe(2);
      expect(out).not.toContain('#');  // turn segment dropped
    });
  });

  it('medium (≥100, <120 cols): 2 separators (turn counter retired)', () => {
    withCols(110, () => {
      const d = new Display({ skin: new SkinEngine({ forceMono: true }) });
      const out = stripAnsi(d.statusFooter(BASE));
      // v4.9.0 pre-ship UI: turn counter removed (value-to-pixel too low).
      expect(out).not.toMatch(/↻/);
      expect(sepCount(out)).toBe(2);
    });
  });

  it('wide (≥120 cols): 5 separators (v4.10 Slice 10.3 — brand + session-uptime + spelled "last")', () => {
    withCols(140, () => {
      const d = new Display({ skin: new SkinEngine({ forceMono: true }) });
      const out = stripAnsi(d.statusFooter(BASE));
      // v4.9.0 pre-ship UI: turn counter retired; ⌛ hourglass remains.
      expect(out).not.toMatch(/↻/);
      expect(out).toContain('⌛');
      // v4.10 Slice 10.3 — full-density tier now has 6 segments:
      //   brand · provModel │ ctxSegFull │ sessionUptime │ last <elapsed> │ stateDot
      // => 5 separators between 6 segments.
      expect(out).toMatch(/Aiden v\d/);
      expect(out).toMatch(/last\s+\d+s/);
      expect(sepCount(out)).toBe(5);
    });
  });

  it('legacy callers (no turn/session/state) collapse to compact tier', () => {
    withCols(140, () => {
      const d = new Display({ skin: new SkinEngine({ forceMono: true }) });
      const out = stripAnsi(d.statusFooter({
        provider: 'groq', model: 'llama-3.3', ctxUsed: 1_000, ctxMax: 128_000, elapsedMs: 2_000,
      }));
      expect(out).toContain('groq');
      expect(out).toContain('llama-3.3');
      expect(out).not.toContain('#');
      expect(sepCount(out)).toBe(2);
    });
  });

  it('state dot paints a semantic colour (mono-off): ok → success rgb', () => {
    withCols(140, () => {
      const d = new Display({ skin: new SkinEngine({ forceMono: false }) });
      const out = d.statusFooter(BASE);
      // default skin success = #4caf50 → rgb 76, 175, 80
      expect(out).toContain('\x1b[38;2;76;175;80m');
    });
  });

  it('80-col output fits without wrap (≤80 visible cells)', () => {
    withCols(80, () => {
      const d = new Display({ skin: new SkinEngine({ forceMono: true }) });
      const out = stripAnsi(d.statusFooter(BASE));
      // 80-col tier: no ANSI to strip in forceMono; raw len is the visible width.
      expect(out.length).toBeLessThanOrEqual(80);
    });
  });
});
