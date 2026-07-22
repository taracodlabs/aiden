/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { createWorkbenchJobCommands } from '../../../core/v4/workbench/jobCommands';

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

  function commands() {
    const jobEngine = createJobEngine({ db });
    const runStore = createRunStore({ db });
    const value = createWorkbenchJobCommands({
      db,
      triggerBus: createTriggerBus({ db }),
      jobEngine,
      runStore,
      instanceId: 'workbench_test',
      idFactory: () => 'workbench-idempotency-key',
    });
    return { ...value, jobEngine, runStore };
  }

  it('returns authoritative Job and Attempt identities before acknowledging enqueue', () => {
    const { enqueue, jobEngine } = commands();
    const result = enqueue.enqueue({ message: 'read the project notes', sessionId: 'workbench-session' });

    expect(result).toMatchObject({ accepted: true, duplicate: false });
    expect(jobEngine.getJob(result.jobId)).toMatchObject({
      id: result.jobId, activeAttemptId: result.attemptId, entryPoint: 'workbench',
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
    expect(jobEngine.getJob(admitted.jobId)).toMatchObject({ status: 'cancelled', activeAttemptId: null });
    expect(jobEngine.getAttempt(admitted.attemptId)?.status).toBe('cancelled');
    expect(jobEngine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: attemptRunning.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'succeeded',
      eventIdempotencyKey: 'workbench-late-success',
      producer: 'test',
    }).applied).toBe(false);
    expect(jobEngine.listEvents(admitted.jobId).map((event) => event.type)).toContain('job.cancelled');
  });
});
