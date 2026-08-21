/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { LATEST_SCHEMA_VERSION, MIGRATIONS_FOR_TESTS, runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';

describe('Worker persistence migration', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => db.close());

  const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);

  it('adds only the five v37 Worker contract tables', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 36)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql ?? '');
        db.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)').run(migration.version, 1);
      })();
    }
    const before = new Set(tables());
    const migration = MIGRATIONS_FOR_TESTS.find((entry) => entry.version === 37)!;
    db.transaction(() => {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql ?? '');
      db.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,37,1)').run();
    })();
    expect(tables().filter((table) => !before.has(table))).toEqual([
      'worker_assignments', 'worker_context_envelopes', 'worker_provider_bindings', 'worker_results', 'worker_runs',
    ]);
  });

  it('upgrades v37 additively with provider-call and reservation records', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 37)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql ?? '');
        db.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)').run(migration.version, 1);
      })();
    }
    const before = new Set(tables());
    const migration = MIGRATIONS_FOR_TESTS.find((entry) => entry.version === 38)!;
    db.transaction(() => {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql ?? '');
      db.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,38,1)').run();
    })();
    expect(tables().filter((table) => !before.has(table))).toEqual([
      'job_budget_reservation_commits', 'job_budget_reservation_items', 'job_budget_reservations',
      'worker_logical_provider_calls', 'worker_provider_tool_links',
    ]);
    expect(columns('worker_provider_bindings')).toEqual(expect.arrayContaining([
      'supports_tool_calling', 'supports_streaming', 'catalog_digest', 'fallback_binding_ids_json',
    ]));
  });

  it('upgrades v38 additively with reconciliation facts and keeps existing rows readable', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 38)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql ?? '');
        db.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)').run(migration.version, 1);
      })();
    }
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO worker_logical_provider_calls (
         logical_call_id,schema_version,idempotency_key,worker_run_id,assignment_id,provider_binding_id,
         child_job_id,child_attempt_id,child_generation,call_ordinal,request_hash,tool_schema_hash,
         provider_id,model_id,state,outcome_known,created_at,updated_at
       ) VALUES ('logical_existing',1,'existing','run','assignment','binding','job','attempt',1,1,?,?,
                 'provider','model','prepared',0,1,1)`,
    ).run('a'.repeat(64), 'b'.repeat(64));
    db.pragma('foreign_keys = ON');
    const before = new Set(tables());
    expect(runMigrations(db)).toEqual({ from: 38, to: LATEST_SCHEMA_VERSION });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(40);
    expect(tables().filter((table) => !before.has(table))).toEqual([
      'browser_action_receipts',
      'browser_navigation_history',
      'browser_sessions',
      'browser_tabs',
      'connected_accounts',
      'continuity_actions',
      'continuity_checkpoints',
      'external_coding_capability_snapshots',
      'external_coding_events',
      'external_coding_inputs',
      'external_coding_mutation_receipts',
      'external_coding_processes',
      'external_coding_promotion_plans',
      'external_coding_raw_output',
      'external_coding_repository_locks',
      'external_coding_sessions',
      'external_coding_workspace_leases',
      'integration_action_receipts',
      'integration_action_schemas',
      'integration_connection_sessions',
      'integration_job_account_bindings',
      'integration_provider_credentials',
      'integration_secret_handles',
      'integration_trigger_cursors',
      'job_budget_reservation_reconciliations',
      'worker_group_members',
      'worker_groups',
      'worker_provider_call_reconciliations',
      'worker_provider_concurrency_reservations',
      'worker_provider_late_responses',
    ]);
    expect(columns('worker_logical_provider_calls')).toEqual(expect.arrayContaining([
      'reconciliation_state', 'outcome_knowledge', 'retry_safety', 'interruption_kind',
      'cancellation_requested_at', 'timeout_requested_at', 'authority_lost_at',
      'stale_response_rejected_at', 'late_response_observed_at', 'reconciled_at',
    ]));
    expect(db.prepare(
      `SELECT reconciliation_state,outcome_knowledge,retry_safety
         FROM worker_logical_provider_calls WHERE logical_call_id='logical_existing'`,
    ).get()).toEqual({
      reconciliation_state: 'not_required', outcome_knowledge: 'no_request_started', retry_safety: 'not_applicable',
    });
  });

  it('keeps WorkerRun as a relation without lifecycle, lease, fence, cancellation, or budget authority', () => {
    runMigrations(db);
    const names = columns('worker_runs');
    expect(names).toEqual(expect.arrayContaining([
      'worker_run_id', 'assignment_id', 'child_job_id', 'child_attempt_id', 'child_generation',
      'execution_graph_node_id', 'provider_binding_id', 'context_envelope_id', 'accepted_result_id', 'created_at',
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      'status', 'lifecycle_state', 'lease_id', 'lease_owner', 'lease_expiry', 'fence_token',
      'cancellation_state', 'budget_remaining', 'effect_state', 'approval_state',
      'verification_state', 'verdict_state', 'proof_state',
    ]));
  });

  it('creates no duplicate Worker authority tables', () => {
    runMigrations(db);
    const forbidden = [
      'worker_leases', 'worker_budgets', 'worker_cancellations', 'worker_evidence', 'worker_verdicts',
      'worker_proofs', 'worker_effects', 'worker_approvals', 'worker_queue', 'worker_scheduler',
      'worker_process_supervisor', 'worker_graphs',
    ];
    expect(tables().filter((name) => forbidden.includes(name))).toEqual([]);
  });

  it('upgrades an existing v36 database and keeps Jobs without Worker rows readable', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 36)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql ?? '');
        db.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)').run(migration.version, 1);
      })();
    }
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('fixture',1,'localhost',1,1,'4.18.0')`,
    ).run();
    const before = createJobEngine({ db }).submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'fixture', instanceId: 'fixture',
      idempotencyNamespace: 'fixture', idempotencyKey: 'job', goal: 'legacy job',
    });

    expect(runMigrations(db)).toEqual({ from: 36, to: LATEST_SCHEMA_VERSION });
    const engine = createJobEngine({ db });
    expect(engine.getJob(before.jobId)?.goal).toBe('legacy job');
    expect(engine.worker.listWorkerRunsForParent(before.jobId)).toEqual([]);
  });

  it('is idempotent when the latest schema is already installed', () => {
    expect(runMigrations(db)).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION });
    expect(runMigrations(db)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(40);
    expect(tables()).toEqual(expect.arrayContaining([
      'worker_groups', 'worker_group_members', 'worker_provider_concurrency_reservations',
    ]));
  });

  it('upgrades v39 additively and preserves reconciliation rows on reopen', () => {
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 39)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql ?? '');
        db.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)')
          .run(migration.version, 1);
      })();
    }
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO worker_provider_call_reconciliations
         (reconciliation_id,logical_call_id,idempotency_key,worker_run_id,child_job_id,child_attempt_id,
          child_generation,reason,outcome_knowledge,retry_safety,physical_attempt_ids_json,
          unknown_spend,unsettled_downstream,state,created_at)
       VALUES ('reconciliation_existing','call_existing','existing','run_existing','job_existing','attempt_existing',
               1,'restart','outcome_unknown','blocked_unknown','[]',1,0,'blocked_unknown',1)`,
    ).run();
    db.pragma('foreign_keys = ON');
    expect(runMigrations(db)).toEqual({ from: 39, to: LATEST_SCHEMA_VERSION });
    expect(db.prepare(
      `SELECT outcome_knowledge,retry_safety,unknown_spend
         FROM worker_provider_call_reconciliations WHERE reconciliation_id='reconciliation_existing'`,
    ).get()).toEqual({ outcome_knowledge: 'outcome_unknown', retry_safety: 'blocked_unknown', unknown_spend: 1 });
    expect(runMigrations(db)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
  });
});
