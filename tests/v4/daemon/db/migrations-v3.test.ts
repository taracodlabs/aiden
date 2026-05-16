/**
 * v4.5 Phase 3 — v3 migration (webhook_deliveries) tests.
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

describe('migrations v3', () => {
  it('creates webhook_deliveries table at LATEST_SCHEMA_VERSION', () => {
    runMigrations(db);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_deliveries'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('webhook_deliveries');
  });

  it('enforces UNIQUE(route_id, delivery_id) when delivery_id is not NULL', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
       VALUES ('r1', 'webhook', 'r', '{}', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    const now = Date.now();
    db.prepare(
      `INSERT INTO webhook_deliveries
         (route_id, delivery_id, signature_verified, status_code, body_hash, received_at)
       VALUES ('r1', 'dup-id', 1, 202, 'h', ?)`,
    ).run(now);
    expect(() => db.prepare(
      `INSERT INTO webhook_deliveries
         (route_id, delivery_id, signature_verified, status_code, body_hash, received_at)
       VALUES ('r1', 'dup-id', 1, 202, 'h', ?)`,
    ).run(now)).toThrow(/UNIQUE/);
  });

  it('allows multiple NULL delivery_ids (partial UNIQUE index)', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
       VALUES ('r1', 'webhook', 'r', '{}', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO webhook_deliveries
         (route_id, signature_verified, status_code, body_hash, received_at)
       VALUES ('r1', 0, 401, ?, ?)`,
    );
    expect(() => { ins.run('h1', now); ins.run('h2', now); }).not.toThrow();
  });

  it('idempotent on re-run', () => {
    runMigrations(db);
    const v = LATEST_SCHEMA_VERSION;
    const r = runMigrations(db);
    expect(r.from).toBe(v);
    expect(r.to).toBe(v);
  });
});
