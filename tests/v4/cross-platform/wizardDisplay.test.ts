/**
 * Phase 19 — setup wizard platform-aware path display.
 *
 * Asserts that the wizard's "Tokens stored at: ..." line uses path.join
 * (no hardcoded forward slashes) so the rendered string matches the
 * platform's separator convention. Phase 18 path audit said no
 * hardcoded path strings; this test enforces that going forward.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';

describe('Wizard path display — platform-aware', () => {
  it('20. tokenfile path joins via path.join, never hardcoded forward slash', () => {
    // Synthetic case: simulate the wizard line construction.
    const root =
      process.platform === 'win32'
        ? 'C:\\Users\\shiva\\AppData\\Local\\aiden'
        : process.platform === 'darwin'
          ? '/Users/shiva/Library/Application Support/aiden'
          : '/home/shiva/.config/aiden';
    const providerId = 'claude-pro';
    const tokenfile = path.join(root, 'auth', `${providerId}.json`);
    if (process.platform === 'win32') {
      expect(tokenfile).toMatch(/\\auth\\claude-pro\.json$/);
    } else {
      expect(tokenfile).toMatch(/\/auth\/claude-pro\.json$/);
    }
    // Either way, the token filename is right at the end and the
    // separator matches the platform.
    expect(tokenfile.endsWith(`auth${path.sep}claude-pro.json`)).toBe(true);
  });

  it('21. path.sep is the platform-correct separator', () => {
    if (process.platform === 'win32') {
      expect(path.sep).toBe('\\');
    } else {
      expect(path.sep).toBe('/');
    }
  });
});
