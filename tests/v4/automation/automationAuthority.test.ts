import Database from 'better-sqlite3';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutomationAuthority } from '../../../core/v4/automation/automationAuthority';
import { createOccurrenceAuthority } from '../../../core/v4/automation/occurrenceAuthority';
import { computeOccurrenceKey } from '../../../core/v4/automation/occurrenceKey';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';

describe('reliable automation authority', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('automation-instance',1,'localhost',?,?,'4.20.0')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  function createScheduledAutomation() {
    const authority = createAutomationAuthority({ db });
    return authority.create({
      name: 'Daily repository summary',
      action: { kind: 'prompt', prompt: 'Summarize the repository.' },
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'Asia/Kolkata' },
      policies: {
        misfire: { kind: 'run_once', maxAgeMs: 86_400_000 },
        overlap: 'queue',
        retry: { maxAttempts: 2 },
      },
      capabilities: ['repository.read'],
      credentialRefs: [],
      workspace: { rootPath: process.cwd() },
      createdBy: 'test-user',
      ownerId: 'owner-a',
      workspaceId: 'workspace-a',
      budget: { runtimeMs: 60_000, modelCalls: 2, toolCalls: 8 },
      now: 1_700_000_000_000,
    });
  }

  it('persists immutable revisions and retains historical timezone truth', () => {
    const created = createScheduledAutomation();
    const authority = createAutomationAuthority({ db });
    const updated = authority.revise(created.definition.id, {
      ...created.revision.spec,
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'America/New_York' },
    }, { createdBy: 'test-user', now: 1_700_000_100_000 });

    expect(updated.revision.revisionNumber).toBe(2);
    expect(created.definition).toMatchObject({
      ownerId: 'owner-a', workspaceId: 'workspace-a', commercialContext: 'pro',
    });
    expect(authority.getRevision(created.revision.id)?.spec.trigger).toEqual({
      kind: 'schedule', expression: '0 9 * * *', timezone: 'Asia/Kolkata',
    });
    expect(() => db.prepare(
      'UPDATE automation_revisions SET spec_json = ? WHERE revision_id = ?',
    ).run('{}', created.revision.id)).toThrow(/immutable/i);
  });

  it('computes the same deterministic occurrence key for the same logical instant', () => {
    const a = computeOccurrenceKey({
      automationId: 'automation_a', revisionId: 'revision_a', triggerKind: 'schedule',
      scheduledFor: '2026-10-25T05:30:00.000Z', sourceIdentity: 'fold-1',
    });
    const b = computeOccurrenceKey({
      sourceIdentity: 'fold-1', scheduledFor: '2026-10-25T05:30:00.000Z',
      triggerKind: 'schedule', revisionId: 'revision_a', automationId: 'automation_a',
    });
    expect(a).toBe(b);
  });

  it('admits exactly one Job for duplicate scans and duplicate TriggerBus receipts', () => {
    const created = createScheduledAutomation();
    const bus = createTriggerBus({ db });
    const event = bus.insert({
      source: 'schedule', sourceKey: created.definition.id,
      idempotencyKey: 'scheduled:2026-08-21T03:30:00.000Z',
      payload: {
        automationId: created.definition.id,
        revisionId: created.revision.id,
        scheduledFor: '2026-08-21T03:30:00.000Z',
      },
    });
    const duplicate = bus.insert({
      source: 'schedule', sourceKey: created.definition.id,
      idempotencyKey: 'scheduled:2026-08-21T03:30:00.000Z',
      payload: {},
    });
    expect(duplicate).toEqual({ id: event.id, inserted: false });

    const claimed = bus.claim({ source: 'schedule', ownerId: 'scheduler-a', leaseMs: 60_000 });
    if (!claimed) throw new Error('expected claim');
    const occurrences = createOccurrenceAuthority({ db, jobEngine: engine });
    const first = occurrences.admitClaimed({
      triggerEventId: claimed.id, claimToken: claimed.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'schedule', scheduledFor: '2026-08-21T03:30:00.000Z',
      sourceIdentity: 'scheduled:2026-08-21T03:30:00.000Z',
      instanceId: 'automation-instance', now: 1_700_000_200_000,
    });
    if (first.disposition !== 'admitted') throw new Error('expected admission');
    const second = occurrences.admitClaimed({
      triggerEventId: claimed.id, claimToken: claimed.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'schedule', scheduledFor: '2026-08-21T03:30:00.000Z',
      sourceIdentity: 'scheduled:2026-08-21T03:30:00.000Z',
      instanceId: 'automation-instance', now: 1_700_000_200_001,
    });
    if (second.disposition !== 'admitted') throw new Error('expected reused admission');

    expect(second.occurrenceId).toBe(first.occurrenceId);
    expect(second.jobId).toBe(first.jobId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_occurrences').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE automation_occurrence_id = ?').get(first.occurrenceId)).toEqual({ count: 1 });
    expect(db.prepare(
      'SELECT triggered_at,admitted_at FROM automation_occurrences WHERE occurrence_id = ?',
    ).get(first.occurrenceId)).toEqual({ triggered_at: 1_700_000_200_000, admitted_at: 1_700_000_200_000 });
    expect(engine.resources.getBudgets(first.jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime_ms', limit: 60_000 }),
      expect.objectContaining({ kind: 'model_calls', limit: 2 }),
      expect.objectContaining({ kind: 'tool_calls', limit: 8 }),
      expect.objectContaining({ kind: 'retries', limit: 1 }),
    ]));
    expect(db.prepare(
      'SELECT allowed_tools_json,allowed_paths_json FROM job_capability_sets WHERE job_id = ?',
    ).get(first.jobId)).toEqual({
      allowed_tools_json: JSON.stringify(['file_read', 'file_list']),
      allowed_paths_json: JSON.stringify([process.cwd()]),
    });
  });

  it('rejects an expired or replaced TriggerBus claim before occurrence admission', () => {
    const created = createScheduledAutomation();
    const bus = createTriggerBus({ db });
    const inserted = bus.insert({ source: 'schedule', sourceKey: created.definition.id, idempotencyKey: 'stale', payload: {} });
    const firstClaim = bus.claim({ source: 'schedule', ownerId: 'scheduler-a', leaseMs: 1 });
    if (!firstClaim) throw new Error('expected claim');
    bus.reclaimExpired(Date.now() + 5_000);
    const replacement = bus.claim({ source: 'schedule', ownerId: 'scheduler-b', leaseMs: 60_000 });
    expect(replacement?.id).toBe(inserted.id);

    const occurrences = createOccurrenceAuthority({ db, jobEngine: engine });
    expect(() => occurrences.admitClaimed({
      triggerEventId: firstClaim.id, claimToken: firstClaim.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'schedule', scheduledFor: '2026-08-21T03:30:00.000Z',
      sourceIdentity: 'stale', instanceId: 'automation-instance', now: Date.now(),
    })).toThrow(/claim authority/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_occurrences').get()).toEqual({ count: 0 });
  });

  it('rejects raw credentials from immutable revision content', () => {
    const authority = createAutomationAuthority({ db });
    expect(() => authority.create({
      name: 'Unsafe',
      action: { kind: 'prompt', prompt: 'Send a report', apiToken: 'plain-text-token' } as never,
      trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [], createdBy: 'test-user',
    })).toThrow(/credential/i);
  });

  it('binds delivery to one exact connected account and the normal integration Effect authority', () => {
    db.prepare(
      `INSERT INTO connected_accounts (
         account_id,provider_id,toolkit_id,owner_id,workspace_id,label,
         provider_account_ref,status,health,created_at,updated_at
       ) VALUES ('account_delivery','composio','slack','owner-a','workspace-a','Ops',
         'provider-account','active','healthy',1,1)`,
    ).run();
    const created = createAutomationAuthority({ db }).create({
      name: 'Verified report delivery',
      action: { kind: 'prompt', prompt: 'Prepare the report.' },
      trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 2 } },
      capabilities: ['apps.use'],
      credentialRefs: ['account_delivery'],
      delivery: {
        destinationRef: 'account_delivery', providerId: 'composio', toolkitId: 'slack',
        actionId: 'send_message', schemaVersion: 'schema-1', providerActionVersion: 'provider-7',
        input: { channel: 'ops' }, contentField: 'text', mode: 'on_success',
      },
      createdBy: 'owner-a', ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    const bus = createTriggerBus({ db });
    bus.insert({ source: 'manual', sourceKey: created.definition.id, idempotencyKey: 'delivery', payload: {} });
    const claim = bus.claim({ source: 'manual', ownerId: 'scheduler', leaseMs: 60_000 });
    if (!claim) throw new Error('claim');
    const result = createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed({
      triggerEventId: claim.id, claimToken: claim.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'manual', sourceIdentity: 'delivery', instanceId: 'automation-instance',
    });
    if (result.disposition !== 'admitted') throw new Error('admission');

    expect(result.deliverySpec).toEqual(created.revision.spec.delivery);
    expect(db.prepare(
      'SELECT allowed_tools_json,allowed_accounts_json,allowed_effect_kinds_json FROM job_capability_sets WHERE job_id = ?',
    ).get(result.jobId)).toEqual({
      allowed_tools_json: JSON.stringify(['app_action']),
      allowed_accounts_json: JSON.stringify(['account_delivery']),
      allowed_effect_kinds_json: JSON.stringify(['integration.action']),
    });
  });

  it('binds relative ScriptSpec paths to the immutable workspace root', () => {
    const workspaceRoot = process.cwd();
    const created = createAutomationAuthority({ db }).create({
      name: 'Bound script',
      action: {
        kind: 'script',
        script: { version: 1, maxRuntimeMs: 1_000, steps: [{ kind: 'write_file', path: 'AUTOMATION_OK.txt', content: 'AUTOMATION_OK' }] },
      },
      trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: ['repository.write'], credentialRefs: [], workspace: { rootPath: workspaceRoot },
      createdBy: 'owner-a', ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    const bus = createTriggerBus({ db });
    bus.insert({ source: 'manual', sourceKey: created.definition.id, idempotencyKey: 'bound-script', payload: {} });
    const claim = bus.claim({ source: 'manual', ownerId: 'scheduler', leaseMs: 60_000 });
    if (!claim) throw new Error('claim');
    const result = createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed({
      triggerEventId: claim.id, claimToken: claim.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'manual', sourceIdentity: 'bound-script', instanceId: 'automation-instance',
    });
    if (result.disposition !== 'admitted') throw new Error('admission');
    expect(engine.getJob(result.jobId)?.workspaceId).toBe(workspaceRoot);
    expect(db.prepare(
      'SELECT allowed_paths_json,allowed_effect_kinds_json FROM job_capability_sets WHERE job_id = ?',
    ).get(result.jobId)).toEqual({
      allowed_paths_json: JSON.stringify([path.resolve(workspaceRoot, 'AUTOMATION_OK.txt')]),
      allowed_effect_kinds_json: JSON.stringify(['filesystem.write', 'filesystem.move', 'filesystem.delete']),
    });
    expect(engine.resources.authorize({ jobId: result.jobId, kind: 'path', value: 'AUTOMATION_OK.txt' })).toBe(true);
    expect(engine.resources.authorize({ jobId: result.jobId, kind: 'path', value: '..\\outside.txt' })).toBe(false);
  });

  it('blocks a new occurrence when its scoped credential was revoked', () => {
    db.prepare(
      `INSERT INTO integration_secret_handles (
         secret_handle,workspace_id,owner_id,provider_id,label,backend,storage_ref,status,created_at,updated_at
       ) VALUES ('secret_ref','workspace-a','owner-a','test','Test','memory','ref:test','active',1,1)`,
    ).run();
    const created = createAutomationAuthority({ db }).create({
      name: 'Credential-bound', action: { kind: 'prompt', prompt: 'Read safely' }, trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: ['repository.read'], credentialRefs: ['secret_ref'], createdBy: 'owner-a',
      workspace: { rootPath: process.cwd() },
      ownerId: 'owner-a', workspaceId: 'workspace-a',
    });
    db.prepare("UPDATE integration_secret_handles SET status = 'revoked',revoked_at = 2,updated_at = 2 WHERE secret_handle = 'secret_ref'").run();
    const bus = createTriggerBus({ db });
    bus.insert({ source: 'manual', sourceKey: created.definition.id, idempotencyKey: 'credential-revoked', payload: {} });
    const claim = bus.claim({ source: 'manual', ownerId: 'scheduler', leaseMs: 60_000 });
    if (!claim) throw new Error('claim');
    const occurrenceAuthority = createOccurrenceAuthority({ db, jobEngine: engine });
    const command = {
      triggerEventId: claim.id, claimToken: claim.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'manual', sourceIdentity: 'credential-revoked', instanceId: 'automation-instance',
    };
    const result = occurrenceAuthority.admitClaimed(command);
    expect(result.disposition).toBe('terminal');
    expect(db.prepare('SELECT state,detail_json FROM automation_occurrences').get()).toEqual({
      state: 'blocked', detail_json: JSON.stringify({ reason: 'credential_unavailable', credentialRef: 'secret_ref' }),
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });

    db.prepare("UPDATE integration_secret_handles SET status = 'active',revoked_at = NULL,updated_at = 3 WHERE secret_handle = 'secret_ref'").run();
    const recovered = occurrenceAuthority.admitClaimed(command);
    expect(recovered.disposition).toBe('admitted');
    expect(recovered.occurrenceId).toBe(result.occurrenceId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  });

  it('rolls back the occurrence if Job admission is interrupted, then safely retries', () => {
    const created = createScheduledAutomation();
    const bus = createTriggerBus({ db });
    bus.insert({ source: 'schedule', sourceKey: created.definition.id, idempotencyKey: 'crash-window', payload: {} });
    const claim = bus.claim({ source: 'schedule', ownerId: 'scheduler', leaseMs: 60_000 });
    if (!claim) throw new Error('claim');
    db.exec(`CREATE TRIGGER fail_automation_job_insert BEFORE INSERT ON tasks
      WHEN NEW.automation_occurrence_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected admission crash'); END;`);
    const command = {
      triggerEventId: claim.id, claimToken: claim.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'schedule', scheduledFor: '2026-08-21T03:30:00.000Z',
      sourceIdentity: 'crash-window', instanceId: 'automation-instance',
    };
    expect(() => createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed(command)).toThrow(/injected admission crash/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_occurrences').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });

    db.exec('DROP TRIGGER fail_automation_job_insert');
    const recovered = createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed(command);
    expect(recovered.disposition).toBe('admitted');
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_occurrences').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  });

  it('rolls back the Job when the occurrence link fails after Job creation', () => {
    const created = createScheduledAutomation();
    const bus = createTriggerBus({ db });
    bus.insert({ source: 'schedule', sourceKey: created.definition.id, idempotencyKey: 'link-crash', payload: {} });
    const claim = bus.claim({ source: 'schedule', ownerId: 'scheduler', leaseMs: 60_000 });
    if (!claim) throw new Error('claim');
    db.exec(`CREATE TRIGGER fail_occurrence_link BEFORE UPDATE ON automation_occurrences
      WHEN NEW.job_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected occurrence link crash'); END;`);
    const command = {
      triggerEventId: claim.id, claimToken: claim.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'schedule', scheduledFor: '2026-08-21T03:30:00.000Z',
      sourceIdentity: 'link-crash', instanceId: 'automation-instance',
    };
    expect(() => createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed(command))
      .toThrow(/injected occurrence link crash/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_occurrences').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });

    db.exec('DROP TRIGGER fail_occurrence_link');
    expect(createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed(command).disposition).toBe('admitted');
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_occurrences').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  });

  it('retries through a new fenced Attempt without creating a second Job', () => {
    const created = createScheduledAutomation();
    const bus = createTriggerBus({ db });
    bus.insert({ source: 'schedule', sourceKey: created.definition.id, idempotencyKey: 'retry', payload: {} });
    const claim = bus.claim({ source: 'schedule', ownerId: 'scheduler', leaseMs: 60_000 });
    if (!claim) throw new Error('claim');
    const authority = createOccurrenceAuthority({ db, jobEngine: engine });
    const command = {
      triggerEventId: claim.id, claimToken: claim.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'schedule', scheduledFor: '2026-08-21T03:30:00.000Z',
      sourceIdentity: 'retry', instanceId: 'automation-instance',
    };
    const first = authority.admitClaimed(command);
    if (first.disposition !== 'admitted') throw new Error('admission');
    const lease = engine.claimAttempt({ attemptId: first.attemptId, ownerId: 'automation-instance', ttlMs: 30_000 });
    const attemptRunning = engine.transitionAttempt({
      attemptId: first.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
      fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'retry-attempt-running', producer: 'test',
    });
    engine.transitionJob({
      jobId: first.jobId, attemptId: first.attemptId, generation: lease.generation!, fenceToken: lease.fenceToken!,
      expectedStateVersion: 0, to: 'running', eventIdempotencyKey: 'retry-job-running', producer: 'test',
    });
    engine.transitionAttempt({
      attemptId: first.attemptId, expectedStateVersion: attemptRunning.stateVersion!, generation: lease.generation!,
      fenceToken: lease.fenceToken!, to: 'failed', eventIdempotencyKey: 'retry-attempt-failed', producer: 'test',
    });
    engine.transitionJob({
      jobId: first.jobId, attemptId: first.attemptId, generation: lease.generation!, fenceToken: lease.fenceToken!,
      expectedStateVersion: 1, to: 'failed', eventIdempotencyKey: 'retry-job-failed', producer: 'test',
    });

    const recovered = authority.admitClaimed(command);
    if (recovered.disposition !== 'admitted') throw new Error('recovery admission');
    expect(recovered.jobId).toBe(first.jobId);
    expect(recovered.attemptId).not.toBe(first.attemptId);
    expect(engine.getAttempt(recovered.attemptId)).toMatchObject({ attemptNumber: 2, generation: 2, recoveryOfAttemptId: first.attemptId });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs WHERE task_id = ?').get(first.jobId)).toEqual({ count: 2 });
  });
});
