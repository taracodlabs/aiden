/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { runWithJobExecutionContext } from './jobExecutionContext';
import type { JobEngine, SubmitJobCommand } from './jobEngine';

export interface DurableJobHandle {
  jobId: string;
  attemptId: string;
  runId: number;
  generation: number;
  fenceToken: string;
  signal: AbortSignal;
}

export interface DurableJobFinalization {
  status: 'completed' | 'failed' | 'cancelled';
  outcome: string;
  finishReason: string;
  evidence: unknown;
  jobCard?: {
    filesTouched?: string[];
    sideEffects?: unknown[];
    failureState?: unknown | null;
    permissions?: Record<string, unknown> | null;
    constraints?: Record<string, unknown> | null;
  };
}

export interface DurableJobExecutionResult<T> extends DurableJobHandle {
  value: T;
}

export class DurableJobLifecycleError extends Error {
  constructor(message: string, readonly handle?: Partial<DurableJobHandle>) {
    super(message);
    this.name = 'DurableJobLifecycleError';
  }
}

export async function executeDurableJob<T>(options: {
  engine: JobEngine;
  ownerId: string;
  admission: SubmitJobCommand;
  execute: (handle: DurableJobHandle) => Promise<T>;
  finalize: (value: T) => DurableJobFinalization;
  leaseTtlMs?: number;
  onLeaseLost?: (error: DurableJobLifecycleError) => void;
}): Promise<DurableJobExecutionResult<T>> {
  const admitted = options.engine.submitJob(options.admission);
  const leaseTtlMs = Math.max(3_000, options.leaseTtlMs ?? 45_000);
  const lease = options.engine.claimAttempt({
    attemptId: admitted.attemptId,
    ownerId: options.ownerId,
    ttlMs: leaseTtlMs,
  });
  if (!lease.acquired || !lease.fenceToken || lease.generation === undefined || lease.stateVersion === undefined) {
    throw new DurableJobLifecycleError(
      `Durable Attempt lease unavailable: ${lease.conflict ?? 'unknown'}`,
      admitted,
    );
  }
  const leaseAbort = new AbortController();
  const handle: DurableJobHandle = {
    jobId: admitted.jobId,
    attemptId: admitted.attemptId,
    runId: admitted.runId,
    generation: lease.generation,
    fenceToken: lease.fenceToken,
    signal: leaseAbort.signal,
  };
  let attemptStateVersion = lease.stateVersion;
  let jobStateVersion = options.engine.getJob(handle.jobId)?.stateVersion ?? 0;
  const attemptStarted = options.engine.transitionAttempt({
    attemptId: handle.attemptId,
    expectedStateVersion: attemptStateVersion,
    generation: handle.generation,
    fenceToken: handle.fenceToken,
    to: 'running',
    eventIdempotencyKey: `attempt-running:${handle.attemptId}:${handle.generation}`,
    producer: options.admission.source,
  });
  if (!attemptStarted.applied || attemptStarted.stateVersion === undefined) {
    throw new DurableJobLifecycleError(
      `Durable Attempt start rejected: ${attemptStarted.conflict ?? 'unknown'}`,
      handle,
    );
  }
  attemptStateVersion = attemptStarted.stateVersion;
  const jobStarted = options.engine.transitionJob({
    jobId: handle.jobId,
    attemptId: handle.attemptId,
    generation: handle.generation,
    fenceToken: handle.fenceToken,
    expectedStateVersion: jobStateVersion,
    to: 'running',
    eventIdempotencyKey: `job-running:${handle.jobId}:${handle.generation}`,
    producer: options.admission.source,
  });
  if (!jobStarted.applied || jobStarted.stateVersion === undefined) {
    throw new DurableJobLifecycleError(
      `Durable Job start rejected: ${jobStarted.conflict ?? 'unknown'}`,
      handle,
    );
  }
  jobStateVersion = jobStarted.stateVersion;

  let leaseLost: DurableJobLifecycleError | null = null;
  const heartbeat = setInterval(() => {
    const renewed = options.engine.renewAttemptLease({
      attemptId: handle.attemptId,
      ownerId: options.ownerId,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      ttlMs: leaseTtlMs,
    });
    if (!renewed.applied || renewed.stateVersion === undefined) {
      clearInterval(heartbeat);
      leaseLost = new DurableJobLifecycleError(
        `Durable Attempt lease renewal failed: ${renewed.conflict ?? 'unknown'}`,
        handle,
      );
      leaseAbort.abort(leaseLost);
      options.onLeaseLost?.(leaseLost);
      return;
    }
    attemptStateVersion = renewed.stateVersion;
  }, Math.max(1_000, Math.floor(leaseTtlMs / 3)));
  heartbeat.unref?.();

  try {
    const value = await runWithJobExecutionContext({
      engine: options.engine,
      jobId: handle.jobId,
      attemptId: handle.attemptId,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      producer: options.admission.source,
    }, () => options.execute(handle));
    if (leaseLost) throw leaseLost;

    const finalization = options.finalize(value);
    const attemptStatus = finalization.status === 'completed'
      ? 'succeeded'
      : finalization.status === 'cancelled' ? 'cancelled' : 'failed';
    const attemptFinished = options.engine.transitionAttempt({
      attemptId: handle.attemptId,
      expectedStateVersion: attemptStateVersion,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      to: attemptStatus,
      eventIdempotencyKey: `attempt-${attemptStatus}:${handle.attemptId}:${handle.generation}`,
      producer: options.admission.source,
      finishReason: finalization.finishReason,
    });
    if (!attemptFinished.applied) {
      throw new DurableJobLifecycleError(
        `Durable Attempt finalization rejected: ${attemptFinished.conflict ?? 'unknown'}`,
        handle,
      );
    }
    const jobFinished = options.engine.finalizeJob({
      jobId: handle.jobId,
      attemptId: handle.attemptId,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      expectedStateVersion: jobStateVersion,
      status: finalization.status,
      outcome: finalization.outcome,
      finishReason: finalization.finishReason,
      evidence: finalization.evidence,
      jobCard: finalization.jobCard,
      eventIdempotencyKey: `job-finalized:${handle.jobId}:${handle.generation}`,
      producer: options.admission.source,
    });
    if (!jobFinished.applied) {
      throw new DurableJobLifecycleError(
        `Durable Job finalization rejected: ${jobFinished.conflict ?? 'unknown'}`,
        handle,
      );
    }
    return { ...handle, value };
  } catch (error) {
    if (!options.engine.getAttempt(handle.attemptId)?.status.match(/^(succeeded|failed|cancelled|timed_out|crashed|unknown)$/)) {
      const attemptFailed = options.engine.transitionAttempt({
        attemptId: handle.attemptId,
        expectedStateVersion: attemptStateVersion,
        generation: handle.generation,
        fenceToken: handle.fenceToken,
        to: 'failed',
        eventIdempotencyKey: `attempt-failed:${handle.attemptId}:${handle.generation}`,
        producer: options.admission.source,
        finishReason: 'error',
      });
      if (attemptFailed.applied) {
        options.engine.finalizeJob({
          jobId: handle.jobId,
          attemptId: handle.attemptId,
          generation: handle.generation,
          fenceToken: handle.fenceToken,
          expectedStateVersion: jobStateVersion,
          status: 'failed',
          outcome: 'failed',
          finishReason: 'error',
          evidence: { errorClass: error instanceof Error ? error.name : 'Error' },
          eventIdempotencyKey: `job-finalized:${handle.jobId}:${handle.generation}`,
          producer: options.admission.source,
        });
      }
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
