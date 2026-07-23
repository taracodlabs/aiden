/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/runs/reclaim.ts — v4.9.0 Slice 3.
 *
 * Mark runs orphaned by a crashed daemon as `interrupted` so a follow-up
 * boot (or a human looking at `aiden runs list`) sees an unambiguous
 * post-mortem instead of an eternally-`running` row.
 *
 * Called from two sites:
 *  1. Process-wide crash handlers (`uncaughtException` /
 *     `unhandledRejection`) installed in `bootstrap.ts`. Before the
 *     handler calls `process.exit(1)`, it reclaims this incarnation's
 *     still-running rows. The DB connection is the same handle the
 *     dispatcher used; the write is one statement so even a crashed
 *     process can finish it.
 *  2. Boot-time, against ANY non-current instance — defence in depth
 *     for the case where `evaluateBootState` didn't sweep a row (e.g.
 *     the prior crash happened after BootState ran but before the
 *     run completed). Idempotent: a no-op when no rows match.
 *
 * Uses existing schema columns only — NO new tables, NO new RunStatus
 * value. Sets `status='interrupted', finish_reason='daemon_crashed',
 * resume_pending=1, resume_reason='daemon_crashed', completed_at=now`.
 * Matches the semantics `evaluateBootState` uses for prior-instance
 * crash recovery, so downstream consumers (`aiden runs list`, restart
 * resume logic) see one consistent shape.
 */

import type { Db } from '../db/connection';

export interface ReclaimResult {
  /** Number of run rows updated. */
  reclaimed: number;
  /** Ids of the affected rows, for log/event emission. */
  runIds:    number[];
}

export interface ReclaimOptions {
  /**
   * When set, only rows owned by this instance are reclaimed
   * (the crash-handler case). When omitted, every non-current
   * instance's running rows are reclaimed (the boot-time sweep).
   */
  instanceId?: string;
  /**
   * Identifies the still-live current instance; rows owned by this id
   * are NEVER touched by the boot-time sweep (we'd otherwise nuke our
   * own in-flight work). Required when `instanceId` is omitted.
   */
  currentInstanceId?: string;
  /** Test seam — clock injection. */
  now?: () => number;
}

/**
 * Reclaim stuck `runs.status='running'` rows. Returns the rows touched
 * so the caller can emit `run_events` entries (skipped on the crash
 * path — the inserts could themselves throw, and the UPDATE is the
 * authoritative outcome).
 */
export function reclaimStuckRuns(db: Db, opts: ReclaimOptions): ReclaimResult {
  const now = (opts.now ?? Date.now)();

  // Phase 1 — select the candidate rows. We pull ids first so the
  // caller can act on them (logging, event emission) without a second
  // round-trip. Using a single WHERE clause keeps the index hit on
  // idx_runs_active (`status IN ('queued','running')`).
  let candidates: Array<{ id: number }>;
  if (opts.instanceId !== undefined) {
    candidates = db.prepare(
      `SELECT id FROM runs
        WHERE status = 'running' AND instance_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.id = runs.task_id AND t.idempotency_namespace IS NOT NULL
          )`,
    ).all(opts.instanceId) as Array<{ id: number }>;
  } else {
    if (!opts.currentInstanceId) {
      throw new Error('reclaimStuckRuns: currentInstanceId required when instanceId omitted');
    }
    candidates = db.prepare(
      `SELECT id FROM runs
        WHERE status = 'running' AND instance_id != ?
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.id = runs.task_id AND t.idempotency_namespace IS NOT NULL
          )`,
    ).all(opts.currentInstanceId) as Array<{ id: number }>;
  }

  if (candidates.length === 0) {
    return { reclaimed: 0, runIds: [] };
  }

  // Phase 2 — single UPDATE for the matching predicate. We re-derive
  // the WHERE from `opts` rather than passing ids inline (would blow
  // past SQLite's bound-parameter cap on a pathologically large run
  // table — unlikely, but cheap to avoid).
  let updateResult;
  if (opts.instanceId !== undefined) {
    updateResult = db.prepare(
      `UPDATE runs
          SET status         = 'interrupted',
              finish_reason  = 'daemon_crashed',
              completed_at   = ?,
              resume_pending = 1,
              resume_reason  = 'daemon_crashed'
        WHERE status = 'running' AND instance_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.id = runs.task_id AND t.idempotency_namespace IS NOT NULL
          )`,
    ).run(now, opts.instanceId);
  } else {
    updateResult = db.prepare(
      `UPDATE runs
          SET status         = 'interrupted',
              finish_reason  = 'daemon_crashed',
              completed_at   = ?,
              resume_pending = 1,
              resume_reason  = 'daemon_crashed'
        WHERE status = 'running' AND instance_id != ?
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.id = runs.task_id AND t.idempotency_namespace IS NOT NULL
          )`,
    ).run(now, opts.currentInstanceId!);
  }

  return {
    reclaimed: Number(updateResult.changes ?? candidates.length),
    runIds:    candidates.map((c) => c.id),
  };
}
