/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS_FOR_TESTS,
  runMigrations,
} from '../../../core/v4/daemon/db/migrations';

describe('external protocol persistence migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => db.close());

  it('adds the shared external identity, capability, task, event, and artifact authorities in v54', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 53)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql ?? '');
        db.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)')
          .run(migration.version, 1);
      })();
    }

    const before = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((row) => row.name));
    expect(runMigrations(db)).toEqual({ from: 53, to: LATEST_SCHEMA_VERSION });
    expect(LATEST_SCHEMA_VERSION).toBe(54);
    const added = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => !before.has(name));
    expect(added).toEqual([
      'external_capability_snapshots',
      'external_identities',
      'remote_artifacts',
      'remote_task_events',
      'remote_tasks',
    ]);
    const eventColumns = (db.prepare('PRAGMA table_info(remote_task_events)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(eventColumns).toEqual([
      'remote_task_event_id', 'remote_task_record_id', 'remote_event_id', 'sequence',
      'kind', 'task_state', 'payload_digest', 'observed_at',
    ]);
    const taskColumns = new Set((db.prepare('PRAGMA table_info(remote_tasks)').all() as Array<{ name: string }>)
      .map((column) => column.name));
    for (const required of [
      'capability_snapshot_id', 'capability_digest', 'protocol_version', 'binding',
      'parent_job_id', 'local_job_id', 'local_attempt_id', 'local_generation',
      'local_fence_digest', 'request_digest', 'idempotency_key', 'remote_task_id',
      'state_version', 'cancel_requested_at', 'terminal_at',
    ]) expect(taskColumns.has(required), required).toBe(true);
  });

  it('keeps the migration idempotent and restart-safe', () => {
    expect(runMigrations(db)).toEqual({ from: 0, to: 54 });
    expect(runMigrations(db)).toEqual({ from: 54, to: 54 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
