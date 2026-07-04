/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/doctor.ts — Aiden v4.0.0 (Phase 14a)
 *
 * `aiden doctor` — diagnostic checks the user can run before opening a
 * support ticket. Each check returns a structured result; runDoctor
 * aggregates them and exits 0 (all pass) or 1 (any failure).
 *
 * Each individual check is wrapped with a 3 s per-check timeout so that
 * a stuck dependency probe never blocks the whole report. The aggregate
 * runtime is therefore bounded at roughly N × 3 s in the worst case but
 * will normally be sub-second.
 *
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { resolveAidenPaths, type AidenPaths } from '../../core/v4/paths';
import { isQuarantineCandidate } from '../../core/v4/reliability';
import { LicenseClient, hasLicense } from '../../core/v4/license';
import { checkForUpdate } from '../../core/v4/update/checkUpdate';
import type { Display } from './display';
import { boxBottom, boxLine, boxTopTitled, visibleLength } from './box';
import { detectBackend, missingBackendMessage, listKnownBackends } from '../../core/voice/audioBackend';

/**
 * v4.1.3-essentials doctor-polish: stable group identifiers used by the
 * renderer to group checks under section headers. Order here is the
 * display order — Providers first (most likely to fail / matter most),
 * then Inference, then the supporting infrastructure groups.
 *
 * Optional sections (Subsystem health / Skill outcomes / Provider
 * liveness) get their own groups appended after the main set.
 */
export type DoctorGroup =
  | 'Providers'
  | 'Inference'
  | 'System tools'
  | 'Storage'
  | 'Voice'
  | 'Updates'
  | 'Subsystem health'
  | 'Skill outcomes'
  | 'Session counters'
  | 'Provider liveness';

/**
 * Display order for groups. Renderer iterates this list rather than
 * the order checks appear in the results array — keeps the visual
 * hierarchy stable even if `runDoctor` reorders its check sequence.
 */
export const DOCTOR_GROUP_ORDER: readonly DoctorGroup[] = [
  'Providers',
  'Inference',
  'System tools',
  'Storage',
  'Voice',
  'Updates',
  'Subsystem health',
  'Skill outcomes',
  // v4.1.3-essentials doctor-polish: session counters land just
  // above provider liveness — they're agent-loop telemetry, distinct
  // from skill outcomes (per-skill stats) and subsystem health
  // (per-subsystem error tracking).
  'Session counters',
  'Provider liveness',
];

export interface CheckResult {
  name: string;
  /** v4.1.3-essentials doctor-polish: group key the renderer uses to
   *  bucket this row under a section header. */
  group: DoctorGroup;
  passed: boolean;
  message: string;
  suggestion?: string;
  durationMs?: number;
}

export interface DoctorReport {
  results: CheckResult[];
  passed: boolean;
  totalMs: number;
}

export interface DoctorOptions {
  paths?: AidenPaths;
  /** Per-check timeout in ms. Default 3 000. */
  timeoutMs?: number;
  /**
   * Override fetch implementation — tests inject a mock so the Ollama
   * probe doesn't hit the real network.
   */
  fetchImpl?: typeof fetch;
  /**
   * Override `child_process.spawn`. Tests inject a stub so we don't have
   * to assume python/docker/npx exist on the runner.
   */
  spawnImpl?: typeof spawn;
  /** Override env (defaults to process.env). Tests use this to stub keys. */
  env?: NodeJS.ProcessEnv;
  /**
   * Phase v4.1.1-oauth-fix Phase 4: when true, doctor also pings every
   * configured / authed provider with a minimal request and prints a
   * per-provider liveness section below the standard health box.
   * Default false — keeps `aiden doctor` fast and offline-friendly.
   */
  liveness?: boolean;
  /**
   * Per-liveness-probe timeout in ms. Default 8 000. Independent of
   * `timeoutMs` (which gates the offline config checks) because real
   * provider round-trips can legitimately take 1-2 seconds.
   */
  livenessTimeoutMs?: number;
  /**
   * Phase v4.1.2-slice3: in-process subsystem-health surface. When
   * provided, the doctor renders a "Subsystem health" block; when
   * omitted (standalone `aiden doctor` from a fresh process), the
   * section is skipped — there's no live agent to read state from.
   *
   * In-REPL doctor invocations pass `agent.subsystemHealthRegistry`
   * here; standalone CLI invocations don't have one.
   */
  subsystemHealthRegistry?: import('../../core/v4/subsystemHealth').SubsystemHealthRegistry;
  /**
   * Phase v4.1.2-slice4: optional in-process skill-outcome tracker.
   * When provided, doctor renders a "Skill outcomes" section showing
   * the top skills by load count with success rates. Omitted entirely
   * on standalone CLI invocations (no live agent → no outcome state).
   */
  skillOutcomeTracker?: import('../../core/v4/skillOutcomeTracker').SkillOutcomeTracker;
}

/**
 * v4.1.3-essentials doctor-polish: convert the subsystem-health
 * registry snapshot into CheckResult rows so they render inside the
 * grouped health box alongside the other checks. Returns an empty
 * array when the registry is undefined / empty so the renderer skips
 * the group cleanly (DOCTOR_GROUP_ORDER drops empty groups).
 *
 * One row per subsystem, plus a fixed "(not instrumented yet)" row
 * for HonestyEnforcement — same convention as the legacy section
 * renderer below.
 */
export function subsystemHealthResults(
  registry: import('../../core/v4/subsystemHealth').SubsystemHealthRegistry | undefined,
): CheckResult[] {
  if (!registry) return [];
  const snaps = registry.snapshot();
  if (snaps.length === 0) return [];
  const out: CheckResult[] = [];
  for (const s of snaps) {
    const passed = s.totalErrors === 0;
    const stats = `${s.totalCalls} call${s.totalCalls === 1 ? '' : 's'}, ${s.totalErrors} error${s.totalErrors === 1 ? '' : 's'}`;
    let message = stats;
    let suggestion: string | undefined;
    if (s.lastError) {
      const ago = humanAge(Date.now() - s.lastError.at.getTime());
      const streak = s.lastError.consecutive > 1
        ? ` (${s.lastError.consecutive} consecutive)`
        : '';
      message = `${stats}${streak}`;
      suggestion = `last ${ago} ago: "${s.lastError.message}"`;
    }
    out.push({
      name: s.subsystem,
      group: 'Subsystem health',
      passed,
      message,
      ...(suggestion ? { suggestion } : {}),
    });
  }
  // Slice3 audit decision: HonestyEnforcement was deliberately not
  // instrumented (pure-pattern path has no failure surface). Surface
  // that explicitly so users know the gap is known, not forgotten.
  out.push({
    name: 'honesty',
    group: 'Subsystem health',
    passed: true,
    message: '(not instrumented yet)',
  });
  return out;
}

