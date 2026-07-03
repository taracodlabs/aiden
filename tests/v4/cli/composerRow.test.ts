/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 2c — the pure render of the live during-turn composer:
 * mode label + typed text, empty→'', tail-truncation. No I/O.
 */
import { describe, it, expect } from 'vitest';
import { renderComposerBuffer, modeLabel } from '../../../cli/v4/composerRow';

describe('modeLabel — the Enter-action verb', () => {
  it('maps each busy mode to its label', () => {
    expect(modeLabel('queue')).toBe('queue');
    expect(modeLabel('interrupt')).toBe('interrupt');
    expect(modeLabel('redirect')).toBe('redirect');
  });
});

describe('renderComposerBuffer — mode label + live text', () => {
  it('empty buffer → empty string (never noisy)', () => {
    expect(renderComposerBuffer('', 'queue')).toBe('');
    expect(renderComposerBuffer('', 'redirect')).toBe('');
  });

  it('prefixes the typed text with the mode label + ▸', () => {
    expect(renderComposerBuffer('hello', 'queue')).toBe('queue ▸ hello');
    expect(renderComposerBuffer('do X', 'redirect')).toBe('redirect ▸ do X');
    expect(renderComposerBuffer('stop', 'interrupt')).toBe('interrupt ▸ stop');
  });

  it('tail-truncates a long line (keeps the cursor end, ellipsis at the front)', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const out = renderComposerBuffer(long, 'queue', 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out.startsWith('queue ▸ ')).toBe(true);
    // keeps the most-recent chars (the tail), marks the elision with a leading …
    expect(out).toContain('…');
    expect(out.endsWith('9')).toBe(true);
  });

  it('short text under the width is shown whole (no ellipsis)', () => {
    const out = renderComposerBuffer('ok', 'queue', 60);
    expect(out).toBe('queue ▸ ok');
    expect(out).not.toContain('…');
  });
});
