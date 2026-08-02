import { describe, it, expect } from 'vitest';
import {
  renderCapabilityCard,
  truncToContent,
} from '../../../cli/v4/display/capabilityCard';
import type { CapabilityCardData } from '../../../providers/v4/types';
import type { ColorKind } from '../../../cli/v4/skinEngine';

/**
 * v4.1.3-essentials: capability card renderer is a pure module —
 * structured input + colorize callback → array of lines. These tests
 * cover the layout invariants (title surfaces, sections gate on
 * non-empty lists, Fix line always rendered, long Fix text wraps, the
 * truncation helper caps overlong actions), not visual fidelity per se.
 *
 * Identity colorizer is passed for assertions on plain text — actual
 * ANSI hygiene is exercised end-to-end by the systemControl smoke.
 */

const idColor = (t: string, _k: ColorKind) => t;

function fullData(): CapabilityCardData {
  return {
    title: 'media_transport requires Windows',
    canStill: [
      'Use Spotify Web API via a skill',
      'Use Chrome DevTools Protocol',
      'shell_exec with playerctl / osascript',
    ],
    cannotReliably: [
      'GSMTC-verified play/pause/skip',
      'Target a specific app by AppUserModelId',
    ],
    fix: 'Run Aiden on Windows for GSMTC, or install a Spotify-OAuth skill.',
  };
}

describe('renderCapabilityCard — happy path', () => {
  it('returns multiple lines (box-bordered block, not a one-liner)', () => {
    const lines = renderCapabilityCard(fullData(), idColor);
    expect(lines.length).toBeGreaterThan(5);
  });

  it('surfaces the title in the top border', () => {
    const lines = renderCapabilityCard(fullData(), idColor);
    const joined = lines.join('\n');
    expect(joined).toContain('media_transport requires Windows');
    // Warning glyph precedes the title per design.
    expect(joined).toContain('⚠');
  });

  it('renders Can still: section with all actions', () => {
    const lines = renderCapabilityCard(fullData(), idColor);
    const joined = lines.join('\n');
    expect(joined).toContain('Can still:');
    expect(joined).toContain('Spotify Web API');
    expect(joined).toContain('Chrome DevTools Protocol');
    expect(joined).toContain('playerctl');
  });

  it('renders Cannot reliably: section with all actions', () => {
    const lines = renderCapabilityCard(fullData(), idColor);
    const joined = lines.join('\n');
    expect(joined).toContain('Cannot reliably:');
    expect(joined).toContain('GSMTC-verified');
    expect(joined).toContain('AppUserModelId');
  });

  it('renders Fix: line with full guidance', () => {
    const lines = renderCapabilityCard(fullData(), idColor);
    const joined = lines.join('\n');
    expect(joined).toContain('Fix:');
    expect(joined).toContain('Run Aiden on Windows');
  });

  it('uses ✓ / ✗ markers for bullet lists', () => {
    const lines = renderCapabilityCard(fullData(), idColor);
    const joined = lines.join('\n');
    expect(joined).toContain('✓');
    expect(joined).toContain('✗');
  });
});

describe('renderCapabilityCard — partial / edge cases', () => {
  it('omits Can still: section when list is empty', () => {
    const data: CapabilityCardData = {
      ...fullData(),
      canStill: [],
    };
    const joined = renderCapabilityCard(data, idColor).join('\n');
    expect(joined).not.toContain('Can still:');
    // The other sections still render.
    expect(joined).toContain('Cannot reliably:');
    expect(joined).toContain('Fix:');
  });

  it('omits Cannot reliably: section when list is empty', () => {
    const data: CapabilityCardData = {
      ...fullData(),
      cannotReliably: [],
    };
    const joined = renderCapabilityCard(data, idColor).join('\n');
    expect(joined).not.toContain('Cannot reliably:');
    expect(joined).toContain('Can still:');
    expect(joined).toContain('Fix:');
  });

  it('renders Fix even with both lists empty (minimum viable card)', () => {
    const data: CapabilityCardData = {
      title: 'Something is missing',
      canStill: [],
      cannotReliably: [],
      fix: 'Fix it by doing the thing.',
    };
    const joined = renderCapabilityCard(data, idColor).join('\n');
    expect(joined).toContain('Something is missing');
    expect(joined).toContain('Fix:');
    expect(joined).toContain('Fix it by doing the thing');
  });

  it('wraps a long Fix line across multiple rows instead of clipping', () => {
    const longFix =
      'Run Aiden on Windows for the full media-control surface, or install ' +
      'the Spotify OAuth skill via /skills install, or use the platform-' +
      'native helper (playerctl on Linux, osascript on macOS) wrapped in shell_exec.';
    const data: CapabilityCardData = {
      ...fullData(),
      fix: longFix,
    };
    const joined = renderCapabilityCard(data, idColor).join('\n');
    // Full fix text must be present even if wrapped.
    expect(joined).toContain('Run Aiden on Windows');
    expect(joined).toContain('osascript on macOS');
  });

  it('invokes colorize with the expected ColorKinds (warn for headings, success/error for marks)', () => {
    const seen: Array<{ text: string; kind: ColorKind }> = [];
    const tracker = (t: string, k: ColorKind) => {
      seen.push({ text: t, kind: k });
      return t;
    };
    renderCapabilityCard(fullData(), tracker);
    const kinds = new Set(seen.map((s) => s.kind));
    expect(kinds.has('warn')).toBe(true);     // headings + ⚠ title prefix
    expect(kinds.has('success')).toBe(true);  // ✓ marks
    expect(kinds.has('error')).toBe(true);    // ✗ marks
    expect(kinds.has('tool')).toBe(true);     // Fix: label
  });
});

describe('truncToContent', () => {
  it('returns the input unchanged when it fits the bullet column', () => {
    expect(truncToContent('short action')).toBe('short action');
  });

  it('truncates with "…" when exceeding the bullet column cap', () => {
    const long = 'x'.repeat(200);
    const out = truncToContent(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });

  it('uses terminal width for ANSI and wide Unicode content', () => {
    const out = truncToContent(`\x1b[38;2;255;107;53m${'界'.repeat(80)}\x1b[0m`);
    expect(require('string-width')(out.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '')))
      .toBeLessThanOrEqual(58);
    expect(out).not.toContain('\uFFFD');
    expect(out).toMatch(/…$/u);
  });
});
