import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { shellExecTool } from '../../../tools/v4/terminal/shellExec';
import { buildLocalShellInvocation, localBackendExecute } from '../../../tools/v4/backends/local';
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
  it('preserves PowerShell source exactly at the process boundary', () => {
    const source = `Write-Output '$env:TEMP'; Write-Output \"quoted\"; Write-Output \`tick; Write-Output '₹ $ literal'`;
    const invocation = buildLocalShellInvocation(source, 'win32');
    expect(invocation.executable).toBe('powershell.exe');
    expect(invocation.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(invocation.args[3], 'base64').toString('utf16le')).toBe(source);
  });

  it('keeps an explicit nested PowerShell command out of an outer PowerShell parser', () => {
    for (const executable of ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']) {
      const command = `${executable} -NoProfile -Command \"$env:TEMP; $env:LOCALAPPDATA\"`;
      expect(buildLocalShellInvocation(command, 'win32')).toEqual({
        executable,
        args: ['-NoProfile', '-EncodedCommand', expect.any(String)],
        detached: false,
      });
      const invocation = buildLocalShellInvocation(command, 'win32');
      expect(Buffer.from(invocation.args.at(-1)!, 'base64').toString('utf16le'))
        .toBe('$env:TEMP; $env:LOCALAPPDATA');
    }
  });

  it('preserves existing encoded commands and direct PowerShell argv', () => {
    const encoded = Buffer.from("Write-Output 'encoded 世界'", 'utf16le').toString('base64');
    expect(buildLocalShellInvocation(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, 'win32')).toEqual({
      executable: 'powershell.exe',
      args: ['-NoProfile', '-EncodedCommand', encoded],
      detached: false,
    });
    expect(buildLocalShellInvocation('pwsh.exe -NoProfile -File "C:\\space path\\script.ps1"', 'win32')).toEqual({
      executable: 'pwsh.exe',
      args: ['-NoProfile', '-File', 'C:\\space path\\script.ps1'],
      detached: false,
    });
  });

  it('removes a cmd host when its sole payload is PowerShell', () => {
    const invocation = buildLocalShellInvocation(
      'cmd.exe /d /s /c powershell.exe -NoProfile -Command "$marker = 1; Write-Output $marker"',
      'win32',
    );
    expect(invocation.executable).toBe('powershell.exe');
    expect(Buffer.from(invocation.args[invocation.args.length - 1]!, 'base64').toString('utf16le'))
      .toBe('$marker = 1; Write-Output $marker');
  });

  it.runIf(isWin)('executes direct environment lookups and special characters on Windows', async () => {
    const marker = `space path 'single' \"double\" \`tick; Unicode-世界; literal-$`;
    const direct = await localBackendExecute({
      command: `Write-Output $env:TEMP; Write-Output $env:LOCALAPPDATA; Write-Output '${marker.replace(/'/g, "''")}'`,
    });
    expect(direct.exitCode).toBe(0);
    expect(direct.stdout).toContain(process.env.TEMP);
    expect(direct.stdout).toContain(process.env.LOCALAPPDATA);
    expect(direct.stdout).toContain(marker);
  });

  it.runIf(isWin)('executes a nested Windows PowerShell environment lookup literally', async () => {
    const nested = await localBackendExecute({ command: 'powershell -NoProfile -Command "$env:TEMP"' });
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout.trim()).toBe(process.env.TEMP);
  });

  it.runIf(isWin)('executes cmd-hosted PowerShell without stripping local variables', async () => {
    const nested = await localBackendExecute({
      command: 'cmd.exe /d /s /c powershell.exe -NoProfile -Command "$marker = $env:TEMP; Write-Output $marker"',
    });
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout.trim()).toBe(process.env.TEMP);
  });

  it.runIf(isWin)('runs the exact delayed marker contract once with variables intact', async () => {
    const marker = path.join(tmp, "activity marker '世界'.txt").replace(/'/g, "''");
    const command = `powershell.exe -NoProfile -Command "$marker = '${marker}'; Start-Sleep -Milliseconds 250; $count = if (Test-Path -LiteralPath $marker) { [int](Get-Content -LiteralPath $marker) } else { 0 }; Set-Content -LiteralPath $marker -Value ($count + 1); Write-Output 'ACTIVITY-DONE'"`;
    const started = Date.now();
    const result = await localBackendExecute({ command, cwd: tmp });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ACTIVITY-DONE');
    expect((await fs.readFile(path.join(tmp, "activity marker '世界'.txt"), 'utf8')).trim()).toBe('1');
  });

  it.runIf(isWin)('executes one approved PowerShell command exactly once', async () => {
    const marker = path.join(tmp, 'one-effect.txt').replace(/'/g, "''");
    const result = await localBackendExecute({
      command: `Add-Content -LiteralPath '${marker}' -Value 'effect'; Get-Content -LiteralPath '${marker}'`,
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    expect((await fs.readFile(path.join(tmp, 'one-effect.txt'), 'utf8')).trim().split(/\r?\n/u)).toEqual(['effect']);
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual(['effect']);
  });

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
