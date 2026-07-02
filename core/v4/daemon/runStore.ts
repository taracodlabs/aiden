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
import type { EventVisibility, EventSource } from './eventCategories';

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
    // v4.13 Gap 4 — job-card linkage (NULL on rows predating v18).
    taskId:          (r as { task_id?: string | null }).task_id ?? null,
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
    /** v4.13 Gap 4 — link to the durable task row (the job-card). */
    taskId?:               string;
  }): number;
  setStatus(runId: number, status: RunStatus, opts?: {
    finishReason?: string;
    completedAt?:  number;
  }): void;
  markResumePending(runId: number, reason: string): void;
  /** v4.13 Gap 4 — runs awaiting the resume sweep. */
  listResumePending(): RunRow[];
  /**
   * v4.13 Gap 4 — resume lease: atomically clears resume_pending and
   * stamps the reason. Returns true for exactly ONE caller per run
   * (single-statement compare-and-clear) — double sweeps are no-ops.
   */
  claimResumePending(runId: number, reason: string): boolean;
  /**
   * Legacy emit — preserved for callers that don't yet pass rich tags.
   * Delegates to emitEventRich with category='legacy' so legacy and
   * new emissions share the same write path (truncation flag,
   * payload_bytes, seq computation are all uniform).
   */
  emitEvent(runId: number, kind: string, payload: Record<string, unknown>): void;
  /**
   * v4.10 Slice 10.2b — richer emission. Writes all fields the
   * trace_query consumer can filter on (category/kind/name,
   * tool_call_id, parent_event_id, status, duration_ms, summary).
   * Returns the generated row id so callers can chain parent_event_id
   * for follow-up rows. Payload over the inline cap (4096 bytes) is
   * sliced + payload_truncated flag set + original size recorded
   * in payload_bytes.
   */
  emitEventRich(opts: EmitEventOptions): number;
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
  /**
   * List events for a run, ordered by ts ascending. Returns the legacy
   * shape (ts/kind/payload) plus `name` so callers that previously
   * asserted on emitter-original identifiers (e.g. `dispatcher:invoked`)
   * still have a stable column once the kind taxonomy shifted to
   * dotted form (`dispatcher.invoked`) in v4.10 Slice 10.2b.
   */
  listEvents(runId: number, limit?: number): Array<{ ts: number; kind: string; name: string | null; payload: string }>;
  /**
   * v4.10 Slice 10.2b — scope-aware event query. Backs the expanded
   * trace_query tool + /trace recent slash. Returns rich rows
   * including category/kind/name/tool_call_id/payload_truncated.
   *
   * Filters compose with AND. The `scope` discriminator gates which
   * additional fields are required (run_id / session_id / hours).
   */
  listEventsScoped(opts: ListEventsScopedOptions): RunEventRich[];
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

/** v4.10 Slice 10.2b — rich emission options. */
export interface EmitEventOptions {
  runId:          number;
  category:       string;
  kind:           string;
  /** The original emission name (e.g. `ui_task_update`). Useful for
   *  exact-match queries that don't want to compute the kind. */
  name?:          string | null;
  /** Session id of the parent run. When omitted, the writer reads
   *  it from the runs table — passing it explicitly saves the JOIN
   *  on the hot path. */
  sessionId?:     string | null;
  /** Per-turn correlation id. NULL for events fired outside a turn
   *  (boot, dispatcher rejections). */
  turnId?:        string | null;
  /** Links this event to a specific tool_call (matches the
   *  `id` from the model's tool_call frame). */
  toolCallId?:    string | null;
  /** Link to a parent event (e.g. tool_call_completed → tool_call_started). */
  parentEventId?: number | null;
  /** Outcome marker — `ok`, `failed`, `blocked`, etc. Renderer-only. */
  status?:        string | null;
  /** Wall-clock duration of the action this event represents. */
  durationMs?:    number | null;
  /** One-line human summary. Surfaces in /trace recent without
   *  forcing the consumer to parse payload. */
  summary?:       string | null;
  /** Event-specific data. Inline-sliced at 4096 bytes; original
   *  byte count preserved via payload_bytes when truncated. */
  payload?:       Record<string, unknown> | null;
  /** Default 'model'. 'system' hides from model-facing trace_query
   *  but still surfaces to /trace recent. 'user' is reserved for
   *  future user-typed annotations. */
  visibility?:    EventVisibility;
  /** Free-form source label — 'repl' / 'daemon' / 'subagent' / 'mcp'. */
  source?:        EventSource | string | null;
}

