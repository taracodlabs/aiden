/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 Pillar 5 Slice A — the self-scoring gate.
 *
 * This file IS the per-PR gate: it runs the deterministic mock scoring suite,
 * loads the committed baseline, and fails the build if any capability
 * regressed. It runs in the normal CI vitest step (no new workflow, no tokens,
 * no network). The unit tests around it lock the scoring + gate semantics:
 * hard checks only, verified < pass-and-verify, safety is absolute, and a
 * baseline diff catches a dropped score.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { runEval, type EvalResult, type EvalScenario } from '../../../evals/runner';
import { runMockSuite } from '../../../evals/mockRun';
import {
  scoreScenario, scoreSuite, evaluateGate, verifiedScore, type SuiteScorecard,
} from '../../../evals/score';
import { scoringSmokeScenarios } from '../../../evals/suites/scoringSmoke';

const META = { suite: 'scoring-smoke', provider: 'mock' };

function mkResult(over: Partial<EvalResult> = {}): EvalResult {
  return {
    scenarioId: 'x', description: '', passed: true, durationMs: 0,
    toolCalls: [], finalResponse: '', failures: [],
    verdict: 'completed',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    turnCount: 2, toolCallCount: 1, interventions: 0, safety: false,
    ...over,
  };
}

// ── determinism ──────────────────────────────────────────────────────────
describe('mock mode is deterministic', () => {
  it('the same suite scored twice is bit-for-bit identical', async () => {
    const a = scoreSuite(await runMockSuite(scoringSmokeScenarios), META);
    const b = scoreSuite(await runMockSuite(scoringSmokeScenarios), META);
    expect(a).toEqual(b);
  });

  it('a single scenario scored twice yields the same verdict + axes', async () => {
    const one = scoringSmokeScenarios.filter((s) => s.id === 'smoke/read-only-complete');
    const [a] = await runMockSuite(one);
    const [b] = await runMockSuite(one);
    expect(scoreScenario(a)).toEqual(scoreScenario(b));
  });
});

// ── score() axes from a known result ──────────────────────────────────────
describe('score() computes the four axes (hard checks)', () => {
  it('maps passed/verdict/usage/steps/interventions to axes', () => {
    const card = scoreScenario(mkResult({
      passed: true, verdict: 'completed',
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      toolCallCount: 2, turnCount: 3, interventions: 1,
    }));
    expect(card.axes).toEqual({
      completed:     1,
      verified:      1,
      cost:          140,
      interventions: 1,
      steps:         5,   // toolCallCount 2 + turnCount 3
    });
  });

  it('a failed scenario scores completed = 0', () => {
    expect(scoreScenario(mkResult({ passed: false, verdict: 'failed' })).axes.completed).toBe(0);
  });
});

// ── verified < pass-and-verify (the key ordering) ─────────────────────────
describe('pass-but-not-verify scores lower than pass-and-verify', () => {
  it('verified axis is strictly ordered by verdict tier', () => {
    expect(verifiedScore('completed')).toBeGreaterThan(verifiedScore('completed_unverified'));
    expect(verifiedScore('completed_unverified')).toBeGreaterThan(verifiedScore('verification_failed'));
    expect(verifiedScore('verification_failed')).toBe(verifiedScore('failed'));
  });

  it('two scenarios that both PASS but differ on verification score differently', () => {
    const proved   = scoreScenario(mkResult({ passed: true, verdict: 'completed' }));
    const unproved = scoreScenario(mkResult({ passed: true, verdict: 'completed_unverified' }));
    // Both passed their expectations…
    expect(proved.axes.completed).toBe(unproved.axes.completed);
    // …but the one that proved its work scores higher on verified.
    expect(proved.axes.verified).toBeGreaterThan(unproved.axes.verified);
  });
});

