/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS_FOR_TESTS,
  runMigrations,
} from '../../../../core/v4/daemon/db/migrations';

let db: Database.Database;

function applyThrough(version: number): void {
  for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= version)) {
    db.transaction(() => {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql ?? '');
      db.prepare(
        'INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)',
      ).run(migration.version, Date.now());
    })();
  }
}

function columns(table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function seedV4151Rows(): { taskId: string; runIds: [number, number] } {
  const now = Date.now();
  db.prepare(
    `INSERT INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('instance_fixture', 1, 'localhost', now, now, '4.15.1');
  db.prepare(
    `INSERT INTO tasks
       (id, title, goal, status, created_at, updated_at, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('task_fixture', 'Fixture', 'Exercise migration', 'active', now, now, 'session_fixture');

  const insertRun = db.prepare(
    `INSERT INTO runs
       (session_id, instance_id, status, started_at, task_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const first = Number(insertRun.run('session_fixture', 'instance_fixture', 'completed', now, 'task_fixture').lastInsertRowid);
  const second = Number(insertRun.run('session_fixture', 'instance_fixture', 'running', now + 1, 'task_fixture').lastInsertRowid);

  const insertEvent = db.prepare(
    `INSERT INTO run_events
       (run_id, session_id, seq, ts, category, kind, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(first, 'session_fixture', 1, now, 'legacy', 'first', '{}');
  insertEvent.run(second, 'session_fixture', 1, now + 1, 'legacy', 'second', '{}');
  return { taskId: 'task_fixture', runIds: [first, second] };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

describe('durable Job and Attempt migration', () => {
  it('promotes a v4.15.1 database without replacing tasks, runs, or historic records', () => {
    applyThrough(19);
    const seeded = seedV4151Rows();

    const result = runMigrations(db);

    expect(result).toEqual({ from: 19, to: LATEST_SCHEMA_VERSION });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(seeded.taskId)).toEqual({ id: seeded.taskId });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()).toBeUndefined();
  });

  it('adds the Job, Attempt, event, ToolCall, and SideEffect authority fields', () => {
    runMigrations(db);

    expect([...columns('tasks')]).toEqual(expect.arrayContaining([
      'state_version', 'active_attempt_id', 'root_job_id',
      'idempotency_namespace', 'idempotency_key', 'request_fingerprint',
      'entry_point', 'source', 'terminal_at', 'terminal_outcome',
      'finish_reason', 'recovery_state', 'crash_count',
      'next_event_sequence', 'policy_snapshot_id',
    ]));
    expect([...columns('runs')]).toEqual(expect.arrayContaining([
      'attempt_id', 'attempt_number', 'generation', 'state_version',
      'lease_id', 'lease_owner', 'lease_expires_at', 'lease_heartbeat_at',
      'fence_token', 'recovery_of_attempt_id', 'trigger_reason',
      'provider_route_snapshot', 'budget_snapshot', 'ended_at',
    ]));
    expect([...columns('run_events')]).toEqual(expect.arrayContaining([
      'job_id', 'attempt_id', 'job_sequence', 'producer', 'generation',
      'causation_id', 'correlation_id', 'idempotency_key',
    ]));
    expect([...columns('tool_calls')]).toEqual(expect.arrayContaining([
      'tool_call_id', 'job_id', 'attempt_id', 'generation', 'model_call_id',
      'tool_name', 'normalized_args_digest', 'risk_tier', 'mutates', 'state',
      'started_at', 'ended_at', 'result_ref', 'side_effect_id', 'verification_ref',
    ]));
    expect([...columns('side_effect_ledger')]).toEqual(expect.arrayContaining([
      'job_id', 'attempt_id', 'generation', 'tool_call_id', 'effect_state',
    ]));
  });

  it('backfills stable Attempt identities and deterministic per-Job event order', () => {
    applyThrough(19);
    const seeded = seedV4151Rows();

    runMigrations(db);

    const attempts = db.prepare(
      'SELECT id, attempt_id, attempt_number, generation FROM runs ORDER BY id',
    ).all() as Array<{ id: number; attempt_id: string; attempt_number: number; generation: number }>;
    expect(attempts).toEqual([
      { id: seeded.runIds[0], attempt_id: `attempt_legacy_${seeded.runIds[0]}`, attempt_number: 1, generation: 1 },
      { id: seeded.runIds[1], attempt_id: `attempt_legacy_${seeded.runIds[1]}`, attempt_number: 2, generation: 1 },
    ]);

    const events = db.prepare(
      'SELECT job_id, attempt_id, job_sequence FROM run_events ORDER BY id',
    ).all();
    expect(events).toEqual([
      { job_id: seeded.taskId, attempt_id: `attempt_legacy_${seeded.runIds[0]}`, job_sequence: 1 },
      { job_id: seeded.taskId, attempt_id: `attempt_legacy_${seeded.runIds[1]}`, job_sequence: 2 },
    ]);
  });

  it('recovers safely from a partially materialized additive schema', () => {
    applyThrough(19);
    db.exec('ALTER TABLE tasks ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0');

    expect(() => runMigrations(db)).not.toThrow();
    expect(columns('tasks').has('active_attempt_id')).toBe(true);
    expect(db.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({
      version: LATEST_SCHEMA_VERSION,
    });
  });

  it('rolls back an interrupted migration and succeeds on retry', () => {
    applyThrough(19);
    db.exec(`
      CREATE TRIGGER reject_job_engine_version
      BEFORE INSERT ON schema_version
      WHEN NEW.version >= 20
      BEGIN
        SELECT RAISE(ABORT, 'fixture interruption');
      END;
    `);

    expect(() => runMigrations(db)).toThrow(/fixture interruption/);
    expect(columns('tasks').has('state_version')).toBe(false);

    db.exec('DROP TRIGGER reject_job_engine_version');
    expect(() => runMigrations(db)).not.toThrow();
    expect(columns('tasks').has('state_version')).toBe(true);
  });

  it('is stable when the additive migration is applied repeatedly', () => {
    applyThrough(19);
    const seeded = seedV4151Rows();
    const migration = MIGRATIONS_FOR_TESTS.find((entry) => entry.version === 20)!;

    migration.apply!(db);
    const first = db.prepare(
      'SELECT attempt_id, attempt_number FROM runs ORDER BY id',
    ).all();
    migration.apply!(db);

    expect(db.prepare('SELECT attempt_id, attempt_number FROM runs ORDER BY id').all()).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 2 });
    expect(first).toEqual([
      { attempt_id: `attempt_legacy_${seeded.runIds[0]}`, attempt_number: 1 },
      { attempt_id: `attempt_legacy_${seeded.runIds[1]}`, attempt_number: 2 },
    ]);
  });

  it('fails a malformed partial migration transaction with an actionable version', () => {
    applyThrough(19);
    const seeded = seedV4151Rows();
    db.exec('ALTER TABLE runs ADD COLUMN attempt_id TEXT');
    db.prepare('UPDATE runs SET attempt_id = ? WHERE id IN (?, ?)')
      .run('duplicate_attempt', ...seeded.runIds);

    expect(() => runMigrations(db)).toThrow(/Migration 20 .*UNIQUE constraint failed/i);
    expect(db.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 19 });
    expect(columns('tasks').has('state_version')).toBe(false);
  });
});
