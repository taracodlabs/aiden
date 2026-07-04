/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * evals/live.ts — v4.14 Pillar 5 Slice B.
 *
 * The REAL-model scoring path, made trustworthy against nondeterminism. One
 * failed live run is NOT a regression — live evals are treated STATISTICALLY:
 *
 *   • Repeat-runs → a per-scenario PASS-RATE (e.g. 4/5), never a single
 *     pass/fail. Reuses the Slice-A runEval per run.
 *   • infra_error split — provider timeout / 429 / network / model-unavailable
 *     are tagged infra and EXCLUDED from the pass-rate; only genuine task
 *     failures count.
 *   • Regression only when the pass-rate drops BELOW (baseline − band) across
 *     repeats, or (candidate-vs-base) when base passes repeatedly and candidate
 *     fails repeatedly. Both sides failing ⇒ flaky/infra, never a regression.
 *
 * This path is ADVISORY / nightly-bound — NOT the per-PR blocking gate. It has
 * NO default provider: a caller must pass an adapter factory, so it can never
 * silently reach for a real model on the per-PR path (that stays Slice A's
 * deterministic mock gate).
 */

import type { ProviderAdapter } from '../providers/v4/types';
import {
  foldOutcomes, isQuarantineCandidate as isQuarantineBase,
  type ReliabilityOutcome, type RollingReliability,
} from '../core/v4/reliability';
import { runEval, type EvalScenario, type EvalResult } from './runner';

// ── infra-error classification ───────────────────────────────────────────
//
// runEval funnels every provider/harness throw into a single
// `infrastructure error: <msg>` failure (timeouts too). A failure with that
// prefix is NEVER a task failure — it's noise. We sub-classify the kind for
// the reliability record; an unrecognised harness error still counts as infra
// (kind 'other'), because a broken harness must not read as a model failure.
const INFRA_PATTERNS: Array<{ kind: string; rx: RegExp }> = [
  { kind: 'timeout',     rx: /timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i },
  { kind: 'rate_limit',  rx: /\b429\b|rate.?limit|too many requests|quota/i },
  { kind: 'network',     rx: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|\bdns\b/i },
  { kind: 'unavailable', rx: /\b5\d\d\b|overloaded|service unavailable|model.*(unavailable|not found|does not exist)/i },
  { kind: 'auth',        rx: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key/i },
];

export function classifyInfra(result: EvalResult): { infra: boolean; kind?: string } {
  const msg = result.failures.find((f) => f.startsWith('infrastructure error:'));
  if (!msg) return { infra: false };
  for (const { kind, rx } of INFRA_PATTERNS) if (rx.test(msg)) return { infra: true, kind };
  return { infra: true, kind: 'other' };
}

// ── repeat-runs ──────────────────────────────────────────────────────────

// The eval outcome kind IS the generic reliability outcome — one vocabulary.
export type RunOutcomeKind = ReliabilityOutcome;

export interface RunOutcome {
  kind:       RunOutcomeKind;
  verdict:    EvalResult['verdict'];
  costTokens: number;
  latencyMs:  number;
  infraKind?: string;
}

/**
 * Per-run adapter source. For a real run this returns the resolved provider
 * adapter; tests/smoke pass a factory that simulates pass/fail/infra per run
 * index — so the whole live path is exercised deterministically with no model.
 */
export type AdapterFactory = (scenario: EvalScenario, runIndex: number) => ProviderAdapter | Promise<ProviderAdapter>;

export interface RepeatOptions {
  repeats:    number;
  provider:   string;
  model:      string;
  timeoutMs?: number;
}

