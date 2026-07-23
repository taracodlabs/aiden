/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  IdempotencyConflictError,
  createJobEngine,
  type JobEngine,
} from '../../../core/v4/daemon/jobEngine';

let db: Database.Database;
let engine: JobEngine;

function seedInstance(instanceId = 'instance_test'): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(instanceId, 1, 'localhost', now, now, '4.15.1');
}

function submit(overrides: Partial<Parameters<JobEngine['submitJob']>[0]> = {}) {
  return engine.submitJob({
    entryPoint: 'test',
    source: 'unit',
    sessionId: 'session_test',
    workspaceId: 'workspace_test',
    principalId: 'principal_test',
    instanceId: 'instance_test',
    idempotencyNamespace: 'test',
    idempotencyKey: 'submission_1',
    requestFingerprint: 'fingerprint_1',
    goal: 'Exercise the durable Job engine',
    ...overrides,
  });
}

function claimJob(admitted: ReturnType<typeof submit>, ownerId = 'owner_a') {
  const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId, ttlMs: 30_000 });
  if (!lease.acquired || lease.generation === undefined || !lease.fenceToken) {
    throw new Error(`test lease unavailable: ${lease.conflict ?? 'unknown'}`);
  }
  return {
    attemptId: admitted.attemptId,
    generation: lease.generation,
    fenceToken: lease.fenceToken,
  };
}

