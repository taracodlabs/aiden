/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { projectReadOnlyRepositoryWorkerGroups } from '../../../core/v4/worker/workerParallel';
import {
  admitParallelWorkers,
  createParallelWorkerFixture,
  type ParallelWorkerFixture,
} from './workerParallelFixture';

describe('parallel read-only Worker restart projection', () => {
  let fixture: ParallelWorkerFixture | undefined;
  let databaseRoot: string | undefined;
  afterEach(async () => {
    await fixture?.close();
    if (databaseRoot) await rm(databaseRoot, { recursive: true, force: true });
  });

  it('reopens nonterminal groups with stable member order and exact reservations', async () => {
    databaseRoot = await mkdtemp(path.join(os.tmpdir(), 'aiden-parallel-reopen-'));
    const databasePath = path.join(databaseRoot, 'jobs.db');
    fixture = await createParallelWorkerFixture(databasePath);
    const admitted = admitParallelWorkers(fixture);
    fixture.db.close();

    const reopened = new Database(databasePath);
    reopened.pragma('foreign_keys = ON');
    expect(runMigrations(reopened)).toEqual({ from: 40, to: 40 });
    const engine = createJobEngine({ db: reopened });
    expect(engine.worker.getWorkerGroup(admitted.group.groupId)).toMatchObject({
      state: 'active', requestedMemberCount: 2, admittedMemberCount: 2,
    });
    expect(engine.worker.listWorkerGroupMembers(admitted.group.groupId).map((member) => member.ordinal))
      .toEqual([1, 2]);
    expect(engine.resources.listWorkerProviderConcurrencyForGroup(admitted.group.groupId)
      .map((slot) => slot.state)).toEqual(['reserved', 'reserved']);
    expect(projectReadOnlyRepositoryWorkerGroups({ engine })).toEqual({ inspected: 1, pendingVerification: [] });
    for (const item of admitted.admissions) {
      expect(engine.cancelJob({
        jobId: item.admission.child.jobId,
        reason: 'restart_reconciliation_fixture',
        producer: 'test',
        eventIdempotencyKey: `cancel-${item.memberId}`,
      })).toMatchObject({ applied: true });
    }
    expect(projectReadOnlyRepositoryWorkerGroups({ engine })).toEqual({ inspected: 1, pendingVerification: [] });
    expect(engine.worker.getWorkerGroup(admitted.group.groupId)).toMatchObject({
      state: 'settled', cancelledMemberCount: 2, settledMemberCount: 2,
    });
    expect(engine.resources.listWorkerProviderConcurrencyForGroup(admitted.group.groupId)
      .map((slot) => slot.state)).toEqual(['released', 'released']);
    expect(projectReadOnlyRepositoryWorkerGroups({ engine })).toEqual({ inspected: 0, pendingVerification: [] });
    reopened.close();
  });
});
