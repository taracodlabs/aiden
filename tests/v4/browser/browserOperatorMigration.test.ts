import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS_FOR_TESTS,
  runMigrations,
} from '../../../core/v4/daemon/db/migrations';

describe('browser operator migration', () => {
  it('adds the durable browser authority to the existing database', () => {
    const db = new Database(':memory:');
    try {
      expect(runMigrations(db)).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION });
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        'browser_sessions',
        'browser_tabs',
        'browser_action_receipts',
        'browser_navigation_history',
      ]));
      expect(MIGRATIONS_FOR_TESTS.find((migration) => migration.version === 44)?.name)
        .toContain('browser operator');
      expect(runMigrations(db)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    } finally {
      db.close();
    }
  });
});