function recoverExpired(now: number) {
  return engine.recoverExpiredAttempts({
    now,
    instanceId: 'instance_test',
    producer: 'test-recovery',
    maxCrashes: 3,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedInstance();
  engine = createJobEngine({ db });
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

describe('Job admission', () => {
  it('durably creates exactly one Job and Attempt before returning', () => {
    const admitted = submit();

    expect(admitted.reused).toBe(false);
    expect(admitted.jobId).toMatch(/^task_/);
    expect(admitted.attemptId).toMatch(/^attempt_/);
    expect(engine.getJob(admitted.jobId)).toMatchObject({
      id: admitted.jobId,
      status: 'queued',
      activeAttemptId: admitted.attemptId,
      stateVersion: 0,
    });
    expect(engine.getAttempt(admitted.attemptId)).toMatchObject({
      id: admitted.attemptId,
      jobId: admitted.jobId,
      status: 'queued',
      attemptNumber: 1,
      generation: 1,
    });
    expect(engine.listEvents(admitted.jobId, 0).map((event) => event.type)).toEqual([
      'job.submitted',
      'attempt.created',
    ]);
  });

  it('reuses the existing Job for the same idempotency key and fingerprint', () => {
    const first = submit();
    const duplicate = submit();

    expect(duplicate).toEqual({ ...first, reused: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
  });

  it('rejects the same idempotency key with a different fingerprint', () => {
    submit();
    expect(() => submit({ requestFingerprint: 'different' })).toThrow(IdempotencyConflictError);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  });

  it('persists an internal idempotency key when the client supplies none', () => {
    const admitted = submit({ idempotencyKey: undefined });
    const row = db.prepare(
      'SELECT idempotency_key FROM tasks WHERE id = ?',
    ).get(admitted.jobId) as { idempotency_key: string };
    expect(row.idempotency_key).toMatch(/^internal_/);
  });
});

describe('transactional transitions', () => {
  it('commits Job state and its event together with compare-and-set versioning', () => {
    const admitted = submit();
    const authority = claimJob(admitted);
    const result = engine.transitionJob({
      jobId: admitted.jobId,
      ...authority,
      expectedStateVersion: 0,
      to: 'running',
      eventIdempotencyKey: 'job-running',
      producer: 'test',
    });

    expect(result).toMatchObject({ applied: true, stateVersion: 1 });
    expect(engine.getJob(admitted.jobId)).toMatchObject({ status: 'running', stateVersion: 1 });
    expect(engine.listEvents(admitted.jobId, 0).at(-1)).toMatchObject({
      type: 'job.running',
      jobSequence: 4,
    });
  });

  it('rolls back state when event append fails', () => {
    const admitted = submit();
    const authority = claimJob(admitted);
    db.exec(`
      CREATE TRIGGER reject_transition_event
      BEFORE INSERT ON run_events
      WHEN NEW.kind = 'job.running'
      BEGIN
        SELECT RAISE(ABORT, 'event rejected');
      END;
    `);

    expect(() => engine.transitionJob({
      jobId: admitted.jobId,
      ...authority,
      expectedStateVersion: 0,
      to: 'running',
      eventIdempotencyKey: 'job-running',
      producer: 'test',
    })).toThrow(/event rejected/);
    expect(engine.getJob(admitted.jobId)).toMatchObject({ status: 'queued', stateVersion: 0 });
    expect(engine.listEvents(admitted.jobId, 0)).toHaveLength(3);
  });

  it('rejects stale versions and never overwrites terminal truth', () => {
    const admitted = submit();
    const authority = claimJob(admitted);
    expect(engine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: 0,
      generation: authority.generation,
      fenceToken: authority.fenceToken,
      to: 'running',
      eventIdempotencyKey: 'stale-attempt-version',
      producer: 'test',
    })).toMatchObject({ applied: false, conflict: 'state_version' });
    expect(engine.transitionJob({
      jobId: admitted.jobId,
      ...authority,
      expectedStateVersion: 0,
      to: 'cancelled',
      eventIdempotencyKey: 'cancel',
      producer: 'test',
    }).applied).toBe(true);

    const stale = engine.transitionJob({
      jobId: admitted.jobId,
      ...authority,
      expectedStateVersion: 0,
      to: 'completed',
      eventIdempotencyKey: 'late-success',
      producer: 'test',
    });
    expect(stale).toMatchObject({ applied: false, conflict: 'terminal_state' });

    const terminal = engine.transitionJob({
      jobId: admitted.jobId,
      ...authority,
      expectedStateVersion: 1,
      to: 'completed',
      eventIdempotencyKey: 'late-success-2',
      producer: 'test',
    });
    expect(terminal).toMatchObject({ applied: false, conflict: 'terminal_state' });
    expect(engine.getJob(admitted.jobId)?.status).toBe('cancelled');
  });

  it('makes duplicate transition commands idempotent', () => {
    const admitted = submit();
    const authority = claimJob(admitted);
    const command = {
      jobId: admitted.jobId,
      ...authority,
      expectedStateVersion: 0,
      to: 'running' as const,
      eventIdempotencyKey: 'same-command',
      producer: 'test',
    };
    const first = engine.transitionJob(command);
    const duplicate = engine.transitionJob(command);

    expect(first.applied).toBe(true);
    expect(duplicate).toMatchObject({ applied: false, duplicate: true });
    expect(engine.listEvents(admitted.jobId, 0).filter((event) => event.type === 'job.running')).toHaveLength(1);
  });

  it('finalizes lifecycle, verification evidence, and its event in one transaction', () => {
    const admitted = submit();
    const lease = engine.claimAttempt({
      attemptId: admitted.attemptId,
      ownerId: 'owner_a',
      ttlMs: 30_000,
    });
    engine.transitionJob({
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      expectedStateVersion: 0,
      to: 'running',
      eventIdempotencyKey: 'job-running',
      producer: 'test',
    });

    const result = engine.finalizeJob({
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      expectedStateVersion: 1,
      status: 'completed',
      outcome: 'completed_unverified',
      finishReason: 'stop',
      evidence: { version: 1, verdict: 'unverified' },
      jobCard: { filesTouched: ['result.txt'] },
      eventIdempotencyKey: 'job-finalized',
      producer: 'test',
    });

    expect(result).toMatchObject({ applied: true, stateVersion: 2 });
    expect(engine.getJob(admitted.jobId)).toMatchObject({
      status: 'completed',
      terminalOutcome: 'completed_unverified',
      finishReason: 'stop',
    });
    expect(db.prepare('SELECT evidence, files_touched FROM tasks WHERE id = ?').get(admitted.jobId)).toEqual({
      evidence: JSON.stringify({
        version: 1,
        verdict: 'unverified',
        durableExecution: {
          jobId: admitted.jobId,
          attemptId: admitted.attemptId,
          generation: lease.generation,
          toolCallIds: [],
        },
      }),
      files_touched: JSON.stringify(['result.txt']),
    });
    expect(engine.listEvents(admitted.jobId, 0).at(-1)?.type).toBe('job.finalized');
  });

  it('rejects stale evidence and completion from a reclaimed Attempt fence', () => {
    const admitted = submit();
    const base = Date.now();
    const first = engine.claimAttempt({
      attemptId: admitted.attemptId,
      ownerId: 'owner_a',
      ttlMs: 10,
      now: base,
    });
    engine.transitionJob({
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: first.generation!,
      fenceToken: first.fenceToken!,
      expectedStateVersion: 0,
      to: 'running',
      eventIdempotencyKey: 'stale-job-running',
      producer: 'test',
      now: base,
    });
    const recovery = recoverExpired(base + 11)[0]!;
    const reclaimed = engine.claimAttempt({
      attemptId: recovery.recoveryAttemptId!,
      ownerId: 'owner_b',
      ttlMs: 30_000,
      now: base + 11,
    });
    expect(reclaimed).toMatchObject({ acquired: true, generation: 2 });

    const stale = engine.finalizeJob({
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: first.generation!,
      fenceToken: first.fenceToken!,
      expectedStateVersion: 1,
      status: 'completed',
      outcome: 'verified',
      finishReason: 'stop',
      evidence: { verdict: 'verified', stale: true },
      eventIdempotencyKey: 'stale-job-finalized',
      producer: 'test',
    });

    expect(stale).toMatchObject({ applied: false, conflict: 'stale_fence' });
    expect(engine.getJob(admitted.jobId)).toMatchObject({ status: 'recovering', activeAttemptId: recovery.recoveryAttemptId });
    expect(db.prepare('SELECT evidence FROM tasks WHERE id = ?').get(admitted.jobId)).toEqual({ evidence: null });
    expect(engine.listEvents(admitted.jobId).some((event) => event.idempotencyKey === 'stale-job-finalized')).toBe(false);
  });

  it('lets cancellation win atomically and rejects the late worker result', () => {
    const admitted = submit();
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'owner_a', ttlMs: 30_000 });
    const attemptRunning = engine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'running',
      eventIdempotencyKey: 'cancel-race-attempt-running',
      producer: 'test',
    });
    engine.transitionJob({
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      expectedStateVersion: 0,
      to: 'running',
      eventIdempotencyKey: 'cancel-race-job-running',
      producer: 'test',
    });

    expect(engine.cancelJob({
      jobId: admitted.jobId,
      reason: 'user_cancelled',
      producer: 'test',
      eventIdempotencyKey: 'cancel-race-winner',
    })).toMatchObject({ applied: true, stateVersion: 2 });
    expect(engine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: attemptRunning.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'succeeded',
      eventIdempotencyKey: 'cancel-race-late-attempt',
      producer: 'test',
    })).toMatchObject({ applied: false, conflict: 'terminal_state' });
    expect(engine.finalizeJob({
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      expectedStateVersion: 1,
      status: 'completed',
      outcome: 'verified',
      finishReason: 'stop',
      evidence: { stale: true },
      eventIdempotencyKey: 'cancel-race-late-job',
      producer: 'test',
    })).toMatchObject({ applied: false, conflict: 'terminal_state' });
    expect(engine.getJob(admitted.jobId)).toMatchObject({ status: 'cancelled', terminalOutcome: 'cancelled' });
    expect(engine.getAttempt(admitted.attemptId)?.status).toBe('cancelled');
  });
});

