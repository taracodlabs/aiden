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
}

const previousLaneSetting = process.env.AIDEN_COMPOSER_LANE;

afterEach(() => {
  if (previousLaneSetting === undefined) delete process.env.AIDEN_COMPOSER_LANE;
  else process.env.AIDEN_COMPOSER_LANE = previousLaneSetting;
});

describe.each([100, 44])('busy composer rendered screen at %i columns', (columns) => {
  it('remains pinned after two durable queue acknowledgements', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const rows = 16;
    const screen = new TerminalScreen(columns, rows);
    const stream = new ScreenStream(screen, columns, rows);
    const display = new Display({
      stdout: stream as unknown as NodeJS.WriteStream,
      skin: new SkinEngine({ forceMono: true }),
    });

    display.setStatusFooter('provider · model · ctx 1k/32k · 1s');
    display.setBusyHint('Enter → queue · /busy to change · Ctrl+C stop');
    const tool = display.toolRow('shell_exec', { command: 'Start-Sleep -Seconds 6' });
    expect(screen.lines().at(-4)).toContain('▲ You · queue mode');
    expect(screen.lines().at(-3)).toMatch(/^│\s+│$/);
    expect(screen.lines().at(-2)).toMatch(/^╰─/);
    expect(screen.bottomLine()).toContain('provider');

    display.setComposer('QUEUE ONE', 'queue');
    display.write('\n✓ queued (1 pending) · input_first\n');
    display.setComposer('', 'queue');
    expect(screen.snapshot()).toContain('input_first');
    expect(screen.lines().at(-4)).toContain('▲ You · queue mode');
    expect(screen.lines().at(-3)).toMatch(/^│\s+│$/);
    expect(screen.bottomLine()).toContain('provider');

    display.setComposer('QUEUE TWO', 'queue');
    display.write('\n✓ queued (2 pending) · input_second\n');
    display.setComposer('', 'queue');
    expect(screen.snapshot()).toContain('input_second');
    expect(screen.lines().at(-4)).toContain('▲ You · queue mode');
    expect(screen.lines().at(-3)).toMatch(/^│\s+│$/);
    expect(screen.bottomLine()).toContain('provider');

    tool.ok(6_000);
    display.clearComposer();
  });
});
