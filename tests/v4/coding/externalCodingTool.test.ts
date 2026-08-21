/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { FakeExternalCodingProvider } from '../../../core/v4/coding/fakeProvider';
import { ExternalCodingProviderRegistry } from '../../../core/v4/coding/providerRegistry';
import { createJobControlAuthority } from '../../../core/v4/daemon/jobControlAuthority';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { buildWorkbenchApprovalCallbacks } from '../../../core/v4/workbench/approvalBridge';
import { projectWorkbenchJob } from '../../../core/v4/workbench/projection';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { makeExternalCodingTool } from '../../../tools/v4/coding/externalCoding';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { createWorkerFixture } from '../worker/fixture';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('external coding production tool boundary', () => {
  it('waits durably in Workbench and starts exactly one session after exact approval', async () => {
    const fixture = createWorkerFixture(':memory:', Date.now(), 'external-coding-approval');
    const source = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-approval-source-'));
    const worktrees = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-approval-worktrees-'));
    const homes = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-approval-homes-'));
    roots.push(source, worktrees, homes);
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(source, 'source.txt'), 'source remains unchanged\n');
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);
    const provider = new FakeExternalCodingProvider({ scenario: 'success' });
    const providers = new ExternalCodingProviderRegistry();
    providers.register(provider);
    const actions = createActionAuthority({ db: fixture.db, jobEngine: fixture.engine });
    const controls = createJobControlAuthority({ db: fixture.db, jobEngine: fixture.engine });
    const parentAttempt = fixture.engine.getAttempt(fixture.parentAuthority.parentAttemptId)!;
    fixture.engine.transitionAttempt({
      attemptId: parentAttempt.id,
      expectedStateVersion: parentAttempt.stateVersion,
      generation: fixture.parentAuthority.parentGeneration,
      fenceToken: fixture.parentAuthority.parentFenceToken,
      to: 'running',
      eventIdempotencyKey: 'external-coding-approval-attempt-running',
      producer: 'workbench-test',
    });
    const parentJob = fixture.engine.getJob(fixture.parentAuthority.parentJobId)!;
    fixture.engine.transitionJob({
      jobId: parentJob.id,
      attemptId: parentAttempt.id,
      generation: fixture.parentAuthority.parentGeneration,
      fenceToken: fixture.parentAuthority.parentFenceToken,
      expectedStateVersion: parentJob.stateVersion,
      to: 'running',
      eventIdempotencyKey: 'external-coding-approval-job-running',
      producer: 'workbench-test',
    });
    const registry = new ToolRegistry();
    registry.register(withBuiltInEffectContract(makeExternalCodingTool({
      engine: fixture.engine, actions, providers, providerId: provider.id,
      modelId: 'fixture-model', instanceId: 'worker-instance', worktreeParent: worktrees,
      sessionHomeParent: homes, sourceEnvironment: process.env, sandboxAvailable: () => true,
      validationExecutor: {
        execute: async () => ({
          exitCode: 0, stdout: 'Tests  1 passed (1)\n', stderr: '', timedOut: false, cancelled: false,
        }),
      },
    })));
    const parent = fixture.parentAuthority;
    const callbacks = buildWorkbenchApprovalCallbacks({
      authority: actions,
      jobId: parent.parentJobId,
      attemptId: parent.parentAttemptId,
      generation: parent.parentGeneration,
      pollIntervalMs: 1,
      timeoutMs: 2_000,
    });
    const executor = registry.buildExecutor({
      cwd: source,
      paths: { root: homes } as never,
      actionAuthority: actions,
      approvalEngine: new ApprovalEngine('smart', callbacks),
      policySnapshot: {
        trustLevel: 'Assistant', autonomyPolicy: 'auto', approvalMode: 'smart',
        toolMetadataVersion: 'test', sandboxPolicy: { roots: [source], deny: [] },
        networkPolicy: { default: 'deny' }, pluginGrants: [], mcpGrants: [],
        workspaceOverrides: {}, jobOverrides: {},
      },
    });
    const controller = new AbortController();
    try {
      const execution = runWithJobExecutionContext({
        engine: fixture.engine,
        jobId: parent.parentJobId,
        attemptId: parent.parentAttemptId,
        generation: parent.parentGeneration,
        fenceToken: parent.parentFenceToken,
        producer: 'workbench-test',
        signal: controller.signal,
        workspacePath: source,
        controlAuthority: controls,
      }, () => executor({
        id: 'external-coding-approval-call', name: 'external_coding', arguments: {
          goal: 'Create result.txt.',
          allowed_scope: ['result.txt'],
          protected_paths: ['PROTECTED.md'],
          acceptance_criteria: [{ statement: 'result.txt passes validation', required: true }],
          validation_commands: ['npm test'],
        },
      }, controller.signal));

      let pending = actions.listPending(parent.parentJobId);
      for (let attempt = 0; pending.length === 0 && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        pending = actions.listPending(parent.parentJobId);
      }
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        jobId: parent.parentJobId,
        attemptId: parent.parentAttemptId,
        generation: parent.parentGeneration,
        toolName: 'external_coding',
        state: 'displayed',
      });
      expect(fixture.engine.coding.listForJob(parent.parentJobId)).toEqual([]);
      await expect(readFile(path.join(source, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(controls.waits.listPending(parent.parentJobId)).toEqual([
        expect.objectContaining({ kind: 'approval', payloadRef: pending[0]!.approvalId }),
      ]);
      expect(projectWorkbenchJob(fixture.engine, { jobId: parent.parentJobId })?.approvals).toEqual([
        expect.objectContaining({
          approval_id: pending[0]!.approvalId,
          tool_name: 'external_coding',
          state: 'displayed',
        }),
      ]);

      const decision = {
        approvalId: pending[0]!.approvalId,
        jobId: parent.parentJobId,
        attemptId: parent.parentAttemptId,
        generation: parent.parentGeneration,
        actionDigest: pending[0]!.actionDigest,
        policySnapshotId: pending[0]!.policySnapshotId,
        decision: 'approved' as const,
        decidedBy: 'workbench-user',
        decisionChannel: 'workbench',
      };
      expect(actions.decide(decision).state).toBe('approved');
      expect(actions.decide(decision).state).toBe('approved');

      const result = await execution;
      expect(result.error).toBeUndefined();
      expect(fixture.engine.coding.listForJob(parent.parentJobId)).toHaveLength(1);
      expect(controls.waits.listPending(parent.parentJobId)).toEqual([]);

      const deniedExecution = runWithJobExecutionContext({
        engine: fixture.engine,
        jobId: parent.parentJobId,
        attemptId: parent.parentAttemptId,
        generation: parent.parentGeneration,
        fenceToken: parent.parentFenceToken,
        producer: 'workbench-test',
        signal: controller.signal,
        workspacePath: source,
        controlAuthority: controls,
      }, () => executor({
        id: 'external-coding-denied-call', name: 'external_coding', arguments: {
          goal: 'Create denied.txt.',
          allowed_scope: ['denied.txt'],
          protected_paths: ['PROTECTED.md'],
          acceptance_criteria: [{ statement: 'denied.txt would pass validation', required: true }],
          validation_commands: ['npm test'],
        },
      }, controller.signal));
      let deniedPending = actions.listPending(parent.parentJobId);
      for (let attempt = 0; deniedPending.length === 0 && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        deniedPending = actions.listPending(parent.parentJobId);
      }
      expect(deniedPending).toHaveLength(1);
      const denial = {
        approvalId: deniedPending[0]!.approvalId,
        jobId: parent.parentJobId,
        attemptId: parent.parentAttemptId,
        generation: parent.parentGeneration,
        actionDigest: deniedPending[0]!.actionDigest,
        policySnapshotId: deniedPending[0]!.policySnapshotId,
        decision: 'denied' as const,
        decidedBy: 'workbench-user',
        decisionChannel: 'workbench',
      };
      expect(actions.decide(denial).state).toBe('denied');
      expect(actions.decide(denial).state).toBe('denied');
      const deniedResult = await deniedExecution;
      expect(deniedResult.error).toMatch(/denied by approval engine/i);
      expect(fixture.engine.coding.listForJob(parent.parentJobId)).toHaveLength(1);
      await expect(readFile(path.join(source, 'denied.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(controls.waits.listPending(parent.parentJobId)).toEqual([]);
    } finally {
      controller.abort();
      fixture.db.close();
    }
  }, 30_000);

  it('admits a real durable child and returns only an independently verified review candidate', async () => {
    const fixture = createWorkerFixture(':memory:', Date.now(), 'external-coding-worker');
    const source = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-tool-source-'));
    const worktrees = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-tool-worktrees-'));
    const homes = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-tool-homes-'));
    roots.push(source, worktrees, homes);
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(source, 'source.txt'), 'source remains unchanged\n');
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);
    const provider = new FakeExternalCodingProvider({ scenario: 'success' });
    const providers = new ExternalCodingProviderRegistry();
    providers.register(provider);
    const actions = createActionAuthority({ db: fixture.db, jobEngine: fixture.engine });
    const handler = makeExternalCodingTool({
      engine: fixture.engine, actions, providers, providerId: provider.id,
      modelId: 'fixture-model', instanceId: 'worker-instance', worktreeParent: worktrees,
      sessionHomeParent: homes, sourceEnvironment: process.env, sandboxAvailable: () => true,
      validationExecutor: {
        execute: async () => ({
          exitCode: 0, stdout: 'Tests  1 passed (1)\n', stderr: '', timedOut: false, cancelled: false,
        }),
      },
    });
    const registry = new ToolRegistry();
    registry.register({ ...handler, mutates: false, riskTier: 'safe' });
    const executor = registry.buildExecutor({
      cwd: source,
      paths: { root: homes } as never,
    });
    const parent = fixture.parentAuthority;
    const controller = new AbortController();
    try {
      const result = await runWithJobExecutionContext({
        engine: fixture.engine,
        jobId: parent.parentJobId,
        attemptId: parent.parentAttemptId,
        generation: parent.parentGeneration,
        fenceToken: parent.parentFenceToken,
        producer: 'test',
        signal: controller.signal,
        workspacePath: source,
      }, () => executor({
        id: 'external-coding-tool-one', name: 'external_coding', arguments: {
          goal: 'Create result.txt.',
          allowed_scope: ['result.txt'],
          protected_paths: ['protected.txt'],
          acceptance_criteria: [
            { statement: '`npm test` passes successfully', required: true },
            { statement: 'The change is minimal.', required: false },
          ],
          validation_commands: ['npm test', 'echo unsupported'],
        },
      }, controller.signal));

      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({
        success: true,
        proof: 'verified',
        changedPaths: ['result.txt'],
        promotion: { state: 'prepared' },
      });
      expect(fixture.engine.proof.listClaims(parent.parentJobId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          statement: '`npm test` passes successfully',
          state: 'verified',
        }),
        expect.objectContaining({
          statement: 'The change is minimal.',
          required: false,
          state: 'unverified',
        }),
      ]));
      expect(fixture.engine.proof.listEvidence(parent.parentJobId)).toEqual([
        expect.objectContaining({
          source: 'external-coding.parent-verification',
          verificationResult: 'verified',
        }),
      ]);
      expect(fixture.engine.proof.finalize({
        jobId: parent.parentJobId,
        attemptId: parent.parentAttemptId,
        generation: parent.parentGeneration,
        fenceToken: parent.parentFenceToken,
      }).verdict).toBe('verified');
      expect(fixture.engine.coding.listForJob(fixture.parent.jobId)).toEqual([
        expect.objectContaining({ parentJobId: fixture.parent.jobId, state: 'ready_for_review' }),
      ]);
      expect(await readFile(path.join(source, 'source.txt'), 'utf8')).toBe('source remains unchanged\n');
      await expect(readFile(path.join(source, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fixture.db.close();
    }
  }, 30_000);

  it('fails before admission without an active durable parent context', async () => {
    const fixture = createWorkerFixture(':memory:', Date.now(), 'external-coding-worker');
    const provider = new FakeExternalCodingProvider({ scenario: 'success' });
    const providers = new ExternalCodingProviderRegistry();
    providers.register(provider);
    const handler = makeExternalCodingTool({
      engine: fixture.engine,
      actions: createActionAuthority({ db: fixture.db, jobEngine: fixture.engine }),
      providers, providerId: provider.id, modelId: 'fixture-model', instanceId: 'fixture',
      worktreeParent: os.tmpdir(), sessionHomeParent: os.tmpdir(), sourceEnvironment: process.env,
      sandboxAvailable: () => false,
      validationExecutor: { execute: async () => { throw new Error('must not run'); } },
    });
    try {
      await expect(handler.execute({
        goal: 'change', allowed_scope: ['result.txt'], protected_paths: [],
        acceptance_criteria: [{ statement: 'verified' }], validation_commands: ['npm test'],
      }, { cwd: process.cwd(), paths: {} as never })).rejects.toThrow(/active durable Job Attempt/);
      expect(fixture.engine.coding.listForJob(fixture.parent.jobId)).toEqual([]);
    } finally {
      fixture.db.close();
    }
  });
});
