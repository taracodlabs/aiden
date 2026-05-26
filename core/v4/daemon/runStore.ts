/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/runStore.ts — v4.5 Phase 1: runs + run_events writers.
 *
 * Daemon-fired runs are persisted in `runs` (one row per turn) with
 * a stream of `run_events` rows for per-event detail (tool calls,
 * verifications, classifications, recovery actions, log lines).
 *
 * CLI-fired turns continue using in-memory trace structures — zero
 * overhead for interactive use. The daemon path opts in by creating
 * a run row + emitting events.
 */

import type { Db } from './db/connection';
import type { RunRow, RunStatus } from './types';
import type { RunRowSql, RunEventRowSql } from './db/schema/v1.spec';

function rowToTs(r: RunRowSql): RunRow {
  return {
    id:              r.id,
    triggerEventId:  r.trigger_event_id,
    sessionId:       r.session_id,
    instanceId:      r.instance_id,
    status:          r.status as RunStatus,
    finishReason:    r.finish_reason,
    startedAt:       r.started_at,
    completedAt:     r.completed_at,
    resumePending:   r.resume_pending === 1,
    resumeReason:    r.resume_reason,
  };
}

export interface RunStore {
  create(opts: {
    sessionId:        string;
    instanceId:       string;
    triggerEventId?:  number;
    status?:          RunStatus;
    startedAt?:       number;
    /**
     * v4.6 Phase 1 — when this run is a sub-agent spawned by another
     * run, set both lineage fields. NULL for top-level runs (REPL
     * turns, daemon-fired turns). Wired into the `runs` table by the
     * v6 schema migration; older rows have NULL values silently.
     */
    spawnedFromRunId?:     number;
    spawnedFromSessionId?: string;
  }): number;
  setStatus(runId: number, status: RunStatus, opts?: {
    finishReason?: string;
    completedAt?:  number;
  }): void;
  markResumePending(runId: number, reason: string): void;
  emitEvent(runId: number, kind: string, payload: Record<string, unknown>): void;
  listActive(): RunRow[];
  get(runId: number): RunRow | null;
  /** Diagnostic — event count for a run. */
  countEvents(runId: number): number;
  /**
   * v4.5 Phase 6 — recent runs with optional filters. Backs the
   * `aiden runs list` CLI surface.
   *
   * Filters are additive; omitting any returns the unfiltered slice.
   * `source` joins to trigger_events to filter by trigger source
   * (file / webhook / email / schedule / manual).
   */
  listRecent(opts?: {
    limit?:    number;          // default 50
    status?:   RunStatus;
    source?:   string;          // trigger_events.source filter
    sessionIdPrefix?: string;   // useful for `aiden trigger runs <id>`
    /**
     * v4.6 Phase 2Q-B — when true (default), the list HIDES sub-agent
     * children (rows with non-NULL `spawned_from_run_id`). Set to
     * false to return a flat list (parents + children intermixed),
     * matching the legacy pre-2Q-B behaviour. The CLI surface
     * exposes this via `aiden runs list --include-children`.
     */
    topLevelOnly?: boolean;
  }): RunRow[];
  /**
   * v4.6 Phase 2Q-B — child-count aggregate for a parent run row.
   * Returns `{ total, completed }` for all rows whose
   * `spawned_from_run_id` matches `parentRunId`. Backs the badge
   * "(N children, M OK)" rendered next to top-level rows in
   * `aiden runs list`. Top-level rows with zero children get
   * `{ total: 0, completed: 0 }` — the CLI omits the badge in that
   * case.
   */
  countChildren(parentRunId: number): { total: number; completed: number };
  /** List events for a run, ordered by ts ascending. */
  listEvents(runId: number, limit?: number): Array<{ ts: number; kind: string; payload: string }>;
  /**
   * v4.10 Slice 10.2 — list events for an entire REPL session, optionally
   * filtered by event kind. Backs `trace_query` + `/trace recent`.
   *
   * Returns descending by ts (newest first) — the typical "what just
   * happened" query shape. Each row carries the parent `run_id` so
   * callers can correlate turn boundaries.
   *
   * Cross-session queries are NOT supported in this slice (Phase B Q2:
   * deferred to v4.11). `sessionId` is required.
   */
  listEventsForSession(opts: {
    sessionId: string;
    /** Filter by event kind substring (e.g. `'ui_'` for all UI events). */
    kindPrefix?: string;
    /** Only events at or after this epoch ms. */
    sinceMs?: number;
    /** Cap rows (default 100, max 5000). */
    limit?: number;
  }): Array<{ runId: number; ts: number; kind: string; payload: string }>;
}

export interface CreateRunStoreOptions {
  db: Db;
}

