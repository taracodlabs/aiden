import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  buildProbeInvocation,
  checkNpxAvailable,
  resolveBinaryPath,
  _resetBinaryResolutionCacheForTests,
} from '../../../cli/v4/doctor';

/**
 * Phase 22 Task 9 — DEP0190 fix.
 *
 * History:
 *   Phase 20.2 fixed npx detection on Windows by passing
 *   `shell: true` so cmd.exe could resolve `npx.cmd` via PATHEXT.
 *   That worked but tripped Node 22's DEP0190 deprecation
 *   ("passing args + shell:true is unsafe").
 *
 *   Phase 22 Task 9 keeps the .cmd resolution and removes the
 *   warning by:
 *     1. Resolving the binary to its absolute path via `where`
 *        (cached per session, Windows only).
 *     2. Spawning that absolute path with `shell: false`.
 *
 *   POSIX paths are unchanged — bare-name lookup via `execvp`
 *   handles shebangs.
 */
function spyingSpawn(
  exitCode: number,
  stdout = '8.19.2',
  capture: { call?: { bin: string; args: string[]; opts: any } } = {},
): typeof import('node:child_process').spawn {
  const fn = ((bin: string, args: string[], opts: any): unknown => {
    capture.call = { bin, args, opts };
    const ee = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
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

describe('Phase 22 Task 9 — DEP0190 fix', () => {
  beforeEach(() => {
    _resetBinaryResolutionCacheForTests();
  });

  it('1. checkNpxAvailable spawns with shell:false on every platform', async () => {
    const capture: { call?: { bin: string; args: string[]; opts: any } } = {};
    const spawnImpl = spyingSpawn(0, '8.19.2', capture);
    const r = await checkNpxAvailable({ spawnImpl, timeoutMs: 1000 });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('8.19.2');
    // The user-facing args (`--version`) are always the last entries in
    // the spawn args list. On Windows .cmd targets they're prefixed
    // with `/c <resolved.cmd>` for the cmd.exe wrap.
    expect(capture.call?.args.at(-1)).toBe('--version');
    // The DEP0190 fix flips shell to false everywhere.
    expect(capture.call?.opts.shell).toBe(false);
  });

  it('2. on Windows, .cmd targets are wrapped in cmd.exe /c (CVE-2024-27980)', async () => {
    const capture: { call?: { bin: string; args: string[]; opts: any } } = {};
    const spawnImpl = spyingSpawn(0, '8.19.2', capture);
    await checkNpxAvailable({ spawnImpl, timeoutMs: 1000 });
    const bin = capture.call?.bin ?? '';
    const args = capture.call?.args ?? [];
    if (process.platform === 'win32') {
      const ext = path.extname(bin).toLowerCase();
      const isCmdWrap =
        bin.toLowerCase() === 'cmd.exe' && args[0] === '/c' && /npx/i.test(args[1] ?? '');
      const isDirectExe =
        ext === '.exe' && /npx/i.test(bin);
      const isFallbackBareName = bin === 'npx';
      // One of three valid Windows shapes: cmd.exe-wrapped .cmd, direct
      // .exe, or bare-name fallback when `where` couldn't resolve.
      expect(isCmdWrap || isDirectExe || isFallbackBareName).toBe(true);
    } else {
      expect(bin).toBe('npx');
      expect(args).toEqual(['--version']);
    }
  });

  it('3. resolveBinaryPath is a no-op on POSIX', () => {
    expect(resolveBinaryPath('npx', 'linux')).toBe('npx');
    expect(resolveBinaryPath('python', 'darwin')).toBe('python');
  });

  it('4. resolveBinaryPath returns absolute paths unchanged on Windows', () => {
    const abs = process.platform === 'win32' ? 'C:\\Tools\\npx.cmd' : '/usr/bin/npx';
    expect(resolveBinaryPath(abs, 'win32')).toBe(abs);
  });

  it('5. resolveBinaryPath returns the original name when where finds nothing', () => {
    const result = resolveBinaryPath(
      'definitely-not-a-real-binary-xyz',
      'win32',
      () => null,
    );
    expect(result).toBe('definitely-not-a-real-binary-xyz');
  });

  it('6. resolveBinaryPath caches the resolution between calls', () => {
    let calls = 0;
    const stub = (n: string): string => {
      calls += 1;
      return `C:\\Resolved\\${n}.cmd`;
    };
    expect(resolveBinaryPath('foo', 'win32', stub)).toBe('C:\\Resolved\\foo.cmd');
    expect(resolveBinaryPath('foo', 'win32', stub)).toBe('C:\\Resolved\\foo.cmd');
    expect(calls).toBe(1); // second call hit cache
  });

  it('7. buildProbeInvocation returns the bare binary on POSIX', () => {
    if (process.platform === 'win32') return; // skip on Windows
    expect(buildProbeInvocation('npx', ['--version'])).toEqual({
      cmd: 'npx',
      args: ['--version'],
    });
  });
});
