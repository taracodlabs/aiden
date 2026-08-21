/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createExternalCodingCapabilitySnapshot } from '../../../core/v4/coding/capability';
import {
  externalCodingReconciliationTruth,
  normalizeExternalCodingReportedFiles,
} from '../../../core/v4/coding/mutationAuthority';
import { bindRun, createWorkerFixture, type WorkerFixture } from '../worker/fixture';

const roots: string[] = [];

async function setup() {
  const fixture = createWorkerFixture(':memory:', Date.now());
  const records = bindRun(fixture, 'mutation');
  const source = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-mutation-source-'));
  const worktrees = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-mutation-worktrees-'));
  roots.push(source, worktrees);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(source, 'result.txt'), 'before\n');
  await writeFile(path.join(source, 'protected.txt'), 'protected\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);
  const codingSessionId = 'coding_session_mutation';
  const lease = await fixture.engine.codingWorkspaces.allocate({
    codingSessionId, ...fixture.childAuthority, sourcePath: source, worktreeParent: worktrees,
    protectedPaths: ['protected.txt'], now: 30,
  });
  const capability = createExternalCodingCapabilitySnapshot({
    capabilityId: 'external-coding:fake', providerId: 'fake_coding', providerVersion: '1.0.0',
    protocolMode: 'structured', protocolVersion: '1', capturedAt: 30,
    supportedFeatures: {
      structuredProtocol: true, pty: false, resume: false, semanticEvents: true,
      clarification: true, approvalEvents: true, nativeDiff: false, nativeTestEvents: true,
      networkRequired: false, processTreeGuarantee: 'supervised', commandVisibility: 'mediated',
    },
    runtimeCompatibility: { platforms: [process.platform] },
  });
  fixture.engine.coding.admit({
    codingSessionId, parentJobId: fixture.parent.jobId, assignmentId: records.assignment.assignmentId,
    workerRunId: records.run.workerRunId, ...fixture.childAuthority,
    workspaceLeaseId: lease.workspaceLeaseId, sessionHomePath: path.join(worktrees, 'session-home'), capability,
    taskEnvelope: {
      goal: 'Update result.txt.', allowedScope: ['result.txt'], protectedPaths: ['protected.txt'],
      forbiddenOperations: ['git.commit', 'git.push'],
      acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt contains after', required: true }],
      validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
      budgets: { runtimeMs: 60_000, outputBytes: 32_768, commandCount: 8 },
      promotionPolicy: 'human_approval_required',
    },
    producer: 'test', idempotencyKey: 'mutation-session', now: 31,
  });
  return { fixture, lease, codingSessionId };
}

