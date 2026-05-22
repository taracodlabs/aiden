/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/runs/stuckAttemptWatchdog.ts — v4.9.0 Slice 8.
 *
 * Sweeps `run_attempts` (and `spans`) that are stuck `running` from
 * a previous incarnation past `STUCK_THRESHOLD_MS`. Marks them
 * `crashed` so post-mortem queries get one consistent shape rather
 * than mixing "in-flight" with "abandoned".
 *
 * Wired as a `setInterval` ticker from bootstrap. Cadence default 5
 * min, configurable via `AIDEN_STUCK_ATTEMPT_CHECK_MS`. Threshold 30
 * min default, configurable via `AIDEN_STUCK_ATTEMPT_THRESHOLD_MS`.
 */

import type { Db } from '../db/connection';

export interface SweepResult {
  reclaimedAttempts: number;
  reclaimedSpans:    number;
  attemptIds:        string[];
  spanIds:           string[];
}

export interface SweepOptions {
  /** Identifier of the live current daemon process. Rows owned by it
   *  are NEVER touched. */
  currentIncarnationId: string;
  thresholdMs?:         number;   // default 30 min
  /** Test seam — clock injection. */
  now?:                 () => number;
}

const DEFAULT_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Run a single sweep pass. Returns the count + ids of rows touched.
 * Idempotent — calling twice in a row sweeps zero on the second call.
 */
export function sweepStuckAttempts(db: Db, opts: SweepOptions): SweepResult {
  const now         = (opts.now ?? Date.now)();
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const cutoffIso   = new Date(now - thresholdMs).toISOString();
  const endedAtIso  = new Date(now).toISOString();

  // ── attempts ────────────────────────────────────────────────────────────
  const attemptRows = db.prepare(
    `SELECT attempt_id FROM run_attempts
      WHERE status = 'running'
        AND incarnation_id != ?
        AND started_at < ?`,
  ).all(opts.currentIncarnationId, cutoffIso) as Array<{ attempt_id: string }>;
  const attemptIds = attemptRows.map((r) => r.attempt_id);
  if (attemptIds.length > 0) {
    db.prepare(
      `UPDATE run_attempts
          SET status        = 'crashed',
              ended_at      = COALESCE(ended_at, ?),
              finish_reason = COALESCE(finish_reason, 'stuck_attempt_swept')
        WHERE status = 'running'
          AND incarnation_id != ?
          AND started_at < ?`,
    ).run(endedAtIso, opts.currentIncarnationId, cutoffIso);
  }

  // ── spans ──────────────────────────────────────────────────────────────
  // Open spans (status NULL = in-flight) from a non-current incarnation.
  // We don't apply the threshold here — any open span owned by a dead
  // incarnation is by definition stuck; the parent process is gone.
  const spanRows = db.prepare(
    `SELECT span_id FROM spans
      WHERE status IS NULL
        AND ended_at IS NULL
        AND incarnation_id != ?`,
  ).all(opts.currentIncarnationId) as Array<{ span_id: string }>;
  const spanIds = spanRows.map((r) => r.span_id);
  if (spanIds.length > 0) {
    db.prepare(
      `UPDATE spans
          SET status        = 'cancelled',
              ended_at      = COALESCE(ended_at, ?),
              error_class   = COALESCE(error_class, 'OrphanedSpan'),
              error_message = COALESCE(error_message, 'incarnation died with span open')
        WHERE status IS NULL
          AND ended_at IS NULL
          AND incarnation_id != ?`,
    ).run(endedAtIso, opts.currentIncarnationId);
  }

  return {
    reclaimedAttempts: attemptIds.length,
    reclaimedSpans:    spanIds.length,
    attemptIds,
    spanIds,
  };
}
