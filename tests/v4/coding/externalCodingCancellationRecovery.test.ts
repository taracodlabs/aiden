/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { recoverCancelledExternalCodingSessions } from '../../../core/v4/coding/cancellationRecovery';
import { createExternalCodingCapabilitySnapshot } from '../../../core/v4/coding/capability';
import { ExternalCodingProcessHost } from '../../../core/v4/coding/processHost';
import { bindRun, createWorkerFixture } from '../worker/fixture';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('cancelled external coding restart recovery', () => {
  it('settles an exact legacy cancelled session and releases only its isolated repository lock', async () => {
    const storage = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-cancel-recovery-db-'));
    const source = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-cancel-recovery-source-'));
    const worktrees = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-cancel-recovery-worktrees-'));
    const homes = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-cancel-recovery-homes-'));
    roots.push(storage, source, worktrees, homes);
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(source, 'source.txt'), 'baseline\n');
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);

    const fixture = createWorkerFixture(path.join(storage, 'aiden.db'), 10, 'external-coding-worker');
    const host = new ExternalCodingProcessHost();
    let processRecordId: string | null = null;
    try {
      const records = bindRun(fixture, 'cancel-recovery');
      const codingSessionId = 'coding_session_cancel_recovery';
      const workspace = await fixture.engine.codingWorkspaces.allocate({
        codingSessionId,
        ...fixture.childAuthority,
        sourcePath: source,
        worktreeParent: worktrees,
        protectedPaths: [],
        now: 20,
      });
      const sessionHome = path.join(homes, codingSessionId);
      await mkdir(sessionHome, { recursive: true });
      fixture.engine.coding.admit({
        codingSessionId,
        parentJobId: fixture.parent.jobId,
        assignmentId: records.assignment.assignmentId,
        workerRunId: records.run.workerRunId,
        ...fixture.childAuthority,
        workspaceLeaseId: workspace.workspaceLeaseId,
        sessionHomePath: sessionHome,
        capability: createExternalCodingCapabilitySnapshot({
          capabilityId: 'external-coding:fixture', providerId: 'fixture-coding', providerVersion: '1.0.0',
          protocolMode: 'structured', protocolVersion: '1', capturedAt: 20,
          supportedFeatures: {
            structuredProtocol: true, pty: false, resume: false, semanticEvents: true,
            clarification: true, approvalEvents: true, nativeDiff: false, nativeTestEvents: false,
            networkRequired: false, processTreeGuarantee: 'supervised', commandVisibility: 'mediated',
          },
          runtimeCompatibility: { platforms: [process.platform], node: '>=20' },
        }),
        taskEnvelope: {
          goal: 'Inspect in isolation.', allowedScope: [], protectedPaths: [], forbiddenOperations: [],
          acceptanceCriteria: [], validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        producer: 'test', idempotencyKey: 'cancel-recovery-session', now: 21,
      });
      fixture.engine.coding.transition({
        codingSessionId, ...fixture.childAuthority, to: 'starting', producer: 'test',
        idempotencyKey: 'cancel-recovery-starting', now: 22,
      });
      fixture.engine.coding.transition({
        codingSessionId, ...fixture.childAuthority, to: 'running', producer: 'test',
        idempotencyKey: 'cancel-recovery-running', now: 23,
      });
      const handle = await host.start({
        codingSessionId, childAttemptId: fixture.child.attemptId,
        generation: fixture.childAuthority.childGeneration,
        executable: process.execPath, executableVersion: process.version,
        args: ['-e', 'setInterval(()=>{},1000)'], cwd: workspace.worktreePath,
        environment: { PATH: process.env.PATH ?? '', HOME: sessionHome, USERPROFILE: sessionHome, TEMP: homes, TMP: homes },
        protocolMode: 'structured',
        sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
        limits: { outputBytes: 4096, rawLogBytes: 4096 },
      });
      processRecordId = handle.processRecordId;
      fixture.engine.coding.bindProcess({
        codingSessionId, ...fixture.childAuthority,
        processRecordId: handle.processRecordId, processIdentity: handle.identity, now: 24,
      });
      expect(fixture.engine.cancelJob({
        jobId: fixture.child.jobId, reason: 'operator_cancelled', producer: 'test',
        eventIdempotencyKey: 'cancel-recovery-child', now: 25,
      })).toMatchObject({ applied: true });

      // Recreate the persisted shape produced before coding-session cancellation
      // was coupled to the durable Job cancellation transaction.
      fixture.db.prepare(
        "UPDATE external_coding_sessions SET state='running',cancellation_requested_at=NULL WHERE coding_session_id=?",
      ).run(codingSessionId);

      const recovered = await recoverCancelledExternalCodingSessions({
        engine: fixture.engine, sourcePath: source, sessionHomeParent: homes,
        producer: 'test-cancel-recovery', now: 30,
      });

      expect(recovered).toMatchObject({ inspected: 1, recovered: 1, released: 1, blocked: [] });
      expect(fixture.engine.coding.get(codingSessionId)).toMatchObject({
        state: 'terminal', reconciliationState: 'reconciled', cancellationRequestedAt: 30,
      });
      expect(fixture.engine.coding.getProcess(codingSessionId)).toMatchObject({ state: 'exited', treeDeadVerified: true });
      expect(fixture.engine.codingWorkspaces.get(workspace.workspaceLeaseId)).toMatchObject({ state: 'released' });
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM external_coding_repository_locks').get()).toEqual({ count: 0 });
      expect(execFileSync('git', ['-C', source, 'status', '--short'], { encoding: 'utf8' })).toBe('');
      await expect(host.wait(handle.processRecordId, 10_000)).resolves.toMatchObject({ treeDeadVerified: true });
      processRecordId = null;

      await expect(recoverCancelledExternalCodingSessions({
        engine: fixture.engine, sourcePath: source, sessionHomeParent: homes,
        producer: 'test-cancel-recovery', now: 31,
      })).resolves.toMatchObject({ inspected: 0, recovered: 0, released: 0, blocked: [] });
    } finally {
      if (processRecordId && host.active().some((item) => item.processRecordId === processRecordId)) {
        await host.cancel(processRecordId);
      }
      fixture.db.close();
    }
  });
});