/**
 * Phase v4.1.2-slice3: render the Subsystem health section.
 *
 * v4.1.3-essentials doctor-polish: kept for back-compat with any
 * direct callers but the in-REPL `/doctor` path now uses
 * `subsystemHealthResults()` and renders inline via the grouped box.
 *
 * Decision tree (per slice3 Phase 3 Q4):
 *   - registry undefined → render nothing (no live state to report)
 *   - all subsystems healthy → one-line green summary
 *   - any degradation → expand block with last-error per failed sub
 *
 * The Honesty layer is intentionally listed as "(not instrumented yet)"
 * when the expanded block fires, because the audit determined the
 * pure-pattern path has no I/O failure surface today.
 */
export function renderSubsystemHealthSection(
  registry: import('../../core/v4/subsystemHealth').SubsystemHealthRegistry | undefined,
): string {
  if (!registry) return '';
  const snaps = registry.snapshot();
  if (snaps.length === 0) return '';

  const degraded = snaps.filter((s) => s.totalErrors > 0);
  if (degraded.length === 0) {
    return `\nSubsystem health: all green (${snaps.length} subsystems instrumented)\n`;
  }

  // Expanded form. Per-subsystem rows:
  //   ✓ name        N calls, 0 errors
  //   ✗ name        N calls, E errors  (last <duration> ago: "message")
  //   - honesty     (not instrumented yet)
  const lines: string[] = ['\nSubsystem health'];
  for (const s of snaps) {
    const mark = s.totalErrors > 0 ? 'x' : 'ok';
    const stats = `${s.totalCalls} call${s.totalCalls === 1 ? '' : 's'}, ${s.totalErrors} error${s.totalErrors === 1 ? '' : 's'}`;
    if (s.lastError) {
      const ago = humanAge(Date.now() - s.lastError.at.getTime());
      const streak = s.lastError.consecutive > 1
        ? ` (${s.lastError.consecutive} consecutive)`
        : '';
      lines.push(
        `  [${mark}] ${s.subsystem.padEnd(16)} ${stats}${streak}  (last ${ago} ago: "${s.lastError.message}")`,
      );
    } else {
      lines.push(`  [${mark}] ${s.subsystem.padEnd(16)} ${stats}`);
    }
  }
  // Slice3 audit decision: HonestyEnforcement was deliberately not
  // instrumented (pure-pattern path has no failure surface). Surface
  // that explicitly so users know the gap is known, not forgotten.
  lines.push(`  [-]  honesty          (not instrumented yet)`);
  lines.push('');
  return lines.join('\n');
}

function humanAge(ms: number): string {
  if (ms < 1_000)       return `${ms}ms`;
  if (ms < 60_000)      return `${(ms / 1_000).toFixed(0)}s`;
  if (ms < 3_600_000)   return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000)  return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/**
 * v4.1.3-essentials doctor-polish: convert the skill-outcome tracker
 * snapshot into CheckResult rows so they render inside the grouped
 * health box. Empty tracker → empty array → group dropped by renderer.
 *
 * One row per top-N skill (sorted by load count). Skills with at
 * least one failure render as `passed:false` so they get the red
 * `✗` icon and a hint line with the last-error message.
 */
export function skillOutcomeResults(
  tracker: import('../../core/v4/skillOutcomeTracker').SkillOutcomeTracker | undefined,
  topN = 5,
): CheckResult[] {
  if (!tracker) return [];
  const snaps = tracker.snapshot();
  if (snaps.length === 0) return [];
  const out: CheckResult[] = [];
  for (const s of snaps.slice(0, topN)) {
    // v4.14 Pillar 6 Slice B — read the rolling verdict record, not the old
    // tool-success counters.
    const rel = s.reliability;
    const rate = rel.rollingPassRate === null
      ? '—'
      : `${Math.round(rel.rollingPassRate * 100)}% pass`;
    const quarantine = isQuarantineCandidate(rel);
    const last = s.lastUsed
      ? `, last ${humanAge(Date.now() - new Date(s.lastUsed).getTime())} ago`
      : '';
    const flag = quarantine ? ' ⚠ flaky' : '';
    const message = `loaded ${s.loaded}, ${rel.totalPassed}/${rel.totalTaskRuns} verified (${rate})${flag}${last}`;
    // Passing = not chronically failing. A clean/short history stays green.
    const passed = !quarantine;
    out.push({
      name: s.skillName,
      group: 'Skill outcomes',
      passed,
      message,
      ...(s.lastError && !passed
        ? { suggestion: `last failure: "${s.lastError.message}"` }
        : {}),
    });
  }
  return out;
}

/**
 * v4.1.3-essentials doctor-polish: convert the live agent's three
 * session-scoped counter surfaces (skill enforcement, URL provenance,
 * empty response) into `CheckResult` rows so they render inside the
 * grouped health box as a "Session counters" section.
 *
 * Previously these three counters emitted as orphan `display.write`
 * lines AFTER the box closed — visually disconnected from the rest
 * of /doctor's output. Now they're inline as their own group.
 *
 * Outcome rule (per Q-B default): passing when ALL counters in a
 * row are zero (clean session); warning when ANY counter is non-zero
 * (worth a look). Note: a healthy session with `recovered>0`
 * registers as warning under this rule — acceptable noise in
 * exchange for a simple predictable classifier.
 *
 * `agent` is the live AidenAgent (or a stub with the three
 * `getXMetrics()` methods). When undefined (CLI doctor from a fresh
 * process), the helper returns `[]` and the group is dropped by the
 * renderer — identical to subsystem-health / skill-outcomes handling.
 */
