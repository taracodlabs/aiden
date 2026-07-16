/**
 * v4.9.0 pre-ship UI — welcome banner hint placement.
 * Hint precedes the closing rule of the boot card; the turn loop
 * never re-emits the hint between rules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.join(__dirname, '../../../../cli/v4/chatSession.ts'), 'utf8');

describe('renderStartupCard closing-line order', () => {
  it('hint precedes the closing rule', () => {
    const h = SRC.indexOf('display.bottomPromptHint() + ');
    expect(h).toBeGreaterThan(0);
    expect(SRC.indexOf('display.rule(Math.max(1, columns - 4))', h)).toBeGreaterThan(h);
  });
  it('turn loop does not emit bottomPromptHint per turn', () => {
    const slice = SRC.slice(SRC.indexOf('while (iter < max)'), SRC.indexOf('await this.runAgentTurn(input)'));
    expect(slice).not.toMatch(/bottomPromptHint/);
  });
});
