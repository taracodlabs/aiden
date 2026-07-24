import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { executeInstall } from '../../../../core/v4/update/executeInstall';
import type { UpdateInstallPlan } from '../../../../core/v4/update/installPreflight';

const targetVersion = '4.16.0';

function readyPlan(): UpdateInstallPlan {
  return {
    provenance: 'npm-global',
    scope: 'user',
    targetVersion,
    installAllowed: true,
    reason: 'ready',
    npmExecutable: 'C:\\Users\\x\\AppData\\Roaming\\npm\\npm.cmd',
    prefix: 'C:\\Users\\x\\AppData\\Roaming\\npm',
    globalRoot: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules',
    packagePath: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\aiden-runtime',
    currentPackagePath: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\aiden-runtime',
    guidance: [],
  };
}

function fakeSpawn(input: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hold?: boolean;
}) {
  const children: Array<EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  }> = [];
  const spawnImpl = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      pid: number;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);
    child.pid = 4242;
    children.push(child);
    setImmediate(() => {
      if (input.stdout) child.stdout.emit('data', Buffer.from(input.stdout));
      if (input.stderr) child.stderr.emit('data', Buffer.from(input.stderr));
      if (!input.hold) child.emit('close', input.exitCode ?? 0);
    });
    return child;
  });
  return { spawnImpl, children };
}

describe('executeInstall safety', () => {
  it('schedules an external helper instead of replacing a running Windows package', async () => {
    const prepareWindowsHelper = vi.fn(async () => ({
      scheduled: true as const,
      helperPath: 'C:\\state\\update-helper.cjs',
      statePath: 'C:\\state\\update-helper-state.json',
      resultPath: 'C:\\state\\update-result.json',
    }));
    const result = await executeInstall({
      targetVersion,
      plan: readyPlan(),
      platform: 'win32',
      updateStateDir: 'C:\\state',
      prepareWindowsHelper,
    });
    expect(result.success).toBe(true);
    expect(result.scheduled).toBe(true);
    expect(prepareWindowsHelper).toHaveBeenCalledOnce();
  });

  it('uses the resolved npm executable and an argument array for the exact target', async () => {
    const fake = fakeSpawn({ stdout: 'added 1 package\n', exitCode: 0 });
    const result = await executeInstall({
      targetVersion,
      plan: readyPlan(),
      platform: 'linux',
      spawnImpl: fake.spawnImpl as never,
      readInstalledVersion: vi.fn(async () => targetVersion),
    });
    expect(result.success).toBe(true);
    expect(fake.spawnImpl).toHaveBeenCalledWith(
      readyPlan().npmExecutable,
      ['install', '-g', `aiden-runtime@${targetVersion}`, '--prefix', readyPlan().prefix],
      expect.objectContaining({ shell: false }),
    );
  });

  it('does not spawn when preflight is not installable', async () => {
    const fake = fakeSpawn({});
    const plan = { ...readyPlan(), installAllowed: false, reason: 'prefix-not-writable' as const };
    const result = await executeInstall({
      targetVersion,
      plan,
      spawnImpl: fake.spawnImpl as never,
    });
    expect(result.success).toBe(false);
    expect(result.kind).toBe('preflight');
    expect(fake.spawnImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['EACCES', 'npm ERR! code EACCES', 'permission'],
    ['EPERM', 'npm ERR! code EPERM', 'permission'],
    ['network', 'npm ERR! code ECONNRESET\nnetwork request failed', 'network'],
    ['registry', 'npm ERR! registry returned 503', 'registry'],
    ['registry auth', 'npm ERR! code E403\n403 Forbidden', 'registry'],
    ['native build', 'npm ERR! node-gyp rebuild failed', 'native-build'],
    ['version unavailable', 'npm ERR! code ETARGET\nNo matching version found', 'version-not-found'],
  ] as const)('classifies %s without leaking raw output', async (_name, stderr, expected) => {
    const fake = fakeSpawn({ stderr, exitCode: 1 });
    const result = await executeInstall({
      targetVersion,
      plan: readyPlan(),
      platform: 'linux',
      spawnImpl: fake.spawnImpl as never,
      readInstalledVersion: vi.fn(async () => null),
    });
    expect(result.success).toBe(false);
    expect(result.kind).toBe(expected);
    expect(result.error).not.toContain(stderr);
  });

  it('rejects npm exit zero when the exact target still has the old version', async () => {
    const fake = fakeSpawn({ stdout: 'changed 1 package\n', exitCode: 0 });
    const result = await executeInstall({
      targetVersion,
      plan: readyPlan(),
      platform: 'linux',
      spawnImpl: fake.spawnImpl as never,
      readInstalledVersion: vi.fn(async () => '4.15.1'),
    });
    expect(result.success).toBe(false);
    expect(result.kind).toBe('verification');
    expect(result.installedVersion).toBe('4.15.1');
  });

  it('times out and terminates the process tree', async () => {
    const fake = fakeSpawn({ hold: true });
    const killProcess = vi.fn();
    const result = await executeInstall({
      targetVersion,
      plan: readyPlan(),
      platform: 'win32',
      timeoutMs: 5,
      spawnImpl: fake.spawnImpl as never,
      killProcessTreeImpl: killProcess,
    });
    expect(result.kind).toBe('timeout');
    expect(killProcess).toHaveBeenCalledOnce();
  });

  it('cancels through AbortSignal and removes the listener', async () => {
    const fake = fakeSpawn({ hold: true });
    const killProcess = vi.fn();
    const controller = new AbortController();
    const pending = executeInstall({
      targetVersion,
      plan: readyPlan(),
      platform: 'win32',
      signal: controller.signal,
      timeoutMs: 5_000,
      spawnImpl: fake.spawnImpl as never,
      killProcessTreeImpl: killProcess,
    });
    controller.abort();
    const result = await pending;
    expect(result.kind).toBe('cancelled');
    expect(killProcess).toHaveBeenCalledOnce();
  });
  it('passes the exact resolved prefix to npm instead of relying on npm config', async () => {
    const fake = fakeSpawn({ stdout: 'changed 1 package\n', exitCode: 0 });
    const plan = {
      ...readyPlan(),
      npmExecutable: 'D:\\Program Files\\nodejs\\npm.cmd',
      prefix: 'C:\\Users\\shiva\\AppData\\Roaming\\npm',
      packagePath: 'C:\\Users\\shiva\\AppData\\Roaming\\npm\\node_modules\\aiden-runtime',
    };
    const result = await executeInstall({
      targetVersion,
      plan,
      platform: 'linux',
      spawnImpl: fake.spawnImpl as never,
      readInstalledVersion: vi.fn(async () => targetVersion),
    });
    expect(result.success).toBe(true);
    expect(fake.spawnImpl).toHaveBeenCalledWith(
      plan.npmExecutable,
      ['install', '-g', `aiden-runtime@${targetVersion}`, '--prefix', plan.prefix],
      expect.objectContaining({ shell: false }),
    );
  });

  it('classifies DNS and registry authorization failures without calling them permissions', async () => {
    const network = await executeInstall({
      targetVersion,
      plan: readyPlan(),
      platform: 'linux',
      spawnImpl: fakeSpawn({ stderr: 'npm ERR! DNS lookup failed', exitCode: 1 }).spawnImpl as never,
    });
    expect(network.kind).toBe('network');
    const auth = await executeInstall({
      targetVersion,
      plan: readyPlan(),
      platform: 'linux',
      spawnImpl: fakeSpawn({ stderr: 'npm ERR! code E401\n401 Unauthorized', exitCode: 1 }).spawnImpl as never,
    });
    expect(auth.kind).toBe('registry');
  });
});