export interface SessionCountersSource {
  getSkillEnforcementMetrics(): {
    armed:     number;
    preArmed:  number;
    recovered: number;
    failed:    number;
  };
  getUrlProvenanceMetrics(): {
    blocked:   number;
    recovered: number;
    failed:    number;
  };
  getEmptyResponseMetrics(): {
    detected:  number;
    retried:   number;
    recovered: number;
  };
}

export function sessionCounterResults(
  agent: SessionCountersSource | undefined,
): CheckResult[] {
  if (!agent) return [];

  const s = agent.getSkillEnforcementMetrics();
  const u = agent.getUrlProvenanceMetrics();
  const e = agent.getEmptyResponseMetrics();

  // Same all-zero classifier per row — keeps the rule symmetric
  // across the three counter sources even though their internal
  // semantics differ.
  const allZero = (vals: readonly number[]): boolean =>
    vals.every((v) => v === 0);

  const rows: CheckResult[] = [];

  // ── skill enforcement ─────────────────────────────────────────────
  {
    const passed = allZero([s.armed, s.preArmed, s.recovered, s.failed]);
    rows.push({
      name: 'skill enforcement',
      group: 'Session counters',
      passed: true,
      message:
        `armed=${s.armed}, pre-armed=${s.preArmed}, ` +
        `recovered=${s.recovered}, failed=${s.failed}`,
      // Suggestion attached only when non-zero so outcomeBucket()
      // routes the row to warning (yellow) rather than passing (green).
      // Text is concise — full counters already in `message`.
      ...(passed ? {} : { suggestion: 'guard fired this session — review if any failed > 0' }),
    });
  }

  // ── URL provenance ────────────────────────────────────────────────
  {
    const passed = allZero([u.blocked, u.recovered, u.failed]);
    rows.push({
      name: 'url provenance',
      group: 'Session counters',
      passed: true,
      message:
        `blocked=${u.blocked}, recovered=${u.recovered}, failed=${u.failed}`,
      ...(passed ? {} : { suggestion: 'open_url provenance gate fired this session' }),
    });
  }

  // ── empty response ────────────────────────────────────────────────
  {
    const passed = allZero([e.detected, e.retried, e.recovered]);
    rows.push({
      name: 'empty response',
      group: 'Session counters',
      passed: true,
      message:
        `detected=${e.detected}, retried=${e.retried}, recovered=${e.recovered}`,
      ...(passed ? {} : { suggestion: 'provider emitted empty turn(s) this session' }),
    });
  }

  return rows;
}

/**
 * Phase v4.1.2-slice4: render the Skill outcomes section.
 *
 * v4.1.3-essentials doctor-polish: kept for back-compat. The in-REPL
 * `/doctor` path now uses `skillOutcomeResults()` and renders inline
 * via the grouped box.
 *
 * Per Q3 decision: silent on empty state (no tracker, or no skills
 * tracked yet) — doctor output for healthy systems stays short.
 *
 * Output (when not empty): top N skills sorted by load count, with
 * total observations and success percentage. Last-error message
 * shown for the one most-recently failing skill (cap one row of
 * detail so the block stays compact).
 */
