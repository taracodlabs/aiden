/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';

describe('durable Job recovery', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let sequence = 0;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('recovery_instance', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  function expiredAttempt() {
    sequence += 1;
    const admitted = engine.submitJob({
      entryPoint: 'daemon', source: 'daemon', sessionId: `session_${sequence}`,
      instanceId: 'recovery_instance', idempotencyNamespace: 'recovery',
      idempotencyKey: `job_${sequence}`, requestFingerprint: `fingerprint_${sequence}`,
      goal: 'recover safely',
    });
    const base = Date.now();
    const lease = engine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'old_worker', ttlMs: 10, now: base,
    });
    return { ...admitted, ...lease, base };
  }

  it('creates a new Attempt instead of resurrecting an expired generation', () => {
    const expired = expiredAttempt();

    expect(engine.recoverExpiredAttempts({
      now: expired.base + 11,
      instanceId: 'recovery_instance',
      producer: 'recovery',
      maxCrashes: 3,
    })).toEqual([expect.objectContaining({ jobId: expired.jobId, decision: 'retry' })]);

    const attempts = engine.listAttempts(expired.jobId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ id: expired.attemptId, status: 'crashed' });
    expect(attempts[1]).toMatchObject({ status: 'queued', attemptNumber: 2, generation: 2 });
    expect(engine.getJob(expired.jobId)).toMatchObject({ status: 'recovering', activeAttemptId: attempts[1]!.id });
  });

  it('does not replay an unknown mutating side effect', () => {
    const expired = expiredAttempt();
    engine.prepareToolCall({
      toolCallId: 'tool_unknown', jobId: expired.jobId, attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!,
      toolName: 'external_send', normalizedArgsDigest: 'digest', riskTier: 'dangerous',
      mutates: true, producer: 'test', now: expired.base + 1,
    });
    engine.startToolCall({
      toolCallId: 'tool_unknown', attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!, producer: 'test',
      now: expired.base + 2,
    });

    expect(engine.recoverExpiredAttempts({
      now: expired.base + 11,
      instanceId: 'recovery_instance', producer: 'recovery', maxCrashes: 3,
    })).toEqual([expect.objectContaining({ decision: 'ask_user' })]);
    expect(engine.listAttempts(expired.jobId)).toHaveLength(1);
    expect(engine.getAttempt(expired.attemptId)?.status).toBe('unknown');
    expect(engine.getJob(expired.jobId)?.status).toBe('blocked');
  });

  it('retries a read-only tool interrupted after start', () => {
    const expired = expiredAttempt();
    engine.prepareToolCall({
      toolCallId: 'tool_read_started', jobId: expired.jobId, attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!,
      toolName: 'file_read', normalizedArgsDigest: 'read-digest', riskTier: 'safe',
      mutates: false, producer: 'test', now: expired.base + 1,
    });
    engine.startToolCall({
      toolCallId: 'tool_read_started', attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!, producer: 'test',
      now: expired.base + 2,
    });

    expect(engine.recoverExpiredAttempts({
      now: expired.base + 11, instanceId: 'recovery_instance', producer: 'recovery', maxCrashes: 3,
    })).toEqual([expect.objectContaining({ decision: 'retry' })]);
    expect(engine.listAttempts(expired.jobId)).toHaveLength(2);
  });

  it('retries a mutating tool that was prepared but never started', () => {
    const expired = expiredAttempt();
    engine.prepareToolCall({
      toolCallId: 'tool_prepared_only', jobId: expired.jobId, attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!,
      toolName: 'file_write', normalizedArgsDigest: 'prepared-digest', riskTier: 'caution',
      mutates: true, producer: 'test', now: expired.base + 1,
    });

    expect(engine.recoverExpiredAttempts({
      now: expired.base + 11, instanceId: 'recovery_instance', producer: 'recovery', maxCrashes: 3,
    })).toEqual([expect.objectContaining({ decision: 'retry' })]);
  });

  it('does not replay a committed mutating side effect when final Job confirmation is missing', () => {
    const expired = expiredAttempt();
    engine.prepareToolCall({
      toolCallId: 'tool_committed', jobId: expired.jobId, attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!,
      toolName: 'file_write', normalizedArgsDigest: 'committed-digest', riskTier: 'caution',
      mutates: true, producer: 'test', now: expired.base + 1,
    });
    engine.startToolCall({
      toolCallId: 'tool_committed', attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!, producer: 'test',
      now: expired.base + 2,
    });
    engine.completeToolCall({
      toolCallId: 'tool_committed', attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!,
      state: 'completed', sideEffectState: 'committed', resultRef: 'tool-result:sha256:known',
      producer: 'test', now: expired.base + 3,
    });

    expect(engine.recoverExpiredAttempts({
      now: expired.base + 11, instanceId: 'recovery_instance', producer: 'recovery', maxCrashes: 3,
    })).toEqual([expect.objectContaining({ decision: 'ask_user' })]);
    expect(engine.listAttempts(expired.jobId)).toHaveLength(1);
    expect(engine.getJob(expired.jobId)).toMatchObject({ status: 'blocked', finishReason: 'unknown_side_effect' });
  });

  it('can retry after a completed read-only tool result but before terminal Job state', () => {
    const expired = expiredAttempt();
    engine.prepareToolCall({
      toolCallId: 'tool_read_complete', jobId: expired.jobId, attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!,
      toolName: 'file_read', normalizedArgsDigest: 'read-complete-digest', riskTier: 'safe',
      mutates: false, producer: 'test', now: expired.base + 1,
    });
    engine.startToolCall({
      toolCallId: 'tool_read_complete', attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!, producer: 'test',
      now: expired.base + 2,
    });
    engine.completeToolCall({
      toolCallId: 'tool_read_complete', attemptId: expired.attemptId,
      generation: expired.generation!, fenceToken: expired.fenceToken!,
      state: 'completed', resultRef: 'tool-result:sha256:read', producer: 'test', now: expired.base + 3,
    });

    expect(engine.recoverExpiredAttempts({
      now: expired.base + 11, instanceId: 'recovery_instance', producer: 'recovery', maxCrashes: 3,
    })).toEqual([expect.objectContaining({ decision: 'retry' })]);
  });

  it('dead-letters a crash loop at the configured threshold', () => {
    const expired = expiredAttempt();
    db.prepare('UPDATE tasks SET crash_count = 2 WHERE id = ?').run(expired.jobId);

    expect(engine.recoverExpiredAttempts({
      now: expired.base + 11,
      instanceId: 'recovery_instance', producer: 'recovery', maxCrashes: 3,
    })).toEqual([expect.objectContaining({ decision: 'dead_letter' })]);
    expect(engine.getJob(expired.jobId)?.status).toBe('dead_letter');
    expect(engine.listAttempts(expired.jobId)).toHaveLength(1);
  });

  it('is idempotent after the first scan resolves an expired Attempt', () => {
    const expired = expiredAttempt();
    const command = {
      now: expired.base + 11,
      instanceId: 'recovery_instance', producer: 'recovery', maxCrashes: 3,
    };
    expect(engine.recoverExpiredAttempts(command)).toHaveLength(1);
    expect(engine.recoverExpiredAttempts(command)).toEqual([]);
  });
});
