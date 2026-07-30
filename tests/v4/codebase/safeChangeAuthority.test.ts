/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import type { FileChangePlan, SafeChangeIo } from '../../../core/v4/codebase/safeChangeAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { normalizedArgsDigest } from '../../../core/v4/daemon/jobExecutionContext';

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

const policy = (root: string): PolicySnapshotInput => ({
  trustLevel: 'Assistant',
  autonomyPolicy: 'ask_for_mutations',
  approvalMode: 'smart',
  toolMetadataVersion: 'codebase-v1',
  sandboxPolicy: { roots: [root], deny: [] },
  networkPolicy: {},
  pluginGrants: [],
  mcpGrants: [],
  workspaceOverrides: {},
  jobOverrides: {},
});

function toolFor(plan: FileChangePlan): string {
  if (plan.operation === 'patch') return 'file_patch';
  if (plan.operation === 'delete') return 'file_delete';
  if (plan.operation === 'move' || plan.operation === 'rename') return 'file_move';
  return 'file_write';
}

function argsFor(plan: FileChangePlan): Record<string, unknown> {
  if (plan.operation === 'patch') {
    return { path: plan.path, find: plan.find, replace: plan.replace, replace_all: plan.replaceAll === true };
  }
  if (plan.operation === 'delete') return { path: plan.path };
  if (plan.operation === 'move' || plan.operation === 'rename') {
    return { from: plan.path, to: plan.destinationPath };
  }
  return { path: plan.path, content: plan.content };
}