export function renderSkillOutcomesSection(
  tracker: import('../../core/v4/skillOutcomeTracker').SkillOutcomeTracker | undefined,
  topN = 5,
): string {
  if (!tracker) return '';
  const snaps = tracker.snapshot();
  if (snaps.length === 0) return '';

  const lines: string[] = ['\nSkill outcomes (top ' + Math.min(topN, snaps.length) + ' by load count)'];
  for (const s of snaps.slice(0, topN)) {
    const rel = s.reliability;
    const rate = rel.rollingPassRate === null
      ? '—'
      : `${Math.round(rel.rollingPassRate * 100)}% pass`;
    const flag = isQuarantineCandidate(rel) ? '  ⚠ flaky' : '';
    const stats = `loaded ${s.loaded}, ${rel.totalPassed}/${rel.totalTaskRuns} verified  (${rate})${flag}`;
    const last  = s.lastUsed
      ? `  last ${humanAge(Date.now() - new Date(s.lastUsed).getTime())} ago`
      : '';
    lines.push(`  ${s.skillName.padEnd(32)} ${stats}${last}`);
  }
  // Spotlight the most-recent failure across all tracked skills so a
  // single broken skill is visible without scanning every row.
  const recentFailures = snaps
    .filter((s) => s.lastError)
    .sort((a, b) =>
      new Date(b.lastError!.at).getTime() - new Date(a.lastError!.at).getTime(),
    );
  if (recentFailures.length > 0) {
    const f = recentFailures[0];
    lines.push(
      `  ↳ last failure: ${f.skillName} — "${f.lastError!.message}"`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** Wrap a promise with a timeout. The timed-out path resolves to the fallback result. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve a Windows binary name (`npx`, `python`, `docker`, ...) to its
 * absolute on-disk path, honouring PATHEXT (`.cmd`, `.exe`, `.bat`,
 * `.ps1`, ...). Result cached per session so repeated /doctor runs
 * don't re-scan PATH for every probe.
 *
 * Phase 22 Task 9 (DEP0190 fix) — replaces the prior
 * `spawn(name, args, { shell: true })` pattern that Node 22 deprecates.
 * After resolution we spawn the absolute path with `shell: false` so
 * the deprecation warning disappears AND we keep Phase 20.2's
 * .cmd-shim coverage.
 *
 * Returns the original name unchanged on POSIX (bare-name lookup via
 * `execvp` already handles shebangs) and on Windows when `where` fails
 * (the eventual `spawn` will produce its own ENOENT and the check
 * surfaces a clear "binary not found" result rather than crashing).
 */
const _binaryResolutionCache = new Map<string, string>();
export function resolveBinaryPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  whereImpl: (n: string) => string | null = defaultWhere,
): string {
  if (platform !== 'win32') return name;
  if (path.isAbsolute(name)) return name;
  const cached = _binaryResolutionCache.get(name);
  if (cached) return cached;
  const resolved = whereImpl(name);
  if (resolved) {
    _binaryResolutionCache.set(name, resolved);
    return resolved;
  }
  return name;
}

/**
 * Windows `where` can list multiple candidates per binary — for npm
 * shims it commonly returns the extensionless POSIX shebang variant
 * first (e.g. `D:\Program Files\nodejs\npx`) followed by `npx.cmd`.
 * Node's `spawn` with `shell: false` cannot execute the
 * extensionless one on Windows; pick the first PATHEXT-executable
 * match instead.
 */
const WINDOWS_EXEC_EXTS = ['.cmd', '.exe', '.bat', '.ps1', '.com'];

function defaultWhere(name: string): string | null {
  try {
    const lines = execFileSync('where', [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const exec = lines.find((l) => {
      const ext = path.extname(l).toLowerCase();
      return WINDOWS_EXEC_EXTS.includes(ext);
    });
    return exec ?? lines[0];
  } catch {
    return null;
  }
}

/** Test-only — drop the cached resolutions between specs. */
export function _resetBinaryResolutionCacheForTests(): void {
  _binaryResolutionCache.clear();
}

/**
 * Build a (cmd, args) tuple to spawn with `shell: false` for the
 * given binary name on the current platform.
 *
 * The Node 18.20+ CVE-2024-27980 fix refuses to spawn `.bat`/`.cmd`
 * files directly with `shell: false` (they would otherwise execute
 * via cmd.exe, which is a shell-injection vector). We side-step by
 * invoking `cmd.exe /c <resolved> <args...>` ourselves — cmd.exe is
 * a .exe and runs cleanly with `shell: false`. Since /doctor's args
 * are hardcoded `--version` strings, cmd.exe's arg interpretation is
 * not a concern.
 *
 * For .exe targets we spawn directly. POSIX is unchanged.
 */
export function buildProbeInvocation(
  bin: string,
  args: string[],
): { cmd: string; args: string[] } {
  const resolved = resolveBinaryPath(bin);
  if (process.platform === 'win32') {
    const ext = path.extname(resolved).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      return { cmd: 'cmd.exe', args: ['/c', resolved, ...args] };
    }
  }
  return { cmd: resolved, args };
}

/**
 * Run a binary with --version and resolve true on exit code 0.
 *
 * Phase 22 Task 9 — `shell: false` everywhere. `buildProbeInvocation`
 * routes `.cmd`/`.bat` through `cmd.exe /c` so Node 18.20+'s
 * CVE-2024-27980 lockout doesn't reject them, while still avoiding
 * the DEP0190 warning that `shell: true` triggers. Args are
 * hardcoded `--version` at every call site; no user input.
 */
function probeBinary(
  bin: string,
  args: string[],
  spawnImpl: typeof spawn,
): Promise<{ ok: boolean; stdout: string }> {
  const inv = buildProbeInvocation(bin, args);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(inv.cmd, inv.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch {
      resolve({ ok: false, stdout: '' });
      return;
    }
    let buf = '';
    child.stdout?.on('data', (d: Buffer | string) => {
      buf += d.toString();
    });
    child.on('error', () => resolve({ ok: false, stdout: '' }));
    child.on('exit', (code) => resolve({ ok: code === 0, stdout: buf.trim() }));
  });
}

// ─── Individual checks ────────────────────────────────────────────────

export async function checkConfigFile(paths: AidenPaths): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await fs.access(paths.configYaml);
    return {
      name: 'config file',
      group: 'Storage',
      passed: true,
      message: `found at ${paths.configYaml}`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      name: 'config file',
      group: 'Storage',
      passed: false,
      message: `missing at ${paths.configYaml}`,
      suggestion: 'run `aiden setup` to create one',
      durationMs: Date.now() - t0,
    };
  }
}

export function checkProviderAuth(env: NodeJS.ProcessEnv): CheckResult {
  const t0 = Date.now();
  const known = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GROQ_API_KEY',
    'TOGETHER_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY',
    'MISTRAL_API_KEY',
  ];
  const present = known.filter((k) => env[k] && env[k]!.length > 0);
  if (present.length === 0) {
    return {
      name: 'provider auth',
      group: 'Providers',
      passed: false,
      message: 'no provider API key found in environment',
      suggestion: 'run `aiden setup` and pick a provider, or set ANTHROPIC_API_KEY',
      durationMs: Date.now() - t0,
    };
  }
  return {
    name: 'provider auth',
    group: 'Providers',
    passed: true,
    message: `${present.length} provider key(s) present (${present.join(', ')})`,
    durationMs: Date.now() - t0,
  };
}

