/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * evals/cli.ts — Phase v4.1.2-slice2.
 *
 * `npm run eval` entrypoint. Parses flags, resolves a provider,
 * runs the chosen suite (or single scenario), prints colored pass/fail
 * rows, and persists results to `evals/results/<ISO>.json`.
 *
 * Default provider is chatgpt-plus + gpt-5.5 to match the locked
 * interactive default. When no OAuth or that provider isn't reachable,
 * the runner falls back to the test-provider chain (Groq tiers,
 * Together) via the same helper integration tests use — so the eval
 * suite stays runnable even without ChatGPT Plus auth on the box.
 *
 * Exit codes:
 *   0  — runner completed (scenario failures are signal, not failure)
 *   1  — runner crashed OR `--strict` was passed AND any scenario failed
 *
 * Flags:
 *   --suite <name>          run a named suite (default: 'honesty')
 *   --scenario <id>         run one scenario by id (overrides --suite)
 *   --provider <name>       override default provider
 *   --model <id>            override default model
 *   --timeout <ms>          per-scenario timeout override
 *   --strict                exit 1 if any scenario fails
 *   --no-write              don't persist results to disk
 *   --help                  show usage and exit 0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { runEval, type EvalScenario, type EvalResult } from './runner';
import { runMockSuite } from './mockRun';
import { scoreSuite, evaluateGate, type SuiteScorecard } from './score';
import {
  runScenarioRepeats, aggregateReliability, compareToBaseline, mergeReliability,
  isQuarantineCandidate, type LiveComparison, type ScenarioReliability,
} from './live';
import { buildLiveReport } from './liveReport';
import { loadLiveBaseline, loadReliability, saveReliability } from './liveStore';
import { SUITES } from './index';
import type { ProviderAdapter } from '../providers/v4/types';
import { resolveAidenPaths } from '../core/v4/paths';
import { VERSION } from '../core/version';

/** Committed deterministic baseline for the mock scoring gate. */
const BASELINE_PATH = path.join(__dirname, 'baseline.json');

// ── ANSI helpers (tiny, no chalk dep) ──────────────────────────────────
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';
const YELLOW = '\x1b[33m';

// ── Flag parsing ───────────────────────────────────────────────────────

interface ParsedFlags {
  suite:            string;
  scenario?:        string;
  provider?:        string;
  model?:           string;
  timeoutMs?:       number;
  strict:           boolean;
  write:            boolean;
  help:             boolean;
  gate:             boolean;
  updateBaseline:   boolean;
  // ── v4.14 Slice B — real-model live path (advisory, nightly-bound) ──────
  live:             boolean;
  repeats:          number;
  subset?:          string[];
  failOnRegression: boolean;
  report?:          string;
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: ParsedFlags = {
    suite: 'honesty',
    strict: false,
    write: true,
    help: false,
    gate: false,
    updateBaseline: false,
    live: false,
    repeats: 3,
    failOnRegression: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--suite':             out.suite = next; i++; break;
      case '--scenario':          out.scenario = next; i++; break;
      case '--provider':          out.provider = next; i++; break;
      case '--model':             out.model = next; i++; break;
      case '--timeout':           out.timeoutMs = Number(next); i++; break;
      case '--strict':            out.strict = true; break;
      case '--no-write':          out.write = false; break;
      case '--gate':              out.gate = true; break;
      case '--update-baseline':   out.updateBaseline = true; break;
      case '--live':              out.live = true; break;
      case '--repeats':           out.repeats = Math.max(1, Number(next) || 3); i++; break;
      case '--subset':            out.subset = next.split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      case '--fail-on-regression': out.failOnRegression = true; break;
      case '--report':            out.report = next; i++; break;
      case '--help':
      case '-h':                  out.help = true; break;
      default:
        if (arg.startsWith('--')) {
          // Unknown flag — surface but don't crash; future-proofs CI scripts.
          process.stderr.write(`${YELLOW}warn:${RESET} unknown flag '${arg}' ignored\n`);
        }
    }
  }
  // Env-var overrides.
  out.provider ??= process.env.AIDEN_EVAL_PROVIDER ?? 'chatgpt-plus';
  out.model    ??= process.env.AIDEN_EVAL_MODEL    ?? 'gpt-5.5';
  return out;
}

