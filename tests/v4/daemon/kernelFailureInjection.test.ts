/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createActionAuthority,
  normalizeExecutionPlan,
  type PolicySnapshotInput,
} from '../../../core/v4/actionAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { sweepDurableJobRecovery } from '../../../core/v4/daemon/jobRecoverySweep';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';

const INSTANCE = 'failure-instance';
const policy: PolicySnapshotInput = {
  trustLevel: 'Assistant',
  autonomyPolicy: 'ask_for_mutations',
  approvalMode: 'smart',
  toolMetadataVersion: '1',
  sandboxPolicy: { roots: ['C:/workspace'], deny: [] },
  networkPolicy: { allow: ['localhost'] },
  pluginGrants: [],
  mcpGrants: [],
  workspaceOverrides: {},
  jobOverrides: {},
};

type Authority = { attemptId: string; generation: number; fenceToken: string };

function seedInstance(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(INSTANCE, 1, 'localhost', 1, 1, '4.16.1');
}

function open(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 100');
  runMigrations(db);
  seedInstance(db);
  return db;
}

function submit(engine: JobEngine, key: string, overrides: Partial<Parameters<JobEngine['submitJob']>[0]> = {}): AdmissionResult {
  return engine.submitJob({
    entryPoint: 'failure-injection', source: 'test', sessionId: 'failure-session',
    instanceId: INSTANCE, idempotencyNamespace: 'failure-injection',
    idempotencyKey: key, requestFingerprint: key, goal: `boundary ${key}`,
    ...overrides,
  });
}

function claim(engine: JobEngine, admitted: AdmissionResult, now = 100, ttlMs = 10): Authority {
  const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'failure-worker', ttlMs, now });
  if (!lease.acquired || lease.generation === undefined || !lease.fenceToken) throw new Error('lease unavailable');
  return { attemptId: admitted.attemptId, generation: lease.generation, fenceToken: lease.fenceToken };
}

function mutatingEffect(target: string, content = 'external result') {
  return {
    classification: 'reconcilable_mutation' as const,
    kind: 'filesystem.write', target,
    retrySafety: 'reconcile_before_retry' as const,
    idempotencySupported: true, idempotencyKey: `effect:${target}`,
    reconciliationSupported: true, verificationSupported: true,
    approvalRequirement: 'policy' as const, approvalState: 'not_required' as const,
    sensitiveFields: ['content'], redactionRules: ['digest_arguments'], trusted: true,
    reconciliationData: {
      path: target,
      before: { exists: false },
      expectedSize: Buffer.byteLength(content),
      expectedContentSha256: createHash('sha256').update(content).digest('hex'),
    },
  };
}

