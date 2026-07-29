/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createActionAuthority,
  normalizeExecutionPlan,
  type ActionAuthority,
  type PolicySnapshotInput,
} from '../../../core/v4/actionAuthority';
import type { GitEffectIo, GitEffectPlan, GitEffectRecord } from '../../../core/v4/codebase/gitEffectAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { normalizedArgsDigest } from '../../../core/v4/daemon/jobExecutionContext';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'color.ui=false', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' },
  }).trim();
}

const policy = (root: string): PolicySnapshotInput => ({
  trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'smart',
  toolMetadataVersion: 'codebase-git-v1', sandboxPolicy: { roots: [root], deny: [] },
  networkPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
});

describe('durable Git effect authority', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let actions: ActionAuthority;
  let root: string;
  let cleanup: string[];
  let admission: AdmissionResult;
  let generation: number;
  let fenceToken: string;
  let toolOrdinal: number;
  let lastSnapshotId: string | undefined;

  beforeEach(async () => {
    cleanup = [];
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-git-effect-'));
    cleanup.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Different User');
    git(root, 'config', 'user.email', 'different@example.invalid');
    await writeFile(path.join(root, 'owned.txt'), 'owned one\n');
    await writeFile(path.join(root, 'user.txt'), 'user one\n');
    git(root, 'add', '--', 'owned.txt', 'user.txt');
    git(root, 'commit', '-qm', 'initial');

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('git-effect-test',1,'localhost',1,1,'4.17.0')`,
    ).run();
    engine = createJobEngine({ db });
    actions = createActionAuthority({ db, jobEngine: engine });
    admission = engine.submitJob({
      entryPoint: 'test', source: 'unit', sessionId: 'git-effects', workspaceId: root,
      instanceId: 'git-effect-test', idempotencyNamespace: 'git-effects',
      idempotencyKey: path.basename(root), goal: 'perform an approved Git operation',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 120_000 });
    generation = lease.generation!;
    fenceToken = lease.fenceToken!;
    engine.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!, generation,
      fenceToken, to: 'running', eventIdempotencyKey: 'git-effect-attempt-running', producer: 'test',
    });
    engine.transitionJob({
      jobId: admission.jobId, attemptId: admission.attemptId, generation, fenceToken,
      expectedStateVersion: 0, to: 'running', eventIdempotencyKey: 'git-effect-job-running', producer: 'test',
    });
    toolOrdinal = 0;
    lastSnapshotId = undefined;
  });

  afterEach(async () => {
    db.close();
    await Promise.all(cleanup.reverse().map((item) => rm(item, { recursive: true, force: true })));
  });

  const binding = () => ({ jobId: admission.jobId, attemptId: admission.attemptId, generation, fenceToken });

  async function capture() {
    const snapshot = await engine.repository.captureSnapshot({
      ...binding(), requestedPath: root, producer: 'test', previousSnapshotId: lastSnapshotId,
    });
    lastSnapshotId = snapshot.id;
    return snapshot;
  }

  function replaceEngine(io: GitEffectIo): void {
    engine = createJobEngine({ db, gitEffectIo: io });
    actions = createActionAuthority({ db, jobEngine: engine });
  }

  async function approve(plan: GitEffectPlan, snapshotId?: string) {
    toolOrdinal += 1;
    const snapshot = snapshotId ? engine.repository.getSnapshot(snapshotId)! : await capture();
    const toolCallId = `git-effect-tool-${toolOrdinal}`;
    const operation = await engine.gitEffects.prepare({
      ...binding(), toolCallId, repositorySnapshotId: snapshot.id, plan, producer: 'test',
    });
    const prepared = engine.prepareToolCall({
      toolCallId, ...binding(), toolName: 'git_effect', normalizedArgsDigest: normalizedArgsDigest(plan),
      riskTier: plan.kind === 'fetch' ? 'caution' : 'dangerous', mutates: true, producer: 'test',
      effect: {
        classification: 'reconcilable_mutation', kind: `git.${plan.kind}`, target: root,
        retrySafety: 'reconcile_before_retry', idempotencySupported: true,
        idempotencyKey: plan.idempotencyKey, reconciliationSupported: true,
        verificationSupported: true, approvalRequirement: 'always', approvalState: 'pending',
        sensitiveFields: ['body'], redactionRules: ['digest_arguments', 'omit_sensitive_values'], trusted: true,
      },
    });
    if (!prepared.effectId) throw new Error('Git Effect was not created');
    engine.gitEffects.bindEffect({ ...binding(), operationId: operation.operationId, effectId: prepared.effectId });
    const normalized = normalizeExecutionPlan({
      toolName: 'git_effect', args: plan as unknown as Record<string, unknown>, cwd: root,
      mutates: true, riskTier: plan.kind === 'fetch' ? 'caution' : 'dangerous', policy: policy(root),
    });
    const approval = actions.request({
      ...binding(), toolCallId, effectId: prepared.effectId, toolName: 'git_effect',
      riskTier: plan.kind === 'fetch' ? 'caution' : 'dangerous', riskReasons: [], normalized,
    });
    engine.gitEffects.bindApproval({
      ...binding(), operationId: operation.operationId, effectId: prepared.effectId,
      approvalId: approval.approvalId, actionDigest: normalized.actionDigest,
    });
    actions.decide({
      approvalId: approval.approvalId, ...binding(), actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId, decision: 'approved',
      decidedBy: 'user', decisionChannel: 'test',
    });
    engine.resolveToolCallApproval({
      toolCallId, ...binding(), state: 'approved', approvalId: approval.approvalId,
      actionDigest: normalized.actionDigest, producer: 'test',
    });
    expect(actions.authorizeExecution({
      approvalId: approval.approvalId, ...binding(), toolCallId, effectId: prepared.effectId,
      actionDigest: normalized.actionDigest, policySnapshotId: approval.policySnapshotId,
    }).authorized).toBe(true);
    engine.startToolCall({ toolCallId, ...binding(), producer: 'test' });
    const execute = async (signal?: AbortSignal) => {
      const result = await engine.gitEffects.execute({
        ...binding(), operationId: operation.operationId, effectId: prepared.effectId!,
        approvalId: approval.approvalId, actionDigest: normalized.actionDigest,
        plan, producer: 'test', signal,
      });
      lastSnapshotId = result.resultingSnapshotId ?? lastSnapshotId;
      return result;
    };
    const settle = (record: GitEffectRecord) => engine.completeToolCall({
      toolCallId, ...binding(), state: record.state === 'succeeded' || record.state === 'reconciled' ? 'completed' : 'unknown',
      sideEffectState: record.state === 'succeeded' || record.reconciliationOutcome === 'occurred' ? 'committed' : 'unknown',
      resultRef: record.operationId, verificationRef: record.evidenceId, producer: 'test',
    });
    return { operation, effectId: prepared.effectId, toolCallId, execute, settle };
  }

  async function addBareRemote(): Promise<string> {
    const remote = await mkdtemp(path.join(os.tmpdir(), 'aiden-git-bare-'));
    cleanup.push(remote);
    execFileSync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-qu', 'origin', 'main');
    execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { windowsHide: true });
    return remote;
  }

  async function advanceRemote(remote: string, file = 'remote.txt'): Promise<string> {
    const clone = await mkdtemp(path.join(os.tmpdir(), 'aiden-git-clone-'));
    cleanup.push(clone);
    execFileSync('git', ['clone', '-q', remote, clone], { windowsHide: true });
    git(clone, 'config', 'user.name', 'Remote User');
    git(clone, 'config', 'user.email', 'remote@example.invalid');
    await writeFile(path.join(clone, file), 'remote update\n');
    git(clone, 'add', '--', file);
    git(clone, 'commit', '-qm', 'remote update');
    git(clone, 'push', '-q', 'origin', 'main');
    return git(clone, 'rev-parse', 'HEAD');
  }

  it('stages exact owned paths while preserving unrelated dirty and staged work', async () => {
    await writeFile(path.join(root, 'owned.txt'), 'owned two\n');
    await writeFile(path.join(root, 'user.txt'), 'user two\n');
    git(root, 'add', '--', 'user.txt');
    const operation = await approve({ kind: 'stage', ownedPaths: ['owned.txt'], idempotencyKey: 'stage-owned' });
    const result = await operation.execute();
    operation.settle(result);
    expect(git(root, 'diff', '--cached', '--name-only').split(/\r?\n/).sort()).toEqual(['owned.txt', 'user.txt']);
    expect(await readFile(path.join(root, 'user.txt'), 'utf8')).toBe('user two\n');
  });

  it('unstages exact owned paths without altering unrelated staged work', async () => {
    await writeFile(path.join(root, 'owned.txt'), 'owned two\n');
    await writeFile(path.join(root, 'user.txt'), 'user two\n');
    git(root, 'add', '--', 'owned.txt', 'user.txt');
    const operation = await approve({ kind: 'unstage', ownedPaths: ['owned.txt'], idempotencyKey: 'unstage-owned' });
    const result = await operation.execute();
    operation.settle(result);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('user.txt');
    expect(git(root, 'status', '--short')).toContain('owned.txt');
  });

  it('rejects secret-bearing paths before staging', async () => {
    await writeFile(path.join(root, '.env'), 'TOKEN=not-a-real-secret\n');
    const snapshot = await capture();
    await expect(engine.gitEffects.prepare({
      ...binding(), toolCallId: 'secret-stage', repositorySnapshotId: snapshot.id,
      plan: { kind: 'stage', ownedPaths: ['.env'], idempotencyKey: 'secret-stage' }, producer: 'test',
    })).rejects.toMatchObject({ code: 'GIT_SECRET_PATH_REJECTED' });
  });

  it('rejects credential values in public Git metadata', async () => {
    const snapshot = await capture();
    await expect(engine.gitEffects.prepare({
      ...binding(), toolCallId: 'secret-message', repositorySnapshotId: snapshot.id,
      plan: {
        kind: 'commit', ownedPaths: ['owned.txt'], message: 'token=not-a-real-secret',
        idempotencyKey: 'secret-message',
      },
      producer: 'test',
    })).rejects.toMatchObject({ code: 'GIT_SECRET_CONTENT_REJECTED' });
  });

  it('commits only owned paths with Shiva Deore author and committer identity', async () => {
    await writeFile(path.join(root, 'owned.txt'), 'owned two\n');
    await writeFile(path.join(root, 'user.txt'), 'user two\n');
    git(root, 'add', '--', 'owned.txt', 'user.txt');
    const operation = await approve({
      kind: 'commit', ownedPaths: ['owned.txt'], message: 'test: commit owned file', idempotencyKey: 'commit-owned',
    });
    const result = await operation.execute();
    operation.settle(result);
    expect(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('owned.txt');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('user.txt');
    expect(git(root, 'show', '-s', '--format=%an <%ae>|%cn <%ce>', 'HEAD'))
      .toBe('Shiva Deore <shiva.deore111@gmail.com>|Shiva Deore <shiva.deore111@gmail.com>');
  });

  it('rejects branch drift after approval', async () => {
    const operation = await approve({ kind: 'branch_create', targetRef: 'planned', idempotencyKey: 'branch-drift' });
    git(root, 'switch', '-qc', 'surprise');
    await expect(operation.execute()).rejects.toMatchObject({ code: 'GIT_BRANCH_DRIFT' });
    expect(git(root, 'branch', '--show-current')).toBe('surprise');
  });

  it('creates and switches branches, tags commits, and fast-forwards merges', async () => {
    let operation = await approve({ kind: 'branch_create', targetRef: 'topic', idempotencyKey: 'branch-create' });
    operation.settle(await operation.execute());
    operation = await approve({ kind: 'branch_switch', targetRef: 'topic', idempotencyKey: 'branch-switch-topic' });
    operation.settle(await operation.execute());
    await writeFile(path.join(root, 'topic.txt'), 'topic\n');
    git(root, 'add', '--', 'topic.txt');
    git(root, 'commit', '-qm', 'topic');
    const topicHead = git(root, 'rev-parse', 'HEAD');
    operation = await approve({ kind: 'tag', targetRef: 'v-test', expectedNewRef: topicHead, idempotencyKey: 'tag-test' });
    operation.settle(await operation.execute());
    operation = await approve({ kind: 'branch_switch', targetRef: 'main', idempotencyKey: 'branch-switch-main' });
    operation.settle(await operation.execute());
    operation = await approve({ kind: 'merge', targetRef: 'topic', expectedNewRef: topicHead, idempotencyKey: 'merge-topic' });
    operation.settle(await operation.execute());
    expect(git(root, 'rev-parse', 'HEAD')).toBe(topicHead);
    expect(git(root, 'rev-parse', 'refs/tags/v-test')).toBe(topicHead);
  });

  it('detects a remote advance before push', async () => {
    const remote = await addBareRemote();
    await writeFile(path.join(root, 'owned.txt'), 'local update\n');
    git(root, 'add', '--', 'owned.txt');
    git(root, 'commit', '-qm', 'local update');
    const expectedOldRef = git(root, 'rev-parse', 'HEAD~1');
    const expectedNewRef = git(root, 'rev-parse', 'HEAD');
    const operation = await approve({
      kind: 'push', remote: 'origin', targetRef: 'main', expectedOldRef, expectedNewRef, idempotencyKey: 'push-drift',
    });
    await advanceRemote(remote);
    await expect(operation.execute()).rejects.toMatchObject({ code: 'GIT_REMOTE_REF_DRIFT' });
    expect(git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/main')).not.toContain(expectedNewRef);
  });

  it('reconciles a push that succeeded when its response was lost', async () => {
    await addBareRemote();
    const expectedOldRef = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'owned.txt'), 'local update\n');
    git(root, 'add', '--', 'owned.txt');
    git(root, 'commit', '-qm', 'local update');
    const expectedNewRef = git(root, 'rev-parse', 'HEAD');
    replaceEngine({ afterMutation: async () => { throw new Error('response lost'); } });
    const operation = await approve({
      kind: 'push', remote: 'origin', targetRef: 'main', expectedOldRef, expectedNewRef,
      idempotencyKey: 'push-lost-response',
    });
    await expect(operation.execute()).rejects.toMatchObject({ code: 'GIT_OUTCOME_UNKNOWN' });
    engine.completeToolCall({
      toolCallId: operation.toolCallId, ...binding(), state: 'unknown', sideEffectState: 'unknown', producer: 'test',
    });
    replaceEngine({});
    const reconciled = await engine.gitEffects.reconcile({
      operationId: operation.operation.operationId, producer: 'test', idempotencyKey: 'reconcile-push',
    });
    expect(reconciled.reconciliationOutcome).toBe('occurred');
    expect(git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/main')).toContain(expectedNewRef);
  });

  it('records a command failure before a remote update as failed, not successful', async () => {
    await addBareRemote();
    const expectedOldRef = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'owned.txt'), 'local update\n');
    git(root, 'add', '--', 'owned.txt');
    git(root, 'commit', '-qm', 'local update');
    const expectedNewRef = git(root, 'rev-parse', 'HEAD');
    replaceEngine({ beforeMutation: async () => { git(root, 'remote', 'remove', 'origin'); } });
    const operation = await approve({
      kind: 'push', remote: 'origin', targetRef: 'main', expectedOldRef, expectedNewRef,
      idempotencyKey: 'push-command-fails',
    });
    await expect(operation.execute()).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' });
    expect(engine.gitEffects.get(operation.operation.operationId)?.state).toBe('failed');
  });

  it('reconciles lost PR responses and prevents duplicate creation', async () => {
    await addBareRemote();
    let creates = 0;
    const stored = new Map<string, { externalReference: string; headCommit: string; state: 'open' }>();
    replaceEngine({
      findPullRequest: async ({ idempotencyKey }) => stored.get(idempotencyKey) ?? null,
      createPullRequest: async ({ idempotencyKey, headCommit }) => {
        creates += 1;
        const result = { externalReference: 'https://example.invalid/pull/1', headCommit, state: 'open' as const };
        stored.set(idempotencyKey, result);
        return result;
      },
      afterMutation: async () => { throw new Error('response lost'); },
    });
    const operation = await approve({
      kind: 'pr_create', remote: 'origin', targetRef: 'main', baseRef: 'main', title: 'Add durable Git effect',
      body: 'Summary only.', idempotencyKey: 'pr-stable-identity',
    });
    await expect(operation.execute()).rejects.toMatchObject({ code: 'GIT_OUTCOME_UNKNOWN' });
    engine.completeToolCall({
      toolCallId: operation.toolCallId, ...binding(), state: 'unknown', sideEffectState: 'unknown', producer: 'test',
    });
    replaceEngine({
      findPullRequest: async ({ idempotencyKey }) => stored.get(idempotencyKey) ?? null,
      createPullRequest: async () => { creates += 1; throw new Error('duplicate'); },
    });
    const reconciled = await engine.gitEffects.reconcile({
      operationId: operation.operation.operationId, producer: 'test', idempotencyKey: 'reconcile-pr',
    });
    expect(reconciled.reconciliationOutcome).toBe('occurred');
    expect((await operation.execute()).externalReference).toBe('https://example.invalid/pull/1');
    expect(creates).toBe(1);
  });

  it('does not treat commit exit zero as success when the expected tree differs', async () => {
    await writeFile(path.join(root, 'owned.txt'), 'owned two\n');
    git(root, 'add', '--', 'owned.txt');
    const operation = await approve({
      kind: 'commit', ownedPaths: ['owned.txt'], message: 'test: tree mismatch',
      expectedTreeHash: '0000000000000000000000000000000000000000', idempotencyKey: 'tree-mismatch',
    });
    await expect(operation.execute()).rejects.toMatchObject({ code: 'GIT_OUTCOME_UNKNOWN' });
    expect(engine.gitEffects.get(operation.operation.operationId)?.state).toBe('unknown');
  });

  it('fails a conflicting pull without rewriting local history', async () => {
    const remote = await addBareRemote();
    const remoteHead = await advanceRemote(remote, 'owned.txt');
    await writeFile(path.join(root, 'owned.txt'), 'local divergent update\n');
    git(root, 'add', '--', 'owned.txt');
    git(root, 'commit', '-qm', 'local divergent update');
    const localHead = git(root, 'rev-parse', 'HEAD');
    const operation = await approve({
      kind: 'pull', remote: 'origin', targetRef: 'main', expectedOldRef: localHead,
      expectedNewRef: remoteHead, idempotencyKey: 'pull-conflict',
    });
    await expect(operation.execute()).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(localHead);
  });

  it('marks cancellation after mutation as unknown and requires reconciliation', async () => {
    const controller = new AbortController();
    replaceEngine({ afterMutation: async () => { controller.abort(); } });
    const operation = await approve({ kind: 'branch_create', targetRef: 'cancelled-race', idempotencyKey: 'cancel-race' });
    await expect(operation.execute(controller.signal)).rejects.toMatchObject({ code: 'GIT_OUTCOME_UNKNOWN' });
    expect(engine.gitEffects.get(operation.operation.operationId)?.state).toBe('unknown');
    expect(git(root, 'show-ref', '--verify', 'refs/heads/cancelled-race')).toContain('refs/heads/cancelled-race');
  });

  it('recovers and reconciles an unknown Git Effect after authority restart', async () => {
    await addBareRemote();
    const expectedOldRef = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'owned.txt'), 'restart update\n');
    git(root, 'add', '--', 'owned.txt');
    git(root, 'commit', '-qm', 'restart update');
    const expectedNewRef = git(root, 'rev-parse', 'HEAD');
    replaceEngine({ afterMutation: async () => { throw new Error('connection closed'); } });
    const operation = await approve({
      kind: 'push', remote: 'origin', targetRef: 'main', expectedOldRef, expectedNewRef,
      idempotencyKey: 'restart-push',
    });
    await expect(operation.execute()).rejects.toMatchObject({ code: 'GIT_OUTCOME_UNKNOWN' });
    engine.completeToolCall({
      toolCallId: operation.toolCallId, ...binding(), state: 'unknown', sideEffectState: 'unknown', producer: 'test',
    });
    engine = createJobEngine({ db });
    const recovered = await engine.gitEffects.reconcile({
      operationId: operation.operation.operationId, producer: 'recovery', idempotencyKey: 'restart-reconcile',
    });
    expect(recovered.reconciliationOutcome).toBe('occurred');
    expect(recovered.state).toBe('reconciled');
  });

  it('fetches and verifies remote refs, then deletes the exact remote branch', async () => {
    const remote = await addBareRemote();
    const remoteHead = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', '-q', 'origin', 'HEAD:refs/heads/remote-topic');
    git(root, 'update-ref', '-d', 'refs/remotes/origin/remote-topic');
    let operation = await approve({
      kind: 'fetch', remote: 'origin', targetRef: 'remote-topic', expectedNewRef: remoteHead, idempotencyKey: 'fetch-topic',
    });
    operation.settle(await operation.execute());
    expect(git(root, 'rev-parse', 'refs/remotes/origin/remote-topic')).toBe(remoteHead);
    operation = await approve({
      kind: 'remote_branch_delete', remote: 'origin', targetRef: 'remote-topic', expectedOldRef: remoteHead,
      idempotencyKey: 'delete-remote-topic',
    });
    operation.settle(await operation.execute());
    expect(git(root, 'ls-remote', '--heads', remote, 'refs/heads/remote-topic')).toBe('');
  });
});
