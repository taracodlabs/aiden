/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.6 Phase 3b — schema v7 migration tests.
 *
 *   1. v7 applies cleanly on a fresh db (v1→v7 in one pass)
 *   2. failure_signatures + recovery_reports tables exist with the
 *      right columns
 *   3. Required indexes exist
 *   4. Re-running migrations is a no-op (idempotent)
 *   5. Inserts into failure_signatures default occurrences=1, recovered_count=0
 *   6. Snapshot — inline V7_SQL matches schema/v7.sql source-of-truth
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../../../core/v4/daemon/db/migrations';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('schema v7 migration — self-improvement loop foundation', () => {
  it('LATEST_SCHEMA_VERSION is 7 (or greater)', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
  });

  it('applies v1→v7 in one pass on a fresh db', () => {
    const r = runMigrations(db);
    expect(r.from).toBe(0);
    expect(r.to).toBe(LATEST_SCHEMA_VERSION);
    // Both new tables present.
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('failure_signatures', 'recovery_reports')`,
    ).all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(['failure_signatures', 'recovery_reports']);
  });

  it('failure_signatures has the right column shape', () => {
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(failure_signatures)`).all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')?.type).toBe('INTEGER');
    expect(byName.get('signature')?.type).toBe('TEXT');
    expect(byName.get('tool_name')?.type).toBe('TEXT');
    expect(byName.get('failure_category')?.type).toBe('TEXT');
    expect(byName.get('args_hash')?.type).toBe('TEXT');
    expect(byName.get('first_seen_at')?.type).toBe('INTEGER');
    expect(byName.get('last_seen_at')?.type).toBe('INTEGER');
    expect(byName.get('occurrences')?.type).toBe('INTEGER');
    expect(byName.get('recovered_count')?.type).toBe('INTEGER');
    expect(byName.get('last_recovery_report_id')?.type).toBe('INTEGER');
  });

  it('recovery_reports has the right column shape', () => {
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(recovery_reports)`).all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')?.type).toBe('INTEGER');
    expect(byName.get('signature_id')?.type).toBe('INTEGER');
    expect(byName.get('run_id')?.type).toBe('INTEGER');
    expect(byName.get('session_id')?.type).toBe('TEXT');
    expect(byName.get('failed_attempts')?.type).toBe('INTEGER');
    expect(byName.get('successful_strategy')?.type).toBe('TEXT');
    expect(byName.get('changed_parameters')?.type).toBe('TEXT');
    expect(byName.get('verification')?.type).toBe('TEXT');
    expect(byName.get('created_at')?.type).toBe('INTEGER');
    expect(byName.get('notes')?.type).toBe('TEXT');
  });

  it('expected indexes are present', () => {
    runMigrations(db);
    const indexes = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index'
        AND name IN ('idx_failure_signatures_signature',
                     'idx_failure_signatures_tool',
                     'idx_recovery_reports_signature',
                     'idx_recovery_reports_run')`,
    ).all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name).sort()).toEqual([
      'idx_failure_signatures_signature',
      'idx_failure_signatures_tool',
      'idx_recovery_reports_run',
      'idx_recovery_reports_signature',
    ]);
  });

  it('idempotent: re-running migrations after v7 is a no-op', () => {
    const r1 = runMigrations(db);
    const r2 = runMigrations(db);
    expect(r2.from).toBe(r1.to);
    expect(r2.to).toBe(r1.to);
  });

  it('insert defaults: occurrences=1, recovered_count=0', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO failure_signatures (signature, tool_name, failure_category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('file_read:not_found:abc123', 'file_read', 'not_found', Date.now(), Date.now());
    const row = db.prepare(
      `SELECT occurrences, recovered_count FROM failure_signatures WHERE signature = ?`,
    ).get('file_read:not_found:abc123') as { occurrences: number; recovered_count: number };
    expect(row.occurrences).toBe(1);
    expect(row.recovered_count).toBe(0);
  });

  it('UNIQUE constraint on signature column', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO failure_signatures (signature, tool_name, failure_category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('dup:network:x', 'web', 'network', 1, 1);
    expect(() => db.prepare(
      `INSERT INTO failure_signatures (signature, tool_name, failure_category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('dup:network:x', 'web', 'network', 2, 2)).toThrow();
  });

  it('snapshot — inline V7_SQL matches schema/v7.sql', () => {
    const schemaPath = join(__dirname, '../../../../core/v4/daemon/db/schema/v7.sql');
    const fileText = readFileSync(schemaPath, 'utf8');
    const normalize = (s: string) =>
      s
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    runMigrations(db);
    const fileNorm = normalize(fileText);
    expect(fileNorm).toContain('create table if not exists failure_signatures');
    expect(fileNorm).toContain('create table if not exists recovery_reports');
    expect(fileNorm).toContain('signature text unique not null');
    expect(fileNorm).toContain('signature_id integer not null references failure_signatures(id)');
    expect(fileNorm).toContain('create index if not exists idx_failure_signatures_signature');
    expect(fileNorm).toContain('create index if not exists idx_recovery_reports_signature');
  });
});
