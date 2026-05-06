/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/checkUpdate.ts — Aiden v4.0.0 (Phase 20)
 *
 * Background "is there a newer aiden on npm?" check that prints a single
 * boot-card line when an update is available. Mirrors Hermes's
 * `hermes_cli/banner.check_for_updates()` shape (6 h cache, opt-out env
 * var, single-line announcement) but talks to the npm registry instead
 * of running `git fetch`.
 *
 * Strategy:
 *   1. Read the cache at <aiden-home>/.update_check.json.
 *      If `ts` is < 6 h old AND `installed` matches the running version,
 *      use the cached `latest` and skip the network. (Match-on-installed
 *      is Hermes's `HERMES_REVISION` invalidation mechanism, ported.)
 *   2. Otherwise, GET https://registry.npmjs.org/aiden-runtime/latest.
 *      Pull `version` from the response. 4 s timeout — if the network is
 *      slow we cache `null` and try again next boot. Never block REPL boot.
 *   3. Compare versions with a tiny semver subset (Aiden's tags are
 *      strictly `MAJOR.MINOR.PATCH[-beta.N]`, so we don't need a full
 *      semver dependency for this).
 *   4. Write the cache regardless of comparison outcome.
 *
 * Opt-out: `AIDEN_NO_UPDATE_CHECK=1` skips both the cache read and the
 * network probe — the function is a no-op. Same shape Hermes uses for
 * its `HERMES_NO_UPDATE` discipline.
 *
 * The check is awaited via `setImmediate` from the boot path so it never
 * delays the first prompt. Cache hit: ≪1 ms. Cache miss with timeout:
 * up to 4 s on a separate microtask.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from '../paths';

const REGISTRY_URL = 'https://registry.npmjs.org/aiden-runtime/latest';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h, same as Hermes
const REGISTRY_TIMEOUT_MS = 4_000;

export interface UpdateCacheShape {
  /** Epoch ms when this entry was written. */
  ts: number;
  /** Latest version on npm at last check. null = network failed. */
  latest: string | null;
  /** Installed version when this cache was written. Cache invalidates on bump. */
  installed: string;
}

export interface UpdateStatus {
  /** Currently-running Aiden version. */
  installed: string;
  /** npm registry's `latest` dist-tag at last check (null = unknown / offline). */
  latest: string | null;
  /** True iff `latest` is a strict-newer version than `installed`. */
  updateAvailable: boolean;
  /** Whether this status came from the disk cache (no network this boot). */
  fromCache: boolean;
  /**
   * Phase 20 Task 6: true when no prior cache file existed before this
   * call — i.e. first-ever boot of this aiden install. Lets the boot
   * path surface a louder warn() instead of the dim() update line, since
   * a brand-new install shipping with a stale version is unusual enough
   * to flag explicitly.
   */
  firstRun: boolean;
}

export interface CheckUpdateOptions {
  paths: AidenPaths;
  /** Currently-installed Aiden version, usually `package.json` `version`. */
  installedVersion: string;
  /**
   * Override the registry fetch. Tests inject a stubbed fetch that
   * returns either a `{ version: 'x.y.z' }` object or throws to simulate
   * network failure. Defaults to global `fetch` with an AbortController
   * timeout.
   */
  fetchImpl?: (url: string) => Promise<{ version: string }>;
  /** Override env (used by tests for `AIDEN_NO_UPDATE_CHECK`). */
  env?: NodeJS.ProcessEnv;
  /** Override cache TTL. Tests use this to force a refresh. */
  cacheTtlMs?: number;
  /** Override the cache path (defaults to `<aiden-home>/.update_check.json`). */
  cacheFile?: string;
  /** Inject a "now" clock for deterministic tests. */
  now?: () => number;
}

/** Cache file path. Co-located with other Aiden home dotfiles. */
function defaultCacheFile(paths: AidenPaths): string {
  return path.join(paths.root, '.update_check.json');
}

/**
 * Compare two strict `MAJOR.MINOR.PATCH[-beta.N]` versions. Returns
 * positive when `a > b`, negative when `a < b`, zero when equal.
 *
 * Pre-release ordering: `4.0.0` > `4.0.0-beta.2` > `4.0.0-beta.1`. Same
 * as semver.org §11.4. We don't claim to handle alpha/rc/etc — Aiden's
 * tag policy is beta-only.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: number | null } => {
    const [core, pre] = v.split('-');
    const coreNums = core.split('.').map((n) => Number.parseInt(n, 10));
    if (coreNums.some(Number.isNaN)) {
      throw new Error(`unparseable version: ${v}`);
    }
    let preNum: number | null = null;
    if (pre) {
      const m = pre.match(/^beta\.(\d+)$/);
      if (m) preNum = Number.parseInt(m[1], 10);
      else preNum = -1; // unknown pre — treat as oldest
    }
    return { core: coreNums, pre: preNum };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const av = pa.core[i] ?? 0;
    const bv = pb.core[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  // Same core. A non-prerelease wins over a prerelease.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre - pb.pre;
}

async function readCache(file: string): Promise<UpdateCacheShape | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as UpdateCacheShape;
  } catch {
    return null;
  }
}

async function writeCache(file: string, cache: UpdateCacheShape): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(cache));
  } catch {
    /* swallow — cache write is best-effort */
  }
}

