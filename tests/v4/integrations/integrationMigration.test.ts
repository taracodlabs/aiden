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

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

describe('integration authority migration', () => {
  it('adds only secret metadata, connected accounts, action pins, receipts and trigger cursors', () => {
    runMigrations(db);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(45);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      'integration_secret_handles',
      'connected_accounts',
      'integration_job_account_bindings',
      'integration_action_schemas',
      'integration_action_receipts',
      'integration_trigger_cursors',
    ]));
    const secretColumns = (db.prepare("PRAGMA table_info('integration_secret_handles')").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(secretColumns).not.toEqual(expect.arrayContaining([
      'secret', 'token', 'access_token', 'refresh_token', 'password', 'value',
    ]));
  });

  it('upgrades the accepted v4.20 browser schema without rewriting its durable records', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((item) => item.version <= 44)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql ?? '');
        db.prepare('INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)')
          .run(migration.version, migration.version);
      }).immediate();
    }
    const browserSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='browser_sessions'",
    ).pluck().get();

    expect(runMigrations(db)).toEqual({ from: 44, to: LATEST_SCHEMA_VERSION });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='browser_sessions'").pluck().get())
      .toBe(browserSchema);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connected_accounts'").pluck().get())
      .toBe('connected_accounts');
  });
});
