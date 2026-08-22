import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { createPresenceAuthority } from '../../../core/v4/presence/presenceAuthority';
import { createWorkbenchJobCommands } from '../../../core/v4/workbench/jobCommands';
import { createWorkbenchPresencePort } from '../../../core/v4/workbench/presencePort';

describe('Workbench Presence port', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('presence-workbench',1,'localhost',1,1,'4.20.0')`,
    ).run();
  });
  afterEach(() => db.close());

  it('reconciles durable facts without owning their lifecycle', () => {
    db.prepare(
      `INSERT INTO tasks (id,title,goal,status,created_at,updated_at,channel_id,session_id,trace_ids,artifact_ids)
       VALUES ('job_1','Job','Review result','completed_unverified',1,2,'workbench','session_1','[]','[]')`,
    ).run();
    const authority = createPresenceAuthority({ db, enabled: true, now: () => 10 });
    const port = createWorkbenchPresencePort({ db, authority, edition: buildEditionAuthority('pro') });

    expect(port.snapshot().reviewWhenReady).toEqual([
      expect.objectContaining({ sourceKind: 'job', sourceIdentity: 'job_1', jobId: 'job_1' }),
    ]);
    expect(db.prepare(`SELECT status FROM tasks WHERE id='job_1'`).get()).toEqual({ status: 'completed_unverified' });
  });

  it('keeps proposal creation separate from explicit ordinary admission', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => 10 });
    const item = authority.observe({
      sourceKind: 'continuity', sourceIdentity: 'checkpoint_1', sourceRevision: 'current:1', initiator: 'SYSTEM',
      category: 'next_action', priority: 40, title: 'Continue review', summary: 'Inspect the remaining files.',
      reasonCode: 'continuity_next_step', reason: 'A current checkpoint proposes a next step.',
      recommendedAction: 'Review next step', active: true, observedAt: 10,
    }).item;
    const jobEngine = createJobEngine({ db });
    const commands = createWorkbenchJobCommands({
      db, jobEngine, runStore: createRunStore({ db }), triggerBus: createTriggerBus({ db }),
      instanceId: 'presence-workbench', idFactory: () => 'ordinary-workbench-key',
    });
    const enqueueSpy = vi.spyOn(commands.enqueue, 'enqueue');
    const port = createWorkbenchPresencePort({ db, authority, edition: buildEditionAuthority('pro'), enqueue: commands.enqueue });
    const proposal = port.propose({ itemId: item.id, prompt: 'Inspect the remaining files.', goal: 'Continue review' });
    expect(enqueueSpy).not.toHaveBeenCalled();
    const accepted = port.acceptProposal({ proposalId: proposal.id, expectedVersion: proposal.version });
    expect(accepted).toMatchObject({ state: 'accepted', jobId: expect.any(String), attemptId: expect.any(String), runId: expect.any(Number) });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(jobEngine.getJob(accepted.jobId!)).toMatchObject({
      entryPoint: 'workbench', source: 'workbench', goal: 'Inspect the remaining files.',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM side_effect_ledger').get()).toEqual({ count: 0 });
  });

  it('keeps Community safety truth while disabling proactive Presence', () => {
    const authority = createPresenceAuthority({ db, enabled: false, now: () => 10 });
    const port = createWorkbenchPresencePort({ db, authority, edition: buildEditionAuthority('community') });
    expect(port.snapshot()).toMatchObject({ enabled: false, needsYou: [] });
    expect(() => port.propose({ itemId: 'missing', prompt: 'x', goal: 'x' })).toThrow(/Pro/i);
  });

  it('projects exact feedback identity to an optional Learning adapter without changing Presence policy', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => 10, idFactory: () => 'feedback_1' });
    const item = authority.observe({
      sourceKind: 'job', sourceIdentity: 'job_feedback', sourceRevision: '1', initiator: 'USER',
      workspaceId: 'workspace_1', ownerId: 'owner_1', category: 'ready_review', priority: 50,
      title: 'Review result', summary: 'A verified result is ready.', reasonCode: 'review_ready',
      reason: 'The Job is ready for review.', active: true, observedAt: 10,
    }).item;
    const onFeedback = vi.fn();
    const port = createWorkbenchPresencePort({
      db, authority, edition: buildEditionAuthority('pro'), workspaceId: 'workspace_1', ownerId: 'owner_1', onFeedback,
    });

    expect(port.feedback({ itemId: item.id, kind: 'helpful' })).toMatchObject({
      accepted: true, eventId: expect.stringMatching(/^presence_event_/),
    });
    expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ item, kind: 'helpful', eventId: expect.any(String) }));
    expect(authority.get(item.id)).toMatchObject({ priority: item.priority, state: item.state });
  });

  it('rejects item actions outside the exact Workbench project and owner scope', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => 10 });
    const foreign = authority.observe({
      sourceKind: 'approval', sourceIdentity: 'approval_foreign', sourceRevision: 'created:1', initiator: 'USER',
      workspaceId: 'workspace_other', ownerId: 'owner_other', category: 'approval_required', priority: 100,
      title: 'Foreign approval', summary: 'Must remain isolated.', reasonCode: 'approval_waiting',
      reason: 'A protected action is waiting.', active: true, observedAt: 10,
    }).item;
    const port = createWorkbenchPresencePort({
      db, authority, edition: buildEditionAuthority('pro'), workspaceId: 'workspace_1', ownerId: 'owner_1',
    });
    expect(() => port.explain(foreign.id)).toThrow(/scope/i);
    expect(() => port.snooze({ itemId: foreign.id, expectedVersion: foreign.version, until: 20 })).toThrow(/scope/i);
    expect(authority.get(foreign.id)?.state).toBe('active');
  });
});
