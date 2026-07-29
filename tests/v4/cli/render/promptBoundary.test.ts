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
});