describe('source-fenced safe change authority', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let actions: ActionAuthority;
  let root: string;
  let admission: AdmissionResult;
  let generation: number;
  let fenceToken: string;
  let ordinal: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('change-test',1,'localhost',1,1,'4.17.0')`,
    ).run();
    engine = createJobEngine({ db });
    actions = createActionAuthority({ db, jobEngine: engine });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-safe-change-'));
    admission = engine.submitJob({
      entryPoint: 'test', source: 'unit', sessionId: 'safe-change', workspaceId: root,
      instanceId: 'change-test', idempotencyNamespace: 'safe-change',
      idempotencyKey: path.basename(root), goal: 'change repository safely',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 60_000 });
    generation = lease.generation!;
    fenceToken = lease.fenceToken!;
    engine.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!, generation,
      fenceToken, to: 'running', eventIdempotencyKey: 'change-attempt-running', producer: 'test',
    });
    engine.transitionJob({
      jobId: admission.jobId, attemptId: admission.attemptId, generation, fenceToken,
      expectedStateVersion: 0, to: 'running', eventIdempotencyKey: 'change-job-running', producer: 'test',
    });
    ordinal = 0;
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const binding = () => ({
    jobId: admission.jobId,
    attemptId: admission.attemptId,
    generation,
    fenceToken,
  });

  async function capture(previousSnapshotId?: string) {
    return engine.repository.captureSnapshot({
      ...binding(), requestedPath: root, producer: 'test', previousSnapshotId,
    });
  }

  async function approve(baseSnapshotId: string, plan: FileChangePlan) {
    ordinal += 1;
    const toolName = toolFor(plan);
    const args = argsFor(plan);
    const toolCallId = `change-tool-${ordinal}`;
    const intent = await engine.changes.prepare({
      ...binding(), toolCallId, baseSnapshotId, plan, producer: 'test',
    });
    const prepared = engine.prepareToolCall({
      toolCallId, ...binding(), toolName, normalizedArgsDigest: normalizedArgsDigest(args),
      riskTier: plan.operation === 'delete' ? 'dangerous' : 'caution', mutates: true, producer: 'test',
      effect: {
        classification: 'reconcilable_mutation',
        kind: plan.operation === 'delete' ? 'filesystem.delete'
          : plan.operation === 'move' || plan.operation === 'rename' ? 'filesystem.move'
            : 'filesystem.write',
        target: path.join(root, plan.path), retrySafety: 'reconcile_before_retry',
        idempotencySupported: true, idempotencyKey: `change:${intent.intentId}`,
        reconciliationSupported: true, verificationSupported: true,
        approvalRequirement: 'policy', approvalState: 'pending', sensitiveFields: ['content'],
        redactionRules: ['digest_arguments', 'omit_sensitive_values'], trusted: true,
      },
    });
    if (!prepared.effectId) throw new Error('Effect was not created');
    engine.changes.bindEffect({ ...binding(), intentId: intent.intentId, effectId: prepared.effectId });
    const normalized = normalizeExecutionPlan({
      toolName, args, cwd: root, mutates: true,
      riskTier: plan.operation === 'delete' ? 'dangerous' : 'caution', policy: policy(root),
    });
    const approval = actions.request({
      ...binding(), toolCallId, effectId: prepared.effectId, toolName,
      riskTier: plan.operation === 'delete' ? 'dangerous' : 'caution', riskReasons: [], normalized,
    });
    engine.changes.bindApproval({
      ...binding(), intentId: intent.intentId, effectId: prepared.effectId,
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
    return {
      intent,
      effectId: prepared.effectId,
      approvalId: approval.approvalId,
      actionDigest: normalized.actionDigest,
      execute: (override = plan, signal?: AbortSignal) => engine.changes.execute({
        ...binding(), intentId: intent.intentId, effectId: prepared.effectId!,
        approvalId: approval.approvalId, actionDigest: normalized.actionDigest,
        plan: override, producer: 'test', signal,
      }),
    };
  }

  function replaceEngine(io: SafeChangeIo): void {
    engine = createJobEngine({ db, safeChangeIo: io });
    actions = createActionAuthority({ db, jobEngine: engine });
  }

  it('rejects a write when the user changes the source after approval', async () => {
    await writeFile(path.join(root, 'source.ts'), 'const value = 1;\n');
    const snapshot = await capture();
    const change = await approve(snapshot.id, { operation: 'modify', path: 'source.ts', content: 'const value = 2;\n' });
    await writeFile(path.join(root, 'source.ts'), 'const userValue = 3;\n');
    await expect(change.execute()).rejects.toMatchObject({ code: 'STALE_SOURCE' });
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('const userValue = 3;\n');
    expect(engine.proof.listEvidence(admission.jobId)).toContainEqual(expect.objectContaining({
      effectId: change.effectId,
      repositorySnapshotId: snapshot.id,
      source: 'repository.change.conflict',
      coverage: 'full',
      verificationResult: 'unknown',
      payload: expect.objectContaining({
        intentId: change.intent.intentId,
        errorCode: 'STALE_SOURCE',
        expectedHash: sha256('const value = 1;\n'),
        observedHash: sha256('const userValue = 3;\n'),
      }),
    }));
  });

  it('rejects inactive Attempts and stale fence tokens before mutation', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const snapshot = await capture();
    const change = await approve(snapshot.id, { operation: 'modify', path: 'source.ts', content: 'after\n' });
    db.prepare('UPDATE tasks SET active_attempt_id=NULL WHERE id=?').run(admission.jobId);
    await expect(change.execute()).rejects.toMatchObject({ code: 'STALE_CHANGE_AUTHORITY' });
    db.prepare('UPDATE tasks SET active_attempt_id=? WHERE id=?').run(admission.attemptId, admission.jobId);
    db.prepare('UPDATE runs SET fence_token=? WHERE attempt_id=?').run('replacement-fence', admission.attemptId);
    await expect(change.execute()).rejects.toMatchObject({ code: 'STALE_CHANGE_AUTHORITY' });
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('before\n');
  });

  it('rejects an operation changed after exact approval', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const snapshot = await capture();
    const change = await approve(snapshot.id, { operation: 'modify', path: 'source.ts', content: 'approved\n' });
    await expect(change.execute({ operation: 'modify', path: 'source.ts', content: 'changed\n' }))
      .rejects.toMatchObject({ code: 'APPROVED_CHANGE_MISMATCH' });
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('before\n');
  });

  it('rejects symlink traversal outside the workspace', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aiden-safe-change-outside-'));
    await writeFile(path.join(outside, 'outside.ts'), 'outside\n');
    await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const snapshot = await capture();
      await expect(engine.changes.prepare({
        ...binding(), toolCallId: 'escape', baseSnapshotId: snapshot.id,
        plan: { operation: 'modify', path: 'escape/outside.ts', content: 'changed\n' }, producer: 'test',
      })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
      await expect(readFile(path.join(outside, 'outside.ts'), 'utf8')).resolves.toBe('outside\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('rejects Windows junction traversal outside the workspace', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aiden-safe-change-junction-'));
    await writeFile(path.join(outside, 'outside.ts'), 'outside\n');
    await symlink(outside, path.join(root, 'junction'), 'junction');
    try {
      const snapshot = await capture();
      await expect(engine.changes.prepare({
        ...binding(), toolCallId: 'junction', baseSnapshotId: snapshot.id,
        plan: { operation: 'delete', path: 'junction/outside.ts' }, producer: 'test',
      })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('never verifies a write when fresh readback fails', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const snapshot = await capture();
    const change = await approve(snapshot.id, { operation: 'modify', path: 'source.ts', content: 'after\n' });
    replaceEngine({ readback: async () => { throw new Error('readback unavailable'); } });
    await expect(change.execute()).rejects.toMatchObject({ code: 'READBACK_FAILED' });
    expect(engine.proof.listClaims(admission.jobId)).toContainEqual(expect.objectContaining({ state: 'unknown' }));
    expect(engine.proof.listEvidence(admission.jobId)).toContainEqual(expect.objectContaining({
      effectId: change.effectId, verificationResult: 'unknown', coverage: 'unknown',
    }));
  });

  it('fails closed for ambiguous and zero-match patches', async () => {
    await writeFile(path.join(root, 'source.ts'), 'value\nvalue\n');
    let snapshot = await capture();
    await expect(approve(snapshot.id, {
      operation: 'patch', path: 'source.ts', find: 'value', replace: 'next', replaceAll: false,
    })).rejects.toMatchObject({ code: 'PATCH_AMBIGUOUS' });
    await writeFile(path.join(root, 'source.ts'), 'value\n');
    snapshot = await capture(snapshot.id);
    await expect(approve(snapshot.id, {
      operation: 'patch', path: 'source.ts', find: 'missing', replace: 'next', replaceAll: false,
    })).rejects.toMatchObject({ code: 'PATCH_NO_MATCH' });
  });

  it('preserves CRLF, UTF-8 BOM, and executable mode', async () => {
    const target = path.join(root, 'script.ts');
    await writeFile(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\r\nsecond\r\n')]));
    if (process.platform !== 'win32') await chmod(target, 0o755);
    const beforeMode = (await lstat(target)).mode & 0o777;
    const snapshot = await capture();
    const change = await approve(snapshot.id, {
      operation: 'patch', path: 'script.ts', find: 'second', replace: 'changed\ncontinued', replaceAll: false,
    });
    const result = await change.execute();
    const bytes = await readFile(target);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString('utf8')).toBe('\ufefffirst\r\nchanged\r\ncontinued\r\n');
    expect((await lstat(target)).mode & 0o777).toBe(beforeMode);
    expect(result.resultHash).toBe(sha256(bytes));
  });

  it('rejects unsupported binary edits', async () => {
    await writeFile(path.join(root, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
    const snapshot = await capture();
    await expect(engine.changes.prepare({
      ...binding(), toolCallId: 'binary', baseSnapshotId: snapshot.id,
      plan: { operation: 'modify', path: 'asset.bin', content: 'text' }, producer: 'test',
    })).rejects.toMatchObject({ code: 'BINARY_EDIT_UNSUPPORTED' });
  });

  it('records cancellation after mutation as unknown and never verifies it', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const snapshot = await capture();
    const change = await approve(snapshot.id, { operation: 'modify', path: 'source.ts', content: 'after\n' });
    const aborter = new AbortController();
    replaceEngine({ afterMutation: async () => { aborter.abort(); } });
    await expect(change.execute(undefined, aborter.signal)).rejects.toMatchObject({ code: 'CHANGE_CANCELLED_UNKNOWN' });
    expect(engine.proof.listClaims(admission.jobId)).toContainEqual(expect.objectContaining({ state: 'unknown' }));
  });

  it('returns the same committed record for an exact duplicate retry', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const snapshot = await capture();
    const change = await approve(snapshot.id, { operation: 'modify', path: 'source.ts', content: 'after\n' });
    const first = await change.execute();
    const second = await change.execute();
    expect(second.changeId).toBe(first.changeId);
    expect(engine.changes.listRecords(admission.jobId)).toHaveLength(1);
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('after\n');
  });

  it('detects undeclared formatter changes without claiming scoped success', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    await writeFile(path.join(root, 'other.ts'), 'owned by user\n');
    const snapshot = await capture();
    const change = await approve(snapshot.id, { operation: 'modify', path: 'source.ts', content: 'after\n' });
    replaceEngine({ afterMutation: async () => { await writeFile(path.join(root, 'other.ts'), 'formatter changed this\n'); } });
    await expect(change.execute()).rejects.toMatchObject({ code: 'UNDECLARED_WORKSPACE_CHANGE' });
    expect(engine.changes.getRecord(change.intent.intentId)).toMatchObject({ state: 'failed' });
  });

  it('persists exact Effect-linked evidence and a descendant snapshot', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    await writeFile(path.join(root, 'dirty.txt'), 'unrelated dirty work\n');
    const snapshot = await capture();
    const change = await approve(snapshot.id, { operation: 'modify', path: 'source.ts', content: 'after\n' });
    const result = await change.execute();
    const evidence = engine.proof.listEvidence(admission.jobId);
    expect(result).toMatchObject({
      state: 'committed', fenceToken, effectId: change.effectId, baseSnapshotId: snapshot.id,
      descendantSnapshotId: expect.any(String), diffEvidenceId: expect.any(String),
      resultHash: sha256('after\n'),
    });
    expect(evidence).toContainEqual(expect.objectContaining({
      evidenceId: result.diffEvidenceId, effectId: change.effectId,
      source: 'repository.change.readback', coverage: 'full', verificationResult: 'verified',
    }));
    expect(engine.repository.compareSnapshots(snapshot.id, result.descendantSnapshotId!).changed).toEqual(['source.ts']);
    await expect(readFile(path.join(root, 'dirty.txt'), 'utf8')).resolves.toBe('unrelated dirty work\n');
    expect(engine.proof.listClaims(admission.jobId)).toContainEqual(expect.objectContaining({ state: 'verified' }));
  });

  it('supports create, modify, patch, rename, move, and delete as fenced single-file changes', async () => {
    let snapshot = await capture();
    const create = await approve(snapshot.id, { operation: 'create', path: 'one.txt', content: 'one\n' });
    snapshot = engine.repository.getSnapshot((await create.execute()).descendantSnapshotId!)!;
    const modify = await approve(snapshot.id, { operation: 'modify', path: 'one.txt', content: 'two\n' });
    snapshot = engine.repository.getSnapshot((await modify.execute()).descendantSnapshotId!)!;
    const patch = await approve(snapshot.id, { operation: 'patch', path: 'one.txt', find: 'two', replace: 'three' });
    snapshot = engine.repository.getSnapshot((await patch.execute()).descendantSnapshotId!)!;
    const rename = await approve(snapshot.id, { operation: 'rename', path: 'one.txt', destinationPath: 'renamed.txt' });
    snapshot = engine.repository.getSnapshot((await rename.execute()).descendantSnapshotId!)!;
    const move = await approve(snapshot.id, { operation: 'move', path: 'renamed.txt', destinationPath: 'nested/moved.txt' });
    snapshot = engine.repository.getSnapshot((await move.execute()).descendantSnapshotId!)!;
    const remove = await approve(snapshot.id, { operation: 'delete', path: 'nested/moved.txt' });
    const final = await remove.execute();
    await expect(readFile(path.join(root, 'nested/moved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(engine.repository.compareSnapshots(snapshot.id, final.descendantSnapshotId!).removed).toEqual(['nested/moved.txt']);
  });
});
