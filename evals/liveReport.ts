/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * evals/liveReport.ts — v4.14 Pillar 5 Slice C.
 *
 * Pure report + issue-body builders for the nightly live run. The CLI writes a
 * LiveReport JSON; the nightly workflow reads it and, IFF `regressions > 0`,
 * opens a GitHub issue with the pre-rendered markdown. Keeping the body here (in
 * testable TS) means the workflow step stays a dumb "if regressions, create
 * issue" — no logic to get wrong in yaml.
 */

import type { LiveComparison, ScenarioReliability } from './live';

export interface LiveScenarioReport {
  scenarioId:       string;
  classification:   LiveComparison['classification'];
  passRate:         number | null;
  baselinePassRate: number;
  band:             number;
  taskRuns:         number;
  infraErrors:      number;
  medianCostTokens: number;
  p95LatencyMs:     number;
}

export interface LiveReport {
  model:       string;
  provider:    string;
  repeats:     number;
  /** ISO timestamp, stamped by the caller (Date is unavailable in some ctxs). */
  generatedAt: string | null;
  scenarios:   LiveScenarioReport[];
  regressions: number;
  /** Pre-rendered issue title/body; null when there is nothing to flag. */
  issueTitle:  string | null;
  issueBody:   string | null;
}

function pct(n: number | null): string {
  return n === null ? 'n/a' : `${Math.round(n * 100)}%`;
}

/**
 * Build the report from per-scenario (reliability, comparison) pairs. A
 * comparison of `null` means the scenario had no committed baseline entry — it
 * is reported but never counts as a regression.
 */
export function buildLiveReport(args: {
  model:       string;
  provider:    string;
  repeats:     number;
  generatedAt?: string | null;
  results:     Array<{ rel: ScenarioReliability; cmp: LiveComparison | null }>;
}): LiveReport {
  const scenarios: LiveScenarioReport[] = args.results.map(({ rel, cmp }) => ({
    scenarioId:       rel.scenarioId,
    classification:   cmp?.classification ?? 'inconclusive',
    passRate:         rel.passRate,
    baselinePassRate: cmp?.baselinePassRate ?? 0,
    band:             cmp?.band ?? 0,
    taskRuns:         rel.taskRuns,
    infraErrors:      rel.infraErrors,
    medianCostTokens: rel.medianCostTokens,
    p95LatencyMs:     rel.p95LatencyMs,
  }));
  const regressed = scenarios.filter((s) => s.classification === 'regression');
  const issue = regressed.length > 0 ? regressionIssueFrom(args.model, args.provider, scenarios) : null;

  return {
    model:       args.model,
    provider:    args.provider,
    repeats:     args.repeats,
    generatedAt: args.generatedAt ?? null,
    scenarios,
    regressions: regressed.length,
    issueTitle:  issue?.title ?? null,
    issueBody:   issue?.body ?? null,
  };
}

function regressionIssueFrom(
  model: string,
  provider: string,
  scenarios: LiveScenarioReport[],
): { title: string; body: string } {
  const regressed = scenarios.filter((s) => s.classification === 'regression');
  const title = `[self-score] nightly regression: ${regressed.length} scenario(s) dropped below baseline`;
  const rows = scenarios.map((s) => {
    const flag = s.classification === 'regression' ? ' ⛔' : '';
    return `| \`${s.scenarioId}\` | ${pct(s.passRate)} | ${pct(s.baselinePassRate)} | ±${Math.round(s.band * 100)}% | ${s.classification}${flag} | ${s.infraErrors} |`;
  });
  const body = [
    `Nightly self-scoring found a **pass-rate regression** on \`${provider}/${model}\`.`,
    '',
    'A scenario is flagged only when its pass-rate fell **below (baseline − band)** across repeats — infra errors (timeouts/429/network) are excluded, and a single miss never flags. This is **advisory**: the per-PR gate is the deterministic mock gate and is unaffected.',
    '',
    '| scenario | pass-rate | baseline | band | class | infra |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    `**Regressed:** ${regressed.map((s) => `\`${s.scenarioId}\``).join(', ')}`,
    '',
    'Next: re-run manually (`workflow_dispatch` with more repeats) to confirm it is not noise; if real, investigate the change; if the model genuinely shifted, recalibrate `evals/baseline-live.json`.',
  ].join('\n');
  return { title, body };
}

/** Issue payload for the nightly — null when there is nothing to open. */
export function regressionIssue(report: LiveReport): { title: string; body: string } | null {
  if (report.regressions <= 0 || !report.issueTitle || !report.issueBody) return null;
  return { title: report.issueTitle, body: report.issueBody };
}