/** v4.10 Slice 10.2b — rich row shape returned by listEventsScoped. */
export interface RunEventRich {
  id:               number;
  runId:            number;
  sessionId:        string | null;
  turnId:           string | null;
  seq:              number;
  ts:               number;
  category:         string;
  kind:             string;
  name:             string | null;
  toolCallId:       string | null;
  parentEventId:    number | null;
  status:           string | null;
  durationMs:       number | null;
  summary:          string | null;
  payload:          string;        // raw JSON string
  payloadTruncated: boolean;
  payloadBytes:     number | null;
  payloadRef:       string | null;
  visibility:       string;
  source:           string | null;
}

/** v4.10 Slice 10.2b — scoped query options. */
export type ListEventsScopedOptions =
  | {
      scope:        'current_run';
      runId:        number;
      category?:    string;
      kind?:        string;
      name?:        string;
      toolCallId?:  string;
      limit?:       number;
    }
  | {
      scope:        'current_session';
      sessionId:    string;
      category?:    string;
      kind?:        string;
      name?:        string;
      toolCallId?:  string;
      limit?:       number;
    }
  | {
      scope:        'run_id';
      runId:        number;
      category?:    string;
      kind?:        string;
      name?:        string;
      toolCallId?:  string;
      limit?:       number;
    }
  | {
      scope:        'session_id';
      sessionId:    string;
      category?:    string;
      kind?:        string;
      name?:        string;
      toolCallId?:  string;
      limit?:       number;
    }
  | {
      scope:        'last_hours';
      hours:        number;
      category?:    string;
      kind?:        string;
      name?:        string;
      toolCallId?:  string;
      limit?:       number;
    }
  | {
      scope:        'all';
      category?:    string;
      kind?:        string;
      name?:        string;
      toolCallId?:  string;
      limit?:       number;
    };

export interface CreateRunStoreOptions {
  db: Db;
}

