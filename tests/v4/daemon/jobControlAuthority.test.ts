/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import {
  createJobControlAuthority,
  type JobControlAuthority,
} from '../../../core/v4/daemon/jobControlAuthority';

describe('durable Job input and control authority', () => {
  let db: Database.Database;
  let jobs: JobEngine;
  let controls: JobControlAuthority;
  let admission: AdmissionResult;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (
         instance_id, pid, hostname, started_at, last_heartbeat, version
       ) VALUES ('instance-1', 1, 'test', 1, 1, 'test')`,
    ).run();
    db.prepare(
      `INSERT INTO daemon_instances (
         instance_id, pid, hostname, started_at, last_heartbeat, version
       ) VALUES ('instance-2', 2, 'test', 1, 1, 'test')`,
    ).run();
    jobs = createJobEngine({ db });
    controls = createJobControlAuthority({ db, jobEngine: jobs });
    admission = jobs.submitJob({
      entryPoint: 'interactive',
      source: 'test',
      sessionId: 'session-1',
      instanceId: 'instance-1',
      idempotencyNamespace: 'test',
      idempotencyKey: 'job-1',
      goal: 'test durable input',
    });
  });

  afterEach(() => db.close());

  it('persists before acknowledging, preserves order, and consumes exactly once', () => {
    const first = controls.inputs.receive({
      jobId: admission.jobId,
      targetAttemptId: admission.attemptId,
      targetGeneration: 1,
      sessionId: 'session-1',
      source: 'tui',
      kind: 'message',
      content: '  FIRST\n',
      idempotencyNamespace: 'tui:session-1',
      idempotencyKey: 'input-1',
    });
    const second = controls.inputs.receive({
      jobId: admission.jobId,
      targetAttemptId: admission.attemptId,
      targetGeneration: 1,
      sessionId: 'session-1',
      source: 'api',
      kind: 'message',
      content: 'SECOND',
      idempotencyNamespace: 'api:session-1',
      idempotencyKey: 'input-2',
    });

    expect(first.persisted).toBe(true);
    expect(first.record.content).toBe('  FIRST\n');
    expect([first.record.sequence, second.record.sequence]).toEqual([1, 2]);
    expect(controls.inputs.listPending(admission.jobId).map((entry) => entry.inputId))
      .toEqual([first.record.inputId, second.record.inputId]);

    const claim = controls.inputs.claimNext({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
    });
    expect(claim?.inputId).toBe(first.record.inputId);
    expect(controls.inputs.claimNext({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
    })?.inputId).toBe(second.record.inputId);
    expect(controls.inputs.consume({
      inputId: first.record.inputId,
      attemptId: admission.attemptId,
      generation: 1,
    }).applied).toBe(true);
    expect(controls.inputs.consume({
      inputId: first.record.inputId,
      attemptId: admission.attemptId,
      generation: 1,
    })).toMatchObject({ applied: false, duplicate: true });
  });

  it('deduplicates delivery, rejects stale generations, and excludes credentials', () => {
    const command = {
      jobId: admission.jobId,
      targetAttemptId: admission.attemptId,
      targetGeneration: 1,
      sessionId: 'session-1',
      source: 'channel',
      kind: 'message' as const,
      content: 'hello',
      idempotencyNamespace: 'channel:one',
      idempotencyKey: 'delivery-7',
    };
    const first = controls.inputs.receive(command);
    const duplicate = controls.inputs.receive(command);
    expect(duplicate).toMatchObject({ persisted: true, duplicate: true });
    expect(duplicate.record.inputId).toBe(first.record.inputId);

    expect(() => controls.inputs.receive({ ...command, idempotencyKey: 'stale', targetGeneration: 2 }))
      .toThrow(/stale generation/i);
    expect(() => controls.inputs.receive({ ...command, idempotencyKey: 'secret', kind: 'credential', content: 'secret' }))
      .toThrow(/credential/i);
    expect(JSON.stringify(controls.inputs.listPending(admission.jobId))).not.toContain('secret');
  });

  it('rejects new input addressed to a terminal Job', () => {
    controls.commands.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      kind: 'cancel',
      source: 'test',
      idempotencyNamespace: 'test-control',
      idempotencyKey: 'terminal-input-cancel',
    });
    expect(() => controls.inputs.receive({
      jobId: admission.jobId,
      targetAttemptId: admission.attemptId,
      targetGeneration: 1,
      sessionId: 'session-1',
      source: 'api',
      kind: 'message',
      content: 'do not reopen',
      idempotencyNamespace: 'api:session-1',
      idempotencyKey: 'terminal-input',
    })).toThrow(/terminal.*new Job|continuation/i);
  });

  it('persists steering and applies it once at a safe boundary', () => {
    const steer = controls.steering.submit({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      sessionId: 'session-1',
      source: 'tui',
      action: 'redirect',
      payload: 'use the narrower scope',
      idempotencyNamespace: 'steer:session-1',
      idempotencyKey: 'steer-1',
    });
    expect(steer.state).toBe('pending');
    expect(controls.steering.applyNext({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      safeBoundarySequence: 8,
    })).toMatchObject({ steeringId: steer.steeringId, state: 'applied', safeBoundarySequence: 8 });
    expect(controls.steering.applyNext({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      safeBoundarySequence: 9,
    })).toBeNull();
  });

  it('creates a new Attempt for goal-changing steering at a safe boundary', () => {
    const lease = jobs.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 30_000 });
    jobs.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!, fenceToken: lease.fenceToken!, to: 'running',
      producer: 'test', eventIdempotencyKey: 'goal-attempt-running',
    });
    jobs.transitionJob({
      jobId: admission.jobId, attemptId: admission.attemptId, expectedStateVersion: 0,
      generation: lease.generation!, fenceToken: lease.fenceToken!, to: 'running',
      producer: 'test', eventIdempotencyKey: 'goal-job-running',
    });
    controls.steering.submit({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 1,
      sessionId: 'session-1', source: 'tui', action: 'replace_goal', payload: 'new durable goal',
      idempotencyNamespace: 'steer:session-1', idempotencyKey: 'replace-goal',
    });

    expect(controls.steering.applyNext({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 1,
      safeBoundarySequence: 12, instanceId: 'instance-2',
    })).toMatchObject({ action: 'replace_goal', state: 'applied' });
    const current = jobs.getJob(admission.jobId)!;
    expect(current.activeAttemptId).not.toBe(admission.attemptId);
    expect(jobs.getAttempt(current.activeAttemptId!)?.generation).toBe(2);
  });

  it('rejects stale steering after a newer Attempt becomes active', () => {
    const steer = controls.steering.submit({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 1,
      sessionId: 'session-1', source: 'tui', action: 'skip',
      idempotencyNamespace: 'steer:session-1', idempotencyKey: 'stale-steer',
    });
    db.prepare("UPDATE steering_commands SET generation = 2 WHERE steering_id = ?").run(steer.steeringId);
    expect(controls.steering.applyNext({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 2,
      safeBoundarySequence: 4,
    })).toMatchObject({ steeringId: steer.steeringId, state: 'rejected', rejectionReason: 'stale generation' });
  });

  it('does not let a queued steering record displace the next chat message claim', () => {
    controls.steering.submit({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      sessionId: 'session-1',
      source: 'tui',
      action: 'redirect',
      payload: 'narrow the result',
      idempotencyNamespace: 'steer:session-1',
      idempotencyKey: 'steer-before-message',
    });
    const message = controls.inputs.receive({
      jobId: admission.jobId,
      sessionId: 'session-1',
      source: 'tui',
      kind: 'message',
      content: 'next user turn',
      idempotencyNamespace: 'tui:session-1',
      idempotencyKey: 'message-after-steer',
    });

    expect(controls.inputs.claimNext({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      kinds: ['message'],
    })?.inputId).toBe(message.record.inputId);
  });

  it('restores an exact claimed input after authority reconstruction', () => {
    const received = controls.inputs.receive({
      jobId: admission.jobId,
      targetAttemptId: admission.attemptId,
      targetGeneration: 1,
      sessionId: 'session-1',
      source: 'tui',
      kind: 'message',
      content: 'survive restart',
      idempotencyNamespace: 'tui:session-1',
      idempotencyKey: 'restart-claim',
    });
    expect(controls.inputs.claimNext({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      inputId: received.record.inputId,
      kinds: ['message'],
    })?.state).toBe('claimed');

    const restored = createJobControlAuthority({ db, jobEngine: createJobEngine({ db }) });
    expect(restored.inputs.claimNext({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      inputId: received.record.inputId,
      kinds: ['message'],
    })?.inputId).toBe(received.record.inputId);
    expect(restored.inputs.consume({
      inputId: received.record.inputId,
      attemptId: admission.attemptId,
      generation: 1,
    }).applied).toBe(true);
  });

  it('projects input lifecycle by reference without copying content into Job events', () => {
    const secretLikeContent = 'ordinary input with private material';
    const received = controls.inputs.receive({
      jobId: admission.jobId,
      targetAttemptId: admission.attemptId,
      targetGeneration: 1,
      sessionId: 'session-1',
      source: 'api',
      kind: 'message',
      content: secretLikeContent,
      idempotencyNamespace: 'api:session-1',
      idempotencyKey: 'event-projection',
    });
    controls.inputs.claimNext({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      inputId: received.record.inputId,
    });
    controls.inputs.consume({
      inputId: received.record.inputId,
      attemptId: admission.attemptId,
      generation: 1,
    });

    const events = jobs.listEvents(admission.jobId).filter((event) => event.type.startsWith('input.'));
    expect(events.map((event) => event.type)).toEqual(['input.queued', 'input.claimed', 'input.consumed']);
    expect(events.every((event) => event.payload?.inputId === received.record.inputId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secretLikeContent);
  });

  it('persists cancellation before physically aborting and makes races idempotent', () => {
    const abort = new AbortController();
    controls.runtime.attach(admission.attemptId, abort);
    const result = controls.commands.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      kind: 'cancel',
      source: 'api',
      reason: 'user requested stop',
      idempotencyNamespace: 'api-control',
      idempotencyKey: 'cancel-1',
    });
    expect(result.persisted).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    expect(jobs.getJob(admission.jobId)?.status).toBe('cancelled');
    expect(controls.commands.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      kind: 'cancel',
      source: 'api',
      reason: 'duplicate',
      idempotencyNamespace: 'api-control',
      idempotencyKey: 'cancel-1',
    }).duplicate).toBe(true);
  });

  it('cascades parent cancellation to active child Jobs and runtimes', () => {
    const child = jobs.submitJob({
      entryPoint: 'subagent',
      source: 'parent',
      sessionId: 'session-1',
      instanceId: 'instance-1',
      idempotencyNamespace: 'test-child',
      idempotencyKey: 'child-1',
      goal: 'child work',
      parentJobId: admission.jobId,
      rootJobId: admission.jobId,
    });
    const parentAbort = new AbortController();
    const childAbort = new AbortController();
    controls.runtime.attach(admission.attemptId, parentAbort);
    controls.runtime.attach(child.attemptId, childAbort);

    expect(controls.commands.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      kind: 'cancel',
      source: 'api',
      reason: 'cancel family',
      idempotencyNamespace: 'api-control',
      idempotencyKey: 'cancel-family',
    }).applied).toBe(true);
    expect(jobs.getJob(admission.jobId)?.status).toBe('cancelled');
    expect(jobs.getJob(child.jobId)?.status).toBe('cancelled');
    expect(parentAbort.signal.aborted).toBe(true);
    expect(childAbort.signal.aborted).toBe(true);
  });

  it('persists pause and creates a new attempt on resume', () => {
    const claimed = jobs.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 30_000 });
    expect(claimed.acquired).toBe(true);
    const startedAttempt = jobs.transitionAttempt({
      attemptId: admission.attemptId,
      expectedStateVersion: claimed.stateVersion!,
      generation: claimed.generation!,
      fenceToken: claimed.fenceToken!,
      to: 'running',
      producer: 'test',
      eventIdempotencyKey: 'attempt-running',
    });
    const startedJob = jobs.transitionJob({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      expectedStateVersion: 0,
      generation: claimed.generation!,
      fenceToken: claimed.fenceToken!,
      to: 'running',
      producer: 'test',
      eventIdempotencyKey: 'job-running',
    });
    expect(startedAttempt.applied && startedJob.applied).toBe(true);

    const paused = controls.commands.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      kind: 'pause',
      source: 'tui',
      reason: 'user pause',
      idempotencyNamespace: 'tui-control',
      idempotencyKey: 'pause-1',
    });
    expect(paused.persisted).toBe(true);
    expect(paused.applied).toBe(false);
    expect(controls.commands.applyPendingAtBoundary({ jobId: admission.jobId })).toEqual({ applied: true, kind: 'pause' });
    expect(jobs.getJob(admission.jobId)?.status).toBe('paused');

    const resumed = controls.commands.resume({
      jobId: admission.jobId,
      source: 'tui',
      instanceId: 'instance-2',
      idempotencyNamespace: 'tui-control',
      idempotencyKey: 'resume-1',
    });
    expect(resumed.attemptId).not.toBe(admission.attemptId);
    expect(resumed.generation).toBe(2);
    expect(jobs.getJob(admission.jobId)?.activeAttemptId).toBe(resumed.attemptId);
  });

  it('keeps runtime signal registration scoped to the exact attempt', () => {
    const first = new AbortController();
    const second = new AbortController();
    const detachFirst = controls.runtime.attach(admission.attemptId, first);
    controls.runtime.attach(admission.attemptId, second);
    detachFirst();
    controls.runtime.cancel(admission.attemptId, 'cancel current');
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });
});
