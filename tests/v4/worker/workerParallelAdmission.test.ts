/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createTriggerBus, type TriggerBus } from '../../../core/v4/daemon/triggerBus';
import {
  admitReadOnlyRepositoryWorkerGroup,
  DEFAULT_READ_ONLY_WORKER_GROUP_SIZE,
  MAX_READ_ONLY_WORKER_GROUP_SIZE,
  normalizeReadOnlyWorkerGroupSize,
} from '../../../core/v4/worker/workerParallel';

const provider = {
  providerId: 'custom_openai', modelId: 'custom-default',
  providerRuntimeIdentity: 'runtime:custom_openai', credentialReference: null,
  endpointReference: 'endpoint:configured', supportsToolCalling: true,
  contextWindow: 32_768, maxOutputTokens: 4_096, selectionReason: 'configured provider',
} as const;

describe('bounded parallel read-only Worker admission', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let triggerBus: TriggerBus;
  let root: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('worker-instance',1,'localhost',1,1,'4.18.0')`,
    ).run();
    engine = createJobEngine({ db });
    triggerBus = createTriggerBus({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-parallel-worker-'));
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function setupParent(key = 'parent') {
    const parent = engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'parallel-worker', workspaceId: root,
      instanceId: 'worker-instance', idempotencyNamespace: 'parallel-worker',
      idempotencyKey: key, goal: 'Coordinate repository inspection.',
    });
    const lease = engine.claimAttempt({ attemptId: parent.attemptId, ownerId: 'worker-instance', ttlMs: 60_000 });
    const snapshot = await engine.repository.captureSnapshot({
      jobId: parent.jobId, attemptId: parent.attemptId, generation: lease.generation!,
      fenceToken: lease.fenceToken!, requestedPath: root, producer: 'test',
    });
    return {
      parent,
      authority: {
        jobId: parent.jobId, attemptId: parent.attemptId,
        generation: lease.generation!, fenceToken: lease.fenceToken!,
      },
      snapshot,
    };
  }

  it('defaults to two members and never admits more than four', () => {
    expect(DEFAULT_READ_ONLY_WORKER_GROUP_SIZE).toBe(2);
    expect(MAX_READ_ONLY_WORKER_GROUP_SIZE).toBe(4);
    expect(normalizeReadOnlyWorkerGroupSize(undefined)).toBe(2);
    expect(normalizeReadOnlyWorkerGroupSize(4)).toBe(4);
    expect(() => normalizeReadOnlyWorkerGroupSize(5)).toThrow(/maximum.*4/i);
  });

  it('rejects nested or mutating Worker requests', () => {
    expect(() => normalizeReadOnlyWorkerGroupSize(2, { depth: 1 })).toThrow(/nested/i);
    expect(() => normalizeReadOnlyWorkerGroupSize(2, { mutation: true })).toThrow(/mutation/i);
  });

  it('atomically projects and dispatches two immutable read-only members', async () => {
    const setup = await setupParent();
    const admitted = admitReadOnlyRepositoryWorkerGroup({
      engine, triggerBus, parent: setup.authority, idempotencyKey: 'group-two',
      policy: 'require_all', repositorySnapshotId: setup.snapshot.id,
      members: [
        { goal: 'Inspect source exports.', provider },
        { goal: 'Inspect source constants.', provider },
      ],
      providerConcurrencyLimit: 2,
    });
    expect(admitted.failures).toEqual([]);
    expect(admitted.admissions).toHaveLength(2);
    expect(admitted.group).toMatchObject({ state: 'active', requestedMemberCount: 2, admittedMemberCount: 2 });
    expect(engine.worker.listWorkerGroupMembers(admitted.group.groupId).map((member) => member.ordinal)).toEqual([1, 2]);
    expect(engine.worker.listWorkerAssignmentsForParent(setup.parent.jobId)).toHaveLength(2);
    expect(engine.resources.listWorkerProviderConcurrencyForGroup(admitted.group.groupId)).toHaveLength(2);
    expect(triggerBus.stats().pending).toBe(2);
    for (const item of admitted.admissions) {
      expect(engine.resources.authorize({
        jobId: item.admission.child.jobId, kind: 'tool', value: 'shell_exec',
      })).toBe(false);
    }
  });

  it('admits four only with explicit parent and provider capacity and rejects a fifth', async () => {
    const setup = await setupParent();
    const admitted = admitReadOnlyRepositoryWorkerGroup({
      engine, triggerBus, parent: setup.authority, idempotencyKey: 'group-four',
      policy: 'allow_partial', repositorySnapshotId: setup.snapshot.id,
      memberTemplate: { goal: 'Inspect the pinned snapshot.', provider }, memberCount: 4,
      parentConcurrencyLimit: 4, providerConcurrencyLimit: 4,
    });
    expect(admitted.admissions).toHaveLength(4);
    expect(admitted.failures).toEqual([]);
    expect(() => admitReadOnlyRepositoryWorkerGroup({
      engine, triggerBus, parent: setup.authority, idempotencyKey: 'group-five',
      policy: 'require_all', repositorySnapshotId: setup.snapshot.id,
      memberTemplate: { goal: 'Inspect.', provider }, memberCount: 5,
      parentConcurrencyLimit: 4, providerConcurrencyLimit: 5,
    })).toThrow(/maximum.*4/i);
  });

  it('enforces provider capacity durably and represents rejected admission', async () => {
    const setup = await setupParent();
    const admitted = admitReadOnlyRepositoryWorkerGroup({
      engine, triggerBus, parent: setup.authority, idempotencyKey: 'provider-limited',
      policy: 'allow_partial', repositorySnapshotId: setup.snapshot.id,
      memberTemplate: { goal: 'Inspect.', provider }, memberCount: 2,
      providerConcurrencyLimit: 1,
    });
    expect(admitted.admissions).toHaveLength(1);
    expect(admitted.failures).toHaveLength(1);
    expect(engine.worker.listWorkerGroupMembers(admitted.group.groupId).map((member) => member.outcome))
      .toEqual(['admitted', 'rejected']);
    expect(engine.resources.listWorkerProviderConcurrencyForGroup(admitted.group.groupId)).toHaveLength(1);
  });

  it('deduplicates the same group, members, child Jobs, reservations and dispatches', async () => {
    const setup = await setupParent();
    const input = {
      engine, triggerBus, parent: setup.authority, idempotencyKey: 'duplicate-group',
      policy: 'require_all' as const, repositorySnapshotId: setup.snapshot.id,
      memberTemplate: { goal: 'Inspect.', provider }, memberCount: 2,
      providerConcurrencyLimit: 2,
    };
    const first = admitReadOnlyRepositoryWorkerGroup(input);
    const duplicate = admitReadOnlyRepositoryWorkerGroup(input);
    expect(duplicate.group.groupId).toBe(first.group.groupId);
    expect(duplicate.admissions.map((item) => item.admission.child.jobId))
      .toEqual(first.admissions.map((item) => item.admission.child.jobId));
    expect(duplicate.admissions.every((item) => item.admission.triggerEvent.inserted === false)).toBe(true);
    expect(engine.worker.listWorkerAssignmentsForParent(setup.parent.jobId)).toHaveLength(2);
    expect(engine.resources.listWorkerReservations(setup.parent.jobId)).toHaveLength(2);
  });
});
