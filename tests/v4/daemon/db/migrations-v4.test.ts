/**
 * v4.5 Phase 4a — v4 migration (email_seen) tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../../../core/v4/daemon/db/migrations';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('migrations v4', () => {
  it('creates email_seen table at LATEST_SCHEMA_VERSION', () => {
    runMigrations(db);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_seen'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('email_seen');
  });

  it('enforces UNIQUE(route_id, uid_validity, uid)', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
       VALUES ('e1', 'email', 'e', '{}', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    const insert = db.prepare(
      `INSERT INTO email_seen (route_id, mailbox, uid_validity, uid, received_at, status)
       VALUES ('e1', 'INBOX', 1, 42, ?, 'processed')`,
    );
    insert.run(Date.now());
    expect(() => insert.run(Date.now())).toThrow(/UNIQUE/);
  });

  it('FK cascade triggers → email_seen', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
       VALUES ('e1', 'email', 'e', '{}', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.prepare(
      `INSERT INTO email_seen (route_id, mailbox, uid_validity, uid, received_at, status)
       VALUES ('e1', 'INBOX', 1, 1, ?, 'processed')`,
    ).run(Date.now());
    db.prepare('DELETE FROM triggers WHERE id = ?').run('e1');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM email_seen').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('idempotent re-run', () => {
    runMigrations(db);
    const v = LATEST_SCHEMA_VERSION;
    const r = runMigrations(db);
    expect(r.from).toBe(v);
    expect(r.to).toBe(v);
  });
});