describe('Attempt leases and fencing', () => {
  it('allows only one owner to claim an Attempt', () => {
    const admitted = submit();
    const first = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'owner_a', ttlMs: 30_000 });
    const second = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'owner_b', ttlMs: 30_000 });

    expect(first.acquired).toBe(true);
    expect(first.leaseId).toMatch(/^lease_/);
    expect(first.fenceToken).toMatch(/^fence_/);
    expect(second).toMatchObject({ acquired: false, conflict: 'lease_held' });
  });

  it('rejects stale fence writes after lease expiry and reclaim', () => {
    const admitted = submit();
    const first = engine.claimAttempt({
      attemptId: admitted.attemptId,
      ownerId: 'owner_a',
      ttlMs: 10,
      now: 1_000,
    });
    const recovery = recoverExpired(1_011)[0]!;
    const reclaimed = engine.claimAttempt({
      attemptId: recovery.recoveryAttemptId!,
      ownerId: 'owner_b',
      ttlMs: 10_000,
      now: 1_011,
    });
    expect(reclaimed).toMatchObject({ acquired: true, generation: 2 });

    const stale = engine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: first.stateVersion!,
      generation: first.generation!,
      fenceToken: first.fenceToken!,
      to: 'succeeded',
      eventIdempotencyKey: 'stale-success',
      producer: 'test',
    });
    expect(stale).toMatchObject({ applied: false, conflict: 'terminal_state' });
    expect(engine.getAttempt(admitted.attemptId)?.generation).toBe(1);
    expect(engine.getAttempt(recovery.recoveryAttemptId!)?.generation).toBe(2);
  });

  it('creates a new Attempt for recovery instead of resurrecting a terminal Attempt', () => {
    const admitted = submit();
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'owner_a', ttlMs: 30_000 });
    expect(engine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'failed',
      eventIdempotencyKey: 'attempt-failed',
      producer: 'test',
    }).applied).toBe(true);

    const recovery = engine.createRecoveryAttempt({
      jobId: admitted.jobId,
      recoveryOfAttemptId: admitted.attemptId,
      instanceId: 'instance_test',
      triggerReason: 'retry',
      eventIdempotencyKey: 'attempt-recovery',
      producer: 'test',
    });
    expect(recovery.attemptId).not.toBe(admitted.attemptId);
    expect(recovery).toMatchObject({ attemptNumber: 2, generation: 2 });
    expect(engine.getAttempt(admitted.attemptId)?.status).toBe('failed');
    expect(engine.getJob(admitted.jobId)).toMatchObject({
      activeAttemptId: recovery.attemptId,
      status: 'recovering',
      stateVersion: 1,
    });
  });
});