// ── the gate: layered, safety-absolute, baseline-relative ─────────────────
describe('evaluateGate — layered, hard checks only', () => {
  const baseline = scoreSuite([
    mkResult({ scenarioId: 'safe',   safety: true,  passed: true, verdict: 'completed' }),
    mkResult({ scenarioId: 'mutate', safety: false, passed: true, verdict: 'completed' }),
  ], META);

  it('passes when nothing regressed', () => {
    const current = scoreSuite([
      mkResult({ scenarioId: 'safe',   safety: true,  passed: true, verdict: 'completed' }),
      mkResult({ scenarioId: 'mutate', safety: false, passed: true, verdict: 'completed' }),
    ], META);
    const gate = evaluateGate(current, baseline);
    expect(gate.ok).toBe(true);
    expect(gate.blocks).toEqual([]);
  });

  it('BLOCKS immediately when a safety scenario fails (binary, no averaging)', () => {
    const current = scoreSuite([
      mkResult({ scenarioId: 'safe',   safety: true,  passed: false, verdict: 'failed' }),
      mkResult({ scenarioId: 'mutate', safety: false, passed: true,  verdict: 'completed' }),
    ], META);
    const gate = evaluateGate(current, baseline);
    expect(gate.ok).toBe(false);
    expect(gate.blocks.some((b) => b.startsWith('SAFETY:'))).toBe(true);
  });

  it('BLOCKS when a scenario verdict drops a tier vs baseline', () => {
    const current = scoreSuite([
      mkResult({ scenarioId: 'safe',   safety: true,  passed: true, verdict: 'completed' }),
      mkResult({ scenarioId: 'mutate', safety: false, passed: true, verdict: 'verification_failed' }),
    ], META);
    const gate = evaluateGate(current, baseline);
    expect(gate.ok).toBe(false);
    expect(gate.blocks.some((b) => b.includes('completed→verification_failed'))).toBe(true);
  });

  it('BLOCKS when a scenario regresses passed→failed', () => {
    const current = scoreSuite([
      mkResult({ scenarioId: 'safe',   safety: true,  passed: true,  verdict: 'completed' }),
      mkResult({ scenarioId: 'mutate', safety: false, passed: false, verdict: 'failed' }),
    ], META);
    const gate = evaluateGate(current, baseline);
    expect(gate.ok).toBe(false);
    expect(gate.blocks.some((b) => b.includes('passed→failed'))).toBe(true);
  });

  it('a token/steps increase is a WARNING, not a block (capability gate, not perf gate)', () => {
    const current = scoreSuite([
      mkResult({ scenarioId: 'safe',   safety: true,  passed: true, verdict: 'completed' }),
      mkResult({ scenarioId: 'mutate', safety: false, passed: true, verdict: 'completed',
                 usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 } }),
    ], META);
    const gate = evaluateGate(current, baseline);
    expect(gate.ok).toBe(true);
    expect(gate.warnings.some((w) => w.startsWith('DRIFT:'))).toBe(true);
  });
});

// ── the manual real-provider path still works (backward compat) ───────────
describe('runEval real-provider signature still works', () => {
  it('returns a well-formed EvalResult (with the new axes) via an injected adapter', async () => {
    const adapter = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 't1', name: 'file_read', arguments: { path: '/x' } }]),
      MockProviderAdapter.stop('the file says y.'),
    ]);
    const scenario: EvalScenario = {
      id: 'compat', description: 'backward-compat probe', userInput: 'read x',
      expectations: [{ type: 'tool_called', toolName: 'file_read' }],
      executeTool: async (c) => ({ id: c.id, name: c.name, result: { content: 'y' } }),
    };
    const r = await runEval(scenario, { provider: { name: 'test', model: 'test' }, adapter });
    expect(r.passed).toBe(true);
    expect(r.verdict).toBe('completed');
    expect(r.toolCallCount).toBe(1);
    expect(r.usage.totalTokens).toBeGreaterThan(0);
  });
});

// ── THE CI GATE — mock suite vs committed baseline ────────────────────────
describe('CI gate: scoring-smoke suite vs committed baseline', () => {
  it('the deterministic mock run has NOT regressed against evals/baseline.json', async () => {
    const baselinePath = path.join(__dirname, '..', '..', '..', 'evals', 'baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as SuiteScorecard;
    const current = scoreSuite(await runMockSuite(scoringSmokeScenarios), META);
    const gate = evaluateGate(current, baseline);
    // If this fails, a change lowered a capability score. Inspect gate.blocks;
    // if the new behavior is intentional, regenerate with `npm run eval:baseline`.
    expect(gate.blocks).toEqual([]);
    expect(gate.ok).toBe(true);
  });
});
