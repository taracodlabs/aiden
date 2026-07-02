/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/cron/cronState.ts — Phase v4.1-cron
 *
 * Durable state for the cron scheduler. One JSON file at
 * `~/.aiden/cron_jobs.json` with shape:
 *
 *   {
 *     schemaVersion: 2,
 *     updatedAt:     "2026-05-09T..",
 *     jobs:          [<CronJob>, ...]
 *   }
 *
 * Three responsibilities:
 *
 *   1. Whole-state file lock via `proper-lockfile`. Lock path:
 *      `<state>.lock`. Non-blocking acquire (retries=0). Two
 *      processes racing → first wins, second gets `lockHeld`. The
 *      heartbeat skips silently when locked; user-driven API calls
 *      surface a clear error so the user can retry.
 *
 *   2. Schema migration. v1 = bare array `[CronJob, ...]`,
 *      v2 = enveloped. Detected on first read; auto-migrated
 *      transparently with one stderr line per process boot.
 *
 *   3. Auto-repair on JSON corruption. Try strict parse → fallback
 *      strip-trailing-commas → fallback empty + rename original
 *      to `.bak.<ts>`. Mirrors prior multi-agent systems' lesson:
 *      a partial write or external editor truncation should NOT
 *      leave the user with no scheduled jobs.
 *
 * Stateless module — every call opens, reads, mutates, writes,
 * closes. The in-memory cache lives in `cronManager.ts` and is
 * refreshed by the heartbeat.
 */

