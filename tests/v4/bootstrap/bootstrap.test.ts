import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const bootstrap = require(path.join(root, 'bin', 'aiden-bootstrap.cjs')) as {
  SUPPORTED_NODE_MAJORS: readonly number[];
  checkPackageHealth(options: {
    packageRoot: string;
    nodeVersion?: string;
    nodeAbi?: string;
  }): { ok: boolean; kind?: string; version?: string };
  classifyStartupFailure(value: unknown): {
    kind: string;
    installedAbi?: string;
    requiredAbi?: string;
  };
  formatStartupFailure(
    failure: { kind: string; installedAbi?: string; requiredAbi?: string },
    context: { installedVersion?: string; nodeVersion: string; nodeAbi: string },
    options?: { debug?: boolean; detail?: string },
  ): string;
  compareVersions(a: string, b: string): number;
  selectUpdateCandidate(options: {
    installed: string;
    latest: string | null;
    beta?: string | null;
    channel: 'stable' | 'beta' | 'off';
  }): string | null;
  normalizeUpdateState(value: unknown): {
    enabled: boolean;
    channel: 'stable' | 'beta' | 'off';
    skippedVersion?: string;
    remindAfter?: number;
  };
  shouldOfferUpdate(options: {
    installed: string;
    candidate: string | null;
    state: Record<string, unknown>;
    now: number;
  }): boolean;
  parseUpdateArgs(args: string[]): {
    mode: 'none' | 'check' | 'install';
    assumeYes: boolean;
    version?: string;
    error?: string;
  };
  inferOwningPrefix(packageRoot: string, platform?: NodeJS.Platform): string | null;
  resolveNpmEnvironment(options: { packageRoot: string; env: NodeJS.ProcessEnv }): { ok: boolean; reason?: string };
};

function packageFixture(options: {
  version?: string;
  packageJson?: string;
  cli?: boolean;
  runtime?: boolean;
} = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aiden-bootstrap-'));
  if (options.packageJson !== undefined) {
    writeFileSync(path.join(dir, 'package.json'), options.packageJson, 'utf8');
  } else {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'aiden-runtime', version: options.version ?? '4.19.0' }),
      'utf8',
    );
  }
  if (options.cli !== false) {
    mkdirSync(path.join(dir, 'dist', 'cli', 'v4'), { recursive: true });
    writeFileSync(path.join(dir, 'dist', 'cli', 'v4', 'aidenCLI.js'), '', 'utf8');
  }
  if (options.runtime !== false) {
    mkdirSync(path.join(dir, 'dist', 'core'), { recursive: true });
    writeFileSync(path.join(dir, 'dist', 'core', 'version.js'), '', 'utf8');
  }
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'bin', 'aiden-updater.cjs'), '', 'utf8');
  return dir;
}

