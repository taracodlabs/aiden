/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { sweepDurableJobRecovery } from '../../../core/v4/daemon/jobRecoverySweep';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { bindRun, createWorkerFixture, type WorkerFixture } from './fixture';

describe('Worker provider recovery reconciliation', () => {
  let fixture: WorkerFixture | undefined;
  const tempDirs: string[] = [];
  afterEach(() => {
    if (fixture?.db.open) fixture.db.close();
    fixture = undefined;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function prepare(state: 'prepared' | 'attempting') {
    const current = fixture = createWorkerFixture();
    const records = bindRun(current);
    const command = {
      ...current.childAuthority,
      logicalCallId: `logical_recovery_${state}`,
      idempotencyKey: `logical-recovery-${state}`,
      workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId,
      providerBindingId: records.providerBinding.providerBindingId,
      callOrdinal: 1,
      requestHash: 'c'.repeat(64),
      toolSchemaHash: 'd'.repeat(64),
      now: 30,
    };
    current.engine.workerProviderCalls.prepare(command);
    if (state === 'attempting') current.engine.workerProviderCalls.markAttempting(command);
    current.db.prepare('UPDATE runs SET lease_expires_at=? WHERE attempt_id=?')
      .run(40, current.child.attemptId);
    return { current, command, records };
  }

  it('allows JobEngine to replace a no-send call only after the old Attempt is fenced', () => {
    const { current, command, records } = prepare('prepared');
    const [decision] = current.engine.recoverExpiredAttempts({
      now: 41,
      instanceId: 'worker-instance',
      producer: 'test',
      maxCrashes: 3,
    });
    expect(decision).toMatchObject({
      jobId: current.child.jobId,
      expiredAttemptId: current.child.attemptId,
      decision: 'retry',
      workerReconciliation: {
        calls: 1,
        retrySafety: 'safe',
        outcomeKnowledge: ['no_request_started'],
      },
    });
    expect(decision?.recoveryAttemptId).not.toBe(current.child.attemptId);
    expect(current.engine.getAttempt(current.child.attemptId)).toMatchObject({
      status: 'crashed', fenceToken: current.childAuthority.childFenceToken, leaseOwner: null,
    });
    expect(current.engine.workerProviderCalls.get(command.logicalCallId)).toMatchObject({
      authorityLostAt: 41,
      retrySafety: 'safe',
      reconciliationState: 'reconciled',
    });
    const nextLease = current.engine.claimAttempt({
      attemptId: decision!.recoveryAttemptId!, ownerId: 'child-owner-next', ttlMs: 60_000, now: 42,
    });
    const nextRun = current.engine.worker.bindWorkerRunFromAssignment({
      childJobId: current.child.jobId,
      childAttemptId: decision!.recoveryAttemptId!,
      childGeneration: nextLease.generation!,
      childFenceToken: nextLease.fenceToken!,
      workerRunId: 'worker_run_recovery_next',
      schemaVersion: 1,
      assignmentId: records.assignment.assignmentId,
      providerBindingId: records.providerBinding.providerBindingId,
      contextEnvelopeId: records.contextEnvelope.contextEnvelopeId,
      producer: 'test',
      idempotencyKey: 'worker-run-recovery-next',
      now: 43,
    });
    expect(current.engine.workerProviderCalls.prepare({
      childJobId: current.child.jobId,
      childAttemptId: decision!.recoveryAttemptId!,
      childGeneration: nextLease.generation!,
      childFenceToken: nextLease.fenceToken!,
      logicalCallId: 'logical_recovery_replacement',
      idempotencyKey: 'logical-recovery-replacement',
      workerRunId: nextRun.workerRunId,
      assignmentId: records.assignment.assignmentId,
      providerBindingId: records.providerBinding.providerBindingId,
      callOrdinal: 1,
      requestHash: 'e'.repeat(64),
      toolSchemaHash: 'd'.repeat(64),
      now: 44,
    })).toMatchObject({ recoveryPredecessorLogicalCallId: command.logicalCallId });
  });

  it('blocks automatic replacement when a sent request has unknown outcome and spend', () => {
    const { current, command } = prepare('attempting');
    const [decision] = current.engine.recoverExpiredAttempts({
      now: 41,
      instanceId: 'worker-instance',
      producer: 'test',
      maxCrashes: 3,
    });
    expect(decision).toMatchObject({
      jobId: current.child.jobId,
      expiredAttemptId: current.child.attemptId,
      decision: 'ask_user',
      workerReconciliation: {
        calls: 1,
        retrySafety: 'blocked_unknown',
        outcomeKnowledge: ['outcome_unknown'],
      },
    });
    expect(decision?.recoveryAttemptId).toBeUndefined();
    expect(current.engine.getJob(current.child.jobId)).toMatchObject({
      status: 'blocked', activeAttemptId: null,
    });
    expect(current.engine.getAttempt(current.child.attemptId)).toMatchObject({ status: 'unknown' });
    expect(current.engine.workerProviderCalls.get(command.logicalCallId)).toMatchObject({
      authorityLostAt: 41,
      retrySafety: 'blocked_unknown',
      outcomeKnowledge: 'outcome_unknown',
      reconciliationState: 'blocked_unknown',
    });
  });

  it('persists cancellation intent through JobEngine before terminal Attempt settlement', () => {
    const { current, command } = prepare('attempting');
    expect(current.engine.cancelJob({
      jobId: current.child.jobId,
      reason: 'operator_cancelled',
      producer: 'test',
      eventIdempotencyKey: 'cancel-worker-recovery',
      now: 31,
    })).toMatchObject({ applied: true });
    expect(current.engine.workerProviderCalls.get(command.logicalCallId)).toMatchObject({
      interruptionKind: 'cancellation',
      cancellationRequestedAt: 31,
      reconciliationState: 'pending',
    });
    const events = current.engine.listEvents(current.child.jobId);
    const intent = events.findIndex((event) => event.type === 'worker.provider_cancellation_requested');
    const cancelled = events.findIndex((event) => event.type === 'attempt.cancelled');
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(cancelled).toBeGreaterThan(intent);
  });

  it('keeps unknown provider spend reserved and does not enqueue a replacement on restart', () => {
    const { current, command, records } = prepare('attempting');
    current.engine.resources.configure({
      jobId: current.parent.jobId,
      budgets: { model_calls: 2, input_tokens: 100, output_tokens: 100 },
    });
    current.engine.resources.configure({
      jobId: current.child.jobId,
      budgets: { model_calls: 1, input_tokens: 50, output_tokens: 50 },
    });
    const reservation = current.engine.resources.reserveWorker({
      reservationId: 'worker_recovery_reservation',
      idempotencyKey: 'worker-recovery-reservation',
      ...current.parentAuthority,
      childJobId: current.child.jobId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId,
      amounts: { model_calls: 1, input_tokens: 50, output_tokens: 50 },
      now: 31,
    });
    const result = sweepDurableJobRecovery({
      jobEngine: current.engine,
      triggerBus: createTriggerBus({ db: current.db }),
      instanceId: 'worker-instance',
      producer: 'test',
      now: 41,
    });
    expect(result).toMatchObject({ expired: 1, retried: 0, needsUser: 1, enqueued: 0 });
    expect(current.engine.resources.getWorkerReservation(reservation.reservationId)).toMatchObject({
      state: 'reserved', reconciliationState: 'blocked_unknown', unknownSpendPending: true,
    });
    expect(current.engine.workerProviderCalls.get(command.logicalCallId)).toMatchObject({
      outcomeKnowledge: 'outcome_unknown', retrySafety: 'blocked_unknown',
    });
    expect(current.engine.getJob(current.child.jobId)).toMatchObject({ status: 'blocked', activeAttemptId: null });
  });

  it('reopens v39 state and repeats reconciliation without duplicate events or replacement attempts', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-worker-recovery-'));
    tempDirs.push(root);
    const first = fixture = createWorkerFixture(join(root, 'jobs.db'));
    const records = bindRun(first);
    const command = {
      ...first.childAuthority,
      logicalCallId: 'logical_reopen_unknown',
      idempotencyKey: 'logical-reopen-unknown',
      workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId,
      providerBindingId: records.providerBinding.providerBindingId,
      callOrdinal: 1,
      requestHash: 'c'.repeat(64),
      toolSchemaHash: 'd'.repeat(64),
      now: 30,
    };
    first.engine.workerProviderCalls.prepare(command);
    first.engine.workerProviderCalls.markAttempting(command);
    first.db.prepare('UPDATE runs SET lease_expires_at=40 WHERE attempt_id=?').run(first.child.attemptId);
    first.db.close();

    const reopenedDb = new Database(join(root, 'jobs.db'));
    reopenedDb.pragma('foreign_keys = ON');
    fixture = { ...first, db: reopenedDb, engine: createJobEngine({ db: reopenedDb }) };
    const [decision] = fixture.engine.recoverExpiredAttempts({
      now: 41, instanceId: 'worker-instance', producer: 'test', maxCrashes: 3,
    });
    expect(decision).toMatchObject({ decision: 'ask_user' });
    expect(fixture.engine.recoverExpiredAttempts({
      now: 42, instanceId: 'worker-instance', producer: 'test', maxCrashes: 3,
    })).toEqual([]);
    expect(fixture.engine.listAttempts(first.child.jobId)).toHaveLength(1);
    expect(reopenedDb.prepare(
      'SELECT COUNT(*) AS n FROM worker_provider_call_reconciliations WHERE logical_call_id=?',
    ).get(command.logicalCallId)).toEqual({ n: 1 });
    expect(fixture.engine.listEvents(first.child.jobId)
      .filter((event) => event.type === 'worker.provider_reconciliation_completed')).toHaveLength(1);
  });
});
