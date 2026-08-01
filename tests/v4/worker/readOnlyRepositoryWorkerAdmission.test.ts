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
  READ_ONLY_REPOSITORY_WORKER,
  READ_ONLY_REPOSITORY_WORKER_TOOLS,
  admitReadOnlyRepositoryWorker,
} from '../../../core/v4/worker/readOnlyRepositoryWorker';

describe('durable read-only repository Worker admission', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let triggerBus: TriggerBus;
  let root: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES (?,?,?,?,?,?)`,
    ).run('worker-instance', 1, 'localhost', Date.now(), Date.now(), '4.18.0');
    engine = createJobEngine({ db });
    triggerBus = createTriggerBus({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-read-worker-'));
    await writeFile(path.join(root, 'AGENTS.md'), 'Inspect only the pinned repository snapshot.\n');
    await writeFile(path.join(root, 'source.ts'), 'export const marker = "durable-worker";\n');
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function parentAuthority() {
    const parent = engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'worker-session', workspaceId: root,
      instanceId: 'worker-instance', idempotencyNamespace: 'worker-parent',
      idempotencyKey: 'parent', goal: 'Confirm the repository marker.',
    });
    const lease = engine.claimAttempt({
      attemptId: parent.attemptId, ownerId: 'worker-instance', ttlMs: 60_000,
    });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('parent lease');
    engine.graph.create({
      jobId: parent.jobId,
      planDigest: 'worker-plan',
      nodes: [{ nodeId: 'inspect-source', kind: 'inspection', requiresVerification: true }],
      producer: 'test', idempotencyKey: 'worker-plan',
    });
    const snapshot = await engine.repository.captureSnapshot({
      jobId: parent.jobId, attemptId: parent.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, requestedPath: root, producer: 'test',
    });
    const claim = engine.proof.createClaim({
      jobId: parent.jobId, attemptId: parent.attemptId, generation: lease.generation,
      category: 'observed', statement: 'source.ts contains the durable Worker marker.',
      required: true, repositorySnapshotId: snapshot.id,
      sourceReferences: [{ snapshotId: snapshot.id, path: 'source.ts', lineStart: 1, lineEnd: 1 }],
      requiredEvidenceCategories: ['repository_readback'],
    });
    return { parent, lease, snapshot, claim };
  }

  it('creates one immutable assignment, one child Job, and one durable dispatch', async () => {
    const { parent, lease, snapshot, claim } = await parentAuthority();
    const admitted = admitReadOnlyRepositoryWorker({
      engine, triggerBus,
      parent: {
        jobId: parent.jobId, attemptId: parent.attemptId,
        generation: lease.generation!, fenceToken: lease.fenceToken!,
      },
      idempotencyKey: 'inspect-marker',
      goal: 'Inspect source.ts and report the exact marker with a source reference.',
      repositorySnapshotId: snapshot.id,
      planStepIds: ['inspect-source'],
      claimIds: [claim.claimId],
      boundedParentNote: 'Return only repository-grounded findings.',
      provider: {
        providerId: 'custom_openai', modelId: 'custom-default',
        providerRuntimeIdentity: 'runtime:custom_openai',
        credentialReference: 'credential:custom_openai', endpointReference: 'endpoint:configured',
        supportsToolCalling: true, contextWindow: 32_768, maxOutputTokens: 4_096,
        selectionReason: 'configured provider',
      },
    });

    expect(admitted.assignment.workerDefinitionId).toBe(READ_ONLY_REPOSITORY_WORKER.workerDefinitionId);
    expect(admitted.assignment.repositorySnapshotId).toBe(snapshot.id);
    expect(admitted.child.reused).toBe(false);
    expect(engine.getJob(admitted.child.jobId)?.parentJobId).toBe(parent.jobId);
    expect(engine.getChildContract(admitted.child.jobId)).toMatchObject({
      workerId: READ_ONLY_REPOSITORY_WORKER.workerDefinitionId,
      capabilities: [...READ_ONLY_REPOSITORY_WORKER_TOOLS],
    });
    expect(READ_ONLY_REPOSITORY_WORKER_TOOLS.every((tool) => (
      engine.resources.authorize({ jobId: admitted.child.jobId, kind: 'tool', value: tool })
    ))).toBe(true);
    expect(engine.resources.authorize({
      jobId: admitted.child.jobId, kind: 'tool', value: 'shell_exec',
    })).toBe(false);
    expect(triggerBus.get(admitted.triggerEvent.id)?.payload).toMatchObject({
      worker_assignment_id: admitted.assignment.assignmentId,
      durable_job: {
        job_id: admitted.child.jobId,
        attempt_id: admitted.child.attemptId,
        run_id: admitted.child.runId,
      },
    });
    const persistedContext = engine.worker.getWorkerContextEnvelope(admitted.contextEnvelope.contextEnvelopeId)!;
    expect(persistedContext).toMatchObject({
      assignmentId: admitted.assignment.assignmentId,
      repositorySnapshotId: snapshot.id,
      planStepIds: ['inspect-source'],
      claimIds: [claim.claimId],
      boundedParentNote: 'Return only repository-grounded findings.',
    });
    const isolated = JSON.stringify(persistedContext);
    for (const forbidden of [
      'conversationHistory', 'messages', 'memory', 'environment', 'apiKey',
      lease.fenceToken!, 'credential:custom_openai',
    ]) expect(isolated).not.toContain(forbidden);
    const publicEvents = JSON.stringify(engine.listEvents(parent.jobId));
    expect(publicEvents).not.toContain(lease.fenceToken!);
    expect(publicEvents).not.toContain('credential:custom_openai');
    expect(engine.resources.getBudgets(admitted.child.jobId).map((item) => item.kind)).toEqual(expect.arrayContaining([
      'effects', 'input_tokens', 'model_calls', 'output_bytes', 'output_tokens', 'runtime_ms', 'tool_calls', 'workers',
    ]));
  });

  it('deduplicates the same request and refuses a second concurrent Worker', async () => {
    const { parent, lease, snapshot, claim } = await parentAuthority();
    const input = {
      engine, triggerBus,
      parent: {
        jobId: parent.jobId, attemptId: parent.attemptId,
        generation: lease.generation!, fenceToken: lease.fenceToken!,
      },
      idempotencyKey: 'inspect-marker', goal: 'Inspect source.ts.',
      repositorySnapshotId: snapshot.id, planStepIds: ['inspect-source'], claimIds: [claim.claimId],
      provider: {
        providerId: 'custom_openai', modelId: 'custom-default',
        providerRuntimeIdentity: 'runtime:custom_openai', credentialReference: null,
        endpointReference: 'endpoint:configured', supportsToolCalling: true,
        contextWindow: 32_768, maxOutputTokens: 4_096, selectionReason: 'configured provider',
      },
    } as const;
    const first = admitReadOnlyRepositoryWorker(input);
    const duplicate = admitReadOnlyRepositoryWorker(input);
    expect(duplicate.assignment.assignmentId).toBe(first.assignment.assignmentId);
    expect(duplicate.child.jobId).toBe(first.child.jobId);
    expect(duplicate.triggerEvent).toMatchObject({ id: first.triggerEvent.id, inserted: false });

    expect(() => admitReadOnlyRepositoryWorker({
      ...input, idempotencyKey: 'second-worker', goal: 'Inspect AGENTS.md.',
    })).toThrow(/one active read-only repository Worker/i);
  });

  it.each([
    ['tool calls are unavailable', { supportsToolCalling: false }],
    ['the snapshot belongs to another Job', { repositorySnapshotId: 'missing_snapshot' }],
  ])('fails closed when %s', async (_label, override) => {
    const { parent, lease, snapshot } = await parentAuthority();
    expect(() => admitReadOnlyRepositoryWorker({
      engine, triggerBus,
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: lease.generation!, fenceToken: lease.fenceToken! },
      idempotencyKey: 'rejected', goal: 'Inspect.',
      repositorySnapshotId: override.repositorySnapshotId ?? snapshot.id,
      provider: {
        providerId: 'custom_openai', modelId: 'custom-default',
        providerRuntimeIdentity: 'runtime:custom_openai', credentialReference: null,
        endpointReference: null, supportsToolCalling: override.supportsToolCalling ?? true,
        contextWindow: 32_768, maxOutputTokens: 4_096, selectionReason: 'configured provider',
      },
    })).toThrow();
  });

  it.each([
    ['the parent generation is stale', { generationDelta: 1, fenceToken: null }],
    ['the parent fence is wrong', { generationDelta: 0, fenceToken: 'wrong-parent-fence' }],
  ])('rejects admission when %s', async (_label, override) => {
    const { parent, lease, snapshot } = await parentAuthority();
    expect(() => admitReadOnlyRepositoryWorker({
      engine, triggerBus,
      parent: {
        jobId: parent.jobId,
        attemptId: parent.attemptId,
        generation: lease.generation! + override.generationDelta,
        fenceToken: override.fenceToken ?? lease.fenceToken!,
      },
      idempotencyKey: 'stale-parent', goal: 'Inspect.', repositorySnapshotId: snapshot.id,
      provider: {
        providerId: 'fixture', modelId: 'fixture-model', providerRuntimeIdentity: 'runtime:fixture',
        credentialReference: null, endpointReference: null, supportsToolCalling: true,
        contextWindow: 8_192, maxOutputTokens: 1_024, selectionReason: 'test',
      },
    })).toThrow(/parent|authority|generation|fence/i);
  });

  it('blocks admission when the bounded context cannot fit the pinned provider window', async () => {
    const { parent, lease, snapshot } = await parentAuthority();
    expect(() => admitReadOnlyRepositoryWorker({
      engine, triggerBus,
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: lease.generation!, fenceToken: lease.fenceToken! },
      idempotencyKey: 'context-overflow', goal: 'Inspect.', repositorySnapshotId: snapshot.id,
      provider: {
        providerId: 'fixture', modelId: 'fixture-model', providerRuntimeIdentity: 'runtime:fixture',
        credentialReference: null, endpointReference: null, supportsToolCalling: true,
        contextWindow: 512, maxOutputTokens: 511, selectionReason: 'test',
      },
    })).toThrow(/context.*window/i);
  });
});
