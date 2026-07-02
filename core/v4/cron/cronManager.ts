/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/cron/cronManager.ts — Phase v4.1-cron
 *
 * Public scheduler API. Replaces the legacy `core/cronManager.ts`
 * with the same exported function names so existing callers
 * (cli/v4/commands/cron.ts) keep working.
 *
 * Architecture: state lives on disk (cron_jobs.json), in-memory
 * cache + timers are this module's singleton state, refreshed
 * by the heartbeat. All API calls acquire the file lock before
 * mutating state — multi-process safety.
 *
 * Public surface (preserved from legacy):
 *   - createJob(description, schedule, action) → CronJob
 *   - listJobs() → CronJob[]
 *   - getJob(id) → CronJob | undefined
 *   - pauseJob(id, reason?) → boolean
 *   - resumeJob(id) → boolean
 *   - deleteJob(id) → boolean
 *   - triggerJob(id) → Promise<boolean>
 *   - parseSchedule(input) → ScheduleSpec  (re-exported)
 *   - loadJobs() → void                    (idempotent boot)
 *   - awaitPendingSaves() → Promise<void>  (test/shutdown)
 *   - __resetForTests() → void
 *
 * New surface (additive):
 *   - getDiagnostics() → CronDiagnostics
 *   - startHeartbeat() / stopHeartbeat()
 */

import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';

import {
  parseSchedule,
  type ScheduleSpec,
} from './scheduleParser';
import {
  defaultCronPaths,
  acquireCronLock,
  readCronState,
  writeCronState,
  isCronLockHeld,
  migrateToV2,
  type CronJobV2,
  type CronStateV2,
  type CronPaths,
} from './cronState';
import {
  fireJob,
  computeNextFire,
  defaultRunAction,
  type RunActionFn,
} from './cronExecute';
import {
  startHeartbeat as startHeartbeatRaw,
  stopHeartbeat,
  isHeartbeatActive,
} from './cronTick';
import {
  AIDEN_CRON_BUILD,
  CRON_SCHEMA_VERSION,
  getDiagnosticsSnapshot,
  type CronDiagnostics,
} from './diagnostics';

// ── Re-exports for backwards compat ──────────────────────────────────────

export { parseSchedule } from './scheduleParser';
export type { ScheduleSpec } from './scheduleParser';
export { AIDEN_CRON_BUILD } from './diagnostics';
export type { CronDiagnostics, CronFireRecord } from './diagnostics';
export type { CronJobV2 as CronJob } from './cronState';

// ── State (in-memory cache + per-job timers) ─────────────────────────────

const _timers = new Map<string, NodeJS.Timeout>();
let _paths: CronPaths = defaultCronPaths();
let _runAction: RunActionFn = defaultRunAction;
let _bootedPid: number | null = null;

/** Override paths — for tests. Invalidates the cache + lazy-hydration
 *  guard: the old cache is a view of the OLD paths' state file. */
export function setCronPathsForTests(paths: CronPaths): void {
  _paths = paths;
  _cache = [];
  _cacheHydratedPid = null;
}

