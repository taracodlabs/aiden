/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-update — executeInstall unit coverage.
 *
 * Tests the shared install executor that both `/update install` and
 * `aiden_self_update` call. Drives a stubbed child_process.spawn so
 * we don't actually invoke npm on the test machine. Verifies:
 *   - happy path: success + version detection
 *   - permission denied: platform-specific remediation strings
 *   - non-zero exit: structured failure
 *   - timeout: SIGTERM + honest error
 *   - spawn-level error (npm not on PATH): structured failure
 *   - version parser
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  executeInstall,
  parseInstalledVersion,
  INSTALL_TIMEOUT_MS,
} from '../../../core/v4/update/executeInstall';

/**
 * Build a fake spawn that returns a controllable ChildProcess-shaped
 * EventEmitter. The test scripts stdout/stderr emissions and the
 * eventual exit code/error.
 */
function fakeSpawn(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  emitError?: Error;
  delayMs?: number;          // delay before emitting close (for timeout tests)
}) {
  return vi.fn((_cmd: string, _args: readonly string[], _opts: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (_sig?: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);

    // Emit on next tick so the listeners attached by executeInstall
    // are wired up.
    setImmediate(() => {
      if (opts.emitError) {
        child.emit('error', opts.emitError);
        return;
      }
      if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
      const close = () => child.emit('close', opts.exitCode ?? 0);
      if (opts.delayMs) setTimeout(close, opts.delayMs);
      else close();
    });

    return child;
  });
}

describe('executeInstall — happy path', () => {
  it('returns success with parsed installedVersion on clean npm output', async () => {
    const spawnImpl = fakeSpawn({
      stdout: 'added 1 package in 12s\n+ aiden-runtime@4.1.3\n',
      exitCode: 0,
    });
    // Cast to satisfy the typeof child_process.spawn parameter without
    // pulling in the full spawn type surface area.
    const result = await executeInstall({ spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'] });
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBe('4.1.3');
    expect(result.exitCode).toBe(0);
  });

  it('passes the canonical `install -g aiden-runtime@latest` args (POSIX path)', async () => {
    // v4.9.2 — pin to linux so we exercise the direct-spawn shape. The
    // Windows cmd.exe wrapping is covered by the separate test below.
    const spawnImpl = fakeSpawn({ stdout: '+ aiden-runtime@4.1.3', exitCode: 0 });
    await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
      platform: 'linux',
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'aiden-runtime@latest'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('honors a custom packageSpec override (test seam)', async () => {
    const spawnImpl = fakeSpawn({ stdout: '+ aiden-runtime@4.1.4', exitCode: 0 });
    await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
      packageSpec: 'aiden-runtime@beta',
      platform: 'linux',
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'aiden-runtime@beta'],
      expect.any(Object),
    );
  });

  // v4.9.2 — the helper wraps Windows npm.cmd via `cmd.exe /d /s /c` (escaped
  // args) so Node 20+ EINVAL on .cmd shims is avoided without shell:true. The
  // cmd.exe wrap only fires when a real `npm.cmd` shim is resolvable on PATH,
  // which exists only on a win32 HOST — even with platform:'win32', a posix
  // runner has no npm.cmd and correctly resolves to a bare `npm`. So the
  // cmd.exe assertion is win32-host-only; the posix branch is checked below on
  // every host.
  it.skipIf(process.platform !== 'win32')('routes via cmd.exe on win32, never with shell:true (win32 host only) (v4.9.2)', async () => {
    const winSpawn = fakeSpawn({ stdout: '+ aiden-runtime@4.1.3', exitCode: 0 });
    await executeInstall({
      spawnImpl: winSpawn as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
      platform: 'win32',
    });
    expect(winSpawn.mock.calls[0]?.[0]).toBe('cmd.exe');
    expect((winSpawn.mock.calls[0]?.[1] as string[])[0]).toBe('/d');
    expect(winSpawn.mock.calls[0]?.[2]?.shell).toBeFalsy();
    expect(winSpawn.mock.calls[0]?.[2]?.windowsVerbatimArguments).toBe(true);
  });

  it('routes direct npm on posix, never with shell:true (v4.9.2)', async () => {
    const linuxSpawn = fakeSpawn({ stdout: '+ aiden-runtime@4.1.3', exitCode: 0 });
    await executeInstall({
      spawnImpl: linuxSpawn as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
      platform: 'linux',
    });
    expect(linuxSpawn.mock.calls[0]?.[0]).toBe('npm');
    expect(linuxSpawn.mock.calls[0]?.[2]?.shell).toBeFalsy();
  });
});

describe('executeInstall — permission denied', () => {
  it('detects EACCES → returns platform-specific remediation (linux)', async () => {
    const spawnImpl = fakeSpawn({
      stderr: 'npm ERR! Error: EACCES: permission denied, mkdir "/usr/lib/node_modules/aiden-runtime"',
      exitCode: 1,
    });
    const result = await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
      platform: 'linux',
    });
    expect(result.success).toBe(false);
    // v4.9.1 — message wording refreshed (platformInstructions builder).
    expect(result.error).toContain('permission denied');
    expect(result.error).toContain('sudo npm install -g aiden-runtime@latest');
    expect(result.error).toMatch(/npm config set prefix "[^"]*\.npm-global"/);
  });

  it('detects EPERM / "access is denied" → Windows admin remediation', async () => {
    const spawnImpl = fakeSpawn({
      stderr: 'npm ERR! Error: EPERM: operation not permitted, access is denied',
      exitCode: 1,
    });
    const result = await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
      platform: 'win32',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('PowerShell as Administrator');
    expect(result.error).toContain('npm install -g aiden-runtime@latest');
  });

  it('detects darwin → macOS/Linux sudo branch', async () => {
    const spawnImpl = fakeSpawn({
      stderr: 'npm ERR! permission denied',
      exitCode: 243,
    });
    const result = await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
      platform: 'darwin',
    });
    // v4.9.1 — message wording refreshed; "darwin" now appears in headline,
    // sudo path still the first remediation.
    expect(result.error).toMatch(/sudo|darwin/);
    expect(result.error).toContain('sudo npm');
  });

  it('all permission-denied branches include the user-local prefix alternative', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      const spawnImpl = fakeSpawn({
        stderr: 'EACCES: permission denied',
        exitCode: 1,
      });
      const result = await executeInstall({
        spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
        platform,
      });
      // v4.9.1 — phrasing refreshed; Option 2 now reads "user-local prefix".
      expect(result.error).toMatch(/user-local prefix/);
      expect(result.error).toContain('npm config set prefix');
    }
  });
});