async function cleanup(value: { fixture: WorkerFixture; lease: { workspaceLeaseId: string }; codingSessionId: string }) {
  const current = value.fixture.engine.codingWorkspaces.get(value.lease.workspaceLeaseId);
  if (current && current.state !== 'released' && current.state !== 'reconciliation_required') {
    await value.fixture.engine.codingWorkspaces.release({
      workspaceLeaseId: current.workspaceLeaseId, codingSessionId: value.codingSessionId,
      ...value.fixture.childAuthority, disposition: 'discard', now: 50,
    });
  }
  value.fixture.db.close();
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('external coding mutation reconciliation', () => {
  it('normalizes Windows relative, slash, absolute, and case variants to one repository path', () => {
    expect(normalizeExternalCodingReportedFiles([
      'src/value.js',
      'src\\value.js',
      '.\\src\\value.js',
      'C:\\isolated\\worktree\\src\\value.js',
      'C:/ISOLATED/WORKTREE/SRC/VALUE.JS',
    ], 'C:\\isolated\\worktree', 'win32')).toEqual(['src/value.js']);
  });

  it('derives the actual diff independently instead of trusting reported files', async () => {
    const value = await setup();
    try {
      const baseline = await value.fixture.engine.codingMutations.captureBaseline({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority, producer: 'test', now: 32,
      });
      await writeFile(path.join(value.lease.worktreePath, 'result.txt'), 'after\n');
      const receipt = await value.fixture.engine.codingMutations.reconcile({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority,
        reportedResult: {
          summary: 'Claimed an unrelated file.', reportedFiles: ['reported-only.txt'],
          reportedValidations: ['tests passed'], externalOutcome: 'completed',
        },
        producer: 'test', now: 33,
      });
      const replayed = await value.fixture.engine.codingMutations.reconcile({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority,
        reportedResult: {
          summary: 'Claimed an unrelated file.', reportedFiles: ['reported-only.txt'],
          reportedValidations: ['tests passed'], externalOutcome: 'completed',
        },
        producer: 'test', now: 34,
      });

      expect(baseline.id).toMatch(/^repository_snapshot_/);
      expect(replayed.receiptId).toBe(receipt.receiptId);
      expect(value.fixture.engine.coding.listEvents(value.codingSessionId)
        .filter((event) => event.type === 'reconciliation.completed')).toHaveLength(1);
      expect(receipt).toMatchObject({
        state: 'observed', changedPaths: ['result.txt'], unexpectedPaths: [],
        protectedPathViolations: [], reportMismatch: true,
      });
      expect(receipt.reportedFiles).toEqual(['reported-only.txt']);
      expect(externalCodingReconciliationTruth(receipt)).toEqual({
        actualOutcomeKnown: true,
        providerReportMatches: false,
        actualChangedFiles: ['result.txt'],
        reportedChangedFiles: ['reported-only.txt'],
        mismatchReasons: ['not_reported:result.txt', 'not_observed:reported-only.txt'],
        protectedPathsIntact: true,
        workspaceContained: true,
        safeForIndependentValidation: true,
      });
      expect(value.fixture.engine.proof.listEvidence(value.fixture.child.jobId)).toContainEqual(expect.objectContaining({
        source: 'external-coding.diff', repositorySnapshotId: receipt.postSnapshotId,
        verificationResult: 'partial',
      }));
    } finally {
      await cleanup(value);
    }
  });

  it('normalizes an absolute provider-reported worktree path to the same observed file', async () => {
    const value = await setup();
    try {
      await value.fixture.engine.codingMutations.captureBaseline({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority, producer: 'test', now: 32,
      });
      await writeFile(path.join(value.lease.worktreePath, 'result.txt'), 'after\n');
      const receipt = await value.fixture.engine.codingMutations.reconcile({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority,
        reportedResult: {
          summary: 'Candidate prepared.',
          reportedFiles: [path.join(value.lease.worktreePath, 'result.txt')],
          reportedValidations: [],
          externalOutcome: 'completed',
        },
        producer: 'test', now: 33,
      });

      expect(receipt.changedPaths).toEqual(['result.txt']);
      expect(receipt.reportedFiles).toEqual(['result.txt']);
      expect(receipt.reportMismatch).toBe(false);
    } finally {
      await cleanup(value);
    }
  });

  it('rejects protected and unexpected paths even when the provider reports success', async () => {
    const value = await setup();
    try {
      await value.fixture.engine.codingMutations.captureBaseline({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority, producer: 'test', now: 32,
      });
      await writeFile(path.join(value.lease.worktreePath, 'protected.txt'), 'changed\n');
      await writeFile(path.join(value.lease.worktreePath, 'unexpected.txt'), 'unexpected\n');
      const receipt = await value.fixture.engine.codingMutations.reconcile({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority,
        reportedResult: {
          summary: 'Everything passed.', reportedFiles: ['protected.txt', 'unexpected.txt'],
          reportedValidations: ['all tests passed'], externalOutcome: 'completed',
        },
        producer: 'test', now: 33,
      });

      expect(receipt.state).toBe('rejected');
      expect(receipt.protectedPathViolations).toEqual(['protected.txt']);
      expect(receipt.unexpectedPaths).toEqual(['unexpected.txt']);
      expect(externalCodingReconciliationTruth(receipt)).toMatchObject({
        actualOutcomeKnown: true,
        providerReportMatches: true,
        protectedPathsIntact: false,
        workspaceContained: false,
        safeForIndependentValidation: false,
      });
      expect(value.fixture.engine.coding.get(value.codingSessionId)?.state).not.toBe('ready_for_review');
    } finally {
      await cleanup(value);
    }
  });

  it('rejects staged Git metadata even when the file content is otherwise allowed', async () => {
    const value = await setup();
    try {
      await value.fixture.engine.codingMutations.captureBaseline({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority, producer: 'test', now: 32,
      });
      await writeFile(path.join(value.lease.worktreePath, 'result.txt'), 'after\n');
      execFileSync('git', ['-C', value.lease.worktreePath, 'add', '--', 'result.txt']);
      const receipt = await value.fixture.engine.codingMutations.reconcile({
        codingSessionId: value.codingSessionId, ...value.fixture.childAuthority,
        reportedResult: {
          summary: 'Candidate prepared.', reportedFiles: ['result.txt'],
          reportedValidations: [], externalOutcome: 'completed',
        },
        producer: 'test', now: 33,
      });
      expect(receipt.state).toBe('rejected');
      expect(receipt.protectedPathViolations).toContain('.git/index');
    } finally {
      await cleanup(value);
    }
  });
});
