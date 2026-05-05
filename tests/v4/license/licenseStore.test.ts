import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  saveLicense,
  loadLicense,
  clearLicense,
  hasLicense,
  type LicenseCache,
} from '../../../core/v4/license/licenseStore';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-licstore-'));
  process.env.AIDEN_MACHINE_KEY = 'test-machine-key-for-licstore';
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_MACHINE_KEY;
});

const sample: LicenseCache = {
  key: 'AIDEN-PRO-ABC12-DEF34-GHI56',
  valid: true,
  plan: 'pro_monthly',
  expiresAt: '2099-01-01T00:00:00Z',
  features: { multi_tool_approval: true, silent_oauth_refresh: true },
  lastVerified: 1_000_000_000_000,
};

describe('licenseStore', () => {
  it('1. round-trips a license cache through encrypt/decrypt', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveLicense(paths, sample);
    const back = await loadLicense(paths);
    expect(back?.key).toBe(sample.key);
    expect(back?.features.multi_tool_approval).toBe(true);
    expect(back?.lastVerified).toBe(sample.lastVerified);
  });

  it('2. on-disk file does NOT contain the license key in plaintext', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveLicense(paths, sample);
    expect(await hasLicense(paths)).toBe(true);
    const dir = path.join(paths.root, 'license');
    const files = await fs.readdir(dir);
    expect(files.length).toBe(1);
    const raw = await fs.readFile(path.join(dir, files[0]), 'utf8');
    expect(raw).not.toContain(sample.key);
    expect(raw).toContain('"version": 1');
    expect(raw).toContain('"ciphertext"');
  });

  it('3. clearLicense removes the file', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveLicense(paths, sample);
    expect(await hasLicense(paths)).toBe(true);
    await clearLicense(paths);
    expect(await hasLicense(paths)).toBe(false);
    expect(await loadLicense(paths)).toBeNull();
  });
});
