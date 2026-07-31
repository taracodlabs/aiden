/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createDispatcher } from '../../../core/v4/daemon/dispatcher/dispatcher';
import { createRealAgentRunner, type AgentBuilder } from '../../../core/v4/daemon/dispatcher/realAgentRunner';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { resolveAidenPaths } from '../../../core/v4/paths';
import {
  admitReadOnlyRepositoryWorker,
  verifyReadOnlyRepositoryWorkerResult,
} from '../../../core/v4/worker/readOnlyRepositoryWorker';
import type { ProviderAdapter } from '../../../providers/v4/types';

describe('read-only repository Worker durable dispatcher path', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })));
  });

  it('delivers the child through TriggerBus and the canonical daemon lifecycle exactly once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-worker-e2e-'));
    const home = await mkdtemp(path.join(os.tmpdir(), 'aiden-worker-e2e-home-'));
    cleanup.push(root, home);
    const sourceBytes = 'export const value = "dispatcher-worker";\n';
    await writeFile(path.join(root, 'source.ts'), sourceBytes);
    const dbPath = path.join(home, 'worker-e2e.db');
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      'INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)',
    ).run('worker-instance', 1, 'localhost', Date.now(), Date.now(), '4.18.0');

    const engine = createJobEngine({ db });
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const parent = engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'parent-session', workspaceId: root,
      instanceId: 'worker-instance', idempotencyNamespace: 'parent', idempotencyKey: 'one', goal: 'verify value',
    });
    const parentLease = engine.claimAttempt({ attemptId: parent.attemptId, ownerId: 'worker-instance', ttlMs: 60_000 });
    if (!parentLease.acquired || !parentLease.fenceToken || parentLease.generation === undefined) throw new Error('parent lease');
    const snapshot = await engine.repository.captureSnapshot({
      jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation,
      fenceToken: parentLease.fenceToken, requestedPath: root, producer: 'test',
    });
    engine.graph.createCodingPlan({
      jobId: parent.jobId, planDigest: 'dispatcher-worker-plan', producer: 'test', idempotencyKey: 'worker-plan',
      steps: [{
        stepId: 'locate-auth-session', label: 'Locate session authentication',
        repositorySnapshotId: snapshot.id, requiresVerification: true,
      }],
    });
    const entry = engine.repository.getEntry(snapshot.id, 'source.ts')!;
    const claim = engine.proof.createClaim({
      jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation,
      category: 'observed', statement: 'source.ts contains dispatcher-worker.', required: true,
      repositorySnapshotId: snapshot.id,
      sourceReferences: [{ snapshotId: snapshot.id, path: 'source.ts', lineStart: 1, lineEnd: 1 }],
      requiredEvidenceCategories: ['repository_readback'],
    });
    const admission = admitReadOnlyRepositoryWorker({
      engine, triggerBus: bus,
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation, fenceToken: parentLease.fenceToken },
      idempotencyKey: 'dispatcher-worker', goal: 'Read source.ts and report the value.',
      repositorySnapshotId: snapshot.id, planStepIds: ['locate-auth-session'], claimIds: [claim.claimId],
      provider: {
        providerId: 'fixture', modelId: 'fixture-model', providerRuntimeIdentity: 'runtime:fixture',
        credentialReference: null, endpointReference: null, supportsToolCalling: true,
        contextWindow: 8_192, maxOutputTokens: 2_048, selectionReason: 'fixture',
      },
    });
    let calls = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            toolCalls: [{ id: 'read', name: 'repository_snapshot_read', arguments: { path: 'source.ts' } }],
            finishReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return {
          content: JSON.stringify({
            schemaVersion: 1, status: 'completed', summary: 'The value is dispatcher-worker.',
            findings: [{
              findingId: 'value', statement: 'source.ts contains dispatcher-worker.', uncertainty: 'low',
              sourceReferences: [{
                snapshotId: snapshot.id, snapshotEntryId: entry.canonicalIdentity,
                path: 'source.ts', startLine: 1, endLine: 1, contentHash: entry.contentHash,
              }],
            }],
            unresolvedQuestions: [], uncertainty: { level: 'low', reasons: [] },
          }),
          toolCalls: [], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    let normalBuilderCalls = 0;
    const builder = (async () => {
      normalBuilderCalls += 1;
      throw new Error('ordinary daemon builder must not run for Worker children');
    }) as AgentBuilder;
    builder.resolveReadOnlyWorkerProvider = async (binding) => {
      expect(binding.providerId).toBe('fixture');
      expect(binding.modelId).toBe('fixture-model');
      return { adapter, paths: resolveAidenPaths({ rootOverride: home }) };
    };
    const runner = createRealAgentRunner({
      db, runStore, jobEngine: engine, agentBuilder: builder,
      persistedDefault: { provider: 'different-provider', model: 'different-model' },
      dailyBudget: null,
    });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db, jobEngine: engine,
      ownerId: 'worker-instance', instanceId: 'worker-instance', workerCount: 1,
      runnerFactory: () => runner, initialRunnerKind: 'real',
    });

    expect(await dispatcher._pumpOnce()).toBe(admission.triggerEvent.id);
    expect(bus.get(admission.triggerEvent.id)).toMatchObject({ status: 'done', runId: admission.child.runId });
    expect(engine.getJob(admission.child.jobId)).toMatchObject({ status: 'completed', terminalOutcome: 'worker_completed' });
    expect(engine.worker.listWorkerRunsForChild(admission.child.jobId)).toHaveLength(1);
    const [resultId] = engine.worker.rebuildWorkerProjection(parent.jobId).acceptedResultIds;
    expect(resultId).toBeTruthy();
    expect(normalBuilderCalls).toBe(0);
    expect(calls).toBe(2);
    expect(await dispatcher._pumpOnce()).toBeNull();
    expect(engine.worker.listWorkerRunsForChild(admission.child.jobId)).toHaveLength(1);

    const verification = await verifyReadOnlyRepositoryWorkerResult({
      engine,
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation, fenceToken: parentLease.fenceToken },
      workerResultId: resultId!, idempotencyKey: 'parent-readback', producer: 'test',
    });
    expect(verification.claims[0]).toMatchObject({ claimId: claim.claimId, state: 'verified' });
    expect(engine.graph.getCodingPlan(parent.jobId)?.steps[0].references).toContainEqual(expect.objectContaining({
      kind: 'evidence', id: verification.evidence[0].evidenceId,
    }));
    expect(engine.proof.getVerdict(parent.jobId)).toBeNull();
    const childEvidenceId = engine.proof.listEvidence(admission.child.jobId)[0].evidenceId;
    const parentEvidenceId = verification.evidence[0].evidenceId;
    expect(childEvidenceId).not.toBe(parentEvidenceId);
    expect(await readFile(path.join(root, 'source.ts'), 'utf8')).toBe(sourceBytes);
    db.close();

    const reopenedDb = new Database(dbPath);
    reopenedDb.pragma('foreign_keys = ON');
    const reopened = createJobEngine({ db: reopenedDb });
    expect(reopened.worker.getWorkerAssignment(admission.assignment.assignmentId)).toMatchObject({
      childJobId: admission.child.jobId,
      repositorySnapshotId: snapshot.id,
    });
    expect(reopened.getAttempt(admission.child.attemptId)).toMatchObject({ generation: 1 });
    expect(reopened.worker.listWorkerRunsForChild(admission.child.jobId)[0]).toMatchObject({
      childAttemptId: admission.child.attemptId,
      childGeneration: 1,
      acceptedResultId: resultId,
    });
    expect(reopened.worker.getWorkerResult(resultId!)).toMatchObject({ acceptanceState: 'accepted' });
    expect(reopened.proof.listEvidence(admission.child.jobId).map((item) => item.evidenceId)).toEqual([childEvidenceId]);
    expect(reopened.proof.listEvidence(parent.jobId).map((item) => item.evidenceId)).toContain(parentEvidenceId);
    expect(reopened.proof.listClaims(parent.jobId)).toContainEqual(expect.objectContaining({
      claimId: claim.claimId,
      state: 'verified',
    }));
    expect(createTriggerBus({ db: reopenedDb }).get(admission.triggerEvent.id)).toMatchObject({ status: 'done' });
    expect(reopened.proof.getVerdict(parent.jobId)).toBeNull();
    expect(await readFile(path.join(root, 'source.ts'), 'utf8')).toBe(sourceBytes);
    reopenedDb.close();
  });
});