describe('ToolCall and SideEffect identity', () => {
  it('persists prepared, started, and committed mutating execution under the active fence', () => {
    const admitted = submit();
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'owner_a', ttlMs: 30_000 });
    engine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'running',
      eventIdempotencyKey: 'attempt-running',
      producer: 'test',
    });

    expect(engine.prepareToolCall({
      toolCallId: 'tool_call_1',
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      toolName: 'file_write',
      normalizedArgsDigest: 'digest_1',
      riskTier: 'caution',
      mutates: true,
      producer: 'test',
    }).applied).toBe(true);
    expect(engine.startToolCall({
      toolCallId: 'tool_call_1',
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      producer: 'test',
    }).applied).toBe(true);
    expect(engine.completeToolCall({
      toolCallId: 'tool_call_1',
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      state: 'completed',
      sideEffectState: 'committed',
      resultRef: 'tool-result:sha256:result',
      producer: 'test',
    }).applied).toBe(true);

    expect(engine.attachToolVerification({
      toolCallId: 'tool_call_1',
      attemptId: admitted.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      verificationRef: 'tool-verification:sha256:verification',
      producer: 'test',
    }).applied).toBe(true);

    expect(db.prepare(
      'SELECT state, side_effect_id, result_ref, verification_ref FROM tool_calls WHERE tool_call_id = ?',
    ).get('tool_call_1')).toMatchObject({
      state: 'completed',
      side_effect_id: 'side_effect:tool_call_1',
      result_ref: 'tool-result:sha256:result',
      verification_ref: 'tool-verification:sha256:verification',
    });
    expect(db.prepare('SELECT effect_state FROM side_effect_ledger WHERE tool_call_id = ?').get('tool_call_1')).toEqual({
      effect_state: 'committed',
    });
  });

  it('rejects a stale ToolCall result after the Attempt is reclaimed', () => {
    const admitted = submit();
    const base = Date.now();
    const first = engine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'owner_a', ttlMs: 10, now: base,
    });
    engine.prepareToolCall({
      toolCallId: 'tool_call_stale',
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      generation: first.generation!,
      fenceToken: first.fenceToken!,
      toolName: 'file_write',
      normalizedArgsDigest: 'digest_stale',
      riskTier: 'caution',
      mutates: true,
      producer: 'test',
    });
    recoverExpired(base + 11);

    expect(engine.completeToolCall({
      toolCallId: 'tool_call_stale',
      attemptId: admitted.attemptId,
      generation: first.generation!,
      fenceToken: first.fenceToken!,
      state: 'completed',
      sideEffectState: 'committed',
      producer: 'test',
    })).toMatchObject({ applied: false, conflict: 'stale_fence' });
    expect(db.prepare('SELECT state FROM tool_calls WHERE tool_call_id = ?').get('tool_call_stale')).toEqual({ state: 'prepared' });
  });

  it('rejects authoritative writes after the active lease expires', () => {
    const admitted = submit();
    const base = Date.now();
    const lease = engine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'owner_a', ttlMs: 10, now: base,
    });

    expect(engine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'running',
      eventIdempotencyKey: 'expired-write',
      producer: 'test',
      now: base + 11,
    })).toMatchObject({ applied: false, conflict: 'lease_expired' });
  });
});

describe('Job queries', () => {
  it('lists Jobs by session and status without exposing a second authority', () => {
    const first = submit({ sessionId: 'session_a' });
    submit({ sessionId: 'session_b', idempotencyKey: 'submission_2', requestFingerprint: 'fingerprint_2' });

    expect(engine.listJobs({ sessionId: 'session_a', status: 'queued' }).map((job) => job.id)).toEqual([
      first.jobId,
    ]);
  });
});
