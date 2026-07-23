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

function createDisplay(columns: number, rows = 18): {
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

function composerGeometry(screen: TerminalScreen): {
  top: number;
  bottom: number;
  content: string[];
  status: string;
} {
  const lines = screen.lines();
  const top = lines.findLastIndex((line) => line.startsWith('╭─ ▲ You'));
  const bottom = lines.findLastIndex((line) => line.startsWith('╰─'));
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeGreaterThan(top);
  expect(bottom).toBe(lines.length - 2);
  expect(lines.slice(top + 1, bottom).every((line) => line.startsWith('│ '))).toBe(true);
  return {
    top,
    bottom,
    content: lines.slice(top + 1, bottom),
    status: lines.at(-1) ?? '',
  };
}

function expectExclusiveSurface(screen: TerminalScreen, statusNeedle: string): ReturnType<typeof composerGeometry> {
  const geometry = composerGeometry(screen);
  const lines = screen.lines();
  expect(geometry.status).toContain('◆');
  expect(geometry.status).toContain(statusNeedle);
  expect(lines.slice(0, geometry.top).filter((line) => line.includes('▲ You'))).toHaveLength(0);
  expect(lines.slice(0, geometry.top).filter((line) => line.includes(statusNeedle))).toHaveLength(0);
  return geometry;
}

describe.each([100, 80, 44])('boxed fixed bottom region at %i columns', (columns) => {
  it('owns empty, normal, and Unicode drafts with the hardware cursor at insertion', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('◆ provider · model │ ◉ context 2k/32k │ ⧖ 4s');
    display.setIdleComposer('', 'Type your message · /help');
    let surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines()[surface.top]).toContain('▲ You');
    expect(surface.content).toHaveLength(1);
    expect(surface.content[0]).not.toContain('Type your message');
    expect(screen.cursorPosition()).toEqual({ row: surface.top + 1, col: 2 });

    display.setIdleComposer('hello terminal', 'Type your message · /help', 5);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('hello terminal');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);
    expect(screen.cursorPosition().col).toBe(2 + 5);

    display.setIdleComposer('Unicode: नमस्ते 世界 🚀', 'Type your message · /help');
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('Unicode: नमस्ते 世界 🚀');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);

    display.setIdleComposer('A世界B', 'Type your message · /help', 'A世'.length);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('A世界B');
    expect(screen.cursorPosition()).toEqual({
      row: surface.bottom - 1,
      col: 2 + 3,
    });
  });

  it('grows upward for wrapped drafts while status remains on the final row', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);
    const draft = 'wrapped input '.repeat(12).trim();

    display.setStatusFooter('◆ provider · model │ ◉ context 2k/32k │ ⧖ 8s');
    display.setIdleComposer(draft, 'Type your message · /help');

    const surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.length).toBeGreaterThan(1);
    expect(surface.content.join(' ')).toContain('wrapped input');
    expect(screen.lines().at(-1)).toContain('⧖');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);
  });

  it('labels queue mode and keeps acknowledgements above the owned surface', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('◆ provider · model │ ◉ context 1k/32k │ ⧖ 1s');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    display.setComposer('QUEUE ONE', 'queue');
    display.write('\n✓ queued (1 pending) · input_first\n');
    display.setComposer('QUEUE TWO', 'queue');

    const surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines()[surface.top]).toContain('▲ You · queue mode');
    expect(surface.content.join('')).toContain('QUEUE TWO');
    expect(screen.lines().slice(0, surface.top).join('\n')).toContain('input_first');
    expect(screen.lines().slice(0, surface.top).join('\n')).not.toContain('QUEUE TWO');
  });

  it('keeps streaming and tool output above the composer and restores after a modal', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('◆ provider · model │ ◉ context 1k/16k │ ⧖ 1s');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const tool = display.toolRow('shell_exec', { command: 'Start-Sleep -Seconds 6' });
    display.write('streamed response\n');
    let surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines().slice(0, surface.top).join('\n')).toContain('streamed response');

    display.pauseComposerSurface();
    display.write('approval prompt\n');
    display.resumeComposerSurface();
    surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines()[surface.top]).toContain('queue mode');

    tool.ok(6_000);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines().slice(0, surface.top).join('\n')).toContain('Start-Sleep');
  });
});

describe('boxed fixed bottom region resize', () => {
  it('makes room without overwriting the existing transcript tail', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(80, 14);
    stream.write(Array.from({ length: 8 }, (_, index) => `startup transcript ${index + 1}`).join('\n'));

    display.setStatusFooter('◆ provider · model │ ◉ context 0/32k │ ⧖ 0ms');
    display.setIdleComposer('', 'Type your message · /help');

    const surface = expectExclusiveSurface(screen, 'provider');
    const transcript = screen.lines().slice(0, surface.top).join('\n');
    expect(transcript).toContain('startup transcript 8');
    expect(transcript).not.toContain('startup transcr▲');
  });

  it('preserves draft, cursor, status, and single ownership across 100 → 44 → 80', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100);
    const draft = 'a long Unicode draft 世界 that must wrap upward and survive resizing exactly';

    display.setStatusFooter('◆ provider · selected-model │ ◉ context 3k/32k │ ⧖ 9s');
    display.setIdleComposer(draft, 'Type your message · /help');
    let surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join(' ')).toContain('Unicode draft');

    stream.resize(44, 18);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.length).toBeGreaterThan(1);
    expect(surface.content.join(' ')).toContain('survive resizing exactly');

    stream.resize(80, 18);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join(' ')).toContain('Unicode draft 世界');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);
  });
});
