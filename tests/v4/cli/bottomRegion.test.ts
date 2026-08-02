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
import { BottomRegion, renderBottomSurface } from '../../../cli/v4/composerLane';
import { primeFrameAsync } from '../../../cli/v4/display/frame';
import { TerminalScreen } from '../harness/terminalScreen';

class ScreenStream extends Writable {
  isTTY = true;
  columns: number;
  rows: number;
  readonly writes: string[] = [];

  constructor(
    readonly screen: TerminalScreen,
    columns: number,
    rows: number,
  ) {
    super({
      write: (chunk, _encoding, callback) => {
        this.writes.push(chunk.toString());
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

it('applies the active theme to the borderless composer hierarchy without changing geometry', () => {
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
  expect(text).toContain(`\x1b[90m${'─'.repeat(79)}\x1b[39m`);
  expect(text).toContain(`\x1b[90m${'─'.repeat(21)}\x1b[39m`);
  expect(styled.cursorCol).toBe(6);
});

it('renders the borderless composer hierarchy with the draft at terminal column one', () => {
  const surface = renderBottomSurface(
    18,
    44,
    {
      draft: 'Draft begins here and wraps naturally across the available terminal width.',
      mode: 'idle',
      cursorIndex: 5,
    },
    '◆ provider/model │ context │ phase │ timer',
    { brand: (value) => value, muted: (value) => value, unicode: true },
  );

  expect(surface.lines[0]).toBe('─'.repeat(43));
  expect(surface.lines[1]).toBe('▲ You');
  expect(surface.lines[2]).toBe('─'.repeat(21));
  expect(surface.lines[3]?.startsWith('Draft')).toBe(true);
  expect(surface.lines[3]?.[0]).toBe('D');
  expect(surface.lines.slice(3, -2).every((line) => line.length <= 43)).toBe(true);
  expect(surface.lines.slice(3, -2).join('')).toBe(
    'Draft begins here and wraps naturally across the available terminal width.',
  );
  expect(surface.lines.at(-2)).toBe('─'.repeat(43));
  expect(surface.lines.at(-1)).toContain('◆ provider/model');
  expect(surface.lines.join('\n')).not.toMatch(/[╭╮╰╯│]\s*Draft/u);
  expect(surface.cursorCol).toBe(6);
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
  const screen = new TerminalScreen(columns, rows, { retainResizeHistory: true });
  const stream = new ScreenStream(screen, columns, rows);
  const display = new Display({
    stdout: stream as unknown as NodeJS.WriteStream,
    skin: new SkinEngine({ forceMono: true }),
  });
  return { display, screen, stream };
}

it.each([44, 80, 100, 120, 160])(
  'preserves complete bounded read ranges at %i columns',
  (columns) => {
    const { display, screen } = createDisplay(columns, 30);
    display.setStatusFooter('◆ provider/model │ context │ phase │ timer');
    display.setIdleComposer('', 'Type your message');
    const row = display.toolRow('file_read', {
      path: 'C:\\workspace\\cli\\v4\\display.ts', offset: 7_000, limit: 80,
    }, undefined, { activityId: `read-range-${columns}` });
    row.ok(12);
    const output = screen.lines().join('\n');
    expect(output).toContain('chars 7000–7079');
    expect(output).not.toMatch(/chars 7000–(?:\s|$)/u);
  },
);

it('aggregates equivalent compact read rows while preserving distinct ranges', () => {
  const { display, screen } = createDisplay(100, 35);
  display.setStatusFooter('◆ provider/model │ context │ phase │ timer');
  display.setIdleComposer('', 'Type your message');
  const args = { path: 'C:\\workspace\\cli\\v4\\display.ts', offset: 120, limit: 80 };
  display.toolRow('file_read', args, undefined, { activityId: 'read-a' }).ok(10);
  display.toolRow('file_read', args, undefined, { activityId: 'read-b' }).ok(11);
  display.toolRow('file_read', { ...args, offset: 200 }, undefined, { activityId: 'read-c' }).ok(12);

  const output = screen.lines().join('\n');
  expect(output.match(/chars 120–199/gu)).toHaveLength(1);
  expect(output.match(/chars 200–279/gu)).toHaveLength(1);
});

it('projects one compact shell activity when the semantic command-result event also arrives', () => {
  const { display, screen } = createDisplay(100, 35);
  display.setStatusFooter('◆ provider/model │ context │ phase │ timer');
  display.setIdleComposer('', 'Type your message');
  display.toolRow('shell_exec', { command: 'Get-Location' }, undefined, {
    activityId: 'shell-one',
  }).ok(14);
  display.toolRow('ui_command_result', { command: 'Get-Location' }, undefined, {
    activityId: 'ui-result-one',
  }).ok(14);
  display.renderUiEvent('ui_command_result', {
    command: 'Get-Location', stdout: 'C:\\workspace', exit_code: 0,
  });

  const output = screen.lines().join('\n');
  expect(output.match(/completed Get-Location/gu)).toHaveLength(1);
  expect(output).not.toContain('✓ Get-Location — completed');
});

it('keeps settled assistant transcript immutable after a late activity repaint', () => {
  const { display, screen } = createDisplay(100, 35);
  display.setStatusFooter('◆ provider/model │ context │ completing │ 1s');
  display.setIdleComposer('', 'Type your message');
  const activity = display.toolRow('file_read', { path: 'package.json' }, undefined, {
    activityId: 'late-read',
  });
  activity.ok(10);
  display.streamPartial('FINAL STABLE RESPONSE');
  display.streamComplete();
  activity.refresh();
  display.setStatusFooter('◆ provider/model │ context │ ready │ 1s');
  display.setIdleComposer('', 'Type your message');

  const lines = screen.lines();
  const output = lines.join('\n');
  expect(output.match(/FINAL STABLE RESPONSE/gu)).toHaveLength(1);
  expect(output.match(/▲ You/gu)).toHaveLength(1);
  const activityRow = lines.findLastIndex((line) => line.includes('package.json'));
  const responseRow = lines.findLastIndex((line) => line.includes('FINAL STABLE RESPONSE'));
  expect(lines.slice(activityRow + 1, responseRow).filter((line) => line.trim() === '').length).toBeLessThanOrEqual(1);
});

function composerGeometry(screen: TerminalScreen): {
  topSeparator: number;
  top: number;
  divider: number;
  bottom: number;
  content: string[];
  status: string;
} {
  const lines = screen.lines();
  const top = lines.findLastIndex((line) => line.startsWith('▲ You'));
  const topSeparator = top - 1;
  const divider = top + 1;
  const bottom = lines.length - 2;
  expect(top).toBeGreaterThanOrEqual(0);
  expect(lines[topSeparator]).toMatch(/^─+$/u);
  expect(lines[divider]).toBe('─'.repeat(Math.min(21, lines[divider]?.length ?? 0)));
  expect(bottom).toBeGreaterThan(top);
  expect(lines[bottom]).toMatch(/^─+$/u);
  expect(lines.slice(top + 2, bottom).every((line) => !/^[ \t]/u.test(line))).toBe(true);
  const owned = lines.slice(topSeparator);
  expect(owned.filter((line) => line.startsWith('▲ You'))).toHaveLength(1);
  expect(owned.filter((line) => line === lines[divider])).toHaveLength(1);
  expect(owned.filter((line) => line === lines[topSeparator])).toHaveLength(2);
  return {
    topSeparator,
    top,
    divider,
    bottom,
    content: lines.slice(top + 2, bottom),
    status: lines.at(-1) ?? '',
  };
}

function createRegionHarness(reflowSafe: boolean, columns = 100, rows = 30) {
  const screen = new TerminalScreen(columns, rows, { retainResizeHistory: true });
  let currentColumns = columns;
  let currentRows = rows;
  let resizeListener: (() => void) | null = null;
  const region = new BottomRegion({
    write: (value) => screen.write(value),
    cols: () => currentColumns,
    rows: () => currentRows,
    onResize: (listener) => {
      resizeListener = listener;
      return () => { resizeListener = null; };
    },
    reflowSafe,
  });
  region.activate(
    { draft: '', mode: 'queue' },
    '◆ provider · model │ ◉ context 2k/32k │ ⧖ 4s',
  );
  return {
    region,
    screen,
    resize(nextColumns: number, nextRows: number) {
      currentColumns = nextColumns;
      currentRows = nextRows;
      screen.resize(nextColumns, nextRows);
      resizeListener?.();
    },
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

function composerText(content: string[]): string {
  return content.join('');
}

describe.each([100, 80, 44])('borderless fixed bottom region at %i columns', (columns) => {
  it('owns empty, normal, and Unicode drafts with the hardware cursor at insertion', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('◆ provider · model │ ◉ context 2k/32k │ ⧖ 4s');
    display.setIdleComposer('', 'Type your message · /help');
    let surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines()[surface.top]).toContain('▲ You');
    expect(surface.content).toHaveLength(1);
    expect(surface.content[0]).not.toContain('Type your message');
    expect(screen.cursorPosition()).toEqual({ row: surface.top + 2, col: 0 });

    display.setIdleComposer('hello terminal', 'Type your message · /help', 5);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('hello terminal');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);
    expect(screen.cursorPosition().col).toBe(5);

    display.setIdleComposer('Unicode: नमस्ते 世界 🚀', 'Type your message · /help');
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('Unicode: नमस्ते 世界 🚀');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);

    display.setIdleComposer('A世界B', 'Type your message · /help', 'A世'.length);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('A世界B');
    expect(screen.cursorPosition()).toEqual({
      row: surface.bottom - 1,
      col: 3,
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

describe('borderless fixed bottom region resize', () => {
  it.each([false, true])(
    'settles a live row before a second host resize can archive it (reflowSafe=%s)',
    async (reflowSafe) => {
      const { region, resize, screen } = createRegionHarness(reflowSafe);
      region.setLiveRow('tool_settlement', '⚙ shell_exec running');

      resize(150, 45);
      region.settleLiveRow('tool_settlement', '✓ shell_exec completed');
      resize(80, 24);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(screen.bufferSnapshot()).not.toContain('shell_exec running');
      expect(screen.bufferSnapshot().match(/shell_exec completed/gu) ?? []).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'rejects a late activity frame after terminal settlement (reflowSafe=%s)',
    async (reflowSafe) => {
      const { region, resize, screen } = createRegionHarness(reflowSafe);
      region.setLiveRow('tool_late_tick', '⚙ shell_exec running frame 1');
      region.settleLiveRow('tool_late_tick', '! shell_exec cancelled', 'cancelled');
      resize(44, 18);
      region.setLiveRow('tool_late_tick', '⚙ shell_exec running late frame');
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(screen.bufferSnapshot()).not.toContain('running late frame');
      expect(screen.bufferSnapshot().match(/shell_exec cancelled/gu) ?? []).toHaveLength(1);
    },
  );

  it.each([
    ['succeeded', '✓ tool completed'],
    ['failed', '! tool failed'],
    ['cancelled', '! tool cancelled'],
  ] as const)(
    'keeps only one %s terminal projection through rapid resize settlement',
    async (state, terminal) => {
      const { region, resize, screen } = createRegionHarness(false, 100, 30);
      region.setLiveRow(`tool_${state}`, '⚙ tool running');
      for (const [columns, rows] of [[60, 24], [100, 30], [44, 18]] as const) {
        resize(columns, rows);
      }
      region.settleLiveRow(`tool_${state}`, terminal, state);
      for (const [columns, rows] of [[100, 30], [60, 24], [100, 30]] as const) {
        resize(columns, rows);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(screen.bufferSnapshot()).not.toContain('tool running');
      expect(
        screen.bufferSnapshot().match(new RegExp(terminal.slice(2), 'gu')) ?? [],
        screen.bufferSnapshot(),
      ).toHaveLength(1);
    },
  );

  it('removes provider activity during resize without archiving its volatile frame', async () => {
    const { region, resize, screen } = createRegionHarness(false);
    region.setLiveRow('provider_wait', '◐ Aiden is thinking');
    resize(150, 45);
    region.removeLiveRow('provider_wait', true);
    resize(80, 24);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(screen.bufferSnapshot()).not.toContain('Aiden is thinking');
  });

  it('makes room without overwriting the existing transcript tail', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(80, 14);
    display.write(Array.from({ length: 8 }, (_, index) => `startup transcript ${index + 1}`).join('\n'));

    display.setStatusFooter('◆ provider · model │ ◉ context 0/32k │ ⧖ 0ms');
    display.setIdleComposer('', 'Type your message · /help');

    const surface = expectExclusiveSurface(screen, 'provider');
    const transcript = screen.lines().slice(0, surface.top).join('\n');
    expect(transcript).toContain('startup transcript 8');
    expect(transcript).not.toContain('startup transcr▲');
  });

  it('preserves column-one draft, cursor, hierarchy, and single ownership across 100 → 44 → 100', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100);
    const draft = 'a long Unicode draft 世界 that must wrap upward and survive resizing exactly';

    display.setStatusFooter('◆ provider · selected-model │ ◉ context 3k/32k │ ⧖ 9s');
    display.setIdleComposer(draft, 'Type your message · /help', 6);
    let surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join(' ')).toContain('Unicode draft');
    expect(surface.content[0]?.[0]).toBe('a');
    expect(screen.cursorPosition().col).toBe(6);

    stream.resize(44, 18);
    await new Promise<void>((resolve) => setImmediate(resolve));
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.length).toBeGreaterThan(1);
    expect(composerText(surface.content)).toContain('survive resizing exactly');
    expect(surface.content[0]?.[0]).toBe('a');
    expect(screen.cursorPosition().col).toBe(6);

    stream.resize(100, 18);
    await new Promise<void>((resolve) => setImmediate(resolve));
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join(' ')).toContain('Unicode draft 世界');
    expect(surface.content[0]?.[0]).toBe('a');
    expect(screen.cursorPosition()).toEqual({ row: surface.top + 2, col: 6 });
    expect(screen.scrollbackSnapshot(), screen.bufferSnapshot()).not.toContain('▲ You');
  });

  it('coalesces a resize burst into one main-buffer surface repaint', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.write('Environment\nCapabilities\nBuilt solo\n');
    display.setStatusFooter('◆ provider · model │ ◉ context 3k/32k │ ⧖ 9s');
    display.setIdleComposer('draft survives', 'Type your message · /help');
    stream.writes.length = 0;

    for (const [columns, rows] of [
      [60, 24], [100, 30], [44, 18], [100, 30],
    ] as const) {
      stream.resize(columns, rows);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stream.writes, stream.writes.join('\n')).toHaveLength(1);
    const resizeTransaction = stream.writes.join('');
    expect(resizeTransaction).not.toContain('\x1b[?1049h');
    expect(resizeTransaction).not.toContain('\x1b[2J\x1b[H');
    expect(resizeTransaction).not.toContain('\n');
    expect(resizeTransaction).not.toContain('Environment');
    expect(resizeTransaction).not.toContain('Capabilities');
    expect(resizeTransaction).not.toContain('Built solo');
    const rendered = screen.snapshot();
    expect(rendered.match(/▲ You/gu)).toHaveLength(1);
    expect(rendered.match(/◆\s*provider/gu)).toHaveLength(1);
    expect(rendered).toContain('draft survives');
    const durableBuffer = screen.bufferSnapshot();
    expect(durableBuffer.match(/Environment/gu) ?? []).toHaveLength(1);
    expect(durableBuffer.match(/Capabilities/gu) ?? []).toHaveLength(1);
    expect(durableBuffer.match(/Built solo/gu) ?? []).toHaveLength(1);
    const transientHistory = screen.scrollbackSnapshot();
    expect(transientHistory).not.toContain('▲ You');
    expect(transientHistory).not.toContain('◆ provider');
    expect(maxBlankRun(transientHistory)).toBeLessThanOrEqual(4);
  });

  it('projects the latest activity and status once after rapid 60 ↔ 44 oscillation', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.setStatusFooter('◆ provider · model │ ◉ context 1k/32k │ ⧖ 1s');
    display.setIdleComposer('unsent draft', 'Type your message · /help');
    stream.writes.length = 0;

    for (const width of [60, 44, 60, 44, 100]) {
      stream.resize(width, 30);
      display.renderUiEvent('ui_task_update', {
        task_id: 'task_resize', label: `Inspect at ${width}`, status: 'running',
      });
      display.setStatusFooter(`◆ provider · model │ ◉ context 2k/32k │ ⧖ ${width}ms`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stream.writes, stream.writes.join('\n')).toHaveLength(1);
    const rendered = screen.snapshot();
    expect(rendered.match(/^▲ You/gmu) ?? [], rendered).toHaveLength(1);
    expect(rendered.match(/Inspect at 100/gu) ?? [], rendered).toHaveLength(1);
    expect(rendered, rendered).not.toContain('Inspect at 44');
    expect(rendered, rendered).toContain('unsent draft');
    expect(rendered.split('\n').at(-1), rendered).toContain('100ms');
  });

  it('invalidates a deferred resize repaint when the viewport epoch changes', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.setStatusFooter('◆ provider · model │ ◉ context 0/32k │ ⧖ 0ms');
    display.setIdleComposer('draft survives clear', 'Type your message · /help');

    stream.resize(44, 20);
    display.clearScreen();
    const writesAfterClear = stream.writes.length;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stream.writes).toHaveLength(writesAfterClear);
    const rendered = screen.snapshot();
    expect(rendered.match(/^▲ You/gmu) ?? [], rendered).toHaveLength(1);
    expect(rendered, rendered).toContain('draft survives clear');
    expect(rendered.match(/^◆\s*provider/gmu) ?? [], rendered).toHaveLength(1);
  });

  it('restores one-shot transcript and footer after a modal resizes the terminal', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.write('Environment │ Capabilities\nBuilt solo\n');
    display.setStatusFooter('◆ provider · model │ ◉ context 3k/32k │ ⧖ 9s');
    display.setIdleComposer('approval draft', 'Type your message · /help');

    display.pauseComposerSurface();
    stream.resize(44, 20);
    display.write('Approval required\n');
    stream.resize(100, 30);
    display.resumeComposerSurface();

    const rendered = screen.snapshot();
    const reviewable = screen.reviewableSnapshot();
    expect(reviewable.match(/Environment/gu), reviewable).toHaveLength(1);
    expect(reviewable.match(/Capabilities/gu)).toHaveLength(1);
    expect(reviewable.match(/Built solo/gu)).toHaveLength(1);
    expect(rendered.match(/Approval required/gu)).toHaveLength(1);
    expect(rendered.match(/▲ You/gu)).toHaveLength(1);
    expect(rendered.match(/◆\s*provider/gu)).toHaveLength(1);
    expect(rendered).toContain('approval draft');
  });

  it('keeps one volatile surface through fifty physical-equivalent resize sequences', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.write('Environment\nCapabilities\nBuilt solo\n');
    display.setStatusFooter('◆ custom_openai · custom-default │ ◉ context 0/32k │ ✓ ready │ ⧖ 0ms');
    display.setIdleComposer('unsent Windows draft', 'Type your message · /help');

    const sequence = [60, 100, 44, 100, 60, 44] as const;
    for (let iteration = 0; iteration < 50; iteration += 1) {
      for (const width of sequence) {
        stream.resize(width, 30);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const rendered = screen.snapshot();
      expect(rendered.match(/^▲ You/gmu) ?? [], rendered).toHaveLength(1);
      expect(rendered.match(/^◆\s*custom_openai/gmu) ?? [], rendered).toHaveLength(1);
      expect(screen.scrollbackSnapshot(), screen.bufferSnapshot()).not.toContain('▲ You');
    }

    const history = screen.reviewableSnapshot();
    expect(history.match(/Environment/gu) ?? [], history).toHaveLength(1);
    expect(history.match(/Capabilities/gu) ?? [], history).toHaveLength(1);
    expect(history.match(/Built solo/gu) ?? [], history).toHaveLength(1);
    expect(screen.snapshot(), screen.snapshot()).toContain('unsent Windows draft');
  });

  it('survives one hundred mixed-width transitions across activity and approval ownership', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.write('durable prompt\ncompleted answer\n');
    display.setStatusFooter('◆ custom_openai · custom-default │ ◉ context 7% │ T │ ⧖ 8s');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    display.setComposer('queued draft remains exact', 'queue');

    const widths = [100, 60, 44, 80, 40, 100, 44, 60] as const;
    for (let index = 0; index < 100; index += 1) {
      const width = widths[index % widths.length];
      if (index === 20) {
        display.renderUiEvent('ui_task_update', {
          task_id: 'provider_resize', label: 'Provider activity', status: 'running',
        });
      }
      if (index === 40) {
        display.renderUiEvent('ui_task_update', {
          task_id: 'tool_resize', label: 'Tool activity', status: 'running',
        });
      }
      if (index === 60) {
        display.pauseComposerSurface();
        stream.resize(width, 24);
        display.write('Approval required\n');
        display.resumeComposerSurface();
      } else {
        stream.resize(width, index % 3 === 0 ? 24 : 30);
      }
      if (index === 80) {
        display.renderUiEvent('ui_task_update', {
          task_id: 'provider_resize', label: 'Provider complete', status: 'completed',
        });
        display.renderUiEvent('ui_task_update', {
          task_id: 'tool_resize', label: 'Tool complete', status: 'completed',
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rendered = screen.snapshot();
      expect(rendered.match(/^▲ You · queue mode/gmu) ?? [], rendered).toHaveLength(1);
      expect(rendered.match(/^◆\s*custom_openai/gmu) ?? [], rendered).toHaveLength(1);
      expect(screen.scrollbackSnapshot(), screen.bufferSnapshot()).not.toContain('▲ You');
    }

    const rendered = screen.snapshot();
    expect(rendered, rendered).toContain('queued draft remains exact');
    expect(
      screen.reviewableSnapshot().match(/Approval required/gu) ?? [],
      screen.reviewableSnapshot(),
    ).toHaveLength(1);
    expect(screen.reviewableSnapshot(), screen.reviewableSnapshot()).toContain('completed answer');
  });
});

function semanticGap(lines: string[], before: string, after: string): number {
  const beforeRow = lines.findLastIndex((line) => line.includes(before));
  const afterRow = lines.findLastIndex((line) => line.includes(after));
  expect(beforeRow, `missing semantic row: ${before}`).toBeGreaterThanOrEqual(0);
  expect(afterRow, `missing semantic row: ${after}`).toBeGreaterThan(beforeRow);
  return afterRow - beforeRow - 1;
}

function maxBlankRun(value: string): number {
  let current = 0;
  let maximum = 0;
  for (const line of value.split(/\r?\n/u)) {
    if (line.trim() === '') {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function blankRowsBeforeComposer(screen: TerminalScreen, content: string): number {
  const lines = screen.lines();
  const composer = lines.findLastIndex((line) => line.startsWith('▲ You'));
  const separator = composer - 1;
  const contentRow = lines.findLastIndex((line, index) => (
    index < separator && line.includes(content)
  ));
  expect(composer, screen.snapshot()).toBeGreaterThanOrEqual(1);
  expect(contentRow, screen.snapshot()).toBeGreaterThanOrEqual(0);
  return lines.slice(contentRow + 1, separator).filter((line) => line.trim() === '').length;
}

describe('compact live-region height ownership', () => {
  it('keeps ten related tool rows contiguous without decorative blanks', () => {
    const { display, screen } = createDisplay(100, 45);
    display.setStatusFooter('◆ provider/model │ 0% │ working │ 1s');
    display.setIdleComposer('', 'Type your message');
    const rows = Array.from({ length: 10 }, (_, index) => display.toolRow(
      'file_read',
      { path: `C:\\workspace\\compact-${index}.ts` },
      undefined,
      { activityId: `compact-${index}` },
    ));

    const visible = screen.lines();
    const indexes = Array.from({ length: 10 }, (_, index) => (
      visible.findIndex((line) => line.includes(`compact-${index}.ts`))
    ));
    expect(indexes.every((index) => index >= 0), screen.snapshot()).toBe(true);
    for (let index = 1; index < indexes.length; index += 1) {
      expect(indexes[index] - indexes[index - 1], screen.snapshot()).toBe(1);
    }
    for (const row of rows) row.ok(1);
  });

  it('keeps a short final answer adjacent to the composer boundary', () => {
    const { display, screen } = createDisplay(100, 100);
    display.setStatusFooter('◆ provider/model │ 0% │ ready │ 1s');
    display.setIdleComposer('', 'Type your message');
    display.write('Short final answer.\n');

    expect(blankRowsBeforeComposer(screen, 'Short final answer.')).toBeLessThanOrEqual(1);
  });

  it('releases a settled spinner height immediately', () => {
    const { display, screen } = createDisplay(100, 45);
    display.setStatusFooter('◆ provider/model │ 0% │ thinking │ 1s');
    display.setIdleComposer('', 'Type your message');
    display.write('Prompt boundary\n');
    const activity = display.liveActivityRow('calling provider');
    activity.stop();

    expect(screen.snapshot()).not.toContain('Aiden is thinking');
    expect(blankRowsBeforeComposer(screen, 'Prompt boundary')).toBeLessThanOrEqual(1);
  });

  it('shrinks a multiline activity replacement to its semantic row', () => {
    const { region, screen } = createRegionHarness(false, 80, 30);
    region.writeAbove('Inspection boundary\n');
    region.setLiveRow('inspection', 'Status bar\nraw detail one\nraw detail two\nraw detail three');
    region.setLiveRow('inspection', '✓ statusBar.ts · lines 1–190 inspected');

    expect(screen.snapshot()).not.toContain('raw detail');
    expect(blankRowsBeforeComposer(screen, 'lines 1–190 inspected')).toBeLessThanOrEqual(1);
  });

  it('releases every row when a suggestion-like activity is dismissed', () => {
    const { region, screen } = createRegionHarness(false, 80, 30);
    region.writeAbove('Suggestion boundary\n');
    region.setLiveRow('skill-suggestion', 'Suggested skill\nInspect repository\nPress Enter to accept');
    region.removeLiveRow('skill-suggestion');

    expect(screen.snapshot()).not.toContain('Suggested skill');
    expect(blankRowsBeforeComposer(screen, 'Suggestion boundary')).toBeLessThanOrEqual(1);
  });

  it('recomputes wrapped height in both resize directions without gaps or overlap', async () => {
    const { region, screen, resize } = createRegionHarness(false, 44, 45);
    region.writeAbove('Resize boundary\n');
    region.paint({
      draft: 'Inspect repository files with a semantic summary that wraps at narrow width',
      mode: 'idle',
    });
    const narrowComposer = composerGeometry(screen).topSeparator;

    resize(100, 45);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const wideComposer = composerGeometry(screen).topSeparator;
    expect(wideComposer).toBeGreaterThan(narrowComposer);
    expect(blankRowsBeforeComposer(screen, 'Resize boundary')).toBeLessThanOrEqual(1);

    resize(44, 45);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(screen.snapshot().match(/Inspect repository files/gu)).toHaveLength(1);
    expect(screen.snapshot().match(/▲ You/gu)).toHaveLength(1);
  });

  it('omits empty live sections instead of reserving their rows', () => {
    const { region, screen } = createRegionHarness(false, 80, 30);
    region.writeAbove('Empty-section boundary\n');
    region.setLiveRow('empty-section', '  \n\n  ');

    expect(blankRowsBeforeComposer(screen, 'Empty-section boundary')).toBeLessThanOrEqual(1);
  });

  it('clears prior reserved height and rejects late restoration after cls', () => {
    const { display, screen } = createDisplay(100, 45);
    display.setStatusFooter('◆ provider/model │ 0% │ working │ 1s');
    display.setIdleComposer('', 'Type your message');
    const activity = display.toolRow('file_read', { path: 'before-cls.ts' }, undefined, {
      activityId: 'before-cls',
    });
    display.clearScreen();
    display.write('After cls\n');
    activity.refresh();

    expect(screen.snapshot().match(/before-cls.ts/gu)).toHaveLength(1);
    expect(blankRowsBeforeComposer(screen, 'After cls')).toBeLessThanOrEqual(1);
  });
});

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
  it('wraps transcript prose at word boundaries when the word fits the terminal', async () => {
    await primeFrameAsync();
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

      expect(semanticGap(screen.lines(), 'compact provider request', 'Aiden is thinking')).toBeLessThanOrEqual(1);
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

    expect(semanticGap(screen.lines(), 'FINAL-PROMPT-LINE', 'Aiden is thinking')).toBeLessThanOrEqual(1);
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
      expect(semanticGap(screen.lines(), 'resize provider request', 'Aiden is thinking')).toBeLessThanOrEqual(1);
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
    expect(semanticGap(lines, 'inspect the package manifest', 'Aiden is thinking')).toBeLessThanOrEqual(1);
    expect(semanticGap(lines, 'Aiden is thinking', 'package.json')).toBe(0);
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
    expect(semanticGap(screen.lines(), 'return one concise answer', 'Aiden is thinking')).toBeLessThanOrEqual(1);

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
    expect(semanticGap(screen.lines(), 'request a guarded action', 'Aiden is thinking')).toBeLessThanOrEqual(1);

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
    expect(semanticGap(screen.lines(), `request after ${command}`, 'Aiden is thinking')).toBeLessThanOrEqual(1);
    provider.stop();
  });
});
