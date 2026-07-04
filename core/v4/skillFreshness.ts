/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillFreshness.ts — v4.14 Pillar 6 Slice C.
 *
 * The third skill-lifecycle signal, completing the trio: readiness (A) + trust
 * (B) + FRESHNESS (C). Purely ADVISORY — detect and flag, never auto-update or
 * auto-remove. This is the Phase-14 update-detection finally wired: it reuses
 * the curated-manifest fetch seam (fetchCuratedManifest — never throws) and the
 * semver comparator (compareVersions), and adds a short-TTL disk cache so
 * `/skills health` doesn't hit the network on every call.
 *
 * Four honest states:
 *   current          — installed version matches the upstream manifest.
 *   update_available — the manifest has a newer version (semver) or, at the
 *                      same version, a differing pinned source ref.
 *   local_only       — the skill isn't in the upstream manifest (a user/custom
 *                      or bundled-only skill). NOT stale, just unmanaged.
 *   unknown          — no manifest (offline / fetch failed). Honest, not "current".
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { compareVersions } from './update/checkUpdate';
import { resolveAidenPaths } from './paths';
import {
  fetchCuratedManifest,
  type CuratedManifestEntry,
  type FetchImpl,
} from './skills/curatedManifest';

export type FreshnessStatus = 'current' | 'update_available' | 'local_only' | 'unknown';

export interface SkillFreshness {
  status:            FreshnessStatus;
  installedVersion?: string;
  latestVersion?:    string;
}

/**
 * Pure comparison. `manifestEntry` is the upstream row (or null when the skill
 * isn't in the manifest → local_only). `opts.manifestUnavailable` short-circuits
 * to `unknown` when there was no manifest to compare against at all.
 */
export function computeSkillFreshness(
  installed: { version?: string; ref?: string },
  manifestEntry: CuratedManifestEntry | null,
  opts?: { manifestUnavailable?: boolean },
): SkillFreshness {
  const cur = installed.version;
  if (opts?.manifestUnavailable) return { status: 'unknown', installedVersion: cur };
  if (!manifestEntry)            return { status: 'local_only', installedVersion: cur };

  const latest = manifestEntry.version;

  // Newer upstream version → update. compareVersions throws on a non-semver
  // string, so a weird version never crashes the gate — it just isn't "newer".
  let newer = false;
  try { newer = !!cur && !!latest && compareVersions(latest, cur) > 0; } catch { newer = false; }
  if (newer) return { status: 'update_available', installedVersion: cur, latestVersion: latest };

  // Same version but a differing pinned source ref → content moved under the
  // same version number. Only flag when the versions are equal/comparable-equal
  // (an installed skill that is NEWER than the manifest stays "current").
  if (installed.ref && manifestEntry.upstream_commit && installed.ref !== manifestEntry.upstream_commit) {
    let equalOrUnknown = true;
    try { equalOrUnknown = !cur || !latest || compareVersions(latest, cur) === 0; } catch { equalOrUnknown = true; }
    if (equalOrUnknown) return { status: 'update_available', installedVersion: cur, latestVersion: latest };
  }

  return { status: 'current', installedVersion: cur, latestVersion: latest };
}

// ── resilient, cached manifest load ──────────────────────────────────────

export interface FreshnessManifest {
  available: boolean;
  commit?:   string;
  entries:   Map<string, CuratedManifestEntry>;
}

interface ManifestDiskCache {
  fetchedAt: number;
  commit:    string;
  skills:    CuratedManifestEntry[];
}

export interface LoadManifestOptions {
  cacheFile?:    string;
  /** Cache TTL — default 6h. Within it, no network call. */
  ttlMs?:        number;
  /** Injected in tests; defaults to a timeout-bounded global fetch. */
  fetchImpl?:    FetchImpl;
  /** Injected in tests; defaults to Date.now(). */
  now?:          number;
  forceRefresh?: boolean;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

/** Timeout-bounded global fetch so a slow host can never hang the caller. */
const defaultFetch: FetchImpl = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } finally {
    clearTimeout(timer);
  }
};

function toEntryMap(skills: readonly CuratedManifestEntry[]): Map<string, CuratedManifestEntry> {
  const m = new Map<string, CuratedManifestEntry>();
  for (const e of skills) m.set(e.name, e);
  return m;
}

/**
 * Load the upstream manifest for freshness, non-blocking + resilient:
 *   1. A fresh disk cache (< TTL) is used without touching the network.
 *   2. Otherwise fetch (fetchCuratedManifest never throws); on success, write
 *      the cache and return it.
 *   3. On any failure (offline, bad JSON, timeout) → `available: false` so every
 *      skill reads `unknown`. Never throws, never hangs.
 */
export async function loadManifestForFreshness(opts: LoadManifestOptions = {}): Promise<FreshnessManifest> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now();
  let cacheFile = opts.cacheFile;
  if (!cacheFile) {
    try { cacheFile = path.join(resolveAidenPaths().root, '.skills-manifest-cache.json'); }
    catch { cacheFile = undefined; }
  }

  // 1. fresh cache
  if (cacheFile && !opts.forceRefresh) {
    try {
      const c = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as ManifestDiskCache;
      if (c && typeof c.fetchedAt === 'number' && Array.isArray(c.skills) && (now - c.fetchedAt) < ttl) {
        return { available: true, commit: c.commit, entries: toEntryMap(c.skills) };
      }
    } catch { /* missing / stale / corrupt → fall through to fetch */ }
  }

  // 2. fetch (resilient — never throws)
  const result = await fetchCuratedManifest(opts.fetchImpl ?? defaultFetch);
  if (!result.manifest) {
    return { available: false, entries: new Map() };   // → unknown for all
  }

  // 3. persist the cache (best-effort)
  if (cacheFile) {
    const cache: ManifestDiskCache = {
      fetchedAt: now,
      commit:    result.manifest.commit,
      skills:    [...result.manifest.skills],
    };
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    } catch { /* cache write is best-effort */ }
  }

  return { available: true, commit: result.manifest.commit, entries: toEntryMap(result.manifest.skills) };
}

/** One-line human freshness cell for a health row. */
export function freshnessCell(f: SkillFreshness): string {
  switch (f.status) {
    case 'current':          return 'current';
    case 'update_available': return `⬆ ${f.installedVersion ?? '?'}→${f.latestVersion ?? '?'}`;
    case 'local_only':       return 'local';
    default:                 return '? offline';
  }
}
