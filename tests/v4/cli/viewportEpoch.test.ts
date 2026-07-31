/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { TerminalScreen } from '../harness/terminalScreen';

class ViewportStream extends Writable {
  isTTY = true;

  constructor(
    readonly screen: TerminalScreen,
    public columns = 100,
    public rows = 24,
  ) {
    super({
      write: (chunk, _encoding, callback) => {
        screen.write(chunk);
        callback();
      },
    });
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.screen.resize(columns, rows);
    this.emit('resize');
  }
}

function harness(columns = 100, rows = 24): {
  display: Display;
  screen: TerminalScreen;
  stream: ViewportStream;
} {
  const screen = new TerminalScreen(columns, rows, { retainResizeHistory: true });
  const stream = new ViewportStream(screen, columns, rows);
  const display = new Display({
    stdout: stream as unknown as NodeJS.WriteStream,
    skin: new SkinEngine({ forceMono: true }),
  });
  display.setStatusFooter('◆ provider · model │ ◉ context │ ready');
  display.setIdleComposer('', 'Type your message · /help');
  return { display, screen, stream };
}

function count(lines: string[], text: string): number {
  return lines.filter((line) => line.includes(text)).length;
}

function expectCleanViewport(
  screen: TerminalScreen,
  opts: { draft?: string; active?: string } = {},
): void {
  const lines = screen.lines();
  const composerTop = lines.findIndex((line) => line.startsWith('▲ You'));
  expect(composerTop).toBeGreaterThanOrEqual(0);
  expect(count(lines, '▲ You'), screen.snapshot()).toBe(1);
  expect(count(lines, '◆ provider'), screen.snapshot()).toBe(1);
  expect(lines.at(-1)).toContain('◆ provider');
  expect(lines.at(-2)).toMatch(/^─+$/u);
  if (opts.draft) expect(lines.slice(composerTop, -1).join('\n')).toContain(opts.draft);
  if (opts.active) {
    expect(count(lines, opts.active)).toBe(1);
    expect(lines.slice(0, Math.max(0, composerTop - 1)).join('\n')).toContain(opts.active);
  } else {
    expect(lines.slice(0, Math.max(0, composerTop - 1)).every((line) => line === '')).toBe(true);
  }
  expect(screen.cursorPosition().row).toBe(composerTop + 2);
}

const previousLaneSetting = process.env.AIDEN_COMPOSER_LANE;

afterEach(() => {
  if (previousLaneSetting === undefined) delete process.env.AIDEN_COMPOSER_LANE;
  else process.env.AIDEN_COMPOSER_LANE = previousLaneSetting;
});

