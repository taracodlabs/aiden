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
      db.prepare('INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)')
        .run(migration.version, Date.now());
    })();
  }
}

describe('durable effect contract migration', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => db.close());

  it('upgrades the v21 ledger additively and preserves legacy effects', () => {
    applyThrough(21);
    db.prepare(
      `INSERT INTO side_effect_ledger
         (key, task_id, step, tool, args_hash, status, attempted_at, effect_state)
       VALUES ('legacy-effect', 'legacy-job', 1, 'send', 'digest', 'confirmed', 1, 'committed')`,
    ).run();

    expect(runMigrations(db)).toEqual({ from: 21, to: LATEST_SCHEMA_VERSION });
    expect(db.prepare(
      'SELECT key, effect_state, effect_classification, updated_at FROM side_effect_ledger WHERE key = ?',
    ).get('legacy-effect')).toMatchObject({
      key: 'legacy-effect', effect_state: 'committed', effect_classification: 'unsafe_mutation', updated_at: 1,
    });
  });

  it('rolls back the additive migration when version persistence fails', () => {
    applyThrough(21);
    db.exec(`
      CREATE TRIGGER reject_effect_contract_version
      BEFORE INSERT ON schema_version
      WHEN NEW.version = 22
      BEGIN
        SELECT RAISE(ABORT, 'effect fixture interruption');
      END;
    `);

    expect(() => runMigrations(db)).toThrow(/Migration 22 .*effect fixture interruption/i);
    const names = (db.prepare('PRAGMA table_info(side_effect_ledger)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).not.toContain('effect_classification');
    expect(db.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 21 });
  });

  it('adds reconciliation history without replacing existing Effect rows', () => {
    applyThrough(22);
    db.prepare(
      `INSERT INTO side_effect_ledger
         (key, task_id, step, tool, args_hash, status, attempted_at, effect_state,
          effect_classification, effect_kind, retry_safety, updated_at)
       VALUES ('effect-before-v23', 'job-before-v23', 1, 'file_write', 'digest',
               'unknown', 1, 'unknown', 'reconcilable_mutation', 'filesystem.write',
               'reconcile_before_retry', 1)`,
    ).run();

    expect(runMigrations(db)).toEqual({ from: 22, to: LATEST_SCHEMA_VERSION });
    expect(db.prepare('SELECT key, effect_state FROM side_effect_ledger WHERE key = ?')
      .get('effect-before-v23')).toEqual({ key: 'effect-before-v23', effect_state: 'unknown' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='effect_reconciliations'").get())
      .toEqual({ name: 'effect_reconciliations' });
  });
});
