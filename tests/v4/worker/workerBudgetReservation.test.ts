/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createAssignment, createWorkerFixture, type WorkerFixture } from './fixture';

describe('Worker JobResource reservations', () => {
  let fixture: WorkerFixture | undefined;
  afterEach(() => fixture?.db.close());

  function setup() {
    const current = fixture = createWorkerFixture();
    const records = createAssignment(current);
    current.engine.resources.configure({
      jobId: current.parent.jobId,
      budgets: { model_calls: 5, input_tokens: 100, external_cost: 10 },
    });
    current.engine.resources.configure({
      jobId: current.child.jobId,
      budgets: { model_calls: 3, input_tokens: 50, external_cost: 5 },
    });
    const command = {
      reservationId: 'worker_budget_one',
      idempotencyKey: 'worker-budget-one',
      ...current.parentAuthority,
      childJobId: current.child.jobId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      workerRunId: 'worker_run_reserved',
      assignmentId: records.assignment.assignmentId,
      amounts: { model_calls: 3, input_tokens: 50, external_cost: 5 },
      now: 30,
    };
    return { current, records, command };
  }

  it('atomically reserves finite parent capacity and replays an identical request', () => {
    const { current, command } = setup();
    const reservation = current.engine.resources.reserveWorker(command);
    expect(reservation).toMatchObject({
      reservationId: command.reservationId,
      parentJobId: current.parent.jobId,
      childJobId: current.child.jobId,
      childAttemptId: current.child.attemptId,
      state: 'reserved',
    });
    expect(current.engine.resources.available(current.parent.jobId, 'model_calls')).toBe(2);
    expect(current.engine.resources.reserveWorker(command)).toEqual(reservation);
    expect(() => current.engine.resources.reserveWorker({
      ...command, amounts: { ...command.amounts, model_calls: 4 },
    })).toThrow(/idempotency conflict/i);
  });

  it('rejects reservations beyond parent capacity and stale parent authority', () => {
    const { current, command } = setup();
    expect(() => current.engine.resources.reserveWorker({
      ...command, amounts: { model_calls: 6 },
    })).toThrow(/exceeds parent capacity/i);
    expect(() => current.engine.resources.reserveWorker({
      ...command, reservationId: 'worker_budget_stale', idempotencyKey: 'worker-budget-stale',
      parentFenceToken: 'stale-fence',
    })).toThrow(/stale worker/i);
    expect(current.engine.resources.listWorkerReservations(current.parent.jobId)).toEqual([]);
  });

  it('serializes competing child reservations so parent capacity cannot be oversubscribed', () => {
    const { current, command } = setup();
    const secondChild = current.engine.submitJob({
      entryPoint: 'worker', source: 'worker', sessionId: 'worker-session', instanceId: 'worker-instance',
      idempotencyNamespace: 'worker-child', idempotencyKey: 'child-two', goal: 'inspect another repository view',
      parentJobId: current.parent.jobId,
      childContract: {
        required: true, workerId: 'repository-reader', capabilities: ['repository_snapshot_read'],
        allowedResources: { repository: 'snapshot' }, budget: { modelCalls: 1 },
      },
    });
    const secondLease = current.engine.claimAttempt({
      attemptId: secondChild.attemptId, ownerId: 'child-owner-two', ttlMs: 60_000, now: 10,
    });
    const secondFixture: WorkerFixture = {
      ...current,
      child: secondChild,
      childAuthority: {
        childJobId: secondChild.jobId,
        childAttemptId: secondChild.attemptId,
        childGeneration: secondLease.generation!,
        childFenceToken: secondLease.fenceToken!,
      },
    };
    const second = createAssignment(secondFixture, 'two');
    current.engine.resources.reserveWorker(command);
    expect(() => current.engine.resources.reserveWorker({
      ...command,
      reservationId: 'worker_budget_two',
      idempotencyKey: 'worker-budget-two',
      childJobId: secondChild.jobId,
      childAttemptId: secondChild.attemptId,
      childGeneration: secondLease.generation!,
      workerRunId: 'worker_run_reserved_two',
      assignmentId: second.assignment.assignmentId,
      amounts: { model_calls: 3 },
    })).toThrow(/exceeds parent capacity/i);
    expect(current.engine.resources.available(current.parent.jobId, 'model_calls')).toBe(2);
  });

  it('commits child usage and parent roll-up exactly once, then releases only unused capacity', () => {
    const { current, command } = setup();
    const reservation = current.engine.resources.reserveWorker(command);
    const commit = {
      reservationId: reservation.reservationId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      childFenceToken: current.childAuthority.childFenceToken,
      kind: 'model_calls' as const,
      amount: 1,
      certainty: 'confirmed' as const,
      sourceKind: 'provider_attempt' as const,
      sourceId: 'physical_one',
      idempotencyKey: 'physical-one:model',
      now: 31,
    };
    expect(current.engine.resources.commitWorkerUsage(commit)).toMatchObject({ applied: true, remaining: 2 });
    expect(current.engine.resources.commitWorkerUsage(commit)).toMatchObject({ applied: false, duplicate: true, remaining: 2 });
    expect(current.engine.resources.getBudgets(current.child.jobId).find((item) => item.kind === 'model_calls')?.used).toBe(1);
    expect(current.engine.resources.getBudgets(current.parent.jobId).find((item) => item.kind === 'model_calls')?.used).toBe(1);
    expect(current.db.prepare(
      "SELECT COUNT(*) AS n FROM job_budget_debits WHERE kind='model_calls'",
    ).get()).toEqual({ n: 2 });

    const released = current.engine.resources.releaseWorker({
      reservationId: reservation.reservationId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      childFenceToken: current.childAuthority.childFenceToken,
      now: 32,
    });
    expect(released.state).toBe('released');
    expect(released.items.find((item) => item.kind === 'model_calls')).toMatchObject({
      committed: 1, released: 2,
    });
    expect(current.engine.resources.available(current.parent.jobId, 'model_calls')).toBe(4);
    expect(current.engine.resources.getBudgets(current.parent.jobId).find((item) => item.kind === 'model_calls')?.used).toBe(1);
    expect(current.engine.resources.releaseWorker({
      reservationId: reservation.reservationId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      childFenceToken: current.childAuthority.childFenceToken,
    })).toEqual(released);
  });

  it('preserves unknown usage and cost instead of treating either as zero', () => {
    const { current, command } = setup();
    const reservation = current.engine.resources.reserveWorker(command);
    expect(current.engine.resources.commitWorkerUsage({
      reservationId: reservation.reservationId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      childFenceToken: current.childAuthority.childFenceToken,
      kind: 'external_cost', amount: null, certainty: 'unknown',
      sourceKind: 'provider_attempt', sourceId: 'physical_unknown',
      idempotencyKey: 'physical-unknown:cost', now: 31,
    })).toMatchObject({ applied: true, exhausted: true, remaining: 0 });
    expect(current.engine.resources.getWorkerReservation(reservation.reservationId)?.items
      .find((item) => item.kind === 'external_cost')).toMatchObject({
      hasUnknownUsage: true, state: 'unknown', released: 0,
    });
    expect(current.engine.resources.getBudgets(current.child.jobId).find((item) => item.kind === 'external_cost'))
      .toMatchObject({ used: 0, hasUnknownUsage: true });
    expect(current.engine.resources.getBudgets(current.parent.jobId).find((item) => item.kind === 'external_cost'))
      .toMatchObject({ used: 0, hasUnknownUsage: true });
  });

  it('releases unused capacity after persist-first child cancellation', () => {
    const { current, command } = setup();
    const reservation = current.engine.resources.reserveWorker(command);
    expect(current.engine.cancelJob({
      jobId: current.child.jobId,
      reason: 'operator_cancelled',
      producer: 'test',
      eventIdempotencyKey: 'cancel-worker-child',
    })).toMatchObject({ applied: true });
    const released = current.engine.resources.releaseWorker({
      reservationId: reservation.reservationId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      childFenceToken: current.childAuthority.childFenceToken,
      cancelled: true,
    });
    expect(released.state).toBe('cancelled');
    expect(released.items.find((item) => item.kind === 'model_calls')).toMatchObject({
      committed: 0, released: 3, state: 'released',
    });
    expect(current.engine.resources.available(current.parent.jobId, 'model_calls')).toBe(5);
  });

  it('records accepted overage and prohibits further capacity without erasing usage', () => {
    const { current, command } = setup();
    const reservation = current.engine.resources.reserveWorker(command);
    expect(current.engine.resources.commitWorkerUsage({
      reservationId: reservation.reservationId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      childFenceToken: current.childAuthority.childFenceToken,
      kind: 'model_calls', amount: 4, certainty: 'confirmed',
      sourceKind: 'reconciliation', sourceId: 'accepted-overage',
      idempotencyKey: 'accepted-overage:model', now: 31,
    })).toMatchObject({ applied: true, exhausted: true, remaining: 0 });
    expect(current.engine.resources.getBudgets(current.child.jobId).find((item) => item.kind === 'model_calls')?.used).toBe(4);
    expect(current.engine.resources.getBudgets(current.parent.jobId).find((item) => item.kind === 'model_calls')?.used).toBe(4);
    expect(current.engine.resources.getWorkerReservation(reservation.reservationId)?.state).toBe('exhausted');
  });

  it('rejects usage roll-up after the parent Attempt loses active authority', () => {
    const { current, command } = setup();
    const reservation = current.engine.resources.reserveWorker(command);
    current.db.prepare('UPDATE tasks SET active_attempt_id=NULL WHERE id=?').run(current.parent.jobId);
    expect(() => current.engine.resources.commitWorkerUsage({
      reservationId: reservation.reservationId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      childFenceToken: current.childAuthority.childFenceToken,
      kind: 'model_calls', amount: 1, certainty: 'confirmed',
      sourceKind: 'provider_attempt', sourceId: 'stale-parent', idempotencyKey: 'stale-parent:model',
    })).toThrow(/parent worker budget authority is stale/i);
    expect(current.engine.resources.getBudgets(current.child.jobId).find((item) => item.kind === 'model_calls')?.used).toBe(0);
    expect(current.engine.resources.getBudgets(current.parent.jobId).find((item) => item.kind === 'model_calls')?.used).toBe(0);
  });
});
