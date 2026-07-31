/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Turn-transition separator ownership.
 * Completed output or a completed local command owns one separator;
 * composer acquisition owns none.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Display } from '../../../../cli/v4/display';
import { SkinEngine } from '../../../../cli/v4/skinEngine';
import { TerminalScreen } from '../../harness/terminalScreen';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('prompt-zone rule boundaries', () => {
  it('printTurnSeparator emits a ─ rule line (TOP)', () => {
    const chunks: string[] = [];
    const out = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } }) as unknown as NodeJS.WriteStream;
    (out as unknown as { isTTY: boolean }).isTTY = false;
    new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out }).printTurnSeparator();
    expect(/─{10,}/.test(stripAnsi(chunks.join('')))).toBe(true);
  });

  it('chatSession does not add separator rules while acquiring the next composer', () => {
    const src = readFileSync(path.join(__dirname, '../../../../cli/v4/chatSession.ts'), 'utf8');
    expect(src).not.toMatch(/if \(iter > 1\) this\.opts\.display\.printTurnSeparator\(\)/);
    const dispatch = src.indexOf('await this.runAgentTurn(input, inputAlreadyPersisted, queuedDurableInputId)');
    expect(dispatch).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, dispatch - 500), dispatch)).not.toMatch(/display\.rule\(\)/);
  });

  it.each([
    'hi',
    'a long wrapped submission '.repeat(8),
    'Unicode नमस्ते 世界 🚀',
    'first line\n\n  indented second line',
  ])('keeps the submitted prompt immutable when a turn rule is painted', (value) => {
    class ScreenStream extends Writable {
      isTTY = true;
      columns = 44;
      rows = 18;
      constructor(readonly screen: TerminalScreen) {
        super({ write: (chunk, _encoding, callback) => { screen.write(chunk); callback(); } });
      }
    }
    const screen = new TerminalScreen(44, 18);
    const out = new ScreenStream(screen) as unknown as NodeJS.WriteStream;
    const display = new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out });
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message');
    display.submitIdleComposer(value, 'Type your message');
    display.printTurnSeparator();

    const lines = screen.lines();
    const composerLabel = lines.findLastIndex((line) => line.startsWith('▲ You'));
    const transcript = lines.slice(0, Math.max(0, composerLabel - 1));
    const submittedRows = transcript.filter((line) => (
      line.includes('▲ You') || line.includes('indented second') || line.includes('Unicode')
    ));
    expect(submittedRows.length, screen.snapshot()).toBeGreaterThan(0);
    expect(submittedRows.every((line) => !line.includes('─')), screen.snapshot()).toBe(true);
    expect(transcript.some((line) => /^\s*─{10,}\s*$/u.test(line)), screen.snapshot()).toBe(true);
  });
});
