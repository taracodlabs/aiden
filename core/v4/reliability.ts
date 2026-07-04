/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/reliability.ts — the generic rolling-reliability primitive.
 *
 * Extracted from the Pillar-5 live-eval path (evals/live.ts) so that BOTH the
 * eval reliability record AND skill trust (Pillar 6) fold outcomes through ONE
 * implementation — a rolling last-N window, a rolling pass-rate, and a
 * quarantine flag for something that's chronically failing. Not a fork: evals
 * and skill trust are two consumers of this one primitive. Domain-agnostic —
 * no eval or skill concepts leak in here.
 *
 * An outcome is `pass` / `fail` / `infra`. `infra` (a harness/transient error)
 * is EXCLUDED from the pass-rate — it's noise, not a real failure — so a run of
 * pure infra errors is inconclusive (rate `null`), never a regression.
 */

export type ReliabilityOutcome = 'pass' | 'fail' | 'infra';

export interface RollingReliability {
  /** The most-recent outcomes, capped to the history window. */
  lastOutcomes:    ReliabilityOutcome[];
  totalRuns:       number;
  /** Runs that were genuine attempts (not infra). */
  totalTaskRuns:   number;
  totalPassed:     number;
  totalInfra:      number;
  /** Pass-rate over the window's genuine (non-infra) runs; null if all infra. */
  rollingPassRate: number | null;
}

export function emptyRolling(): RollingReliability {
  return { lastOutcomes: [], totalRuns: 0, totalTaskRuns: 0, totalPassed: 0, totalInfra: 0, rollingPassRate: null };
}

/** Fold new outcomes into the rolling record (history capped at `histCap`). */
export function foldOutcomes(
  prev: RollingReliability | undefined,
  outcomes: ReliabilityOutcome[],
  histCap = 50,
): RollingReliability {
  const last = [...(prev?.lastOutcomes ?? []), ...outcomes].slice(-histCap);
  const task = last.filter((o) => o !== 'infra');
  const passed = last.filter((o) => o === 'pass').length;
  return {
    lastOutcomes:    last,
    totalRuns:       (prev?.totalRuns ?? 0) + outcomes.length,
    totalTaskRuns:   (prev?.totalTaskRuns ?? 0) + outcomes.filter((o) => o !== 'infra').length,
    totalPassed:     (prev?.totalPassed ?? 0) + outcomes.filter((o) => o === 'pass').length,
    totalInfra:      (prev?.totalInfra ?? 0) + outcomes.filter((o) => o === 'infra').length,
    rollingPassRate: task.length > 0 ? passed / task.length : null,
  };
}

/** True when the rolling pass-rate has been chronically low over enough runs. */
export function isQuarantineCandidate(r: RollingReliability, floor = 0.5, minRuns = 6): boolean {
  return r.lastOutcomes.filter((o) => o !== 'infra').length >= minRuns
    && r.rollingPassRate !== null
    && r.rollingPassRate < floor;
}
