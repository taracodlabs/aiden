import { describe, expect, it, vi } from 'vitest';

import {
  inspectUpdateInstall,
  type InstallInspectionOptions,
} from '../../../../core/v4/update/installPreflight';

const TARGET = '4.16.0';

function windowsGlobal(overrides: Partial<InstallInspectionOptions> = {}): InstallInspectionOptions {
  const prefix = 'C:\\Users\\Shiva Rao\\AppData\\Roaming\\npm';
  const root = `${prefix}\\node_modules`;
  return {
    targetVersion: TARGET,
    platform: 'win32',
    home: 'C:\\Users\\Shiva Rao',
    detectionInput: {
      platform: 'win32',
      env: {},
      moduleDir: `${root}\\aiden-runtime\\dist\\core\\v4\\update`,
      argvScript: `${root}\\aiden-runtime\\dist\\cli\\v4\\aidenCLI.js`,
    },
    resolveNpm: () => ({ path: `${prefix}\\npm.cmd`, isShim: true }),
    runCommand: vi.fn(async (_command, args) => {
      if (args.join(' ') === 'prefix -g') return { exitCode: 0, stdout: `${prefix}\r\n`, stderr: '' };
      if (args.join(' ') === 'root -g') return { exitCode: 0, stdout: `${root}\r\n`, stderr: '' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }),
    probeWritable: vi.fn(async () => true),
    ...overrides,
  };
}

describe('inspectUpdateInstall', () => {
  it('accepts an exact writable user-local npm-global target', async () => {
    const plan = await inspectUpdateInstall(windowsGlobal());

    expect(plan.provenance).toBe('npm-global');
    expect(plan.scope).toBe('user');
    expect(plan.installAllowed).toBe(true);
    expect(plan.prefix).toBe('C:\\Users\\Shiva Rao\\AppData\\Roaming\\npm');
    expect(plan.packagePath).toBe(
      'C:\\Users\\Shiva Rao\\AppData\\Roaming\\npm\\node_modules\\aiden-runtime',
    );
    expect(plan.npmExecutable).toMatch(/npm\.cmd$/i);
    expect(plan.reason).toBe('ready');
  });

  it('allows a non-admin process when its actual prefix is writable', async () => {
    const plan = await inspectUpdateInstall(windowsGlobal({ elevated: false }));
    expect(plan.installAllowed).toBe(true);
    expect(plan.elevated).toBe(false);
  });

  it('rejects an administrator process when the actual target is not writable', async () => {
    const prefix = 'C:\\Program Files\\nodejs';
    const root = `${prefix}\\node_modules`;
    const plan = await inspectUpdateInstall(windowsGlobal({
      elevated: true,
      home: 'C:\\Users\\Shiva Rao',
      detectionInput: {
        platform: 'win32',
        env: {},
        moduleDir: `${root}\\aiden-runtime\\dist`,
        argvScript: `${root}\\aiden-runtime\\dist\\cli\\v4\\aidenCLI.js`,
      },
      runCommand: vi.fn(async (_command, args) => ({
        exitCode: 0,
        stdout: args[0] === 'prefix' ? `${prefix}\r\n` : `${root}\r\n`,
        stderr: '',
      })),
      probeWritable: vi.fn(async () => false),
    }));

    expect(plan.installAllowed).toBe(false);
    expect(plan.reason).toBe('prefix-not-writable');
    expect(plan.prefix).toBe(prefix);
    expect(plan.guidance.join('\n')).toContain(prefix);
    expect(plan.guidance.join('\n')).not.toMatch(/Administrator|config set prefix|SetEnvironmentVariable/i);
  });

  it('fails closed when npm is unavailable', async () => {
    const plan = await inspectUpdateInstall(windowsGlobal({ resolveNpm: () => null }));
    expect(plan.installAllowed).toBe(false);
    expect(plan.reason).toBe('npm-unavailable');
  });

  it('fails closed when npm prefix discovery fails', async () => {
    const plan = await inspectUpdateInstall(windowsGlobal({
      runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'configuration error' })),
    }));
    expect(plan.installAllowed).toBe(false);
    expect(plan.reason).toBe('prefix-resolution-failed');
    expect(plan.guidance.join('\n')).not.toContain('configuration error');
  });

  it('rejects an npm executable whose global root does not own the running package', async () => {
    const otherPrefix = 'D:\\other-prefix';
    const plan = await inspectUpdateInstall(windowsGlobal({
      runCommand: vi.fn(async (_command, args) => ({
        exitCode: 0,
        stdout: args[0] === 'prefix'
          ? `${otherPrefix}\r\n`
          : `${otherPrefix}\\node_modules\r\n`,
        stderr: '',
      })),
    }));
    expect(plan.installAllowed).toBe(false);
    expect(plan.reason).toBe('npm-environment-mismatch');
  });

  it.each([
    {
      name: 'package runner',
      expected: 'package-runner',
      input: {
        moduleDir: 'C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\aiden-runtime\\dist',
        argvScript: 'C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin\\aiden',
        env: {},
        platform: 'win32' as const,
      },
    },
    {
      name: 'repository checkout',
      expected: 'source',
      input: {
        moduleDir: 'C:\\src\\aiden\\core\\v4\\update',
        argvScript: 'C:\\src\\aiden\\cli\\v4\\aidenCLI.ts',
        env: {},
        platform: 'win32' as const,
      },
    },
    {
      name: 'standalone package',
      expected: 'standalone',
      input: {
        moduleDir: 'C:\\Apps\\Aiden',
        argvScript: 'C:\\Apps\\Aiden\\aiden.exe',
        env: { AIDEN_STANDALONE_BINARY: '1' },
        platform: 'win32' as const,
      },
    },
    {
      name: 'unknown installation',
      expected: 'unknown',
      input: {
        moduleDir: 'C:\\mystery',
        argvScript: 'C:\\mystery\\entry.js',
        env: {},
        platform: 'win32' as const,
      },
    },
  ])('does not dispatch a global install for $name', async ({ expected, input }) => {
    const runCommand = vi.fn();
    const plan = await inspectUpdateInstall({
      targetVersion: TARGET,
      detectionInput: input,
      platform: 'win32',
      runCommand,
    });
    expect(plan.provenance).toBe(expected);
    expect(plan.installAllowed).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('preserves a long Unicode prefix without shell interpolation', async () => {
    const prefix = 'C:\\Users\\Śhiva\\工具\\npm prefix with spaces';
    const root = `${prefix}\\node_modules`;
    const plan = await inspectUpdateInstall(windowsGlobal({
      home: 'C:\\Users\\Śhiva',
      detectionInput: {
        platform: 'win32',
        env: {},
        moduleDir: `${root}\\aiden-runtime\\dist`,
        argvScript: `${root}\\aiden-runtime\\dist\\cli\\v4\\aidenCLI.js`,
      },
      resolveNpm: () => ({ path: `${prefix}\\npm.cmd`, isShim: true }),
      runCommand: vi.fn(async (_command, args) => ({
        exitCode: 0,
        stdout: args[0] === 'prefix' ? `${prefix}\r\n` : `${root}\r\n`,
        stderr: '',
      })),
    }));
    expect(plan.installAllowed).toBe(true);
    expect(plan.prefix).toBe(prefix);
  });
});
