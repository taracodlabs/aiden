import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  LicenseClient,
  isWellFormedKey,
  type LicenseFetch,
  type LicenseServerResponse,
} from '../../../core/v4/license/licenseClient';
import { hasLicense } from '../../../core/v4/license/licenseStore';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-licclient-'));
  process.env.AIDEN_MACHINE_KEY = 'test-machine-key-for-licclient';
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_MACHINE_KEY;
});

function makeFetch(
  responses: Record<string, LicenseServerResponse | (() => Promise<never>)>,
): { impl: LicenseFetch; calls: Array<{ path: string; body: object }> } {
  const calls: Array<{ path: string; body: object }> = [];
  const impl: LicenseFetch = async (urlPath, body) => {
    calls.push({ path: urlPath, body });
    const r = responses[urlPath];
    if (typeof r === 'function') return r();
    if (!r) throw new Error(`unexpected fetch to ${urlPath}`);
    return r;
  };
  return { impl, calls };
}

describe('licenseClient', () => {
  it('1. isWellFormedKey accepts valid format and rejects garbage', () => {
    expect(isWellFormedKey('AIDEN-PRO-ABC12-DEF34-GHI56')).toBe(true);
    expect(isWellFormedKey('aiden-pro-abc12-def34-ghi56')).toBe(true); // case-insensitive
    expect(isWellFormedKey('AIDEN-PRO-TOO-SHORT')).toBe(false);
    expect(isWellFormedKey('not-a-key')).toBe(false);
    expect(isWellFormedKey('')).toBe(false);
  });

  it('2. activate() rejects malformed keys without contacting the server', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const { impl, calls } = makeFetch({});
    const client = new LicenseClient({ paths, fetchImpl: impl });
    const r = await client.activate('garbage');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid key format/);
    expect(calls.length).toBe(0);
  });

  it('3. activate() persists cache on success', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const { impl } = makeFetch({
      '/license/activate': {
        activated: true,
        plan: 'pro_yearly',
        expiresAt: '2099-01-01T00:00:00Z',
        features: { multi_tool_approval: true },
      },
    });
    const client = new LicenseClient({ paths, fetchImpl: impl });
    const r = await client.activate('AIDEN-PRO-ABC12-DEF34-GHI56');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cache.plan).toBe('pro_yearly');
      expect(r.cache.features.multi_tool_approval).toBe(true);
    }
    expect(await hasLicense(paths)).toBe(true);
  });

  it('4. activate() surfaces server rejection without caching', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const { impl } = makeFetch({
      '/license/activate': { activated: false, error: 'Key revoked' },
    });
    const client = new LicenseClient({ paths, fetchImpl: impl });
    const r = await client.activate('AIDEN-PRO-ABC12-DEF34-GHI56');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Key revoked');
    expect(await hasLicense(paths)).toBe(false);
  });

  it('5. verify() returns cached pro on fresh cache without a network call', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const fetchA = makeFetch({
      '/license/activate': {
        activated: true,
        plan: 'pro_monthly',
        expiresAt: '2099-01-01T00:00:00Z',
        features: { multi_tool_approval: true },
      },
    });
    const client = new LicenseClient({ paths, fetchImpl: fetchA.impl });
    await client.activate('AIDEN-PRO-ABC12-DEF34-GHI56');

    // Second fetch impl that would throw if hit — proves cache was used.
    const fetchB = makeFetch({
      '/license/verify': () => Promise.reject(new Error('should not be called')),
    });
    const client2 = new LicenseClient({ paths, fetchImpl: fetchB.impl });
    const r = await client2.verify();
    expect(r.tier).toBe('pro');
    if (r.tier === 'pro') expect(r.cached).toBe(true);
    expect(fetchB.calls.length).toBe(0);
  });
});
