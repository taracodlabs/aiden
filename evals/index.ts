/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * evals/index.ts — Phase v4.1.2-slice2.
 *
 * Barrel exporting registered eval suites. The CLI imports `SUITES`
 * to look up a suite by name. Add new suites here as separate
 * `evals/suites/<name>.ts` files; the runtime contract is just
 * "a `<suite>Scenarios: EvalScenario[]` export."
 */

import type { EvalScenario } from './runner';
import { honestyScenarios } from './suites/honesty';
import { scoringSmokeScenarios } from './suites/scoringSmoke';

export const SUITES: Record<string, EvalScenario[]> = {
  honesty: honestyScenarios,
  // v4.14 Slice A — the deterministic, mock-scripted scoring fixture that
  // backs the per-PR gate. Runs free via `--provider mock`.
  'scoring-smoke': scoringSmokeScenarios,
};

export type SuiteName = keyof typeof SUITES;
