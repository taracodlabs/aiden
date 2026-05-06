import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';

import {
  formatStatusLine,
  formatStatusState,
  renderColouredProgressBar,
  type StatusState,
} from '../../../cli/v4/chatSession';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeDisplay(opts: { mono: boolean }): Display {
  const out = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return new Display({
    skin: new SkinEngine({ forceMono: opts.mono }),
    stdout: out,
  });
}

describe('formatStatusState (Phase 22 Task 4)', () => {
  it('ready returns the literal "ready" in muted', () => {
    expect(formatStatusState({ kind: 'ready' })).toEqual({
      text: 'ready',
      colour: 'muted',
    });
  });

  it('generating shows ⏵ + duration in brand', () => {
    const out = formatStatusState({ kind: 'generating', sinceMs: 0 }, 12_400);
    expect(out.colour).toBe('brand');
    expect(out.text).toMatch(/^⏵ /);
    // Duration is formatted as something like "12s" or "12.4s" depending on
    // formatDuration's resolution — check the prefix is right.
    expect(out.text.length).toBeGreaterThan(2);
  });

  it('exec shows ▶ exec in brand', () => {
    expect(formatStatusState({ kind: 'exec' })).toEqual({
      text: '▶ exec',
      colour: 'brand',
    });
  });

  it('approve shows ⊕ approve in warn', () => {
    expect(formatStatusState({ kind: 'approve' })).toEqual({
      text: '⊕ approve',
      colour: 'warn',
    });
  });

  it('retry shows ⚠ retry <Ns> in warn, counting down', () => {
    const out = formatStatusState(
      { kind: 'retry', retryUntilMs: 30_000 },
      0,
    );
    expect(out.colour).toBe('warn');
    expect(out.text).toMatch(/^⚠ retry 30s$/);
  });

  it('retry pinned to 0 once the deadline passes', () => {
    const out = formatStatusState(
      { kind: 'retry', retryUntilMs: 100 },
      5_000,
    );
    expect(out.text).toMatch(/⚠ retry 0s/);
  });

  it('generating duration starts at 0 when called at exactly sinceMs', () => {
    const out = formatStatusState({ kind: 'generating', sinceMs: 1000 }, 1000);
    expect(out.text).toBe('⏵ 0s');
  });
});

describe('formatStatusLine (Phase 22 Task 4)', () => {
  const baseArgs = {
    provider: 'together',
    model: 'Qwen3-235B',
    usedTokens: 0,
    maxTokens: 131_072,
    turn: 0,
    maxTurns: 90,
  };

  it('uses vertical-bar separators between every segment', () => {
    const display = makeDisplay({ mono: true });
    const line = stripAnsi(formatStatusLine({
      ...baseArgs,
      state: { kind: 'ready' },
      display,
    }));
    // Three separators: provider|ctx, ctx|budget, budget|state.
    const seps = line.match(/ │ /g) ?? [];
    expect(seps.length).toBe(3);
  });

  it('renders the four segments in order: provider:model, ctx, budget, state', () => {
    const display = makeDisplay({ mono: true });
    const line = stripAnsi(formatStatusLine({
      ...baseArgs,
      state: { kind: 'ready' },
      display,
    }));
    const segments = line.split(' │ ');
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe('together:Qwen3-235B');
    expect(segments[1]).toMatch(/^ctx /);
    expect(segments[2]).toMatch(/^budget 0\/90$/);
    expect(segments[3]).toBe('ready');
  });

  it('right-most segment shows generating duration when in flight', () => {
    const display = makeDisplay({ mono: true });
    const line = stripAnsi(formatStatusLine({
      ...baseArgs,
      state: { kind: 'generating', sinceMs: 1_000 },
      display,
      now: 4_000,
    }));
    const segments = line.split(' │ ');
    expect(segments.at(-1)).toMatch(/^⏵ /);
  });

  it('right-most segment cycles through every state kind', () => {
    const display = makeDisplay({ mono: true });
    const states: StatusState[] = [
      { kind: 'ready' },
      { kind: 'generating', sinceMs: 0 },
      { kind: 'exec' },
      { kind: 'approve' },
      { kind: 'retry', retryUntilMs: 5_000 },
    ];
    const right: string[] = [];
    for (const state of states) {
      const line = stripAnsi(formatStatusLine({ ...baseArgs, state, display, now: 0 }));
      right.push(line.split(' │ ').at(-1)!);
    }
    expect(right[0]).toBe('ready');
    expect(right[1]).toMatch(/^⏵ /);
    expect(right[2]).toBe('▶ exec');
    expect(right[3]).toBe('⊕ approve');
    expect(right[4]).toMatch(/^⚠ retry/);
  });

  it('progress bar uses ▓ for filled and ░ for empty cells', () => {
    const display = makeDisplay({ mono: true });
    const line = stripAnsi(formatStatusLine({
      ...baseArgs,
      usedTokens: Math.round(0.5 * baseArgs.maxTokens),
      state: { kind: 'ready' },
      display,
    }));
    const ctxSegment = line.split(' │ ')[1];
    expect(ctxSegment).toMatch(/\[▓+░+\]/);
  });

  it('coloured output uses the soft-cyan #6FB3D2 separator (no grey)', () => {
    // Ensures Group A's muted-colour change actually applies to the
    // status bar separators rather than re-introducing grey here.
    const display = makeDisplay({ mono: false });
    const line = formatStatusLine({
      ...baseArgs,
      state: { kind: 'ready' },
      display,
    });
    // Soft cyan #6FB3D2 = rgb 111, 179, 210.
    expect(line).toContain('\x1b[38;2;111;179;210m');
    // No grey #808080 anywhere.
    expect(line).not.toContain('\x1b[38;2;128;128;128m');
  });

  it('coloured output uses the brand orange #FF6B35 for filled progress cells', () => {
    const display = makeDisplay({ mono: false });
    const line = formatStatusLine({
      ...baseArgs,
      usedTokens: Math.round(0.5 * baseArgs.maxTokens),
      state: { kind: 'ready' },
      display,
    });
    // Brand orange #FF6B35 = rgb 255, 107, 53.
    expect(line).toContain('\x1b[38;2;255;107;53m');
  });
});

describe('renderColouredProgressBar', () => {
  it('produces width-many cells with [ ... ] delimiters', () => {
    const display = makeDisplay({ mono: true });
    const bar = stripAnsi(renderColouredProgressBar(50, 100, 10, display));
    expect(bar.startsWith('[')).toBe(true);
    expect(bar.endsWith(']')).toBe(true);
    // 10 inner cells.
    expect(bar.length).toBe(12);
  });

  it('all empty when used=0', () => {
    const display = makeDisplay({ mono: true });
    expect(stripAnsi(renderColouredProgressBar(0, 100, 6, display))).toBe('[░░░░░░]');
  });

  it('all filled when used=max', () => {
    const display = makeDisplay({ mono: true });
    expect(stripAnsi(renderColouredProgressBar(100, 100, 6, display))).toBe('[▓▓▓▓▓▓]');
  });
});