export function createRunStore(opts: CreateRunStoreOptions): RunStore {
  const db = opts.db;

  // Shared write path for both legacy `emitEvent` and rich
  // `emitEventRich`. Extracted as a closure so destructured callers
  // (`const { emitEvent } = store; emitEvent(...)`) still hit the
  // same implementation — `this`-bound dispatch wouldn't survive
  // that pattern.
  const emitEventRichImpl = (eo: EmitEventOptions): number => {
    const now = Date.now();

    // session_id: prefer caller-supplied (saves a JOIN); fall back
    // to a lookup against runs. Null only if the run row vanished —
    // shouldn't happen for live runs, but we tolerate it for
    // legacy/orphan rows.
    let sessionId: string | null = eo.sessionId ?? null;
    if (sessionId === null) {
      const r = db.prepare(
        'SELECT session_id FROM runs WHERE id = ?',
      ).get(eo.runId) as { session_id: string | null } | undefined;
      sessionId = r?.session_id ?? null;
    }

    // seq: per-run monotonic counter. COALESCE handles the first
    // event for a run (no rows → MAX returns NULL → COALESCE to 0
    // → +1 = 1). Indexed by (run_id, seq) so this scales.
    const seqRow = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS m FROM run_events WHERE run_id = ?',
    ).get(eo.runId) as { m: number };
    const seq = seqRow.m + 1;

    // payload: serialise once, measure full size, then slice for
    // inline storage. The truncation flag + original size let
    // consumers know to fetch the full blob (future: payload_ref
    // → external store) when they need it. Null payload is
    // serialised as the literal "null" so the column stays NOT
    // NULL (the column constraint dates to v1 and can't be relaxed
    // via SQLite ALTER).
    const fullJson  = JSON.stringify(eo.payload ?? null);
    const fullBytes = Buffer.byteLength(fullJson, 'utf8');
    const truncated = fullBytes > 4096;
    const inline    = truncated ? fullJson.slice(0, 4096) : fullJson;

    const r = db.prepare(
      `INSERT INTO run_events (
         run_id, session_id, turn_id, seq, ts,
         category, kind, name,
         tool_call_id, parent_event_id,
         status, duration_ms, summary,
         payload, payload_truncated, payload_bytes, payload_ref,
         visibility, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eo.runId,
      sessionId,
      eo.turnId          ?? null,
      seq,
      now,
      eo.category,
      eo.kind,
      eo.name            ?? null,
      eo.toolCallId      ?? null,
      eo.parentEventId   ?? null,
      eo.status          ?? null,
      eo.durationMs      ?? null,
      eo.summary         ?? null,
      inline,
      truncated ? 1 : 0,
      truncated ? fullBytes : null,
      null,                                 // payload_ref — reserved for v4.11 external store
      eo.visibility      ?? 'model',
      (eo.source as string | null | undefined) ?? null,
    );
    return Number(r.lastInsertRowid);
  };

  return {
    create({ sessionId, instanceId, triggerEventId, status, startedAt, spawnedFromRunId, spawnedFromSessionId, taskId }) {
      const now = startedAt ?? Date.now();
      // v4.6 Phase 1 — explicit INSERT including the two sub-agent
      // lineage columns (NULL for top-level runs).
      // v4.13 Gap 4 — task_id links the run to its durable job-card so
      // the resume sweep revalidates from evidence, not prose.
      const r = db.prepare(
        `INSERT INTO runs
           (trigger_event_id, session_id, instance_id, status, started_at,
            resume_pending, spawned_from_run_id, spawned_from_session_id, task_id)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        triggerEventId ?? null,
        sessionId,
        instanceId,
        status ?? 'queued',
        now,
        spawnedFromRunId ?? null,
        spawnedFromSessionId ?? null,
        taskId ?? null,
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
    listResumePending() {
      const rows = db.prepare(
        `SELECT * FROM runs WHERE resume_pending = 1 ORDER BY started_at ASC`,
      ).all() as RunRowSql[];
      return rows.map(rowToTs);
    },
    claimResumePending(runId, reason) {
      // Single-statement compare-and-clear: exactly one caller wins.
      const info = db.prepare(
        `UPDATE runs SET resume_pending = 0, resume_reason = ?
          WHERE id = ? AND resume_pending = 1`,
      ).run(reason, runId);
      return info.changes === 1;
    },
    emitEvent(runId, kind, payload) {
      // Legacy path — preserve the pre-Slice-10.2b call shape by
      // routing through emitEventRich with category='legacy'. The
      // category tells trace consumers "this emission predates the
      // taxonomy"; a follow-up slice can migrate specific kinds into
      // proper categories once their emitters opt in.
      emitEventRichImpl({
        runId,
        category: 'legacy',
        kind,
        payload: payload ?? null,
      });
    },
    emitEventRich(eo) {
      return emitEventRichImpl(eo);
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
      // v4.10 Slice 10.2b — selects `name` alongside legacy columns
      // so callers asserting on the emitter-original event identifier
      // (e.g. 'dispatcher:invoked', 'tool_call_started') get a stable
      // column even though `kind` shifted to dotted form. Legacy rows
      // (pre-migration) have `name` IS NULL.
      const rows = db.prepare(
        `SELECT ts, kind, name, payload FROM run_events WHERE run_id = ? ORDER BY ts ASC LIMIT ?`,
      ).all(runId, Math.max(1, Math.min(limit, 5000))) as Array<{ ts: number; kind: string; name: string | null; payload: string }>;
      return rows;
    },
    listEventsScoped(qOpts) {
      // v4.10 Slice 10.2b — scope-aware rich event query. Builds the
      // WHERE clause from the discriminated scope + optional filters,
      // then maps the snake_case sqlite row into the camelCase
      // RunEventRich shape. All 6 scopes share the same SELECT list —
      // only the WHERE composition differs.
      const limit = Math.max(1, Math.min(qOpts.limit ?? 200, 5000));

      const where:  string[]                    = [];
      const params: Array<string | number>      = [];

      // Scope predicate — first because it's the most selective and
      // matches the index leading column (run_id, session_id, ts).
      switch (qOpts.scope) {
        case 'current_run':
        case 'run_id': {
          where.push('e.run_id = ?');
          params.push(qOpts.runId);
          break;
        }
        case 'current_session':
        case 'session_id': {
          where.push('e.session_id = ?');
          params.push(qOpts.sessionId);
          break;
        }
        case 'last_hours': {
          const cutoff = Date.now() - Math.max(0, qOpts.hours) * 3_600_000;
          where.push('e.ts >= ?');
          params.push(cutoff);
          break;
        }
        case 'all': {
          // No scope predicate — caller assumes the cost. The limit
          // still caps the result; combined with at least one of
          // category/kind/name it stays fast.
          break;
        }
      }

      // Optional shared filters.
      if (qOpts.category) {
        where.push('e.category = ?');
        params.push(qOpts.category);
      }
      if (qOpts.kind) {
        where.push('e.kind = ?');
        params.push(qOpts.kind);
      }
      if (qOpts.name) {
        where.push('e.name = ?');
        params.push(qOpts.name);
      }
      if (qOpts.toolCallId) {
        where.push('e.tool_call_id = ?');
        params.push(qOpts.toolCallId);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);

      const rows = db.prepare(
        `SELECT
            e.id                AS id,
            e.run_id             AS run_id,
            e.session_id         AS session_id,
            e.turn_id            AS turn_id,
            e.seq                AS seq,
            e.ts                 AS ts,
            e.category           AS category,
            e.kind               AS kind,
            e.name               AS name,
            e.tool_call_id       AS tool_call_id,
            e.parent_event_id    AS parent_event_id,
            e.status             AS status,
            e.duration_ms        AS duration_ms,
            e.summary            AS summary,
            e.payload            AS payload,
            e.payload_truncated  AS payload_truncated,
            e.payload_bytes      AS payload_bytes,
            e.payload_ref        AS payload_ref,
            e.visibility         AS visibility,
            e.source             AS source
           FROM run_events e
           ${whereSql}
           ORDER BY e.ts DESC, e.id DESC
           LIMIT ?`,
      ).all(...params) as Array<{
        id:                number;
        run_id:            number;
        session_id:        string | null;
        turn_id:           string | null;
        seq:               number;
        ts:                number;
        category:          string;
        kind:              string;
        name:              string | null;
        tool_call_id:      string | null;
        parent_event_id:   number | null;
        status:            string | null;
        duration_ms:       number | null;
        summary:           string | null;
        payload:           string;
        payload_truncated: number;
        payload_bytes:     number | null;
        payload_ref:       string | null;
        visibility:        string;
        source:            string | null;
      }>;

      return rows.map((r) => ({
        id:               r.id,
        runId:            r.run_id,
        sessionId:        r.session_id,
        turnId:           r.turn_id,
        seq:              r.seq,
        ts:               r.ts,
        category:         r.category,
        kind:             r.kind,
        name:             r.name,
        toolCallId:       r.tool_call_id,
        parentEventId:    r.parent_event_id,
        status:           r.status,
        durationMs:       r.duration_ms,
        summary:          r.summary,
        payload:          r.payload,
        payloadTruncated: r.payload_truncated === 1,
        payloadBytes:     r.payload_bytes,
        payloadRef:       r.payload_ref,
        visibility:       r.visibility,
        source:           r.source,
      }));
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
