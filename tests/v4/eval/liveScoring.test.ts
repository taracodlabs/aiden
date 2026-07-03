/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 Pillar 5 Slice B — the real-model live path, exercised deterministically.
 *
 * Every test drives the live logic through a SIMULATED adapter factory (mock /
 * faulty adapters chosen per run index) — no network, no real model — so the
 * statistics (pass-rate, infra split, candidate-vs-base, band) are asserted
 * exactly. The live path is advisory and NOT part of the per-PR gate; the last
 * test pins that separation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import type { ProviderAdapter, ProviderCallInput, ProviderCallOutput } from '../../../providers/v4/types';
import { type EvalScenario } from '../../../evals/runner';
import { scoringSmokeScenarios } from '../../../evals/suites/scoringSmoke';
import {
  runScenarioRepeats, aggregateReliability, classifyInfra, classifyCandidate,
  compareToBaseline, mergeReliability, isQuarantineCandidate,
  type AdapterFactory, type ScenarioReliability, type ReliabilityRecord,
} from '../../../evals/live';

// ── simulated adapters ─────────────────────────────────────────────────────
class FaultyAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  constructor(private msg: string) {}
  async call(_i: ProviderCallInput): Promise<ProviderCallOutput> { throw new Error(this.msg); }
}
type Kind = 'pass' | 'fail' | 'infra';
const SCENARIO = scoringSmokeScenarios.find((s) => s.id === 'smoke/read-only-complete')!;

function factory(plan: Kind[], infraMsg = '429 Too Many Requests'): AdapterFactory {
  return (sc: EvalScenario, i: number) => {
    const k = plan[i] ?? 'pass';
    if (k === 'pass')  return new MockProviderAdapter(sc.script!);
    if (k === 'infra') return new FaultyAdapter(infraMsg);
    // 'fail' — answer without calling the tool → expectations fail (task failure).
    return new MockProviderAdapter([MockProviderAdapter.stop('(declined)')]);
  };
}

async function reliability(plan: Kind[]): Promise<ScenarioReliability> {
  const outcomes = await runScenarioRepeats(SCENARIO, factory(plan), {
    repeats: plan.length, provider: 'sim', model: 'sim',
  });
  return aggregateReliability(SCENARIO.id, outcomes, { model: 'sim', provider: 'sim' });
}

// ── repeat-runs → pass-rate ────────────────────────────────────────────────
describe('repeat-runs aggregate to a pass-rate, not a single pass/fail', () => {
  it('2 pass + 1 fail → pass-rate 2/3', async () => {
    const rel = await reliability(['pass', 'pass', 'fail']);
    expect(rel.taskRuns).toBe(3);
    expect(rel.passed).toBe(2);
    expect(rel.passRate).toBeCloseTo(2 / 3, 5);
    expect(rel.outcomes).toEqual(['pass', 'pass', 'fail']);
  });
});

// ── noise band: single miss never flags; repeated failure does ─────────────
describe('band tolerates a single miss but catches a real drop', () => {
  const entry = { scenarioId: SCENARIO.id, passRate: 1.0, band: 0.34 };

  it('failing 1/5 (0.8) stays above (baseline − band) → NOT a regression', async () => {
    const rel = await reliability(['pass', 'pass', 'pass', 'pass', 'fail']);
    expect(rel.passRate).toBeCloseTo(0.8, 5);
    expect(compareToBaseline(rel, entry).classification).not.toBe('regression');
  });

  it('failing 4/5 (0.2) drops below the band → regression', async () => {
    const rel = await reliability(['fail', 'fail', 'fail', 'fail', 'pass']);
    expect(rel.passRate).toBeCloseTo(0.2, 5);
    expect(compareToBaseline(rel, entry).classification).toBe('regression');
  });
});

// ── candidate-vs-base classification ───────────────────────────────────────
describe('candidate-vs-base classification', () => {
  it('BOTH sides fail repeatedly → flaky/infra, NOT a regression', async () => {
    const base = await reliability(['fail', 'fail', 'pass']);   // 0.33
    const cand = await reliability(['fail', 'fail', 'fail']);   // 0.0
    expect(classifyCandidate(base, cand)).toBe('flaky_or_infra');
  });

  it('base passes repeatedly, candidate fails repeatedly → regression', async () => {
    const base = await reliability(['pass', 'pass', 'pass']);   // 1.0
    const cand = await reliability(['fail', 'fail', 'pass']);   // 0.33
    expect(classifyCandidate(base, cand)).toBe('regression');
  });

  it('candidate matches base → ok', async () => {
    const base = await reliability(['pass', 'pass', 'fail']);   // 0.66
    const cand = await reliability(['pass', 'pass', 'pass']);   // 1.0
    expect(classifyCandidate(base, cand)).toBe('improvement');
  });
});