import { promises as fsp } from 'node:fs';
import { existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { writeJsonAtomic } from './atomicWrite';
import { resolveUserPath, resolveAidenRoot } from '../paths';
import {
  CRON_SCHEMA_VERSION,
  type CronFireRecord,
} from './diagnostics';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lockfile = require('proper-lockfile') as {
  lock:    (file: string, opts?: Record<string, unknown>) => Promise<() => Promise<void>>;
  unlock:  (file: string, opts?: Record<string, unknown>) => Promise<void>;
  check:   (file: string, opts?: Record<string, unknown>) => Promise<boolean>;
};

// ── Schema types ─────────────────────────────────────────────────────────

export type CronKind = 'interval' | 'cron' | 'oneshot';

/** Per-job persisted record. Matches legacy fields + adds the new
 *  hardened fields (state, pausedAt, lastDeliveryError, etc.). */
export interface CronJobV2 {
  id:           string;
  description:  string;
  schedule:     string;
  kind:         CronKind;
  intervalMs?:  number;
  cronExpr?:    string;
  oneshotIso?:  string;
  action:       string;
  enabled:      boolean;
  /** v4.1-cron — discriminated state. `enabled=true` is
   *  necessary but not sufficient — `state="error"` keeps the job
   *  in the registry without firing, so the user can /cron status
   *  see it. */
  state:        'scheduled' | 'paused' | 'completed' | 'error';
  pausedAt?:    string | null;
  pausedReason?: string | null;
  createdAt:    string;
  lastRun?:     string;
  lastResult?:  CronFireRecord['status'];
  lastOutput?:  string;
  lastError?:   string | null;
  /** v4.1-cron — separate from lastError, tracks errors that
   *  happened AFTER the agent step (e.g. delivery to a channel). */
  lastDeliveryError?: string | null;
  nextRun?:     string;
  runCount:     number;
}

export interface CronStateV2 {
  schemaVersion: 2;
  updatedAt:     string;
  jobs:          CronJobV2[];
}

// ── Paths ────────────────────────────────────────────────────────────────

export interface CronPaths {
  stateFile: string;
  lockFile:  string;
  logsDir:   string;
}

export function defaultCronPaths(
  homeOverride?: string,
  /** Test seams — production callers omit both. */
  opts?: { platformRoot?: string; legacyRoot?: string },
): CronPaths {
  // Honor AIDEN_HOME (used by tests + multi-profile workflows). When
  // set, paths root IS AIDEN_HOME directly (no `.aiden` suffix). Routed
  // through resolveUserPath so a quoted / ~-prefixed value can't glue
  // onto the cwd (v4.12.1 class fix).
  //
  // v4.12.1 cron-root unification — the fallback previously hardcoded
  // `~/.aiden`, which had DRIFTED from the product-wide platform root
  // (`resolveAidenRoot()`: %LOCALAPPDATA%\aiden on Windows, Application
  // Support on macOS, XDG on Linux) — so cron jobs lived in a different
  // directory than every other Aiden artifact. Now unified onto the one
  // resolver, with a one-time COPY migration from the legacy location so
  // existing installs' jobs + logs follow (see
  // maybeMigrateLegacyCronState below). AIDEN_HOME / homeOverride users
  // are untouched — migration runs only on the platform-root branch.
  let root: string;
  if (homeOverride && homeOverride.length > 0) {
    root = homeOverride;
  } else {
    const envRoot = resolveUserPath(process.env.AIDEN_HOME);
    if (envRoot) {
      root = envRoot;
    } else {
      root = opts?.platformRoot ?? resolveAidenRoot();
      maybeMigrateLegacyCronState(root, opts?.legacyRoot);
    }
  }
  const stateFile = path.join(root, 'cron_jobs.json');
  return {
    stateFile,
    lockFile: `${stateFile}.lock`,
    logsDir:  path.join(root, 'cron-logs'),
  };
}

/**
 * v4.12.1 — one-time migration of cron state from the legacy `~/.aiden`
 * location into the unified platform root. COPY semantics (the legacy
 * files are left in place — no destructive move), naturally idempotent:
 *
 *   - legacy cron_jobs.json absent            → fresh install, no-op.
 *   - platform cron_jobs.json already present → platform wins, never
 *     overwritten (also makes re-runs after a successful copy no-ops).
 *   - legacy root IS the platform root        → no-op (Linux installs
 *     where resolveAidenRoot itself prefers the legacy dir).
 *
 * Copies the state file + the cron-logs dir, then logs ONE stderr line.
 * Best-effort: any I/O failure is swallowed — migration must never
 * break boot; the worst case is cron booting with an empty registry at
 * the new location while the legacy file stays intact on disk.
 */
export function maybeMigrateLegacyCronState(
  destRoot: string,
  legacyRoot: string = path.join(os.homedir(), '.aiden'),
): void {
  try {
    if (path.resolve(legacyRoot) === path.resolve(destRoot)) return;
    const legacyState = path.join(legacyRoot, 'cron_jobs.json');
    const destState   = path.join(destRoot, 'cron_jobs.json');
    if (!existsSync(legacyState) || existsSync(destState)) return;
    mkdirSync(destRoot, { recursive: true });
    copyFileSync(legacyState, destState);
    const legacyLogs = path.join(legacyRoot, 'cron-logs');
    const destLogs   = path.join(destRoot, 'cron-logs');
    if (existsSync(legacyLogs) && !existsSync(destLogs)) {
      cpSync(legacyLogs, destLogs, { recursive: true });
    }
    process.stderr.write(
      `v4.12.1-cron: migrated cron state ${legacyState} -> ${destState}\n`,
    );
  } catch {
    /* best-effort — never break boot on a migration failure */
  }
}

// ── Migration ────────────────────────────────────────────────────────────

let _migrationLogged = false;

/** Migrate a parsed v1 (bare array) to v2 envelope. Idempotent —
 *  v2 envelopes pass through unchanged. Mutates in place + returns
 *  the new envelope. Logs ONE stderr line per process boot. */
export function migrateToV2(parsed: unknown): CronStateV2 {
  // v2 envelope — pass through.
  if (parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && 'schemaVersion' in (parsed as object)
      && (parsed as { schemaVersion: number }).schemaVersion === CRON_SCHEMA_VERSION) {
    return enrichV2(parsed as CronStateV2);
  }
  // v1 bare array — wrap.
  if (Array.isArray(parsed)) {
    if (!_migrationLogged) {
      try {
        process.stderr.write(
          'v4.1-cron: migrated cron_jobs.json schema v1 → v2\n',
        );
      } catch { /* non-fatal */ }
      _migrationLogged = true;
    }
    return {
      schemaVersion: CRON_SCHEMA_VERSION,
      updatedAt:     new Date().toISOString(),
      jobs:          (parsed as unknown[]).map(migrateJobToV2).filter((j): j is CronJobV2 => j !== null),
    };
  }
  // Anything else — empty registry.
  return {
    schemaVersion: CRON_SCHEMA_VERSION,
    updatedAt:     new Date().toISOString(),
    jobs:          [],
  };
}

/** Per-job migration. Adds default values for fields that didn't
 *  exist in v1. Drops malformed records (returns null). */
function migrateJobToV2(raw: unknown): CronJobV2 | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.action !== 'string') return null;

  // Detect kind if missing (pre-v4.1-cron legacy).
  let kind: CronKind = 'interval';
  if (typeof o.kind === 'string'
      && (o.kind === 'interval' || o.kind === 'cron' || o.kind === 'oneshot')) {
    kind = o.kind;
  } else if (typeof o.cronExpr === 'string') kind = 'cron';
  else if (typeof o.oneshotIso === 'string') kind = 'oneshot';

  // Discriminated state — derive from `enabled` when absent.
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : true;
  let state: CronJobV2['state'] = enabled ? 'scheduled' : 'paused';
  if (typeof o.state === 'string'
      && (o.state === 'scheduled' || o.state === 'paused'
       || o.state === 'completed' || o.state === 'error')) {
    state = o.state;
  }

  return {
    id:           String(o.id),
    description:  typeof o.description === 'string' ? o.description : '',
    schedule:     typeof o.schedule    === 'string' ? o.schedule    : '',
    kind,
    intervalMs:   typeof o.intervalMs  === 'number' ? o.intervalMs  : undefined,
    cronExpr:     typeof o.cronExpr    === 'string' ? o.cronExpr    : undefined,
    oneshotIso:   typeof o.oneshotIso  === 'string' ? o.oneshotIso  : undefined,
    action:       String(o.action),
    enabled,
    state,
    pausedAt:     typeof o.pausedAt     === 'string' ? o.pausedAt     : null,
    pausedReason: typeof o.pausedReason === 'string' ? o.pausedReason : null,
    createdAt:    typeof o.createdAt    === 'string' ? o.createdAt    : new Date().toISOString(),
    lastRun:      typeof o.lastRun      === 'string' ? o.lastRun      : undefined,
    lastResult:   typeof o.lastResult   === 'string' ? o.lastResult as CronJobV2['lastResult'] : undefined,
    lastOutput:   typeof o.lastOutput   === 'string' ? o.lastOutput   : undefined,
    lastError:    typeof o.lastError    === 'string' ? o.lastError    : null,
    lastDeliveryError: typeof o.lastDeliveryError === 'string' ? o.lastDeliveryError : null,
    nextRun:      typeof o.nextRun      === 'string' ? o.nextRun      : undefined,
    runCount:     typeof o.runCount     === 'number' ? o.runCount     : 0,
  };
}

