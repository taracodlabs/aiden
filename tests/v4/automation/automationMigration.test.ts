import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importLegacyScheduledWorkflows } from '../../../core/v4/automation/legacyMigration';
import { createAutomationAuthority } from '../../../core/v4/automation/automationAuthority';
import { createAutomationControlAuthority } from '../../../core/v4/automation/controlAuthority';
import { LATEST_SCHEMA_VERSION, MIGRATIONS_FOR_TESTS, runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';

describe('legacy schedule compatibility import', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => db.close());

  it('imports scheduled_workflows once, preserves due time, and never stores an executable shell spec', () => {
    const due = Date.parse('2026-08-22T03:30:00.000Z');
    db.prepare(
      `INSERT INTO scheduled_workflows (
        id,name,schedule_expression,timezone,enabled,payload_json,prompt_template,deliver_only,
        misfire_policy,fire_rate_limit,catch_up_limit,grace_ms,last_fired_at,next_fire_at,created_at,updated_at
      ) VALUES ('legacy-1','Legacy','cron:0 9 * * *','Asia/Kolkata',1,?,NULL,0,'run_once_if_late',NULL,NULL,60000,NULL,?,?,?)`,
    ).run(JSON.stringify({ action: 'read package.json', description: 'Legacy' }), due, due - 1000, due - 1000);

    expect(importLegacyScheduledWorkflows({ db, now: due })).toMatchObject({ imported: 1, existing: 0, skipped: 0 });
    expect(importLegacyScheduledWorkflows({ db, now: due + 1 })).toMatchObject({ imported: 0, existing: 1, skipped: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT next_fire_at FROM automation_trigger_bindings').get()).toEqual({ next_fire_at: '2026-08-22T03:30:00.000Z' });
    const revision = db.prepare('SELECT spec_json FROM automation_revisions').get() as { spec_json: string };
    expect(JSON.parse(revision.spec_json)).toMatchObject({ action: { kind: 'prompt', prompt: 'read package.json' } });
    expect(revision.spec_json).not.toContain('shell');
  });

  it('projects later legacy CLI edits through a new immutable revision instead of reviving a second scheduler', () => {
    const due = Date.parse('2026-08-22T03:30:00.000Z');
    db.prepare(
      `INSERT INTO scheduled_workflows (
        id,name,schedule_expression,timezone,enabled,payload_json,prompt_template,deliver_only,
        misfire_policy,fire_rate_limit,catch_up_limit,grace_ms,last_fired_at,next_fire_at,created_at,updated_at
      ) VALUES ('legacy-edit','Legacy','cron:0 9 * * *','Asia/Kolkata',1,?,NULL,0,
        'run_once_if_late',NULL,NULL,60000,NULL,?,?,?)`,
    ).run(JSON.stringify({ action: 'first prompt' }), due, due - 1000, due - 1000);
    const first = importLegacyScheduledWorkflows({ db, now: due });
    expect(first).toMatchObject({ imported: 1 });

    db.prepare(
      `UPDATE scheduled_workflows
          SET schedule_expression = 'cron:0 10 * * *',payload_json = ?,enabled = 0,updated_at = ?
        WHERE id = 'legacy-edit'`,
    ).run(JSON.stringify({ action: 'revised prompt' }), due + 1);
    expect(importLegacyScheduledWorkflows({ db, now: due + 2 })).toMatchObject({ updated: 1, skipped: 0 });

    expect(db.prepare('SELECT enabled FROM automation_definitions').get()).toEqual({ enabled: 0 });
    const revisions = db.prepare('SELECT revision_number,spec_json FROM automation_revisions ORDER BY revision_number')
      .all() as Array<{ revision_number: number; spec_json: string }>;
    expect(revisions).toHaveLength(2);
    expect(revisions.map((row) => JSON.parse(row.spec_json))).toEqual([
      expect.objectContaining({ action: { kind: 'prompt', prompt: 'first prompt' } }),
      expect.objectContaining({
        action: { kind: 'prompt', prompt: 'revised prompt' },
        trigger: { kind: 'schedule', expression: 'cron:0 10 * * *', timezone: 'Asia/Kolkata' },
      }),
    ]);
  });

  it('rolls back an interrupted import before its receipt and converges exactly once after restart', () => {
    const due = Date.parse('2026-08-22T03:30:00.000Z');
    db.prepare(
      `INSERT INTO scheduled_workflows (
        id,name,schedule_expression,timezone,enabled,payload_json,prompt_template,deliver_only,
        misfire_policy,fire_rate_limit,catch_up_limit,grace_ms,last_fired_at,next_fire_at,created_at,updated_at
      ) VALUES ('legacy-crash','Legacy crash','cron:0 9 * * *','Asia/Kolkata',1,?,NULL,0,
        'run_once_if_late',NULL,NULL,60000,NULL,?,?,?)`,
    ).run(JSON.stringify({ action: 'inspect package.json' }), due, due - 1000, due - 1000);
    db.exec(`CREATE TRIGGER fail_legacy_receipt BEFORE INSERT ON automation_migration_receipts
      BEGIN SELECT RAISE(ABORT, 'injected migration interruption'); END;`);

    expect(importLegacyScheduledWorkflows({ db, now: due })).toMatchObject({ imported: 0, skipped: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_revisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_migration_receipts').get()).toEqual({ count: 0 });

    db.exec('DROP TRIGGER fail_legacy_receipt');
    expect(importLegacyScheduledWorkflows({ db, now: due + 1 })).toMatchObject({ imported: 1, skipped: 0 });
    expect(importLegacyScheduledWorkflows({ db, now: due + 2 })).toMatchObject({ imported: 0, existing: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_revisions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_migration_receipts').get()).toEqual({ count: 1 });
  });

  it('deduplicates provider webhook deliveries through one bound TriggerBus identity', () => {
    const created = createAutomationAuthority({ db }).create({
      name: 'Webhook', action: { kind: 'prompt', prompt: 'Process event' },
      trigger: { kind: 'webhook', bindingId: 'provider-hook-1' },
      policies: { misfire: { kind: 'skip' }, overlap: 'queue', retry: { maxAttempts: 2 } },
      capabilities: [], credentialRefs: [], createdBy: 'test',
    });
    const binding = db.prepare('SELECT binding_id FROM automation_trigger_bindings WHERE automation_id = ?')
      .get(created.definition.id) as { binding_id: string };
    const control = createAutomationControlAuthority({ db, triggerBus: createTriggerBus({ db }) });
    expect(control.emitBound({ bindingId: 'provider-hook-1', providerEventId: 'event-42', payload: { subject: 'hello' } }).inserted).toBe(true);
    expect(control.emitBound({ bindingId: binding.binding_id, providerEventId: 'event-42', payload: { subject: 'hello' } }).inserted).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM trigger_events').get()).toEqual({ count: 1 });
    const event = db.prepare('SELECT payload_json FROM trigger_events').get() as { payload_json: string };
    expect(JSON.parse(event.payload_json)).toMatchObject({ untrustedContent: true });
  });

  it('upgrades an already-applied v48 database with durable approval continuations', () => {
    const legacy = new Database(':memory:');
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 48)) {
      legacy.transaction(() => {
        if (migration.apply) migration.apply(legacy);
        else legacy.exec(migration.sql ?? '');
        legacy.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)')
          .run(migration.version, 1);
      }).immediate();
    }
    expect(legacy.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='automation_approval_continuations'",
    ).get()).toBeUndefined();
    expect(runMigrations(legacy)).toEqual({ from: 48, to: LATEST_SCHEMA_VERSION });
    expect(legacy.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='automation_approval_continuations'",
    ).get()).toEqual({ name: 'automation_approval_continuations' });
    legacy.close();
  });
});