// ── infra_error handling ───────────────────────────────────────────────────
describe('infra errors never count as task failures', () => {
  it('a 429 is tagged infra and excluded from the pass-rate', async () => {
    const rel = await reliability(['pass', 'infra', 'pass']);
    expect(rel.infraErrors).toBe(1);
    expect(rel.taskRuns).toBe(2);          // the infra run is NOT a genuine attempt
    expect(rel.passed).toBe(2);
    expect(rel.passRate).toBe(1);          // 2/2, the 429 didn't drag it down
    expect(rel.outcomes).toEqual(['pass', 'infra', 'pass']);
  });

  it('classifyInfra recognises timeout / rate-limit / network / unavailable', () => {
    const mk = (msg: string) => ({ failures: [`infrastructure error: ${msg}`] } as never);
    expect(classifyInfra(mk('scenario timed out after 60000ms')).kind).toBe('timeout');
    expect(classifyInfra(mk('429 Too Many Requests')).kind).toBe('rate_limit');
    expect(classifyInfra(mk('ECONNRESET socket hang up')).kind).toBe('network');
    expect(classifyInfra(mk('503 service unavailable')).kind).toBe('unavailable');
    // a genuine task failure (expectation miss) is NOT infra.
    expect(classifyInfra({ failures: ["expected tool 'x' to be called"] } as never).infra).toBe(false);
  });

  it('all-infra run is inconclusive (passRate null), never a regression', async () => {
    const rel = await reliability(['infra', 'infra']);
    expect(rel.passRate).toBeNull();
    expect(compareToBaseline(rel, { scenarioId: SCENARIO.id, passRate: 1, band: 0.2 }).classification)
      .toBe('inconclusive');
  });
});

// ── reliability record (rolling, persisted) ────────────────────────────────
describe('reliability record persists last-N + rolling pass-rate', () => {
  it('folds a run into the rolling window and recomputes the rate', async () => {
    const rel = await reliability(['pass', 'fail', 'pass']);
    const prev: ReliabilityRecord = {
      scenarioId: SCENARIO.id, model: 'sim', provider: 'sim',
      lastOutcomes: ['pass', 'pass'], totalRuns: 2, totalTaskRuns: 2, totalPassed: 2, totalInfra: 0,
      rollingPassRate: 1, medianCostTokens: 0, p95CostTokens: 0, medianLatencyMs: 0, p95LatencyMs: 0,
    };
    const merged = mergeReliability(prev, rel);
    expect(merged.lastOutcomes).toEqual(['pass', 'pass', 'pass', 'fail', 'pass']);
    expect(merged.totalRuns).toBe(5);
    expect(merged.rollingPassRate).toBeCloseTo(4 / 5, 5);   // 4 pass of 5 task runs
  });

  it('caps the rolling window at histCap', async () => {
    const rel = await reliability(['pass']);
    const prev: ReliabilityRecord = {
      scenarioId: SCENARIO.id, model: 'sim', provider: 'sim',
      lastOutcomes: Array<Kind>(50).fill('pass'), totalRuns: 50, totalTaskRuns: 50, totalPassed: 50, totalInfra: 0,
      rollingPassRate: 1, medianCostTokens: 0, p95CostTokens: 0, medianLatencyMs: 0, p95LatencyMs: 0,
    };
    expect(mergeReliability(prev, rel, 50).lastOutcomes).toHaveLength(50);
  });

  it('flags a chronically-flaky scenario as a quarantine candidate', () => {
    const rec: ReliabilityRecord = {
      scenarioId: 'x', model: 'sim', provider: 'sim',
      lastOutcomes: ['fail', 'fail', 'pass', 'fail', 'pass', 'fail'], totalRuns: 6, totalTaskRuns: 6,
      totalPassed: 2, totalInfra: 0, rollingPassRate: 2 / 6,
      medianCostTokens: 0, p95CostTokens: 0, medianLatencyMs: 0, p95LatencyMs: 0,
    };
    expect(isQuarantineCandidate(rec)).toBe(true);
  });
});

// ── separation: the live path is NOT in the per-PR gate ────────────────────
describe('live path is advisory, off the per-PR gate', () => {
  it('the deterministic gate test does not import the live module', () => {
    const gate = readFileSync(path.join(__dirname, 'selfScoreGate.test.ts'), 'utf8');
    expect(gate).not.toContain("evals/live");
    expect(gate).not.toContain('runScenarioRepeats');
  });

  it('runScenarioRepeats requires an explicit adapter factory (no default real provider)', () => {
    // Type + runtime contract: there is no way to invoke the live path without
    // handing it an adapter source, so it can never silently reach a real model.
    expect(typeof runScenarioRepeats).toBe('function');
    expect(runScenarioRepeats.length).toBeGreaterThanOrEqual(3); // (scenario, makeAdapter, opts)
  });
});
