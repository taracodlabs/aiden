/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createExternalCodingCapabilitySnapshot,
} from '../../../core/v4/coding/capability';
import { bindRun, createWorkerFixture } from '../worker/fixture';

const temporaryRoots: string[] = [];

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-repository-'));
  temporaryRoots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(root, 'package.json'), '{"name":"coding-fixture"}\n');
  await writeFile(path.join(root, 'protected.txt'), 'do not change\n');
  execFileSync('git', ['-C', root, 'add', 'package.json', 'protected.txt']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('external coding capability foundation', () => {
  it('creates a deterministic immutable capability digest', () => {
    const first = createExternalCodingCapabilitySnapshot({
      capabilityId: 'external-coding:structured-cli',
      providerId: 'structured-cli',
      providerVersion: '1.2.3',
      protocolMode: 'structured',
      protocolVersion: '1',
      supportedFeatures: {
        structuredProtocol: true,
        pty: false,
        resume: false,
        semanticEvents: true,
        clarification: true,
        approvalEvents: false,
        nativeDiff: false,
        nativeTestEvents: false,
        networkRequired: false,
        processTreeGuarantee: 'supervised',
        commandVisibility: 'observable',
      },
      runtimeCompatibility: { platforms: ['win32', 'linux', 'darwin'], node: '>=20' },
      capturedAt: 10,
    });
    const second = createExternalCodingCapabilitySnapshot({
      ...first,
      capabilityDigest: undefined,
      capturedAt: 99,
    });

    expect(first.capabilityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.capabilityDigest).toBe(first.capabilityDigest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.supportedFeatures)).toBe(true);
  });
});

