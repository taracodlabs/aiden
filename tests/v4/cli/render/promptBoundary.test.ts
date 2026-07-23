/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 pre-ship UI — prompt-zone rule boundaries.
 * TOP rule = `printTurnSeparator()` (already shipping).
 * BOTTOM rule = NEW seam in chatSession right before `runAgentTurn`.
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

  it('chatSession.ts emits BOTTOM rule immediately before runAgentTurn', () => {
    const src = readFileSync(path.join(__dirname, '../../../../cli/v4/chatSession.ts'), 'utf8');
    const lines = src.split('\n');
    const idx = lines.findIndex((l) => /await this\.runAgentTurn\(input(?:,\s*inputAlreadyPersisted)?\)/.test(l));
    expect(idx).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, idx - 8), idx).join('\n');
    expect(preceding).toMatch(/display\.write\(\s*`\s+\$\{this\.opts\.display\.rule\(\)\}\\n`\s*\)/);
  });
});
