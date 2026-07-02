/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/taskStore.ts — v4.10 Slice 10.8.
 *
 * Durable Task-lite kernel. Sits ABOVE the per-turn `runs` table:
 * one Task can span many turns via the `traceIds` array, which
 * back-references `run_events.id` from Slice 10.2b. Designed to be
 * lighter than the full-Task-kernel pattern (claim_lock, worker_pid,
 * heartbeat fields, separate task_runs ledger) that a multi-worker
 * daemon path would need — REPL is single-process so those
 * coordination fields are deliberately absent. v4.11 daemon-path
 * slice can add them if/when worker isolation becomes a real need.
 *
 * Factory pattern matches `createRunStore` (same daemon.db handle,
 * same idiom). Migration v14 owns the table; this module owns the
 * read/write surface.
 *
 * Status lifecycle:
 *
 *   pending  →  active  →  completed
 *                       →  failed
 *                       →  cancelled
 *                       →  interrupted
 *
 * `pending` is in the enum for v4.11 forward-compat (daemon may
 * legitimately queue tasks); REPL skips it and starts at `active`.
 *
 * `interrupted` (v4.11 Slice 0) is a terminal status applied by the
 * boot-time orphan sweep: a REPL that crashes mid-turn never fires the
 * completed/failed transition, leaving its row stuck at `active`
 * forever. On the next REPL boot, `sweepOrphaned` retires those
 * pre-boot `active` rows so `/tasks` doesn't accrue phantom in-flight
 * tasks from dead sessions. Mirrors the `reclaimStuckRuns` precedent
 * (core/v4/daemon/runs/reclaim.ts) which does the same for `runs`.
 *
 * Persistence policy: every write is best-effort. The caller wraps
 * in try/catch so a locked DB / schema drift never crashes the
 * REPL — same discipline as runStore.emitEventRich. Observability
 * must not break dispatch.
 */

import type { Db } from './db/connection';
import type {
  TaskEvidence,
  SideEffectRecord,
  TaskFailureState,
} from '../taskVerification';

/**
 * v4.13 Gap 1 adds the verify-before-done states:
 *
 *   active → pending_verification → completed             (evidence-backed)
 *                                 → completed_unverified  (honest downgrade)
 *                                 → verification_failed   (claimed, no evidence)
 *
 * `pending_verification` is transitional — entered when the turn finishes
 * with a clean `stop`, exited microseconds later by the verdict policy.
 * Its value is crash-honesty: a process death mid-verification leaves the
 * row saying "not yet verified" instead of a lying `completed`, and the
 * boot orphan sweep retires it like a stranded `active`.
 */
export type TaskStatus =
  | 'pending' | 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  | 'pending_verification' | 'completed_unverified' | 'verification_failed'
  // v4.13 Gap 4 — resume verdict terminals: the sweep parked the task on a
  // specific user question (blocked_needs_user) or gave up honestly after
  // the wake-loop cap / an unrecoverable world (abandoned).
  | 'blocked_needs_user' | 'abandoned';

export interface Task {
  id:           string;
  title:        string;
  goal:         string;
  status:       TaskStatus;
  createdAt:    number;
  updatedAt:    number;
  channelId:    string | null;
  sessionId:    string;
  parentTaskId: string | null;
  traceIds:     number[];
  artifactIds:  string[];
  /** v4.13 Gap 1 — verification envelope (null pre-gate / non-stop finishes). */
  evidence:     TaskEvidence | null;
  // ── v4.13 Gap 3 — the job-card ─────────────────────────────────────
  /** User-stated limits at creation. No producer today — the seam. */
  constraints:  Record<string, unknown> | null;
  /** Deduped paths from mutating, verifier-evidenced executions. */
  filesTouched: string[];
  /** Mutating executions beyond files ({tool, target, verified, evidence?}). */
  sideEffects:  SideEffectRecord[];
  /** Last structured give-up / verification failure. */
  failureState: TaskFailureState | null;
  /** Approval mode in force when the task ran (Pillar-2 seam). */
  permissions:  Record<string, unknown> | null;
  /** v4.13 Gap 4 — resume attempts spent (per-task wake-loop cap). */
  resumeCount:  number;
}

