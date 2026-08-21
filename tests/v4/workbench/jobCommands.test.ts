/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createActionAuthority, normalizeExecutionPlan } from '../../../core/v4/actionAuthority';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { createWorkbenchJobCommands, summarizeWorkbenchGoal } from '../../../core/v4/workbench/jobCommands';

describe('Workbench durable Job commands', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('workbench_test', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
  });

  afterEach(() => db.close());

  function commands(workspacePath?: string) {
    const jobEngine = createJobEngine({ db });
    const runStore = createRunStore({ db });
    const value = createWorkbenchJobCommands({
      db,
      triggerBus: createTriggerBus({ db }),
      jobEngine,
      runStore,
      instanceId: 'workbench_test',
      idFactory: () => 'workbench-idempotency-key',
      ...(workspacePath ? { workspacePath } : {}),
    });
    return { ...value, jobEngine, runStore };
  }

  it('stores a compact truthful title without changing the exact trigger prompt', () => {
    expect(summarizeWorkbenchGoal('  Inspect\npackage.json   and report the version  '))
      .toBe('Inspect package.json and report the version');
    expect(summarizeWorkbenchGoal('x'.repeat(200))).toHaveLength(120);
  });

  it('returns authoritative Job and Attempt identities before acknowledging enqueue', () => {
    const { enqueue, jobEngine } = commands();
    const result = enqueue.enqueue({ message: 'read the project notes', sessionId: 'workbench-session' });

    expect(result).toMatchObject({ accepted: true, duplicate: false });
    expect(jobEngine.getJob(result.jobId)).toMatchObject({
      id: result.jobId, activeAttemptId: result.attemptId, entryPoint: 'workbench',
      goal: 'read the project notes',
    });
    expect(jobEngine.getAttempt(result.attemptId)).toMatchObject({
      rowId: result.runId, jobId: result.jobId, status: 'queued',
    });
    const trigger = db.prepare('SELECT payload_json FROM trigger_events WHERE id = ?')
      .get(result.triggerEventId) as { payload_json: string };
    expect(JSON.parse(trigger.payload_json).durable_job).toEqual({
      job_id: result.jobId,
      attempt_id: result.attemptId,
      run_id: result.runId,
    });
  });

  it('cancels through the Job authority and rejects the active worker late result', () => {
    const { enqueue, cancel, jobEngine } = commands();
    const admitted = enqueue.enqueue({ message: 'wait for cancellation' });
    const lease = jobEngine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'workbench-runner', ttlMs: 30_000,
    });
    const attemptRunning = jobEngine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'running',
      eventIdempotencyKey: 'workbench-attempt-running',
      producer: 'test',
    });
    jobEngine.transitionJob({
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      expectedStateVersion: 0,
      to: 'running',
      eventIdempotencyKey: 'workbench-job-running',
      producer: 'test',
    });

    expect(cancel.cancel(admitted.runId)).toEqual({ accepted: true, runId: admitted.runId });
    expect(jobEngine.getJob(admitted.jobId)).toMatchObject({ status: 'cancelling', activeAttemptId: admitted.attemptId });
    expect(jobEngine.getAttempt(admitted.attemptId)?.status).toBe('running');
    expect(jobEngine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: attemptRunning.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'succeeded',
      eventIdempotencyKey: 'workbench-late-success',
      producer: 'test',
    }).applied).toBe(false);
    expect(jobEngine.listEvents(admitted.jobId).map((event) => event.type)).toContain('job.cancelling');
  });

  it('freezes the current session provider/model into the admitted trigger payload', () => {
    const jobEngine = createJobEngine({ db });
    const runStore = createRunStore({ db });
    let selected = { provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'session' as const };
    const { enqueue } = createWorkbenchJobCommands({
      db, triggerBus: createTriggerBus({ db }), jobEngine, runStore,
      instanceId: 'workbench_test', idFactory: () => 'model-binding-key',
      resolveModelBinding: () => selected,
    });
    const admitted = enqueue.enqueue({ message: 'inspect once', sessionId: 'session-model' });
    selected = { provider: 'openai', model: 'gpt-5.4', source: 'session' };

    const trigger = db.prepare('SELECT payload_json FROM trigger_events WHERE id = ?')
      .get(admitted.triggerEventId) as { payload_json: string };
    expect(JSON.parse(trigger.payload_json).model_binding).toEqual({
      provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'session',
    });
  });

  it('binds admitted Workbench Jobs to the exact repository workspace', () => {
    const workspacePath = 'C:\\fixture\\repository';
    const { enqueue, jobEngine } = commands(workspacePath);

    const result = enqueue.enqueue({ message: 'use external coding for this repository' });

    expect(jobEngine.getJob(result.jobId)?.workspaceId).toBe(workspacePath);
  });

  it('removes a cancelled queued Job from the durable trigger queue', () => {
    const { enqueue, cancel, jobEngine } = commands();
    const admitted = enqueue.enqueue({ message: 'cancel before dispatch' });

    expect(cancel.cancel(admitted.runId)).toEqual({ accepted: true, runId: admitted.runId });
    expect(jobEngine.getJob(admitted.jobId)?.status).toBe('cancelled');
    expect(db.prepare('SELECT status, last_error FROM trigger_events WHERE id = ?').get(admitted.triggerEventId))
      .toEqual({ status: 'dead_letter', last_error: 'workbench task cancelled before dispatch' });
  });

  it('acknowledges cancellation of a succeeded run as already final', () => {
    const { enqueue, cancel } = commands();
    const admitted = enqueue.enqueue({ message: 'already complete' });
    db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(admitted.runId);

    expect(cancel.cancel(admitted.runId)).toEqual({
      accepted: true,
      runId: admitted.runId,
      alreadyFinal: true,
    });
  });

  it('persists queued input and pause before acknowledging, then resumes with a new Attempt', () => {
    const { enqueue, input, control, jobEngine } = commands();
    const admitted = enqueue.enqueue({ message: 'long work', sessionId: 'workbench-session' });
    const lease = jobEngine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'workbench-runner', ttlMs: 30_000,
    });
    jobEngine.transitionAttempt({
      attemptId: admitted.attemptId, expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!, fenceToken: lease.fenceToken!, to: 'running',
      eventIdempotencyKey: 'input-attempt-running', producer: 'test',
    });
    jobEngine.transitionJob({
      jobId: admitted.jobId, attemptId: admitted.attemptId, expectedStateVersion: 0,
      generation: lease.generation!, fenceToken: lease.fenceToken!, to: 'running',
      eventIdempotencyKey: 'input-job-running', producer: 'test',
    });

    const queued = input.receive(admitted.runId, 'follow up', 'input-key');
    expect(queued).toMatchObject({ accepted: true, inputId: expect.stringMatching(/^input_/) });
    expect(control.pause(admitted.runId, 'pause-key')).toMatchObject({ accepted: true, applied: false });
    expect(jobEngine.getJob(admitted.jobId)?.status).toBe('running');
    expect(control.applyPauseBoundary(admitted.runId)).toEqual({ accepted: true, applied: true });
    expect(jobEngine.getJob(admitted.jobId)?.status).toBe('paused');

    const resumed = control.resume(admitted.runId, 'resume-key');
    expect(resumed).toMatchObject({
      accepted: true,
      attemptId: expect.any(String),
      generation: 2,
      triggerEventId: expect.any(Number),
    });
    expect(resumed.attemptId).not.toBe(admitted.attemptId);
    expect(db.prepare('SELECT trigger_event_id FROM runs WHERE attempt_id = ?').get(resumed.attemptId))
      .toEqual({ trigger_event_id: resumed.triggerEventId });
  });

  it('resolves a durable approval by exact ID without treating ordinary input as consent', () => {
    const value = commands();
    const admitted = value.enqueue.enqueue({ message: 'write a file', sessionId: 'workbench-session' });
    const lease = value.jobEngine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'workbench_test', ttlMs: 60_000,
    });
    const actionAuthority = createActionAuthority({ db, jobEngine: value.jobEngine });
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write', args: { path: 'result.txt' }, cwd: process.cwd(),
      mutates: true, riskTier: 'caution',
      policy: {
        trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'smart',
        toolMetadataVersion: 'test', sandboxPolicy: {}, networkPolicy: {}, pluginGrants: [],
        mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
      },
    });
    const pending = actionAuthority.request({
      jobId: admitted.jobId, attemptId: admitted.attemptId, generation: 1, fenceToken: lease.fenceToken!,
      toolCallId: 'workbench-tool', toolName: 'file_write', riskTier: 'caution',
      riskReasons: [], normalized,
    });
    const commandsWithApproval = createWorkbenchJobCommands({
      db, triggerBus: createTriggerBus({ db }), jobEngine: value.jobEngine,
      runStore: value.runStore, instanceId: 'workbench_test',
      actionAuthority, idFactory: () => 'approval-command-key',
    });

    expect(commandsWithApproval.approval.decide(pending.approvalId, 'approved')).toMatchObject({
      accepted: true, approvalId: pending.approvalId, state: 'approved',
    });
    expect(() => commandsWithApproval.input.receive(admitted.runId, 'yes', 'ordinary-yes'))
      .not.toThrow();
    expect(actionAuthority.get(pending.approvalId)?.state).toBe('approved');
  });

  it('persists an exact browser denial idempotently', () => {
    const value = commands();
    const admitted = value.enqueue.enqueue({ message: 'write a denied file', sessionId: 'workbench-session' });
    const lease = value.jobEngine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'workbench_test', ttlMs: 60_000,
    });
    const authority = createActionAuthority({ db, jobEngine: value.jobEngine });
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write', args: { path: 'denied.txt' }, cwd: process.cwd(),
      mutates: true, riskTier: 'caution',
      policy: {
        trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'smart',
        toolMetadataVersion: 'test', sandboxPolicy: {}, networkPolicy: {}, pluginGrants: [],
        mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
      },
    });
    const pending = authority.request({
      jobId: admitted.jobId, attemptId: admitted.attemptId, generation: 1, fenceToken: lease.fenceToken!,
      toolCallId: 'workbench-deny', toolName: 'file_write', riskTier: 'caution',
      riskReasons: [], normalized,
    });
    const commandsWithApproval = createWorkbenchJobCommands({
      db, triggerBus: createTriggerBus({ db }), jobEngine: value.jobEngine,
      runStore: value.runStore, instanceId: 'workbench_test', actionAuthority: authority,
      idFactory: () => 'approval-deny-key',
    });

    expect(commandsWithApproval.approval.decide(pending.approvalId, 'denied')).toMatchObject({
      accepted: true, approvalId: pending.approvalId, state: 'denied',
    });
    expect(commandsWithApproval.approval.decide(pending.approvalId, 'denied')).toMatchObject({
      accepted: true, approvalId: pending.approvalId, state: 'denied',
    });
    expect(authority.get(pending.approvalId)).toMatchObject({ state: 'denied', decision: 'denied' });
  });

  it('continues a paused Job with bounded durable context on one fresh Attempt', async () => {
    const value = commands();
    const admitted = value.enqueue.enqueue({ message: 'inspect durable state', sessionId: 'workbench-session' });
    value.control.pause(admitted.runId, 'pause-for-continue');
    expect(value.control.applyPauseBoundary(admitted.runId)).toEqual({ accepted: true, applied: true });
    const checkpoint = value.continuity.getLatest(admitted.jobId)!;

    const continued = await value.continueTask.continue(checkpoint.checkpointId, 'continue-exactly-once');
    expect(continued).toMatchObject({
      decision: 'continued', jobId: admitted.jobId, priorAttemptId: admitted.attemptId, generation: 2,
    });
    expect(continued.attemptId).not.toBe(admitted.attemptId);
    expect(value.jobEngine.getJob(admitted.jobId)?.activeAttemptId).toBe(continued.attemptId);
    const trigger = db.prepare("SELECT payload_json FROM trigger_events WHERE source_key LIKE 'workbench-resume:%' ORDER BY id DESC LIMIT 1")
      .get() as { payload_json: string };
    const payload = JSON.parse(trigger.payload_json);
    expect(payload.body.prompt).toContain('[resume]');
    expect(payload.body.prompt).toContain('Original goal:');
    expect(payload).not.toHaveProperty('messages');
    expect((await value.continueTask.continue(checkpoint.checkpointId, 'continue-exactly-once')).decision)
      .toBe('already_applied');
  });

  it('checks the live repository snapshot and records drift before continuing', async () => {
    const value = commands();
    const admitted = value.enqueue.enqueue({ message: 'continue after repository drift', sessionId: 'workbench-session' });
    db.prepare('UPDATE tasks SET repository_snapshot_id=? WHERE id=?').run('snapshot_exact', admitted.jobId);
    vi.spyOn(value.jobEngine.repository, 'getSnapshot').mockReturnValue({
      id: 'snapshot_exact', stateDigest: 'repo_before',
    } as ReturnType<typeof value.jobEngine.repository.getSnapshot>);
    const inventory = vi.spyOn(value.jobEngine.repository, 'inventory').mockResolvedValue({
      snapshotId: 'snapshot_exact', stateDigest: 'repo_before', entries: [],
      nextCursor: null, truncated: false, stale: true,
    });

    value.control.pause(admitted.runId, 'pause-for-drift');
    expect(value.control.applyPauseBoundary(admitted.runId)).toEqual({ accepted: true, applied: true });
    const checkpoint = value.continuity.getLatest(admitted.jobId)!;
    expect(checkpoint).toMatchObject({
      repositorySnapshotId: 'snapshot_exact', repositoryFingerprint: 'repo_before',
      environmentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const continued = await value.continueTask.continue(checkpoint.checkpointId, 'continue-after-drift');
    expect(inventory).toHaveBeenCalledWith('snapshot_exact', { limit: 1 });
    expect(continued).toMatchObject({
      decision: 'continued',
      revalidation: { repositoryDrift: true, environmentDrift: false },
      reason: 'Continued with drift revalidation',
    });
  });
});