/** v2-shaped envelope — make sure all jobs have the new fields with
 *  defaults. Catches the "user manually edited cron_jobs.json"
 *  case. */
function enrichV2(env: CronStateV2): CronStateV2 {
  return {
    schemaVersion: CRON_SCHEMA_VERSION,
    updatedAt:     env.updatedAt ?? new Date().toISOString(),
    jobs: (env.jobs ?? []).map((j) => ({
      ...j,
      state:             j.state ?? (j.enabled ? 'scheduled' : 'paused'),
      pausedAt:          j.pausedAt          ?? null,
      pausedReason:      j.pausedReason      ?? null,
      lastError:         j.lastError         ?? null,
      lastDeliveryError: j.lastDeliveryError ?? null,
    })),
  };
}

// ── Auto-repair / load ────────────────────────────────────────────────────

/** Read state from disk. Auto-migrates v1 → v2; auto-repairs on
 *  corrupt JSON. Returns an empty envelope when the file doesn't
 *  exist. NEVER throws — corrupt-state is ALWAYS recoverable. */
export async function readCronState(stateFile: string): Promise<CronStateV2> {
  let raw: string;
  try {
    raw = await fsp.readFile(stateFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        schemaVersion: CRON_SCHEMA_VERSION,
        updatedAt:     new Date().toISOString(),
        jobs:          [],
      };
    }
    // Permission / EBUSY — leave caller to handle, but do NOT lose state.
    throw err;
  }

  // Try strict parse.
  try {
    return migrateToV2(JSON.parse(raw));
  } catch { /* fall through to repair */ }

  // Auto-repair: strip trailing commas (most common bare-edit corruption).
  try {
    const stripped = raw
      .replace(/,(\s*[}\]])/g, '$1')   // trailing comma in object/array
      .replace(/^\s*\/\/.*$/gm, '');   // line comments (defensive)
    return migrateToV2(JSON.parse(stripped));
  } catch { /* fall through to bak-and-empty */ }

  // Last resort: rename the corrupt file aside, return empty.
  const bak = `${stateFile}.bak.${Date.now()}`;
  try { await fsp.rename(stateFile, bak); } catch { /* noop */ }
  try {
    process.stderr.write(
      `v4.1-cron: cron_jobs.json corrupt — moved to ${path.basename(bak)}, starting empty\n`,
    );
  } catch { /* noop */ }
  return {
    schemaVersion: CRON_SCHEMA_VERSION,
    updatedAt:     new Date().toISOString(),
    jobs:          [],
  };
}