describe('durable external coding authority', () => {
  it('binds one session to exact Worker, child Attempt, generation and workspace lease', async () => {
    const fixture = createWorkerFixture();
    const records = bindRun(fixture, 'coding');
    const sourceRoot = await repositoryFixture();
    const worktreeParent = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-worktrees-'));
    temporaryRoots.push(worktreeParent);
    const codingSessionId = 'coding_session_foundation';
    const capability = createExternalCodingCapabilitySnapshot({
      capabilityId: 'external-coding:fake', providerId: 'fake', providerVersion: '1.0.0',
      protocolMode: 'structured', protocolVersion: '1', capturedAt: 20,
      supportedFeatures: {
        structuredProtocol: true, pty: false, resume: false, semanticEvents: true,
        clarification: true, approvalEvents: true, nativeDiff: false,
        nativeTestEvents: false, networkRequired: false,
        processTreeGuarantee: 'supervised', commandVisibility: 'mediated',
      },
      runtimeCompatibility: { platforms: [process.platform], node: '>=20' },
    });

    const lease = await fixture.engine.codingWorkspaces.allocate({
      codingSessionId,
      ...fixture.childAuthority,
      sourcePath: sourceRoot,
      worktreeParent,
      protectedPaths: ['protected.txt'],
      now: 20,
    });
    const session = fixture.engine.coding.admit({
      codingSessionId,
      parentJobId: fixture.parent.jobId,
      assignmentId: records.assignment.assignmentId,
      workerRunId: records.run.workerRunId,
      ...fixture.childAuthority,
      workspaceLeaseId: lease.workspaceLeaseId,
      sessionHomePath: path.join(worktreeParent, 'session-home'),
      capability,
      taskEnvelope: {
        goal: 'Fix the failing test.',
        allowedScope: ['package.json'],
        protectedPaths: ['protected.txt'],
        forbiddenOperations: ['git.commit', 'git.push'],
        acceptanceCriteria: [{ claimId: 'claim_test', statement: 'Tests pass', required: true }],
        validationCommands: ['npm test'],
        networkPolicy: 'disabled',
        packagePolicy: 'deny',
        budgets: { runtimeMs: 60_000, outputBytes: 65_536, commandCount: 10 },
        promotionPolicy: 'human_approval_required',
      },
      producer: 'test',
      idempotencyKey: 'coding-session-foundation',
      now: 21,
    });

    expect(session).toMatchObject({
      codingSessionId,
      childJobId: fixture.child.jobId,
      childAttemptId: fixture.child.attemptId,
      childGeneration: fixture.childAuthority.childGeneration,
      assignmentId: records.assignment.assignmentId,
      workerRunId: records.run.workerRunId,
      workspaceLeaseId: lease.workspaceLeaseId,
      state: 'preparing',
      nextEventSequence: 1,
      nextInputSequence: 1,
    });
    expect(lease.worktreePath).not.toBe(sourceRoot);
    expect((await readFile(path.join(lease.worktreePath, 'protected.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('do not change\n');
    expect(execFileSync('git', ['-C', sourceRoot, 'status', '--short'], { encoding: 'utf8' })).toBe('');

    const firstEvent = fixture.engine.coding.appendEvent({
      codingSessionId,
      ...fixture.childAuthority,
      type: 'session.started',
      payload: { mode: 'structured' },
      producer: 'test',
      idempotencyKey: 'session-started',
      now: 22,
    });
    const duplicate = fixture.engine.coding.appendEvent({
      codingSessionId,
      ...fixture.childAuthority,
      type: 'session.started',
      payload: { mode: 'structured' },
      producer: 'test',
      idempotencyKey: 'session-started',
      now: 23,
    });
    const input = fixture.engine.coding.recordInput({
      codingSessionId,
      ...fixture.childAuthority,
      requestId: 'request_clarification',
      kind: 'clarification',
      content: 'Use SQLite.',
      producer: 'test',
      idempotencyKey: 'clarification-one',
      now: 24,
    });

    expect(firstEvent).toMatchObject({ sequence: 1, duplicate: false });
    expect(duplicate).toMatchObject({ sequence: 1, duplicate: true });
    expect(input.sequence).toBe(1);
    expect(fixture.engine.coding.listEvents(codingSessionId).map((event) => event.sequence)).toEqual([1]);

    fixture.engine.coding.bindProcess({
      codingSessionId,
      ...fixture.childAuthority,
      processRecordId: 'coding_process_foundation',
      processIdentity: {
        pid: 4242, startTime: 100, executable: 'fixture-runtime', version: '1.0.0',
        cwd: lease.worktreePath, mode: 'structured',
      },
      now: 24,
    });
    fixture.engine.coding.appendRawOutput({
      codingSessionId,
      ...fixture.childAuthority,
      chunkSequence: 1,
      stream: 'stdout',
      content: '{"type":"session.ready"}\n',
      observedByteCount: 25,
      truncated: false,
      now: 24,
    });
    fixture.engine.coding.recordProcessExit({
      codingSessionId,
      ...fixture.childAuthority,
      processRecordId: 'coding_process_foundation',
      state: 'exited',
      exitCode: 0,
      exitSignal: null,
      treeDeadVerified: true,
      now: 25,
    });
    expect(fixture.engine.coding.getProcess(codingSessionId)).toMatchObject({
      processRecordId: 'coding_process_foundation', state: 'exited', exitCode: 0, treeDeadVerified: true,
    });
    expect(fixture.engine.coding.listRawOutput(codingSessionId)).toEqual([
      expect.objectContaining({ stream: 'stdout', content: '{"type":"session.ready"}\n' }),
    ]);

    expect(() => fixture.engine.coding.appendEvent({
      codingSessionId,
      ...fixture.childAuthority,
      childGeneration: fixture.childAuthority.childGeneration + 1,
      type: 'result.reported', payload: {}, producer: 'stale',
      idempotencyKey: 'stale-result', now: 25,
    })).toThrow(/stale|authority/i);

    await fixture.engine.codingWorkspaces.release({
      workspaceLeaseId: lease.workspaceLeaseId,
      codingSessionId,
      ...fixture.childAuthority,
      disposition: 'discard',
      now: 26,
    });
    fixture.db.close();
  });

  it('admits only one mutable external session for one repository identity', async () => {
    const first = createWorkerFixture();
    const firstRecords = bindRun(first, 'lock-one');
    const root = await repositoryFixture();
    const worktreeParent = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-locks-'));
    temporaryRoots.push(worktreeParent);
    const firstLease = await first.engine.codingWorkspaces.allocate({
      codingSessionId: 'coding_session_lock_one',
      ...first.childAuthority,
      sourcePath: root,
      worktreeParent,
      protectedPaths: [],
      now: 24,
    });

    await expect(first.engine.codingWorkspaces.allocate({
      codingSessionId: 'coding_session_lock_two',
      ...first.childAuthority,
      sourcePath: root,
      worktreeParent,
      protectedPaths: [],
      now: 25,
    })).rejects.toMatchObject({ code: 'REPOSITORY_MUTATION_LOCKED' });

    await first.engine.codingWorkspaces.release({
      workspaceLeaseId: firstLease.workspaceLeaseId,
      codingSessionId: 'coding_session_lock_one',
      ...first.childAuthority,
      disposition: 'discard',
      now: 26,
    });
    expect(firstRecords.run.childJobId).toBe(first.child.jobId);
    first.db.close();
  });
});
