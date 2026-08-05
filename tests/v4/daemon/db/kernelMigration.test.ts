/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDaemonDb, openDaemonDb } from '../../../../core/v4/daemon/db/connection';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS_FOR_TESTS,
  runMigrations,
} from '../../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../../core/v4/daemon/jobEngine';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function applyThrough(db: Database.Database, version: number): void {
  for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= version)) {
    db.transaction(() => {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql ?? '');
      db.prepare('INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)')
        .run(migration.version, Date.now());
    }).immediate();
  }
}

function tempDb(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'aiden-kernel-migration-'));
  roots.push(root);
  return { root, path: join(root, 'daemon.db') };
}

describe('kernel migration compatibility', () => {
  it('adds empty Effect bindings to existing Claims without changing their truth', () => {
    const db = new Database(':memory:');
    applyThrough(db, 41);
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO job_claims
         (claim_id, job_id, category, statement, required, state, created_at)
       VALUES ('claim_legacy', 'job_legacy', 'contract', 'legacy claim', 1, 'verified', 1)`,
    ).run();
    db.pragma('foreign_keys = ON');

    expect(runMigrations(db)).toEqual({ from: 41, to: LATEST_SCHEMA_VERSION });
    expect(db.prepare(
      `SELECT statement, required, state, effect_ids_json FROM job_claims WHERE claim_id='claim_legacy'`,
    ).get()).toEqual({
      statement: 'legacy claim',
      required: 1,
      state: 'verified',
      effect_ids_json: '[]',
    });
    db.close();
  });

  it('opens a populated v4.16-era database without changing terminal truth or queued input', () => {
    const location = tempDb();
    const legacy = new Database(location.path);
    legacy.pragma('foreign_keys = ON');
    applyThrough(legacy, 21);
    const now = Date.now();
    legacy.prepare(
      `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('legacy-instance', 1, 'localhost', ?, ?, '4.16.1')`,
    ).run(now, now);
    const engine = createJobEngine({ db: legacy });
    const admitted = engine.submitJob({
      entryPoint: 'legacy', source: 'legacy', sessionId: 'legacy-session', instanceId: 'legacy-instance',
      idempotencyNamespace: 'legacy', idempotencyKey: 'job', requestFingerprint: 'job', goal: 'legacy goal',
    });
    legacy.prepare(
      `UPDATE tasks SET status = 'completed', terminal_at = ?, terminal_outcome = 'verified',
         finish_reason = 'legacy_done', evidence = ?, active_attempt_id = NULL WHERE id = ?`,
    ).run(now, JSON.stringify({ preserved: true }), admitted.jobId);
    legacy.prepare(
      `UPDATE runs SET status = 'succeeded', completed_at = ?, ended_at = ? WHERE attempt_id = ?`,
    ).run(now, now, admitted.attemptId);
    legacy.prepare(
      `INSERT INTO durable_inputs (
         input_id, job_id, target_attempt_id, target_generation, session_id, source, sequence,
         kind, content, content_hash, state, idempotency_namespace, idempotency_key, created_at, updated_at
       ) VALUES ('input_legacy', ?, NULL, NULL, 'legacy-session', 'repl', 1,
                 'follow_up', 'preserve me', 'hash', 'queued', 'legacy', 'input', ?, ?)`,
    ).run(admitted.jobId, now, now);
    legacy.prepare(
      `INSERT INTO policy_snapshots (
         policy_snapshot_id, schema_version, digest, trust_level, autonomy_policy, approval_mode,
         tool_metadata_version, sandbox_policy_json, network_policy_json, plugin_grants_json,
         mcp_grants_json, workspace_overrides_json, job_overrides_json, created_at
       ) VALUES ('policy_legacy', 1, 'digest', 'Assistant', 'ask', 'smart', 'legacy', '{}', '{}', '[]', '[]', '{}', '{}', ?)`,
    ).run(now);
    legacy.prepare(
      `INSERT INTO approvals (
         approval_id, job_id, attempt_id, generation, tool_call_id, request_sequence, tool_name,
         risk_tier, risk_reasons_json, normalized_execution_plan, action_digest, policy_snapshot_id,
         state, requested_at
       ) VALUES ('approval_legacy', ?, ?, 1, 'tool_legacy', 1, 'file_write',
                 'caution', '[]', '{}', 'action', 'policy_legacy', 'approved', ?)`,
    ).run(admitted.jobId, admitted.attemptId, now);
    legacy.close();

    const upgraded = openDaemonDb(location.path);
    expect(upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get())
      .toEqual({ version: LATEST_SCHEMA_VERSION });
    expect(upgraded.prepare('SELECT status, terminal_outcome, finish_reason, evidence FROM tasks WHERE id = ?').get(admitted.jobId))
      .toEqual({ status: 'completed', terminal_outcome: 'verified', finish_reason: 'legacy_done', evidence: '{"preserved":true}' });
    expect(upgraded.prepare('SELECT content, state FROM durable_inputs WHERE input_id = ?').get('input_legacy'))
      .toEqual({ content: 'preserve me', state: 'queued' });
    expect(upgraded.prepare('SELECT state, fence_token_digest FROM approvals WHERE approval_id = ?').get('approval_legacy'))
      .toEqual({ state: 'approved', fence_token_digest: null });
    const backupPath = `${location.path}.pre-schema-v21.bak`;
    expect(existsSync(backupPath)).toBe(true);
    closeDaemonDb(location.path);
    const backup = new Database(backupPath, { readonly: true });
    expect(backup.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 21 });
    expect(backup.prepare('SELECT content FROM durable_inputs WHERE input_id = ?').get('input_legacy'))
      .toEqual({ content: 'preserve me' });
    backup.close();
  });

  it('rolls back an interrupted kernel migration and reruns cleanly', () => {
    const db = new Database(':memory:');
    applyThrough(db, 29);
    db.exec(`
      CREATE TRIGGER reject_cursor_version BEFORE INSERT ON schema_version
      WHEN NEW.version = 30 BEGIN SELECT RAISE(ABORT, 'cursor migration interrupted'); END;
    `);
    expect(() => runMigrations(db)).toThrow(/Migration 30 .*cursor migration interrupted/);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_event_cursors'").get()).toBeUndefined();
    expect(db.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 29 });
    db.exec('DROP TRIGGER reject_cursor_version');
    expect(runMigrations(db)).toEqual({ from: 29, to: LATEST_SCHEMA_VERSION });
    expect(runMigrations(db)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    db.close();
  });

  it('repairs a missing optional cursor projection but rejects missing canonical tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec('DROP TABLE job_event_cursors');
    expect(runMigrations(db)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_event_cursors'").get()).toBeDefined();
    db.exec('DROP TABLE durable_inputs');
    expect(() => runMigrations(db)).toThrow(/schema is incomplete.*durable_inputs/i);
    db.close();
  });
});