describe('physical viewport epochs', () => {
  it.each([
    ['startup', 'CANONICAL STARTUP\nEnvironment\nCapabilities\nBuilt solo\n'],
    ['one chat turn', '▲ You  old question\n│ Aiden\nold answer\n'],
    ['long multiline response', Array.from({ length: 80 }, (_, index) => `OLD LONG ROW ${index}`).join('\n') + '\n'],
    ['settled tool activity', '⚙ PowerShell running\n✓ PowerShell completed\n'],
    ['theme selector', 'Theme selection\naiden-ember\nmonochrome\n'],
    ['idle command row', '▲ You  /cls\n'],
  ])('clears pre-epoch %s rows without deleting footer ownership', (_name, transcript) => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = harness();
    display.write(transcript);

    display.clearScreen();

    expect(screen.snapshot()).not.toContain(transcript.split('\n')[0]);
    expect(screen.snapshot()).not.toContain('/cls');
    expectCleanViewport(screen);
  });

  it.each([
    [100, 16], [100, 24], [100, 35], [100, 45], [100, 60], [44, 24], [80, 35],
  ])('keeps the new epoch clean through a %i x %i viewport', async (columns, rows) => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = harness(100, 24);
    display.write('OLD BEFORE RESIZE\n'.repeat(40));
    display.clearScreen();

    stream.resize(columns, rows);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(screen.snapshot()).not.toContain('OLD BEFORE RESIZE');
    expectCleanViewport(screen);
  });

  it('retains active provider and tool rows across clear and later ticks', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = harness();
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    display.write('OLD ACTIVE TURN\n');
    const provider = display.liveActivityRow('calling provider');
    const tool = display.toolRow('file_read', { path: 'C:\\workspace\\active.txt' }, undefined, {
      activityId: 'viewport-active-tool', externalTicker: true,
    });

    display.clearScreen();
    provider.refresh(1);
    tool.refresh?.();

    expect(screen.snapshot()).not.toContain('OLD ACTIVE TURN');
    expectCleanViewport(screen, { active: 'Aiden is thinking' });
    expect(count(screen.lines(), 'active.txt')).toBe(1);
    tool.ok(25);
    provider.stop();
  });

  it('preserves a queue draft while clearing all prior transcript rows', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = harness(44, 24);
    display.write('OLD QUEUE TURN\n');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    display.setComposer('QUEUE TWO SURVIVES', 'queue');

    display.clearScreen();

    expect(screen.snapshot()).not.toContain('OLD QUEUE TURN');
    expectCleanViewport(screen, { draft: 'QUEUE TWO SURVIVES' });
    expect(screen.snapshot()).toContain('queue mode');
  });

  it('defers a clear requested during modal ownership and restores only the new epoch', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = harness();
    display.write('OLD BEFORE APPROVAL\n');
    display.pauseComposerSurface();
    display.write('Approval required\nDecision: Once\n');

    display.clearScreen();
    display.resumeComposerSurface();

    expect(screen.snapshot()).not.toContain('OLD BEFORE APPROVAL');
    expect(screen.snapshot()).not.toContain('Approval required');
    expectCleanViewport(screen);
  });

  it('does not resurrect rows on theme repaint, status tick, or activity animation', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = harness();
    display.write('OLD BEFORE REPAINT\n');
    const provider = display.liveActivityRow('calling provider');
    display.clearScreen();

    display.refreshTheme();
    display.setStatusFooter('◆ provider · model │ ◉ context │ 2s');
    provider.refresh(3);

    expect(screen.snapshot()).not.toContain('OLD BEFORE REPAINT');
    expectCleanViewport(screen, { active: 'Aiden is thinking' });
    provider.stop();
  });

  it('shows only a new prompt while retaining the prior model conversation outside the viewport', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = harness();
    display.write('OLD MODEL CONTEXT ROW\n');
    display.clearScreen();

    display.submitIdleComposer('NEW PROMPT', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');

    expect(screen.snapshot()).not.toContain('OLD MODEL CONTEXT ROW');
    expect(screen.snapshot()).toContain('NEW PROMPT');
    expect(count(screen.lines(), 'NEW PROMPT')).toBe(1);
    expect(count(screen.lines(), 'Aiden is thinking')).toBe(1);
    provider.stop();
  });

  it('keeps the epoch boundary after bottom-region teardown and remount', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = harness();
    display.write('OLD BEFORE REMOUNT\n');
    display.clearScreen();
    display.releaseBottomRegion();

    display.setStatusFooter('◆ provider · model │ ◉ context │ ready');
    display.setIdleComposer('', 'Type your message · /help');

    expect(screen.snapshot()).not.toContain('OLD BEFORE REMOUNT');
    expectCleanViewport(screen);
  });

  it('hides ten thousand retained rows without replaying them on later repaint', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = harness();
    display.write(Array.from({ length: 10_000 }, (_, index) => `OLD BULK ROW ${index}`).join('\n') + '\n');
    display.clearScreen();

    display.setStatusFooter('◆ provider · model │ ◉ context │ 3s');
    display.refreshTheme();

    expect(screen.snapshot()).not.toContain('OLD BULK ROW');
    expectCleanViewport(screen);
  });
});
