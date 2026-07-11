import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  REMOVED_OAUTH_PROVIDERS,
  isRemovedOAuthProvider,
  findOrphanedRemovedTokens,
  cleanupRemovedProviderToken,
  announceRemovedProviderOrphans,
} from '../../../core/v4/auth/removedProviders';
import { saveTokens, hasTokens } from '../../../core/v4/auth/tokenStore';
import { resolveAidenPaths, ensureAidenDirsExist, type AidenPaths } from '../../../core/v4/paths';

let tmpRoot: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-removed-prov-'));
  process.env.AIDEN_TOKEN_KEY = 'test-key-removed-prov';
  paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await ensureAidenDirsExist(paths);
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
});

async function seedToken(provider: string): Promise<void> {
  await saveTokens(paths, {
    provider,
    accessToken: 'orphan-AT',
    refreshToken: null,
    expiresAtMs: Date.now() + 3600_000,
  });
}

describe('REMOVED_OAUTH_PROVIDERS registry', () => {
  it('claude-pro is a removed provider; live providers are not', () => {
    expect(REMOVED_OAUTH_PROVIDERS).toContain('claude-pro');
    expect(isRemovedOAuthProvider('claude-pro')).toBe(true);
    expect(isRemovedOAuthProvider('chatgpt-plus')).toBe(false);
    expect(isRemovedOAuthProvider('anthropic')).toBe(false);
  });
});

describe('findOrphanedRemovedTokens', () => {
  it('returns [] on a clean install (nothing to pay for beyond one access)', async () => {
    expect(await findOrphanedRemovedTokens(paths)).toEqual([]);
  });
  it('surfaces a leftover claude-pro token', async () => {
    await seedToken('claude-pro');
    expect(await findOrphanedRemovedTokens(paths)).toEqual(['claude-pro']);
  });
});

describe('announceRemovedProviderOrphans — non-interactive (headless) MUST diagnose, never delete', () => {
  it('prints the removal notice + file + purge command, and leaves the file on disk', async () => {
    await seedToken('claude-pro');
    const lines: string[] = [];
    const result = await announceRemovedProviderOrphans({
      paths,
      interactive: false,
      write: (l) => lines.push(l),
      // no confirm — non-interactive
    });
    const text = lines.join('\n');
    expect(text).toMatch(/no longer supported/i);
    expect(text).toContain(path.join(paths.root, 'auth', 'claude-pro.json'));
    expect(text).toContain('aiden auth cleanup claude-pro');
    expect(result.diagnosed).toEqual(['claude-pro']);
    expect(result.deleted).toEqual([]);
    // The invariant: silence/headless is not consent — the file survives.
    expect(await hasTokens(paths, 'claude-pro')).toBe(true);
  });

  it('does nothing on a clean install', async () => {
    const lines: string[] = [];
    const result = await announceRemovedProviderOrphans({
      paths, interactive: false, write: (l) => lines.push(l),
    });
    expect(lines).toEqual([]);
    expect(result).toEqual({ diagnosed: [], deleted: [], kept: [] });
  });
});

describe('announceRemovedProviderOrphans — interactive respects the user choice', () => {
  it('confirm → delete removes the file', async () => {
    await seedToken('claude-pro');
    const result = await announceRemovedProviderOrphans({
      paths, interactive: true, write: () => {}, confirm: async () => true,
    });
    expect(result.deleted).toEqual(['claude-pro']);
    expect(await hasTokens(paths, 'claude-pro')).toBe(false);
  });
  it('decline → keep leaves the file (nothing auto-deletes)', async () => {
    await seedToken('claude-pro');
    const result = await announceRemovedProviderOrphans({
      paths, interactive: true, write: () => {}, confirm: async () => false,
    });
    expect(result.kept).toEqual(['claude-pro']);
    expect(await hasTokens(paths, 'claude-pro')).toBe(true);
  });
});

describe('cleanupRemovedProviderToken — the only delete path, scoped to removed providers', () => {
  it('removes a present claude-pro token', async () => {
    await seedToken('claude-pro');
    const r = await cleanupRemovedProviderToken(paths, 'claude-pro');
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(true);
    expect(await hasTokens(paths, 'claude-pro')).toBe(false);
  });
  it('is a friendly no-op when there is nothing to remove', async () => {
    const r = await cleanupRemovedProviderToken(paths, 'claude-pro');
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(false);
  });
  it('HARD GUARD: refuses a live provider and never deletes its token', async () => {
    await seedToken('chatgpt-plus');
    const r = await cleanupRemovedProviderToken(paths, 'chatgpt-plus');
    expect(r.ok).toBe(false);
    expect(r.removed).toBe(false);
    // The live provider's credential is untouched — this is not a delete-any path.
    expect(await hasTokens(paths, 'chatgpt-plus')).toBe(true);
  });
});

describe('upgrade path — an install that already contains a real claude-pro.json', () => {
  // The migration a live Pro/Max user actually hits: they had a working
  // subscription login (full token bundle on disk), then upgraded to a build
  // where the provider no longer exists.
  it('surfaces the leftover login, keeps it through a headless boot, and purges on demand', async () => {
    await saveTokens(paths, {
      provider: 'claude-pro',
      accessToken: 'prior-install-AT',
      refreshToken: 'prior-install-RT',
      expiresAtMs: Date.now() + 3600_000,
      account: 'user@example.com',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
    });

    // 1. Detector sees the upgraded-in orphan.
    expect(await findOrphanedRemovedTokens(paths)).toEqual(['claude-pro']);

    // 2. First headless boot: diagnostic printed, file left intact (no consent).
    const lines: string[] = [];
    const boot = await announceRemovedProviderOrphans({
      paths, interactive: false, write: (l) => lines.push(l),
    });
    expect(boot.diagnosed).toEqual(['claude-pro']);
    expect(boot.deleted).toEqual([]);
    expect(lines.join('\n')).toContain('aiden auth cleanup claude-pro');
    expect(await hasTokens(paths, 'claude-pro')).toBe(true);

    // 3. The user runs cleanup explicitly → the orphan is gone.
    const purge = await cleanupRemovedProviderToken(paths, 'claude-pro');
    expect(purge.removed).toBe(true);
    expect(await findOrphanedRemovedTokens(paths)).toEqual([]);
  });
});
