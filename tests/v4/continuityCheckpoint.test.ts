import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContinuityCheckpointAuthority } from '../../core/v4/continuityCheckpoint';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../core/v4/daemon/jobEngine';

describe('ContinuityCheckpoint authority', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let admitted: AdmissionResult;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      'INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)',
    ).run('instance_1', 1, 'test', 1, 1, 'test');
    engine = createJobEngine({ db });
    admitted = engine.submitJob({
      entryPoint: 'workbench', source: 'test', sessionId: 'session_1', workspaceId: 'workspace_1',
      instanceId: 'instance_1', idempotencyNamespace: 'test', idempotencyKey: 'job_1', goal: 'inspect repository',
    });
  });
  afterEach(() => db.close());

  const capture = (key = 'one', extras: Record<string, unknown> = {}) => createContinuityCheckpointAuthority({ db, engine }).capture({
    jobId: admitted.jobId, attemptId: admitted.attemptId, attemptGeneration: 1,
    reason: 'safe boundary', idempotencyNamespace: 'test', idempotencyKey: key,
    ...extras,
  });

  it('C1 migration creates the durable table at the latest schema version', () => {
    expect(db.prepare('SELECT version FROM schema_version WHERE id=1').pluck().get()).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='continuity_checkpoints'").pluck().get()).toBe('continuity_checkpoints');
  });
  it('C2 captures exact existing Job and Attempt authority', () => expect(capture()).toMatchObject({ jobId: admitted.jobId, attemptId: admitted.attemptId, attemptGeneration: 1, validity: 'current' }));
  it('C3 is idempotent for one exact capture key', () => expect(capture('same').checkpointId).toBe(capture('same').checkpointId));
  it('C4 supersedes the prior current checkpoint', () => {
    const first = capture('first'); const second = capture('second');
    const authority = createContinuityCheckpointAuthority({ db, engine });
    expect(authority.get(first.checkpointId)?.validity).toBe('superseded');
    expect(second.supersedesCheckpointId).toBe(first.checkpointId);
  });
  it('C5 keeps exactly one current checkpoint per Job', () => {
    capture('first'); capture('second'); capture('third');
    expect(db.prepare("SELECT count(*) FROM continuity_checkpoints WHERE job_id=? AND validity='current'").pluck().get(admitted.jobId)).toBe(1);
  });
  it('C6 rejects a mismatched Attempt', () => expect(() => createContinuityCheckpointAuthority({ db, engine }).capture({
    jobId: admitted.jobId, attemptId: 'attempt_wrong', attemptGeneration: 1, reason: 'bad', idempotencyNamespace: 'test', idempotencyKey: 'bad',
  })).toThrow(/authority/i));
  it('C7 rejects a stale generation', () => expect(() => createContinuityCheckpointAuthority({ db, engine }).capture({
    jobId: admitted.jobId, attemptId: admitted.attemptId, attemptGeneration: 2, reason: 'bad', idempotencyNamespace: 'test', idempotencyKey: 'bad',
  })).toThrow(/authority/i));
  it('C8 references evidence instead of duplicating its payload', () => {
    const value = capture();
    expect(value.evidenceIds).toEqual([]);
    expect(Object.keys(value)).not.toContain('evidence');
  });
  it('C9 stores a bounded reconstruction recipe, not a transcript', () => {
    const value = capture('recipe', { decisions: ['use existing authority'], blockers: ['approval pending'], proposedNext: ['revalidate'] });
    expect(value).toMatchObject({ decisions: ['use existing authority'], blockers: ['approval pending'], proposedNext: ['revalidate'], contextRecipeVersion: 1 });
    expect(Object.keys(value)).not.toContain('messages');
  });
  it('C10 deduplicates durable reference lists', () => expect(capture('refs', { pendingWaitIds: ['wait_1', 'wait_1'], pendingApprovalIds: ['approval_1', 'approval_1'] })).toMatchObject({ pendingWaitIds: ['wait_1'], pendingApprovalIds: ['approval_1'] }));
  it('C11 persists repository and environment fingerprints only as supplied digests', () => expect(capture('fingerprints', { repositoryFingerprint: 'repo_sha', environmentFingerprint: 'env_sha' })).toMatchObject({ repositoryFingerprint: 'repo_sha', environmentFingerprint: 'env_sha' }));
  it('C12 invalidates a checkpoint fail closed', () => {
    const value = capture();
    expect(createContinuityCheckpointAuthority({ db, engine }).invalidate(value.checkpointId)?.validity).toBe('invalid');
  });
  it('C13 detects corrupt stored reference JSON instead of trusting it', () => {
    const value = capture();
    db.prepare("UPDATE continuity_checkpoints SET decisions_json='not-json' WHERE checkpoint_id=?").run(value.checkpointId);
    expect(() => createContinuityCheckpointAuthority({ db, engine }).get(value.checkpointId)).toThrow(/corrupt/i);
  });
  it('C14 lists checkpoints by exact workspace without cross-workspace leakage', () => {
    capture();
    expect(createContinuityCheckpointAuthority({ db, engine }).listForWorkspace('workspace_1')).toHaveLength(1);
    expect(createContinuityCheckpointAuthority({ db, engine }).listForWorkspace('workspace_other')).toEqual([]);
  });
  it('C15 redacts secret-shaped text and stores only a digest of the idempotency key', () => {
    const secret = ['gsk', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
    const value = capture(secret, { decisions: [`use ${secret}`], blockers: [`Bearer ${secret}`] });
    expect(value.decisions).toEqual(['use [redacted]']);
    expect(value.blockers.join(' ')).not.toContain(secret);
    const stored = JSON.stringify(db.prepare('SELECT * FROM continuity_checkpoints WHERE checkpoint_id=?').get(value.checkpointId));
    expect(stored).not.toContain(secret);
    expect(value.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });
  it('C16 deterministically narrows multiple resumable Jobs instead of choosing by event order', () => {
    capture('first-job', { now: 10 });
    const second = engine.submitJob({
      entryPoint: 'workbench', source: 'test', sessionId: 'session_2', workspaceId: 'workspace_1',
      instanceId: 'instance_1', idempotencyNamespace: 'test', idempotencyKey: 'job_2', goal: 'second job',
    });
    engine.continuity!.capture({
      jobId: second.jobId, attemptId: second.attemptId, attemptGeneration: 1,
      reason: 'second boundary', idempotencyNamespace: 'test', idempotencyKey: 'second-job', now: 20,
    });
    const resolution = engine.continuity!.resolveForWorkspace('workspace_1');
    expect(resolution.decision).toBe('choice_required');
    expect(resolution.checkpoint).toBeNull();
    expect(resolution.candidates.map((item) => item.jobId)).toEqual([second.jobId, admitted.jobId]);
  });
  it('C17 reloads the latest valid checkpoint after a database restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-continuity-restart-'));
    const file = path.join(root, 'state.db');
    let first: Database.Database | null = new Database(file);
    let reopened: Database.Database | null = null;
    try {
      runMigrations(first);
      first.prepare('INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)')
        .run('restart_instance', 1, 'test', 1, 1, 'test');
      const firstEngine = createJobEngine({ db: first });
      const job = firstEngine.submitJob({
        entryPoint: 'workbench', source: 'test', sessionId: 'restart_session', workspaceId: 'restart_workspace',
        instanceId: 'restart_instance', idempotencyNamespace: 'restart', idempotencyKey: 'job', goal: 'restart',
      });
      const checkpoint = firstEngine.continuity!.capture({
        jobId: job.jobId, attemptId: job.attemptId, attemptGeneration: 1,
        reason: 'restart boundary', idempotencyNamespace: 'restart', idempotencyKey: 'checkpoint',
      });
      first.close(); first = null;

      reopened = new Database(file);
      runMigrations(reopened);
      const reopenedEngine = createJobEngine({ db: reopened });
      expect(reopenedEngine.continuity!.getLatest(job.jobId)).toMatchObject({
        checkpointId: checkpoint.checkpointId, jobId: job.jobId, attemptId: job.attemptId, validity: 'current',
      });
    } finally {
      try { first?.close(); } catch { /* noop */ }
      try { reopened?.close(); } catch { /* noop */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('C18 marks changed repository or environment assumptions stale without overwriting the checkpoint', () => {
    const checkpoint = capture('assumptions', {
      repositoryFingerprint: 'repo_before', environmentFingerprint: 'env_before',
    });
    expect(engine.continuity!.assess(checkpoint.checkpointId, {
      repositoryFingerprint: 'repo_after', environmentFingerprint: 'env_before',
    })).toMatchObject({ assumptions: 'stale', repositoryDrift: true, environmentDrift: false });
    expect(engine.continuity!.get(checkpoint.checkpointId)?.validity).toBe('current');
  });
  it('C19 preserves physical checkpoint order when timestamps are identical', () => {
    const first = capture('same-time-first', { now: 100 });
    const second = capture('same-time-second', { now: 100 });
    const authority = createContinuityCheckpointAuthority({ db, engine });
    expect(authority.getLatest(admitted.jobId)?.checkpointId).toBe(second.checkpointId);
    expect(authority.listForWorkspace('workspace_1').map((item) => item.checkpointId)).toEqual([
      second.checkpointId,
      first.checkpointId,
    ]);
  });
});
