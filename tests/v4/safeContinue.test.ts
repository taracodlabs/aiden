import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContinuityCheckpointAuthority } from '../../core/v4/continuityCheckpoint';
import { runMigrations } from '../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../core/v4/daemon/jobEngine';
import { createTaskStore, type TaskStore } from '../../core/v4/daemon/taskStore';
import { continueFromCheckpoint } from '../../core/v4/safeContinue';

describe('safe continuation from durable checkpoints', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let tasks: TaskStore;
  let admitted: AdmissionResult;
  let checkpointId: string;
  let resume: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)')
      .run('instance_1', 1, 'test', 1, 1, 'test');
    engine = createJobEngine({ db });
    tasks = createTaskStore({ db });
    admitted = engine.submitJob({
      entryPoint: 'workbench', source: 'test', sessionId: 'session_1', workspaceId: 'workspace_1',
      instanceId: 'instance_1', idempotencyNamespace: 'test', idempotencyKey: 'job_1', goal: 'continue safely',
    });
    expect(engine.pauseJob({
      jobId: admitted.jobId, reason: 'interrupted', producer: 'test', eventIdempotencyKey: 'pause-before-continue',
    }).applied).toBe(true);
    checkpointId = createContinuityCheckpointAuthority({ db, engine }).capture({
      jobId: admitted.jobId, attemptId: admitted.attemptId, attemptGeneration: 1,
      reason: 'safe boundary', idempotencyNamespace: 'test', idempotencyKey: 'checkpoint_1',
      repositoryFingerprint: 'repo_1', environmentFingerprint: 'env_1',
    }).checkpointId;
    resume = vi.fn((input: { idempotencyKey: string }) => engine.resumeJob({
      jobId: admitted.jobId,
      instanceId: 'instance_1',
      triggerReason: 'safe continue',
      producer: 'test',
      eventIdempotencyKey: `resume:${input.idempotencyKey}`,
    }));
  });
  afterEach(() => db.close());

  const run = (overrides: Record<string, unknown> = {}) => continueFromCheckpoint({
    db, checkpoints: createContinuityCheckpointAuthority({ db, engine }), engine, taskStore: tasks,
    checkpointId, idempotencyKey: 'continue_1', currentRepositoryFingerprint: 'repo_1',
    currentEnvironmentFingerprint: 'env_1', fileProbe: () => ({ exists: true }), resume,
    ...overrides,
  } as any);

  it('D1 creates a fresh Attempt through the existing resume adapter', () => {
    const result = run();
    expect(result).toMatchObject({ decision: 'continued', priorAttemptId: admitted.attemptId, generation: 2 });
    expect(result.attemptId).not.toBe(admitted.attemptId);
    expect(engine.getJob(admitted.jobId)?.activeAttemptId).toBe(result.attemptId);
  });
  it('D2 passes exact Job, Attempt, generation and bounded preamble to resume', () => {
    run();
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ jobId: admitted.jobId, priorAttemptId: admitted.attemptId, priorGeneration: 1, idempotencyKey: 'continue_1' }));
  });
  it('D3 makes duplicate continue requests idempotent', () => {
    expect(run().decision).toBe('continued');
    expect(run().decision).toBe('already_applied');
    expect(resume).toHaveBeenCalledTimes(1);
  });
  it('D4 refuses a superseded checkpoint', () => {
    createContinuityCheckpointAuthority({ db, engine }).capture({ jobId: admitted.jobId, attemptId: admitted.attemptId, attemptGeneration: 1, reason: 'later', idempotencyNamespace: 'test', idempotencyKey: 'later' });
    expect(() => run()).toThrow(/superseded/i);
  });
  it('D5 refuses an invalid checkpoint', () => {
    createContinuityCheckpointAuthority({ db, engine }).invalidate(checkpointId);
    expect(() => run()).toThrow(/invalid/i);
  });
  it('D6 blocks pending approval before execution', () => {
    checkpointId = createContinuityCheckpointAuthority({ db, engine }).capture({ jobId: admitted.jobId, attemptId: admitted.attemptId, attemptGeneration: 1, reason: 'approval', idempotencyNamespace: 'test', idempotencyKey: 'approval', pendingApprovalIds: ['approval_1'] }).checkpointId;
    expect(run()).toMatchObject({ decision: 'blocked_approval' }); expect(resume).not.toHaveBeenCalled();
  });
  it('D7 blocks a durable wait before execution', () => {
    checkpointId = createContinuityCheckpointAuthority({ db, engine }).capture({ jobId: admitted.jobId, attemptId: admitted.attemptId, attemptGeneration: 1, reason: 'wait', idempotencyNamespace: 'test', idempotencyKey: 'wait', pendingWaitIds: ['wait_1'] }).checkpointId;
    expect(run()).toMatchObject({ decision: 'blocked_wait' }); expect(resume).not.toHaveBeenCalled();
  });
  it('D8 blocks unknown effects instead of repeating them', () => {
    const wrapped = Object.create(engine) as JobEngine;
    wrapped.listEffectsRequiringReconciliation = () => [{ effectId: 'effect_1', jobId: admitted.jobId, attemptId: admitted.attemptId, generation: 1, kind: 'external', target: 'remote', retrySafety: 'unsafe', idempotencyKey: null, reconciliationData: null, effectState: 'unknown' }];
    expect(run({ engine: wrapped })).toMatchObject({ decision: 'blocked_unknown_effect', revalidation: { unknownEffectIds: ['effect_1'] } });
    expect(resume).not.toHaveBeenCalled();
  });
  it('D9 records repository drift and revalidates before continuing', () => expect(run({ currentRepositoryFingerprint: 'repo_2' })).toMatchObject({ decision: 'continued', revalidation: { repositoryDrift: true } }));
  it('D10 records environment drift and revalidates before continuing', () => expect(run({ currentEnvironmentFingerprint: 'env_2' })).toMatchObject({ decision: 'continued', revalidation: { environmentDrift: true } }));
  it('D11 never repeats a verified file effect', () => {
    db.prepare("UPDATE tasks SET files_touched=?, side_effects=? WHERE id=?").run(JSON.stringify(['done.txt']), JSON.stringify([{ tool: 'file_write', target: 'done.txt', verified: true }]), admitted.jobId);
    const result = run({ fileProbe: () => ({ exists: true }) });
    expect(result.resumePlan?.preamble).toContain('CONFIRMED (do not redo)');
  });
  it('D12 blocks an unverified mutation through the existing resume plan', () => {
    db.prepare("UPDATE tasks SET side_effects=? WHERE id=?").run(JSON.stringify([{ tool: 'send', target: 'remote', verified: false }]), admitted.jobId);
    expect(run()).toMatchObject({ decision: 'blocked_drift', resumePlan: { verdict: 'ask_user' } });
  });
  it('D13 blocks when a previously verified file has drifted', () => {
    db.prepare("UPDATE tasks SET files_touched=?, side_effects=? WHERE id=?").run(JSON.stringify(['done.txt']), JSON.stringify([{ tool: 'file_write', target: 'done.txt', verified: true }]), admitted.jobId);
    const result = run({ fileProbe: () => ({ exists: false }) });
    expect(result.resumePlan?.checks.some((check) => check.status === 'missing')).toBe(true);
  });
  it('D14 returns terminal truth without creating another Attempt', () => {
    db.prepare("UPDATE tasks SET status='cancelled', terminal_at=10, terminal_outcome='cancelled' WHERE id=?").run(admitted.jobId);
    expect(run()).toMatchObject({ decision: 'terminal' }); expect(resume).not.toHaveBeenCalled();
  });
  it('D15 rejects an adapter that reuses the stale Attempt', () => {
    resume.mockReturnValue({ attemptId: admitted.attemptId, generation: 1, runId: admitted.runId });
    expect(() => run()).toThrow(/new Attempt/i);
  });
  it('D16 fails closed when the durable Job card is unavailable', () => expect(() => run({ taskStore: { get: () => null } })).toThrow(/card/i));
  it('D17 preserves the checkpoint event cursor and never replays transcript text', () => {
    const checkpoint = createContinuityCheckpointAuthority({ db, engine }).get(checkpointId)!;
    run();
    expect(checkpoint.eventCursor).toBeGreaterThan(0);
    expect(Object.keys(resume.mock.calls[0][0])).not.toContain('messages');
  });
  it('D18 narrows the continuation context to durable decisions and revalidation checks', () => {
    run();
    const preamble = resume.mock.calls[0][0].preamble as string;
    expect(preamble).toContain('Original goal: continue safely');
    expect(preamble).toContain('NOT CHECKABLE');
  });
  it('D19 persists only the continuation receipt, not reconstructed context text', () => {
    run();
    const row = db.prepare('SELECT idempotency_key, result_json FROM continuity_actions WHERE checkpoint_id=?')
      .get(checkpointId) as { idempotency_key: string; result_json: string };
    expect(row.idempotency_key).toMatch(/^[a-f0-9]{64}$/);
    expect(row.result_json).not.toContain('Original goal');
    expect(JSON.parse(row.result_json)).not.toHaveProperty('resumePlan');
  });
  it('D20 refuses to continue work that is still active', () => {
    db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(admitted.jobId);
    expect(run()).toMatchObject({ decision: 'invalid', reason: expect.stringMatching(/only paused/i) });
    expect(resume).not.toHaveBeenCalled();
  });
  it('D21 rejects a resume adapter that fabricates a fresh Attempt identity', () => {
    resume.mockReturnValue({ attemptId: 'attempt_missing', generation: 2, runId: 999 });
    expect(() => run()).toThrow(/durable Attempt authority/i);
  });
  it('D22 records interrupted process state as lost rather than still running', () => {
    const result = run();
    expect(result.resumePlan?.checks).toContainEqual(expect.objectContaining({ kind: 'process', status: 'lost' }));
    expect(result.resumePlan?.preamble).toMatch(/processes.*gone/i);
  });
  it('D23 fails closed when the checkpoint Job has been removed', () => {
    db.prepare('DELETE FROM tasks WHERE id=?').run(admitted.jobId);
    expect(() => run()).toThrow(/missing|invalid|superseded/i);
    expect(resume).not.toHaveBeenCalled();
  });
  it('D24 bounds reconstructed continuation context', () => {
    db.prepare('UPDATE tasks SET goal=? WHERE id=?').run('x'.repeat(50_000), admitted.jobId);
    run();
    expect((resume.mock.calls[0][0].preamble as string).length).toBeLessThanOrEqual(16_000);
  });
});
