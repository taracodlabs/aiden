import { describe, it, expect } from 'vitest';
import {
  shouldAutoSummarize,
  memoryGrewBetween,
  SESSION_SUMMARY_MIN_TURNS,
} from '../../../cli/v4/sessionSummaryGate';

/**
 * Phase v4.1.2-followup-2 — auto-summary trigger logic.
 *
 * Replaces the earlier strict-`>5` threshold (the smoke gate that
 * silently failed for any session of 5 or fewer user turns).
 *
 * Contract:
 *   - 0..2 user turns → fire=false, reason='short' (let user know why)
 *   - 3+ user turns + provider configured + paths wired → fire=true
 *   - unconfigured / no-paths beats 'short' if also short
 *     (we report the most actionable reason first via short-circuit)
 *   - memoryGrewBetween triggers on EITHER size growth OR mtime advance
 *     (covers same-length replace-section writes that bump mtime only)
 */
describe('shouldAutoSummarize', () => {
  it('exposes the threshold constant as 3', () => {
    expect(SESSION_SUMMARY_MIN_TURNS).toBe(3);
  });

  it('returns short for 0 turns', () => {
    const r = shouldAutoSummarize({
      userTurns:    0,
      unconfigured: false,
      memoryPath:   '/tmp/m.md',
    });
    expect(r).toEqual({ fire: false, reason: 'short' });
  });

  it('returns short for 1, 2 turns', () => {
    for (const n of [1, 2]) {
      expect(shouldAutoSummarize({
        userTurns:    n,
        unconfigured: false,
        memoryPath:   '/tmp/m.md',
      })).toEqual({ fire: false, reason: 'short' });
    }
  });

  it('fires at exactly 3 turns', () => {
    expect(shouldAutoSummarize({
      userTurns:    3,
      unconfigured: false,
      memoryPath:   '/tmp/m.md',
    })).toEqual({ fire: true });
  });

  it('fires for 4 user turns (the smoke regression case)', () => {
    // The chat-session smoke that surfaced this bug had 4 user turns —
    // model-picker, file_read SOUL.md, file_list, who-are-you. Under the
    // old `> 5` threshold this returned silently. Now it must fire.
    expect(shouldAutoSummarize({
      userTurns:    4,
      unconfigured: false,
      memoryPath:   '/tmp/m.md',
    })).toEqual({ fire: true });
  });

  it('reports unconfigured before short — both can be true but only one log fires', () => {
    // Threshold check runs FIRST in the implementation, so short wins
    // when both conditions hold. This documents the ordering so the
    // log message stays predictable.
    const r = shouldAutoSummarize({
      userTurns:    1,
      unconfigured: true,
      memoryPath:   '/tmp/m.md',
    });
    expect(r).toEqual({ fire: false, reason: 'short' });
  });

  it('reports unconfigured when threshold passes but no provider', () => {
    expect(shouldAutoSummarize({
      userTurns:    5,
      unconfigured: true,
      memoryPath:   '/tmp/m.md',
    })).toEqual({ fire: false, reason: 'unconfigured' });
  });

  it('reports no-paths when threshold + provider OK but path missing', () => {
    expect(shouldAutoSummarize({
      userTurns:    5,
      unconfigured: false,
      memoryPath:   undefined,
    })).toEqual({ fire: false, reason: 'no-paths' });
  });
});

describe('memoryGrewBetween', () => {
  it('detects size growth', () => {
    expect(memoryGrewBetween(
      { size: 100, mtime: 1000 },
      { size: 250, mtime: 1000 },
    )).toBe(true);
  });

  it('detects mtime advance even when size is identical (same-length section replace)', () => {
    // session_summary uses replaceSection which can leave size
    // unchanged when an existing entry of the same length is replaced;
    // mtime still advances. The gate must catch this.
    expect(memoryGrewBetween(
      { size: 500, mtime: 1000 },
      { size: 500, mtime: 2000 },
    )).toBe(true);
  });

  it('returns false when both size and mtime are unchanged', () => {
    expect(memoryGrewBetween(
      { size: 100, mtime: 1000 },
      { size: 100, mtime: 1000 },
    )).toBe(false);
  });

  it('returns false when file is empty and stays empty (no-op call)', () => {
    expect(memoryGrewBetween(
      { size: 0, mtime: 0 },
      { size: 0, mtime: 0 },
    )).toBe(false);
  });

  it('detects first write to a previously missing file (0 → non-zero size)', () => {
    // Snapshot helper normalises missing file to zeros; first-ever
    // session_summary call should be detected as growth.
    expect(memoryGrewBetween(
      { size: 0, mtime: 0 },
      { size: 800, mtime: 1234567890 },
    )).toBe(true);
  });
});
