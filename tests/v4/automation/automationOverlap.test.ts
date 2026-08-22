import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutomationAuthority } from '../../../core/v4/automation/automationAuthority';
import { createOccurrenceAuthority } from '../../../core/v4/automation/occurrenceAuthority';
import { createAutomationScheduler } from '../../../core/v4/automation/scheduler';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';

describe('automation overlap policy', () => {
  let db: Database.Database;
  let engine: JobEngine;
  beforeEach(() => {
    db = new Database(':memory:'); runMigrations(db);
    const now = Date.now();
    db.prepare(`INSERT INTO daemon_instances
      (instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES ('automation-instance',1,'localhost',?,?,'4.20.0')`).run(now, now);
    engine = createJobEngine({ db });
  });
  afterEach(() => db.close());

  function setup(overlap: 'skip' | 'queue' | 'cancel_previous') {
    const created = createAutomationAuthority({ db }).create({
      name: overlap, action: { kind: 'prompt', prompt: 'Run safely' }, trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap, retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [], createdBy: 'test',
    });
    const bus = createTriggerBus({ db });
    const admit = (identity: string, now?: number) => {
      bus.insert({ source: 'manual', sourceKey: created.definition.id, idempotencyKey: identity, payload: {} });
      const claim = bus.claim({ source: 'manual', ownerId: 'test', leaseMs: 60_000 });
      if (!claim) throw new Error('claim');
      return createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed({
        triggerEventId: claim.id, claimToken: claim.claimToken,
        automationId: created.definition.id, revisionId: created.revision.id,
        triggerKind: 'manual', sourceIdentity: identity, instanceId: 'automation-instance', now,
      });
    };
    return { admit, bus, created };
  }

  it('SKIP records a durable skipped occurrence without a second Job', () => {
    const { admit } = setup('skip');
    expect(admit('one').disposition).toBe('admitted');
    expect(admit('two').disposition).toBe('skipped');
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM automation_occurrences WHERE state = 'skipped_overlap'").get()).toEqual({ count: 1 });
  });

  it('QUEUE records a durable queued occurrence without concurrent admission', () => {
    const { admit } = setup('queue');
    expect(admit('one').disposition).toBe('admitted');
    expect(admit('two').disposition).toBe('queued');
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM automation_occurrences WHERE state = 'queued_overlap'").get()).toEqual({ count: 1 });
  });

  it('CANCEL_PREVIOUS persists cancellation before deferring replacement admission', () => {
    const { admit } = setup('cancel_previous');
    const first = admit('one');
    if (first.disposition !== 'admitted') throw new Error('admission');
    expect(admit('two').disposition).toBe('queued');
    expect(engine.getJob(first.jobId)?.status).toBe('cancelled');
    const events = engine.listEvents(first.jobId).map((event) => event.type);
    expect(events).toContain('job.cancelled');
  });

  it('releases queued occurrences in durable FIFO order after the prior Job settles', () => {
    const { admit, bus, created } = setup('queue');
    const sameInstant = 1_700_000_000_000;
    const first = admit('one', sameInstant);
    if (first.disposition !== 'admitted') throw new Error('first admission');
    expect(admit('two', sameInstant).disposition).toBe('queued');
    expect(admit('three', sameInstant).disposition).toBe('queued');
    const originalOrder = db.prepare(
      `SELECT source_identity,trigger_event_id FROM automation_occurrences
        WHERE source_identity IN ('two','three') ORDER BY trigger_event_id`,
    ).all() as Array<{ source_identity: string; trigger_event_id: number }>;
    expect(originalOrder.map((row) => row.source_identity)).toEqual(['two', 'three']);
    engine.cancelJob({
      jobId: first.jobId, reason: 'test settlement', producer: 'test',
      eventIdempotencyKey: 'settle-first',
    });
    const scheduler = createAutomationScheduler({ db, triggerBus: bus, maxPerScan: 10 });
    expect(scheduler.scanDue()).toMatchObject({ released: 1 });
    expect(db.prepare(
      `SELECT source_identity,trigger_event_id FROM automation_occurrences
        WHERE source_identity IN ('two','three') ORDER BY trigger_event_id`,
    ).all()).toEqual(originalOrder);
    const claimTwo = bus.claim({ source: 'manual', ownerId: 'test', leaseMs: 60_000 });
    if (!claimTwo) throw new Error('second release claim');
    const second = createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed({
      triggerEventId: claimTwo.id, claimToken: claimTwo.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'manual', sourceIdentity: 'two', instanceId: 'automation-instance',
    });
    expect(second.disposition).toBe('admitted');
    expect(scheduler.scanDue()).toMatchObject({ released: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM automation_occurrences WHERE state = 'queued_overlap'").get())
      .toEqual({ count: 1 });
    if (second.disposition !== 'admitted') throw new Error('second admission');
    engine.cancelJob({
      jobId: second.jobId, reason: 'test settlement', producer: 'test',
      eventIdempotencyKey: 'settle-second',
    });
    expect(scheduler.scanDue()).toMatchObject({ released: 1 });
    const claimThree = bus.claim({ source: 'manual', ownerId: 'test', leaseMs: 60_000 });
    if (!claimThree) throw new Error('third release claim');
    const third = createOccurrenceAuthority({ db, jobEngine: engine }).admitClaimed({
      triggerEventId: claimThree.id, claimToken: claimThree.claimToken,
      automationId: created.definition.id, revisionId: created.revision.id,
      triggerKind: 'manual', sourceIdentity: 'three', instanceId: 'automation-instance',
    });
    expect(third.disposition).toBe('admitted');
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 3 });
  });
});