function printUsage(): void {
  const lines = [
    '',
    `${BOLD}aiden eval${RESET}  —  scenario-driven behavior measurement`,
    '',
    'Usage:',
    '  npm run eval -- [flags]',
    '  npm run eval:honesty',
    '  npm run eval -- --scenario <id>',
    '',
    'Flags:',
    '  --suite <name>          suite to run (default: honesty)',
    '  --scenario <id>         single scenario id (overrides --suite)',
    `  --provider <name>       provider id (default: chatgpt-plus, env: AIDEN_EVAL_PROVIDER)`,
    `  --model    <id>         model id    (default: gpt-5.5,       env: AIDEN_EVAL_MODEL)`,
    '  --timeout <ms>          per-scenario timeout override (default 60000)',
    '  --strict                exit 1 if any scenario fails (default: always exit 0)',
    '  --no-write              do not persist results to evals/results/',
    '',
    `  ${BOLD}--provider mock${RESET}         deterministic, free, no network (scripted scenarios)`,
    '  --gate                  (mock) score vs evals/baseline.json; exit 1 on capability regression',
    '  --update-baseline       (mock) regenerate evals/baseline.json from this run',
    '',
    `  ${BOLD}--live${RESET}                  real-model, repeat-runs, ADVISORY (not the per-PR gate)`,
    '  --repeats <n>           runs per scenario for the pass-rate (default 3)',
    '  --subset <a,b,c>        scenario ids to run (default: evals/baseline-live.json subset)',
    '  --fail-on-regression    (live) exit 1 on a pass-rate regression — nightly opt-in only',
    '',
    `Available suites: ${Object.keys(SUITES).join(', ')}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

// ── Provider resolution ────────────────────────────────────────────────

/**
 * Resolve the provider adapter. Tries the locked default first
 * (chatgpt-plus via the live RuntimeResolver against the user's
 * tokenStore), falls back to the integration-test provider chain
 * (Groq tiers / Together via env-var keys).
 *
 * Returns null when neither path works — caller prints a usage hint.
 */
async function resolveAdapter(flags: ParsedFlags): Promise<{
  adapter:   ProviderAdapter;
  provider:  string;
  model:     string;
  source:    'runtime' | 'test-chain';
} | null> {
  // Try the runtime resolver first (matches what `aiden` itself uses).
  try {
    const { RuntimeResolver } = await import('../providers/v4/runtimeResolver');
    const { CredentialResolver } = await import('../providers/v4/credentialResolver');
    const paths = resolveAidenPaths();
    const resolver = new RuntimeResolver(new CredentialResolver(paths.authJson));
    const adapter = await resolver.resolve({
      providerId: flags.provider!,
      modelId:    flags.model!,
      paths,
    });
    return {
      adapter,
      provider: flags.provider!,
      model:    flags.model!,
      source:   'runtime',
    };
  } catch (err) {
    process.stderr.write(
      `${DIM}runtime resolver failed (${(err as Error).message}); falling back to test-provider chain...${RESET}\n`,
    );
  }

  // Fall back to the test-provider chain.
  try {
    const { getTestProvider } = await import('../tests/v4/_helpers/testProvider');
    const tp = await getTestProvider();
    if (!tp) return null;
    return {
      adapter:  tp.adapter,
      provider: tp.providerId,
      model:    tp.modelId,
      source:   'test-chain',
    };
  } catch {
    return null;
  }
}

// ── Output ─────────────────────────────────────────────────────────────

function fmtResult(r: EvalResult): string {
  const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const idCol = r.scenarioId.padEnd(46);
  const dur  = `${DIM}(${(r.durationMs / 1000).toFixed(1)}s)${RESET}`;
  return `  ${icon} ${idCol} ${dur}`;
}

function fmtFailures(r: EvalResult): string {
  if (r.passed || r.failures.length === 0) return '';
  return r.failures.map((f) => `      ${RED}↳${RESET} ${f}`).join('\n') + '\n';
}

// ── Result persistence ─────────────────────────────────────────────────

async function persistResults(payload: unknown): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'results');
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return outPath;
}

// ── Scorecard rendering (mock mode) ──────────────────────────────────────

function fmtVerdict(v: EvalResult['verdict']): string {
  const c = v === 'completed' ? GREEN
    : v === 'completed_unverified' ? YELLOW
    : RED;
  return `${c}${v}${RESET}`;
}

function fmtScored(r: EvalResult): string {
  const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const tag  = r.safety ? `${DIM}[safety]${RESET} ` : '';
  const idCol = (tag + r.scenarioId).padEnd(58);
  return `  ${icon} ${idCol} ${fmtVerdict(r.verdict)}` +
    `${DIM}  ·  ${r.usage.totalTokens}tok · ${r.toolCallCount + r.turnCount} steps · ${r.interventions} interv${RESET}`;
}

// ── Mock-provider gate (deterministic, free) ─────────────────────────────

async function loadBaseline(): Promise<SuiteScorecard | null> {
  try {
    return JSON.parse(await fs.readFile(BASELINE_PATH, 'utf8')) as SuiteScorecard;
  } catch {
    return null;
  }
}

async function runMockMode(
  scenarios: EvalScenario[],
  suiteLabel: string,
  flags: ParsedFlags,
): Promise<number> {
  process.stdout.write(`\n${BOLD}aiden eval${RESET}  ·  ${suiteLabel}  ${DIM}(mock — deterministic)  ·  aiden v${VERSION}${RESET}\n\n`);
  const results = await runMockSuite(scenarios);
  for (const r of results) {
    process.stdout.write(fmtScored(r) + '\n');
    if (!r.passed) process.stdout.write(fmtFailures(r));
  }
  const scorecard = scoreSuite(results, { suite: suiteLabel, provider: 'mock' });
  const t = scorecard.totals;
  process.stdout.write(
    `\n${DIM}verdicts:${RESET} ${t.completed} completed · ${t.completedUnverified} unverified · ` +
    `${t.verificationFailed} verify-failed · ${t.failed} failed` +
    `${DIM}  ·  ${t.totalTokens} tok · ${t.totalSteps} steps · ${t.totalInterventions} interv${RESET}\n`,
  );

  // Regenerate the committed baseline.
  if (flags.updateBaseline) {
    await fs.writeFile(BASELINE_PATH, JSON.stringify(scorecard, null, 2) + '\n', 'utf8');
    process.stdout.write(`${GREEN}✓${RESET} baseline written: ${BASELINE_PATH}\n`);
    return 0;
  }

  // Gate against the committed baseline.
  if (flags.gate) {
    const baseline = await loadBaseline();
    if (!baseline) {
      process.stderr.write(`${RED}✗${RESET} no baseline at ${BASELINE_PATH} — run with --update-baseline first.\n`);
      return 1;
    }
    const gate = evaluateGate(scorecard, baseline);
    for (const w of gate.warnings) process.stdout.write(`  ${YELLOW}!${RESET} ${w}\n`);
    if (gate.ok) {
      process.stdout.write(`\n${GREEN}${BOLD}GATE PASS${RESET}${DIM}  ·  no capability regression vs baseline${RESET}\n`);
      return 0;
    }
    process.stdout.write(`\n${RED}${BOLD}GATE FAIL${RESET}\n`);
    for (const b of gate.blocks) process.stdout.write(`  ${RED}✗${RESET} ${b}\n`);
    return 1;
  }

  return flags.strict && t.passed < t.total ? 1 : 0;
}

// ── Live mode (real model, repeat-runs, advisory) ────────────────────────

function fmtClass(c: LiveComparison['classification']): string {
  const color = c === 'regression' ? RED
    : c === 'flaky_or_infra' || c === 'inconclusive' ? YELLOW
    : GREEN;
  return `${color}${c}${RESET}`;
}

async function runLiveMode(flags: ParsedFlags): Promise<number> {
  const baseline = await loadLiveBaseline();
  const subset = flags.subset ?? baseline?.subset ?? [];
  if (subset.length === 0) {
    process.stderr.write(`${RED}✗${RESET} no live subset (pass --subset a,b or seed evals/baseline-live.json).\n`);
    return 1;
  }
  const resolved = await resolveAdapter(flags);
  if (!resolved) {
    process.stderr.write(
      `${RED}✗${RESET} live mode needs a real provider. Set GROQ_API_KEY / TOGETHER_API_KEY or log in, ` +
      `then re-run (e.g. --provider groq --model llama-3.3-70b-versatile).\n`,
    );
    return 1;
  }

  process.stdout.write(
    `\n${BOLD}aiden eval — live${RESET}  ${DIM}(advisory · NOT the per-PR gate)${RESET}\n` +
    `${DIM}provider: ${resolved.provider} / ${resolved.model}  ·  repeats: ${flags.repeats}  ·  aiden v${VERSION}${RESET}\n\n`,
  );

  const allScenarios = Object.values(SUITES).flat();
  const records = await loadReliability();
  const reportRows: Array<{ rel: ScenarioReliability; cmp: LiveComparison | null }> = [];
  let regressions = 0;

  for (const id of subset) {
    const scenario = allScenarios.find((s) => s.id === id);
    if (!scenario) {
      process.stdout.write(`  ${YELLOW}!${RESET} ${id} ${DIM}— not found in any suite; skipped${RESET}\n`);
      continue;
    }
    const outcomes = await runScenarioRepeats(scenario, () => resolved.adapter, {
      repeats:   flags.repeats,
      provider:  resolved.provider,
      model:     resolved.model,
      timeoutMs: flags.timeoutMs,
    });
    const rel = aggregateReliability(id, outcomes, { model: resolved.model, provider: resolved.provider });
    const entry = baseline?.entries[id];
    const cmp = entry
      ? compareToBaseline(rel, entry, { band: baseline?.band })
      : null;
    reportRows.push({ rel, cmp });
    if (cmp?.classification === 'regression') regressions += 1;

    const rate = rel.passRate === null ? 'n/a' : `${rel.passed}/${rel.taskRuns} (${(rel.passRate * 100).toFixed(0)}%)`;
    const cls  = cmp ? `  ·  ${fmtClass(cmp.classification)}` : '';
    process.stdout.write(
      `  ${id.padEnd(46)} ${rate.padEnd(14)} ${DIM}[${rel.outcomes.join(',')}]${RESET}` +
      `${DIM}  ·  ${rel.infraErrors} infra · p95 ${rel.p95CostTokens}tok/${rel.p95LatencyMs}ms${RESET}${cls}\n`,
    );

    const merged = mergeReliability(records[id], rel);
    records[id] = merged;
    if (isQuarantineCandidate(merged)) {
      process.stdout.write(`      ${YELLOW}⚠ quarantine candidate${RESET} ${DIM}— rolling pass-rate ${((merged.rollingPassRate ?? 0) * 100).toFixed(0)}%${RESET}\n`);
    }
  }

  if (flags.write) {
    try { await saveReliability(records); process.stdout.write(`\n${DIM}reliability updated: evals/reliability.json${RESET}\n`); }
    catch (err) { process.stderr.write(`${YELLOW}warn:${RESET} could not save reliability: ${(err as Error).message}\n`); }
  }

  // Machine-readable report for the nightly workflow (issue-on-regression).
  if (flags.report) {
    const report = buildLiveReport({
      model: resolved.model, provider: resolved.provider, repeats: flags.repeats,
      generatedAt: new Date().toISOString(), results: reportRows,
    });
    try {
      await fs.writeFile(flags.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
      process.stdout.write(`${DIM}report: ${flags.report}${RESET}\n`);
    } catch (err) {
      process.stderr.write(`${YELLOW}warn:${RESET} could not write report: ${(err as Error).message}\n`);
    }
  }

  // Advisory by default — a regression is reported but does NOT fail the run
  // unless the nightly explicitly opts in with --fail-on-regression.
  if (regressions > 0) {
    process.stdout.write(`\n${YELLOW}${BOLD}${regressions} regression flag(s)${RESET}${DIM} — advisory; review before acting.${RESET}\n`);
    return flags.failOnRegression ? 1 : 0;
  }
  process.stdout.write(`\n${GREEN}no regressions vs live baseline${RESET}\n`);
  return 0;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (flags.help) { printUsage(); return 0; }
  if (flags.live) return runLiveMode(flags);

  // Pick the scenarios to run.
  let scenarios: EvalScenario[];
  let suiteLabel: string;
  if (flags.scenario) {
    // Search across every registered suite for the requested id.
    const all = Object.values(SUITES).flat();
    const hit = all.find((s) => s.id === flags.scenario);
    if (!hit) {
      process.stderr.write(`${RED}✗${RESET} scenario '${flags.scenario}' not found.\n`);
      process.stderr.write(`Available ids:\n${all.map((s) => '  ' + s.id).join('\n')}\n`);
      return 1;
    }
    scenarios = [hit];
    suiteLabel = `single:${hit.id}`;
  } else {
    const s = SUITES[flags.suite];
    if (!s) {
      process.stderr.write(`${RED}✗${RESET} suite '${flags.suite}' not found.\n`);
      process.stderr.write(`Available: ${Object.keys(SUITES).join(', ')}\n`);
      return 1;
    }
    scenarios = s;
    suiteLabel = flags.suite;
  }

  // v4.14 Slice A — mock mode: deterministic, free, gate-capable. No provider.
  if (flags.provider === 'mock') {
    return runMockMode(scenarios, suiteLabel, flags);
  }

  // Resolve the provider.
  const resolved = await resolveAdapter(flags);
  if (!resolved) {
    process.stderr.write(
      `${RED}✗${RESET} could not resolve a provider. Either:\n` +
      `  • Log in to chatgpt-plus via '/auth login chatgpt-plus' and re-run, or\n` +
      `  • Set GROQ_API_KEY / TOGETHER_API_KEY for the test-provider fallback.\n`,
    );
    return 1;
  }

  const startedAt = new Date().toISOString();
  const start = Date.now();

  process.stdout.write(`\n${BOLD}aiden eval${RESET}  ·  ${suiteLabel}\n`);
  process.stdout.write(
    `${DIM}provider: ${resolved.provider} / ${resolved.model}` +
    `  (source: ${resolved.source})  ·  aiden v${VERSION}${RESET}\n\n`,
  );

  const results: EvalResult[] = [];
  for (const scenario of scenarios) {
    const result = await runEval(scenario, {
      provider:  { name: resolved.provider, model: resolved.model },
      adapter:   resolved.adapter,
      timeoutMs: flags.timeoutMs,
    });
    results.push(result);
    process.stdout.write(fmtResult(result) + '\n');
    if (!result.passed) process.stdout.write(fmtFailures(result));
  }

  const finishedAt = new Date().toISOString();
  const totalMs = Date.now() - start;
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.length - passedCount;

  const summaryColor = failedCount === 0 ? GREEN : YELLOW;
  process.stdout.write(
    `\n${summaryColor}${passedCount}/${results.length} passed` +
    `${RESET}${DIM}  ·  ${(totalMs / 1000).toFixed(1)}s total${RESET}\n`,
  );

  // Persist unless suppressed.
  if (flags.write) {
    const payload = {
      startedAt,
      finishedAt,
      provider:      { name: resolved.provider, model: resolved.model, source: resolved.source },
      aidenVersion:  VERSION,
      suite:         suiteLabel,
      scenarios:     results.map((r) => ({
        id:            r.scenarioId,
        description:   r.description,
        passed:        r.passed,
        durationMs:    r.durationMs,
        toolCalls:     r.toolCalls,
        finalResponse: r.finalResponse,
        failures:      r.failures,
      })),
      summary: {
        total:     results.length,
        passed:    passedCount,
        failed:    failedCount,
        durationMs: totalMs,
      },
    };
    try {
      const out = await persistResults(payload);
      process.stdout.write(`${DIM}results: ${out}${RESET}\n`);
    } catch (err) {
      process.stderr.write(
        `${YELLOW}warn:${RESET} could not persist results: ${(err as Error).message}\n`,
      );
    }
  }

  // Exit-code policy: 0 unless --strict, in which case map to pass-rate.
  return flags.strict && failedCount > 0 ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${RED}eval harness crashed:${RESET} ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
