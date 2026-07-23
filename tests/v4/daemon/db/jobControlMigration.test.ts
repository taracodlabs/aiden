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

function tableNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

describe('durable input and approval migration', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => db.close());

  it('upgrades the exact previous schema additively without creating another Job or Attempt authority', () => {
    applyThrough(20);
    const before = tableNames();

    expect(runMigrations(db)).toEqual({ from: 20, to: LATEST_SCHEMA_VERSION });
    expect(tableNames()).toEqual(expect.arrayContaining([
      ...before,
      'durable_inputs',
      'steering_commands',
      'job_control_commands',
      'policy_snapshots',
      'approvals',
    ]));
    expect(tableNames()).not.toContain('jobs');
    expect(db.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 21 });
  });

  it('is idempotent when the additive migration is applied repeatedly', () => {
    applyThrough(20);
    const migration = MIGRATIONS_FOR_TESTS.find((entry) => entry.version === 21)!;
    migration.apply!(db);
    const first = tableNames();
    migration.apply!(db);
    expect(tableNames()).toEqual(first);
  });

  it('rolls back all Phase 4 tables when schema-version persistence is interrupted', () => {
    applyThrough(20);
    db.exec(`
      CREATE TRIGGER reject_phase_four_version
      BEFORE INSERT ON schema_version
      WHEN NEW.version = 21
      BEGIN
        SELECT RAISE(ABORT, 'phase four fixture interruption');
      END;
    `);

    expect(() => runMigrations(db)).toThrow(/Migration 21 .*fixture interruption/i);
    expect(tableNames()).not.toContain('durable_inputs');
    expect(db.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 20 });
  });

  it('contains no credential columns or seeded secret values', () => {
    runMigrations(db);
    const schema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('durable_inputs','policy_snapshots','approvals') ORDER BY name",
    ).all() as Array<{ sql: string }>;
    expect(schema.map((row) => row.sql).join('\n')).not.toMatch(/api_key|access_token|refresh_token|password/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM durable_inputs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({ count: 0 });
  });
});
