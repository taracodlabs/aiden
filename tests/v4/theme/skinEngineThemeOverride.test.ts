/**
 * tests/v4/theme/skinEngineThemeOverride.test.ts — v4.9.0 Slice 1a hotfix #1.
 *
 * Verifies that SkinEngine.applyColors resolves the live tokens.ts
 * value when a user theme is active, and falls back to the legacy
 * skin RGB map when no theme is loaded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { applyTheme, resetToDefault } from '../../../core/v4/theme/themeRegistry';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function rgbFrom(painted: string): [number, number, number] | null {
  const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(painted);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

describe('SkinEngine — live theme override (Slice 1a hotfix #1)', () => {
  beforeEach(() => { resetToDefault(); });
  afterEach(() => { resetToDefault(); });

  it('no theme active → uses legacy skin RGB (preserves /skin behaviour)', () => {
    const sk = new SkinEngine({ forceMono: false });
    const painted = sk.applyColors('X', 'brand');
    // The legacy skin's brand colour is the orange RGB tuple.
    expect(rgbFrom(painted)).toEqual([255, 107, 53]);
    expect(stripAnsi(painted)).toBe('X');
  });

  it('user theme active → applyColors resolves live tokens.ts override', () => {
    applyTheme(
      {
        name: 'magenta-test',
        colorOverrides: { 'brand.primary': '#FF00FF' },
        glyphOverrides: {},
      },
      '/tmp/fake-theme.yaml', // non-null activePath enables the override branch
    );
    const sk = new SkinEngine({ forceMono: false });
    const painted = sk.applyColors('X', 'brand');
    expect(rgbFrom(painted)).toEqual([255, 0, 255]); // magenta
  });

  it('user theme override drops on resetToDefault → back to legacy skin', () => {
    applyTheme(
      {
        name: 'green-test',
        colorOverrides: { 'brand.primary': '#00FF00' },
        glyphOverrides: {},
      },
      '/tmp/fake-theme.yaml',
    );
    const sk = new SkinEngine({ forceMono: false });
    expect(rgbFrom(sk.applyColors('X', 'brand'))).toEqual([0, 255, 0]);
    resetToDefault();
    expect(rgbFrom(sk.applyColors('X', 'brand'))).toEqual([255, 107, 53]);
  });

  it('semantic kinds (error/warn/success) route through semantic.* tokens', () => {
    applyTheme(
      {
        name: 'semantic-test',
        colorOverrides: {
          'semantic.error':   '#111111',
          'semantic.warn':    '#222222',
          'semantic.success': '#333333',
        },
        glyphOverrides: {},
      },
      '/tmp/fake-theme.yaml',
    );
    const sk = new SkinEngine({ forceMono: false });
    expect(rgbFrom(sk.applyColors('X', 'error'))).toEqual([0x11, 0x11, 0x11]);
    expect(rgbFrom(sk.applyColors('X', 'warn'))).toEqual([0x22, 0x22, 0x22]);
    expect(rgbFrom(sk.applyColors('X', 'success'))).toEqual([0x33, 0x33, 0x33]);
  });

  it('forceMono still wins even when theme is active', () => {
    applyTheme(
      {
        name: 'mono-test',
        colorOverrides: { 'brand.primary': '#FF00FF' },
        glyphOverrides: {},
      },
      '/tmp/fake-theme.yaml',
    );
    const sk = new SkinEngine({ forceMono: true });
    expect(sk.applyColors('X', 'brand')).toBe('X');
  });
});
