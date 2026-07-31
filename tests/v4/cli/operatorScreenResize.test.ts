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

class ResizableScreenStream extends Writable {
  isTTY = true;

  constructor(
    readonly screen: TerminalScreen,
    public columns: number,
    public rows: number,
  ) {
    super({
      write: (chunk, _encoding, done) => {
        screen.write(chunk);
        done();
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

const previousLaneSetting = process.env.AIDEN_COMPOSER_LANE;

afterEach(() => {
  if (previousLaneSetting === undefined) delete process.env.AIDEN_COMPOSER_LANE;
  else process.env.AIDEN_COMPOSER_LANE = previousLaneSetting;
});

function harness(columns = 100, rows = 30) {
  delete process.env.AIDEN_COMPOSER_LANE;
  const screen = new TerminalScreen(columns, rows, { retainResizeHistory: true });
  const stream = new ResizableScreenStream(screen, columns, rows);
  const display = new Display({
    stdout: stream as unknown as NodeJS.WriteStream,
    skin: new SkinEngine({ forceMono: true }),
  });
  display.setStatusFooter('◆ provider · model │ ◉ context 2k/32k │ ⧖ 4s');
  display.setIdleComposer('draft 世界', 'Type your message · /help', 5);
  return { display, screen, stream };
}

function assertOneCurrentSurface(
  screen: TerminalScreen,
  expectedDraft = 'draft 世界',
): void {
  const lines = screen.lines();
  const surfaceRows = lines.slice(-6);
  const composerRows = surfaceRows.filter((line) => line.startsWith('▲ You'));
  const statusRows = surfaceRows.filter((line) => /◆\s*provider/u.test(line));
  const shortDividers = surfaceRows.filter((line) => line === '─'.repeat(21));
  const fullSeparators = surfaceRows.filter((line) => /^─{22,}$/u.test(line));
  expect(composerRows, screen.snapshot()).toHaveLength(1);
  expect(statusRows, screen.snapshot()).toHaveLength(1);
  expect(shortDividers, screen.snapshot()).toHaveLength(1);
  expect(fullSeparators, screen.snapshot()).toHaveLength(2);
  expect(lines.at(-1), screen.snapshot()).toMatch(/◆\s*provider/u);
  expect(lines.at(-2), screen.snapshot()).toMatch(/^─+$/u);
  expect(lines.at(-5), screen.snapshot()).toMatch(/^▲ You/u);
  expect(lines.at(-3)?.startsWith(expectedDraft), screen.snapshot()).toBe(true);
  expect(lines.join('\n'), screen.snapshot()).not.toMatch(/[╭╮╰╯]/u);
  expect(lines.join('\n'), screen.snapshot()).toContain(expectedDraft);
}

async function settleResize(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('operator screen resize transactions', () => {
  it.each([
    [160, 45], [120, 35], [100, 30], [80, 24], [60, 20], [44, 16],
  ])('keeps the essential surface bounded at %ix%i', async (columns, rows) => {
    const { screen, stream } = harness();
    stream.resize(columns, rows);
    await settleResize();
    assertOneCurrentSurface(screen);
    for (const line of screen.lines()) expect(line.length).toBeLessThanOrEqual(columns);
  });

  it('heals the old and new footer geometry through the physical resize sequence', async () => {
    const { screen, stream } = harness();
    assertOneCurrentSurface(screen);

    for (const [columns, rows] of [[150, 45], [80, 24], [150, 45]] as const) {
      stream.resize(columns, rows);
      await settleResize();
      assertOneCurrentSurface(screen);
    }
  });

  it.each([
    ['width increase', 150, 30],
    ['width decrease', 80, 30],
    ['height increase', 100, 45],
    ['height decrease', 100, 20],
    ['wide to narrow', 44, 16],
  ])('preserves one semantic surface after %s', async (_label, columns, rows) => {
    const { screen, stream } = harness();
    stream.resize(columns, rows);
    await settleResize();
    assertOneCurrentSurface(screen);
    expect(screen.cursorPosition().col).toBe(5);
  });

  it('preserves queue draft and one tool identity across a resize burst', async () => {
    const { display, screen, stream } = harness();
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    display.setComposer('QUEUE ONE', 'queue');
    const tool = display.toolRow('shell_exec', { command: 'Start-Sleep -Seconds 15' });

    for (const [columns, rows] of [[120, 35], [60, 20], [160, 45], [44, 16], [100, 30]] as const) {
      stream.resize(columns, rows);
    }
    await settleResize();

    assertOneCurrentSurface(screen, 'QUEUE ONE');
    expect(
      screen.lines().filter((line) => line.includes('Start-Sleep')),
      screen.snapshot(),
    ).toHaveLength(1);
    expect(screen.lines().filter((line) => line.includes('▲ You · queue mode'))).toHaveLength(1);
    tool.ok(15_000);
  });

  it('restores a submitted user row after a modal before a tool expands the live region', () => {
    const { display, screen } = harness();
    display.submitIdleComposer('run a slow safe tool', 'Type your message');
    display.pauseComposerSurface();
    display.write('Approval required\nDecision: Once\n');
    display.resumeComposerSurface();
    display.setBusyHint('Enter → queue · Ctrl+C stop');

    const tool = display.toolRow('shell_exec', { command: 'Start-Sleep -Seconds 4' });

    expect(
      screen.lines().filter((line) => line.includes('run a slow safe tool')),
      screen.snapshot(),
    ).toHaveLength(1);
    assertOneCurrentSurface(screen, '');
    tool.ok(4_000);
  });

  it('keeps one provider activity across wide-narrow-wide resize', async () => {
    const { display, screen, stream } = harness(160, 45);
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const activity = display.liveActivityRow('calling provider');
    activity.refresh(1);
    expect(screen.lines().slice(0, -6).filter((line) => line.includes('Aiden is thinking'))).toHaveLength(1);

    stream.resize(44, 16);
    activity.refresh(2);
    await settleResize();
    expect(screen.lines().slice(0, -6).filter((line) => line.includes('Aiden is thinking'))).toHaveLength(1);

    stream.resize(160, 45);
    activity.refresh(3);
    await settleResize();
    expect(screen.lines().slice(0, -6).filter((line) => line.includes('Aiden is thinking'))).toHaveLength(1);
    assertOneCurrentSurface(screen, '');
    activity.stop();
  });

  it('reflows one assistant stream block and archives it once on completion', async () => {
    const { display, screen, stream } = harness(100, 30);
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    display.streamPartial('A streamed response with **structured text** that remains one block.');
    stream.resize(44, 16);
    await settleResize();
    expect(screen.lines().filter((line) => line.includes('Aiden'))).toHaveLength(1);
    expect(screen.snapshot()).toContain('streamed response');

    stream.resize(120, 35);
    await settleResize();
    display.streamComplete();
    stream.resize(80, 24);
    await settleResize();
    expect(screen.reviewableSnapshot()).toContain('Aiden');
    expect(screen.reviewableSnapshot()).toContain('structured text');
    assertOneCurrentSurface(screen, '');
  });

  it('preserves a multiline Unicode draft and insertion cursor through resize', async () => {
    const { display, screen, stream } = harness(80, 24);
    const draft = 'first line\n  second 世界 line';
    display.setIdleComposer(draft, 'Type your message', 8);
    stream.resize(44, 16);
    await settleResize();
    const narrowCursor = screen.cursorPosition();
    expect(screen.snapshot()).toContain('first line');
    expect(narrowCursor.row).toBeGreaterThanOrEqual(0);
    stream.resize(100, 30);
    await settleResize();
    expect(screen.snapshot()).toContain('second 世界 line');
    expect(screen.cursorPosition().col).toBe(8);
  });

  it('restores one current surface after resize while a modal owns the terminal', async () => {
    const { display, screen, stream } = harness();
    display.pauseComposerSurface();
    stream.resize(44, 16);
    display.writeTransient('Approval required\n');
    display.resumeComposerSurface();
    await settleResize();

    assertOneCurrentSurface(screen);
    expect(screen.bufferSnapshot()).not.toContain('Approval required');
  });

  it('does not archive animation frames when resize happens around settlement', async () => {
    const { display, screen, stream } = harness();
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const tool = display.toolRow('shell_exec', { command: 'Start-Sleep -Seconds 15' });
    stream.resize(150, 45);
    tool.ok(15_000);
    stream.resize(80, 24);
    await settleResize();

    assertOneCurrentSurface(screen, '');
    expect(screen.lines().filter((line) => line.includes('running'))).toHaveLength(0);
    expect(screen.bufferSnapshot()).toContain('Start-Sleep');
  });

  it('virtualizes fifty active rows without overwriting composer or status', () => {
    const { display, screen } = harness(60, 20);
    const handles = Array.from({ length: 50 }, (_, index) => (
      display.toolRow('file_read', { path: `C:\\workspace\\file-${index}.txt` }, undefined, { activityId: `activity_${index}` })
    ));
    assertOneCurrentSurface(screen);
    expect(screen.snapshot()).toContain('more active');
    expect(screen.lines().filter((line) => line.includes('file-')).length).toBeLessThanOrEqual(15);
    for (const handle of handles) handle.ok(1);
    assertOneCurrentSurface(screen);
  });
});
