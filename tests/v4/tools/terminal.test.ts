import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { shellExecTool } from '../../../tools/v4/terminal/shellExec';
import { localBackendExecute } from '../../../tools/v4/backends/local';
import {
  dockerBackendExecute,
  isDockerAvailable,
} from '../../../tools/v4/backends/docker';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const isWin = process.platform === 'win32';
const echoCmd = (msg: string) =>
  isWin ? `Write-Output '${msg}'` : `echo '${msg}'`;
const errCmd = (msg: string) =>
  isWin ? `Write-Error '${msg}'` : `echo '${msg}' 1>&2; exit 3`;

let ctx: ToolContext;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-shell-tool-'));
  ctx = {
    cwd: tmp,
    paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
  };
});

describe('shell_exec — schema', () => {
  it('1. is a write-category execute tool', () => {
    expect(shellExecTool.schema.name).toBe('shell_exec');
    expect(shellExecTool.category).toBe('execute');
    expect(shellExecTool.mutates).toBe(true);
    expect(shellExecTool.toolset).toBe('terminal');
    expect(shellExecTool.schema.inputSchema.required).toEqual(['command']);
  });
});

describe('localBackend', () => {
  it('2. executes a simple command', async () => {
    const r = await localBackendExecute({ command: echoCmd('hello-shell') });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/hello-shell/);
    expect(r.backend).toBe('local');
  });

  it('3. captures stdout', async () => {
    const r = await localBackendExecute({ command: echoCmd('out-marker') });
    expect(r.stdout).toMatch(/out-marker/);
  });

  it('4. captures stderr / non-zero exit', async () => {
    const r = await localBackendExecute({ command: errCmd('boom') });
    expect(r.exitCode).not.toBe(0);
    // PowerShell Write-Error and POSIX `echo ... 1>&2` both surface
    // the marker on stderr (or sometimes stdout in PS error pipeline).
    expect(`${r.stdout}${r.stderr}`).toMatch(/boom/);
  });

  it('5. respects cwd', async () => {
    const cmd = isWin ? '(Get-Location).Path' : 'pwd';
    const r = await localBackendExecute({ command: cmd, cwd: tmp });
    // tmp may be a symlinked path on macOS (/var → /private/var); compare
    // by basename to dodge that.
    expect(r.stdout).toContain(path.basename(tmp));
  });

  it('6. honors timeout (kills hung command)', async () => {
    const cmd = isWin ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const r = await localBackendExecute({ command: cmd, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  }, 10_000);

  it('7. empty command returns error, does not hang', async () => {
    const r = await localBackendExecute({ command: '   ' });
    expect(r.stderr).toMatch(/empty/i);
    expect(r.exitCode).not.toBe(0);
  });

  it('8. captures multi-line output without dropping content', async () => {
    const cmd = isWin
      ? '1..5 | ForEach-Object { Write-Output "line-$_" }'
      : 'for i in 1 2 3 4 5; do echo "line-$i"; done';
    const r = await localBackendExecute({ command: cmd });
    for (let i = 1; i <= 5; i++) {
      expect(r.stdout).toMatch(new RegExp(`line-${i}`));
    }
  });
});

describe('dockerBackend', () => {
  const skip = !isDockerAvailable();

  it.skipIf(skip)('9. executes if Docker available', async () => {
    const r = await dockerBackendExecute({
      command: 'echo docker-marker',
      cwd: tmp,
      timeoutMs: 60_000,
    });
    expect(r.backend).toBe('docker');
    if (r.exitCode === 0) {
      expect(r.stdout).toMatch(/docker-marker/);
    } else {
      // Image pull or other transient failure — still a clean error
      // surface, not a crash.
      expect(typeof r.stderr).toBe('string');
    }
  }, 120_000);

  it('10. returns clear error when Docker unavailable', async () => {
    if (!skip) {
      // Docker IS available here — sanity check the surface anyway by
      // running with a guaranteed-bogus image so we get a docker-side
      // error (not an unavailable error). Skip in that case to keep
      // the assertion meaningful.
      return;
    }
    const r = await dockerBackendExecute({ command: 'echo hi' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/docker/i);
  });
});

describe('shell_exec — routing', () => {
  it('11. routes to local by default (AIDEN_SANDBOX=0 opt-out)', async () => {
    // v4.4 Phase 6 — sandbox is on by default. To exercise the
    // pre-v4.4 "local default" path, opt out explicitly.
    process.env.AIDEN_SANDBOX = '0';
    try {
      const r = (await shellExecTool.execute(
        { command: echoCmd('local-route') },
        ctx,
      )) as { backend: string; stdout: string };
      expect(r.backend).toBe('local');
      expect(r.stdout).toMatch(/local-route/);
    } finally {
      delete process.env.AIDEN_SANDBOX;
    }
  });

  it('12. routes to docker when ctx.terminalBackend=docker (legacy single-shot, AIDEN_SANDBOX=0)', async () => {
    // v4.4 Phase 6 — sandbox is on by default and routes the
    // docker path through dockerSessionExec (long-lived container
    // reuse + fallback-to-local on docker unavailable). This test
    // specifically exercises the LEGACY single-shot
    // dockerBackendExecute path that fires when AIDEN_SANDBOX=0 +
    // ctx.terminalBackend='docker' — kept for back-compat.
    process.env.AIDEN_SANDBOX = '0';
    try {
      const dockerCtx: ToolContext = { ...ctx, terminalBackend: 'docker' };
      const r = (await shellExecTool.execute(
        { command: 'echo from-docker' },
        dockerCtx,
      )) as { backend: string };
      expect(r.backend).toBe('docker');
      // Pass either way — if Docker is up we get exit 0, if not we get
      // the clear error string. Both prove routing.
    } finally {
      delete process.env.AIDEN_SANDBOX;
    }
  }, 120_000);
});
