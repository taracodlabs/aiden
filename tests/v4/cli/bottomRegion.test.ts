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
import { renderBottomSurface } from '../../../cli/v4/composerLane';
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

it('applies the active theme to the composer title and restrained frame without changing geometry', () => {
  const renderStyled = renderBottomSurface as unknown as (...args: unknown[]) => ReturnType<typeof renderBottomSurface>;
  const styled = renderStyled(
    24,
    80,
    { draft: 'hello', mode: 'idle' },
    '◆ provider · model',
    {
      brand: (value: string) => `\x1b[31m${value}\x1b[39m`,
      muted: (value: string) => `\x1b[90m${value}\x1b[39m`,
    },
  );
  const text = styled.lines.join('\n');
  expect(text).toContain('\x1b[31m▲ You\x1b[39m');
  expect(text).toContain('\x1b[90m╭─ \x1b[39m');
  expect(styled.cursorCol).toBe(8);
});

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

function semanticGap(lines: string[], before: string, after: string): number {
  const beforeRow = lines.findLastIndex((line) => line.includes(before));
  const afterRow = lines.findLastIndex((line) => line.includes(after));
  expect(beforeRow, `missing semantic row: ${before}`).toBeGreaterThanOrEqual(0);
  expect(afterRow, `missing semantic row: ${after}`).toBeGreaterThan(beforeRow);
  return afterRow - beforeRow - 1;
}

