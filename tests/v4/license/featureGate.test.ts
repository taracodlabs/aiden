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
  type LicenseCache,
} from '../../../core/v4/license/licenseStore';
import {
  FeatureGate,
  FEATURE_FLAGS,
} from '../../../core/v4/license/featureGate';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-gate-'));
  process.env.AIDEN_MACHINE_KEY = 'test-machine-key-gate';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_MACHINE_KEY;
});

describe('FeatureGate', () => {
  it('1. denies all features for free tier (no cache)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const gate = new FeatureGate({ paths });
    expect(await gate.isProEnabled(FEATURE_FLAGS.MULTI_TOOL_APPROVAL)).toBe(false);
    expect(await gate.isProEnabled(FEATURE_FLAGS.CUSTOM_PERSONALITIES)).toBe(false);
    expect(await gate.isProEnabled(FEATURE_FLAGS.SILENT_OAUTH_REFRESH)).toBe(false);
  });

  it('2. allows feature when explicitly enabled in cache', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const cache: LicenseCache = {
      key: 'AIDEN-PRO-ABC12-DEF34-GHI56',
      valid: true,
      plan: 'pro_monthly',
      expiresAt: '2099-01-01T00:00:00Z',
      features: { [FEATURE_FLAGS.MULTI_TOOL_APPROVAL]: true },
      lastVerified: Date.now(),
    };
    await saveLicense(paths, cache);
    const gate = new FeatureGate({ paths });
    expect(await gate.isProEnabled(FEATURE_FLAGS.MULTI_TOOL_APPROVAL)).toBe(true);
    // Forward-compat: missing flag on a valid Pro cache defaults to enabled.
    expect(await gate.isProEnabled(FEATURE_FLAGS.CUSTOM_PERSONALITIES)).toBe(true);
  });

  it('3. denies feature when explicitly disabled in cache', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const cache: LicenseCache = {
      key: 'AIDEN-PRO-ABC12-DEF34-GHI56',
      valid: true,
      plan: 'pro_basic',
      expiresAt: '2099-01-01T00:00:00Z',
      features: { [FEATURE_FLAGS.MULTI_TOOL_APPROVAL]: false },
      lastVerified: Date.now(),
    };
    await saveLicense(paths, cache);
    const gate = new FeatureGate({ paths });
    expect(await gate.isProEnabled(FEATURE_FLAGS.MULTI_TOOL_APPROVAL)).toBe(false);
  });

  it('4. degradation message names the feature and links upgrade URL', () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const gate = new FeatureGate({ paths });
    const msg = gate.degradationMessage(FEATURE_FLAGS.CUSTOM_PERSONALITIES);
    expect(msg).toContain('Custom personalities');
    expect(msg).toContain('aiden.taracod.com/pro');
    expect(msg).toContain('/license activate');
  });
});