describe('dependency-light command bootstrap', () => {
  it('supports the accepted Node 20 and Node 22 runtimes only', () => {
    expect(bootstrap.SUPPORTED_NODE_MAJORS).toEqual([20, 22]);
    expect(bootstrap.checkPackageHealth({ packageRoot: packageFixture(), nodeVersion: '20.20.2', nodeAbi: '115' }).ok).toBe(true);
    expect(bootstrap.checkPackageHealth({ packageRoot: packageFixture(), nodeVersion: '22.23.1', nodeAbi: '127' }).ok).toBe(true);
    expect(bootstrap.checkPackageHealth({ packageRoot: packageFixture(), nodeVersion: '24.13.1', nodeAbi: '137' })).toMatchObject({
      ok: false,
      kind: 'unsupported-node',
    });
    const unsupported = bootstrap.formatStartupFailure(
      { kind: 'unsupported-node' },
      { installedVersion: '4.19.1', nodeVersion: '24.13.1', nodeAbi: '137' },
    );
    expect(unsupported).toContain('Supported runtimes: Node 20 and Node 22');
    expect(unsupported).toContain('npm install -g aiden-runtime@latest');
  });

  it('detects missing, malformed, and incomplete packages before the full CLI loads', () => {
    expect(bootstrap.checkPackageHealth({ packageRoot: path.join(tmpdir(), 'absent-aiden-package'), nodeVersion: '22.23.1' })).toMatchObject({
      ok: false,
      kind: 'missing-package',
    });
    expect(bootstrap.checkPackageHealth({ packageRoot: packageFixture({ packageJson: '{' }), nodeVersion: '22.23.1' })).toMatchObject({
      ok: false,
      kind: 'malformed-package',
    });
    expect(bootstrap.checkPackageHealth({ packageRoot: packageFixture({ cli: false }), nodeVersion: '22.23.1' })).toMatchObject({
      ok: false,
      kind: 'missing-cli',
    });
    expect(bootstrap.checkPackageHealth({ packageRoot: packageFixture({ runtime: false }), nodeVersion: '22.23.1' })).toMatchObject({
      ok: false,
      kind: 'missing-runtime',
    });
    const withoutUpdater = packageFixture();
    const updaterPath = path.join(withoutUpdater, 'bin', 'aiden-updater.cjs');
    unlinkSync(updaterPath);
    expect(bootstrap.checkPackageHealth({ packageRoot: withoutUpdater, nodeVersion: '22.23.1' })).toMatchObject({
      ok: false,
      kind: 'missing-updater',
    });
  });

  it('classifies the observed native ABI mismatch without exposing a raw stack', () => {
    const detail = [
      'Error: The module better_sqlite3.node was compiled against a different Node.js version using',
      'NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127.',
      '    at Module._extensions..node',
    ].join('\n');
    const classified = bootstrap.classifyStartupFailure(detail);
    expect(classified).toMatchObject({ kind: 'native-abi', installedAbi: '137', requiredAbi: '127' });
    const friendly = bootstrap.formatStartupFailure(classified, {
      installedVersion: '4.19.0',
      nodeVersion: '22.23.1',
      nodeAbi: '127',
    }, { detail });
    expect(friendly).toContain('installed using a different Node version');
    expect(friendly).toContain('ABI 127');
    expect(friendly).toContain('npm install -g aiden-runtime@latest');
    expect(friendly).not.toContain('Module._extensions');
  });

  it('classifies missing modules, generic native load failures, and unknown failures safely', () => {
    expect(bootstrap.classifyStartupFailure({ code: 'MODULE_NOT_FOUND', message: 'missing' }).kind).toBe('missing-module');
    expect(bootstrap.classifyStartupFailure({ code: 'ERR_MODULE_NOT_FOUND', message: 'missing' }).kind).toBe('missing-module');
    expect(bootstrap.classifyStartupFailure({ code: 'ERR_DLOPEN_FAILED', message: 'bad native image' }).kind).toBe('native-load');
    const unknown = bootstrap.formatStartupFailure(
      { kind: 'unknown' },
      { installedVersion: '4.19.0', nodeVersion: '22.23.1', nodeAbi: '127' },
      { detail: 'Error: private stack\n at internal-file:1' },
    );
    expect(unknown).toMatch(/diagnostic/i);
    expect(unknown).not.toContain('internal-file');
    const debug = bootstrap.formatStartupFailure(
      { kind: 'unknown' },
      { installedVersion: '4.19.0', nodeVersion: '22.23.1', nodeAbi: '127' },
      { detail: 'Error: private stack\n at internal-file:1', debug: true },
    );
    expect(debug).toContain('internal-file');
  });
});

