/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { createTaskStore } from '../../../core/v4/daemon/taskStore';

describe('durable Job compatibility boundaries', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('compat_instance', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  function admit() {
    return engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'compat_session',
      instanceId: 'compat_instance', idempotencyNamespace: 'compat',
      idempotencyKey: 'compat_job', goal: 'Protect durable authority',
    });
  }

  it('rejects legacy status and resume writers for promoted Jobs and Attempts', () => {
    const admitted = admit();
    const taskStore = createTaskStore({ db });
    const runStore = createRunStore({ db });

    expect(() => taskStore.setStatus(admitted.jobId, 'completed')).toThrow(/Job transition authority/);
    expect(() => taskStore.setGoal(admitted.jobId, 'replacement')).toThrow(/Job transition authority/);
    expect(() => taskStore.incrementResumeCount(admitted.jobId)).toThrow(/Job transition authority/);
    expect(() => runStore.setStatus(admitted.runId, 'completed')).toThrow(/Job transition authority/);
    expect(() => runStore.markResumePending(admitted.runId, 'legacy')).toThrow(/Job transition authority/);
    expect(() => runStore.claimResumePending(admitted.runId, 'legacy')).toThrow(/Job transition authority/);

    expect(engine.getJob(admitted.jobId)).toMatchObject({ status: 'queued', goal: 'Protect durable authority' });
    expect(engine.getAttempt(admitted.attemptId)).toMatchObject({ status: 'queued' });
  });

  it('keeps expired-worker diagnostic events out of the authoritative Job sequence', () => {
    const admitted = admit();
    const base = 1;
    engine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'old_worker', ttlMs: 10, now: base,
    });
    const before = engine.listEvents(admitted.jobId).map((event) => event.jobSequence);

    const eventId = createRunStore({ db }).emitEventRich({
      runId: admitted.runId,
      category: 'dispatcher',
      kind: 'late.worker.output',
      source: 'old_worker',
      payload: { accepted: false },
    });

    expect(engine.listEvents(admitted.jobId).map((event) => event.jobSequence)).toEqual(before);
    expect(db.prepare(
      'SELECT job_id, attempt_id, job_sequence FROM run_events WHERE id = ?',
    ).get(eventId)).toEqual({ job_id: null, attempt_id: null, job_sequence: null });
  });

  it('does not let the legacy orphan sweep transition a promoted Job', () => {
    const admitted = admit();
    db.prepare("UPDATE tasks SET status = 'active', created_at = 1 WHERE id = ?").run(admitted.jobId);

    expect(createTaskStore({ db }).sweepOrphaned(Date.now())).toBe(0);
    expect(engine.getJob(admitted.jobId)?.status).toBe('active');
  });
});
