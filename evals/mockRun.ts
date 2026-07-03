/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * evals/mockRun.ts — v4.14 Pillar 5 Slice A.
 *
 * Deterministic mock-provider driver. Each scenario carries a `script`
 * (ProviderCallOutput[]); we replay it through a MockProviderAdapter — the
 * same scripted adapter the agent-loop unit tests use — so a run is bit-for-bit
 * repeatable, free, and network-free. This is the CI-gateable path; the real
 * provider stays available through the normal `runEval` adapter for the later
 * nightly (Slice C).
 *
 * A scenario without a `script` cannot run deterministically and is reported as
 * an infrastructure failure rather than silently skipped — a scored suite that
 * quietly dropped a scenario would read as "all green" while covering less.
 */

import { MockProviderAdapter } from '../core/v4/__mocks__/mockProvider';
import { runEval, type EvalScenario, type EvalResult } from './runner';

/**
 * Disable the TCE recovery ladder (AIDEN_TCE=0) for the duration of `fn`. The
 * per-tool verifier stays on — it's pure/synchronous, so a scripted result maps
 * to a fixed verdict — but the recovery ladder can runtime-RETRY a transient
 * failure, which would make the step/tool-call counts vary run to run. Off, the
 * counts are exact. Env is saved and restored so the harness never leaks the
 * toggle into a co-resident test process.
 */
async function withDeterministicLoop<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AIDEN_TCE;
  process.env.AIDEN_TCE = '0';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AIDEN_TCE;
    else process.env.AIDEN_TCE = prev;
  }
}

/** Run one scripted scenario against a MockProviderAdapter. */
export async function runMockScenario(scenario: EvalScenario): Promise<EvalResult> {
  if (!scenario.script || scenario.script.length === 0) {
    return {
      scenarioId:    scenario.id,
      description:   scenario.description,
      passed:        false,
      durationMs:    0,
      toolCalls:     [],
      finalResponse: '',
      failures:      [`mock run requires a 'script'; scenario '${scenario.id}' has none`],
      verdict:       'failed',
      usage:         { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount:     0,
      toolCallCount: 0,
      interventions: 0,
      safety:        scenario.safety ?? false,
    };
  }
  const adapter = new MockProviderAdapter(scenario.script);
  return withDeterministicLoop(() =>
    runEval(scenario, { provider: { name: 'mock', model: 'mock' }, adapter }));
}

/** Run a whole suite deterministically through the mock provider (serial). */
export async function runMockSuite(scenarios: EvalScenario[]): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runMockScenario(scenario));
  }
  return results;
}
