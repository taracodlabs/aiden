/**
 * v4.5 Phase 1 — schema migration runner tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS_FOR_TESTS,
} from '../../../../core/v4/daemon/db/migrations';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
});

describe('runMigrations', () => {
  it('applies v1 schema on fresh database', () => {
    const result = runMigrations(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — second run is a no-op', () => {
    runMigrations(db);
    const result = runMigrations(db);
    expect(result.from).toBe(LATEST_SCHEMA_VERSION);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
  });

  it('upgrades a v42 database without changing existing ledger records', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((item) => item.version <= 42)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql ?? '');
        db.prepare('INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)')
          .run(migration.version, migration.version);
      }).immediate();
    }
    db.prepare(
      `INSERT INTO trigger_events
         (source, source_key, idempotency_key, payload_json, status, created_at, updated_at)
       VALUES ('manual', 'continuity-migration', 'existing-record', '{}', 'pending', 1, 1)`,
    ).run();

    expect(runMigrations(db)).toEqual({ from: 42, to: 43 });
    expect(db.prepare("SELECT source_key FROM trigger_events WHERE idempotency_key='existing-record'").pluck().get())
      .toBe('continuity-migration');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='continuity_checkpoints'").pluck().get())
      .toBe('continuity_checkpoints');
  });

  it('creates all v1 tables', () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('schema_version');
    expect(names).toContain('daemon_instances');
    expect(names).toContain('trigger_events');
    expect(names).toContain('runs');
    expect(names).toContain('run_events');
    expect(names).toContain('idempotency_keys');
    expect(names).toContain('crash_reports');
    expect(names).toContain('restart_failure_counts');
    expect(names).toContain('triggers');
    expect(names).toContain('child_job_contracts');
    expect(names).toContain('job_budgets');
    expect(names).toContain('job_budget_debits');
    expect(names).toContain('job_capability_sets');
    expect(names).toContain('job_claims');
    expect(names).toContain('job_evidence');
    expect(names).toContain('job_verdicts');
    expect(names).toContain('proof_reviews');
    expect(names).toContain('job_event_cursors');
    expect(names).toContain('repository_change_intents');
    expect(names).toContain('repository_change_records');
  });

  it('enforces trigger_events UNIQUE(source, idempotency_key) when key present', () => {
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO trigger_events
         (source, source_key, idempotency_key, payload_json, status, created_at, updated_at)
       VALUES ('webhook', 'wh1', 'dup-key', '{}', 'pending', ?, ?)`,
    ).run(now, now);
    // Same idem_key + source → INSERT OR IGNORE should not raise but
    // change count 0. We just verify the unique index by direct INSERT
    // (without IGNORE) raises.
    expect(() => db.prepare(
      `INSERT INTO trigger_events
         (source, source_key, idempotency_key, payload_json, status, created_at, updated_at)
       VALUES ('webhook', 'wh1', 'dup-key', '{}', 'pending', ?, ?)`,
    ).run(now, now)).toThrow(/UNIQUE/);
  });

  it('allows multiple NULL idempotency_keys (partial unique index)', () => {
    runMigrations(db);
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO trigger_events
         (source, source_key, idempotency_key, payload_json, status, created_at, updated_at)
       VALUES ('manual', 'm1', NULL, '{}', 'pending', ?, ?)`,
    );
    expect(() => { ins.run(now, now); ins.run(now, now); }).not.toThrow();
  });

  it('records applied_at in schema_version', () => {
    runMigrations(db);
    const row = db.prepare('SELECT * FROM schema_version').get() as { version: number; applied_at: number };
    expect(row.version).toBe(LATEST_SCHEMA_VERSION);
    expect(row.applied_at).toBeGreaterThan(0);
  });

  it('adds durable TriggerBus claim fencing without changing existing events', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((item) => item.version <= 40)) {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql ?? '');
      db.prepare(
        'INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)',
      ).run(migration.version, Date.now());
    }
    const now = Date.now();
    db.prepare(
      `INSERT INTO trigger_events
         (source,source_key,payload_json,status,attempts,claim_owner,claim_expires_at,created_at,updated_at)
       VALUES ('manual','preserved','{"value":1}','claimed',1,'legacy-owner',?,?,?)`,
    ).run(now + 60_000, now, now);

    expect(runMigrations(db)).toEqual({ from: 40, to: LATEST_SCHEMA_VERSION });
    expect(db.prepare(
      'SELECT source_key,payload_json,status,claim_owner,claim_token FROM trigger_events WHERE source_key=?',
    ).get('preserved')).toEqual({
      source_key: 'preserved',
      payload_json: '{"value":1}',
      status: 'claimed',
      claim_owner: 'legacy-owner',
      claim_token: null,
    });
  });
});
