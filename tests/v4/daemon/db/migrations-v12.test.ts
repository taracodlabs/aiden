/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12b — schema v12 migration test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../../../core/v4/daemon/db/migrations';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); });
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('schema v12 migration — hook auto-disable counter', () => {
  it('LATEST_SCHEMA_VERSION is 12+', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
  });

  it('hooks table has consecutive_failures column defaulting to 0', () => {
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(hooks)`).all() as Array<{ name: string; type: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'consecutive_failures');
    expect(col).toBeDefined();
    expect(col?.type).toBe('INTEGER');
    expect(col?.dflt_value).toBe('0');
  });

  it('insert into hooks defaults consecutive_failures = 0', () => {
    runMigrations(db);
    db.prepare(`INSERT INTO hooks (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
      VALUES ('h1','d','global','subprocess','/p','c',0,'untrusted','t','t')`).run();
    const row = db.prepare(`SELECT consecutive_failures FROM hooks WHERE hook_id='h1'`).get() as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(0);
  });

  it('idempotent — re-running migrations is a no-op', () => {
    const r1 = runMigrations(db);
    const r2 = runMigrations(db);
    expect(r2.from).toBe(r1.to);
    expect(r2.to).toBe(r1.to);
  });
});