export function createRunStore(opts: CreateRunStoreOptions): RunStore {
  const db = opts.db;
  return {
    create({ sessionId, instanceId, triggerEventId, status, startedAt, spawnedFromRunId, spawnedFromSessionId }) {
      const now = startedAt ?? Date.now();
      // v4.6 Phase 1 — explicit 8-column INSERT including the two
      // sub-agent lineage columns. Top-level runs pass NULL for both;
      // sub-agent runs pass the parent run_id + session_id. Single
      // insert path keeps the code simple at the cost of two extra
      // bound NULLs on the common (top-level) case.
      const r = db.prepare(
        `INSERT INTO runs
           (trigger_event_id, session_id, instance_id, status, started_at,
            resume_pending, spawned_from_run_id, spawned_from_session_id)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        triggerEventId ?? null,
        sessionId,
        instanceId,
        status ?? 'queued',
        now,
        spawnedFromRunId ?? null,
        spawnedFromSessionId ?? null,
      );
      return Number(r.lastInsertRowid);
    },
    setStatus(runId, status, opts2 = {}) {
      const completedAt = opts2.completedAt
        ?? (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
            ? Date.now()
            : null);
      db.prepare(
        `UPDATE runs
            SET status        = ?,
                finish_reason = COALESCE(?, finish_reason),
                completed_at  = COALESCE(?, completed_at)
          WHERE id = ?`,
      ).run(status, opts2.finishReason ?? null, completedAt, runId);
    },
    markResumePending(runId, reason) {
      db.prepare(
        `UPDATE runs SET resume_pending = 1, resume_reason = ? WHERE id = ?`,
      ).run(reason, runId);
    },
    emitEvent(runId, kind, payload) {
      const json = JSON.stringify(payload).slice(0, 4096);
      db.prepare(
        `INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)`,
      ).run(runId, Date.now(), kind, json);
    },
    listActive(): RunRow[] {
      const rows = db
        .prepare(`SELECT * FROM runs WHERE status IN ('queued','running')`)
        .all() as RunRowSql[];
      return rows.map(rowToTs);
    },
    get(runId): RunRow | null {
      const r = db
        .prepare('SELECT * FROM runs WHERE id = ?')
        .get(runId) as RunRowSql | undefined;
      return r ? rowToTs(r) : null;
    },
    countEvents(runId) {
      const r = db
        .prepare('SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?')
        .get(runId) as { c: number };
      return r.c;
    },
    listRecent(opts2 = {}) {
      const limit = Math.max(1, Math.min(opts2.limit ?? 50, 1000));
      const whereParts: string[] = [];
      const params: Array<string | number> = [];
      if (opts2.status) {
        whereParts.push('r.status = ?');
        params.push(opts2.status);
      }
      if (opts2.source) {
        whereParts.push('te.source = ?');
        params.push(opts2.source);
      }
      if (opts2.sessionIdPrefix) {
        whereParts.push('r.session_id LIKE ?');
        params.push(`${opts2.sessionIdPrefix}%`);
      }
      // v4.6 Phase 2Q-B — default to top-level rows only. Children
      // (rows with non-NULL `spawned_from_run_id`) clutter the list
      // when you really want "what user-triggered runs happened
      // recently". The partial index `idx_runs_spawned_from` makes
      // the negated predicate cheap (children indexed; parents NOT
      // indexed but the predicate is `IS NULL` — table scan, but
      // the planner uses the limit + ORDER BY started_at to cap
      // work). `--include-children` flips the flag for flat view.
      if (opts2.topLevelOnly !== false) {
        whereParts.push('r.spawned_from_run_id IS NULL');
      }
      const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
      const sql = `
        SELECT r.* FROM runs r
        LEFT JOIN trigger_events te ON r.trigger_event_id = te.id
        ${where}
        ORDER BY r.started_at DESC
        LIMIT ?`;
      params.push(limit);
      const rows = db.prepare(sql).all(...params) as RunRowSql[];
      return rows.map(rowToTs);
    },
    countChildren(parentRunId) {
      // Single round-trip via conditional COUNT — sqlite handles
      // this fine even with a few thousand children per parent,
      // which we'll never see in practice (fanout caps at 5).
      const r = db.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM runs
        WHERE spawned_from_run_id = ?`,
      ).get(parentRunId) as { total: number; completed: number | null };
      return {
        total:     r.total,
        completed: r.completed ?? 0,
      };
    },
    listEvents(runId, limit = 200) {
      const rows = db.prepare(
        `SELECT ts, kind, payload FROM run_events WHERE run_id = ? ORDER BY ts ASC LIMIT ?`,
      ).all(runId, Math.max(1, Math.min(limit, 5000))) as Array<{ ts: number; kind: string; payload: string }>;
      return rows;
    },
    listEventsForSession(opts) {
      // v4.10 Slice 10.2 — session-scoped event query for trace_query +
      // /trace recent. Joins run_events to runs on run_id so we can
      // filter by session_id without exposing a denormalized column.
      // Newest-first (DESC) matches the "what just happened" usage.
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 5000));
      const params: Array<string | number> = [opts.sessionId];
      let where = 'r.session_id = ?';
      if (typeof opts.sinceMs === 'number') {
        where += ' AND e.ts >= ?';
        params.push(opts.sinceMs);
      }
      if (typeof opts.kindPrefix === 'string' && opts.kindPrefix.length > 0) {
        where += ' AND e.kind LIKE ?';
        params.push(`${opts.kindPrefix}%`);
      }
      params.push(limit);
      const rows = db.prepare(
        `SELECT e.run_id AS run_id, e.ts AS ts, e.kind AS kind, e.payload AS payload
           FROM run_events e
           JOIN runs r ON r.id = e.run_id
          WHERE ${where}
          ORDER BY e.ts DESC
          LIMIT ?`,
      ).all(...params) as Array<{ run_id: number; ts: number; kind: string; payload: string }>;
      return rows.map((r) => ({
        runId:   r.run_id,
        ts:      r.ts,
        kind:    r.kind,
        payload: r.payload,
      }));
    },
  };
}
