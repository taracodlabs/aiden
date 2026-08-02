/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createTriggerBus, type TriggerBus } from '../../../core/v4/daemon/triggerBus';
import { admitReadOnlyRepositoryWorkerGroup } from '../../../core/v4/worker/workerParallel';

export const parallelWorkerProvider = {
  providerId: 'custom_openai', modelId: 'custom-default',
  providerRuntimeIdentity: 'runtime:custom_openai', credentialReference: null,
  endpointReference: 'endpoint:configured', supportsToolCalling: true,
  contextWindow: 32_768, maxOutputTokens: 4_096, selectionReason: 'configured provider',
} as const;

export interface ParallelWorkerFixture {
  db: Database.Database;
  engine: JobEngine;
  triggerBus: TriggerBus;
  root: string;
  parent: ReturnType<JobEngine['submitJob']>;
  authority: { jobId: string; attemptId: string; generation: number; fenceToken: string };
  snapshotId: string;
  close(): Promise<void>;
}

export async function createParallelWorkerFixture(databasePath = ':memory:'): Promise<ParallelWorkerFixture> {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT OR IGNORE INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
     VALUES ('worker-instance',1,'localhost',1,1,'4.18.0')`,
  ).run();
  const engine = createJobEngine({ db });
  const triggerBus = createTriggerBus({ db });
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-parallel-worker-'));
  await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
  const parent = engine.submitJob({
    entryPoint: 'test', source: 'test', sessionId: 'parallel-worker', workspaceId: root,
    instanceId: 'worker-instance', idempotencyNamespace: 'parallel-worker',
    idempotencyKey: 'parent', goal: 'Coordinate repository inspection.',
  });
  const lease = engine.claimAttempt({
    attemptId: parent.attemptId, ownerId: 'worker-instance', ttlMs: 60_000,
  });
  const snapshot = await engine.repository.captureSnapshot({
    jobId: parent.jobId, attemptId: parent.attemptId, generation: lease.generation!,
    fenceToken: lease.fenceToken!, requestedPath: root, producer: 'test',
  });
  return {
    db, engine, triggerBus, root, parent,
    authority: {
      jobId: parent.jobId, attemptId: parent.attemptId,
      generation: lease.generation!, fenceToken: lease.fenceToken!,
    },
    snapshotId: snapshot.id,
    async close() {
      if (db.open) db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function admitParallelWorkers(fixture: ParallelWorkerFixture, input: {
  idempotencyKey?: string;
  count?: number;
  policy?: 'require_all' | 'allow_partial';
  providerConcurrencyLimit?: number;
} = {}) {
  return admitReadOnlyRepositoryWorkerGroup({
    engine: fixture.engine,
    triggerBus: fixture.triggerBus,
    parent: fixture.authority,
    idempotencyKey: input.idempotencyKey ?? 'parallel-group',
    policy: input.policy ?? 'require_all',
    repositorySnapshotId: fixture.snapshotId,
    memberTemplate: { goal: 'Inspect the pinned repository snapshot.', provider: parallelWorkerProvider },
    memberCount: input.count ?? 2,
    parentConcurrencyLimit: input.count ?? 2,
    providerConcurrencyLimit: input.providerConcurrencyLimit ?? input.count ?? 2,
  });
}
