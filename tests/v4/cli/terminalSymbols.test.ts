import { describe, expect, it } from 'vitest';

import { renderBottomSurface } from '../../../cli/v4/composerLane';
import { terminalStateSymbol, terminalSupportsUnicode } from '../../../cli/v4/terminalSymbols';

describe('terminal symbol fallback', () => {
  it('uses explicit ASCII state labels when Unicode is disabled', () => {
    const env = { AIDEN_UI_UNICODE: '0' } as NodeJS.ProcessEnv;
    expect(terminalSupportsUnicode(env)).toBe(false);
    expect(terminalStateSymbol('running', env)).toBe('[>]');
    expect(terminalStateSymbol('completed', env)).toBe('[+]');
    expect(terminalStateSymbol('failed', env)).toBe('[x]');
    expect(terminalStateSymbol('warning', env)).toBe('[!]');
    expect(terminalStateSymbol('unknown', env)).toBe('[?]');
  });

  it('uses the borderless ASCII composer hierarchy for a dumb terminal', () => {
    const surface = renderBottomSurface(16, 44, { draft: 'plain', mode: 'idle' }, 'provider', {
      brand: (value) => value, muted: (value) => value, unicode: false,
    });
    expect(surface.lines[0]).toBe('-'.repeat(43));
    expect(surface.lines[1]).toBe('> You');
    expect(surface.lines[2]).toBe('-'.repeat(21));
    expect(surface.lines[3]).toBe('plain');
    expect(surface.lines[4]).toBe('-'.repeat(43));
    expect(surface.lines[5]).toBe('provider');
  });
});
