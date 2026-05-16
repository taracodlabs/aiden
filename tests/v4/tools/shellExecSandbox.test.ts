/**
 * v4.4 Phase 3 — shell_exec sandbox backend-selection integration tests.
 *
 * Covers the three-way selection logic in tools/v4/terminal/shellExec.ts:
 *   1. AIDEN_SANDBOX=0 (default) → local backend.
 *   2. AIDEN_SANDBOX=0 + ctx.terminalBackend='docker' → legacy
 *      single-shot dockerBackendExecute (skipped here when docker
 *      isn't available — tests cover the FALLBACK path).
 *   3. AIDEN_SANDBOX=1 + docker unavailable → falls through
 *      dockerSessionExec, which emits the warn-once + routes to
 *      local. backend reported as 'local'.
 *
 * Tests force docker UNAVAILABLE for determinism — the gate must
 * pass on machines without docker installed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { shellExecTool } from '../../../tools/v4/terminal/shellExec';
import { resolveAidenPaths } from '../../../core/v4/paths';
import {
  _setDockerAvailableForTests,
  _resetDockerSessionForTests,
} from '../../../core/v4/dockerSession';
import { _resetSandboxConfigForTests } from '../../../core/v4/sandboxConfig';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const isWin = process.platform === 'win32';
const echoCmd = (msg: string) =>
  isWin ? `Write-Output '${msg}'` : `echo '${msg}'`;

let tmp: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-sbxsh-tool-'));
  ctx = {
    cwd: tmp,
    paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
  };
  _resetDockerSessionForTests();
  _resetSandboxConfigForTests();
});

afterEach(async () => {
  if (process.env.AIDEN_SANDBOX !== undefined) delete process.env.AIDEN_SANDBOX;
  _resetSandboxConfigForTests();
  _resetDockerSessionForTests();
  try { await fs.rm(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

interface ShellResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  backend: 'local' | 'docker';
}

describe('shell_exec — sandbox opt-out via AIDEN_SANDBOX=0', () => {
  // v4.4 Phase 6 — sandbox is on by default. Force docker-unavailable
  // OR explicitly opt out to assert the local-backend path still works.
  it('uses local backend when AIDEN_SANDBOX=0', async () => {
    process.env.AIDEN_SANDBOX = '0';
    _resetSandboxConfigForTests();
    try {
      const r = (await shellExecTool.execute(
        { command: echoCmd('local-default') },
        ctx,
      )) as ShellResult;
      expect(r.backend).toBe('local');
      expect(r.stdout).toMatch(/local-default/);
    } finally {
      delete process.env.AIDEN_SANDBOX;
      _resetSandboxConfigForTests();
    }
  });

  it('respects ctx.terminalBackend="local" explicit override (sandbox=0)', async () => {
    process.env.AIDEN_SANDBOX = '0';
    _resetSandboxConfigForTests();
    try {
      const ctx2: ToolContext = { ...ctx, terminalBackend: 'local' };
      const r = (await shellExecTool.execute(
        { command: echoCmd('explicit-local') },
        ctx2,
      )) as ShellResult;
      expect(r.backend).toBe('local');
    } finally {
      delete process.env.AIDEN_SANDBOX;
      _resetSandboxConfigForTests();
    }
  });
});

describe('shell_exec — sandbox on, docker unavailable → fallback', () => {
  it('AIDEN_SANDBOX=1 + docker unavailable → local fallback', async () => {
    process.env.AIDEN_SANDBOX = '1';
    _resetSandboxConfigForTests();
    _setDockerAvailableForTests(false);
    const r = (await shellExecTool.execute(
      { command: echoCmd('sbx-fallback') },
      { ...ctx, sessionId: 'sbx-fallback-sess' },
    )) as ShellResult;
    expect(r.backend).toBe('local');
    expect(r.stdout).toMatch(/sbx-fallback/);
  });

  it('explicit terminalBackend="docker" + sandbox on + docker unavailable → fallback', async () => {
    process.env.AIDEN_SANDBOX = '1';
    _resetSandboxConfigForTests();
    _setDockerAvailableForTests(false);
    const ctx2: ToolContext = { ...ctx, terminalBackend: 'docker', sessionId: 's2' };
    const r = (await shellExecTool.execute(
      { command: echoCmd('explicit-docker-fallback') },
      ctx2,
    )) as ShellResult;
    // Sandbox path uses dockerSessionExec which falls back to local
    // when docker is unavailable.
    expect(r.backend).toBe('local');
    expect(r.stdout).toMatch(/explicit-docker-fallback/);
  });

  it('warn-once: log callback receives exactly one fallback warning across multiple calls', async () => {
    process.env.AIDEN_SANDBOX = '1';
    _resetSandboxConfigForTests();
    _setDockerAvailableForTests(false);
    const warnings: string[] = [];
    const ctx2: ToolContext = {
      ...ctx,
      sessionId: 'warn-once-sess',
      log: (level, msg) => {
        if (level === 'warn' && /Docker is not running or unreachable/i.test(msg)) {
          warnings.push(msg);
        }
      },
    };
    for (let i = 0; i < 3; i++) {
      await shellExecTool.execute({ command: echoCmd('warn-' + i) }, ctx2);
    }
    expect(warnings.length).toBe(1);
  });
});

describe('shell_exec — schema invariants under Phase 3', () => {
  it('shell_exec is still riskTier dangerous (sandbox does not demote)', () => {
    expect(shellExecTool.riskTier).toBe('dangerous');
  });

  it('shell_exec still mutates + execute category', () => {
    expect(shellExecTool.mutates).toBe(true);
    expect(shellExecTool.category).toBe('execute');
  });
});
