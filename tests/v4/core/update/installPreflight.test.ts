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

  it('uses the running package target when npm prefix discovery fails after npm is found', async () => {
    const plan = await inspectUpdateInstall(windowsGlobal({
      runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'configuration error' })),
    }));
    expect(plan.installAllowed).toBe(true);
    expect(plan.reason).toBe('ready');
    expect(plan.prefix).toBe('C:\\Users\\Shiva Rao\\AppData\\Roaming\\npm');
    expect(plan.guidance.join('\n')).not.toContain('configuration error');
  });

  it('ignores an unrelated npm global root and keeps the running package target', async () => {
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
    expect(plan.installAllowed).toBe(true);
    expect(plan.reason).toBe('ready');
    expect(plan.prefix).toBe('C:\\Users\\Shiva Rao\\AppData\\Roaming\\npm');
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
    const prefix = 'C:\\Users\\Åšhiva\\å·¥å…·\\npm prefix with spaces';
    const root = `${prefix}\\node_modules`;
    const plan = await inspectUpdateInstall(windowsGlobal({
      home: 'C:\\Users\\Åšhiva',
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
  it('targets the running AppData package when npm configuration points at Program Files', async () => {
    const appDataPrefix = 'C:\\Users\\shiva\\AppData\\Roaming\\npm';
    const appDataRoot = `${appDataPrefix}\\node_modules`;
    const configuredPrefix = 'D:\\Program Files\\nodejs';
    const configuredRoot = `${configuredPrefix}\\node_modules`;
    const probed: string[] = [];
    const plan = await inspectUpdateInstall(windowsGlobal({
      home: 'C:\\Users\\shiva',
      detectionInput: {
        platform: 'win32',
        env: {},
        moduleDir: [appDataRoot, 'aiden-runtime', 'dist', 'core', 'v4', 'update'].join('\\'),
        argvScript: [appDataRoot, 'aiden-runtime', 'dist', 'cli', 'v4', 'aidenCLI.js'].join('\\'),
      },
      resolveNpm: () => ({ path: `${configuredPrefix}\\npm.cmd`, isShim: true }),
      runCommand: vi.fn(async (_command, args) => ({
        exitCode: 0,
        stdout: args[0] === 'prefix' ? `${configuredPrefix}\r\n` : `${configuredRoot}\r\n`,
        stderr: '',
      })),
      probeWritable: vi.fn(async (directory) => { probed.push(directory); return true; }),
    }));

    expect(plan.installAllowed).toBe(true);
    expect(plan.reason).toBe('ready');
    expect(plan.prefix).toBe(appDataPrefix);
    expect(plan.globalRoot).toBe(appDataRoot);
    expect(plan.packagePath).toBe(`${appDataRoot}\\aiden-runtime`);
    expect(plan.scope).toBe('user');
    expect(probed).toEqual([appDataPrefix, appDataRoot, `${appDataRoot}\\aiden-runtime`]);
    expect(plan.guidance.join('\n')).not.toMatch(/Administrator|config set prefix|Program Files/i);
  });

  it('can derive the target from the running package when npm root discovery fails', async () => {
    const appDataPrefix = 'C:\\Users\\shiva\\AppData\\Roaming\\npm';
    const appDataRoot = `${appDataPrefix}\\node_modules`;
    const plan = await inspectUpdateInstall(windowsGlobal({
      home: 'C:\\Users\\shiva',
      detectionInput: {
        platform: 'win32',
        env: {},
        moduleDir: [appDataRoot, 'aiden-runtime', 'dist'].join('\\'),
        argvScript: [appDataRoot, 'aiden-runtime', 'dist', 'cli', 'v4', 'aidenCLI.js'].join('\\'),
      },
      resolveNpm: () => ({ path: 'D:\\Program Files\\nodejs\\npm.cmd', isShim: true }),
      runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'bad prefix' })),
      probeWritable: vi.fn(async () => true),
    }));

    expect(plan.installAllowed).toBe(true);
    expect(plan.prefix).toBe(appDataPrefix);
    expect(plan.packagePath).toBe(`${appDataRoot}\\aiden-runtime`);
  });
});
