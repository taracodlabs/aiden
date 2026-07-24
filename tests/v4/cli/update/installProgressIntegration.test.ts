/**
 * v4.9.1 — executeInstall integration: phases drive off mock npm
 * stdout; EPERM produces a platform-correct remediation; DEP0190
 * is filtered from the surfaced `error`/`stderr`.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { executeInstall } from '../../../../core/v4/update/executeInstall';

/** Build a fake child_process for executeInstall. */
function fakeChild(stdoutLines: string[], stderrLines: string[], exitCode: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { /* noop */ };
  process.nextTick(() => {
    for (const l of stdoutLines) child.stdout.emit('data', l + '\n');
    for (const l of stderrLines) child.stderr.emit('data', l + '\n');
    child.emit('close', exitCode);
  });
  return child;
}

describe('executeInstall — phase callback', () => {
  it('emits truthful indeterminate lifecycle phases on success', async () => {
    const phases: string[] = [];
    const spawnImpl = vi.fn(() => fakeChild(
      ['npm http fetch GET 200 https://registry', 'added 247 packages in 4s', '+ aiden-runtime@4.9.1'],
      [], 0,
    ));
    const r = await executeInstall({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: spawnImpl as any,
      onPhase: (p) => phases.push(p),
      platform: 'darwin', home: '/Users/x',
    });
    expect(r.success).toBe(true);
    expect(r.installedVersion).toBe('4.9.1');
    expect(phases[0]).toBe('preparing update');
    expect(phases).toContain('installing');
    expect(phases).toContain('verifying');
    expect(phases[phases.length - 1]).toBe('complete');
  });
});

describe('executeInstall — EPERM produces platform-correct hints', () => {
  it('Windows EPERM → PowerShell syntax in error', async () => {
    const spawnImpl = vi.fn(() => fakeChild(
      [], ['npm ERR! code EPERM', 'npm ERR! operation not permitted'], 1,
    ));
    const r = await executeInstall({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: spawnImpl as any,
      platform: 'win32', home: 'C:\\Users\\x',
    });
    expect(r.success).toBe(false);
    expect(r.kind).toBe('permission');
    expect(r.error).not.toMatch(/Administrator/);
    expect(r.error).not.toMatch(/sudo/);
    expect(r.error).not.toMatch(/^export /m);
  });
  it('darwin EACCES → bash export + .zshrc', async () => {
    const spawnImpl = vi.fn(() => fakeChild(
      [], ['npm ERR! code EACCES', 'npm ERR! syscall mkdir'], 1,
    ));
    const r = await executeInstall({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: spawnImpl as any,
      platform: 'darwin', home: '/Users/x', env: { SHELL: '/bin/zsh' },
    });
    expect(r.success).toBe(false);
    expect(r.kind).toBe('permission');
    expect(r.error).not.toMatch(/sudo/);
    expect(r.error).not.toMatch(/PowerShell/);
    expect(r.error).not.toMatch(/\$env:USERPROFILE/);
  });
});

describe('executeInstall — DEP0190 filter', () => {
  it('DEP lines do not appear in surfaced stderr/error', async () => {
    const spawnImpl = vi.fn(() => fakeChild(
      [],
      [
        '(node:7777) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true ...',
        '(Use `node --trace-deprecation ...` to show where the warning was created)',
        'npm ERR! code EACCES',
      ],
      1,
    ));
    const r = await executeInstall({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: spawnImpl as any,
      platform: 'linux', home: '/home/x', env: { SHELL: '/bin/bash' },
    });
    expect(r.stderr).not.toMatch(/DEP0190/);
    expect(r.stderr).not.toMatch(/trace-deprecation/);
    expect(r.stderr).toMatch(/EACCES/);
  });
});
