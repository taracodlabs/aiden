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

  it('uses ASCII composer chrome for a dumb terminal', () => {
    const surface = renderBottomSurface(16, 44, { draft: 'plain', mode: 'idle' }, 'provider', {
      brand: (value) => value, muted: (value) => value, unicode: false,
    });
    expect(surface.lines[0]).toMatch(/^\+- > You -+\+$/u);
    expect(surface.lines[1]).toMatch(/^\| plain\s+\|$/u);
    expect(surface.lines[2]).toMatch(/^\+-+\+$/u);
  });
});
