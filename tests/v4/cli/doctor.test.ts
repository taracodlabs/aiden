import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  checkConfigFile,
  checkProviderAuth,
  checkOllamaReachable,
  checkPythonAvailable,
  checkDockerAvailable,
  checkNpxAvailable,
  checkSkillsDir,
  checkBundledManifest,
  checkPlatformPaths,
  checkLogsWritable,
  runDoctor,
} from '../../../cli/v4/doctor';
import type { AidenPaths } from '../../../core/v4/paths';
import { saveTokens } from '../../../core/v4/auth/tokenStore';
import { writeProviderDecision } from '../../../core/v4/providerDecision';

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'memories', 'MEMORY.md'),
    userMd: path.join(root, 'memories', 'USER.md'),
    skillsDir: path.join(root, 'skills'),
    sessionsDir: path.join(root, 'sessions'),
    pluginsDir: path.join(root, 'plugins'),
    logsDir: path.join(root, 'logs'),
    bundledManifest: path.join(root, '.bundled_manifest'),
    skillsBundleVersion: path.join(root, '.skills-bundle-version'),
  };
}

/** Fake child_process spawn that fires exit(0) or exit(1) immediately. */
function fakeSpawn(exitCode: number, stdout = ''): typeof import('node:child_process').spawn {
  const fn: typeof import('node:child_process').spawn = ((): unknown => {
    const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    setImmediate(() => {
      if (stdout) ee.stdout.emit('data', Buffer.from(stdout));
      ee.emit('exit', exitCode);
    });
    return ee;
  }) as never;
  return fn;
}

/** A spawn that hangs forever — used to force the per-check timeout path. */
function hangingSpawn(): typeof import('node:child_process').spawn {
  const fn: typeof import('node:child_process').spawn = ((): unknown => {
    const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    return ee; // never emits exit
  }) as never;
  return fn;
}

