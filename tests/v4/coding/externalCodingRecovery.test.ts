/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createExternalCodingCapabilitySnapshot } from '../../../core/v4/coding/capability';
import { ExternalCodingProcessHost } from '../../../core/v4/coding/processHost';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { sweepDurableJobRecovery } from '../../../core/v4/daemon/jobRecoverySweep';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { bindRun, createWorkerFixture } from '../worker/fixture';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('external coding restart reconciliation', () => {
  it('reopens an interrupted coding session for reconciliation and never blindly retries its child Attempt', async () => {
    const storage = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-recovery-db-'));
    const source = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-recovery-source-'));
    const worktrees = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-recovery-worktrees-'));
    roots.push(storage, source, worktrees);
    const databasePath = path.join(storage, 'aiden.db');
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(source, 'source.txt'), 'baseline\n');
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);

    const fixture = createWorkerFixture(databasePath, 10, 'external-coding-worker');
    const processHost = new ExternalCodingProcessHost();
    let processRecordId: string | null = null;
    let initialDatabaseOpen = true;
    try {
      const records = bindRun(fixture, 'coding-recovery');
    const capability = createExternalCodingCapabilitySnapshot({
      capabilityId: 'external-coding:fake',
      providerId: 'fake_coding',
      providerVersion: '1.0.0',
      protocolMode: 'structured',
      protocolVersion: '1',
      capturedAt: 20,
      supportedFeatures: {
        structuredProtocol: true,
        pty: false,
        resume: false,
        semanticEvents: true,
        clarification: true,
        approvalEvents: true,
        nativeDiff: false,
        nativeTestEvents: false,
        networkRequired: false,
        processTreeGuarantee: 'supervised',
        commandVisibility: 'mediated',
      },
      runtimeCompatibility: { platforms: [process.platform], node: '>=20' },
    });
      const codingSessionId = 'coding_session_recovery';
      const workspace = await fixture.engine.codingWorkspaces.allocate({
      codingSessionId,
      ...fixture.childAuthority,
      sourcePath: source,
      worktreeParent: worktrees,
      protectedPaths: [],
      now: 20,
    });
      fixture.engine.coding.admit({
      codingSessionId,
      parentJobId: fixture.parent.jobId,
      assignmentId: records.assignment.assignmentId,
      workerRunId: records.run.workerRunId,
      ...fixture.childAuthority,
      workspaceLeaseId: workspace.workspaceLeaseId,
      sessionHomePath: path.join(worktrees, 'session-home'),
      capability,
      taskEnvelope: {
        goal: 'Prepare an isolated change.',
        allowedScope: ['result.txt'],
        protectedPaths: [],
        forbiddenOperations: ['git.commit', 'git.push'],
        acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result is verified', required: true }],
        validationCommands: ['npm test'],
        networkPolicy: 'disabled',
        packagePolicy: 'deny',
        budgets: { runtimeMs: 60_000, outputBytes: 65_536, commandCount: 8 },
        promotionPolicy: 'human_approval_required',
      },
      producer: 'test',
      idempotencyKey: 'coding-recovery-session',
      now: 21,
    });
      fixture.engine.coding.transition({
      codingSessionId,
      ...fixture.childAuthority,
      to: 'starting',
      producer: 'test',
      idempotencyKey: 'coding-recovery-starting',
      now: 22,
    });
      fixture.engine.coding.transition({
      codingSessionId,
      ...fixture.childAuthority,
      to: 'running',
      producer: 'test',
      idempotencyKey: 'coding-recovery-running',
      now: 23,
    });
      const processHandle = await processHost.start({
        codingSessionId,
        childAttemptId: fixture.childAuthority.childAttemptId,
        generation: fixture.childAuthority.childGeneration,
        executable: process.execPath,
        executableVersion: process.version,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: workspace.worktreePath,
        environment: {
          PATH: process.env.PATH ?? '',
          HOME: path.join(worktrees, 'session-home'),
          USERPROFILE: path.join(worktrees, 'session-home'),
          TEMP: worktrees,
          TMP: worktrees,
        },
        protocolMode: 'structured',
        sandbox: {
          required: true, available: true, authority: 'test-fixture',
          networkEnforced: true, workspaceWriteBoundaryEnforced: true,
        },
        limits: { outputBytes: 4096, rawLogBytes: 4096 },
      });
      processRecordId = processHandle.processRecordId;
      fixture.engine.coding.bindProcess({
      codingSessionId,
      ...fixture.childAuthority,
      processRecordId: processHandle.processRecordId,
      processIdentity: processHandle.identity,
      now: 24,
    });
      fixture.engine.renewAttemptLease({
        attemptId: fixture.parentAuthority.parentAttemptId,
        ownerId: 'parent-owner',
        generation: fixture.parentAuthority.parentGeneration,
        fenceToken: fixture.parentAuthority.parentFenceToken,
        ttlMs: 120_000,
        now: 24,
      });
      fixture.db.close();
      initialDatabaseOpen = false;

      const reopenedDb = new Database(databasePath);
      reopenedDb.pragma('foreign_keys = ON');
      runMigrations(reopenedDb);
      const reopened = createJobEngine({ db: reopenedDb });
      try {
      const sweep = sweepDurableJobRecovery({
        jobEngine: reopened,
        triggerBus: createTriggerBus({ db: reopenedDb }),
        instanceId: 'worker-instance',
        producer: 'test-recovery',
        now: 60_011,
      });
      expect(sweep).toMatchObject({ expired: 1, needsUser: 1, retried: 0, enqueued: 0 });
      expect(reopened.getAttempt(fixture.child.attemptId)).toMatchObject({ status: 'unknown' });
      expect(reopened.getJob(fixture.child.jobId)).toMatchObject({
        status: 'blocked',
        finishReason: 'worker_provider_outcome_unknown',
        activeAttemptId: null,
      });
      expect(reopened.coding.get(codingSessionId)).toMatchObject({
        state: 'reconciliation_required',
        reconciliationState: 'required',
      });
      expect(reopened.coding.getProcess(codingSessionId)).toMatchObject({ state: 'unknown', treeDeadVerified: true });
      expect(reopened.codingWorkspaces.get(workspace.workspaceLeaseId)).toMatchObject({
        state: 'reconciliation_required',
      });
      expect(reopened.coding.listEvents(codingSessionId)).toContainEqual(expect.objectContaining({
        type: 'reconciliation.started',
        payload: expect.objectContaining({ authorityLost: true, processIdentityMatched: true, processTreeDeadVerified: true }),
      }));
      await expect(processHost.wait(processHandle.processRecordId, 10_000)).resolves.toMatchObject({ treeDeadVerified: true });
      expect(processHost.active()).toEqual([]);
      expect(sweepDurableJobRecovery({
        jobEngine: reopened,
        triggerBus: createTriggerBus({ db: reopenedDb }),
        instanceId: 'worker-instance',
        producer: 'test-recovery',
        now: 60_012,
      }).expired).toBe(0);
      } finally {
        reopenedDb.close();
        execFileSync('git', ['-C', source, 'worktree', 'remove', '--force', workspace.worktreePath]);
      }
    } finally {
      if (processRecordId && processHost.active().some((item) => item.processRecordId === processRecordId)) {
        await processHost.cancel(processRecordId);
      }
      if (initialDatabaseOpen && fixture.db.open) fixture.db.close();
    }
  });
});
