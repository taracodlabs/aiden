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
 * boot-card line when an update is available. 6 h cache, opt-out env
 * var, single-line announcement; talks to the npm registry rather than
 * running `git fetch`.
 *
 * Strategy:
 *   1. Read the cache at <aiden-home>/.update_check.json.
 *      If `ts` is < 6 h old AND `installed` matches the running version,
 *      use the cached `latest` and skip the network. Match-on-installed
 *      invalidates the cache when the user upgrades.
 *   2. Otherwise, GET https://registry.npmjs.org/aiden-runtime/latest.
 *      Pull `version` from the response. 4 s timeout — if the network is
 *      slow we cache `null` and try again next boot. Never block REPL boot.
 *   3. Compare versions with a tiny semver subset (Aiden's tags are
 *      strictly `MAJOR.MINOR.PATCH[-beta.N]`, so we don't need a full
 *      semver dependency for this).
 *   4. Write the cache regardless of comparison outcome.
 *
 * Opt-out: `AIDEN_NO_UPDATE_CHECK=1` skips both the cache read and the
 * network probe — the function is a no-op.
 *
 * The check is awaited via `setImmediate` from the boot path so it never
 * delays the first prompt. Cache hit: ≪1 ms. Cache miss with timeout:
 * up to 4 s on a separate microtask.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from '../paths';

const REGISTRY_URL = 'https://registry.npmjs.org/aiden-runtime/latest';
// v4.5 update system — TTL bumped 6h → 24h per spec. The old 6h
// supported the firstRun loud-warn UX; the new interactive boot
// prompt makes the prompt itself the prominent surface, so we can
// relax the refresh cadence.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 4_000;

export interface UpdateCacheShape {
  /** Epoch ms when this entry was written. */
  ts: number;
  /** Latest version on npm at last check. null = network failed. */
  latest: string | null;
  /** Installed version when this cache was written. Cache invalidates on bump. */
  installed: string;
  /**
   * v4.5 update system — first descriptive line of the GitHub
   * release body (~120 chars) and the release-page URL. Optional;
   * populated only when GitHub releases endpoint responded with a
   * matching tag.
   */
  releaseNotes?: string;
  releaseUrl?:   string;
  /**
   * v4.5 update system — user typed 'n' on this version. The boot
   * prompt suppresses re-prompting until npm publishes a newer
   * version. Q-U7(b) "skip until newer than X" semantics — see
   * `core/v4/update/skipState.ts::isVersionSkipped`.
   */
  skippedVersion?: string;
  /** Automatic retry backoff after a failed or rejected install attempt. */
  failedVersion?: string;
  failureCount?: number;
  retryAfter?: number;
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
   *
   * v4.5 note: the new interactive boot prompt UX replaces the
   * loud-warn/dim split — firstRun is retained for diagnostic
   * surfaces (e.g. `aiden doctor`) but no longer drives the
   * loud-warn rendering path.
   */
  firstRun: boolean;
  /**
   * v4.5 update system — release-notes blurb populated when the
   * GitHub releases endpoint responded. Omitted otherwise. The
   * boot prompt + `/update` slash both consult this.
   */
  releaseNotes?: string;
  releaseUrl?:   string;
  /**
   * v4.5 update system — `true` when the user previously typed 'n'
   * on this latest version (cache.skippedVersion >= latest). The
   * boot prompt MUST suppress when this is true.
   */
  skipped:       boolean;
  /** True only for automatic boot prompting; manual /update still retries. */
  failureBackoffActive?: boolean;
  failureBackoffUntil?: number;
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

/**
 * v4.5 update system — public cache writer for the skip-state +
 * release-notes machinery. `mutate` receives the current cache
 * (or a fresh empty shell when none exists) and returns the new
 * cache content; this function persists. Used by:
 *
 *   - `/update skip <v>` slash command (writes skippedVersion)
 *   - boot prompt path (writes skippedVersion on 'n')
 *   - registry probe path (writes releaseNotes / releaseUrl)
 *
 * Never throws — best-effort I/O.
 */
export async function updateCacheFile(
  paths:  AidenPaths,
  mutate: (current: UpdateCacheShape) => UpdateCacheShape,
): Promise<void> {
  const file = defaultCacheFile(paths);
  const current = (await readCache(file)) ?? {
    ts:        0,
    latest:    null,
    installed: '',
  };
  const next = mutate(current);
  await writeCache(file, next);
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
      skipped: false,
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
    // v4.5 — surface skip-state lazily so the boot prompt can decide
    // whether to render the box at all. The compare is cheap; we
    // avoid pulling skipState.ts module-level to keep this file's
    // dep graph minimal.
    const skipped =
      typeof cached.skippedVersion === 'string' &&
      cached.latest !== null &&
      safeCompare(cached.skippedVersion, cached.latest) >= 0;
    const failureBackoffActive =
      typeof cached.failedVersion === 'string' &&
      cached.failedVersion === cached.latest &&
      typeof cached.retryAfter === 'number' &&
      now < cached.retryAfter;
    return {
      installed,
      latest: cached.latest,
      updateAvailable,
      fromCache: true,
      firstRun: false,
      releaseNotes: cached.releaseNotes,
      releaseUrl:   cached.releaseUrl,
      skipped,
      failureBackoffActive,
      failureBackoffUntil: cached.retryAfter,
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

  // v4.5 — preserve skippedVersion + release-notes across cache
  // refreshes. The fresh probe overwrites the {ts, latest, installed}
  // triple; everything else carries forward from the prior cache.
  await writeCache(cacheFile, {
    ts:             now,
    latest,
    installed,
    releaseNotes:   cached?.releaseNotes,
    releaseUrl:     cached?.releaseUrl,
    skippedVersion: cached?.skippedVersion,
    failedVersion:  cached?.failedVersion,
    failureCount:   cached?.failureCount,
    retryAfter:     cached?.retryAfter,
  });

  const updateAvailable = latest !== null && safeCompare(latest, installed) > 0;
  const skipped =
    typeof cached?.skippedVersion === 'string' &&
    latest !== null &&
    safeCompare(cached.skippedVersion, latest) >= 0;
  const failureBackoffActive =
    typeof cached?.failedVersion === 'string' &&
    cached.failedVersion === latest &&
    typeof cached.retryAfter === 'number' &&
    now < cached.retryAfter;
  return {
    installed,
    latest,
    updateAvailable,
    fromCache: false,
    firstRun,
    releaseNotes: cached?.releaseNotes,
    releaseUrl:   cached?.releaseUrl,
    skipped,
    failureBackoffActive,
    failureBackoffUntil: cached?.retryAfter,
  };
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
 * Single-line, low-key, dismissable by ignoring it.
 */
export function formatUpdateLine(status: UpdateStatus): string | null {
  if (!status.updateAvailable || !status.latest) return null;
  return `[update] aiden v${status.latest} available. Run \`npm install -g aiden-runtime@latest\` to update.`;
}
