/**
 * v4.9.0 pre-ship UI — Aiden response-box breathing room.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Display } from '../../../../cli/v4/display';
import { SkinEngine } from '../../../../cli/v4/skinEngine';

describe('response box breathing room', () => {
  it('agentHeader ends with blank line below', () => {
    const d = new Display({ skin: new SkinEngine({ forceMono: true }) });
    expect(d.agentHeader().replace(/\x1b\[[0-9;]*m/g, '').endsWith('\n\n')).toBe(true);
  });
  it('post-response rule has leading blank line', () => {
    const src = readFileSync(path.join(__dirname, '../../../../cli/v4/chatSession.ts'), 'utf8');
    expect(src).toMatch(/display\.write\(\s*`\\n\s+\$\{this\.opts\.display\.rule\(\)\}\\n`/);
  });
});
