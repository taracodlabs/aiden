/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.8 — TaskStore unit tests.
 *
 * Covers the durable Task-lite kernel in isolation against a real
 * better-sqlite3 handle + the v14 migration. ChatSession integration
 * is tested separately in chatSessionUiPersist.test.ts so a future
 * regression in either layer fails the right test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { createTaskStore, type TaskStore } from '../../../core/v4/daemon/taskStore';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';

let tmp: string;
let db: Database.Database;
let store: TaskStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-tasks-'));
  db = new Database(path.join(tmp, 'daemon.db'));
  runMigrations(db);
  store = createTaskStore({ db });
});

afterEach(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('TaskStore.create', () => {
  it('inserts a row with the locked schema shape + returns the new id', () => {
    const id = store.create({
      title:     'list files in this dir',
      goal:      'list files in this directory and tell me about the largest one',
      sessionId: 'sess-1',
      channelId: 'repl',
    });
    expect(id).toMatch(/^task_[a-f0-9]+$/);
    const row = store.get(id);
    expect(row).not.toBeNull();
    expect(row!.title).toBe('list files in this dir');
    expect(row!.goal).toBe('list files in this directory and tell me about the largest one');
    expect(row!.status).toBe('active');             // default per B2
    expect(row!.sessionId).toBe('sess-1');
    expect(row!.channelId).toBe('repl');
    expect(row!.parentTaskId).toBeNull();
    expect(row!.traceIds).toEqual([]);
    expect(row!.artifactIds).toEqual([]);
    expect(row!.createdAt).toBeGreaterThan(0);
    expect(row!.updatedAt).toBe(row!.createdAt);    // first write, same ts
  });

  it('caps title to 80 chars; goal stays unbounded', () => {
    const longTitle = 'a'.repeat(200);
    const id = store.create({ title: longTitle, goal: longTitle, sessionId: 'sess-cap' });
    const row = store.get(id)!;
    expect(row.title.length).toBe(80);
    expect(row.goal.length).toBe(200);        // goal preserved verbatim
  });

  it('respects an explicit status override (pending reserved for v4.11)', () => {
    const id = store.create({
      title:     'queued task',
      goal:      'queued task',
      sessionId: 'sess-pending',
      status:    'pending',
    });
    expect(store.get(id)!.status).toBe('pending');
  });

  it('records parentTaskId when provided (forward-compat sub-tasks)', () => {
    const parent = store.create({ title: 'p', goal: 'p', sessionId: 's' });
    const child  = store.create({ title: 'c', goal: 'c', sessionId: 's', parentTaskId: parent });
    expect(store.get(child)!.parentTaskId).toBe(parent);
  });
});

describe('TaskStore.setStatus', () => {
  it('transitions active → completed and bumps updatedAt', async () => {
    const id = store.create({ title: 't', goal: 't', sessionId: 's' });
    const created = store.get(id)!;
    // Force a small clock advance so updatedAt != createdAt.
    await new Promise((res) => setTimeout(res, 5));
    store.setStatus(id, 'completed');
    const after = store.get(id)!;
    expect(after.status).toBe('completed');
    expect(after.updatedAt).toBeGreaterThan(created.createdAt);
    expect(after.createdAt).toBe(created.createdAt);   // createdAt immutable
  });

  it('handles missing id silently (no throw)', () => {
    expect(() => store.setStatus('task_nonexistent', 'cancelled')).not.toThrow();
  });

  it('supports the full lifecycle vocabulary', () => {
    for (const status of ['pending', 'active', 'completed', 'failed', 'cancelled'] as const) {
      const id = store.create({ title: 't', goal: 't', sessionId: 's' });
      store.setStatus(id, status);
      expect(store.get(id)!.status).toBe(status);
    }
  });
});

describe('TaskStore.setGoal', () => {
  it('replaces goal and bumps updatedAt; title unchanged', async () => {
    const id = store.create({ title: 'original title', goal: 'original goal', sessionId: 's' });
    await new Promise((res) => setTimeout(res, 5));
    store.setGoal(id, 'redirected goal');
    const row = store.get(id)!;
    expect(row.goal).toBe('redirected goal');
    expect(row.title).toBe('original title');   // unchanged — title is at-creation label
    expect(row.updatedAt).toBeGreaterThan(row.createdAt);
  });
});

describe('TaskStore.appendTraceId', () => {
  it('appends a run_event.id to traceIds atomically', () => {
    const id = store.create({ title: 't', goal: 't', sessionId: 's' });
    store.appendTraceId(id, 101);
    store.appendTraceId(id, 102);
    store.appendTraceId(id, 103);
    expect(store.get(id)!.traceIds).toEqual([101, 102, 103]);
  });

  it('de-duplicates so noisy emitters cannot blow row size', () => {
    const id = store.create({ title: 't', goal: 't', sessionId: 's' });
    store.appendTraceId(id, 42);
    store.appendTraceId(id, 42);     // duplicate
    store.appendTraceId(id, 42);     // duplicate
    expect(store.get(id)!.traceIds).toEqual([42]);
  });

  it('silently no-ops on missing task id', () => {
    expect(() => store.appendTraceId('task_missing', 99)).not.toThrow();
  });
});

describe('TaskStore.appendArtifactId (v4.11 — closes the reserved field)', () => {
  it('appends artifact ids to artifactIds atomically + de-dupes', () => {
    const id = store.create({ title: 't', goal: 't', sessionId: 's' });
    expect(store.get(id)!.artifactIds).toEqual([]);   // reserved-empty at create
    store.appendArtifactId(id, 'art_1');
    store.appendArtifactId(id, 'art_2');
    store.appendArtifactId(id, 'art_1');              // duplicate
    expect(store.get(id)!.artifactIds).toEqual(['art_1', 'art_2']);
  });

  it('silently no-ops on missing task id', () => {
    expect(() => store.appendArtifactId('task_missing', 'art_x')).not.toThrow();
  });
});

describe('TaskStore.listRecent', () => {
  it('returns newest-first by createdAt', async () => {
    const a = store.create({ title: 'first', goal: 'a', sessionId: 's' });
    await new Promise((res) => setTimeout(res, 5));
    const b = store.create({ title: 'second', goal: 'b', sessionId: 's' });
    await new Promise((res) => setTimeout(res, 5));
    const c = store.create({ title: 'third', goal: 'c', sessionId: 's' });
    const rows = store.listRecent();
    expect(rows.map((r) => r.id)).toEqual([c, b, a]);
  });

  it('filters by sessionId', () => {
    store.create({ title: 'a', goal: 'a', sessionId: 'sess-A' });
    store.create({ title: 'b', goal: 'b', sessionId: 'sess-B' });
    store.create({ title: 'c', goal: 'c', sessionId: 'sess-A' });
    const onlyA = store.listRecent({ sessionId: 'sess-A' });
    expect(onlyA.length).toBe(2);
    expect(onlyA.every((r) => r.sessionId === 'sess-A')).toBe(true);
  });

  it('omitting sessionId lists across ALL sessions (the /tasks all opt-in)', () => {
    // Mechanism behind `/tasks all`: the handler drops the sessionId
    // filter so boot-swept orphans from dead sessions become visible.
    store.create({ title: 'a', goal: 'a', sessionId: 'sess-A' });
    store.create({ title: 'b', goal: 'b', sessionId: 'sess-B' });
    store.create({ title: 'c', goal: 'c', sessionId: 'sess-C' });
    const all = store.listRecent();                        // no sessionId
    expect(all.length).toBe(3);
    expect(new Set(all.map((r) => r.sessionId))).toEqual(
      new Set(['sess-A', 'sess-B', 'sess-C']),
    );
    // Scoped query still isolates a single session — default unchanged.
    expect(store.listRecent({ sessionId: 'sess-B' }).map((r) => r.title)).toEqual(['b']);
  });

  it('cross-session listing surfaces interrupted orphans a scoped query hides', () => {
    // End-to-end of the Slice 0 value: a dead session's swept orphan is
    // invisible to a fresh session's scoped /tasks, but visible to /tasks all.
    const orphan = store.create({ title: 'stuck', goal: 'stuck', sessionId: 'sess-DEAD' });
    store.setStatus(orphan, 'interrupted');
    store.create({ title: 'live', goal: 'live', sessionId: 'sess-NEW' });
    // Fresh session's default /tasks — orphan NOT shown.
    const scoped = store.listRecent({ sessionId: 'sess-NEW' });
    expect(scoped.some((r) => r.id === orphan)).toBe(false);
    // /tasks all interrupted — orphan IS shown.
    const crossInterrupted = store.listRecent({ status: 'interrupted' });
    expect(crossInterrupted.map((r) => r.id)).toEqual([orphan]);
  });

  it('filters by status (composes with sessionId via AND)', () => {
    const a = store.create({ title: 'a', goal: 'a', sessionId: 'sess' });
    const b = store.create({ title: 'b', goal: 'b', sessionId: 'sess' });
    const c = store.create({ title: 'c', goal: 'c', sessionId: 'sess' });
    store.setStatus(a, 'completed');
    store.setStatus(b, 'cancelled');
    // c stays active.
    const active = store.listRecent({ sessionId: 'sess', status: 'active' });
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(c);
    const cancelled = store.listRecent({ status: 'cancelled' });
    expect(cancelled.length).toBe(1);
    expect(cancelled[0].id).toBe(b);
  });

  it('respects limit (default 50, hard cap 5000)', () => {
    // Batch the 75 inserts in a single transaction. The DB is file-backed
    // (beforeEach), so individually each create() fsyncs to disk; on a
    // Windows CI runner under full-suite parallel-worker disk contention
    // (+ antivirus), 75 separate fsyncs blew past the 5s default timeout.
    // One transaction = one commit/fsync. Assertions are unchanged — the
    // same 75 rows exist; only the setup I/O is collapsed.
    db.transaction(() => {
      for (let i = 0; i < 75; i++) {
        store.create({ title: `t${i}`, goal: `t${i}`, sessionId: 's' });
      }
    })();
    expect(store.listRecent().length).toBe(50);             // default
    expect(store.listRecent({ limit: 10 }).length).toBe(10);
    expect(store.listRecent({ limit: 99999 }).length).toBe(75); // cap clamps, only 75 exist
  }, 30_000);
});

describe('TaskStore — defensive JSON parses', () => {
  it('returns empty arrays when traceIds/artifactIds are corrupt JSON', () => {
    const id = store.create({ title: 't', goal: 't', sessionId: 's' });
    // Direct corruption via raw UPDATE — surfaces what happens if a
    // future migration bug or external editor mangles the column.
    db.prepare(`UPDATE tasks SET trace_ids = ?, artifact_ids = ? WHERE id = ?`)
      .run('not json', '{}also-not-array', id);
    const row = store.get(id)!;
    expect(row.traceIds).toEqual([]);
    expect(row.artifactIds).toEqual([]);
  });
});

// ─── V14 migration smoke ─────────────────────────────────────────────

describe('v14 migration — Slice 10.8 tasks table', () => {
  it('creates the tasks table + two indexes; idempotent on re-run', () => {
    // Fresh DB already migrated by the beforeEach above. Just assert
    // the post-state.
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toEqual([
      'artifact_ids', 'channel_id',
      // v4.13 Gap 3 (v17 migration) — job-card columns.
      'constraints',
      'created_at',
      // v4.13 Gap 1 (v16 migration) — verify-before-done evidence envelope.
      'evidence',
      // v4.13 Gap 3 (v17 migration) — job-card columns.
      'failure_state', 'files_touched',
      'goal', 'id',
      'parent_task_id',
      // v4.13 Gap 3 (v17 migration) — job-card columns.
      'permissions',
      // v4.13 Gap 4 (v18 migration) — wake-loop cap.
      'resume_count',
      'session_id',
      // v4.13 Gap 3 (v17 migration) — job-card columns.
      'side_effects',
      'status', 'title', 'trace_ids', 'updated_at',
    ]);
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name).sort()).toEqual([
      'idx_tasks_session_created',
      'idx_tasks_status',
    ]);
    // Re-run is idempotent (CREATE TABLE IF NOT EXISTS + version bump
    // already applied so this is effectively a no-op).
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('TaskStore.sweepOrphaned (v4.11 Slice 0)', () => {
  /** Insert a row with explicit created_at + status, bypassing create()'s
   *  Date.now() so the boot-cutoff boundary is deterministic. */
  function seed(id: string, status: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO tasks (
         id, title, goal, status, created_at, updated_at,
         channel_id, session_id, parent_task_id, trace_ids, artifact_ids
       ) VALUES (?, ?, ?, ?, ?, ?, 'repl', 'sess-x', NULL, '[]', '[]')`,
    ).run(id, id, id, status, createdAt, createdAt);
  }

  it('retires pre-boot active rows to interrupted and returns the count', () => {
    const boot = 10_000;
    seed('task_old1', 'active', boot - 100);
    seed('task_old2', 'active', boot - 1);
    const swept = store.sweepOrphaned(boot);
    expect(swept).toBe(2);
    expect(store.get('task_old1')!.status).toBe('interrupted');
    expect(store.get('task_old2')!.status).toBe('interrupted');
    // updated_at is bumped on the swept rows.
    expect(store.get('task_old1')!.updatedAt).toBeGreaterThanOrEqual(boot - 100);
  });

  it('NEVER touches rows at/after the cutoff — the current-session guard', () => {
    const boot = 10_000;
    seed('task_now',    'active', boot);       // exactly at boot — strict < excludes it
    seed('task_future', 'active', boot + 500); // created after boot (current session)
    const swept = store.sweepOrphaned(boot);
    expect(swept).toBe(0);
    expect(store.get('task_now')!.status).toBe('active');
    expect(store.get('task_future')!.status).toBe('active');
  });

  it('only active rows are eligible — terminal statuses are left alone', () => {
    const boot = 10_000;
    seed('task_done',   'completed',   boot - 100);
    seed('task_cancel', 'cancelled',   boot - 100);
    seed('task_fail',   'failed',      boot - 100);
    seed('task_int',    'interrupted', boot - 100);
    seed('task_live',   'active',      boot - 100);
    const swept = store.sweepOrphaned(boot);
    expect(swept).toBe(1);                                  // only the active one
    expect(store.get('task_live')!.status).toBe('interrupted');
    expect(store.get('task_done')!.status).toBe('completed');
    expect(store.get('task_cancel')!.status).toBe('cancelled');
    expect(store.get('task_fail')!.status).toBe('failed');
    expect(store.get('task_int')!.status).toBe('interrupted');
  });

  it('returns 0 when nothing is eligible', () => {
    expect(store.sweepOrphaned(Date.now())).toBe(0);
  });
});
