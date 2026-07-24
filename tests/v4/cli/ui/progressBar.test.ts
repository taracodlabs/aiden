/**
 * v4.9.1 — progress bar renderer + state machine.
 * Pure-function tests for renderLine + detectRenderMode + phase mapping;
 * stream tests for animated lifecycle (paint, complete, fail).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import {
  detectRenderMode,
  renderLine,
  startProgressBar,
  startPhaseIndicator,
  detectNpmPhase,
  npmInstallPhasePercent,
} from '../../../../cli/v4/ui/progressBar';

function captureStream(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  return { stream, chunks };
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

describe('detectRenderMode', () => {
  it('non-TTY → plain text, no color, no blocks, not animated', () => {
    expect(detectRenderMode(false, {})).toEqual({ color: false, blocks: false, animated: false });
  });
  it('TTY default → color + blocks + animated', () => {
    expect(detectRenderMode(true, {})).toEqual({ color: true, blocks: true, animated: true });
  });
  it('TTY + NO_COLOR → no color, still blocks + animated', () => {
    const m = detectRenderMode(true, { NO_COLOR: '1' });
    expect(m.color).toBe(false);
    expect(m.blocks).toBe(true);
    expect(m.animated).toBe(true);
  });
  it('TTY + TERM=dumb → no color, no blocks (use #-), still animated', () => {
    const m = detectRenderMode(true, { TERM: 'dumb' });
    expect(m.color).toBe(false);
    expect(m.blocks).toBe(false);
  });
  it('TTY + CI=true → degraded like dumb', () => {
    const m = detectRenderMode(true, { CI: 'true' });
    expect(m.color).toBe(false);
    expect(m.blocks).toBe(false);
  });
});

describe('renderLine', () => {
  const base = { width: 10, percent: 50, phase: 'downloading', elapsedMs: 3200 } as const;
  it('block glyphs + color', () => {
    const line = renderLine({ ...base, mode: { color: true, blocks: true, animated: true } });
    expect(line).toMatch(/█████░░░░░/);
    expect(line).toMatch(/50%/);
    expect(line).toMatch(/downloading/);
    expect(line).toMatch(/3\.2s/);
    expect(line).toMatch(/\x1b\[/);
  });
  it('block glyphs + NO_COLOR (no ANSI)', () => {
    const line = renderLine({ ...base, mode: { color: false, blocks: true, animated: true } });
    expect(line).toMatch(/█████░░░░░/);
    expect(line).not.toMatch(/\x1b\[/);
  });
  it('dumb terminal → #- fallback', () => {
    const line = renderLine({ ...base, mode: { color: false, blocks: false, animated: false } });
    expect(line).toMatch(/#####-----/);
    expect(line).not.toMatch(/█/);
    expect(line).not.toMatch(/░/);
  });
  it('clamps percent to [0,100]', () => {
    const lo = renderLine({ ...base, percent: -5, mode: { color: false, blocks: true, animated: true } });
    const hi = renderLine({ ...base, percent: 150, mode: { color: false, blocks: true, animated: true } });
    expect(lo).toMatch(/0%/);
    expect(hi).toMatch(/100%/);
  });
});

describe('npm phase helpers', () => {
  it('phase → percent mapping covers the install timeline', () => {
    expect(npmInstallPhasePercent('spawning'))    .toBeLessThan(npmInstallPhasePercent('resolving'));
    expect(npmInstallPhasePercent('resolving'))   .toBeLessThan(npmInstallPhasePercent('downloading'));
    expect(npmInstallPhasePercent('downloading')) .toBeLessThan(npmInstallPhasePercent('extracting'));
    expect(npmInstallPhasePercent('extracting'))  .toBeLessThan(npmInstallPhasePercent('verifying'));
    expect(npmInstallPhasePercent('installed')).toBe(100);
    expect(npmInstallPhasePercent('failed'))   .toBe(100);
    expect(npmInstallPhasePercent('unknown'))  .toBe(0);
  });
  it('detectNpmPhase reads common npm output patterns', () => {
    expect(detectNpmPhase('added 247 packages in 4s')).toBe('verifying');
    expect(detectNpmPhase('npm http fetch GET 200 https://registry'))
      .toBe('downloading');
    // "reify:<pkg>: extract" → extracting (extract keyword wins over reify).
    expect(detectNpmPhase('reify:better-sqlite3: extract'))
      .toBe('extracting');
    // Plain reify lines (no extract keyword) map to downloading.
    expect(detectNpmPhase('reify:better-sqlite3 ━━╸'))
      .toBe('downloading');
    expect(detectNpmPhase('npm WARN unrelated text')).toBeNull();
  });
});

describe('startProgressBar — stream behavior', () => {
  let cap: ReturnType<typeof captureStream>;
  beforeEach(() => { cap = captureStream(); });

  it('writes label immediately, paints status on complete', () => {
    const bar = startProgressBar({
      label: 'Installing aiden-runtime v4.9.1...',
      phases: ['spawning', 'installed'],
      out: cap.stream, isTTY: false, env: {},
    });
    bar.complete('Updated to 4.9.1');
    const out = stripAnsi(cap.chunks.join(''));
    expect(out).toMatch(/Installing aiden-runtime v4\.9\.1/);
    expect(out).toMatch(/✓ Updated to 4\.9\.1/);
  });
  it('fail() emits ✗ + message', () => {
    const bar = startProgressBar({
      label: 'L', phases: ['spawning'], out: cap.stream, isTTY: false, env: {},
    });
    bar.fail('Permission denied');
    const out = stripAnsi(cap.chunks.join(''));
    expect(out).toMatch(/✗ Permission denied/);
  });
  it('non-TTY → no ANSI sequences in output', () => {
    const bar = startProgressBar({
      label: 'L', phases: ['spawning', 'installed'],
      out: cap.stream, isTTY: false, env: {},
    });
    bar.setPhase('installed');
    bar.complete('done');
    expect(cap.chunks.join('')).not.toMatch(/\x1b\[/);
  });
  it('NO_COLOR=1 → no ANSI sequences even when TTY', () => {
    const bar = startProgressBar({
      label: 'L', phases: ['spawning', 'installed'],
      out: cap.stream, isTTY: true, env: { NO_COLOR: '1' },
    });
    bar.complete('done');
    expect(cap.chunks.join('')).not.toMatch(/\x1b\[3[0-9]/);
  });
  it('idempotent close: second complete() is a no-op', () => {
    const bar = startProgressBar({
      label: 'L', phases: ['spawning'], out: cap.stream, isTTY: false, env: {},
    });
    bar.complete('once');
    const len = cap.chunks.join('').length;
    bar.complete('twice');
    expect(cap.chunks.join('').length).toBe(len);
  });
});

describe('startPhaseIndicator — truthful indeterminate updater status', () => {
  it('renders phases without a fabricated numeric percentage', () => {
    const cap = captureStream();
    const indicator = startPhaseIndicator({
      label: 'Updating aiden-runtime 4.16.0',
      phases: ['checking installation', 'installing', 'verifying'],
      out: cap.stream,
      isTTY: false,
      env: {},
    });
    indicator.setPhase('installing');
    indicator.setPhase('verifying');
    indicator.complete('Update verified.');
    const output = stripAnsi(cap.chunks.join(''));
    expect(output).toContain('checking installation');
    expect(output).toContain('installing');
    expect(output).toContain('verifying');
    expect(output).not.toMatch(/\b\d+%/);
  });

  it('stops its only timer exactly once on cancellation', () => {
    const cap = captureStream();
    const indicator = startPhaseIndicator({
      label: 'Updating',
      phases: ['installing'],
      out: cap.stream,
      isTTY: true,
      env: { NO_COLOR: '1' },
      tickMs: 5,
    });
    indicator.cancel('Update cancelled.');
    const atCancel = cap.chunks.length;
    indicator.cancel('duplicate');
    indicator.setPhase('verifying');
    expect(cap.chunks.length).toBe(atCancel);
  });
});
