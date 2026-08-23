/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS_FOR_TESTS,
  runMigrations,
} from '../../../core/v4/daemon/db/migrations';

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe('Capability SDK migration v52', () => {
  it('upgrades v51 additively with immutable identities, scoped grants and host-bound receipts', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 51)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db!);
        else db!.exec(migration.sql ?? '');
        db!.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)')
          .run(migration.version, 1);
      }).immediate();
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_versions'").get())
      .toBeUndefined();

    expect(runMigrations(db)).toEqual({ from: 51, to: LATEST_SCHEMA_VERSION });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(52);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'capability_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'capability_activation_history',
      'capability_active_versions',
      'capability_grants',
      'capability_health',
      'capability_invocations',
      'capability_packages',
      'capability_versions',
    ]);
    const columns = db.prepare('PRAGMA table_info(capability_invocations)').all() as Array<{ name: string }>;
    expect(columns.map((row) => row.name)).toEqual(expect.arrayContaining([
      'host_instance_id', 'host_pid', 'host_start_time', 'fence_token_hash', 'state_version',
    ]));
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_capability_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      'idx_capability_activation_history',
      'idx_capability_grants_identity',
      'idx_capability_invocations_identity',
      'idx_capability_invocations_job',
      'idx_capability_version_identity',
    ]));
    expect(runMigrations(db)).toEqual({
      from: LATEST_SCHEMA_VERSION,
      to: LATEST_SCHEMA_VERSION,
    });
  });
});
