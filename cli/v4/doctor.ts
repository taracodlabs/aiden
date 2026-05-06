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
 * Hermes reference: hermes_cli/doctor.py.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { resolveAidenPaths, type AidenPaths } from '../../core/v4/paths';
import { LicenseClient, hasLicense } from '../../core/v4/license';
import { checkForUpdate } from '../../core/v4/update/checkUpdate';

export interface CheckResult {
  name: string;
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
 * Run a binary with --version and resolve true on exit code 0.
 *
 * Phase 20.2 — `shell: true` on Windows so npm shims (`npx.cmd`,
 * `npm.cmd`, `tsc.cmd`, ...) get resolved via cmd.exe's pathext lookup.
 * Without it, Node's `spawn` only finds bare `.exe` files on Windows
 * and reports `npx not found` even when `npx --version` works fine in
 * the user's shell. POSIX is unchanged — bare-name resolution there
 * already covers shebangs.
 *
 * Args are hardcoded to `--version` everywhere this helper is called,
 * so cmd.exe arg-interpretation is not a concern (no user input flows
 * through the shell).
 */
function probeBinary(
  bin: string,
  args: string[],
  spawnImpl: typeof spawn,
): Promise<{ ok: boolean; stdout: string }> {
  const useShell = process.platform === 'win32';
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
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
      passed: true,
      message: `found at ${paths.configYaml}`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      name: 'config file',
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
      passed: false,
      message: 'no provider API key found in environment',
      suggestion: 'run `aiden setup` and pick a provider, or set ANTHROPIC_API_KEY',
      durationMs: Date.now() - t0,
    };
  }
  return {
    name: 'provider auth',
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
          passed: true,
          message: res.stdout || 'docker present',
          durationMs: Date.now() - t0,
        };
      }
      return {
        name: 'docker available',
        passed: false,
        message: 'docker not found on PATH',
        suggestion: 'optional — install Docker Desktop if you want sandboxed tool execution',
        durationMs: Date.now() - t0,
      };
    })(),
    opts.timeoutMs,
    {
      name: 'docker available',
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
          passed: true,
          message: `npx ${res.stdout}`,
          durationMs: Date.now() - t0,
        };
      }
      return {
        name: 'npx available',
        passed: false,
        message: 'npx not found on PATH',
        suggestion: 'install Node.js 20+ — required for npm-published MCP servers',
        durationMs: Date.now() - t0,
      };
    })(),
    opts.timeoutMs,
    {
      name: 'npx available',
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
        passed: false,
        message: `${paths.skillsDir} is not a directory`,
        durationMs: Date.now() - t0,
      };
    }
    const entries = await fs.readdir(paths.skillsDir);
    return {
      name: 'skills dir',
      passed: true,
      message: `${paths.skillsDir} (${entries.length} entries)`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      name: 'skills dir',
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
      passed: true,
      message: `present at ${paths.bundledManifest}`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      name: 'bundled manifest',
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
      passed: true,
      message: `aiden home: ${paths.root}`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      name: 'platform paths',
      passed: false,
      message: `aiden home missing: ${paths.root}`,
      suggestion: 'run `aiden setup` to initialise the home directory',
      durationMs: Date.now() - t0,
    };
  }
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
            passed: true,
            message: 'license cache present but not currently valid (free tier)',
            suggestion: 'run /license refresh to re-verify against server',
            durationMs: Date.now() - t0,
          };
        }
        const expiry = status.cache.expiresAt || 'lifetime';
        return {
          name: 'license',
          passed: true,
          message: `Pro (${status.cache.plan}, expires ${expiry})`,
          durationMs: Date.now() - t0,
        };
      })(),
      opts.timeoutMs,
      {
        name: 'license',
        passed: false as const,
        message: 'license check timed out reading cache',
        durationMs: Date.now() - t0,
      } as CheckResult,
    );
  } catch (err) {
    return {
      name: 'license',
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
            passed: true,
            message: `installed v${status.installed} is up to date (${where})`,
            durationMs: Date.now() - t0,
          };
        }
        return {
          name: 'npm update',
          passed: true,
          message: `v${status.latest} available (installed: v${status.installed})`,
          suggestion: 'run `npm install -g aiden-runtime@latest`',
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        return {
          name: 'npm update',
          passed: false,
          message: `update check error: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - t0,
        };
      }
    })(),
    opts.timeoutMs,
    {
      name: 'npm update',
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
      passed: true,
      message: paths.logsDir,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      name: 'logs writable',
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

  // Resolve the installed version once; pulled from package.json so a tag
  // mismatch surfaces here rather than via a confusing /doctor pass.
  let installedVersion = '0.0.0';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version: string };
    installedVersion = pkg.version;
  } catch {
    /* leave default */
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
  // Phase 20 Task 7: license + update health.
  results.push(await checkLicense({ paths, fetchImpl, timeoutMs }));
  results.push(await checkUpdate({ paths, installedVersion, timeoutMs }));

  return {
    results,
    passed: results.every((r) => r.passed),
    totalMs: Date.now() - start,
  };
}

/**
 * CLI entry point. Prints results, sets `process.exitCode` to 0 / 1, and
 * returns the report. Callers can invoke this directly from an `aiden
 * doctor` command handler.
 */
export async function runDoctorCli(opts?: DoctorOptions): Promise<DoctorReport> {
  const report = await runDoctor(opts);
  for (const r of report.results) {
    const marker = r.passed ? '[ok]  ' : '[fail]';
    process.stdout.write(`${marker} ${r.name}: ${r.message}\n`);
    if (!r.passed && r.suggestion) {
      process.stdout.write(`        hint: ${r.suggestion}\n`);
    }
  }
  process.stdout.write(
    `\n${report.passed ? 'all checks passed' : 'some checks failed'} in ${report.totalMs} ms\n`,
  );
  process.exitCode = report.passed ? 0 : 1;
  return report;
}