/** Raw column shape from sqlite. JSON arrays come back as strings. */
interface TaskRowSql {
  id:              string;
  title:           string;
  goal:            string;
  status:          string;
  created_at:      number;
  updated_at:      number;
  channel_id:      string | null;
  session_id:      string;
  parent_task_id:  string | null;
  trace_ids:       string;
  artifact_ids:    string;
  evidence:        string | null;
  constraints:     string | null;
  files_touched:   string;
  side_effects:    string;
  failure_state:   string | null;
  permissions:     string | null;
  resume_count:    number;
}

/** Defensive JSON parse — null on corruption, never a crash. */
function parseJsonOrNull<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as T : null;
  } catch { return null; }
}

/** Defensive JSON-array parse — empty array on corruption/absence. */
function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch { return []; }
}

function rowToTask(r: TaskRowSql): Task {
  // Defensive JSON parses — corruption fall-through to empty arrays
  // rather than crashing the listing surface.
  let traceIds: number[] = [];
  let artifactIds: string[] = [];
  try {
    const parsed = JSON.parse(r.trace_ids);
    if (Array.isArray(parsed)) traceIds = parsed.filter((n): n is number => typeof n === 'number');
  } catch { /* malformed JSON in this row — surface as empty */ }
  try {
    const parsed = JSON.parse(r.artifact_ids);
    if (Array.isArray(parsed)) artifactIds = parsed.filter((s): s is string => typeof s === 'string');
  } catch { /* same */ }
  let evidence: TaskEvidence | null = null;
  try {
    if (r.evidence) {
      const parsed = JSON.parse(r.evidence);
      if (parsed && typeof parsed === 'object') evidence = parsed as TaskEvidence;
    }
  } catch { /* malformed envelope — surface as null, never crash a listing */ }
  return {
    id:           r.id,
    title:        r.title,
    goal:         r.goal,
    status:       r.status as TaskStatus,
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
    channelId:    r.channel_id,
    sessionId:    r.session_id,
    parentTaskId: r.parent_task_id,
    traceIds,
    artifactIds,
    evidence,
    constraints:  parseJsonOrNull<Record<string, unknown>>(r.constraints),
    filesTouched: parseJsonArray<string>(r.files_touched).filter((s): s is string => typeof s === 'string'),
    sideEffects:  parseJsonArray<SideEffectRecord>(r.side_effects),
    failureState: parseJsonOrNull<TaskFailureState>(r.failure_state),
    permissions:  parseJsonOrNull<Record<string, unknown>>(r.permissions),
    resumeCount:  typeof r.resume_count === 'number' ? r.resume_count : 0,
  };
}

export interface CreateTaskOptions {
  title:         string;
  goal:          string;
  sessionId:     string;
  channelId?:    string | null;
  parentTaskId?: string | null;
  /** Default 'active'. v4.10 REPL never starts at 'pending'; the
   *  enum value is reserved for v4.11 daemon queueing. */
  status?:       TaskStatus;
}

export interface ListRecentTasksOptions {
  sessionId?:    string;
  status?:       TaskStatus;
  /** Cap at 5000 (hard) or 50 (default). */
  limit?:        number;
}

