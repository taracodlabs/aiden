/**
 * tests/v4/daemon/runs/reclaim.test.ts — v4.9.0 Slice 3.
 *
 * `reclaimStuckRuns` marks `runs.status='running'` rows owned by a
 * specific incarnation (crash-handler path) OR every non-current
 * incarnation (boot-time sweep) as `interrupted` / `daemon_crashed`,
 * matching `evaluateBootState`'s recovery semantics. Idempotent: a
 * second call against the same predicate touches zero rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { reclaimStuckRuns } from '../../../../core/v4/daemon/runs/reclaim';
import type { Db } from '../../../../core/v4/daemon/db/connection';

let db: Db;

function seedInstance(id: string): void {
  db.prepare(
    `INSERT INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, 12345, 'test-host', Date.now(), Date.now(), 'v4.9.0-test');
}

function seedRun(opts: { instanceId: string; status: string; sessionId?: string }): number {
  const r = db.prepare(
    `INSERT INTO runs
       (trigger_event_id, session_id, instance_id, status, started_at, resume_pending)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(null, opts.sessionId ?? 'sess-test', opts.instanceId, opts.status, Date.now());
  return Number(r.lastInsertRowid);
}

function readRun(id: number): { status: string; finish_reason: string | null; completed_at: number | null; resume_pending: number; resume_reason: string | null } {
  return db.prepare(
    `SELECT status, finish_reason, completed_at, resume_pending, resume_reason FROM runs WHERE id = ?`,
  ).get(id) as never;
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedInstance('inst-current');
  seedInstance('inst-dead');
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
});

describe('reclaimStuckRuns — v4.9.0 Slice 3', () => {
  it('crash-handler path: reclaims only the named instance\'s running rows', () => {
    const r1 = seedRun({ instanceId: 'inst-dead',    status: 'running' });
    const r2 = seedRun({ instanceId: 'inst-current', status: 'running' });
    const result = reclaimStuckRuns(db, { instanceId: 'inst-dead' });
    expect(result.reclaimed).toBe(1);
    expect(result.runIds).toEqual([r1]);
    const dead = readRun(r1);
    expect(dead.status).toBe('interrupted');
    expect(dead.finish_reason).toBe('daemon_crashed');
    expect(dead.resume_pending).toBe(1);
    expect(dead.resume_reason).toBe('daemon_crashed');
    expect(dead.completed_at).toBeGreaterThan(0);
    // Current instance untouched.
    expect(readRun(r2).status).toBe('running');
  });

  it('boot-time sweep: reclaims rows owned by any non-current instance', () => {
    const rDead = seedRun({ instanceId: 'inst-dead',    status: 'running' });
    const rCur  = seedRun({ instanceId: 'inst-current', status: 'running' });
    const result = reclaimStuckRuns(db, { currentInstanceId: 'inst-current' });
    expect(result.reclaimed).toBe(1);
    expect(result.runIds).toEqual([rDead]);
    expect(readRun(rDead).status).toBe('interrupted');
    expect(readRun(rCur).status).toBe('running');
  });

  it('idempotent: second call against same predicate is a no-op', () => {
    seedRun({ instanceId: 'inst-dead', status: 'running' });
    reclaimStuckRuns(db, { instanceId: 'inst-dead' });
    const second = reclaimStuckRuns(db, { instanceId: 'inst-dead' });
    expect(second.reclaimed).toBe(0);
    expect(second.runIds).toEqual([]);
  });

  it('does NOT touch non-running rows', () => {
    const completed = seedRun({ instanceId: 'inst-dead', status: 'completed' });
    const failed    = seedRun({ instanceId: 'inst-dead', status: 'failed' });
    const queued    = seedRun({ instanceId: 'inst-dead', status: 'queued' });
    const result = reclaimStuckRuns(db, { instanceId: 'inst-dead' });
    expect(result.reclaimed).toBe(0);
    expect(readRun(completed).status).toBe('completed');
    expect(readRun(failed).status).toBe('failed');
    expect(readRun(queued).status).toBe('queued');
  });

  it('handles zero candidates cleanly', () => {
    const result = reclaimStuckRuns(db, { instanceId: 'inst-dead' });
    expect(result.reclaimed).toBe(0);
    expect(result.runIds).toEqual([]);
  });

  it('throws when neither instanceId nor currentInstanceId is set', () => {
    expect(() => reclaimStuckRuns(db, {})).toThrow(/currentInstanceId required/);
  });

  it('clock injection produces deterministic completed_at', () => {
    const r = seedRun({ instanceId: 'inst-dead', status: 'running' });
    reclaimStuckRuns(db, { instanceId: 'inst-dead', now: () => 1700000000000 });
    expect(readRun(r).completed_at).toBe(1700000000000);
  });

  it('many orphaned rows are all reclaimed in one pass', () => {
    const ids: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push(seedRun({ instanceId: 'inst-dead', status: 'running', sessionId: `sess-${i}` }));
    }
    const result = reclaimStuckRuns(db, { instanceId: 'inst-dead' });
    expect(result.reclaimed).toBe(25);
    expect(result.runIds.length).toBe(25);
    for (const id of ids) {
      expect(readRun(id).status).toBe('interrupted');
    }
  });

  it('does not bypass the Job lease recovery authority for durable Attempts', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks
         (id, title, goal, status, created_at, updated_at, session_id,
          idempotency_namespace, idempotency_key)
       VALUES ('task-durable', 'durable', 'durable', 'running', ?, ?, 'sess-durable',
               'durable-test', 'durable-key')`,
    ).run(now, now);
    const runId = seedRun({ instanceId: 'inst-dead', status: 'running', sessionId: 'sess-durable' });
    db.prepare("UPDATE runs SET task_id = 'task-durable' WHERE id = ?").run(runId);

    expect(reclaimStuckRuns(db, { instanceId: 'inst-dead' })).toEqual({ reclaimed: 0, runIds: [] });
    expect(readRun(runId).status).toBe('running');
  });
});
