/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeExternalCodingProvider } from '../../../core/v4/coding/fakeProvider';
import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { ExternalCodingProviderRegistry } from '../../../core/v4/coding/providerRegistry';
import {
  admitExternalCodingWorker,
  executeAdmittedExternalCodingWorker,
} from '../../../core/v4/coding/workerBridge';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createJobControlAuthority } from '../../../core/v4/daemon/jobControlAuthority';

const roots: string[] = [];

async function fixture(scenario: ConstructorParameters<typeof FakeExternalCodingProvider>[0]['scenario'] = 'success') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-worker-source-'));
  const worktrees = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-worker-worktrees-'));
  const homes = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-worker-homes-'));
  roots.push(root, worktrees, homes);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(root, 'source.txt'), 'source remains unchanged\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances
       (instance_id,pid,hostname,started_at,last_heartbeat,version)
     VALUES ('coding-worker-instance',1,'localhost',1,1,'4.19.1')`,
  ).run();
  const engine = createJobEngine({ db });
  const parent = engine.submitJob({
    entryPoint: 'test', source: 'test', sessionId: 'coding-parent-session', workspaceId: root,
    instanceId: 'coding-worker-instance', idempotencyNamespace: 'coding-parent',
    idempotencyKey: 'one', goal: 'Coordinate one isolated coding Worker.',
    resourcePolicy: {
      budgets: { workers: 1, model_calls: 1, tool_calls: 8, runtime_ms: 60_000, output_bytes: 65_536 },
    },
  });
  const lease = engine.claimAttempt({ attemptId: parent.attemptId, ownerId: 'parent-owner', ttlMs: 120_000 });
  if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('parent lease');
  const snapshot = await engine.repository.captureSnapshot({
    jobId: parent.jobId, attemptId: parent.attemptId, generation: lease.generation,
    fenceToken: lease.fenceToken, requestedPath: root, producer: 'test',
  });
  const provider = new FakeExternalCodingProvider({ scenario });
  const providers = new ExternalCodingProviderRegistry();
  providers.register(provider);
  return {
    db, engine, parent, snapshot, provider, providers, root, worktrees, homes,
    parentAuthority: {
      jobId: parent.jobId, attemptId: parent.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken,
    },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('external coding durable Worker bridge', () => {
  it('accepts a source path alias only when it resolves to the exact captured repository', async () => {
    const value = await fixture();
    const aliasParent = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-worker-alias-'));
    const sourceAlias = path.join(aliasParent, 'source-alias');
    roots.push(aliasParent);
    await symlink(value.root, sourceAlias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const admission = await admitExternalCodingWorker({
        engine: value.engine,
        parent: value.parentAuthority,
        idempotencyKey: 'external-alias-one',
        repositorySnapshotId: value.snapshot.id,
        sourcePath: sourceAlias,
        instanceId: 'coding-worker-instance',
        providers: value.providers,
        providerId: value.provider.id,
        modelId: 'fixture-coding-model',
        task: {
          goal: 'Inspect the exact repository.', allowedScope: [], protectedPaths: [],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [], validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
      });
      expect(admission.assignment.repositorySnapshotId).toBe(value.snapshot.id);
    } finally {
      value.db.close();
    }
  });

  it('admits one exact child Worker and executes it only through the canonical lifecycle', async () => {
    const value = await fixture();
    try {
      const task = {
        goal: 'Create result.txt.', allowedScope: ['result.txt'], protectedPaths: ['protected.txt'],
        forbiddenOperations: ['git.commit', 'git.push', 'git.tag', 'git.merge', 'git.reset', 'git.clean', 'agent.recursive'],
        acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt contains the fixture result', required: true }],
        validationCommands: [], networkPolicy: 'disabled' as const, packagePolicy: 'deny' as const,
        budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8, eventCount: 50 },
        promotionPolicy: 'human_approval_required' as const,
      };
      const admission = await admitExternalCodingWorker({
        engine: value.engine,
        parent: value.parentAuthority,
        idempotencyKey: 'external-fix-one',
        repositorySnapshotId: value.snapshot.id,
        sourcePath: value.root,
        instanceId: 'coding-worker-instance',
        providers: value.providers,
        providerId: value.provider.id,
        modelId: 'fixture-coding-model',
        task,
      });

      expect(value.engine.getChildContract(admission.child.jobId)).toMatchObject({
        parentJobId: value.parent.jobId, workerId: 'external-coding-worker', required: true,
      });
      expect(admission.providerBinding).toMatchObject({
        providerId: 'fake_coding', modelId: 'fixture-coding-model',
      });
      expect(admission.assignment.childJobId).toBe(admission.child.jobId);
      expect(admission.reservation.items.map((item) => item.kind)).toEqual(
        expect.arrayContaining(['workers', 'runtime_ms', 'output_bytes']),
      );

      const execution = await executeAdmittedExternalCodingWorker({
        engine: value.engine,
        ownerId: 'coding-worker-instance',
        admission,
        providers: value.providers,
        providerId: value.provider.id,
        modelId: 'fixture-coding-model',
        sourcePath: value.root,
        worktreeParent: value.worktrees,
        sessionHomeParent: value.homes,
        sourceEnvironment: process.env,
        task,
        sandboxAvailable: true,
        verify: async ({ postSnapshotId, engine }) => {
          const observed = await engine.repository.readFile(postSnapshotId, 'result.txt');
          return {
            claims: [{
              claimId: 'claim_result',
              state: observed.content === 'FAKE_CODING_RESULT\n' ? 'verified' as const : 'failed' as const,
              payload: { contentHash: observed.fullContentHash },
            }],
            validationRefs: [],
          };
        },
      });

      expect(value.engine.getJob(admission.child.jobId)?.status).toBe('completed');
      expect(value.engine.getAttempt(admission.child.attemptId)?.status).toBe('succeeded');
      expect(execution.value.workerResult.acceptanceState).toBe('accepted');
      expect(execution.value.proof.verdict).toBe('verified');
      expect(value.engine.workerProviderCalls.listForWorkerRun(execution.value.workerRun.workerRunId))
        .toEqual([expect.objectContaining({ state: 'completed', providerId: 'fake_coding', modelId: 'fixture-coding-model' })]);
      expect(await readFile(path.join(value.root, 'source.txt'), 'utf8')).toBe('source remains unchanged\n');
      await expect(readFile(path.join(value.root, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      value.db.close();
    }
  });

  it('routes clarification through the parent and returns one generation-fenced durable reply', async () => {
    const value = await fixture('clarification');
    try {
      const task = {
        goal: 'Clarify the storage choice.', allowedScope: [], protectedPaths: [],
        forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
        acceptanceCriteria: [{ claimId: 'claim_answer', statement: 'clarification was delivered', required: true }],
        validationCommands: [], networkPolicy: 'disabled' as const, packagePolicy: 'deny' as const,
        budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
        promotionPolicy: 'human_approval_required' as const,
      };
      const admission = await admitExternalCodingWorker({
        engine: value.engine, parent: value.parentAuthority, idempotencyKey: 'clarification-one',
        repositorySnapshotId: value.snapshot.id, sourcePath: value.root, instanceId: 'coding-worker-instance',
        providers: value.providers, providerId: value.provider.id, modelId: 'fixture-coding-model', task,
      });
      const requests: string[] = [];
      const execution = await executeAdmittedExternalCodingWorker({
        engine: value.engine, ownerId: 'coding-worker-instance', admission,
        providers: value.providers, providerId: value.provider.id, modelId: 'fixture-coding-model',
        sourcePath: value.root, worktreeParent: value.worktrees, sessionHomeParent: value.homes,
        sourceEnvironment: process.env, task, sandboxAvailable: true,
        interaction: {
          async requestClarification(request) {
            requests.push(request.requestId);
            expect(request.parentJobId).toBe(value.parent.jobId);
            return { content: 'Use SQLite.', respondedBy: 'test-user', responseChannel: 'test' };
          },
          async requestApproval() { throw new Error('approval was not requested'); },
        },
        verify: async () => ({
          claims: [{ claimId: 'claim_answer', state: 'verified', payload: { delivered: true } }],
          validationRefs: [],
        }),
      });

      expect(requests).toEqual(['fake_clarification']);
      expect(value.engine.coding.listInputs(execution.value.codingSessionId)).toEqual([
        expect.objectContaining({ kind: 'task', state: 'delivered', sequence: 1 }),
        expect.objectContaining({ kind: 'clarification', content: 'Use SQLite.', state: 'delivered', sequence: 2 }),
      ]);
      expect(execution.value.finalization.status).toBe('completed');
    } finally {
      value.db.close();
    }
  });

  it('keeps an exact package approval separate from text and sends a denied decision without an effect', async () => {
    const value = await fixture('approval');
    try {
      const task = {
        goal: 'Request but do not perform a package installation.', allowedScope: [], protectedPaths: [],
        forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
        acceptanceCriteria: [{ claimId: 'claim_denied', statement: 'denied approval produced no mutation', required: true }],
        validationCommands: [], networkPolicy: 'approved_adapter_only' as const,
        packagePolicy: 'approval_required' as const,
        budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
        promotionPolicy: 'human_approval_required' as const,
      };
      const admission = await admitExternalCodingWorker({
        engine: value.engine, parent: value.parentAuthority, idempotencyKey: 'approval-deny-one',
        repositorySnapshotId: value.snapshot.id, sourcePath: value.root, instanceId: 'coding-worker-instance',
        providers: value.providers, providerId: value.provider.id, modelId: 'fixture-coding-model', task,
      });
      const approvals = createActionAuthority({ db: value.db, jobEngine: value.engine });
      const execution = await executeAdmittedExternalCodingWorker({
        engine: value.engine, ownerId: 'coding-worker-instance', admission,
        providers: value.providers, providerId: value.provider.id, modelId: 'fixture-coding-model',
        sourcePath: value.root, worktreeParent: value.worktrees, sessionHomeParent: value.homes,
        sourceEnvironment: process.env, task, sandboxAvailable: true, approvalAuthority: approvals,
        interaction: {
          async requestClarification() { throw new Error('clarification was not requested'); },
          async requestApproval(request) {
            expect(request.operation).toBe('package.install');
            return { decision: 'denied', decidedBy: 'test-user', decisionChannel: 'test' };
          },
        },
        verify: async ({ postSnapshotId, engine }) => {
          const snapshot = engine.repository.getSnapshot(postSnapshotId)!;
          return {
            claims: [{
              claimId: 'claim_denied', state: snapshot.dirtyPaths.length === 0 ? 'verified' as const : 'failed' as const,
              payload: { dirtyPaths: snapshot.dirtyPaths },
            }],
            validationRefs: [],
          };
        },
      });

      const approvalInputs = value.engine.coding.listInputs(execution.value.codingSessionId)
        .filter((input) => input.kind === 'approval');
      expect(approvalInputs).toEqual([expect.objectContaining({ content: 'denied', state: 'delivered' })]);
      expect(value.engine.listEvents(admission.child.jobId).filter((event) => event.type === 'approval.denied')).toHaveLength(1);
      expect(execution.value.mutation.changedPaths).toEqual([]);
      expect(execution.value.finalization.status).toBe('completed');
    } finally {
      value.db.close();
    }
  });

  it('propagates a durable parent cancellation into the active coding session', async () => {
    const value = await fixture('hang');
    try {
      const task = {
        goal: 'Remain active until the parent cancels.', allowedScope: [], protectedPaths: [],
        forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
        acceptanceCriteria: [{ claimId: 'claim_cancel', statement: 'the provider is cancelled', required: true }],
        validationCommands: [], networkPolicy: 'disabled' as const, packagePolicy: 'deny' as const,
        budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
        promotionPolicy: 'human_approval_required' as const,
      };
      const admission = await admitExternalCodingWorker({
        engine: value.engine, parent: value.parentAuthority, idempotencyKey: 'parent-cancel-one',
        repositorySnapshotId: value.snapshot.id, sourcePath: value.root, instanceId: 'coding-worker-instance',
        providers: value.providers, providerId: value.provider.id, modelId: 'fixture-coding-model', task,
      });
      const execution = executeAdmittedExternalCodingWorker({
        engine: value.engine, ownerId: 'coding-worker-instance', admission,
        providers: value.providers, providerId: value.provider.id, modelId: 'fixture-coding-model',
        sourcePath: value.root, worktreeParent: value.worktrees, sessionHomeParent: value.homes,
        sourceEnvironment: process.env, task, sandboxAvailable: true,
        verify: async () => ({ claims: [], validationRefs: [] }),
      });
      const deadline = Date.now() + 5_000;
      while (value.engine.coding.getForChildJob(admission.child.jobId)?.state !== 'running') {
        if (Date.now() >= deadline) throw new Error('coding session did not start');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const control = createJobControlAuthority({ db: value.db, jobEngine: value.engine });
      expect(control.commands.request({
        jobId: value.parent.jobId,
        attemptId: value.parent.attemptId,
        generation: value.parentAuthority.generation,
        kind: 'cancel',
        reason: 'stopped from workbench web',
        source: 'workbench',
        idempotencyNamespace: 'workbench-control',
        idempotencyKey: `cancel:${value.parent.jobId}`,
      })).toMatchObject({ applied: true });
      expect(value.engine.coding.getForChildJob(admission.child.jobId)).toMatchObject({
        state: 'cancelling',
        cancellationRequestedAt: expect.any(Number),
      });
      await expect(execution).rejects.toMatchObject({ code: 'DURABLE_JOB_CANCELLED' });
      expect(value.engine.getJob(admission.child.jobId)?.status).toBe('cancelled');
      expect(value.engine.coding.getForChildJob(admission.child.jobId)).toMatchObject({
        state: 'terminal',
        reconciliationState: 'reconciled',
        cancellationRequestedAt: expect.any(Number),
      });
      expect(value.engine.codingWorkspaces.getForSession(
        value.engine.coding.getForChildJob(admission.child.jobId)!.codingSessionId,
      )?.state).toBe('released');
      expect(value.engine.workerProviderCalls.listForAttempt(admission.child.attemptId, 1)).toEqual([
        expect.objectContaining({
          state: 'cancelled',
          outcomeKnowledge: 'provider_cancelled_known',
          reconciliationState: 'reconciled',
        }),
      ]);
      expect(value.engine.resources.getWorkerReservation(admission.reservation.reservationId)).toMatchObject({
        state: 'reconciled',
        reconciliationState: 'reconciled',
        unknownSpendPending: false,
      });
      expect(execFileSync('git', ['-C', value.root, 'status', '--short'], { encoding: 'utf8' })).toBe('');
    } finally {
      value.db.close();
    }
  }, 15_000);
});
