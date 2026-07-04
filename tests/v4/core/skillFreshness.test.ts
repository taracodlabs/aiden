/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 Pillar 6 Slice C — skill freshness (version/staleness). Advisory only:
 * detect + flag. Pure comparison across the four honest states, plus the
 * resilient, cached, non-blocking manifest load (offline → unknown, never a
 * throw or a hang; a fresh cache skips the network).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  computeSkillFreshness, loadManifestForFreshness, freshnessCell,
} from '../../../core/v4/skillFreshness';
import type { CuratedManifestEntry, FetchImpl } from '../../../core/v4/skills/curatedManifest';

const entry = (name: string, version: string, commit = 'c1'): CuratedManifestEntry => ({
  name, path: `skills/${name}`, description: 'd', category: 'misc', version,
  license: 'MIT', author: 'a', upstream_source: 'https://example/x', upstream_commit: commit,
  size_bytes: 100, files: ['SKILL.md'],
});
const manifestJson = (skills: CuratedManifestEntry[]): string =>
  JSON.stringify({ schema_version: 1, snapshot_at: '2026-01-01T00:00:00Z', commit: 'mc1', skills });
const okFetch = (json: string, c?: { n: number }): FetchImpl =>
  async () => { if (c) c.n += 1; return { ok: true, status: 200, text: async () => json }; };
const failFetch = (c?: { n: number }): FetchImpl =>
  async () => { if (c) c.n += 1; throw new Error('offline'); };

// ── the four states (pure) ─────────────────────────────────────────────────
describe('computeSkillFreshness', () => {
  it('current — installed version matches the manifest', () => {
    expect(computeSkillFreshness({ version: '1.2.0' }, entry('a', '1.2.0')).status).toBe('current');
  });

  it('update_available — the manifest has a newer semver', () => {
    const f = computeSkillFreshness({ version: '1.0.0' }, entry('a', '1.2.0'));
    expect(f.status).toBe('update_available');
    expect(f.installedVersion).toBe('1.0.0');
    expect(f.latestVersion).toBe('1.2.0');
  });

  it('update_available — same version but a differing pinned ref', () => {
    const f = computeSkillFreshness({ version: '1.0.0', ref: 'oldsha' }, entry('a', '1.0.0', 'newsha'));
    expect(f.status).toBe('update_available');
  });

  it('local_only — the skill is not in the manifest (unmanaged, NOT stale)', () => {
    expect(computeSkillFreshness({ version: '9.9.9' }, null).status).toBe('local_only');
  });

  it('unknown — no manifest (offline / fetch failed), honest not "current"', () => {
    expect(computeSkillFreshness({ version: '1.0.0' }, null, { manifestUnavailable: true }).status).toBe('unknown');
  });

  it('an installed skill NEWER than the manifest stays current (never downgrades)', () => {
    expect(computeSkillFreshness({ version: '2.0.0' }, entry('a', '1.0.0')).status).toBe('current');
  });

  it('an unparseable version never throws — falls back to current', () => {
    expect(() => computeSkillFreshness({ version: 'weird-x' }, entry('a', '1.0.0'))).not.toThrow();
    expect(computeSkillFreshness({ version: 'weird-x' }, entry('a', '1.0.0')).status).toBe('current');
  });
});

// ── resilient, cached load ─────────────────────────────────────────────────
describe('loadManifestForFreshness', () => {
  let tmp: string; let cacheFile: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-fresh-'));
    cacheFile = path.join(tmp, 'cache.json');
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

  it('fetch success → available + entries + a written cache', async () => {
    const m = await loadManifestForFreshness({ cacheFile, fetchImpl: okFetch(manifestJson([entry('a', '1.0.0')])), now: 1000 });
    expect(m.available).toBe(true);
    expect(m.entries.get('a')?.version).toBe('1.0.0');
    expect(await fs.readFile(cacheFile, 'utf8')).toContain('"fetchedAt"');
  });

  it('a fetch failure → available:false (all unknown), never throws, never hangs', async () => {
    const c = { n: 0 };
    const m = await loadManifestForFreshness({ cacheFile: path.join(tmp, 'none.json'), fetchImpl: failFetch(c), now: 1 });
    expect(m.available).toBe(false);
    expect(m.entries.size).toBe(0);
    expect(c.n).toBe(1);
  });

  it('a second call within the TTL uses the cache — no re-fetch', async () => {
    const c = { n: 0 };
    const opts = { cacheFile, fetchImpl: okFetch(manifestJson([entry('a', '1.0.0')]), c) };
    await loadManifestForFreshness({ ...opts, now: 1000 });
    expect(c.n).toBe(1);
    const m2 = await loadManifestForFreshness({ ...opts, now: 1000 + 60_000 });   // < 6h
    expect(c.n).toBe(1);                    // cache hit — no network
    expect(m2.available).toBe(true);
  });

  it('a stale cache (past TTL) re-fetches', async () => {
    const c = { n: 0 };
    const opts = { cacheFile, fetchImpl: okFetch(manifestJson([entry('a', '1.0.0')]), c) };
    await loadManifestForFreshness({ ...opts, now: 0 });
    await loadManifestForFreshness({ ...opts, now: 7 * 60 * 60 * 1000 });          // > 6h TTL
    expect(c.n).toBe(2);
  });

  it('forceRefresh bypasses the cache', async () => {
    const c = { n: 0 };
    const opts = { cacheFile, fetchImpl: okFetch(manifestJson([entry('a', '1.0.0')]), c) };
    await loadManifestForFreshness({ ...opts, now: 1000 });
    await loadManifestForFreshness({ ...opts, now: 1000, forceRefresh: true });
    expect(c.n).toBe(2);
  });
});

// ── rendering ──────────────────────────────────────────────────────────────
describe('freshnessCell', () => {
  it('renders all four states honestly', () => {
    expect(freshnessCell({ status: 'current' })).toBe('current');
    expect(freshnessCell({ status: 'update_available', installedVersion: '1.0.0', latestVersion: '1.2.0' })).toBe('⬆ 1.0.0→1.2.0');
    expect(freshnessCell({ status: 'local_only' })).toBe('local');
    expect(freshnessCell({ status: 'unknown' })).toBe('? offline');
  });
});