/** Run one scenario `repeats` times, classifying each outcome. */
export async function runScenarioRepeats(
  scenario: EvalScenario,
  makeAdapter: AdapterFactory,
  opts: RepeatOptions,
): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < Math.max(1, opts.repeats); i++) {
    let result: EvalResult;
    try {
      const adapter = await makeAdapter(scenario, i);
      result = await runEval(scenario, {
        provider:  { name: opts.provider, model: opts.model },
        adapter,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      // The adapter factory itself blew up (couldn't build a provider) — infra.
      outcomes.push({ kind: 'infra', verdict: 'failed', costTokens: 0, latencyMs: 0, infraKind: 'other' });
      void err;
      continue;
    }
    const infra = classifyInfra(result);
    outcomes.push({
      kind:       infra.infra ? 'infra' : result.passed ? 'pass' : 'fail',
      verdict:    result.verdict,
      costTokens: result.usage.totalTokens,
      latencyMs:  result.durationMs,
      infraKind:  infra.kind,
    });
  }
  return outcomes;
}

// ── aggregation ──────────────────────────────────────────────────────────

export interface ScenarioReliability {
  scenarioId:       string;
  runs:             number;   // total repeats
  taskRuns:         number;   // repeats that were genuine attempts (not infra)
  passed:           number;
  infraErrors:      number;
  /** passed / taskRuns; null when every run was infra (inconclusive). */
  passRate:         number | null;
  outcomes:         RunOutcomeKind[];
  medianCostTokens: number;
  p95CostTokens:    number;
  medianLatencyMs:  number;
  p95LatencyMs:     number;
  model:            string;
  provider:         string;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p95(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1);
  return s[Math.max(0, idx)];
}

export function aggregateReliability(
  scenarioId: string,
  outcomes: RunOutcome[],
  meta: { model: string; provider: string },
): ScenarioReliability {
  const infraErrors = outcomes.filter((o) => o.kind === 'infra').length;
  const task        = outcomes.filter((o) => o.kind !== 'infra');
  const passed      = task.filter((o) => o.kind === 'pass').length;
  // cost/latency percentiles over GENUINE runs only (infra fails fast + free).
  const costs = task.map((o) => o.costTokens);
  const lats  = task.map((o) => o.latencyMs);
  return {
    scenarioId,
    runs:             outcomes.length,
    taskRuns:         task.length,
    passed,
    infraErrors,
    passRate:         task.length > 0 ? passed / task.length : null,
    outcomes:         outcomes.map((o) => o.kind),
    medianCostTokens: median(costs),
    p95CostTokens:    p95(costs),
    medianLatencyMs:  median(lats),
    p95LatencyMs:     p95(lats),
    model:            meta.model,
    provider:         meta.provider,
  };
}

// ── comparison ───────────────────────────────────────────────────────────

export type LiveClass = 'ok' | 'regression' | 'improvement' | 'flaky_or_infra' | 'inconclusive';

export interface CompareOptions {
  /** Pass-rate at/above which a side is "passes repeatedly". Default 0.6. */
  passThreshold?: number;
  /** Regression margin below baseline before it counts. Default 0.2. */
  band?: number;
}

/**
 * candidate-vs-base — the reference A/B method. Both sides failing ⇒ the
 * scenario is flaky or infra-bound, NOT a regression. Base passing repeatedly
 * while candidate drops below (base − band) ⇒ a real regression.
 */
export function classifyCandidate(
  base: ScenarioReliability,
  cand: ScenarioReliability,
  opts: CompareOptions = {},
): LiveClass {
  const passThreshold = opts.passThreshold ?? 0.6;
  const band          = opts.band ?? 0.2;
  if (base.passRate === null || cand.passRate === null) return 'inconclusive';
  const basePasses = base.passRate >= passThreshold;
  const candPasses = cand.passRate >= passThreshold;
  if (!basePasses && !candPasses) return 'flaky_or_infra';
  if (basePasses && cand.passRate < base.passRate - band) return 'regression';
  if (cand.passRate > base.passRate + band) return 'improvement';
  return 'ok';
}

export interface LiveBaselineEntry {
  scenarioId: string;
  passRate:   number;
  /** Per-scenario noise band; falls back to CompareOptions.band. */
  band?:      number;
}

export interface LiveComparison {
  scenarioId:       string;
  classification:   LiveClass;
  passRate:         number | null;
  baselinePassRate: number;
  band:             number;
  taskRuns:         number;
  infraErrors:      number;
}

/**
 * Single-run-vs-history comparison (nightly trend). A single miss on a noisy
 * scenario never trips this — only a pass-rate below (baseline − band).
 */
export function compareToBaseline(
  rel: ScenarioReliability,
  entry: LiveBaselineEntry,
  opts: CompareOptions = {},
): LiveComparison {
  const band = entry.band ?? opts.band ?? 0.2;
  const base = { scenarioId: rel.scenarioId, classification: 'inconclusive' as LiveClass,
    passRate: rel.passRate, baselinePassRate: entry.passRate, band,
    taskRuns: rel.taskRuns, infraErrors: rel.infraErrors };
  if (rel.passRate === null) return base;
  if (rel.passRate < entry.passRate - band) return { ...base, classification: 'regression' };
  if (rel.passRate > entry.passRate + band) return { ...base, classification: 'improvement' };
  return { ...base, classification: 'ok' };
}

// ── reliability record (rolling, persisted) ──────────────────────────────

export interface ReliabilityRecord extends RollingReliability {
  scenarioId:       string;
  model:            string;
  provider:         string;
  medianCostTokens: number;
  p95CostTokens:    number;
  medianLatencyMs:  number;
  p95LatencyMs:     number;
}

/** Fold this run's reliability into the rolling record (cap the history). */
export function mergeReliability(
  prev: ReliabilityRecord | undefined,
  rel: ScenarioReliability,
  histCap = 50,
): ReliabilityRecord {
  // Rolling window + pass-rate + totals come from the shared core primitive;
  // the eval record adds its scenario identity + cost/latency percentiles.
  const rolling = foldOutcomes(prev, rel.outcomes, histCap);
  return {
    ...rolling,
    scenarioId:       rel.scenarioId,
    model:            rel.model,
    provider:         rel.provider,
    medianCostTokens: rel.medianCostTokens,
    p95CostTokens:    rel.p95CostTokens,
    medianLatencyMs:  rel.medianLatencyMs,
    p95LatencyMs:     rel.p95LatencyMs,
  };
}

/** True when a scenario is chronically flaky and should be quarantined. */
export function isQuarantineCandidate(rec: ReliabilityRecord, floor = 0.5, minRuns = 6): boolean {
  return isQuarantineBase(rec, floor, minRuns);
}
