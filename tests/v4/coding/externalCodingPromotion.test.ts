/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { FakeExternalCodingProvider } from '../../../core/v4/coding/fakeProvider';
import { ExternalCodingProviderRegistry } from '../../../core/v4/coding/providerRegistry';
import {
  admitExternalCodingWorker,
  executeAdmittedExternalCodingWorker,
} from '../../../core/v4/coding/workerBridge';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';

const cleanupRoots: string[] = [];

async function completedCandidate() {
  const source = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-promotion-source-'));
  const worktrees = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-promotion-worktrees-'));
  const homes = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-promotion-homes-'));
  cleanupRoots.push(source, worktrees, homes);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(source, 'source.txt'), 'source remains unchanged\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances
       (instance_id,pid,hostname,started_at,last_heartbeat,version)
     VALUES ('coding-promotion-instance',1,'localhost',1,1,'4.19.1')`,
  ).run();
  const engine = createJobEngine({ db });
  const parent = engine.submitJob({
    entryPoint: 'test', source: 'test', sessionId: 'coding-promotion-parent', workspaceId: source,
    instanceId: 'coding-promotion-instance', idempotencyNamespace: 'coding-promotion-parent',
    idempotencyKey: path.basename(source), goal: 'Coordinate reviewed isolated coding changes.',
    resourcePolicy: {
      budgets: { workers: 1, model_calls: 1, tool_calls: 8, runtime_ms: 60_000, output_bytes: 65_536 },
    },
  });
  const parentLease = engine.claimAttempt({ attemptId: parent.attemptId, ownerId: 'parent-owner', ttlMs: 120_000 });
  if (!parentLease.acquired || !parentLease.fenceToken || parentLease.generation === undefined) throw new Error('parent lease');
  const snapshot = await engine.repository.captureSnapshot({
    jobId: parent.jobId,
    attemptId: parent.attemptId,
    generation: parentLease.generation,
    fenceToken: parentLease.fenceToken,
    requestedPath: source,
    producer: 'test',
  });
  const provider = new FakeExternalCodingProvider({ scenario: 'success' });
  const providers = new ExternalCodingProviderRegistry();
  providers.register(provider);
  const task = {
    goal: 'Create result.txt.',
    allowedScope: ['result.txt'],
    protectedPaths: ['protected.txt'],
    forbiddenOperations: ['git.commit', 'git.push', 'git.tag', 'git.merge', 'git.reset', 'git.clean', 'agent.recursive'],
    acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt contains the verified fixture result', required: true }],
    validationCommands: [],
    networkPolicy: 'disabled' as const,
    packagePolicy: 'deny' as const,
    budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
    promotionPolicy: 'human_approval_required' as const,
  };
  const admission = await admitExternalCodingWorker({
    engine,
    parent: {
      jobId: parent.jobId,
      attemptId: parent.attemptId,
      generation: parentLease.generation,
      fenceToken: parentLease.fenceToken,
    },
    idempotencyKey: `promotion-${path.basename(source)}`,
    repositorySnapshotId: snapshot.id,
    sourcePath: source,
    instanceId: 'coding-promotion-instance',
    providers,
    providerId: provider.id,
    modelId: 'fixture-coding-model',
    task,
  });
  const execution = await executeAdmittedExternalCodingWorker({
    engine,
    ownerId: 'coding-promotion-instance',
    admission,
    providers,
    providerId: provider.id,
    modelId: 'fixture-coding-model',
    sourcePath: source,
    worktreeParent: worktrees,
    sessionHomeParent: homes,
    sourceEnvironment: process.env,
    task,
    sandboxAvailable: true,
    verify: async ({ postSnapshotId }) => {
      const observed = await engine.repository.readFile(postSnapshotId, 'result.txt');
      return {
        claims: [{
          claimId: 'claim_result',
          state: observed.content === 'FAKE_CODING_RESULT\n' ? 'verified' as const : 'failed' as const,
          payload: { fullContentHash: observed.fullContentHash },
        }],
        validationRefs: ['validation_fixture_passed'],
      };
    },
  });
  if (!execution.value.promotion) throw new Error('verified candidate did not create a promotion plan');
  return { db, engine, source, execution, promotion: execution.value.promotion };
}

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('external coding reviewed promotion authority', () => {
  it('applies only the exact approved candidate through SafeChange and releases its isolated worktree', async () => {
    const value = await completedCandidate();
    try {
      expect(value.promotion).toMatchObject({ state: 'prepared', changedPaths: ['result.txt'] });
      await expect(readFile(path.join(value.source, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const worktreePath = value.execution.value.workspace.worktreePath;
      const actions = createActionAuthority({ db: value.db, jobEngine: value.engine });
      const applied = await value.engine.codingPromotions.apply({
        promotionId: value.promotion.promotionId,
        ownerId: 'coding-promotion-instance',
        instanceId: 'coding-promotion-instance',
        actions,
        async requestApproval(request) {
          expect(request.files).toEqual(['result.txt']);
          expect(request.approval.actionDigest).toHaveLength(64);
          return { decision: 'approved', decidedBy: 'reviewer', decisionChannel: 'test' };
        },
      });

      expect(applied.value.disposition).toBe('applied');
      expect(applied.value.promotion.state).toBe('applied');
      expect(applied.value.changeRecordIds).toHaveLength(1);
      await expect(readFile(path.join(value.source, 'result.txt'), 'utf8')).resolves.toBe('FAKE_CODING_RESULT\n');
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(value.engine.changes.listRecords(applied.jobId)).toEqual([
        expect.objectContaining({ state: 'committed', descendantSnapshotId: expect.any(String) }),
      ]);
      expect(value.db.prepare('SELECT state FROM approvals WHERE job_id=? ORDER BY requested_at')
        .all(applied.jobId)).toEqual([
        { state: 'executed' },
        { state: 'executed' },
      ]);
    } finally {
      value.db.close();
    }
  });

  it('records an exact denial, leaves the target unchanged, and removes only the reviewed worktree', async () => {
    const value = await completedCandidate();
    try {
      const worktreePath = value.execution.value.workspace.worktreePath;
      const actions = createActionAuthority({ db: value.db, jobEngine: value.engine });
      const denied = await value.engine.codingPromotions.apply({
        promotionId: value.promotion.promotionId,
        ownerId: 'coding-promotion-instance',
        instanceId: 'coding-promotion-instance',
        actions,
        async requestApproval() {
          return { decision: 'denied', decidedBy: 'reviewer', decisionChannel: 'test' };
        },
      });

      expect(denied.value.disposition).toBe('rejected');
      expect(denied.value.promotion.state).toBe('rejected');
      await expect(readFile(path.join(value.source, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(actions.get(denied.value.promotion.approvalId!)?.state).toBe('denied');
      expect(value.engine.changes.listRecords(denied.jobId)).toEqual([]);
    } finally {
      value.db.close();
    }
  });

  it('blocks target drift without overwriting user content and permits a later explicit discard', async () => {
    const value = await completedCandidate();
    try {
      await writeFile(path.join(value.source, 'user-note.txt'), 'user content\n');
      const actions = createActionAuthority({ db: value.db, jobEngine: value.engine });
      await expect(value.engine.codingPromotions.apply({
        promotionId: value.promotion.promotionId,
        ownerId: 'coding-promotion-instance',
        instanceId: 'coding-promotion-instance',
        actions,
        async requestApproval() {
          throw new Error('approval must not be requested after target drift');
        },
      })).rejects.toMatchObject({ code: 'TARGET_WORKSPACE_DRIFT' });

      expect(value.engine.codingPromotions.get(value.promotion.promotionId)).toMatchObject({
        state: 'blocked_drift',
        blockedReason: expect.stringContaining('user-note.txt'),
      });
      await expect(readFile(path.join(value.source, 'user-note.txt'), 'utf8')).resolves.toBe('user content\n');
      await expect(readFile(path.join(value.source, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const discarded = await value.engine.codingPromotions.discard({
        promotionId: value.promotion.promotionId,
        ownerId: 'coding-promotion-instance',
        instanceId: 'coding-promotion-instance',
        decidedBy: 'reviewer',
        decisionChannel: 'test',
      });
      expect(discarded.value.promotion.state).toBe('rejected');
      await expect(stat(value.execution.value.workspace.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(value.source, 'user-note.txt'), 'utf8')).resolves.toBe('user content\n');
    } finally {
      value.db.close();
    }
  });
});