export interface TaskStore {
  /** Create a new Task. Returns the generated id. */
  create(opts: CreateTaskOptions): string;
  /** Read one task by id. Returns null when missing. */
  get(id: string): Task | null;
  /**
   * Transition status. updates updated_at in the same statement.
   * Best-effort; missing task is a silent no-op (caller's already
   * lost track and we don't want to escalate a missing-FK class
   * into a runtime error).
   */
  setStatus(id: string, status: TaskStatus): void;
  /**
   * Replace the `goal` field (used by /adjust). Also bumps
   * updated_at. Title is not touched — title is the at-creation
   * label, goal is the live intent.
   */
  setGoal(id: string, goal: string): void;
  /**
   * Append a run_event.id to the task's traceIds array. Cheap atomic
   * JSON-array-merge inside a single UPDATE. Duplicate ids are
   * filtered out so noisy emitters can't blow the row size.
   */
  appendTraceId(id: string, eventId: number): void;
  /**
   * v4.11 — append an artifact id to the task's artifactIds array,
   * closing the reserved field (migrations.ts: "back-reference into a
   * future artifact registry"). Same atomic JSON-array-merge + de-dupe
   * as appendTraceId; artifact rows live in the `artifacts` table
   * (core/v4/daemon/artifactStore.ts).
   */
  appendArtifactId(id: string, artifactId: string): void;
  /**
   * v4.13 Gap 1 — terminal transition decided by the verify-before-done
   * gate. Writes status + the evidence envelope in ONE statement so a
   * crash can't leave a verdict without its justification (or vice
   * versa). Best-effort like setStatus.
   *
   * v4.13 Gap 3 — the same single UPDATE also carries the job-card:
   * `filesTouched` MERGES (deduped) and `sideEffects` APPENDS (deduped
   * by value) into the row's existing arrays so a multi-turn task
   * accumulates its footprint; `failureState` / `permissions` /
   * `constraints` overwrite only when provided. Single-write
   * discipline: status, evidence, and job-card can never diverge —
   * one statement, no scattered writers.
   */
  finalizeVerification(
    id: string,
    status: TaskStatus,
    evidence: TaskEvidence,
    jobCard?: {
      filesTouched?: string[];
      sideEffects?:  SideEffectRecord[];
      failureState?: TaskFailureState | null;
      permissions?:  Record<string, unknown> | null;
      constraints?:  Record<string, unknown> | null;
    },
  ): void;
  /**
   * v4.13 Gap 4 — spend one resume attempt (atomic increment). Returns
   * the NEW count so the sweep can compare against the wake-loop cap
   * without a second read.
   */
  incrementResumeCount(id: string): number;
  /**
   * Listing surface for /tasks. Newest-first by created_at. Optional
   * session + status filters compose with AND.
   */
  listRecent(opts?: ListRecentTasksOptions): Task[];
  /**
   * v4.11 Slice 0 — boot-time orphan sweep. Retires every `active` task
   * created strictly before `beforeMs` to `interrupted`, returning the
   * number of rows swept. Called once at REPL boot with the boot
   * timestamp: the current session's task rows are all created AFTER
   * boot, so they're never touched — the cutoff is the session guard
   * (the session id isn't even assigned yet at boot). Only `active`
   * rows are eligible; terminal statuses (completed/failed/cancelled/
   * interrupted) are left alone. Best-effort at the call site.
   */
  sweepOrphaned(beforeMs: number): number;
}

export interface CreateTaskStoreOptions {
  db: Db;
}

/**
 * Generate a task id with the `task_` prefix for grep-ability +
 * crypto-strong randomness. Length tuned to ~16 hex chars after the
 * prefix — short enough to type into `/adjust task_abc... cancel`,
 * long enough for collision safety within a session.
 */
function newTaskId(): string {
  // Avoid pulling in node:crypto module-eagerly to keep this module
  // import-cheap; lazy require keeps consumers that only need the
  // type interfaces fast.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('node:crypto');
  return `task_${(randomBytes(8) as Buffer).toString('hex')}`;
}

