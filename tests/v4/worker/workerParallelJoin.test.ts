/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWorkerGroupAggregate,
  joinReadOnlyRepositoryWorkerGroup,
} from '../../../core/v4/worker/workerParallel';
import { resultPayload } from './fixture';
import {
  admitParallelWorkers,
  createParallelWorkerFixture,
  type ParallelWorkerFixture,
} from './workerParallelFixture';

describe('parallel read-only Worker deterministic join', () => {
  let fixture: ParallelWorkerFixture | undefined;
  afterEach(async () => fixture?.close());
  const member = (
    ordinal: number,
    memberId: string,
    outcome: 'verified' | 'failed' | 'unknown',
  ) => ({ ordinal, memberId, assignmentId: `assignment_${memberId}`, childJobId: `job_${memberId}`, outcome });

  it('orders by immutable ordinal rather than completion order', () => {
    const aggregate = buildWorkerGroupAggregate('group_one', 'allow_partial', [
      member(2, 'second', 'verified'),
      member(1, 'first', 'verified'),
    ]);
    expect(aggregate.members.map((item) => item.memberId)).toEqual(['first', 'second']);
    expect(aggregate.outcome).toBe('verified');
  });

  it('keeps failed and unknown members visible under allow_partial', () => {
    const aggregate = buildWorkerGroupAggregate('group_partial', 'allow_partial', [
      member(3, 'unknown', 'unknown'),
      member(1, 'verified', 'verified'),
      member(2, 'failed', 'failed'),
    ]);
    expect(aggregate.outcome).toBe('partial');
    expect(aggregate.counts).toMatchObject({ verified: 1, failed: 1, unknown: 1 });
    expect(aggregate.members).toHaveLength(3);
  });

  it('requires every member to verify under require_all', () => {
    expect(buildWorkerGroupAggregate('group_required', 'require_all', [
      member(1, 'verified', 'verified'),
      member(2, 'failed', 'failed'),
    ])).toMatchObject({ outcome: 'failed' });
  });

  it('independently verifies accepted results and joins by ordinal, not completion order', async () => {
    fixture = await createParallelWorkerFixture();
    const admitted = admitParallelWorkers(fixture);
    const recorded: Array<{ memberId: string; resultId: string; resultHash: string }> = [];
    for (const item of [...admitted.admissions].reverse()) {
      const lease = fixture.engine.claimAttempt({
        attemptId: item.admission.child.attemptId,
        ownerId: 'worker-instance',
        ttlMs: 60_000,
      });
      const run = fixture.engine.worker.bindWorkerRunFromAssignment({
        childJobId: item.admission.child.jobId,
        childAttemptId: item.admission.child.attemptId,
        childGeneration: lease.generation!,
        childFenceToken: lease.fenceToken!,
        workerRunId: item.admission.reservation.workerRunId,
        schemaVersion: 1,
        assignmentId: item.admission.assignment.assignmentId,
        providerBindingId: item.admission.providerBinding.providerBindingId,
        contextEnvelopeId: item.admission.contextEnvelope.contextEnvelopeId,
        producer: 'test',
        idempotencyKey: `run-${item.memberId}`,
      });
      const payload = resultPayload(item.admission.assignment.inputHash);
      const result = fixture.engine.worker.recordWorkerResultFromRun({
        childJobId: item.admission.child.jobId,
        childAttemptId: item.admission.child.attemptId,
        childGeneration: lease.generation!,
        childFenceToken: lease.fenceToken!,
        workerResultId: `result_${item.memberId}`,
        workerRunId: run.workerRunId,
        assignmentId: item.admission.assignment.assignmentId,
        payload,
        producer: 'test',
        idempotencyKey: `result-${item.memberId}`,
      });
      recorded.push({ memberId: item.memberId, resultId: result.workerResultId, resultHash: result.resultHash });
    }
    expect(() => fixture!.engine.worker.settleWorkerGroupMember({
      parentJobId: fixture!.authority.jobId,
      parentAttemptId: fixture!.authority.attemptId,
      parentGeneration: fixture!.authority.generation,
      parentFenceToken: fixture!.authority.fenceToken,
      producer: 'test',
      idempotencyKey: 'unverified-parent-consumption',
      groupId: admitted.group.groupId,
      memberId: recorded[0]!.memberId,
      outcome: 'verified',
      workerResultId: recorded[0]!.resultId,
      resultHash: recorded[0]!.resultHash,
      reason: 'not_independently_verified',
    })).toThrow(/independently verified/i);
    const aggregate = await joinReadOnlyRepositoryWorkerGroup({
      engine: fixture.engine,
      groupId: admitted.group.groupId,
      producer: 'test',
    });
    expect(aggregate).toMatchObject({ outcome: 'verified', counts: { total: 2, verified: 2 } });
    expect(aggregate.members.map((member) => member.ordinal)).toEqual([1, 2]);
    expect(fixture.engine.worker.getWorkerGroup(admitted.group.groupId)).toMatchObject({
      state: 'settled', successfulMemberCount: 2, settledMemberCount: 2,
    });
    expect(fixture.engine.resources.listWorkerProviderConcurrencyForGroup(admitted.group.groupId)
      .map((slot) => slot.state)).toEqual(['released', 'released']);
    expect(await joinReadOnlyRepositoryWorkerGroup({
      engine: fixture.engine,
      groupId: admitted.group.groupId,
      producer: 'test',
    })).toEqual(aggregate);
  });
});
