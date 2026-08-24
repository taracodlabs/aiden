import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { createWorkbenchAutomationPort } from '../../../core/v4/workbench/automationPort';

describe('Workbench reliable automation port', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => db.close());

  it('fails closed in Community without weakening safety capabilities', () => {
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('community'),
    });
    expect(port.snapshot().capability).toMatchObject({ available: false });
    expect(() => port.create({
      name: 'No', action: { kind: 'prompt', prompt: 'No' }, trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [], createdBy: 'test',
    })).toThrow(/Pro/);
  });

  it('creates, previews, pauses and manually enqueues without exposing credentials', () => {
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('pro'),
      workspaceRoot: process.cwd(),
    });
    const created = port.create({
      name: 'Daily', action: { kind: 'prompt', prompt: 'Summarize' },
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'Asia/Kolkata' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'queue', retry: { maxAttempts: 2 } },
      capabilities: ['repository.read'], credentialRefs: [], createdBy: 'test',
    });
    expect(port.preview({ expression: '0 9 * * *', timezone: 'Asia/Kolkata' })).toHaveLength(5);
    expect(port.runNow(created.automationId).triggerEventId).toBeGreaterThan(0);
    db.prepare(
      `INSERT INTO automation_occurrences (
         occurrence_id,occurrence_key,automation_id,revision_id,trigger_kind,source_identity,
         scheduled_for,triggered_at,admitted_at,state,created_at,updated_at
       ) VALUES ('occurrence_history','key-history',?,?, 'manual','manual-history',NULL,1000,NULL,'detected',1000,1000)`,
    ).run(created.automationId, created.revisionId);
    expect(port.setEnabled(created.automationId, false).enabled).toBe(false);
    const snapshot = port.snapshot();
    expect(snapshot.automations).toHaveLength(1);
    expect(snapshot.history).toEqual([
      expect.objectContaining({
        occurrenceId: 'occurrence_history', automationId: created.automationId,
        revisionId: created.revisionId, triggeredAt: 1000, state: 'detected',
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/password|accessToken|secretHandle/i);
    const row = db.prepare(
      `SELECT r.spec_json FROM automation_revisions r
        JOIN automation_definitions d ON d.current_revision_id = r.revision_id
       WHERE d.automation_id = ?`,
    ).get(created.automationId) as { spec_json: string };
    expect(JSON.parse(row.spec_json)).toMatchObject({ workspace: { rootPath: process.cwd() } });
  });

  it('edits through a new immutable revision while preserving the automation identity', () => {
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('pro'),
      workspaceRoot: process.cwd(),
    });
    const created = port.create({
      name: 'Morning brief', createdBy: 'test',
      action: { kind: 'prompt', prompt: 'Original prompt' },
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'UTC' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'queue', retry: { maxAttempts: 2 } },
      capabilities: ['repository.read'], credentialRefs: [],
    });

    const revised = port.revise(created.automationId, {
      createdBy: 'workbench', action: { kind: 'prompt', prompt: 'Updated prompt' },
      trigger: { kind: 'schedule', expression: '0 10 * * *', timezone: 'Europe/Tallinn' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 2 } },
      capabilities: ['repository.read'], credentialRefs: [],
    });

    expect(revised).toMatchObject({ automationId: created.automationId, revisionNumber: 2 });
    expect(revised.revisionId).not.toBe(created.revisionId);
    expect(revised.action).toEqual({ kind: 'prompt', prompt: 'Updated prompt' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_revisions WHERE automation_id = ?').get(created.automationId)).toEqual({ count: 2 });
  });
});
