/**
 * tests/v4/theme/themeLoader.test.ts — v4.9.0 Slice 1a.
 */
import { describe, it, expect } from 'vitest';
import { parseThemeYaml } from '../../../core/v4/theme/themeLoader';

describe('themeLoader — Slice 1a', () => {
  it('parses a valid theme with name + colors + glyphs', () => {
    const yaml = `
name: "magenta"
description: "Test theme"
colors:
  brand:
    primary: "#FF00FF"
    muted: "#990099"
glyphs:
  panel:
    bar: "★"
`;
    const { parsed, warnings } = parseThemeYaml(yaml);
    expect(warnings).toEqual([]);
    expect(parsed?.name).toBe('magenta');
    expect(parsed?.description).toBe('Test theme');
    expect(parsed?.colorOverrides['brand.primary']).toBe('#FF00FF');
    expect(parsed?.colorOverrides['brand.muted']).toBe('#990099');
    expect(parsed?.glyphOverrides['panel.bar']).toBe('★');
  });

  it('returns parsed: null on top-level YAML parse error', () => {
    const { parsed, warnings } = parseThemeYaml('this is: not: valid: yaml: !');
    expect(parsed).toBe(null);
    expect(warnings[0]).toMatch(/parse error/i);
  });

  it('rejects invalid hex with per-field warning, keeps valid siblings', () => {
    const yaml = `
name: "broken"
colors:
  brand:
    primary: "not-a-color"
    muted: "#990099"
`;
    const { parsed, warnings } = parseThemeYaml(yaml);
    expect(parsed).not.toBe(null);
    expect(parsed?.colorOverrides['brand.primary']).toBeUndefined();
    expect(parsed?.colorOverrides['brand.muted']).toBe('#990099');
    expect(warnings.some((w) => /brand\.primary/.test(w))).toBe(true);
  });

  it('falls back to name "custom" when name is missing or empty', () => {
    const { parsed } = parseThemeYaml('colors: {}\nglyphs: {}\n');
    expect(parsed?.name).toBe('custom');
  });

  it('accepts both #RGB and #RRGGBB hex forms', () => {
    const yaml = `
name: "short-hex"
colors:
  brand:
    primary: "#F0F"
    muted: "#FF00FF"
`;
    const { parsed, warnings } = parseThemeYaml(yaml);
    expect(warnings).toEqual([]);
    expect(parsed?.colorOverrides['brand.primary']).toBe('#F0F');
    expect(parsed?.colorOverrides['brand.muted']).toBe('#FF00FF');
  });

  it('handles missing top-level sections gracefully', () => {
    const { parsed, warnings } = parseThemeYaml('name: "minimal"\n');
    expect(parsed?.name).toBe('minimal');
    expect(parsed?.colorOverrides).toEqual({});
    expect(parsed?.glyphOverrides).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('reports unsupported leaf types but does not throw', () => {
    const yaml = `
name: "weird"
colors:
  brand:
    primary: 12345
`;
    const { parsed, warnings } = parseThemeYaml(yaml);
    expect(parsed).not.toBe(null);
    expect(warnings.some((w) => /Unsupported leaf type/.test(w))).toBe(true);
  });

  it('rejects array values with a warning', () => {
    const yaml = `
name: "arr"
colors:
  brand: ["#FF6B35"]
`;
    const { parsed, warnings } = parseThemeYaml(yaml);
    expect(parsed).not.toBe(null);
    expect(warnings.some((w) => /Array not supported/.test(w))).toBe(true);
  });

  // v4.9.0 Slice 1a hotfix #1 — empty file = silent (no warning, no parse).
  it('empty YAML string → no warning, parsed: null', () => {
    const { parsed, warnings } = parseThemeYaml('');
    expect(parsed).toBe(null);
    expect(warnings).toEqual([]);
  });

  it('whitespace-only YAML → no warning, parsed: null', () => {
    const { parsed, warnings } = parseThemeYaml('   \n\n  \n');
    expect(parsed).toBe(null);
    expect(warnings).toEqual([]);
  });

  it('strips the colors./glyphs. prefix from override keys', () => {
    const yaml = `
name: "x"
colors:
  brand:
    primary: "#FF0000"
glyphs:
  trail:
    gutter: "|"
`;
    const { parsed } = parseThemeYaml(yaml);
    expect(Object.keys(parsed?.colorOverrides ?? {})).toContain('brand.primary');
    expect(Object.keys(parsed?.colorOverrides ?? {})).not.toContain('colors.brand.primary');
    expect(Object.keys(parsed?.glyphOverrides ?? {})).toContain('trail.gutter');
  });
});