describe('compact hybrid transcript geometry', () => {
  it('renders distinct prompt and answer blocks without attaching to activity output', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(80, 24);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('Fix `src/math.mjs` and run its focused test.', 'Type your message · /help');
    const activity = display.toolRow('shell_exec', { command: 'npm test -- math' }, undefined, {
      activityId: 'tool_test', externalTicker: true,
    });
    activity.ok(40);
    display.printTurnSeparator();
    display.write(display.agentTurn('Fixed `src/math.mjs`. The focused test passed.'));

    const transcript = screen.lines().slice(0, composerGeometry(screen).top);
    const userRow = transcript.findIndex((line) => line.includes('You'));
    const toolRow = transcript.findIndex((line) => line.includes('npm test'));
    const answerRow = transcript.findIndex((line) => line.includes('Aiden'));
    expect(userRow).toBeGreaterThanOrEqual(0);
    expect(toolRow).toBeGreaterThan(userRow);
    expect(answerRow).toBeGreaterThan(toolRow);
    expect(transcript.slice(userRow, toolRow).some((line) => /^\s*─{10,}\s*$/u.test(line))).toBe(true);
    expect(transcript.slice(toolRow, answerRow).some((line) => /^\s*─{10,}\s*$/u.test(line))).toBe(true);
  });
  it('wraps transcript prose at word boundaries when the word fits the terminal', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(44, 18);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.write('12345678901234567890123456789012345678 ownership remains stable\n');

    const surface = composerGeometry(screen);
    const transcript = screen.lines().slice(0, surface.top);
    expect(transcript.some((line) => line.includes('ownership')), screen.snapshot()).toBe(true);
    expect(transcript.some((line) => /owner$|^ship\b/u.test(line.trim()))).toBe(false);
  });

  it('replaces repeated task updates in one stable live row before settlement', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(80, 18);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');

    display.renderUiEvent('ui_task_update', {
      task_id: 'task_index', label: 'Index repository', status: 'running',
    });
    display.renderUiEvent('ui_task_update', {
      task_id: 'task_index', label: 'Index repository: 42 files', status: 'running',
    });

    const visible = screen.snapshot();
    expect(visible.match(/Index repository/gu)).toHaveLength(1);
    expect(visible).toContain('Index repository: 42 files');

    display.renderUiEvent('ui_task_done', {
      task_id: 'task_index', status: 'success', summary: '42 files indexed',
    });
    display.renderUiEvent('ui_task_done', {
      task_id: 'task_index', status: 'success', summary: '42 files indexed',
    });
    const completed = screen.snapshot();
    expect(completed.match(/Index repository: 42 files/gu)).toHaveLength(1);
    expect(completed.match(/42 files indexed/gu)).toHaveLength(1);
    expect(completed).toContain('✓ 42 files indexed');
    expect(completed).not.toContain('◐ Working');
  });
  it.each([16, 24, 35, 45, 60])(
    'keeps provider activity adjacent to a short prompt at %i rows',
    (rows) => {
      delete process.env.AIDEN_COMPOSER_LANE;
      const { display, screen } = createDisplay(100, rows);
      display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
      display.setIdleComposer('', 'Type your message · /help');
      display.submitIdleComposer('compact provider request', 'Type your message · /help');
      display.setBusyHint('Enter → queue · Ctrl+C stop');
      const provider = display.liveActivityRow('calling provider');

      expect(semanticGap(screen.lines(), 'compact provider request', 'calling provider')).toBeLessThanOrEqual(1);
      provider.stop();
    },
  );

  it('keeps provider activity adjacent to the final wrapped prompt row', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(44, 45);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer(
      'wrapped request keeps every semantic neighbor close FINAL-PROMPT-LINE',
      'Type your message · /help',
    );
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');

    expect(semanticGap(screen.lines(), 'FINAL-PROMPT-LINE', 'calling provider')).toBeLessThanOrEqual(1);
    provider.stop();
  });

  it('keeps compact spacing while terminal height changes during provider activity', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 24);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('resize provider request', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');

    for (const rows of [60, 16, 35]) {
      stream.resize(100, rows);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(semanticGap(screen.lines(), 'resize provider request', 'calling provider')).toBeLessThanOrEqual(1);
    }
    provider.stop();
  });

  it('keeps provider and tool activity in semantic order without filler rows', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(100, 45);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('inspect the package manifest', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');
    const tool = display.toolRow('file_read', { path: 'package.json' }, undefined, {
      activityId: 'activity_package_read',
    });

    const lines = screen.lines();
    expect(semanticGap(lines, 'inspect the package manifest', 'calling provider')).toBeLessThanOrEqual(1);
    expect(semanticGap(lines, 'calling provider', 'package.json')).toBe(0);
    tool.ok(20);
    provider.stop();
  });

  it('places the final response immediately after the active provider phase', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(100, 35);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('return one concise answer', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');
    expect(semanticGap(screen.lines(), 'return one concise answer', 'calling provider')).toBeLessThanOrEqual(1);

    provider.stop();
    display.write(display.agentHeader());
    display.write('FINAL COMPACT RESPONSE\n');
    expect(semanticGap(screen.lines(), 'return one concise answer', 'Aiden')).toBeLessThanOrEqual(1);
    expect(semanticGap(screen.lines(), 'Aiden', 'FINAL COMPACT RESPONSE')).toBeLessThanOrEqual(1);
  });

  it('opens approval at the active semantic boundary and restores the footer', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(100, 35);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('request a guarded action', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');
    expect(semanticGap(screen.lines(), 'request a guarded action', 'calling provider')).toBeLessThanOrEqual(1);

    provider.stop();
    display.pauseComposerSurface();
    display.write('Approval required\n');
    expect(semanticGap(screen.lines(), 'request a guarded action', 'Approval required')).toBeLessThanOrEqual(1);
    display.resumeComposerSurface();
    expect(screen.lines().at(-1)).toContain('provider');
  });

  it.each(['clear', 'cls'])('starts a compact provider block after /%s projection reset', (command) => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(100, 35);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('OLD VISIBLE REQUEST', 'Type your message · /help');
    display.clearScreen();
    if (command === 'clear') display.success('New chat started');
    display.submitIdleComposer(`request after ${command}`, 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');

    expect(screen.snapshot()).not.toContain('OLD VISIBLE REQUEST');
    expect(semanticGap(screen.lines(), `request after ${command}`, 'calling provider')).toBeLessThanOrEqual(1);
    provider.stop();
  });
});
