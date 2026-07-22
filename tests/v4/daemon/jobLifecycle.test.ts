/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { executeDurableJob } from '../../../core/v4/daemon/jobLifecycle';
import { currentJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';

describe('executeDurableJob', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('instance_lifecycle', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  it('creates, leases, starts, executes, and finalizes one Job and Attempt', async () => {
    let identityDuringWork: ReturnType<typeof currentJobExecutionContext>;
    const execution = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_lifecycle',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_1', requestFingerprint: 'fingerprint_1', goal: 'run work',
      },
      execute: async () => {
        identityDuringWork = currentJobExecutionContext();
        return { value: 42 };
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: { verified: true },
      }),
    });

    expect(identityDuringWork!).toMatchObject({
      jobId: execution.jobId,
      attemptId: execution.attemptId,
      generation: 1,
    });
    expect(engine.getJob(execution.jobId)).toMatchObject({ status: 'completed', activeAttemptId: null });
    expect(engine.getAttempt(execution.attemptId)?.status).toBe('succeeded');
    expect(engine.listEvents(execution.jobId).map((event) => event.type)).toEqual([
      'job.submitted', 'attempt.created', 'attempt.leased', 'attempt.running',
      'job.running', 'attempt.succeeded', 'job.finalized',
    ]);
  });

  it('persists failure and never reports an unknown thrown operation as success', async () => {
    const result = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_lifecycle',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_failure', requestFingerprint: 'fingerprint_failure', goal: 'fail work',
      },
      execute: async () => { throw new Error('failure'); },
      finalize: () => ({ status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {} }),
    }).catch((error: Error & { jobId?: string; attemptId?: string }) => error);

    expect(result).toBeInstanceOf(Error);
    const job = engine.listJobs({ sessionId: 'session_lifecycle' })[0];
    expect(job.status).toBe('failed');
    expect(engine.getAttempt(job.activeAttemptId!)?.status ?? engine.listAttempts(job.id)[0]?.status).toBe('failed');
  });

  it('aborts active work when lease renewal loses authority', async () => {
    let sawAbort = false;
    const execution = executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      leaseTtlMs: 3_000,
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_lease_loss',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_lease_loss', requestFingerprint: 'fingerprint_lease_loss', goal: 'wait',
      },
      execute: async (handle) => new Promise<{ value: number }>((resolve) => {
        handle.signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve({ value: 0 });
        }, { once: true });
      }),
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {},
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const job = engine.listJobs({ sessionId: 'session_lease_loss' })[0]!;
    engine.cancelJob({
      jobId: job.id,
      reason: 'test cancellation',
      producer: 'test',
      eventIdempotencyKey: 'cancel-lease-loss',
    });

    await expect(execution).rejects.toThrow(/lease renewal failed/i);
    expect(sawAbort).toBe(true);
    expect(engine.getJob(job.id)?.status).toBe('cancelled');
  });
});
