/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { TerminalScreen } from '../harness/terminalScreen';

class ScreenStream extends Writable {
  isTTY = true;
  columns: number;
  rows: number;

  constructor(
    readonly screen: TerminalScreen,
    columns: number,
    rows: number,
  ) {
    super({
      write: (chunk, _encoding, callback) => {
        screen.write(chunk);
        callback();
      },
    });
    this.columns = columns;
    this.rows = rows;
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.screen.resize(columns, rows);
    this.emit('resize');
  }
}

const previousLaneSetting = process.env.AIDEN_COMPOSER_LANE;

afterEach(() => {
  if (previousLaneSetting === undefined) delete process.env.AIDEN_COMPOSER_LANE;
  else process.env.AIDEN_COMPOSER_LANE = previousLaneSetting;
});

function createDisplay(columns: number, rows = 16): {
  display: Display;
  screen: TerminalScreen;
  stream: ScreenStream;
} {
  const screen = new TerminalScreen(columns, rows);
  const stream = new ScreenStream(screen, columns, rows);
  const display = new Display({
    stdout: stream as unknown as NodeJS.WriteStream,
    skin: new SkinEngine({ forceMono: true }),
  });
  return { display, screen, stream };
}

function expectFixedFooter(screen: TerminalScreen, statusNeedle: string, composerNeedle: string): void {
  const lines = screen.lines();
  expect(lines.at(-1)).toContain(statusNeedle);
  expect(lines.at(-2)).toContain(composerNeedle);
  expect(lines.slice(0, -2).filter((line) => line.includes(statusNeedle))).toHaveLength(0);
  expect(lines.slice(0, -2).filter((line) => line.includes(composerNeedle))).toHaveLength(0);
}

describe.each([100, 44])('fixed two-row bottom region at %i columns', (columns) => {
  it('keeps composer and status fixed across normal and queued submissions', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('groq · selected-model · ctx 2k/32k · 4s');
    display.setIdleComposer('', 'Type your message · /help · /mode');
    expectFixedFooter(screen, 'groq', 'Type your message');

    display.setIdleComposer('NORMAL ENTER', 'Type your message · /help · /mode');
    display.submitIdleComposer('NORMAL ENTER', 'Type your message · /help · /mode');
    expect(screen.lines().slice(0, -2).join('\n')).toContain('NORMAL ENTER');
    expectFixedFooter(screen, 'groq', 'Type your message');

    display.setBusyHint('Enter → queue · /busy to change · Ctrl+C stop');
    display.setComposer('QUEUE ONE', 'queue');
    display.write('\n✓ queued (1 pending) · input_first\n');
    display.setComposer('', 'queue');
    expect(screen.lines().slice(0, -2).join('\n')).toContain('input_first');
    expectFixedFooter(screen, 'groq', 'Enter → queue');

    display.setComposer('QUEUE TWO', 'queue');
    display.write('\n✓ queued (2 pending) · input_second\n');
    display.setComposer('', 'queue');
    expect(screen.lines().slice(0, -2).join('\n')).toContain('input_second');
    expectFixedFooter(screen, 'groq', 'Enter → queue');
  });

  it('keeps tool output above the footer and restores both rows after a modal', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('provider · model · ctx 1k/16k · 1s');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const tool = display.toolRow('shell_exec', { command: 'Start-Sleep -Seconds 6' });
    expectFixedFooter(screen, 'provider', 'Enter → queue');

    display.pauseComposerSurface();
    display.write('approval prompt\n');
    display.resumeComposerSurface();
    expectFixedFooter(screen, 'provider', 'Enter → queue');

    tool.ok(6_000);
    expectFixedFooter(screen, 'provider', 'Enter → queue');
  });
});

describe('fixed two-row bottom region resize', () => {
  it('preserves the complete draft and status while resizing wide to narrow and back', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100);
    const draft = 'a long draft that must survive terminal resizing exactly';

    display.setStatusFooter('provider · selected-model · ctx 3k/32k · 9s');
    display.setIdleComposer(draft, 'Type your message · /help · /mode');
    expectFixedFooter(screen, 'provider', 'draft');

    stream.resize(44, 16);
    expectFixedFooter(screen, 'provider', 'resizing exactly');

    stream.resize(100, 16);
    expectFixedFooter(screen, 'provider', draft);
  });
});