/** Default fetch wrapper with a 4-second AbortController timeout. */
async function defaultFetch(url: string): Promise<{ version: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'aiden-runtime update check',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`registry returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { version?: unknown };
    if (typeof json.version !== 'string') {
      throw new Error('registry response missing version');
    }
    return { version: json.version };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Public API. Returns an `UpdateStatus` describing what we know about
 * the latest version. Never throws — network failures resolve with
 * `latest: null` and the boot card stays silent.
 *
 * Honours `AIDEN_NO_UPDATE_CHECK=1` — when set, returns immediately with
 * `latest: null, updateAvailable: false`. No disk read, no network call.
 */
export async function checkForUpdate(opts: CheckUpdateOptions): Promise<UpdateStatus> {
  const env = opts.env ?? process.env;
  const installed = opts.installedVersion;

  if (env.AIDEN_NO_UPDATE_CHECK === '1') {
    return {
      installed,
      latest: null,
      updateAvailable: false,
      fromCache: false,
      firstRun: false,
    };
  }

  const cacheFile = opts.cacheFile ?? defaultCacheFile(opts.paths);
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const now = (opts.now ?? Date.now)();

  const cached = await readCache(cacheFile);
  const firstRun = cached === null;
  if (cached && now - cached.ts < ttl && cached.installed === installed) {
    const updateAvailable =
      cached.latest !== null && safeCompare(cached.latest, installed) > 0;
    return {
      installed,
      latest: cached.latest,
      updateAvailable,
      fromCache: true,
      firstRun: false,
    };
  }

  let latest: string | null = null;
  try {
    const fetchImpl = opts.fetchImpl ?? defaultFetch;
    const result = await fetchImpl(REGISTRY_URL);
    latest = result.version;
  } catch {
    latest = null;
  }

  await writeCache(cacheFile, { ts: now, latest, installed });

  const updateAvailable = latest !== null && safeCompare(latest, installed) > 0;
  return { installed, latest, updateAvailable, fromCache: false, firstRun };
}

/** Wrap `compareVersions` so unparseable strings don't blow up the boot path. */
function safeCompare(a: string, b: string): number {
  try {
    return compareVersions(a, b);
  } catch {
    return 0;
  }
}

/**
 * Format the boot-card line. Returns null when there's nothing to show.
 * Mirrors Hermes's "[update] N commits behind. Run `git pull` to update."
 * shape — single-line, low-key, dismissable by ignoring it.
 */
export function formatUpdateLine(status: UpdateStatus): string | null {
  if (!status.updateAvailable || !status.latest) return null;
  return `[update] aiden v${status.latest} available. Run \`npm install -g aiden-runtime@latest\` to update.`;
}
