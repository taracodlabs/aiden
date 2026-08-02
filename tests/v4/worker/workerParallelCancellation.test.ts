/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createJobControlAuthority } from '../../../core/v4/daemon/jobControlAuthority';
import { fanOutReadOnlyRepositoryWorkerGroup } from '../../../core/v4/worker/workerParallel';
import {
  admitParallelWorkers,
  createParallelWorkerFixture,
  type ParallelWorkerFixture,
} from './workerParallelFixture';

describe('parallel read-only Worker interruption', () => {
  let fixture: ParallelWorkerFixture | undefined;
  afterEach(async () => fixture?.close());

  it('persists parent and group cancellation intent before cancelling every child exactly once', async () => {
    fixture = await createParallelWorkerFixture();
    const admitted = admitParallelWorkers(fixture);
    const controls = createJobControlAuthority({ db: fixture.db, jobEngine: fixture.engine });
    const command = {
      jobId: fixture.parent.jobId,
      attemptId: fixture.parent.attemptId,
      generation: fixture.authority.generation,
      kind: 'cancel' as const,
      source: 'test',
      reason: 'operator_cancelled',
      idempotencyNamespace: 'parallel-control',
      idempotencyKey: 'cancel-parent-group',
    };
    expect(controls.commands.request(command)).toMatchObject({ persisted: true, applied: true, duplicate: false });
    expect(controls.commands.request(command)).toMatchObject({ persisted: true, duplicate: true });
    expect(fixture.engine.worker.getWorkerGroup(admitted.group.groupId)).toMatchObject({
      state: 'settled', cancellationRequestedAt: expect.any(Number), cancelledMemberCount: 2,
    });
    expect(admitted.admissions.map((item) => fixture!.engine.getJob(item.admission.child.jobId)?.status))
      .toEqual(['cancelled', 'cancelled']);
    const eventTypes = fixture.engine.listEvents(fixture.parent.jobId).map((event) => event.type);
    expect(eventTypes.indexOf('control.persisted')).toBeLessThan(eventTypes.indexOf('worker.group_interruption_requested'));
    expect(eventTypes.indexOf('worker.group_interruption_requested')).toBeLessThan(eventTypes.indexOf('attempt.cancelled'));
    expect(eventTypes.filter((type) => type === 'worker.group_interruption_requested')).toHaveLength(1);
  });

  it('persists timeout intent before physical interruption and fans out idempotently', async () => {
    fixture = await createParallelWorkerFixture();
    const admitted = admitParallelWorkers(fixture);
    for (const item of admitted.admissions) {
      fixture.engine.claimAttempt({
        attemptId: item.admission.child.attemptId,
        ownerId: 'worker-instance',
        ttlMs: 60_000,
      });
    }
    const interrupted: string[] = [];
    const first = fanOutReadOnlyRepositoryWorkerGroup({
      engine: fixture.engine,
      groupId: admitted.group.groupId,
      kind: 'timeout',
      reason: 'worker_group_deadline',
      producer: 'test',
      interruptAttempt(attemptId) { interrupted.push(attemptId); },
    });
    const duplicate = fanOutReadOnlyRepositoryWorkerGroup({
      engine: fixture.engine,
      groupId: admitted.group.groupId,
      kind: 'timeout',
      reason: 'worker_group_deadline',
      producer: 'test',
      interruptAttempt(attemptId) { interrupted.push(attemptId); },
    });
    expect(first.interrupted).toBe(2);
    expect(duplicate.interrupted).toBe(0);
    expect(interrupted).toHaveLength(2);
    expect(fixture.engine.worker.getWorkerGroup(admitted.group.groupId)).toMatchObject({
      state: 'settled', timeoutRequestedAt: expect.any(Number), failedMemberCount: 2,
    });
    expect(admitted.admissions.map((item) => fixture!.engine.getJob(item.admission.child.jobId)?.status))
      .toEqual(['cancelled', 'cancelled']);
  });
});