describe('Doctor — individual checks', () => {
  let tmp: string;
  let paths: AidenPaths;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-doctor-'));
    paths = makePaths(tmp);
  });

  it('checkConfigFile detects missing config', async () => {
    const r = await checkConfigFile(paths);
    expect(r.passed).toBe(false);
    expect(r.suggestion).toMatch(/aiden setup/);
  });

  it('checkConfigFile passes when file exists', async () => {
    await fs.writeFile(paths.configYaml, 'model: {}');
    const r = await checkConfigFile(paths);
    expect(r.passed).toBe(true);
  });

  it('checkProviderAuth detects missing API key', () => {
    const r = checkProviderAuth({});
    expect(r.passed).toBe(false);
    expect(r.suggestion).toBeTruthy();
  });

  it('checkProviderAuth passes when ANTHROPIC_API_KEY present', () => {
    const r = checkProviderAuth({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('ANTHROPIC_API_KEY');
  });

  it('checkOllamaReachable handles successful response', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch;
    const r = await checkOllamaReachable({ fetchImpl, timeoutMs: 1000 });
    expect(r.passed).toBe(true);
  });

  it('checkOllamaReachable handles network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await checkOllamaReachable({ fetchImpl, timeoutMs: 1000 });
    expect(r.passed).toBe(false);
    expect(r.suggestion).toMatch(/ollama\.com/);
  });

  it('checkPythonAvailable passes when binary exits 0', async () => {
    const r = await checkPythonAvailable({
      spawnImpl: fakeSpawn(0, 'Python 3.12.0'),
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(true);
  });

  it('checkPythonAvailable fails when no python on PATH', async () => {
    const r = await checkPythonAvailable({
      spawnImpl: fakeSpawn(1),
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(false);
  });

  it('checkDockerAvailable passes when binary works', async () => {
    const r = await checkDockerAvailable({
      spawnImpl: fakeSpawn(0, 'Docker version 24.0.0'),
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(true);
  });

  it('checkDockerAvailable times out gracefully on hang', async () => {
    const r = await checkDockerAvailable({
      spawnImpl: hangingSpawn(),
      timeoutMs: 50,
    });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/timed out/);
  });

  it('checkNpxAvailable detects npx', async () => {
    const r = await checkNpxAvailable({
      spawnImpl: fakeSpawn(0, '10.5.0'),
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(true);
  });

  it('checkSkillsDir detects missing dir', async () => {
    const r = await checkSkillsDir(paths);
    expect(r.passed).toBe(false);
  });

  it('checkSkillsDir passes when dir exists', async () => {
    await fs.mkdir(paths.skillsDir, { recursive: true });
    const r = await checkSkillsDir(paths);
    expect(r.passed).toBe(true);
  });

  it('checkBundledManifest detects missing manifest', async () => {
    const r = await checkBundledManifest(paths);
    expect(r.passed).toBe(false);
  });

  it('checkPlatformPaths detects missing root', async () => {
    const fake = makePaths(path.join(tmp, 'nope'));
    const r = await checkPlatformPaths(fake);
    expect(r.passed).toBe(false);
  });

  it('checkLogsWritable creates dir and writes probe', async () => {
    const r = await checkLogsWritable(paths);
    expect(r.passed).toBe(true);
    // dir was created
    const stat = await fs.stat(paths.logsDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('Doctor — runDoctor aggregator', () => {
  let tmp: string;
  let paths: AidenPaths;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-doctor-agg-'));
    paths = makePaths(tmp);
  });

  it('returns passed=true when every check passes', async () => {
    // Pre-create everything the filesystem checks expect.
    await fs.mkdir(paths.skillsDir, { recursive: true });
    await fs.mkdir(paths.logsDir, { recursive: true });
    await fs.writeFile(paths.configYaml, 'model: {}');
    await fs.writeFile(paths.bundledManifest, '{}');

    const fetchImpl = (async () =>
      ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch;
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test' };

    const report = await runDoctor({
      paths,
      env,
      fetchImpl,
      spawnImpl: fakeSpawn(0, '1.0.0'),
      timeoutMs: 500,
    });
    expect(report.passed).toBe(true);
    // every check should run quickly with mocks
    expect(report.totalMs).toBeLessThan(5_000);
  });

  it('returns passed=false when any check fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const report = await runDoctor({
      paths,
      env: {},
      fetchImpl,
      spawnImpl: fakeSpawn(1),
      timeoutMs: 200,
    });
    expect(report.passed).toBe(false);
    const failed = report.results.filter((r) => !r.passed);
    expect(failed.length).toBeGreaterThan(0);
    // every failed result with a suggestion has user-facing text
    for (const r of failed) {
      if (r.suggestion) expect(r.suggestion.length).toBeGreaterThan(0);
    }
  });

  it('uses canonical chat readiness instead of reporting a missing environment key', async () => {
    const checkedAt = Date.now();
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const report = await runDoctor({
      paths,
      env: {},
      fetchImpl,
      spawnImpl: fakeSpawn(0, '1.0.0'),
      timeoutMs: 200,
      readinessProjection: {
        overall: 'ready',
        checkedAt,
        issues: [],
        items: [{
          id: 'chat-provider', category: 'chat', state: 'ready', title: 'Chat provider',
          detail: 'ChatGPT Plus (OAuth) · gpt-5.5', configured: true, available: true,
          healthy: true, supported: true, authenticated: true, runtimeAvailable: true,
          permissionAvailable: true, validationAvailable: true, ready: true,
          reason: 'ChatGPT Plus (OAuth) · gpt-5.5', recommendedAction: null,
          blocking: true, severity: 'info', availableActions: [], checkedAt,
        }],
      },
    });

    expect(report.results.find((entry) => entry.name === 'provider auth')).toMatchObject({
      passed: true,
      message: 'ChatGPT Plus (OAuth) · gpt-5.5',
    });
    expect(report.results.find((entry) => entry.name === 'ollama reachable')).toMatchObject({
      passed: true,
      message: expect.stringContaining('optional'),
      suggestion: expect.stringContaining('local'),
    });
  });

  it('recognizes the durable active OAuth credential in standalone doctor mode', async () => {
    await saveTokens(paths, {
      provider: 'chatgpt-plus', accessToken: 'test-access-token',
      expiresAtMs: Date.now() + 3_600_000,
    });
    writeProviderDecision(paths, {
      provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'persisted-config',
      requestedExplicit: false, attempts: [{ providerId: 'chatgpt-plus', ok: true }],
    });
    const report = await runDoctor({
      paths,
      env: {},
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
      spawnImpl: fakeSpawn(0, '1.0.0'),
      timeoutMs: 200,
    });

    expect(report.results.find((entry) => entry.name === 'provider auth')).toMatchObject({
      passed: true,
      message: expect.stringMatching(/ChatGPT Plus.*OAuth.*gpt-5\.5/i),
    });
    expect(report.results.find((entry) => entry.name === 'ollama reachable')).toMatchObject({
      passed: true,
      suggestion: expect.stringContaining('local'),
    });
  });

  it('recognizes the configured active provider API key in standalone doctor mode', async () => {
    await fs.writeFile(paths.configYaml, [
      'model:',
      '  provider: custom_openai',
      '  modelId: custom-default',
      'providers:',
      '  custom_openai:',
      '    baseUrl: http://127.0.0.1:8000/v1',
    ].join('\n') + '\n', 'utf8');

    const report = await runDoctor({
      paths,
      env: { CUSTOM_OPENAI_API_KEY: 'configured-test-key' },
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
      spawnImpl: fakeSpawn(0, '1.0.0'),
      timeoutMs: 200,
    });

    expect(report.results.find((entry) => entry.name === 'provider auth')).toMatchObject({
      passed: true,
      message: expect.stringMatching(/Custom OpenAI-compatible.*custom-default/i),
    });
    expect(report.results.find((entry) => entry.name === 'ollama reachable')).toMatchObject({
      passed: true,
      suggestion: expect.stringContaining('local'),
    });
  });

  it('completes in <5 seconds even when probes hang', async () => {
    const fetchImpl = ((): Promise<Response> => new Promise(() => {})) as unknown as typeof fetch;
    const t0 = Date.now();
    const report = await runDoctor({
      paths,
      env: {},
      fetchImpl,
      spawnImpl: hangingSpawn(),
      timeoutMs: 100,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_000);
    expect(report.totalMs).toBeLessThan(5_000);
  });
});

// ── v4.1.3-essentials doctor-polish: sessionCounterResults ───────────────
//
// Adapter that folds the live agent's three session-scoped counter
// surfaces (skill enforcement / URL provenance / empty response) into
// CheckResult rows so they render inside the grouped health box as a
// "Session counters" group instead of as orphan `display.write` lines
// after the box closes.
//
// Outcome rule: all-zero per row → passing (no suggestion attached).
// Any non-zero → passed:true + suggestion → outcomeBucket() routes
// to 'warning' (yellow). Simple, predictable, accepts the minor noise
// of `recovered>0` flagging as warning.

import { sessionCounterResults } from '../../../cli/v4/doctor';

function makeAgent(opts: {
  skill?: { armed?: number; preArmed?: number; recovered?: number; failed?: number };
  url?:   { blocked?: number; recovered?: number; failed?: number };
  empty?: { detected?: number; retried?: number; recovered?: number };
}) {
  return {
    getSkillEnforcementMetrics: () => ({
      armed:     opts.skill?.armed ?? 0,
      preArmed:  opts.skill?.preArmed ?? 0,
      recovered: opts.skill?.recovered ?? 0,
      failed:    opts.skill?.failed ?? 0,
    }),
    getUrlProvenanceMetrics: () => ({
      blocked:   opts.url?.blocked ?? 0,
      recovered: opts.url?.recovered ?? 0,
      failed:    opts.url?.failed ?? 0,
    }),
    getEmptyResponseMetrics: () => ({
      detected:  opts.empty?.detected ?? 0,
      retried:   opts.empty?.retried ?? 0,
      recovered: opts.empty?.recovered ?? 0,
    }),
  };
}

describe('sessionCounterResults (v4.1.3-essentials doctor-polish)', () => {
  it('undefined agent → empty array (CLI doctor / no live agent)', () => {
    expect(sessionCounterResults(undefined)).toEqual([]);
  });

  it('all-zero session: 3 rows, all passing, no suggestion', () => {
    const rows = sessionCounterResults(makeAgent({}));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.group).toBe('Session counters');
      expect(r.passed).toBe(true);
      expect(r.suggestion).toBeUndefined();
    }
    // Sanity: row order is skill / url / empty.
    expect(rows.map((r) => r.name)).toEqual([
      'skill enforcement',
      'url provenance',
      'empty response',
    ]);
  });

  it('all-zero session: message format readable + matches the counter shape', () => {
    const rows = sessionCounterResults(makeAgent({}));
    expect(rows[0].message).toBe('armed=0, pre-armed=0, recovered=0, failed=0');
    expect(rows[1].message).toBe('blocked=0, recovered=0, failed=0');
    expect(rows[2].message).toBe('detected=0, retried=0, recovered=0');
  });

  it('skill enforcement non-zero: row gets a suggestion (→ warning bucket)', () => {
    const rows = sessionCounterResults(makeAgent({ skill: { armed: 2, recovered: 1 } }));
    const skillRow = rows.find((r) => r.name === 'skill enforcement');
    expect(skillRow?.passed).toBe(true);
    expect(skillRow?.suggestion).toBeTruthy();
    expect(skillRow?.message).toContain('armed=2');
    expect(skillRow?.message).toContain('recovered=1');
    // Other rows still all-zero → no suggestion.
    const urlRow = rows.find((r) => r.name === 'url provenance');
    expect(urlRow?.suggestion).toBeUndefined();
  });

  it('URL provenance non-zero: row gets a suggestion', () => {
    const rows = sessionCounterResults(makeAgent({ url: { blocked: 1 } }));
    const urlRow = rows.find((r) => r.name === 'url provenance');
    expect(urlRow?.suggestion).toBeTruthy();
    expect(urlRow?.message).toContain('blocked=1');
  });

  it('empty response non-zero: row gets a suggestion', () => {
    const rows = sessionCounterResults(makeAgent({ empty: { detected: 1, recovered: 1 } }));
    const emptyRow = rows.find((r) => r.name === 'empty response');
    // detected=1 recovered=1 — fully recovered, BUT the simple-rule
    // classifier still treats any non-zero as warning. Documented
    // tradeoff in the adapter's docstring.
    expect(emptyRow?.suggestion).toBeTruthy();
    expect(emptyRow?.message).toContain('detected=1');
  });

  it('mixed: only the non-zero rows warn; clean rows stay passing', () => {
    const rows = sessionCounterResults(
      makeAgent({
        skill: { failed: 1 },        // non-zero
        url: {},                     // all-zero
        empty: { detected: 2 },      // non-zero
      }),
    );
    const warnNames = rows.filter((r) => r.suggestion).map((r) => r.name);
    expect(warnNames).toEqual(['skill enforcement', 'empty response']);
    const passName = rows.find((r) => !r.suggestion)?.name;
    expect(passName).toBe('url provenance');
  });
});