/** Override the action runner — for tests. */
export function setRunActionForTests(fn: RunActionFn): void {
  _runAction = fn;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function clearTimer(id: string): void {
  const h = _timers.get(id);
  if (h) {
    clearTimeout(h);
    _timers.delete(id);
  }
}

async function withLock<T>(fn: (state: CronStateV2) => Promise<T>): Promise<T> {
  const lock = await acquireCronLock(_paths, { failFast: false });
  if (!lock) {
    throw new Error('cron lock held by another process — try again');
  }
  try {
    const state = await readCronState(_paths.stateFile);
    return await fn(state);
  } finally {
    await lock.release();
  }
}

/** Re-arm a per-job setTimeout based on its current `nextRun`.
 *  Cancels any existing timer first. */
async function armJobTimer(job: CronJobV2): Promise<void> {
  clearTimer(job.id);
  if (!job.enabled || job.state === 'paused' || job.state === 'completed') return;
  const { next } = await computeNextFire(job);
  if (next === null) return;
  const delay = Math.max(0, next - Date.now());
  const handle = setTimeout(() => {
    _timers.delete(job.id);
    void fireJob({
      paths:     _paths,
      jobId:     job.id,
      runAction: _runAction,
    }).then(async () => {
      // After fire, re-arm based on the freshly persisted state.
      const refreshed = await readCronState(_paths.stateFile);
      const fresh = refreshed.jobs.find((j) => j.id === job.id);
      if (fresh) await armJobTimer(fresh);
    }).catch(() => undefined);
  }, delay);
  if (typeof handle.unref === 'function') handle.unref();
  _timers.set(job.id, handle);
}

function genId(state: CronStateV2): string {
  let max = 0;
  for (const j of state.jobs) {
    const n = Number.parseInt(j.id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

// ── In-memory cache (sync read fallback for legacy callers) ─────────────

/** Cache of last-read jobs. Refreshed by every async-public-API call
 *  + the heartbeat. Sync wrappers below read from this — accepting
 *  brief staleness in exchange for source-compat with v3 callers. */
let _cache: CronJobV2[] = [];

/** v4.12.1 — pid that last hydrated the cache (lazy-hydration guard).
 *  Null = never hydrated in this process. */
let _cacheHydratedPid: number | null = null;

function refreshCacheFromState(state: CronStateV2): void {
  _cache = state.jobs;
  // Any authoritative refresh (loadJobs / async API / heartbeat) also
  // satisfies the lazy-hydration guard below.
  _cacheHydratedPid = process.pid;
}

/**
 * v4.12.1 — lazy self-hydration for the sync cache.
 *
 * Historically the cache was only populated by `loadJobs()` (boot) or an
 * async API call — but NO production entry point actually called either
 * before the sync surface, so `aiden cron list` (and getJob / createJob /
 * pauseJob / resumeJob / deleteJob) ran against a permanently-empty cache:
 * list showed "No cron jobs." with valid jobs on disk, mutations no-op'd
 * with "not found", and createJob could mint a colliding id. Rather than
 * hydrate one symptomatic call site (leaving the same trap for every
 * future caller), EVERY sync accessor now self-hydrates on first touch:
 * idempotent per process, synchronous disk read, cache-only — it never
 * arms timers (scheduling stays with loadJobs/heartbeat, so a one-shot
 * CLI can't start firing jobs) and never mutates disk (the async reader
 * owns corrupt-file bak-and-empty recovery; this mirror just falls back
 * to empty). Unlocked read is safe: writers use atomic tmp+rename.
 */
function ensureCacheHydratedSync(): void {
  if (_cacheHydratedPid === process.pid) return;
  _cacheHydratedPid = process.pid;
  let raw: string;
  try {
    raw = readFileSync(_paths.stateFile, 'utf-8');
  } catch {
    return;  // missing/unreadable — keep empty (matches readCronState ENOENT)
  }
  try {
    _cache = migrateToV2(JSON.parse(raw)).jobs;
    return;
  } catch { /* try the same trailing-comma repair the async reader uses */ }
  try {
    const stripped = raw
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/^\s*\/\/.*$/gm, '');
    _cache = migrateToV2(JSON.parse(stripped)).jobs;
  } catch { /* unrecoverable — stay empty; async path will bak-and-empty */ }
}

// ── Public API ───────────────────────────────────────────────────────────

/** Idempotent boot — call once at runtime startup. Loads state +
 *  arms timers for every enabled job. Safe to call multiple times
 *  (re-arms cleanly). */
export async function loadJobs(): Promise<void> {
  if (_bootedPid === process.pid) return;
  _bootedPid = process.pid;
  const lock = await acquireCronLock(_paths, { failFast: false });
  let state: CronStateV2;
  if (lock) {
    try {
      state = await readCronState(_paths.stateFile);
    } finally {
      await lock.release();
    }
  } else {
    // Lock held — best-effort read without lock. Persisters use
    // atomicWrite so the read always sees a consistent file.
    state = await readCronState(_paths.stateFile);
  }
  refreshCacheFromState(state);
  for (const job of state.jobs) {
    void armJobTimer(job);
  }
}

/** SYNC list — reads from the in-memory cache. v4.12.1: self-hydrates
 *  from disk on first access (see ensureCacheHydratedSync), so callers
 *  need no prior loadJobs/async call. Backward-compat for legacy
 *  callers (cli/v4/commands/cron.ts, core/toolRegistry.ts). For
 *  up-to-the-millisecond accuracy use `listJobsAsync()`. */
export function listJobs(): CronJobV2[] {
  ensureCacheHydratedSync();
  return [..._cache];
}

/** Async list — re-reads under lock. Preferred for new code. */
export async function listJobsAsync(): Promise<CronJobV2[]> {
  const lock = await acquireCronLock(_paths, { failFast: false });
  let state: CronStateV2;
  if (lock) {
    try { state = await readCronState(_paths.stateFile); }
    finally { await lock.release(); }
  } else {
    state = await readCronState(_paths.stateFile);
  }
  refreshCacheFromState(state);
  return state.jobs;
}

/** SYNC accessor — uses cache (self-hydrating, v4.12.1). */
export function getJob(id: string): CronJobV2 | undefined {
  ensureCacheHydratedSync();
  return _cache.find((j) => j.id === id);
}

export async function getJobAsync(id: string): Promise<CronJobV2 | undefined> {
  const jobs = await listJobsAsync();
  return jobs.find((j) => j.id === id);
}

/** SYNC create — returns the job object immediately. Persistence
 *  happens in the background via `withLock`; legacy callers that
 *  expected sync semantics keep working. The cache reflects the
 *  new job before this returns. */
export function createJob(
  description: string,
  schedule: string,
  action: string,
): CronJobV2 {
  const spec = parseSchedule(schedule);
  // v4.12.1 — hydrate BEFORE minting the id. An unhydrated (empty) cache
  // previously minted "1" over existing on-disk jobs; the background
  // withLock then found the id taken and silently dropped the new job.
  ensureCacheHydratedSync();
  // Compute id from in-memory cache.
  let max = 0;
  for (const j of _cache) {
    const n = Number.parseInt(j.id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const id = String(max + 1);
  const createdAt = new Date().toISOString();
  const job: CronJobV2 = {
    id,
    description,
    schedule:    spec.display,
    kind:        spec.kind,
    action,
    enabled:     true,
    state:       'scheduled',
    pausedAt:    null,
    pausedReason: null,
    createdAt,
    lastError:   null,
    lastDeliveryError: null,
    runCount:    0,
    ...attachKindFields(spec),
  };
  // Update cache immediately — getJob right after createJob sees it.
  _cache = [..._cache, job];
  // Persist + arm timer in background.
  void (async () => {
    try {
      await withLock(async (state) => {
        // Re-genId in case another process added a job between now
        // and the lock acquisition.
        const idx = state.jobs.findIndex((j) => j.id === job.id);
        if (idx === -1) state.jobs.push(job);
        const { next } = await computeNextFire(job);
        if (next !== null) job.nextRun = new Date(next).toISOString();
        await writeCronState(_paths.stateFile, state);
      });
      void armJobTimer(job);
    } catch { /* persistence error — surface via logger only */ }
  })();
  return job;
}

/** Async variant — awaitable. */
export async function createJobAsync(
  description: string,
  schedule: string,
  action: string,
): Promise<CronJobV2> {
  const spec = parseSchedule(schedule);
  return withLock(async (state) => {
    const id = genId(state);
    const createdAt = new Date().toISOString();
    const job: CronJobV2 = {
      id,
      description,
      schedule:    spec.display,
      kind:        spec.kind,
      action,
      enabled:     true,
      state:       'scheduled',
      pausedAt:    null,
      pausedReason: null,
      createdAt,
      lastError:   null,
      lastDeliveryError: null,
      runCount:    0,
      ...attachKindFields(spec),
    };
    const { next } = await computeNextFire(job);
    if (next !== null) job.nextRun = new Date(next).toISOString();
    state.jobs.push(job);
    refreshCacheFromState(state);
    await writeCronState(_paths.stateFile, state);
    void armJobTimer(job);
    return job;
  });
}

function attachKindFields(spec: ScheduleSpec): Partial<CronJobV2> {
  if (spec.kind === 'interval') return { intervalMs: spec.intervalMs };
  if (spec.kind === 'cron')     return { cronExpr:   spec.cronExpr };
  return                              { oneshotIso: spec.runAtIso };
}

/** SYNC pause — updates cache immediately, persists in background.
 *  `reason` is the new optional second arg added by v4.1-cron
 *  (legacy callers passing one arg still work). */
export function pauseJob(id: string, reason?: string): boolean {
  ensureCacheHydratedSync();
  const idx = _cache.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  const job = { ..._cache[idx]! };
  job.enabled      = false;
  job.state        = 'paused';
  job.pausedAt     = new Date().toISOString();
  job.pausedReason = reason ?? null;
  _cache = [..._cache];
  _cache[idx] = job;
  clearTimer(id);
  void (async () => {
    try {
      await withLock(async (state) => {
        const sIdx = state.jobs.findIndex((j) => j.id === id);
        if (sIdx === -1) return;
        state.jobs[sIdx] = job;
        await writeCronState(_paths.stateFile, state);
      });
    } catch { /* surfaced via logger only */ }
  })();
  return true;
}

/** SYNC resume — recomputes nextRun from now. Hard-learned: don't
 *  carry forward stale next_run after a long pause. */
export function resumeJob(id: string): boolean {
  ensureCacheHydratedSync();
  const idx = _cache.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  const job = { ..._cache[idx]! };
  job.enabled      = true;
  job.state        = 'scheduled';
  job.pausedAt     = null;
  job.pausedReason = null;
  _cache = [..._cache];
  _cache[idx] = job;
  void (async () => {
    try {
      const { next } = await computeNextFire(job);
      if (next !== null) job.nextRun = new Date(next).toISOString();
      _cache[idx] = job;
      await withLock(async (state) => {
        const sIdx = state.jobs.findIndex((j) => j.id === id);
        if (sIdx !== -1) {
          state.jobs[sIdx] = job;
          await writeCronState(_paths.stateFile, state);
        }
      });
      await armJobTimer(job);
    } catch { /* surfaced via logger only */ }
  })();
  return true;
}

/** SYNC delete — removes from cache + clears timer immediately,
 *  persists in background. */
export function deleteJob(id: string): boolean {
  ensureCacheHydratedSync();
  const idx = _cache.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  _cache = _cache.filter((j) => j.id !== id);
  clearTimer(id);
  void (async () => {
    try {
      await withLock(async (state) => {
        const sIdx = state.jobs.findIndex((j) => j.id === id);
        if (sIdx !== -1) {
          state.jobs.splice(sIdx, 1);
          await writeCronState(_paths.stateFile, state);
        }
      });
    } catch { /* surfaced via logger only */ }
  })();
  return true;
}

// ── Async mutation variants (awaited persistence) ────────────────────────
//
// v4.12.1 — the sync mutators above persist in a fire-and-forget
// background IIFE, which is fine in a long-lived REPL but LOSES the write
// when a one-shot CLI process exits right after the call (the lazy-
// hydration fix made CLI mutations reachable and exposed this: `aiden
// cron remove` printed success while the job survived on disk). The CLI
// handlers await these variants instead; each mutates under the file
// lock, persists BEFORE resolving, and refreshes the cache.

/** Awaited pause — persisted before resolve. */
export async function pauseJobAsync(id: string, reason?: string): Promise<boolean> {
  return withLock(async (state) => {
    const idx = state.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    const job = { ...state.jobs[idx]! };
    job.enabled      = false;
    job.state        = 'paused';
    job.pausedAt     = new Date().toISOString();
    job.pausedReason = reason ?? null;
    state.jobs[idx] = job;
    clearTimer(id);
    refreshCacheFromState(state);
    await writeCronState(_paths.stateFile, state);
    return true;
  });
}

/** Awaited resume — recomputes nextRun, persisted before resolve. */
export async function resumeJobAsync(id: string): Promise<boolean> {
  return withLock(async (state) => {
    const idx = state.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    const job = { ...state.jobs[idx]! };
    job.enabled      = true;
    job.state        = 'scheduled';
    job.pausedAt     = null;
    job.pausedReason = null;
    const { next } = await computeNextFire(job);
    if (next !== null) job.nextRun = new Date(next).toISOString();
    state.jobs[idx] = job;
    refreshCacheFromState(state);
    await writeCronState(_paths.stateFile, state);
    void armJobTimer(job);
    return true;
  });
}

/** Awaited delete — persisted before resolve. */
export async function deleteJobAsync(id: string): Promise<boolean> {
  return withLock(async (state) => {
    const idx = state.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    state.jobs.splice(idx, 1);
    clearTimer(id);
    refreshCacheFromState(state);
    await writeCronState(_paths.stateFile, state);
    return true;
  });
}

export async function triggerJob(id: string): Promise<boolean> {
  // A trigger fires NOW, then the post-fire armJobTimer re-schedules.
  const exists = await getJob(id);
  if (!exists) return false;
  clearTimer(id);
  await fireJob({
    paths:     _paths,
    jobId:     id,
    runAction: _runAction,
  });
  const refreshed = await getJob(id);
  if (refreshed && refreshed.enabled && refreshed.state === 'scheduled') {
    await armJobTimer(refreshed);
  }
  return true;
}

// ── Diagnostics + heartbeat ──────────────────────────────────────────────

export async function getDiagnostics(): Promise<CronDiagnostics> {
  const lockHeld = await isCronLockHeld(_paths);
  return getDiagnosticsSnapshot({
    lockPath:      _paths.lockFile,
    lockHeld,
    schemaVersion: CRON_SCHEMA_VERSION,
  });
}

export async function getStateSnapshot(): Promise<CronStateV2> {
  return readCronState(_paths.stateFile);
}

/** Start the heartbeat singleton with a default onTick that
 *  re-arms changed timers. Idempotent. */
export function startHeartbeat(): void {
  startHeartbeatRaw({
    paths: _paths,
    onTick: async (jobs) => {
      for (const j of jobs) {
        const armed = _timers.has(j.id);
        const shouldArm = j.enabled
          && j.state !== 'paused'
          && j.state !== 'completed';
        if (shouldArm && !armed) {
          await armJobTimer(j);
        } else if (!shouldArm && armed) {
          clearTimer(j.id);
        }
      }
      // Drop timers for deleted jobs.
      const live = new Set(jobs.map((j) => j.id));
      for (const id of [..._timers.keys()]) {
        if (!live.has(id)) clearTimer(id);
      }
    },
  });
}

export { stopHeartbeat, isHeartbeatActive };

// ── Drain hook ───────────────────────────────────────────────────────────

/** Test/shutdown drain. */
export async function awaitPendingSaves(): Promise<void> {
  const { awaitAllPending } = await import('./atomicWrite');
  await awaitAllPending();
}

// ── Test reset ───────────────────────────────────────────────────────────

export function __resetForTests(): void {
  for (const id of [..._timers.keys()]) clearTimer(id);
  _bootedPid = null;
  _paths = defaultCronPaths();
  _runAction = defaultRunAction;
  _cache = [];
  _cacheHydratedPid = null;
  stopHeartbeat();
}

// Used by test bench to exercise the full path under a temp dir.
export function __testPaths(rootDir: string): CronPaths {
  return {
    stateFile: path.join(rootDir, 'cron_jobs.json'),
    lockFile:  path.join(rootDir, 'cron_jobs.json.lock'),
    logsDir:   path.join(rootDir, 'cron-logs'),
  };
}

void os; // import retained for future homedir-relative APIs
