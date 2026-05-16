/**
 * v4.5 Phase 4a — seenUids tests.
 */
import { describe, it, expect } from 'vitest';
import { createSeenUids, DEFAULT_MAX_SEEN_UIDS } from '../../../../../core/v4/daemon/triggers/email/seenUids';

describe('seenUids', () => {
  it('add + has roundtrip', () => {
    const s = createSeenUids(10);
    s.add(1); s.add(2); s.add(3);
    expect(s.has(1)).toBe(true);
    expect(s.has(2)).toBe(true);
    expect(s.has(99)).toBe(false);
    expect(s.size()).toBe(3);
  });

  it('seed bulk-loads UIDs', () => {
    const s = createSeenUids(10);
    s.seed([10, 20, 30, 40]);
    expect(s.size()).toBe(4);
    expect(s.has(20)).toBe(true);
  });

  it('seed auto-trims when crossing cap; high UIDs retained, low UIDs dropped', () => {
    const s = createSeenUids(4);
    s.seed([1, 2, 3, 4, 5]);             // crosses cap → auto-trim fires
    expect(s.size()).toBeLessThanOrEqual(4);
    // High UIDs retained (monotonic — recent are kept).
    expect(s.has(5)).toBe(true);
    expect(s.has(4)).toBe(true);
    // Low UIDs dropped.
    expect(s.has(1)).toBe(false);
  });

  it('explicit trim() is a no-op when already at or under cap', () => {
    const s = createSeenUids(10);
    s.seed([1, 2, 3]);
    const t = s.trim();
    expect(t.dropped).toBe(0);
  });

  it('default cap is 2000', () => {
    expect(DEFAULT_MAX_SEEN_UIDS).toBe(2000);
  });

  it('reset clears all', () => {
    const s = createSeenUids();
    s.add(1); s.add(2);
    s.reset();
    expect(s.size()).toBe(0);
    expect(s.has(1)).toBe(false);
  });
});