describe('bootstrap update policy', () => {
  it('infers the exact owning global prefix without using the current working directory', () => {
    expect(bootstrap.inferOwningPrefix('C:\\isolated prefix\\node_modules\\aiden-runtime', 'win32'))
      .toBe(path.win32.normalize('C:\\isolated prefix'));
    expect(bootstrap.inferOwningPrefix('/opt/aiden/lib/node_modules/aiden-runtime', 'linux'))
      .toBe(path.posix.normalize('/opt/aiden'));
  });

  it('refuses to replace a project-local package or a mismatched owning prefix', () => {
    const local = packageFixture();
    writeFileSync(path.join(local, '.aiden-install.json'), JSON.stringify({
      schemaVersion: 1,
      global: false,
      prefix: path.dirname(local),
    }));
    expect(bootstrap.resolveNpmEnvironment({
      packageRoot: local,
      env: { ...process.env, npm_command: '' },
    })).toMatchObject({ ok: false, reason: 'local-install' });

    writeFileSync(path.join(local, '.aiden-install.json'), JSON.stringify({
      schemaVersion: 1,
      global: true,
      prefix: path.join(tmpdir(), 'different-prefix'),
    }));
    expect(bootstrap.resolveNpmEnvironment({
      packageRoot: local,
      env: { ...process.env, npm_command: '' },
    })).toMatchObject({ ok: false, reason: 'install-receipt-mismatch' });
  });

  it('compares stable and prerelease versions without offering a prerelease to stable users', () => {
    expect(bootstrap.compareVersions('4.19.1', '4.19.0')).toBeGreaterThan(0);
    expect(bootstrap.compareVersions('4.20.0', '4.19.9')).toBeGreaterThan(0);
    expect(bootstrap.compareVersions('5.0.0', '4.99.99')).toBeGreaterThan(0);
    expect(bootstrap.selectUpdateCandidate({ installed: '4.19.0', latest: '4.19.1-beta.1', channel: 'stable' })).toBeNull();
    expect(bootstrap.selectUpdateCandidate({ installed: '4.19.0', latest: '4.19.1', beta: '4.20.0-beta.1', channel: 'stable' })).toBe('4.19.1');
    expect(bootstrap.selectUpdateCandidate({ installed: '4.19.0', latest: '4.19.1', beta: '4.20.0-beta.1', channel: 'beta' })).toBe('4.20.0-beta.1');
    expect(bootstrap.selectUpdateCandidate({ installed: '4.19.0', latest: '4.19.1', channel: 'off' })).toBeNull();
  });

  it('normalizes corrupt state and respects skip and remind-after decisions', () => {
    expect(bootstrap.normalizeUpdateState(null)).toMatchObject({ enabled: true, channel: 'stable' });
    expect(bootstrap.normalizeUpdateState({ enabled: 'bad', channel: 'nightly' })).toMatchObject({ enabled: true, channel: 'stable' });
    expect(bootstrap.shouldOfferUpdate({ installed: '4.19.0', candidate: '4.19.1', state: {}, now: 2_000 })).toBe(true);
    expect(bootstrap.shouldOfferUpdate({ installed: '4.19.0', candidate: '4.19.1', state: { skippedVersion: '4.19.1' }, now: 2_000 })).toBe(false);
    expect(bootstrap.shouldOfferUpdate({ installed: '4.19.0', candidate: '4.19.2', state: { skippedVersion: '4.19.1' }, now: 2_000 })).toBe(true);
    expect(bootstrap.shouldOfferUpdate({ installed: '4.19.0', candidate: '4.19.1', state: { remindAfter: 2_001 }, now: 2_000 })).toBe(false);
  });

  it('parses manual update commands without accepting unsafe versions', () => {
    expect(bootstrap.parseUpdateArgs([])).toEqual({ mode: 'none', assumeYes: false });
    expect(bootstrap.parseUpdateArgs(['update', '--check'])).toEqual({ mode: 'check', assumeYes: false });
    expect(bootstrap.parseUpdateArgs(['update', '--yes'])).toEqual({ mode: 'install', assumeYes: true });
    expect(bootstrap.parseUpdateArgs(['update', '--version', '4.19.1'])).toEqual({
      mode: 'install',
      assumeYes: false,
      version: '4.19.1',
    });
    expect(bootstrap.parseUpdateArgs(['update', '--version', '4.19.1 & whoami']).error).toMatch(/version/i);
  });
});