export function createTaskStore(opts: CreateTaskStoreOptions): TaskStore {
  const db = opts.db;
  return {
    create({ title, goal, sessionId, channelId, parentTaskId, status }) {
      const now = Date.now();
      const id = newTaskId();
      db.prepare(
        `INSERT INTO tasks (
           id, title, goal, status, created_at, updated_at,
           channel_id, session_id, parent_task_id,
           trace_ids, artifact_ids
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        // Title cap matches the ui_task_update schema's ≤80-char hint.
        title.slice(0, 80),
        goal,
        status ?? 'active',
        now,
        now,
        channelId      ?? null,
        sessionId,
        parentTaskId   ?? null,
        '[]',
        '[]',
      );
      return id;
    },
    get(id) {
      const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRowSql | undefined;
      return r ? rowToTask(r) : null;
    },
    setStatus(id, status) {
      db.prepare(
        `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
      ).run(status, Date.now(), id);
    },
    setGoal(id, goal) {
      db.prepare(
        `UPDATE tasks SET goal = ?, updated_at = ? WHERE id = ?`,
      ).run(goal, Date.now(), id);
    },
    finalizeVerification(id, status, evidence, jobCard) {
      // Read-merge for the accumulating arrays (same discipline as
      // appendTraceId), then ONE UPDATE carrying every field — status,
      // evidence, and job-card land atomically or not at all.
      const row = db.prepare(
        'SELECT files_touched, side_effects, constraints, failure_state, permissions FROM tasks WHERE id = ?',
      ).get(id) as {
        files_touched: string; side_effects: string;
        constraints: string | null; failure_state: string | null; permissions: string | null;
      } | undefined;
      if (!row) return;   // missing task — same silent no-op as setStatus

      const files = parseJsonArray<string>(row.files_touched)
        .filter((s): s is string => typeof s === 'string');
      for (const f of jobCard?.filesTouched ?? []) {
        if (!files.includes(f)) files.push(f);
      }
      const effects = parseJsonArray<SideEffectRecord>(row.side_effects);
      const seen = new Set(effects.map((e) => JSON.stringify(e)));
      for (const e of jobCard?.sideEffects ?? []) {
        const key = JSON.stringify(e);
        if (!seen.has(key)) { effects.push(e); seen.add(key); }
      }
      const pick = (provided: unknown | undefined, existing: string | null): string | null => {
        if (provided === undefined) return existing;
        return provided === null ? null : JSON.stringify(provided);
      };
      db.prepare(
        `UPDATE tasks SET
           status = ?, evidence = ?,
           files_touched = ?, side_effects = ?,
           failure_state = ?, permissions = ?, constraints = ?,
           updated_at = ?
         WHERE id = ?`,
      ).run(
        status,
        JSON.stringify(evidence),
        JSON.stringify(files),
        JSON.stringify(effects),
        pick(jobCard?.failureState, row.failure_state),
        pick(jobCard?.permissions,  row.permissions),
        pick(jobCard?.constraints,  row.constraints),
        Date.now(),
        id,
      );
    },
    appendTraceId(id, eventId) {
      // Read-modify-write. SQLite's WAL serialises writers so the
      // race window is small but theoretically present; we de-dupe
      // on write to keep the array bounded under repeat emits.
      const row = db.prepare('SELECT trace_ids FROM tasks WHERE id = ?').get(id) as { trace_ids: string } | undefined;
      if (!row) return;
      let arr: number[] = [];
      try {
        const parsed = JSON.parse(row.trace_ids);
        if (Array.isArray(parsed)) arr = parsed.filter((n): n is number => typeof n === 'number');
      } catch { /* malformed — start fresh */ }
      if (arr.includes(eventId)) return;
      arr.push(eventId);
      db.prepare(
        `UPDATE tasks SET trace_ids = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(arr), Date.now(), id);
    },
    appendArtifactId(id, artifactId) {
      // Same atomic read-modify-write + de-dupe as appendTraceId, on the
      // string-valued artifact_ids array.
      const row = db.prepare('SELECT artifact_ids FROM tasks WHERE id = ?').get(id) as { artifact_ids: string } | undefined;
      if (!row) return;
      let arr: string[] = [];
      try {
        const parsed = JSON.parse(row.artifact_ids);
        if (Array.isArray(parsed)) arr = parsed.filter((s): s is string => typeof s === 'string');
      } catch { /* malformed — start fresh */ }
      if (arr.includes(artifactId)) return;
      arr.push(artifactId);
      db.prepare(
        `UPDATE tasks SET artifact_ids = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(arr), Date.now(), id);
    },
    incrementResumeCount(id) {
      db.prepare(
        `UPDATE tasks SET resume_count = resume_count + 1, updated_at = ? WHERE id = ?`,
      ).run(Date.now(), id);
      const row = db.prepare('SELECT resume_count FROM tasks WHERE id = ?').get(id) as { resume_count: number } | undefined;
      return row?.resume_count ?? 0;
    },
    listRecent(qOpts = {}) {
      const limit = Math.max(1, Math.min(qOpts.limit ?? 50, 5000));
      const where: string[]                 = [];
      const params: Array<string | number>  = [];
      if (qOpts.sessionId) {
        where.push('session_id = ?');
        params.push(qOpts.sessionId);
      }
      if (qOpts.status) {
        where.push('status = ?');
        params.push(qOpts.status);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);
      const rows = db.prepare(
        `SELECT * FROM tasks ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params) as TaskRowSql[];
      return rows.map(rowToTask);
    },
    sweepOrphaned(beforeMs) {
      // Single atomic UPDATE — only pre-boot in-flight rows transition.
      // `created_at < beforeMs` excludes anything this process creates
      // (current-session tasks are all stamped after boot), so a live
      // session is never disturbed. Returns the swept count for logging.
      // v4.13 Gap 1 — `pending_verification` is in-flight too: a crash
      // between the gate's two writes must retire the row honestly
      // rather than leaving it pending forever.
      const info = db.prepare(
        `UPDATE tasks
            SET status = 'interrupted', updated_at = ?
          WHERE status IN ('active', 'pending_verification') AND created_at < ?`,
      ).run(Date.now(), beforeMs);
      return info.changes;
    },
  };
}
