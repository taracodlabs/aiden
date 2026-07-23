/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/cleanShutdown.ts — v4.5 Phase 1: clean-shutdown marker.
 *
 * Two-tier crash safety net (paired with `restartFailureCounter.ts`):
 *
 *   - Marker file `<daemonDir>/.clean_shutdown` — touched as the
 *     LAST step of a graceful drain. Empty file; the presence is
 *     the signal.
 *   - On boot: if the marker exists, consume + unlink it. Boot is
 *     "clean," meaning the previous instance exited gracefully and
 *     any active sessions can be considered for normal resume.
 *   - On boot: if the marker is ABSENT, scan `daemon_instances` for
 *     rows with `shutdown_at IS NULL` and stale `last_heartbeat`
 *     (default > 30s). Each such row is a crash candidate; we
 *     write a `crash_reports` entry, mark the row's
 *     `shutdown_reason='crash'`, and increment
 *     `restart_failure_counts` for every still-active session that
 *     was owned by the crashed instance.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Db } from './db/connection';
import type { BootDecision, ShutdownReason } from './types';

const CRASH_STALE_HEARTBEAT_MS = 30_000;

/** Touch the marker. Call from the final step of `drain()`. */
export function touchCleanShutdownMarker(markerPath: string): void {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const fd = fs.openSync(markerPath, 'w');
    fs.closeSync(fd);
  } catch { /* best-effort */ }
}

/** True when the marker file currently exists on disk. */
export function isCleanShutdown(markerPath: string): boolean {
  try { return fs.existsSync(markerPath); } catch { return false; }
}

/** Atomic "read + delete" of the marker. Returns true iff present. */
export function consumeCleanShutdownMarker(markerPath: string): boolean {
  if (!isCleanShutdown(markerPath)) return false;
  try { fs.unlinkSync(markerPath); } catch { /* best-effort */ }
  return true;
}

export interface EvaluateBootStateOptions {
  db:          Db;
  markerPath:  string;
  /** New instance id (the one currently booting). */
  instanceId:  string;
  /** Override "now" for tests. */
  now?:        number;
  /** Optional ps/wmic snapshot for crash_reports.ps_snapshot. */
  psSnapshot?: string | null;
  /** Tolerance for "stale heartbeat" detection. */
  staleHeartbeatMs?: number;
}

/**
 * Top-level boot-state evaluator. Returns the decision the caller
 * should act on, AND writes any required crash-report + instance-row
 * cleanup to the database.
 *
 * Idempotent: rerunning on the same boot is safe (the marker is
 * already consumed, and crashed rows already have `shutdown_at`
 * filled).
 */
export function evaluateBootState(
  opts: EvaluateBootStateOptions,
): BootDecision {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleHeartbeatMs ?? CRASH_STALE_HEARTBEAT_MS;

  // Marker check first — it's the fast happy path.
  if (consumeCleanShutdownMarker(opts.markerPath)) {
    return {
      cleanShutdown:         true,
      suspendActiveSessions: false,
      crashDetected:         false,
    };
  }

  // Find every prior instance that didn't mark shutdown_at and whose
  // heartbeat is stale enough to be considered crashed. The newly-
  // booted instance is excluded (instance_id mismatch).
  const cutoff = now - staleMs;
  const candidates = opts.db
    .prepare(
      `SELECT instance_id, pid, started_at, last_heartbeat
         FROM daemon_instances
        WHERE shutdown_at IS NULL
          AND instance_id != ?
          AND last_heartbeat < ?`,
    )
    .all(opts.instanceId, cutoff) as Array<{
      instance_id: string;
      pid: number;
      started_at: number;
      last_heartbeat: number;
    }>;

  if (candidates.length === 0) {
    // No marker AND no crashed siblings — could be the very first
    // boot OR a quick restart that didn't generate a stale row yet.
    // Treat as dirty boot to be safe (no active sessions to suspend
    // when the table is empty, so this is harmless on a fresh
    // install).
    return {
      cleanShutdown:         false,
      suspendActiveSessions: true,
      crashDetected:         false,
    };
  }

  const tx = opts.db.transaction((): void => {
    for (const c of candidates) {
      // Affected sessions: any run in 'queued' or 'running' status
      // owned by the crashed instance.
      const sessions = opts.db
        .prepare(
          `SELECT DISTINCT session_id
             FROM runs
            WHERE instance_id = ?
              AND status IN ('queued','running')`,
        )
        .all(c.instance_id) as Array<{ session_id: string }>;

      const sessionIds = sessions.map((s) => s.session_id);

      opts.db
        .prepare(
          `INSERT INTO crash_reports
             (instance_id, detected_at, prev_started_at,
              prev_last_heartbeat, prev_pid,
              affected_sessions, ps_snapshot, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          opts.instanceId,
          now,
          c.started_at,
          c.last_heartbeat,
          c.pid,
          JSON.stringify(sessionIds),
          opts.psSnapshot ?? null,
          JSON.stringify({
            dirty_shutdown: true,
            stuck_loop_sessions: sessionIds,
          }),
        );

      opts.db
        .prepare(
          `UPDATE daemon_instances
              SET shutdown_at     = COALESCE(shutdown_at, ?),
                  shutdown_reason = COALESCE(shutdown_reason, ?)
            WHERE instance_id = ?`,
        )
        .run(now, 'crash' satisfies ShutdownReason, c.instance_id);

      // Mark interrupted runs (they shouldn't appear "running" forever).
      opts.db
        .prepare(
          `UPDATE runs
              SET status         = 'interrupted',
                  resume_pending = 1,
                  resume_reason  = 'crash_recovery',
                  completed_at   = ?
            WHERE instance_id = ?
              AND status IN ('queued','running')
              AND NOT EXISTS (
                SELECT 1 FROM tasks t
                 WHERE t.id = runs.task_id AND t.idempotency_namespace IS NOT NULL
              )`,
        )
        .run(now, c.instance_id);
    }
  });
  tx();

  return {
    cleanShutdown:         false,
    suspendActiveSessions: true,
    crashDetected:         true,
  };
}
