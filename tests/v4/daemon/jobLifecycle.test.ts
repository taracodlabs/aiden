/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import {
  createDurableJobLifecycleScope,
  DurableJobLifecycleDisposedError,
  executeDurableJob,
} from '../../../core/v4/daemon/jobLifecycle';
import { currentJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { createJobControlAuthority } from '../../../core/v4/daemon/jobControlAuthority';

describe('executeDurableJob', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('instance_lifecycle', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  it('creates, leases, starts, executes, and finalizes one Job and Attempt', async () => {
    let identityDuringWork: ReturnType<typeof currentJobExecutionContext>;
    const execution = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_lifecycle',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_1', requestFingerprint: 'fingerprint_1', goal: 'run work',
      },
      execute: async () => {
        identityDuringWork = currentJobExecutionContext();
        return { value: 42 };
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: { verified: true },
      }),
    });

    expect(identityDuringWork!).toMatchObject({
      jobId: execution.jobId,
      attemptId: execution.attemptId,
      generation: 1,
    });
    expect(engine.getJob(execution.jobId)).toMatchObject({ status: 'completed', activeAttemptId: null });
    expect(engine.getAttempt(execution.attemptId)?.status).toBe('succeeded');
    expect(engine.listEvents(execution.jobId).map((event) => event.type)).toEqual([
      'job.submitted', 'attempt.created', 'attempt.leased', 'attempt.running',
      'job.running', 'attempt.succeeded', 'job.finalized',
    ]);
    expect(engine.continuity?.getLatest(execution.jobId)).toMatchObject({
      jobId: execution.jobId,
      attemptId: execution.attemptId,
      attemptGeneration: 1,
      reason: 'lifecycle:cleanup',
      validity: 'current',
    });
  });

  it('detaches a host-owned approval wait and reattaches the same Attempt generation and fence', async () => {
    const lifecycleScope = createDurableJobLifecycleScope();
    const controls = createJobControlAuthority({ db, jobEngine: engine });
    let started!: () => void;
    const executing = new Promise<void>((resolve) => { started = resolve; });
    const first = (executeDurableJob as unknown as (options: Record<string, unknown>) => Promise<unknown>)({
      engine,
      ownerId: 'instance_lifecycle',
      lifecycleScope,
      detachOnDispose: () => true,
      controlAuthority: controls,
      initialInput: {
        sessionId: 'session_host_detach', source: 'automation', kind: 'message',
        content: 'write approved file', idempotencyNamespace: 'automation-input',
        idempotencyKey: 'approval_restart',
      },
      admission: {
        entryPoint: 'automation', source: 'automation', sessionId: 'session_host_detach',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'automation',
        idempotencyKey: 'approval_restart', requestFingerprint: 'approval_restart', goal: 'write approved file',
      },
      execute: async (handle: { signal: AbortSignal }) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          handle.signal.addEventListener('abort', () => reject(handle.signal.reason), { once: true });
        });
      },
      finalize: () => ({ status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {} }),
    });

    await executing;
    const before = engine.listJobs({ sessionId: 'session_host_detach' })[0]!;
    const beforeAttempt = engine.getAttempt(before.activeAttemptId!)!;
    await lifecycleScope.dispose('Workbench host shutdown');
    await expect(first).rejects.toMatchObject({ name: 'DurableJobHostDetachedError' });

    const detachedJob = engine.getJob(before.id)!;
    const detachedAttempt = engine.getAttempt(beforeAttempt.id)!;
    expect(detachedJob).toMatchObject({ status: 'waiting', activeAttemptId: beforeAttempt.id });
    expect(detachedAttempt).toMatchObject({
      status: 'waiting',
      generation: beforeAttempt.generation,
      fenceToken: beforeAttempt.fenceToken,
      leaseOwner: null,
    });

    const resumed = await (executeDurableJob as unknown as (options: Record<string, unknown>) => Promise<{
      jobId: string; attemptId: string; generation: number; fenceToken: string;
    }>)({
      engine,
      ownerId: 'instance_lifecycle',
      admission: {
        existing: {
          jobId: before.id,
          attemptId: beforeAttempt.id,
          runId: beforeAttempt.rowId,
          generation: beforeAttempt.generation,
          fenceToken: beforeAttempt.fenceToken,
          reused: true,
        },
        source: 'automation',
      },
      controlAuthority: controls,
      initialInput: {
        sessionId: 'session_host_detach', source: 'automation', kind: 'message',
        content: 'write approved file', idempotencyNamespace: 'automation-input',
        idempotencyKey: 'approval_restart',
      },
      execute: async () => 'approved once',
      finalize: () => ({ status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {} }),
    });

    expect(resumed).toMatchObject({
      jobId: before.id,
      attemptId: beforeAttempt.id,
      generation: beforeAttempt.generation,
      fenceToken: beforeAttempt.fenceToken,
    });
    expect(engine.getJob(before.id)?.status).toBe('completed');
    expect(engine.listAttempts(before.id)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM durable_inputs WHERE job_id = ? AND state = 'consumed'")
      .get(before.id)).toEqual({ count: 1 });
  });

  it('persists failure and never reports an unknown thrown operation as success', async () => {
    const result = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_lifecycle',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_failure', requestFingerprint: 'fingerprint_failure', goal: 'fail work',
      },
      execute: async () => { throw new Error('failure'); },
      finalize: () => ({ status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {} }),
    }).catch((error: Error & { jobId?: string; attemptId?: string }) => error);

    expect(result).toBeInstanceOf(Error);
    const job = engine.listJobs({ sessionId: 'session_lifecycle' })[0];
    expect(job.status).toBe('failed');
    expect(engine.getAttempt(job.activeAttemptId!)?.status ?? engine.listAttempts(job.id)[0]?.status).toBe('failed');
  });

  it('does not finalize completed while a required claim remains unknown', async () => {
    const execution = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_unknown_proof',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_unknown_proof', goal: 'verify required work',
      },
      execute: async (handle) => {
        engine.proof.createClaim({
          jobId: handle.jobId,
          attemptId: handle.attemptId,
          generation: handle.generation,
          category: 'contract',
          statement: 'required artifact exists',
          required: true,
        });
        return 'done';
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {},
      }),
    });

    expect(engine.proof.getVerdict(execution.jobId)?.verdict).toBe('unknown');
    expect(engine.getJob(execution.jobId)).toMatchObject({
      status: 'unknown',
      terminalOutcome: 'unknown',
      finishReason: 'verification_incomplete',
    });
    expect(engine.getAttempt(execution.attemptId)?.status).toBe('unknown');
  });

  it('projects failed required Proof into authoritative Job failure', async () => {
    const execution = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_failed_proof',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_failed_proof', goal: 'verify required work',
      },
      execute: async (handle) => {
        const claim = engine.proof.createClaim({
          jobId: handle.jobId,
          attemptId: handle.attemptId,
          generation: handle.generation,
          category: 'contract',
          statement: 'required result is correct',
          required: true,
        });
        const evidence = engine.proof.recordEvidence({
          jobId: handle.jobId,
          attemptId: handle.attemptId,
          generation: handle.generation,
          fenceToken: handle.fenceToken,
          source: 'test',
          producer: 'test',
          observedAt: Date.now(),
          coverage: 'full',
          verificationResult: 'failed',
          payload: { actual: 'wrong' },
        });
        engine.proof.checkClaim({
          claimId: claim.claimId,
          attemptId: handle.attemptId,
          generation: handle.generation,
          evidenceIds: [evidence.evidenceId],
          state: 'failed',
        });
        return 'done';
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {},
      }),
    });

    expect(engine.proof.getVerdict(execution.jobId)?.verdict).toBe('failed');
    expect(engine.getJob(execution.jobId)).toMatchObject({
      status: 'failed',
      terminalOutcome: 'failed',
      finishReason: 'verification_failed',
    });
    expect(engine.getAttempt(execution.attemptId)?.status).toBe('failed');
  });

  it('aborts active work when lease renewal loses authority', async () => {
    let sawAbort = false;
    const authorityLosingEngine: JobEngine = {
      ...engine,
      renewAttemptLease: () => ({ applied: false, conflict: 'stale_fence' }),
    };
    const execution = executeDurableJob({
      engine: authorityLosingEngine,
      ownerId: 'instance_lifecycle',
      leaseTtlMs: 3_000,
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_lease_loss',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_lease_loss', requestFingerprint: 'fingerprint_lease_loss', goal: 'wait',
      },
      execute: async (handle) => new Promise<{ value: number }>((resolve) => {
        handle.signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve({ value: 0 });
        }, { once: true });
      }),
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {},
      }),
    });
    await expect(execution).rejects.toThrow(/lease renewal failed/i);
    expect(sawAbort).toBe(true);
    const job = engine.listJobs({ sessionId: 'session_lease_loss' })[0]!;
    expect(engine.getJob(job.id)?.status).toBe('running');
    expect(engine.getAttempt(job.activeAttemptId!)?.status).toBe('running');
  });

  it('expires a durable runtime budget while execution is waiting and records actual elapsed use', async () => {
    let intentPersisted = false;
    let persistedBeforeAbort = false;
    const interruption = vi.spyOn(engine.workerProviderCalls, 'recordInterruptionForAttempt')
      .mockImplementation(() => {
        intentPersisted = true;
        return [];
      });
    const execution = executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_runtime_budget',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_runtime_budget', requestFingerprint: 'fingerprint_runtime_budget',
        goal: 'wait beyond budget', resourcePolicy: { budgets: { runtime_ms: 5 } },
      },
      execute: async (handle) => new Promise<string>((resolve) => {
        handle.signal.addEventListener('abort', () => {
          persistedBeforeAbort = intentPersisted;
          resolve('aborted');
        }, { once: true });
      }),
      finalize: () => ({ status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {} }),
    });

    await expect(execution).rejects.toThrow(/runtime_ms/);
    const job = engine.listJobs({ sessionId: 'session_runtime_budget' })[0]!;
    expect(job.status).toBe('failed');
    expect(engine.resources.getBudgets(job.id)).toMatchObject([
      { kind: 'runtime_ms', limit: 5, hasUnknownUsage: false },
    ]);
    expect(engine.resources.getBudgets(job.id)[0]!.used).toBeGreaterThanOrEqual(5);
    expect(interruption).toHaveBeenCalledWith(expect.objectContaining({
      childJobId: job.id,
      kind: 'timeout',
      reason: 'runtime_budget_exceeded',
    }));
    expect(persistedBeforeAbort).toBe(true);
  });

  it('adopts an already admitted Job without creating a parallel lifecycle', async () => {
    const admitted = engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'session_adopted',
      instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
      idempotencyKey: 'request_adopted', requestFingerprint: 'fingerprint_adopted', goal: 'adopt work',
    });

    const execution = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      admission: { existing: admitted, source: 'test' },
      execute: async () => 'done',
      finalize: async () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: { verified: true },
      }),
    });

    expect(execution).toMatchObject({
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      runId: admitted.runId,
    });
    expect(engine.listJobs({ sessionId: 'session_adopted' })).toHaveLength(1);
    expect(engine.listAttempts(admitted.jobId)).toHaveLength(1);
    expect(engine.listEvents(admitted.jobId).map((event) => event.type)).toEqual([
      'job.submitted', 'attempt.created', 'attempt.leased', 'attempt.running',
      'job.running', 'attempt.succeeded', 'job.finalized',
    ]);
  });

  it('persists and consumes initial input under the exact claimed Attempt', async () => {
    const controlAuthority = createJobControlAuthority({ db, jobEngine: engine });
    let inputObservedDuringExecution: string | null = null;

    const execution = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      controlAuthority,
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_input',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_input', requestFingerprint: 'fingerprint_input', goal: 'consume input',
      },
      initialInput: {
        sessionId: 'session_input', source: 'test', kind: 'message', content: 'durable request',
        idempotencyNamespace: 'lifecycle-input', idempotencyKey: 'request_input',
      },
      execute: async (handle) => {
        inputObservedDuringExecution = handle.initialInput?.content ?? null;
        expect(handle.initialInput).toMatchObject({
          jobId: handle.jobId,
          claimedByAttemptId: handle.attemptId,
          claimedGeneration: handle.generation,
          state: 'consumed',
        });
        return 'done';
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: { verified: true },
      }),
    });

    expect(inputObservedDuringExecution).toBe('durable request');
    expect(controlAuthority.inputs.listPending(execution.jobId)).toEqual([]);
    expect(engine.listEvents(execution.jobId).map((event) => event.type)).toContain('input.consumed');
  });

  it('adopts a previously queued Job and consumes its existing input exactly once', async () => {
    const controlAuthority = createJobControlAuthority({ db, jobEngine: engine });
    const admitted = engine.submitJob({
      entryPoint: 'interactive', source: 'repl', sessionId: 'session_queued',
      instanceId: 'instance_lifecycle', idempotencyNamespace: 'queued-turn',
      idempotencyKey: 'queued-job', requestFingerprint: 'queued-fingerprint', goal: 'queued work',
    });
    const received = controlAuthority.inputs.receive({
      jobId: admitted.jobId,
      targetAttemptId: admitted.attemptId,
      sessionId: 'session_queued',
      source: 'tui',
      kind: 'message',
      content: 'queued durable request',
      idempotencyNamespace: 'queued-input',
      idempotencyKey: 'queued-message',
    });
    const restoredControls = createJobControlAuthority({ db, jobEngine: createJobEngine({ db }) });

    const execution = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      controlAuthority: restoredControls,
      admission: { existing: admitted, source: 'repl' },
      existingInitialInputId: received.record.inputId,
      execute: async (handle) => {
        expect(handle.initialInput).toMatchObject({
          inputId: received.record.inputId,
          jobId: admitted.jobId,
          claimedByAttemptId: admitted.attemptId,
          claimedGeneration: 1,
          state: 'consumed',
          content: 'queued durable request',
        });
        return 'done';
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: { verified: true },
      }),
    });

    expect(execution.initialInput?.inputId).toBe(received.record.inputId);
    expect(restoredControls.inputs.listPending(admitted.jobId)).toEqual([]);
    expect(engine.listJobs({ sessionId: 'session_queued' })).toHaveLength(1);
    expect(engine.listEvents(admitted.jobId).filter((event) => event.type === 'input.consumed')).toHaveLength(1);
    expect(restoredControls.inputs.consume({
      inputId: received.record.inputId,
      attemptId: admitted.attemptId,
      generation: 1,
    })).toMatchObject({ applied: false, duplicate: true });
  });

  it('attaches cancellation to the active Attempt and detaches exactly once on cleanup', async () => {
    const controlAuthority = createJobControlAuthority({ db, jobEngine: engine });
    let handleDuringExecution: { jobId: string; attemptId: string; generation: number } | null = null;
    let sawAbort = false;

    const running = executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      controlAuthority,
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_cancel',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_cancel', requestFingerprint: 'fingerprint_cancel', goal: 'cancel work',
      },
      execute: async (handle) => {
        handleDuringExecution = handle;
        expect(controlAuthority.runtime.isAttached(handle.attemptId)).toBe(true);
        await new Promise<void>((_resolve, reject) => {
          handle.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(handle.signal.reason);
          }, { once: true });
        });
        return 'unreachable';
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {},
      }),
    });

    while (!handleDuringExecution) await new Promise((resolve) => setTimeout(resolve, 0));
    const active = handleDuringExecution as { jobId: string; attemptId: string; generation: number };
    const cancelled = controlAuthority.commands.request({
      jobId: active.jobId,
      attemptId: active.attemptId,
      generation: active.generation,
      kind: 'cancel',
      source: 'test',
      reason: 'test cancellation',
      idempotencyNamespace: 'lifecycle-control',
      idempotencyKey: 'cancel_active',
    });

    expect(cancelled).toMatchObject({ persisted: true, applied: true });
    expect(engine.getJob(active.jobId)?.status).toBe('cancelling');
    expect(engine.getAttempt(active.attemptId)?.status).toBe('running');
    await expect(running).rejects.toBeTruthy();
    expect(sawAbort).toBe(true);
    expect(engine.getJob(active.jobId)?.status).toBe('cancelled');
    expect(controlAuthority.runtime.isAttached(active.attemptId)).toBe(false);
  });

  it('settles cancellation as unknown when physical process cleanup cannot be verified', async () => {
    const controlAuthority = createJobControlAuthority({ db, jobEngine: engine });
    let active: { jobId: string; attemptId: string; generation: number } | null = null;
    const running = executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      controlAuthority,
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_cancel_unverified',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_cancel_unverified', goal: 'cancel unsafe process',
      },
      execute: async (handle) => {
        active = handle;
        await new Promise<void>((_resolve, reject) => {
          handle.signal.addEventListener('abort', () => {
            const error = new Error('physical cleanup unverified');
            error.name = 'PhysicalCancellationUnverifiedError';
            reject(error);
          }, { once: true });
        });
        return 'unreachable';
      },
      finalize: () => ({ status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {} }),
    });

    while (!active) await new Promise((resolve) => setTimeout(resolve, 0));
    const identity = active as { jobId: string; attemptId: string; generation: number };
    expect(controlAuthority.commands.request({
      jobId: identity.jobId,
      attemptId: identity.attemptId,
      generation: identity.generation,
      kind: 'cancel',
      source: 'test',
      idempotencyNamespace: 'lifecycle-control',
      idempotencyKey: 'cancel-unverified',
    })).toMatchObject({ persisted: true, applied: true });

    await expect(running).rejects.toMatchObject({ name: 'PhysicalCancellationUnverifiedError' });
    expect(engine.getJob(identity.jobId)).toMatchObject({
      status: 'unknown', terminalOutcome: 'cancellation_cleanup_unverified',
      finishReason: 'Physical process cleanup could not be verified',
    });
    expect(engine.getAttempt(identity.attemptId)?.status).toBe('unknown');
  });

  it('disposes and drains a running lifecycle before durable storage closes', async () => {
    const scope = createDurableJobLifecycleScope();
    let enteredExecution = false;
    let readsAfterDisposal = 0;
    const scopedEngine: JobEngine = {
      ...engine,
      getJob(jobId) {
        if (scope.disposed) readsAfterDisposal += 1;
        return engine.getJob(jobId);
      },
    };

    const running = executeDurableJob({
      engine: scopedEngine,
      lifecycleScope: scope,
      ownerId: 'instance_lifecycle',
      controlPollMs: 25,
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_dispose',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_dispose', requestFingerprint: 'fingerprint_dispose', goal: 'dispose work',
      },
      execute: async (handle) => {
        enteredExecution = true;
        await new Promise<void>((_resolve, reject) => {
          handle.signal.addEventListener('abort', () => reject(handle.signal.reason), { once: true });
        });
        return 'unreachable';
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {},
      }),
    });

    while (!enteredExecution) await new Promise((resolve) => setTimeout(resolve, 0));
    await scope.dispose('test shutdown');
    await expect(running).rejects.toBeInstanceOf(DurableJobLifecycleDisposedError);

    expect(scope.activeCount).toBe(0);
    expect(readsAfterDisposal).toBe(0);
    expect(engine.listJobs({ sessionId: 'session_dispose' })[0]?.status).toBe('cancelled');

    db.close();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(readsAfterDisposal).toBe(0);
    db = new Database(':memory:');
  });

  it('makes lifecycle disposal idempotent and fences late admission', async () => {
    const scope = createDurableJobLifecycleScope();

    await scope.dispose('first shutdown');
    await scope.dispose('second shutdown');

    expect(scope.activeCount).toBe(0);
    await expect(executeDurableJob({
      engine,
      lifecycleScope: scope,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_late',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_late', requestFingerprint: 'fingerprint_late', goal: 'late work',
      },
      execute: async () => 'unreachable',
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {},
      }),
    })).rejects.toBeInstanceOf(DurableJobLifecycleDisposedError);
    expect(engine.listJobs({ sessionId: 'session_late' })).toEqual([]);
  });

  it('releases lifecycle ownership after an execution error', async () => {
    const scope = createDurableJobLifecycleScope();

    await expect(executeDurableJob({
      engine,
      lifecycleScope: scope,
      ownerId: 'instance_lifecycle',
      controlPollMs: 25,
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_error_cleanup',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_error_cleanup', requestFingerprint: 'fingerprint_error_cleanup', goal: 'fail safely',
      },
      execute: async () => { throw new Error('expected execution failure'); },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: {},
      }),
    })).rejects.toThrow('expected execution failure');

    expect(scope.activeCount).toBe(0);
    await scope.dispose('post-error shutdown');
    expect(scope.activeCount).toBe(0);
    expect(engine.listJobs({ sessionId: 'session_error_cleanup' })[0]?.status).toBe('failed');
  });

  it('emits one ordered phase trace and finalizes once', async () => {
    const phases: string[] = [];
    let finalizations = 0;
    const instrumentedEngine: JobEngine = {
      ...engine,
      finalizeJob(command) {
        finalizations += 1;
        return engine.finalizeJob(command);
      },
    };

    await executeDurableJob({
      engine: instrumentedEngine,
      ownerId: 'instance_lifecycle',
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_phases',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_phases', requestFingerprint: 'fingerprint_phases', goal: 'trace work',
      },
      onPhase: (event) => phases.push(event.phase),
      execute: async () => 'done',
      finalize: async () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: { verified: true },
      }),
    });

    expect(phases).toEqual([
      'admitted', 'leased', 'running', 'executing', 'verifying', 'settled', 'cleanup',
    ]);
    expect(finalizations).toBe(1);
  });

  it('rebinds one active execution to a resumed Attempt with a new generation and fence', async () => {
    const controlAuthority = createJobControlAuthority({ db, jobEngine: engine });
    let firstAttemptId = '';
    let resumedAttemptId = '';

    const execution = await executeDurableJob({
      engine,
      ownerId: 'instance_lifecycle',
      controlAuthority,
      admission: {
        entryPoint: 'test', source: 'test', sessionId: 'session_resume',
        instanceId: 'instance_lifecycle', idempotencyNamespace: 'lifecycle',
        idempotencyKey: 'request_resume', requestFingerprint: 'fingerprint_resume', goal: 'resume work',
      },
      execute: async (handle) => {
        firstAttemptId = handle.attemptId;
        controlAuthority.commands.request({
          jobId: handle.jobId,
          attemptId: handle.attemptId,
          generation: handle.generation,
          kind: 'pause',
          source: 'test',
          idempotencyNamespace: 'lifecycle-control',
          idempotencyKey: 'pause-active',
        });
        expect(controlAuthority.commands.applyPendingAtBoundary({ jobId: handle.jobId })).toMatchObject({
          applied: true,
          kind: 'pause',
        });
        handle.pauseAtBoundary();

        const resumed = controlAuthority.commands.resume({
          jobId: handle.jobId,
          source: 'test',
          instanceId: 'instance_lifecycle',
          idempotencyNamespace: 'lifecycle-control',
          idempotencyKey: 'resume-active',
        });
        handle.resumeAttempt({
          jobId: handle.jobId,
          attemptId: resumed.attemptId,
          runId: resumed.runId,
          reused: resumed.duplicate,
        });
        resumedAttemptId = handle.attemptId;
        expect(handle.generation).toBe(2);
        expect(currentJobExecutionContext()).toMatchObject({
          attemptId: resumed.attemptId,
          generation: 2,
          fenceToken: handle.fenceToken,
        });
        return 'done';
      },
      finalize: () => ({
        status: 'completed', outcome: 'completed', finishReason: 'stop', evidence: { verified: true },
      }),
    });

    expect(execution.attemptId).toBe(resumedAttemptId);
    expect(firstAttemptId).not.toBe(resumedAttemptId);
    expect(engine.getAttempt(firstAttemptId)?.status).toBe('cancelled');
    expect(engine.getAttempt(resumedAttemptId)?.status).toBe('succeeded');
    expect(engine.getJob(execution.jobId)?.status).toBe('completed');
  });
});