export async function checkOllamaReachable(opts: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<CheckResult> {
  const t0 = Date.now();
  const fallback: CheckResult = {
    name: 'ollama reachable',
    group: 'Inference',
    passed: false,
    message: 'no response from http://localhost:11434',
    suggestion: 'install Ollama from https://ollama.com or skip if you only use cloud providers',
    durationMs: Date.now() - t0,
  };
  return withTimeout(
    (async () => {
      try {
        const res = await opts.fetchImpl('http://localhost:11434/api/tags');
        if (!res.ok) {
          return {
            ...fallback,
            message: `Ollama responded ${res.status}`,
            durationMs: Date.now() - t0,
          };
        }
        return {
          name: 'ollama reachable',
          group: 'Inference',
          passed: true,
          message: 'Ollama responding on :11434',
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        return {
          ...fallback,
          message: `Ollama probe failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - t0,
        };
      }
    })(),
    opts.timeoutMs,
    { ...fallback, message: 'Ollama probe timed out', durationMs: Date.now() - t0 },
  );
}

export async function checkPythonAvailable(opts: {
  spawnImpl: typeof spawn;
  timeoutMs: number;
}): Promise<CheckResult> {
  const t0 = Date.now();
  const fallback: CheckResult = {
    name: 'python available',
    group: 'System tools',
    passed: false,
    message: 'python not found on PATH',
    suggestion: 'install python 3.10+ — required for graphify and a few skills',
    durationMs: Date.now() - t0,
  };
  return withTimeout(
    (async () => {
      const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
      for (const bin of candidates) {
        const res = await probeBinary(bin, ['--version'], opts.spawnImpl);
        if (res.ok) {
          return {
            name: 'python available',
            group: 'System tools' as DoctorGroup,
            passed: true,
            message: res.stdout || `${bin} present`,
            durationMs: Date.now() - t0,
          };
        }
      }
      return { ...fallback, durationMs: Date.now() - t0 };
    })(),
    opts.timeoutMs,
    { ...fallback, message: 'python probe timed out', durationMs: Date.now() - t0 },
  );
}

export async function checkDockerAvailable(opts: {
  spawnImpl: typeof spawn;
  timeoutMs: number;
}): Promise<CheckResult> {
  const t0 = Date.now();
  return withTimeout(
    (async () => {
      const res = await probeBinary('docker', ['--version'], opts.spawnImpl);
      if (res.ok) {
        return {
          name: 'docker available',
          group: 'System tools' as DoctorGroup,
          passed: true,
          message: res.stdout || 'docker present',
          durationMs: Date.now() - t0,
        };
      }
      return {
        name: 'docker available',
        group: 'System tools' as DoctorGroup,
        passed: false,
        message: 'docker not found on PATH',
        suggestion: 'optional — install Docker Desktop if you want sandboxed tool execution',
        durationMs: Date.now() - t0,
      };
    })(),
    opts.timeoutMs,
    {
      name: 'docker available',
      group: 'System tools' as DoctorGroup,
      passed: false as const,
      message: 'docker probe timed out',
      durationMs: Date.now() - t0,
    } as CheckResult,
  );
}

export async function checkNpxAvailable(opts: {
  spawnImpl: typeof spawn;
  timeoutMs: number;
}): Promise<CheckResult> {
  const t0 = Date.now();
  return withTimeout(
    (async () => {
      const res = await probeBinary('npx', ['--version'], opts.spawnImpl);
      if (res.ok) {
        return {
          name: 'npx available',
          group: 'System tools' as DoctorGroup,
          passed: true,
          message: `npx ${res.stdout}`,
          durationMs: Date.now() - t0,
        };
      }
      return {
        name: 'npx available',
        group: 'System tools' as DoctorGroup,
        passed: false,
        message: 'npx not found on PATH',
        suggestion: 'install Node.js 20+ — required for npm-published MCP servers',
        durationMs: Date.now() - t0,
      };
    })(),
    opts.timeoutMs,
    {
      name: 'npx available',
      group: 'System tools' as DoctorGroup,
      passed: false as const,
      message: 'npx probe timed out',
      durationMs: Date.now() - t0,
    } as CheckResult,
  );
}

export async function checkSkillsDir(paths: AidenPaths): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const stat = await fs.stat(paths.skillsDir);
    if (!stat.isDirectory()) {
      return {
        name: 'skills dir',
        group: 'Storage',
        passed: false,
        message: `${paths.skillsDir} is not a directory`,
        durationMs: Date.now() - t0,
      };
    }
    const entries = await fs.readdir(paths.skillsDir);
    return {
      name: 'skills dir',
      group: 'Storage',
      passed: true,
      message: `${paths.skillsDir} (${entries.length} entries)`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      name: 'skills dir',
      group: 'Storage',
      passed: false,
      message: `missing ${paths.skillsDir}`,
      suggestion: 'run `aiden setup` — it creates the skills directory',
      durationMs: Date.now() - t0,
    };
  }
}

export async function checkBundledManifest(paths: AidenPaths): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await fs.access(paths.bundledManifest);
    return {
      name: 'bundled manifest',
      group: 'Storage',
      passed: true,
      message: `present at ${paths.bundledManifest}`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      name: 'bundled manifest',
      group: 'Storage',
      passed: false,
      message: 'bundled skill manifest missing',
      suggestion: 'reinstall `aiden` — the package was not unpacked correctly',
      durationMs: Date.now() - t0,
    };
  }
}

export async function checkPlatformPaths(paths: AidenPaths): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await fs.access(paths.root);
    return {
      name: 'platform paths',
      group: 'Storage',
      passed: true,
      message: `aiden home: ${paths.root}`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      name: 'platform paths',
      group: 'Storage',
      passed: false,
      message: `aiden home missing: ${paths.root}`,
      suggestion: 'run `aiden setup` to initialise the home directory',
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * Phase v4.1-cross-platform: probe per-OS audio backends so a user
 * who installs Aiden fresh on Linux/macOS gets a clear "install sox"
 * pointer instead of a stack trace the first time they run /voice.
 *
 * Reports as INFO not FAILURE — the agent loop works fine without
 * voice support; we just want to surface the install hint.
 */
export async function checkAudioBackend(): Promise<CheckResult> {
  const t0 = Date.now();
  const playback = detectBackend('playback');
  const record   = detectBackend('record');
  const known = {
    playback: listKnownBackends('playback').map((b) => b.label),
    record:   listKnownBackends('record').map((b) => b.label),
  };
  if (playback && record) {
    return {
      name: 'audio backend',
      group: 'Voice',
      passed: true,
      message: `${process.platform}: playback=${playback.label} · record=${record.label}`,
      durationMs: Date.now() - t0,
    };
  }
  // Pass=true — informational. The suggestion carries the fix.
  const missing: string[] = [];
  if (!playback) missing.push(missingBackendMessage('playback'));
  if (!record)   missing.push(missingBackendMessage('record'));
  return {
    name: 'audio backend',
    group: 'Voice',
    passed: true,
    message: `${process.platform}: voice features will not work — backends missing (known: ${[...new Set([...known.playback, ...known.record])].join(', ') || 'none'})`,
    suggestion: missing.join(' || '),
    durationMs: Date.now() - t0,
  };
}

/**
 * Phase 20 Task 7: license-server reachability + local cache state.
 * `/doctor` shouldn't block when offline — we treat both "no local cache
 * (free tier)" and "server unreachable" as informational, not failures.
 * Hard failures are reserved for "cache exists but is corrupt" and
 * "license server returned a definite error response."
 */
export async function checkLicense(opts: {
  paths: AidenPaths;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const present = await hasLicense(opts.paths);
    if (!present) {
      return {
        name: 'license',
        group: 'Updates',
        passed: true,
        message: 'free tier (no license cache)',
        durationMs: Date.now() - t0,
      };
    }
    // Cache exists — try to verify (network or cached). Either result is OK
    // for /doctor's purposes; we only fail on parse/decrypt errors.
    const client = new LicenseClient({ paths: opts.paths });
    return await withTimeout(
      (async () => {
        const status = await client.statusFromCache();
        if (status.tier !== 'pro') {
          return {
            name: 'license',
            group: 'Updates' as DoctorGroup,
            passed: true,
            message: 'license cache present but not currently valid (free tier)',
            suggestion: 'run /license refresh to re-verify against server',
            durationMs: Date.now() - t0,
          };
        }
        const expiry = status.cache.expiresAt || 'lifetime';
        return {
          name: 'license',
          group: 'Updates' as DoctorGroup,
          passed: true,
          message: `Pro (${status.cache.plan}, expires ${expiry})`,
          durationMs: Date.now() - t0,
        };
      })(),
      opts.timeoutMs,
      {
        name: 'license',
        group: 'Updates' as DoctorGroup,
        passed: false as const,
        message: 'license check timed out reading cache',
        durationMs: Date.now() - t0,
      } as CheckResult,
    );
  } catch (err) {
    return {
      name: 'license',
      group: 'Updates',
      passed: false,
      message: `license check failed: ${err instanceof Error ? err.message : String(err)}`,
      suggestion: 'run /license refresh; if persistent, re-activate with /license activate <key>',
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * Phase 20 Task 7: npm update check status. Reports the cached
 * `updateAvailable` flag without forcing a registry round-trip when
 * the cache is fresh — same 6h discipline as the boot card.
 */
export async function checkUpdate(opts: {
  paths: AidenPaths;
  installedVersion: string;
  timeoutMs: number;
}): Promise<CheckResult> {
  const t0 = Date.now();
  return withTimeout(
    (async () => {
      try {
        const status = await checkForUpdate({
          paths: opts.paths,
          installedVersion: opts.installedVersion,
        });
        if (!status.updateAvailable) {
          const where = status.fromCache ? 'cached' : 'live';
          return {
            name: 'npm update',
            group: 'Updates' as DoctorGroup,
            passed: true,
            message: `installed v${status.installed} is up to date (${where})`,
            durationMs: Date.now() - t0,
          };
        }
        return {
          name: 'npm update',
          group: 'Updates' as DoctorGroup,
          passed: true,
          message: `v${status.latest} available (installed: v${status.installed})`,
          suggestion: 'run `npm install -g aiden-runtime@latest`',
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        return {
          name: 'npm update',
          group: 'Updates' as DoctorGroup,
          passed: false,
          message: `update check error: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - t0,
        };
      }
    })(),
    opts.timeoutMs,
    {
      name: 'npm update',
      group: 'Updates' as DoctorGroup,
      passed: true,
      message: 'update check timed out (network slow — non-fatal)',
      durationMs: Date.now() - t0,
    },
  );
}

export async function checkLogsWritable(paths: AidenPaths): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await fs.mkdir(paths.logsDir, { recursive: true });
    const probe = path.join(paths.logsDir, '.doctor-probe');
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.unlink(probe);
    return {
      name: 'logs writable',
      group: 'Storage',
      passed: true,
      message: paths.logsDir,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      name: 'logs writable',
      group: 'Storage',
      passed: false,
      message: `cannot write to ${paths.logsDir}: ${err instanceof Error ? err.message : String(err)}`,
      suggestion: `check permissions on ${os.homedir()}`,
      durationMs: Date.now() - t0,
    };
  }
}

