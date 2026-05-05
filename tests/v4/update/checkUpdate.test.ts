import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  checkForUpdate,
  formatUpdateLine,
  compareVersions,
} from '../../../core/v4/update/checkUpdate';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-update-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_NO_UPDATE_CHECK;
});

describe('compareVersions', () => {
  it('1. orders core versions and beta prereleases', () => {
    expect(compareVersions('4.0.1', '4.0.0')).toBeGreaterThan(0);
    expect(compareVersions('4.0.0', '4.0.0')).toBe(0);
    expect(compareVersions('4.0.0-beta.1', '4.0.0-beta.2')).toBeLessThan(0);
    // Stable always > prerelease at same core
    expect(compareVersions('4.0.0', '4.0.0-beta.5')).toBeGreaterThan(0);
    // Higher core beats prerelease comparison
    expect(compareVersions('4.0.1-beta.1', '4.0.0')).toBeGreaterThan(0);
  });
});

describe('checkForUpdate', () => {
  it('2. returns updateAvailable=true when registry has a newer version', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const status = await checkForUpdate({
      paths,
      installedVersion: '4.0.0-beta.1',
      fetchImpl: async () => ({ version: '4.0.0-beta.2' }),
    });
    expect(status.updateAvailable).toBe(true);
    expect(status.latest).toBe('4.0.0-beta.2');
    expect(status.fromCache).toBe(false);
  });

  it('3. uses cache on second call within TTL without hitting registry', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { version: '4.0.0' };
    };
    await checkForUpdate({
      paths,
      installedVersion: '4.0.0-beta.1',
      fetchImpl,
    });
    expect(calls).toBe(1);
    const second = await checkForUpdate({
      paths,
      installedVersion: '4.0.0-beta.1',
      fetchImpl,
    });
    expect(calls).toBe(1); // cache hit, no second fetch
    expect(second.fromCache).toBe(true);
    expect(second.updateAvailable).toBe(true);
  });

  it('4. AIDEN_NO_UPDATE_CHECK=1 skips both cache and network', async () => {
    process.env.AIDEN_NO_UPDATE_CHECK = '1';
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    let calls = 0;
    const status = await checkForUpdate({
      paths,
      installedVersion: '4.0.0-beta.1',
      fetchImpl: async () => {
        calls++;
        return { version: '99.0.0' };
      },
    });
    expect(calls).toBe(0);
    expect(status.updateAvailable).toBe(false);
    expect(status.latest).toBeNull();
  });

  it('5. formatUpdateLine returns null when nothing to announce', () => {
    expect(
      formatUpdateLine({
        installed: '4.0.0',
        latest: '4.0.0',
        updateAvailable: false,
        fromCache: false,
      }),
    ).toBeNull();
    const ln = formatUpdateLine({
      installed: '4.0.0-beta.1',
      latest: '4.0.0-beta.2',
      updateAvailable: true,
      fromCache: false,
    });
    expect(ln).toContain('4.0.0-beta.2');
    expect(ln).toContain('npm install');
  });

  it('6. cache invalidates when installed version changes', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { version: '4.0.0-beta.5' };
    };
    await checkForUpdate({
      paths,
      installedVersion: '4.0.0-beta.1',
      fetchImpl,
    });
    expect(calls).toBe(1);
    // Same boot, but the user just upgraded — installed version bumped.
    // Cache should be considered stale and re-fetch.
    await checkForUpdate({
      paths,
      installedVersion: '4.0.0-beta.5',
      fetchImpl,
    });
    expect(calls).toBe(2);
  });
});