/** Write state to disk via atomicWrite. Updates `updatedAt` to now. */
export async function writeCronState(
  stateFile: string,
  state: CronStateV2,
): Promise<void> {
  const next: CronStateV2 = {
    ...state,
    schemaVersion: CRON_SCHEMA_VERSION,
    updatedAt:     new Date().toISOString(),
  };
  await writeJsonAtomic(stateFile, next);
}

// ── Lock ─────────────────────────────────────────────────────────────────

export interface AcquireOptions {
  /** When true, fail fast if lock held; when false, retry once after
   *  100ms. User-driven API calls use false; heartbeat uses true. */
  failFast?: boolean;
}

export interface LockHandle {
  /** Release the lock. Idempotent — calling twice is safe. */
  release: () => Promise<void>;
}

/** Acquire the whole-cron-state lock. Returns null when contended
 *  (failFast) or after retry exhausted (non-failFast). NEVER
 *  throws — caller checks for null. */
export async function acquireCronLock(
  paths: CronPaths,
  opts: AcquireOptions = {},
): Promise<LockHandle | null> {
  // proper-lockfile requires the target to exist. Touch it.
  try {
    await fsp.mkdir(path.dirname(paths.stateFile), { recursive: true });
    if (!existsSync(paths.stateFile)) {
      await fsp.writeFile(
        paths.stateFile,
        JSON.stringify({
          schemaVersion: CRON_SCHEMA_VERSION,
          updatedAt:     new Date().toISOString(),
          jobs:          [],
        }, null, 2),
        { flag: 'wx', encoding: 'utf-8' },
      ).catch(() => undefined);
    }
  } catch { /* non-fatal */ }

  const lockOpts: Record<string, unknown> = {
    realpath:     true,
    stale:        20_000, // proper-lockfile default 10s; bump to 20s
    retries:      opts.failFast ? 0 : 1,
    lockfilePath: paths.lockFile,
  };

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(paths.stateFile, lockOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // proper-lockfile throws ELOCKED — that's a "skip" signal, not
    // an error. Other errors (permission, etc.) are silently NULLed
    // — caller checks for null and proceeds in degraded mode.
    if (!/lock(ed)?/i.test(msg)) {
      // Surface unusual failures via stderr but never crash.
      try {
        process.stderr.write(`v4.1-cron: lock acquire failed: ${msg}\n`);
      } catch { /* noop */ }
    }
    return null;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await release!();
      } catch { /* best effort; OS releases on process exit anyway */ }
    },
  };
}

/** Best-effort check: is the lock currently held? Used by /cron
 *  status diagnostics. Never throws. */
export async function isCronLockHeld(paths: CronPaths): Promise<boolean> {
  try {
    return await lockfile.check(paths.stateFile, {
      realpath:     true,
      lockfilePath: paths.lockFile,
    });
  } catch {
    return false;
  }
}

// ── Test hook ────────────────────────────────────────────────────────────

export function __resetMigrationLogForTests(): void {
  _migrationLogged = false;
}
