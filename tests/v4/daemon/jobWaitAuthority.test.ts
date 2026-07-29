/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createJobControlAuthority, type JobControlAuthority } from '../../../core/v4/daemon/jobControlAuthority';

describe('durable Job waits', () => {
  let db: Database.Database;
  let jobs: JobEngine;
  let controls: JobControlAuthority;
  let job: ReturnType<JobEngine['submitJob']>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('one', 1, 'localhost', 1, 1, '4.16.1'), ('two', 2, 'localhost', 2, 2, '4.16.1')`,
    ).run();
    jobs = createJobEngine({ db });
    controls = createJobControlAuthority({ db, jobEngine: jobs });
    job = jobs.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'session', instanceId: 'one',
      idempotencyNamespace: 'wait', idempotencyKey: 'job', goal: 'wait safely',
    });
  });

  afterEach(() => db.close());

  it('persists every supported wait kind and survives authority reconstruction', () => {
    const kinds = ['approval', 'clarification', 'scheduled_time', 'rate_limit_reset', 'external_event', 'child_job', 'reconciliation', 'resource_availability'] as const;
    for (const [index, kind] of kinds.entries()) {
      controls.waits.create({
        jobId: job.jobId, attemptId: job.attemptId, generation: 1, kind,
        producer: 'test', idempotencyNamespace: 'wait-kind', idempotencyKey: String(index),
      });
    }
    const restored = createJobControlAuthority({ db, jobEngine: createJobEngine({ db }) });
    expect(restored.waits.listPending(job.jobId).map((wait) => wait.kind)).toEqual(kinds);
  });

  it('times out a deadline once and keeps append-only history', () => {
    const wait = controls.waits.create({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1, kind: 'scheduled_time',
      deadlineAt: 100, producer: 'test', idempotencyNamespace: 'deadline', idempotencyKey: 'one', now: 1,
    }).record;
    expect(controls.waits.expireDue(99)).toEqual([]);
    expect(controls.waits.expireDue(100)).toEqual([wait.waitId]);
    expect(controls.waits.expireDue(101)).toEqual([]);
    expect(controls.waits.get(wait.waitId)?.state).toBe('timed_out');
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_wait_events WHERE wait_id = ?').get(wait.waitId))
      .toEqual({ count: 2 });
  });

  it('deduplicates an external event and rejects a stale generation', () => {
    const wait = controls.waits.create({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1, kind: 'external_event',
      externalKey: 'delivery:42', producer: 'test', idempotencyNamespace: 'external', idempotencyKey: 'wait',
    }).record;
    const command = {
      jobId: job.jobId, externalKey: 'delivery:42', attemptId: job.attemptId, generation: 1,
      producer: 'webhook', idempotencyKey: 'event-42', resolutionRef: 'event:sha256:42',
    };
    expect(controls.waits.resolveExternal(command).applied).toBe(true);
    expect(controls.waits.resolveExternal(command)).toMatchObject({ applied: false, duplicate: true });
    expect(controls.waits.resolve({
      waitId: wait.waitId, attemptId: job.attemptId, generation: 2,
      producer: 'test', idempotencyKey: 'stale',
    })).toMatchObject({ applied: false, conflict: 'terminal_state' });
  });

  it('links input received during approval to the exact durable wait', () => {
    const wait = controls.waits.create({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1, kind: 'approval',
      producer: 'test', idempotencyNamespace: 'approval', idempotencyKey: 'input-wait',
    }).record;
    const input = controls.inputs.receive({
      jobId: job.jobId, targetAttemptId: job.attemptId, targetGeneration: 1,
      sessionId: 'session', source: 'tui', kind: 'approval_response', content: 'once',
      idempotencyNamespace: 'approval-response', idempotencyKey: 'one',
    }).record;
    expect(controls.inputs.claimNext({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1,
      inputId: input.inputId, kinds: ['approval_response'],
    })?.inputId).toBe(input.inputId);
    expect(controls.inputs.consume({
      inputId: input.inputId, attemptId: job.attemptId, generation: 1,
    }).applied).toBe(true);
    expect(controls.waits.resolve({
      waitId: wait.waitId, attemptId: job.attemptId, generation: 1,
      producer: 'tui', idempotencyKey: 'approval-response:one', inputId: input.inputId,
      resolutionRef: 'approval:once',
    }).applied).toBe(true);
    expect(controls.waits.get(wait.waitId)).toMatchObject({
      state: 'satisfied', resolvedByInputId: input.inputId, resolutionRef: 'approval:once',
    });
  });

  it('adopts a pending wait onto the resumed Attempt and rejects the old generation', () => {
    const lease = jobs.claimAttempt({ attemptId: job.attemptId, ownerId: 'worker', ttlMs: 30_000 });
    jobs.transitionAttempt({
      attemptId: job.attemptId, generation: 1, fenceToken: lease.fenceToken!, expectedStateVersion: lease.stateVersion!,
      to: 'running', producer: 'test', eventIdempotencyKey: 'attempt-running',
    });
    jobs.transitionJob({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1, fenceToken: lease.fenceToken!, expectedStateVersion: 0,
      to: 'running', producer: 'test', eventIdempotencyKey: 'job-running',
    });
    const wait = controls.waits.create({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1, kind: 'clarification',
      producer: 'test', idempotencyNamespace: 'clarify', idempotencyKey: 'wait',
    }).record;
    controls.commands.request({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1, kind: 'pause', source: 'test',
      idempotencyNamespace: 'control', idempotencyKey: 'pause',
    });
    controls.commands.applyPendingAtBoundary({ jobId: job.jobId });
    const resumed = controls.commands.resume({
      jobId: job.jobId, source: 'test', instanceId: 'two', idempotencyNamespace: 'control', idempotencyKey: 'resume',
    });
    expect(controls.waits.get(wait.waitId)).toMatchObject({ attemptId: resumed.attemptId, generation: 2 });
    expect(controls.waits.resolve({
      waitId: wait.waitId, attemptId: job.attemptId, generation: 1,
      producer: 'test', idempotencyKey: 'old-attempt',
    })).toMatchObject({ applied: false, conflict: 'stale_generation' });
  });

  it('cancels pending waits before physical interruption and cannot revive a terminal Job', () => {
    const wait = controls.waits.create({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1, kind: 'approval',
      producer: 'test', idempotencyNamespace: 'approval', idempotencyKey: 'wait',
    }).record;
    controls.commands.request({
      jobId: job.jobId, attemptId: job.attemptId, generation: 1, kind: 'cancel', source: 'test',
      idempotencyNamespace: 'control', idempotencyKey: 'cancel',
    });
    expect(controls.waits.get(wait.waitId)?.state).toBe('cancelled');
    expect(controls.waits.resolve({
      waitId: wait.waitId, attemptId: job.attemptId, generation: 1,
      producer: 'test', idempotencyKey: 'late',
    })).toMatchObject({ applied: false, conflict: 'terminal_state' });
  });
});
