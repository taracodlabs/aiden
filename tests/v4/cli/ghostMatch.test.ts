/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.2 SLICE 2 — ghostMatch unit coverage.
 *
 * First test file for cli/v4/ghostMatch.ts; the function has shipped
 * since v4.1 Tier-3.1.1 without coverage. Eight cases mirror the
 * documented examples + edge guards.
 */
import { describe, it, expect } from 'vitest';
import { findGhost } from '../../../cli/v4/ghostMatch';

const EMPTY_CTX = { slashNames: [] as string[], slashAliases: [] as string[], history: [] as string[] };

describe('findGhost — slash mode', () => {
  it('returns the suffix completing the longest unique start-with match', () => {
    // '/cr' against ['cron','clear'] → 'cron' wins (only it starts with 'cr').
    expect(findGhost('/cr', { ...EMPTY_CTX, slashNames: ['cron', 'clear'] })).toBe('on');
  });

  it('returns null when no slash name starts with the stem', () => {
    expect(findGhost('/x', { ...EMPTY_CTX, slashNames: ['cron'] })).toBeNull();
  });

  it('prefers the shortest candidate when several share the stem', () => {
    // '/d' against ['daemon','doctor'] → 'daemon' (6) and 'doctor' (6) tie on
    // length; deterministic alphabetical pick → 'daemon' (suffix 'aemon').
    expect(findGhost('/d', { ...EMPTY_CTX, slashNames: ['doctor', 'daemon'] })).toBe('aemon');
  });

  it('matches against aliases alongside names', () => {
    // 'pl' alias present → match.
    expect(findGhost('/pl', {
      ...EMPTY_CTX,
      slashNames: ['providers'],
      slashAliases: ['plugins'],
    })).toBe('ugins');
  });
});

describe('findGhost — free-text history mode', () => {
  it('returns the suffix of the most-recent matching past prompt', () => {
    expect(findGhost('how ', {
      ...EMPTY_CTX,
      history: ['how do I quit'],
    })).toBe('do I quit');
  });

  it('picks the FIRST (most-recent) start-with match when several qualify', () => {
    // history[0] is newest by contract — it should win even if a later
    // entry is also a valid match.
    expect(findGhost('how ', {
      ...EMPTY_CTX,
      history: ['how do I reset', 'how do I quit'],
    })).toBe('do I reset');
  });
});

describe('findGhost — null-return guards', () => {
  it('returns null for empty / whitespace-only typed text', () => {
    expect(findGhost('',     EMPTY_CTX)).toBeNull();
    expect(findGhost('   ',  EMPTY_CTX)).toBeNull();
  });

  it('returns null when typed contains a paste-compression label', () => {
    // We must not suggest over a compressed paste — the user is
    // resuming an edit and any "completion" would corrupt the buffer.
    expect(findGhost('[paste #2: 4kB] more', {
      ...EMPTY_CTX,
      history: ['[paste #2: 4kB] more text from a prior turn'],
    })).toBeNull();
  });
});