// ─── Aggregator ───────────────────────────────────────────────────────

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const paths = opts.paths ?? resolveAidenPaths();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const start = Date.now();

  // Resolve the installed version. The relative path to package.json
  // differs between source (cli/v4/doctor.ts → ../../package.json) and
  // compiled dist (dist/cli/v4/doctor.js → ../../../package.json), so
  // walk a small candidate list. Falls back to 0.0.0 only if every
  // candidate is missing — which would imply a packaging bug worth
  // surfacing rather than masking.
  let installedVersion = '0.0.0';
  for (const rel of ['../../package.json', '../../../package.json']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(rel) as { version: string };
      if (pkg && typeof pkg.version === 'string' && pkg.version) {
        installedVersion = pkg.version;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  const results: CheckResult[] = [];
  results.push(await checkConfigFile(paths));
  results.push(checkProviderAuth(env));
  results.push(await checkOllamaReachable({ fetchImpl, timeoutMs }));
  results.push(await checkPythonAvailable({ spawnImpl, timeoutMs }));
  results.push(await checkDockerAvailable({ spawnImpl, timeoutMs }));
  results.push(await checkNpxAvailable({ spawnImpl, timeoutMs }));
  results.push(await checkSkillsDir(paths));
  results.push(await checkBundledManifest(paths));
  results.push(await checkPlatformPaths(paths));
  results.push(await checkLogsWritable(paths));
  results.push(await checkAudioBackend());
  // Phase 20 Task 7: license + update health.
  results.push(await checkLicense({ paths, fetchImpl, timeoutMs }));
  results.push(await checkUpdate({ paths, installedVersion, timeoutMs }));

  return {
    results,
    passed: results.every((r) => r.passed),
    totalMs: Date.now() - start,
  };
}

// ─── Phase 22 Task 5A — boxed /doctor renderer ────────────────────────

/**
 * Box width policy:
 * - Auto-fit to the widest content row (icon + padded name + message,
 *   plus any hint continuation), so Windows paths like
 *   `C:\Users\<you>\AppData\Local\aiden\.bundled_manifest` don't get
 *   truncated mid-word as they did at the previous fixed 70.
 * - Floor at HEALTH_BOX_MIN_WIDTH so empty-content cases still feel
 *   intentional rather than narrow.
 * - Cap at HEALTH_BOX_MAX_WIDTH so the box doesn't blow out to
 *   beyond the typical terminal — content past that point is wrapped
 *   onto a continuation row instead of forcing horizontal overflow.
 */
const HEALTH_BOX_MIN_WIDTH = 60;
const HEALTH_BOX_MAX_WIDTH = 100;
const HEALTH_BOX_TITLE = 'Health Check';

/**
 * Format a single check row inside the box: `<icon>  <name padded>
 * <message>`. Truncated to fit the box's inner width (HEALTH_BOX_WIDTH
 * minus 2 for the `│ ` gutter on each side).
 *
 * Status icon picks per check outcome:
 *   ✓ green — passed
 *   ⚠ yellow — passed but with a remediation suggestion (soft warning)
 *   ✗ red — failed
 */
function checkIconKind(r: CheckResult): { icon: string; colour: 'success' | 'warn' | 'error' } {
  if (!r.passed) return { icon: '✗', colour: 'error' };
  if (r.suggestion) return { icon: '⚠', colour: 'warn' };
  return { icon: '✓', colour: 'success' };
}

/**
 * Classify outcomes into the three buckets the top summary surfaces:
 *   passing  — passed && no suggestion
 *   warning  — passed && suggestion present (soft warning — works but
 *              has a remediation hint, e.g. audio backend on Linux)
 *   failing  — !passed
 *
 * Order matters: failing dominates warning, warning dominates passing.
 * Same convention as the row-icon picker above.
 */
function outcomeBucket(r: CheckResult): 'passing' | 'warning' | 'failing' {
  if (!r.passed) return 'failing';
  if (r.suggestion) return 'warning';
  return 'passing';
}

function maxNameWidth(report: DoctorReport): number {
  return report.results.reduce((m, r) => Math.max(m, r.name.length), 0);
}

/**
 * v4.1.3-essentials doctor-polish: group results by their `group`
 * field, preserving the configured display order (DOCTOR_GROUP_ORDER)
 * and dropping empty groups. Within each group, results stay in their
 * original insertion order — keeps related checks visually adjacent
 * even when `runDoctor` reorders for parallelism in a future revision.
 */
function groupResults(
  results: readonly CheckResult[],
): Array<{ group: DoctorGroup; rows: CheckResult[] }> {
  const byGroup = new Map<DoctorGroup, CheckResult[]>();
  for (const r of results) {
    const list = byGroup.get(r.group) ?? [];
    list.push(r);
    byGroup.set(r.group, list);
  }
  const out: Array<{ group: DoctorGroup; rows: CheckResult[] }> = [];
  for (const g of DOCTOR_GROUP_ORDER) {
    const rows = byGroup.get(g);
    if (rows && rows.length > 0) out.push({ group: g, rows });
  }
  return out;
}

/**
 * Compute the inner-cell width for the health box: widest visible
 * content row across all check rows, section headers, hint
 * continuations, and the top summary, plus a 1-char trailing gutter.
 * Floored / capped per HEALTH_BOX_MIN/MAX_WIDTH. Title length also
 * factored so the `╭── Health Check ─...─╮` row doesn't underflow.
 */
function computeHealthBoxWidth(report: DoctorReport, nameWidth: number): number {
  const titleMin = 2 + 1 + HEALTH_BOX_TITLE.length + 1 + 2;
  let widest = titleMin;

  const measureRow = (row: string): void => {
    const v = visibleLength(row);
    if (v + 1 > widest) widest = v + 1; // +1 for trailing gutter
  };

  // Top summary line.
  const buckets = { passing: 0, warning: 0, failing: 0 };
  for (const r of report.results) buckets[outcomeBucket(r)] += 1;
  measureRow(
    ` Overall: ${buckets.passing} passing · ${buckets.warning} warning · ${buckets.failing} failing  (${report.results.length} checks, ${report.totalMs} ms)`,
  );

  // Section header rows + group's checks + any hint continuations.
  const groups = groupResults(report.results);
  for (const g of groups) {
    const passed = g.rows.filter((r) => r.passed).length;
    measureRow(`  ${g.group} (${passed}/${g.rows.length})`);
    for (const r of g.rows) {
      measureRow(`    ✓  ${r.name.padEnd(nameWidth)}  ${r.message}`);
      if (r.suggestion && !r.passed) {
        measureRow(`        hint: ${r.suggestion}`);
      }
    }
  }

  return Math.max(HEALTH_BOX_MIN_WIDTH, Math.min(HEALTH_BOX_MAX_WIDTH, widest));
}

/**
 * Render the report as an orange-bordered rounded box with grouped
 * sections + top summary.
 *
 * v4.1.3-essentials doctor-polish: previously rendered as a flat list
 * of 13 rows with the summary at the bottom — hard to scan, easy to
 * miss issues. Now:
 *   - Top: `Overall: X passing · Y warning · Z failing` with per-
 *     bucket colors (green / yellow / red).
 *   - Section headers per group (`Providers (1/1)`) in brand+bold.
 *   - Rows packed tight within group, blank line between groups.
 *   - Hints stay on a continuation line under failed rows only.
 *
 * Pure — returns the multi-line string; caller writes it. `display`
 * is needed for skin-aware colouring of the border, icons, headers,
 * and summary buckets.
 */
export function renderHealthBox(report: DoctorReport, display: Display): string {
  const nameWidth = maxNameWidth(report);
  const W = computeHealthBoxWidth(report, nameWidth);
  const top = display.brand(boxTopTitled(HEALTH_BOX_TITLE, W));
  const bot = display.brand(boxBottom(W));
  const side = (content: string): string => {
    // Brand-colour just the verticals so inner content keeps its own colours.
    const raw = boxLine(content, W);
    const left = raw.slice(0, 1);
    const inner = raw.slice(1, raw.length - 1);
    const right = raw.slice(raw.length - 1);
    return `${display.brand(left)}${inner}${display.brand(right)}`;
  };

  const lines: string[] = [top, side('')];

  // ── Top summary — three colored buckets ───────────────────────────
  const buckets = { passing: 0, warning: 0, failing: 0 };
  for (const r of report.results) buckets[outcomeBucket(r)] += 1;
  // Each bucket colored only when non-zero; zero counters stay muted
  // so the eye lands on the actual state.
  const paintBucket = (n: number, kind: 'success' | 'warn' | 'error', label: string): string => {
    const text = `${n} ${label}`;
    return n > 0 ? display.paint(text, kind) : display.muted(text);
  };
  const summary =
    ` Overall: ${paintBucket(buckets.passing, 'success', 'passing')} · ` +
    `${paintBucket(buckets.warning, 'warn', 'warning')} · ` +
    `${paintBucket(buckets.failing, 'error', 'failing')}  ` +
    `${display.muted(`(${report.results.length} checks, ${report.totalMs} ms)`)}`;
  lines.push(side(summary));
  lines.push(side(''));

  // ── Grouped section rendering ─────────────────────────────────────
  const groups = groupResults(report.results);
  for (let gi = 0; gi < groups.length; gi += 1) {
    const g = groups[gi];
    const passed = g.rows.filter((r) => r.passed).length;
    // Group-level count tinted by aggregate state: all pass → success,
    // any fail → error, only warnings → warn.
    const anyFail = g.rows.some((r) => !r.passed);
    const anyWarn = g.rows.some((r) => r.passed && r.suggestion);
    const countColour: 'success' | 'warn' | 'error' =
      anyFail ? 'error' : anyWarn ? 'warn' : 'success';
    const header =
      `  ${display.brand(g.group)} ` +
      display.paint(`(${passed}/${g.rows.length})`, countColour);
    lines.push(side(header));
    for (const r of g.rows) {
      const { icon, colour } = checkIconKind(r);
      const colouredIcon = display.paint(icon, colour);
      const namePart = `    ${colouredIcon}  ${r.name.padEnd(nameWidth)}  ${r.message}`;
      lines.push(side(namePart));
      if (r.suggestion && !r.passed) {
        const hint = `        ${display.muted('hint:')} ${r.suggestion}`;
        lines.push(side(hint));
      }
    }
    // Blank line between groups (not after the last one).
    if (gi < groups.length - 1) lines.push(side(''));
  }

  lines.push(side(''));
  lines.push(bot);

  return lines.join('\n');
}

/**
 * CLI entry point. Prints results, sets `process.exitCode` to 0 / 1, and
 * returns the report. Callers can invoke this directly from an `aiden
 * doctor` command handler.
 */
export async function runDoctorCli(opts?: DoctorOptions): Promise<DoctorReport> {
  const report = await runDoctor(opts);

  // v4.1.3-essentials doctor-polish: Path-A unification — the CLI
  // path now uses the SAME `renderHealthBox` renderer as `/doctor`
  // (in-REPL). Previously this emitted a plain `[ok]` / `[fail]`
  // list with no box, no grouping, and the optional sections
  // (subsystem health, skill outcomes, liveness) dangled below the
  // summary. Now everything renders inside one cohesive box.
  //
  // NO_COLOR / forceMono handling: the Display instance honors both,
  // so `aiden doctor | tee report.txt` produces clean plain text
  // when piped (no ANSI in the captured file).
  //
  // Lazy-import Display + SkinEngine here because runDoctorCli is
  // also called from non-REPL contexts (tests) where instantiating
  // a Display might not be appropriate. CLI invocations get a fresh
  // skin engine; tests can mock or inspect the report directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Display: DisplayCtor } = require('./display') as {
    Display: typeof import('./display').Display;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SkinEngine: SkinEngineCtor } = require('./skinEngine') as {
    SkinEngine: typeof import('./skinEngine').SkinEngine;
  };
  const display = new DisplayCtor({ skin: new SkinEngineCtor() });

  // Pull in-process surfaces if the caller supplied them. CLI
  // invocations from a fresh process don't have a live agent so the
  // helpers return empty arrays → groups dropped by renderer.
  report.results.push(...subsystemHealthResults(opts?.subsystemHealthRegistry));
  report.results.push(...skillOutcomeResults(opts?.skillOutcomeTracker));

  // Provider-liveness path: runs an opt-in network probe per
  // configured provider when `--providers` is set. Results coerce
  // to CheckResult shape and fold into the same grouped box.
  let livenessFailed = false;
  if (opts?.liveness) {
    const { runProviderLiveness } = await import('./doctorLiveness');
    const paths = opts.paths ?? resolveAidenPaths();
    const { results: liveResults, summary } = await runProviderLiveness({
      paths,
      env:        opts.env,
      fetchImpl:  opts.fetchImpl,
      timeoutMs:  opts.livenessTimeoutMs,
    });
    // Coerce per-provider liveness results into CheckResult rows.
    // `liveResults` shape varies by provider but always has a
    // `passed`/`ok` flag and a message. Treat unknown shapes as
    // pass-through so future probe-result additions don't break.
    for (const lr of liveResults as unknown as Array<{
      name?: string; provider?: string; passed?: boolean; ok?: boolean;
      message?: string; status?: string; latencyMs?: number; error?: string;
    }>) {
      const passed = lr.passed === true || lr.ok === true;
      const latency = typeof lr.latencyMs === 'number' ? ` (${lr.latencyMs}ms)` : '';
      const msg = (lr.message ?? lr.status ?? (passed ? 'live' : (lr.error ?? 'failed'))) + latency;
      report.results.push({
        name: String(lr.name ?? lr.provider ?? 'provider'),
        group: 'Provider liveness',
        passed,
        message: msg,
        ...(passed ? {} : { suggestion: lr.error ?? 'check API key / network' }),
      });
    }
    livenessFailed = summary.red > 0;
  }

  process.stdout.write(renderHealthBox(report, display) + '\n');

  // Phase v4.1.1-oauth-fix Phase 5: discoverability hint for the deep
  // mode. Outside the box so it reads as meta-guidance, not a check.
  if (!opts?.liveness) {
    process.stdout.write(
      '\n  hint: Run `aiden doctor --providers` for live provider checks\n',
    );
  }

  // Liveness reds count toward the overall exit code so CI / scripts
  // can `aiden doctor --providers && deploy`.
  process.exitCode = (report.passed && !livenessFailed) ? 0 : 1;
  return report;
}
