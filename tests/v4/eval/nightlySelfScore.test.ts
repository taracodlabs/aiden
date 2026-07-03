/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 Pillar 5 Slice C — the nightly self-score workflow + its report/issue
 * contract. The workflow yaml is asserted to trigger ONLY on schedule/dispatch
 * (never push/PR — the deterministic mock gate stays the sole PR blocker), to
 * skip cleanly when the API key is absent, and to open an issue on regression.
 * The report builders that drive the issue are unit-tested here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

import type { LiveComparison, ScenarioReliability } from '../../../evals/live';
import { buildLiveReport, regressionIssue } from '../../../evals/liveReport';

const WF_PATH = path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'selfscore-nightly.yml');

function mkRel(over: Partial<ScenarioReliability> = {}): ScenarioReliability {
  return {
    scenarioId: 'honesty/x', runs: 3, taskRuns: 3, passed: 3, infraErrors: 0,
    passRate: 1, outcomes: ['pass', 'pass', 'pass'],
    medianCostTokens: 1000, p95CostTokens: 1200, medianLatencyMs: 500, p95LatencyMs: 900,
    model: 'llama', provider: 'groq', ...over,
  };
}
function mkCmp(over: Partial<LiveComparison> = {}): LiveComparison {
  return {
    scenarioId: 'honesty/x', classification: 'ok', passRate: 1, baselinePassRate: 1,
    band: 0.34, taskRuns: 3, infraErrors: 0, ...over,
  };
}

// ── workflow triggers + secret handling ────────────────────────────────────
describe('nightly workflow — triggers + secret handling', () => {
  const raw = readFileSync(WF_PATH, 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wf = load(raw) as any;

  it('is valid yaml', () => {
    expect(wf).toBeTruthy();
    expect(wf.jobs).toBeTruthy();
  });

  it('triggers ONLY on schedule + workflow_dispatch — never push/PR', () => {
    // NB: yaml parses the bare `on:` key to boolean true, so read via the raw
    // key lookup. js-yaml keeps it under the string 'on' OR boolean true.
    const on = wf.on ?? wf[true];
    expect(on).toBeTruthy();
    expect(on.schedule).toBeTruthy();
    expect('workflow_dispatch' in on).toBe(true);
    expect('push' in on).toBe(false);
    expect('pull_request' in on).toBe(false);
  });

  it('has a nightly cron + dispatch inputs (repeats/model/subset)', () => {
    const on = wf.on ?? wf[true];
    expect(Array.isArray(on.schedule)).toBe(true);
    expect(on.schedule[0].cron).toMatch(/\d+ \d+ \* \* \*/);
    const inputs = on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(expect.arrayContaining(['repeats', 'model', 'subset']));
  });

  it('only requests issues:write (advisory — no contents write)', () => {
    expect(wf.permissions.issues).toBe('write');
    expect(wf.permissions.contents).toBe('read');
  });

  it('skips cleanly when the API key is absent (no hard fail, no leak)', () => {
    // The check step branches on the env-mapped secret and sets has_key; the
    // eval + issue steps are gated on has_key == 'true'.
    expect(raw).toMatch(/has_key=false/);
    expect(raw).toMatch(/skipping live self-score/i);
    expect(raw).toMatch(/steps\.check\.outputs\.has_key == 'true'/);
    // The secret is only ever mapped to env, never echoed.
    expect(raw).not.toMatch(/echo .*\$GROQ_API_KEY/);
  });

  it('opens an issue on regression via github-script (issues.create)', () => {
    expect(raw).toContain('actions/github-script');
    expect(raw).toContain('issues.create');
    expect(raw).toMatch(/report\.regressions/);
  });

  it('the run step is continue-on-error (a regression/infra flake never fails the job hard)', () => {
    expect(raw).toMatch(/continue-on-error:\s*true/);
  });
});

// ── report + issue builders ────────────────────────────────────────────────
describe('buildLiveReport + regressionIssue', () => {
  it('no regressions → issueTitle null, regressionIssue returns null', () => {
    const report = buildLiveReport({
      model: 'llama', provider: 'groq', repeats: 3,
      results: [{ rel: mkRel(), cmp: mkCmp({ classification: 'ok' }) }],
    });
    expect(report.regressions).toBe(0);
    expect(report.issueTitle).toBeNull();
    expect(regressionIssue(report)).toBeNull();
  });

  it('a regression → issue title + body naming the dropped scenario', () => {
    const report = buildLiveReport({
      model: 'llama', provider: 'groq', repeats: 5,
      results: [
        { rel: mkRel({ scenarioId: 'honesty/a' }), cmp: mkCmp({ scenarioId: 'honesty/a', classification: 'ok' }) },
        { rel: mkRel({ scenarioId: 'honesty/b', passRate: 0.2, passed: 1, taskRuns: 5 }),
          cmp: mkCmp({ scenarioId: 'honesty/b', classification: 'regression', passRate: 0.2, baselinePassRate: 1 }) },
      ],
    });
    expect(report.regressions).toBe(1);
    const issue = regressionIssue(report);
    expect(issue).not.toBeNull();
    expect(issue!.title).toMatch(/regression/i);
    expect(issue!.body).toContain('honesty/b');
    // advisory framing is explicit in the body.
    expect(issue!.body).toMatch(/advisory/i);
  });

  it('an infra-only (inconclusive) scenario is reported but never a regression', () => {
    const report = buildLiveReport({
      model: 'llama', provider: 'groq', repeats: 3,
      results: [{ rel: mkRel({ passRate: null, taskRuns: 0, infraErrors: 3, outcomes: ['infra', 'infra', 'infra'] }),
                  cmp: mkCmp({ classification: 'inconclusive', passRate: null }) }],
    });
    expect(report.regressions).toBe(0);
    expect(report.scenarios[0].classification).toBe('inconclusive');
    expect(regressionIssue(report)).toBeNull();
  });
});
