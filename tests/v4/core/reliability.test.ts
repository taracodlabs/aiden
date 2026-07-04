/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the shared rolling-reliability primitive that BOTH the Pillar-5 eval
 * record and Pillar-6 skill trust fold through. One implementation, two
 * consumers — not a fork.
 */
import { describe, it, expect } from 'vitest';
import { foldOutcomes, isQuarantineCandidate, emptyRolling } from '../../../core/v4/reliability';

describe('foldOutcomes', () => {
  it('an empty record has a null pass-rate (inconclusive)', () => {
    const r = emptyRolling();
    expect(r.rollingPassRate).toBeNull();
    expect(r.lastOutcomes).toEqual([]);
  });

  it('folds outcomes and computes the rolling pass-rate over non-infra runs', () => {
    let r = foldOutcomes(undefined, ['pass', 'pass', 'fail']);
    expect(r.lastOutcomes).toEqual(['pass', 'pass', 'fail']);
    expect(r.totalPassed).toBe(2);
    expect(r.totalTaskRuns).toBe(3);
    expect(r.rollingPassRate).toBeCloseTo(2 / 3, 5);
    r = foldOutcomes(r, ['pass']);
    expect(r.totalRuns).toBe(4);
    expect(r.rollingPassRate).toBeCloseTo(3 / 4, 5);
  });

  it('infra outcomes are excluded from the pass-rate (noise, not failure)', () => {
    const r = foldOutcomes(undefined, ['pass', 'infra', 'pass']);
    expect(r.totalInfra).toBe(1);
    expect(r.totalTaskRuns).toBe(2);
    expect(r.rollingPassRate).toBe(1);       // 2/2 — the infra run didn't drag it
  });

  it('all-infra → inconclusive (null), never a 0% failure', () => {
    expect(foldOutcomes(undefined, ['infra', 'infra']).rollingPassRate).toBeNull();
  });

  it('caps the rolling window at histCap', () => {
    let r = emptyRolling();
    for (let i = 0; i < 60; i += 1) r = foldOutcomes(r, ['pass'], 50);
    expect(r.lastOutcomes).toHaveLength(50);
    expect(r.totalRuns).toBe(60);            // totals accumulate beyond the window
  });
});

describe('isQuarantineCandidate', () => {
  it('flags a chronically-low pass-rate over enough runs', () => {
    const r = foldOutcomes(undefined, ['fail', 'fail', 'fail', 'fail', 'pass', 'fail']);
    expect(isQuarantineCandidate(r)).toBe(true);
  });
  it('does not flag a short history even if failing', () => {
    expect(isQuarantineCandidate(foldOutcomes(undefined, ['fail', 'fail']))).toBe(false);
  });
  it('does not flag a mostly-passing skill', () => {
    const r = foldOutcomes(undefined, ['pass', 'pass', 'pass', 'pass', 'pass', 'fail']);
    expect(isQuarantineCandidate(r)).toBe(false);
  });
});