describe('kernel deterministic failure boundaries', () => {
  const directories: string[] = [];
  let db: Database.Database | null = null;

  const databasePath = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'aiden-kernel-failure-'));
    directories.push(directory);
    return join(directory, 'daemon.db');
  };

  const reopen = (path: string): Database.Database => {
    db?.close();
    db = open(path);
    return db;
  };

  afterEach(() => {
    try { db?.close(); } catch { /* already closed */ }
    db = null;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('boundaries 1-3: admission is atomic and a committed queued Attempt survives reopen before claim', () => {
    const path = databasePath();
    db = open(path);
    let engine = createJobEngine({ db });

    db.exec("CREATE TRIGGER fail_before_job BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'before Job commit'); END");
    expect(() => submit(engine, 'before-job')).toThrow(/before Job commit/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    db.exec('DROP TRIGGER fail_before_job');

    db.exec("CREATE TRIGGER fail_before_attempt BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'before Attempt creation'); END");
    expect(() => submit(engine, 'before-attempt')).toThrow(/before Attempt creation/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 0 });
    db.exec('DROP TRIGGER fail_before_attempt');

    const admitted = submit(engine, 'before-claim');
    engine = createJobEngine({ db: reopen(path) });
    expect(engine.getJob(admitted.jobId)).toMatchObject({ status: 'queued', activeAttemptId: admitted.attemptId });
    expect(engine.getAttempt(admitted.attemptId)).toMatchObject({ status: 'queued', leaseId: null, generation: 1 });
    expect(engine.listEvents(admitted.jobId).map((event) => event.type)).toEqual(['job.submitted', 'attempt.created']);
    expect(claim(engine, admitted).generation).toBe(1);
  });

  it('boundary 4: a crash after lease claim expires safely and fences the stale worker', () => {
    const path = databasePath();
    db = open(path);
    let engine = createJobEngine({ db });
    const admitted = submit(engine, 'after-claim');
    const stale = claim(engine, admitted);

    engine = createJobEngine({ db: reopen(path) });
    expect(engine.recoverExpiredAttempts({ now: 111, instanceId: INSTANCE, producer: 'recovery', maxCrashes: 3 }))
      .toEqual([expect.objectContaining({ jobId: admitted.jobId, decision: 'retry' })]);
    expect(engine.listAttempts(admitted.jobId)).toEqual([
      expect.objectContaining({ id: admitted.attemptId, status: 'crashed', generation: 1 }),
      expect.objectContaining({ status: 'queued', generation: 2, recoveryOfAttemptId: admitted.attemptId }),
    ]);
    expect(engine.transitionAttempt({
      attemptId: stale.attemptId, expectedStateVersion: 1, generation: stale.generation,
      fenceToken: stale.fenceToken, to: 'succeeded', eventIdempotencyKey: 'late-success', producer: 'stale', now: 112,
    })).toMatchObject({ applied: false, conflict: 'terminal_state' });
  });

  it('boundary 5: a prepared but unstarted Effect is durable and cannot be started by a stale owner', () => {
    const path = databasePath();
    db = open(path);
    let engine = createJobEngine({ db });
    const admitted = submit(engine, 'effect-before-execution');
    const authority = claim(engine, admitted);
    expect(engine.prepareToolCall({
      toolCallId: 'tool-prepared', jobId: admitted.jobId, ...authority,
      toolName: 'file_write', normalizedArgsDigest: 'prepared-digest', riskTier: 'caution', mutates: true,
      effect: mutatingEffect(join(tmpdir(), 'not-written.txt')), producer: 'test', now: 101,
    }).applied).toBe(true);

    engine = createJobEngine({ db: reopen(path) });
    expect(db.prepare('SELECT effect_state FROM side_effect_ledger WHERE tool_call_id = ?').get('tool-prepared'))
      .toEqual({ effect_state: 'requested' });
    expect(engine.recoverExpiredAttempts({ now: 111, instanceId: INSTANCE, producer: 'recovery', maxCrashes: 3 })[0])
      .toMatchObject({ decision: 'retry' });
    expect(engine.startToolCall({ toolCallId: 'tool-prepared', ...authority, producer: 'stale', now: 112 }))
      .toMatchObject({ applied: false, conflict: 'stale_fence' });
    expect(db.prepare('SELECT effect_state FROM side_effect_ledger WHERE tool_call_id = ?').get('tool-prepared'))
      .toEqual({ effect_state: 'requested' });
  });

  it('boundaries 6-7: owner death during an Effect becomes unknown, while an observed file result reconciles without replay', () => {
    const path = databasePath();
    const directory = join(path, '..');
    const target = join(directory, 'result.txt');
    const content = 'external result';
    db = open(path);
    let engine = createJobEngine({ db });
    const bus = createTriggerBus({ db });
    const admitted = submit(engine, 'external-effect');
    const authority = claim(engine, admitted);
    engine.prepareToolCall({
      toolCallId: 'tool-external', jobId: admitted.jobId, ...authority,
      toolName: 'file_write', normalizedArgsDigest: 'external-digest', riskTier: 'caution', mutates: true,
      effect: mutatingEffect(target, content), producer: 'test', now: 101,
    });
    engine.startToolCall({ toolCallId: 'tool-external', ...authority, producer: 'test', now: 102 });
    writeFileSync(target, content);

    engine = createJobEngine({ db: reopen(path) });
    const sweep = sweepDurableJobRecovery({
      jobEngine: engine, triggerBus: createTriggerBus({ db }), instanceId: INSTANCE,
      producer: 'recovery', now: 111,
    });
    expect(sweep).toMatchObject({ expired: 1, reconciled: 1, retried: 1, needsUser: 0, enqueued: 1 });
    expect(readFileSync(target, 'utf8')).toBe(content);
    expect(engine.listEffectReconciliations('side_effect:tool-external')).toEqual([
      expect.objectContaining({ outcome: 'occurred', confidence: 'high', humanResolutionRequired: false }),
    ]);
    expect(db.prepare('SELECT effect_state FROM side_effect_ledger WHERE tool_call_id = ?').get('tool-external'))
      .toEqual({ effect_state: 'committed' });
    void bus;
  });

  it('boundary 8: a persisted result without evidence remains unverified after restart', () => {
    const path = databasePath();
    db = open(path);
    let engine = createJobEngine({ db });
    const admitted = submit(engine, 'result-before-evidence');
    const authority = claim(engine, admitted, 100, 30_000);
    const claimRecord = engine.proof.createClaim({
      jobId: admitted.jobId, attemptId: admitted.attemptId, generation: 1,
      category: 'contract', statement: 'Result exists', required: true, now: 101,
    });
    engine.prepareToolCall({
      toolCallId: 'tool-result', jobId: admitted.jobId, ...authority,
      toolName: 'file_write', normalizedArgsDigest: 'result-digest', riskTier: 'caution', mutates: true,
      effect: mutatingEffect(join(tmpdir(), 'result-only.txt')), producer: 'test', now: 102,
    });
    engine.startToolCall({ toolCallId: 'tool-result', ...authority, producer: 'test', now: 103 });
    engine.completeToolCall({
      toolCallId: 'tool-result', ...authority, state: 'completed', sideEffectState: 'committed',
      resultRef: 'result:durable', producer: 'test', now: 104,
    });

    engine = createJobEngine({ db: reopen(path) });
    expect(engine.proof.listEvidence(admitted.jobId)).toEqual([]);
    expect(engine.proof.listClaims(admitted.jobId)).toEqual([expect.objectContaining({ claimId: claimRecord.claimId, state: 'unverified' })]);
    expect(engine.proof.finalize({ jobId: admitted.jobId, ...authority, now: 105 })).toMatchObject({ verdict: 'unknown' });
  });

  it('boundaries 9-10: approval wait and exact approval survive reopen without authorizing changed execution', () => {
    const path = databasePath();
    db = open(path);
    let engine = createJobEngine({ db });
    const admitted = submit(engine, 'approval-restart');
    const authority = claim(engine, admitted, 100, 30_000);
    expect(engine.transitionAttempt({
      attemptId: admitted.attemptId, expectedStateVersion: 1, generation: authority.generation,
      fenceToken: authority.fenceToken, to: 'running', eventIdempotencyKey: 'approval-attempt-running',
      producer: 'test', now: 101,
    }).applied).toBe(true);
    expect(engine.transitionJob({
      jobId: admitted.jobId, ...authority, expectedStateVersion: 0, to: 'running',
      eventIdempotencyKey: 'approval-job-running', producer: 'test', now: 101,
    }).applied).toBe(true);
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write', args: { path: 'C:/workspace/result.txt', content: 'ok' },
      cwd: 'C:/workspace', mutates: true, riskTier: 'caution', policy,
    });
    const prepared = engine.prepareToolCall({
      toolCallId: 'tool-approval', jobId: admitted.jobId, ...authority,
      toolName: 'file_write', normalizedArgsDigest: 'approval-digest', riskTier: 'caution', mutates: true,
      effect: { ...mutatingEffect('C:/workspace/result.txt'), approvalState: 'pending' }, producer: 'test', now: 101,
    });
    let actions = createActionAuthority({ db, jobEngine: engine });
    const approval = actions.request({
      jobId: admitted.jobId, ...authority, toolCallId: 'tool-approval', effectId: prepared.effectId,
      toolName: 'file_write', riskTier: 'caution', riskReasons: ['filesystem write'], normalized,
      expiresAt: 10_000, now: 102,
    });
    actions.markDisplayed(approval.approvalId, 102);

    engine = createJobEngine({ db: reopen(path) });
    actions = createActionAuthority({ db, jobEngine: engine });
    expect(actions.listPending(admitted.jobId)).toEqual([expect.objectContaining({ approvalId: approval.approvalId, state: 'displayed' })]);
    actions.decide({
      approvalId: approval.approvalId, jobId: admitted.jobId, attemptId: admitted.attemptId,
      generation: 1, actionDigest: normalized.actionDigest, policySnapshotId: approval.policySnapshotId,
      decision: 'approved', decidedBy: 'user', decisionChannel: 'tui', now: 102,
    });

    engine = createJobEngine({ db: reopen(path) });
    actions = createActionAuthority({ db, jobEngine: engine });
    expect(actions.authorizeExecution({
      approvalId: approval.approvalId, jobId: admitted.jobId, ...authority,
      toolCallId: 'tool-approval', effectId: prepared.effectId ?? null,
      actionDigest: normalized.actionDigest, policySnapshotId: approval.policySnapshotId, now: 103,
    })).toMatchObject({ authorized: true });
    expect(actions.authorizeExecution({
      approvalId: approval.approvalId, jobId: admitted.jobId, ...authority,
      toolCallId: 'tool-approval', effectId: prepared.effectId ?? null,
      actionDigest: normalized.actionDigest, policySnapshotId: approval.policySnapshotId, now: 104,
    })).toMatchObject({ authorized: false, duplicate: true });
  });

  it('boundary 11: reconciliation failure rolls back and a later exact retry records one outcome', () => {
    const path = databasePath();
    db = open(path);
    const engine = createJobEngine({ db });
    const admitted = submit(engine, 'reconciliation-crash');
    const authority = claim(engine, admitted, 100, 30_000);
    engine.prepareToolCall({
      toolCallId: 'tool-reconcile-crash', jobId: admitted.jobId, ...authority,
      toolName: 'file_write', normalizedArgsDigest: 'reconcile-digest', riskTier: 'caution', mutates: true,
      effect: mutatingEffect('C:/workspace/reconcile.txt'), producer: 'test', now: 101,
    });
    engine.startToolCall({ toolCallId: 'tool-reconcile-crash', ...authority, producer: 'test', now: 102 });
    engine.completeToolCall({
      toolCallId: 'tool-reconcile-crash', ...authority, state: 'unknown', sideEffectState: 'unknown', producer: 'test', now: 103,
    });
    db.exec("CREATE TRIGGER fail_reconciliation BEFORE INSERT ON effect_reconciliations BEGIN SELECT RAISE(ABORT, 'reconciliation interrupted'); END");
    const command = {
      effectId: 'side_effect:tool-reconcile-crash', expectedJobStateVersion: 0,
      outcome: 'did_not_occur' as const, confidence: 'high' as const, evidence: { checked: true },
      retryRecommendation: 'retry' as const, humanResolutionRequired: false,
      producer: 'recovery', idempotencyKey: 'reconcile-once', now: 104,
    };
    expect(() => engine.recordEffectReconciliation(command)).toThrow(/reconciliation interrupted/);
    expect(engine.listEffectReconciliations(command.effectId)).toEqual([]);
    expect(db.prepare('SELECT effect_state FROM side_effect_ledger WHERE key = ?').get(command.effectId))
      .toEqual({ effect_state: 'unknown' });
    db.exec('DROP TRIGGER fail_reconciliation');
    expect(engine.recordEffectReconciliation(command).applied).toBe(true);
    expect(engine.recordEffectReconciliation(command)).toMatchObject({ applied: false, duplicate: true });
    expect(engine.listEffectReconciliations(command.effectId)).toHaveLength(1);
  });

  it('boundaries 12-13: child execution and completed child attribution survive parent aggregation restart', () => {
    const path = databasePath();
    db = open(path);
    let engine = createJobEngine({ db });
    const parent = submit(engine, 'parent-child');
    const parentAuthority = claim(engine, parent, 100, 30_000);
    expect(engine.transitionAttempt({
      attemptId: parent.attemptId, expectedStateVersion: 1, generation: parentAuthority.generation,
      fenceToken: parentAuthority.fenceToken, to: 'running', eventIdempotencyKey: 'parent-attempt-running',
      producer: 'parent', now: 101,
    }).applied).toBe(true);
    expect(engine.transitionJob({
      jobId: parent.jobId, ...parentAuthority, expectedStateVersion: 0, to: 'running',
      eventIdempotencyKey: 'parent-job-running', producer: 'parent', now: 101,
    }).applied).toBe(true);
    const child = submit(engine, 'child-running', {
      parentJobId: parent.jobId, rootJobId: parent.jobId,
      childContract: { required: true, workerId: 'child-worker', capabilities: ['read'], allowedResources: {}, budget: {} },
    });
    const childAuthority = claim(engine, child, 100, 30_000);
    expect(engine.transitionAttempt({
      attemptId: child.attemptId, expectedStateVersion: 1, generation: childAuthority.generation,
      fenceToken: childAuthority.fenceToken, to: 'running', eventIdempotencyKey: 'child-attempt-running',
      producer: 'child', now: 102,
    }).applied).toBe(true);
    expect(engine.transitionJob({
      jobId: child.jobId, ...childAuthority, expectedStateVersion: 0, to: 'running',
      eventIdempotencyKey: 'child-job-running', producer: 'child', now: 102,
    }).applied).toBe(true);

    engine = createJobEngine({ db: reopen(path) });
    expect(engine.getChildContract(child.jobId)).toMatchObject({ parentJobId: parent.jobId, resultStatus: null });
    expect(engine.recordChildResult({
      childJobId: child.jobId, ...childAuthority, status: 'completed', evidence: { output: 'done' },
      evidenceHandles: [{ kind: 'proof', value: 'child-proof' }], producer: 'child', idempotencyKey: 'child-result', now: 110,
    }).applied).toBe(true);
    expect(engine.transitionAttempt({
      attemptId: child.attemptId, expectedStateVersion: 2, generation: childAuthority.generation,
      fenceToken: childAuthority.fenceToken, to: 'succeeded', eventIdempotencyKey: 'child-attempt-completed',
      producer: 'child', now: 110,
    }).applied).toBe(true);
    expect(engine.finalizeJob({
      jobId: child.jobId, ...childAuthority, expectedStateVersion: 1,
      status: 'completed', outcome: 'verified', finishReason: 'child completed', evidence: { output: 'done' },
      eventIdempotencyKey: 'child-job-completed', producer: 'child', now: 110,
    }).applied).toBe(true);

    engine = createJobEngine({ db: reopen(path) });
    expect(engine.listChildContracts(parent.jobId)).toEqual([
      expect.objectContaining({ childJobId: child.jobId, resultStatus: 'completed', evidenceHandles: [{ kind: 'proof', value: 'child-proof' }] }),
    ]);
    expect(engine.finalizeJob({
      jobId: parent.jobId, ...parentAuthority, expectedStateVersion: 0,
      status: 'completed', outcome: 'verified', finishReason: 'children aggregated', evidence: { childJobId: child.jobId },
      eventIdempotencyKey: 'parent-final', producer: 'parent', now: 111,
    }).applied).toBe(false);
    expect(engine.finalizeJob({
      jobId: parent.jobId, ...parentAuthority, expectedStateVersion: 1,
      status: 'completed', outcome: 'verified', finishReason: 'children aggregated', evidence: { childJobId: child.jobId },
      eventIdempotencyKey: 'parent-final-current', producer: 'parent', now: 112,
    }).applied).toBe(true);
  });

  it('boundaries 14-15: verification resumes from evidence and a committed verdict replays after UI loss', () => {
    const path = databasePath();
    db = open(path);
    let engine = createJobEngine({ db });
    const admitted = submit(engine, 'verification-ui');
    const authority = claim(engine, admitted, 100, 30_000);
    const claimRecord = engine.proof.createClaim({
      jobId: admitted.jobId, attemptId: admitted.attemptId, generation: 1,
      category: 'contract', statement: 'Output is exact', required: true, now: 101,
    });
    const evidence = engine.proof.recordEvidence({
      jobId: admitted.jobId, ...authority, source: 'test', producer: 'worker', observedAt: 102,
      coverage: 'full', verificationResult: 'verified', payload: { exact: true }, now: 102,
    });

    engine = createJobEngine({ db: reopen(path) });
    expect(engine.proof.getVerdict(admitted.jobId)).toBeNull();
    engine.proof.checkClaim({
      claimId: claimRecord.claimId, attemptId: admitted.attemptId, generation: 1,
      evidenceIds: [evidence.evidenceId], state: 'verified', now: 103,
    });
    const verdict = engine.proof.finalize({ jobId: admitted.jobId, ...authority, now: 104 });
    expect(verdict.verdict).toBe('verified');

    engine = createJobEngine({ db: reopen(path) });
    const replay = engine.projection.rebuild(admitted.jobId);
    expect(replay.verdict).toMatchObject({ verdict: 'verified', attempt_id: admitted.attemptId, generation: 1 });
    expect(engine.proof.finalize({ jobId: admitted.jobId, ...authority, cancelled: true, now: 105 })).toEqual(verdict);
    expect(engine.projection.cursor('lost-ui', admitted.jobId)).toBe(0);
    expect(engine.projection.read('lost-ui', admitted.jobId).map((event) => event.jobSequence))
      .toEqual(engine.listEvents(admitted.jobId).map((event) => event.jobSequence));
  }, 60_000);

  it('keeps an unsafe network Effect unknown after a real loopback disconnect', async () => {
    const path = databasePath();
    db = open(path);
    let engine = createJobEngine({ db });
    const admitted = submit(engine, 'network-disconnect');
    const authority = claim(engine, admitted);
    let received = false;
    let server: Server | null = createServer((request) => {
      request.on('data', () => { received = true; });
      request.on('end', () => request.socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback server did not bind');
    const target = `http://127.0.0.1:${address.port}/effect`;
    engine.prepareToolCall({
      toolCallId: 'tool-network', jobId: admitted.jobId, ...authority,
      toolName: 'web_submit', normalizedArgsDigest: 'network-digest', riskTier: 'dangerous', mutates: true,
      effect: {
        classification: 'non_reconcilable_mutation', kind: 'network.submit', target,
        retrySafety: 'manual_only', idempotencySupported: false, idempotencyKey: null,
        reconciliationSupported: false, verificationSupported: false,
        approvalRequirement: 'policy', approvalState: 'not_required', sensitiveFields: ['body'],
        redactionRules: ['digest_arguments'], trusted: true,
      },
      producer: 'test', now: 101,
    });
    engine.startToolCall({ toolCallId: 'tool-network', ...authority, producer: 'test', now: 102 });

    await expect(new Promise<void>((resolve, reject) => {
      const client = request(target, { method: 'POST' }, (response) => {
        response.resume();
        response.once('end', resolve);
      });
      client.once('error', reject);
      client.end('received-before-disconnect');
    })).rejects.toThrow();
    expect(received).toBe(true);
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
      server!.closeAllConnections();
    });
    server = null;
    engine.completeToolCall({
      toolCallId: 'tool-network', ...authority, state: 'unknown', sideEffectState: 'unknown',
      producer: 'test', now: 103,
    });

    engine = createJobEngine({ db: reopen(path) });
    expect(engine.recoverExpiredAttempts({ now: 111, instanceId: INSTANCE, producer: 'recovery', maxCrashes: 3 }))
      .toEqual([expect.objectContaining({ decision: 'ask_user' })]);
    expect(engine.listEffectsRequiringReconciliation(admitted.jobId)).toEqual([
      expect.objectContaining({ effectId: 'side_effect:tool-network', effectState: 'unknown', retrySafety: 'manual_only' }),
    ]);
  });

  it('surfaces a real database writer lock without partial state and succeeds after release', () => {
    const path = databasePath();
    db = open(path);
    const competing = new Database(path);
    competing.pragma('foreign_keys = ON');
    competing.pragma('busy_timeout = 1');
    try {
      db.exec('BEGIN EXCLUSIVE');
      expect(() => competing.prepare(
        `INSERT INTO daemon_instances
           (instance_id, pid, hostname, started_at, last_heartbeat, version)
         VALUES ('locked-writer', 2, 'localhost', 2, 2, '4.16.1')`,
      ).run()).toThrow(/locked|busy/i);
      db.exec('ROLLBACK');
      expect(competing.prepare("SELECT COUNT(*) AS count FROM daemon_instances WHERE instance_id = 'locked-writer'").get())
        .toEqual({ count: 0 });
      expect(competing.prepare(
        `INSERT INTO daemon_instances
           (instance_id, pid, hostname, started_at, last_heartbeat, version)
         VALUES ('locked-writer', 2, 'localhost', 2, 2, '4.16.1')`,
      ).run().changes).toBe(1);
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      competing.close();
    }
  });
});