describe('executeInstall — failure modes', () => {
  it('non-zero exit (not permission) → structured failure with stderr snippet', async () => {
    const spawnImpl = fakeSpawn({
      stderr: 'npm ERR! 404 Not Found: aiden-runtime@latest',
      exitCode: 1,
    });
    const result = await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exit 1');
    expect(result.error).toContain('404 Not Found');
    expect(result.exitCode).toBe(1);
  });

  it('spawn-level error (npm not on PATH) → structured failure', async () => {
    const enoent = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
    const spawnImpl = fakeSpawn({ emitError: enoent });
    const result = await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('npm spawn failed');
    expect(result.error).toContain('Is npm installed and on PATH?');
  });

  it('timeout → kills child + returns honest timeout error', async () => {
    const spawnImpl = fakeSpawn({
      stdout: 'starting install...',
      delayMs: 200,
      exitCode: 0,
    });
    const result = await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
      timeoutMs: 50,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.error).toContain('50ms');
    expect(result.exitCode).toBe(-1);
  });

  it('synchronous spawn throw (e.g. invalid argv) → caught + returned as failure', async () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('spawn synchronously failed');
    });
    const result = await executeInstall({
      spawnImpl: spawnImpl as unknown as Parameters<typeof executeInstall>[0]['spawnImpl'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not launch npm');
    expect(result.error).toContain('spawn synchronously failed');
  });
});

describe('parseInstalledVersion', () => {
  it('parses standard "+ aiden-runtime@x.y.z" output', () => {
    expect(parseInstalledVersion('+ aiden-runtime@4.1.3')).toBe('4.1.3');
  });
  it('parses with surrounding text', () => {
    expect(parseInstalledVersion('added 1 package in 12s\n+ aiden-runtime@4.1.3\nok')).toBe('4.1.3');
  });
  it('parses pre-release versions', () => {
    expect(parseInstalledVersion('+ aiden-runtime@4.1.3-beta.2')).toBe('4.1.3-beta.2');
  });
  it('returns null when output has no aiden-runtime line', () => {
    expect(parseInstalledVersion('added 1 package: unrelated@1.0.0')).toBeNull();
    expect(parseInstalledVersion('')).toBeNull();
  });
});

describe('INSTALL_TIMEOUT_MS', () => {
  it('is exported as 90_000 (90s) — named const per slice for future tuning', () => {
    expect(INSTALL_TIMEOUT_MS).toBe(90_000);
  });
});
