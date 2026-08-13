/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { runWithJobExecutionContext, type JobExecutionContext } from './jobExecutionContext';
import type { ContinuityCheckpointAuthority } from '../continuityCheckpoint';
import type {
  AdmissionResult,
  AttemptRecord,
  JobEngine,
  JobRecord,
  SubmitJobCommand,
} from './jobEngine';
import type {
  DurableInputRecord,
  JobControlAuthority,
  ReceiveInputCommand,
} from './jobControlAuthority';

export interface DurableJobHandle {
  jobId: string;
  attemptId: string;
  runId: number;
  generation: number;
  fenceToken: string;
  signal: AbortSignal;
  initialInput?: DurableInputRecord;
  pauseAtBoundary(): void;
  resumeAttempt(admission: AdmissionResult): void;
}

export interface DurableJobFinalization {
  status: 'completed' | 'failed' | 'cancelled';
  attemptStatus?: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';
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

export interface DurableJobUncertainDisposition {
  status: 'unknown' | 'blocked';
  outcome: string;
  finishReason: string;
  evidence: unknown;
}

export type DurableJobDisposition = DurableJobFinalization | DurableJobUncertainDisposition;

export interface ExistingDurableJobAdmission {
  existing: AdmissionResult;
  source: string;
}

export interface RecoveryDurableJobAdmission {
  recovery: Parameters<JobEngine['createRecoveryAttempt']>[0];
  source: string;
}

export type DurableJobAdmission =
  | SubmitJobCommand
  | ExistingDurableJobAdmission
  | RecoveryDurableJobAdmission;

export type DurableJobLifecyclePhase =
  | 'admitted'
  | 'leased'
  | 'running'
  | 'executing'
  | 'verifying'
  | 'settled'
  | 'cleanup';

export interface DurableJobLifecyclePhaseEvent {
  phase: DurableJobLifecyclePhase;
  jobId: string;
  attemptId: string;
  runId: number;
  generation?: number;
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

export class DurableJobDuplicateAdmissionError extends DurableJobLifecycleError {
  constructor(readonly admission: AdmissionResult) {
    super('Durable Job admission already exists', admission);
    this.name = 'DurableJobDuplicateAdmissionError';
  }
}

export class DurableJobAuthorityLostError extends DurableJobLifecycleError {
  constructor(message: string, handle?: Partial<DurableJobHandle>) {
    super(message, handle);
    this.name = 'DurableJobAuthorityLostError';
  }
}

export class DurableJobBudgetExceededError extends DurableJobLifecycleError {
  constructor(readonly budgetKind: string, handle?: Partial<DurableJobHandle>) {
    super(`Durable Job budget exhausted: ${budgetKind}`, handle);
    this.name = 'DurableJobBudgetExceededError';
  }
}

export class DurableJobLifecycleDisposedError extends DurableJobLifecycleError {
  constructor(message = 'Durable lifecycle scope was disposed', handle?: Partial<DurableJobHandle>) {
    super(message, handle);
    this.name = 'DurableJobLifecycleDisposedError';
  }
}

interface DurableJobLifecycleRegistration {
  dispose(reason: string): void;
  done: Promise<void>;
}

class DurableJobLifecycleDisposalError extends Error {
  constructor(readonly causes: unknown[]) {
    super('Durable lifecycle disposal failed');
    this.name = 'DurableJobLifecycleDisposalError';
  }
}

export class DurableJobLifecycleScope {
  private readonly registrations = new Set<DurableJobLifecycleRegistration>();
  private disposal: Promise<void> | null = null;
  private disposedState = false;

  get disposed(): boolean {
    return this.disposedState;
  }

  get activeCount(): number {
    return this.registrations.size;
  }

  assertActive(): void {
    if (this.disposedState) throw new DurableJobLifecycleDisposedError();
  }

  register(registration: DurableJobLifecycleRegistration): () => void {
    this.assertActive();
    this.registrations.add(registration);
    return () => this.registrations.delete(registration);
  }

  dispose(reason = 'Durable lifecycle scope disposed'): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposedState = true;
    const registrations = [...this.registrations];
    const disposalErrors: unknown[] = [];
    for (const registration of registrations) {
      try {
        registration.dispose(reason);
      } catch (error) {
        disposalErrors.push(error);
      }
    }
    this.disposal = Promise.allSettled(registrations.map((registration) => registration.done)).then(() => {
      if (disposalErrors.length === 1) throw disposalErrors[0];
      if (disposalErrors.length > 1) throw new DurableJobLifecycleDisposalError(disposalErrors);
    });
    return this.disposal;
  }
}

export function createDurableJobLifecycleScope(): DurableJobLifecycleScope {
  return new DurableJobLifecycleScope();
}

export interface ExecuteDurableJobOptions<T> {
  engine: JobEngine;
  ownerId: string;
  admission: DurableJobAdmission;
  execute: (handle: DurableJobHandle) => Promise<T>;
  finalize: (value: T, handle: DurableJobHandle) => DurableJobDisposition | Promise<DurableJobDisposition>;
  classifyError?: (
    error: unknown,
    handle: DurableJobHandle,
  ) => DurableJobDisposition | null | Promise<DurableJobDisposition | null>;
  controlAuthority?: JobControlAuthority;
  initialInput?: Omit<ReceiveInputCommand, 'jobId' | 'targetAttemptId' | 'targetGeneration'>;
  existingInitialInputId?: string;
  leaseTtlMs?: number;
  controlPollMs?: number;
  onLeaseLost?: (error: DurableJobLifecycleError) => void;
  onPhase?: (event: DurableJobLifecyclePhaseEvent) => void;
  lifecycleScope?: DurableJobLifecycleScope;
  /** Optional durable continuity projection. It records references at lifecycle
   * boundaries and never participates in Job/Attempt transitions. */
  continuity?: Pick<ContinuityCheckpointAuthority, 'capture'>;
}

function isExistingAdmission(admission: DurableJobAdmission): admission is ExistingDurableJobAdmission {
  return 'existing' in admission;
}

function isRecoveryAdmission(admission: DurableJobAdmission): admission is RecoveryDurableJobAdmission {
  return 'recovery' in admission;
}

function producerFor(admission: DurableJobAdmission): string {
  return admission.source;
}

export function admitDurableJob(engine: JobEngine, admission: DurableJobAdmission): AdmissionResult {
  if (isRecoveryAdmission(admission)) {
    return {
      ...engine.createRecoveryAttempt(admission.recovery),
      jobId: admission.recovery.jobId,
      reused: false,
    };
  }
  if (!isExistingAdmission(admission)) return engine.submitJob(admission);
  const { existing } = admission;
  const job = engine.getJob(existing.jobId);
  const attempt = engine.getAttempt(existing.attemptId);
  if (!job || !attempt || attempt.jobId !== job.id || attempt.rowId !== existing.runId) {
    throw new DurableJobLifecycleError('Existing durable admission does not identify one Job and Attempt', existing);
  }
  if (job.activeAttemptId !== attempt.id) {
    throw new DurableJobLifecycleError('Existing durable admission is not the active Attempt', existing);
  }
  return existing;
}

function isAttemptTerminal(attempt: AttemptRecord | null): boolean {
  return attempt !== null && /^(succeeded|completed|failed|cancelled|timed_out|crashed|unknown|interrupted)$/.test(attempt.status);
}

function isJobTerminal(job: JobRecord | null): boolean {
  return job !== null && /^(cancelled|completed|failed|dead_letter|completed_unverified|verification_failed|abandoned)$/.test(job.status);
}

function applyRequiredProof(
  engine: JobEngine,
  handle: DurableJobHandle,
  finalization: DurableJobDisposition,
): DurableJobDisposition {
  if (!engine.proof.hasRequiredClaims(handle.jobId)) return finalization;
  const proof = engine.proof.getVerdict(handle.jobId) ?? engine.proof.finalize({
    jobId: handle.jobId,
    attemptId: handle.attemptId,
    generation: handle.generation,
    fenceToken: handle.fenceToken,
    cancelled: finalization.status === 'cancelled',
  });
  if (finalization.status !== 'completed' || proof.verdict === 'verified') return finalization;
  const evidence = engine.proof.exportJson(handle.jobId);
  if (proof.verdict === 'failed') {
    return {
      status: 'failed',
      attemptStatus: 'failed',
      outcome: 'failed',
      finishReason: 'verification_failed',
      evidence,
      ...('jobCard' in finalization && finalization.jobCard ? { jobCard: finalization.jobCard } : {}),
    };
  }
  if (proof.verdict === 'cancelled') {
    return {
      status: 'cancelled',
      attemptStatus: 'cancelled',
      outcome: 'cancelled',
      finishReason: 'interrupted',
      evidence,
    };
  }
  return {
    status: 'unknown',
    outcome: proof.verdict,
    finishReason: 'verification_incomplete',
    evidence,
  };
}

function assertAuthority(engine: JobEngine, handle: DurableJobHandle): { attempt: AttemptRecord; job: JobRecord } {
  const attempt = engine.getAttempt(handle.attemptId);
  const job = engine.getJob(handle.jobId);
  if (
    !attempt
    || !job
    || attempt.jobId !== handle.jobId
    || attempt.generation !== handle.generation
    || attempt.fenceToken !== handle.fenceToken
    || attempt.leaseOwner === null
    || job.activeAttemptId !== handle.attemptId
    || isAttemptTerminal(attempt)
    || isJobTerminal(job)
  ) {
    throw new DurableJobAuthorityLostError('Durable lifecycle authority was lost before settlement', handle);
  }
  return { attempt, job };
}

function notifyPhase(
  options: Pick<ExecuteDurableJobOptions<unknown>, 'onPhase' | 'continuity' | 'engine'>,
  phase: DurableJobLifecyclePhase,
  identity: Pick<AdmissionResult, 'jobId' | 'attemptId' | 'runId'>,
  generation?: number,
): void {
  options.onPhase?.({
    phase,
    jobId: identity.jobId,
    attemptId: identity.attemptId,
    runId: identity.runId,
    generation,
  });
  const continuity = options.continuity ?? options.engine.continuity;
  if (continuity) {
    const attempt = options.engine.getAttempt(identity.attemptId);
    if (attempt) {
      continuity.capture({
        jobId: identity.jobId,
        attemptId: identity.attemptId,
        attemptGeneration: generation ?? attempt.generation,
        reason: `lifecycle:${phase}`,
        idempotencyNamespace: 'durable-lifecycle',
        idempotencyKey: `${phase}:${identity.attemptId}:${generation ?? attempt.generation}`,
      });
    }
  }
}

export async function executeDurableJob<T>(
  options: ExecuteDurableJobOptions<T>,
): Promise<DurableJobExecutionResult<T>> {
  options.lifecycleScope?.assertActive();
  const producer = producerFor(options.admission);
  const admitted = admitDurableJob(options.engine, options.admission);
  notifyPhase(options, 'admitted', admitted);
  if (!isExistingAdmission(options.admission) && !isRecoveryAdmission(options.admission) && admitted.reused) {
    throw new DurableJobDuplicateAdmissionError(admitted);
  }

  if (options.initialInput && options.existingInitialInputId) {
    throw new DurableJobLifecycleError('Durable initial input must be new or existing, not both', admitted);
  }
  if ((options.initialInput || options.existingInitialInputId) && !options.controlAuthority) {
    throw new DurableJobLifecycleError('Durable initial input requires JobControlAuthority', admitted);
  }

  const receivedInput = options.initialInput
    ? options.controlAuthority?.inputs.receive({
      ...options.initialInput,
      jobId: admitted.jobId,
      targetAttemptId: admitted.attemptId,
    })
    : null;
  const initialInput = receivedInput?.record
    ?? (options.existingInitialInputId
      ? options.controlAuthority?.inputs.get(options.existingInitialInputId) ?? null
      : null);
  if (options.existingInitialInputId && (
    !initialInput
    || initialInput.jobId !== admitted.jobId
    || (initialInput.targetAttemptId !== null && initialInput.targetAttemptId !== admitted.attemptId)
    || !['queued', 'claimed'].includes(initialInput.state)
  )) {
    throw new DurableJobLifecycleError('Existing durable initial input does not match the admitted Job', admitted);
  }

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
  notifyPhase(options, 'leased', admitted, lease.generation);

  const leaseAbort = new AbortController();
  const handle = {
    jobId: admitted.jobId,
    attemptId: admitted.attemptId,
    runId: admitted.runId,
    generation: lease.generation,
    fenceToken: lease.fenceToken,
    signal: leaseAbort.signal,
  } as DurableJobHandle;
  const executionContext: JobExecutionContext = {
    engine: options.engine,
    jobId: handle.jobId,
    attemptId: handle.attemptId,
    generation: handle.generation,
    fenceToken: handle.fenceToken,
    producer,
    signal: handle.signal,
    controlAuthority: options.controlAuthority,
    ...(options.engine.getJob(handle.jobId)?.workspaceId
      ? { workspacePath: options.engine.getJob(handle.jobId)!.workspaceId! }
      : {}),
  };
  let attemptStateVersion = lease.stateVersion;
  let jobStateVersion = options.engine.getJob(handle.jobId)?.stateVersion ?? 0;
  let detachRuntime = options.controlAuthority?.runtime.attach(handle.attemptId, leaseAbort) ?? null;
  let leaseLost: DurableJobLifecycleError | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let controlWatcher: ReturnType<typeof setInterval> | null = null;
  let runtimeBudgetTimer: ReturnType<typeof setTimeout> | null = null;
  let runtimeBudgetExpired = false;
  let disposalError: DurableJobLifecycleDisposedError | null = null;
  const executionStartedAt = Date.now();

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (disposalError) return;
      const renewed = options.engine.renewAttemptLease({
        attemptId: handle.attemptId,
        ownerId: options.ownerId,
        generation: handle.generation,
        fenceToken: handle.fenceToken,
        ttlMs: leaseTtlMs,
      });
      if (!renewed.applied || renewed.stateVersion === undefined) {
        stopHeartbeat();
        leaseLost = new DurableJobAuthorityLostError(
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
  };

  const stopAsyncResources = (): void => {
    if (runtimeBudgetTimer) clearTimeout(runtimeBudgetTimer);
    runtimeBudgetTimer = null;
    stopHeartbeat();
    if (controlWatcher) clearInterval(controlWatcher);
    controlWatcher = null;
    detachRuntime?.();
    detachRuntime = null;
  };

  let resolveLifecycleDone!: () => void;
  const lifecycleDone = new Promise<void>((resolve) => { resolveLifecycleDone = resolve; });
  const unregisterScope = options.lifecycleScope?.register({
    done: lifecycleDone,
    dispose(reason) {
      if (disposalError) return;
      disposalError = new DurableJobLifecycleDisposedError(reason, handle);
      stopAsyncResources();
      let persistenceError: unknown = null;
      try {
        options.engine.cancelJob({
          jobId: handle.jobId,
          reason,
          producer,
          eventIdempotencyKey: `lifecycle-dispose:${handle.attemptId}:${handle.generation}`,
        });
      } catch (error) {
        persistenceError = error;
      }
      leaseAbort.abort(disposalError);
      if (persistenceError) throw persistenceError;
    },
  }) ?? null;

  Object.defineProperties(handle, {
    pauseAtBoundary: {
      enumerable: false,
      value: (): void => {
        const attempt = options.engine.getAttempt(handle.attemptId);
        const job = options.engine.getJob(handle.jobId);
        if (
          !attempt
          || !job
          || attempt.jobId !== handle.jobId
          || attempt.generation !== handle.generation
          || attempt.status !== 'waiting'
          || attempt.leaseOwner !== null
          || attempt.fenceToken !== null
          || job.status !== 'paused'
          || job.activeAttemptId !== handle.attemptId
        ) {
          throw new DurableJobLifecycleError(
            'Durable lifecycle pause boundary does not match the active paused Attempt',
            handle,
          );
        }
        stopHeartbeat();
        detachRuntime?.();
        detachRuntime = null;
        attemptStateVersion = attempt.stateVersion;
        jobStateVersion = job.stateVersion;
      },
    },
    resumeAttempt: {
      enumerable: false,
      value: (nextAdmission: AdmissionResult): void => {
        if (nextAdmission.jobId !== handle.jobId) {
          throw new DurableJobLifecycleError('Resumed Attempt belongs to a different Job', nextAdmission);
        }
        const queuedAttempt = options.engine.getAttempt(nextAdmission.attemptId);
        const queuedJob = options.engine.getJob(handle.jobId);
        if (
          !queuedAttempt
          || !queuedJob
          || queuedAttempt.jobId !== handle.jobId
          || queuedAttempt.rowId !== nextAdmission.runId
          || queuedAttempt.status !== 'queued'
          || queuedJob.status !== 'queued'
          || queuedJob.activeAttemptId !== nextAdmission.attemptId
        ) {
          throw new DurableJobLifecycleError(
            'Resumed durable admission is not the active queued Attempt',
            nextAdmission,
          );
        }

        const resumedLease = options.engine.claimAttempt({
          attemptId: nextAdmission.attemptId,
          ownerId: options.ownerId,
          ttlMs: leaseTtlMs,
        });
        if (
          !resumedLease.acquired
          || !resumedLease.fenceToken
          || resumedLease.generation === undefined
          || resumedLease.stateVersion === undefined
        ) {
          throw new DurableJobLifecycleError(
            `Resumed durable Attempt lease rejected: ${resumedLease.conflict ?? 'unknown'}`,
            nextAdmission,
          );
        }

        const attemptStarted = options.engine.transitionAttempt({
          attemptId: nextAdmission.attemptId,
          expectedStateVersion: resumedLease.stateVersion,
          generation: resumedLease.generation,
          fenceToken: resumedLease.fenceToken,
          to: 'running',
          eventIdempotencyKey: `attempt-running:${nextAdmission.attemptId}:${resumedLease.generation}`,
          producer,
        });
        if (!attemptStarted.applied || attemptStarted.stateVersion === undefined) {
          throw new DurableJobLifecycleError(
            `Resumed durable Attempt start rejected: ${attemptStarted.conflict ?? 'unknown'}`,
            nextAdmission,
          );
        }
        const currentJob = options.engine.getJob(handle.jobId);
        if (!currentJob || currentJob.activeAttemptId !== nextAdmission.attemptId) {
          throw new DurableJobLifecycleError('Resumed durable Job authority changed before start', nextAdmission);
        }
        const jobStarted = options.engine.transitionJob({
          jobId: handle.jobId,
          attemptId: nextAdmission.attemptId,
          generation: resumedLease.generation,
          fenceToken: resumedLease.fenceToken,
          expectedStateVersion: currentJob.stateVersion,
          to: 'running',
          eventIdempotencyKey: `job-running:${handle.jobId}:${resumedLease.generation}`,
          producer,
        });
        if (!jobStarted.applied || jobStarted.stateVersion === undefined) {
          throw new DurableJobLifecycleError(
            `Resumed durable Job start rejected: ${jobStarted.conflict ?? 'unknown'}`,
            nextAdmission,
          );
        }

        detachRuntime?.();
        handle.attemptId = nextAdmission.attemptId;
        handle.runId = nextAdmission.runId;
        handle.generation = resumedLease.generation;
        handle.fenceToken = resumedLease.fenceToken;
        executionContext.attemptId = handle.attemptId;
        executionContext.generation = handle.generation;
        executionContext.fenceToken = handle.fenceToken;
        executionContext.repository = undefined;
        executionContext.repositoryPromise = undefined;
        attemptStateVersion = attemptStarted.stateVersion;
        jobStateVersion = jobStarted.stateVersion;
        leaseLost = null;
        detachRuntime = options.controlAuthority?.runtime.attach(handle.attemptId, leaseAbort) ?? null;
        startHeartbeat();
      },
    },
  });

  try {
    const attemptStarted = options.engine.transitionAttempt({
      attemptId: handle.attemptId,
      expectedStateVersion: attemptStateVersion,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      to: 'running',
      eventIdempotencyKey: `attempt-running:${handle.attemptId}:${handle.generation}`,
      producer,
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
      producer,
    });
    if (!jobStarted.applied || jobStarted.stateVersion === undefined) {
      throw new DurableJobLifecycleError(
        `Durable Job start rejected: ${jobStarted.conflict ?? 'unknown'}`,
        handle,
      );
    }
    jobStateVersion = jobStarted.stateVersion;

    if (initialInput && options.controlAuthority) {
      const claimed = options.controlAuthority.inputs.claimNext({
        jobId: handle.jobId,
        attemptId: handle.attemptId,
        generation: handle.generation,
        inputId: initialInput.inputId,
      });
      if (!claimed) {
        throw new DurableJobLifecycleError('Durable initial input could not be claimed by the active Attempt', handle);
      }
      const consumed = options.controlAuthority.inputs.consume({
        inputId: claimed.inputId,
        attemptId: handle.attemptId,
        generation: handle.generation,
      });
      if (!consumed.applied && !consumed.duplicate) {
        throw new DurableJobLifecycleError(
          `Durable initial input could not be consumed: ${consumed.conflict ?? 'unknown'}`,
          handle,
        );
      }
      handle.initialInput = options.controlAuthority.inputs.get(claimed.inputId) ?? claimed;
    }

    startHeartbeat();

    const runtimeBudget = options.engine.resources.getBudgets(handle.jobId)
      .find((budget) => budget.kind === 'runtime_ms');
    if (runtimeBudget?.limit !== null && runtimeBudget !== undefined) {
      const remaining = Math.max(0, runtimeBudget.limit - runtimeBudget.used);
      runtimeBudgetTimer = setTimeout(() => {
        if (disposalError) return;
        try {
          options.engine.workerProviderCalls.recordInterruptionForAttempt({
            childJobId: handle.jobId,
            childAttemptId: handle.attemptId,
            childGeneration: handle.generation,
            childFenceToken: handle.fenceToken,
            kind: 'timeout',
            reason: 'runtime_budget_exceeded',
            idempotencyKey: `worker-timeout:${handle.attemptId}:${handle.generation}`,
          });
          runtimeBudgetExpired = true;
          leaseAbort.abort(new DurableJobBudgetExceededError('runtime_ms', handle));
        } catch (error) {
          leaseLost = new DurableJobAuthorityLostError(
            `Durable Worker timeout intent could not be persisted: ${error instanceof Error ? error.message : 'unknown'}`,
            handle,
          );
          leaseAbort.abort(leaseLost);
        }
      }, remaining);
      runtimeBudgetTimer.unref?.();
    }

    controlWatcher = setInterval(() => {
      if (disposalError || leaseAbort.signal.aborted) return;
      const status = options.engine.getJob(handle.jobId)?.status;
      if (status === 'cancelled' || status === 'cancelling') {
        leaseAbort.abort(new Error('Durable Job cancellation requested'));
      }
    }, Math.max(25, options.controlPollMs ?? 250));
    controlWatcher.unref?.();

    notifyPhase(options, 'running', handle, handle.generation);
    notifyPhase(options, 'executing', handle, handle.generation);
    const value = await runWithJobExecutionContext(executionContext, () => options.execute(handle));
    if (disposalError) throw disposalError;
    if (runtimeBudgetExpired) throw new DurableJobBudgetExceededError('runtime_ms', handle);
    if (leaseLost) throw leaseLost;
    assertAuthority(options.engine, handle);

    notifyPhase(options, 'verifying', handle, handle.generation);
    const requestedFinalization = await options.finalize(value, handle);
    if (leaseLost) throw leaseLost;
    const authority = assertAuthority(options.engine, handle);
    const finalization = applyRequiredProof(options.engine, handle, requestedFinalization);
    attemptStateVersion = authority.attempt.stateVersion;
    jobStateVersion = authority.job.stateVersion;
    settle(options.engine, handle, finalization, attemptStateVersion, jobStateVersion, producer);
    notifyPhase(options, 'settled', handle, handle.generation);
    return Object.assign(handle, { value });
  } catch (error) {
    if (disposalError) throw disposalError;
    if (leaseLost || error instanceof DurableJobAuthorityLostError) throw error;
    const attempt = options.engine.getAttempt(handle.attemptId);
    const job = options.engine.getJob(handle.jobId);
    if (!isAttemptTerminal(attempt) && !isJobTerminal(job)) {
      const disposition = await options.classifyError?.(error, handle) ?? {
        status: 'failed' as const,
        outcome: 'failed',
        finishReason: 'error',
        evidence: { errorClass: error instanceof Error ? error.name : 'Error' },
      };
      const authority = assertAuthority(options.engine, handle);
      settle(
        options.engine,
        handle,
        disposition,
        authority.attempt.stateVersion,
        authority.job.stateVersion,
        producer,
      );
      notifyPhase(options, 'settled', handle, handle.generation);
    }
    throw error;
  } finally {
    stopAsyncResources();
    try {
      const browserSession = options.engine.browser.getSessionForAttempt(
        handle.jobId,
        handle.attemptId,
        handle.generation,
      );
      if (browserSession) {
        try {
          const { pwCloseBrowserSessionResources } = await import('../../playwrightBridge');
          await pwCloseBrowserSessionResources(browserSession.browserSessionId);
          const { clearBrowserObservationSession } = await import('../../../tools/v4/browser/_observer');
          clearBrowserObservationSession(browserSession.browserSessionId);
        } catch { /* browser runtime may be unavailable during shutdown */ }
        const jobStatus = options.engine.getJob(handle.jobId)?.status;
        const state = jobStatus === 'cancelled' || jobStatus === 'cancelling'
          ? 'cancelled'
          : leaseLost || disposalError
            ? 'lost'
            : 'closed';
        try {
          options.engine.browser.settleSession({
            jobId: handle.jobId,
            attemptId: handle.attemptId,
            generation: handle.generation,
            fenceToken: handle.fenceToken,
          }, state, `durable lifecycle ${jobStatus ?? 'ended'}`);
        } catch { /* stale replacement already owns browser authority */ }
      }
      if (!disposalError && options.engine.resources.getBudgets(handle.jobId).some((budget) => budget.kind === 'runtime_ms')) {
        try {
          options.engine.resources.debit({
            jobId: handle.jobId,
            attemptId: handle.attemptId,
            generation: handle.generation,
            fenceToken: handle.fenceToken,
            kind: 'runtime_ms',
            amount: Math.max(0, Date.now() - executionStartedAt),
            certainty: 'confirmed',
            idempotencyKey: `runtime:${handle.attemptId}:${handle.generation}`,
            enforceLimit: false,
          });
        } catch { /* stale authority cannot spend after replacement */ }
      }
      if (!disposalError) notifyPhase(options, 'cleanup', handle, handle.generation);
    } finally {
      unregisterScope?.();
      resolveLifecycleDone();
    }
  }
}

function settle(
  engine: JobEngine,
  handle: DurableJobHandle,
  finalization: DurableJobDisposition,
  attemptStateVersion: number,
  jobStateVersion: number,
  producer: string,
): void {
  const attemptStatus = 'attemptStatus' in finalization && finalization.attemptStatus
    ? finalization.attemptStatus
    : finalization.status === 'completed'
    ? 'succeeded'
    : finalization.status === 'cancelled'
      ? 'cancelled'
      : finalization.status === 'unknown' || finalization.status === 'blocked'
        ? 'unknown'
        : 'failed';
  const attemptFinished = engine.transitionAttempt({
    attemptId: handle.attemptId,
    expectedStateVersion: attemptStateVersion,
    generation: handle.generation,
    fenceToken: handle.fenceToken,
    to: attemptStatus,
    eventIdempotencyKey: `attempt-${attemptStatus}:${handle.attemptId}:${handle.generation}`,
    producer,
    finishReason: finalization.finishReason,
  });
  if (!attemptFinished.applied) {
    throw new DurableJobLifecycleError(
      `Durable Attempt finalization rejected: ${attemptFinished.conflict ?? 'unknown'}`,
      handle,
    );
  }

  if (finalization.status === 'unknown' || finalization.status === 'blocked') {
    const jobFinished = engine.transitionJob({
      jobId: handle.jobId,
      attemptId: handle.attemptId,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      expectedStateVersion: jobStateVersion,
      to: finalization.status,
      eventIdempotencyKey: `job-${finalization.status}:${handle.jobId}:${handle.generation}`,
      producer,
      finishReason: finalization.finishReason,
      terminalOutcome: finalization.outcome,
      payload: { evidence: finalization.evidence },
    });
    if (!jobFinished.applied) {
      throw new DurableJobLifecycleError(
        `Durable Job uncertainty transition rejected: ${jobFinished.conflict ?? 'unknown'}`,
        handle,
      );
    }
    return;
  }

  const jobFinished = engine.finalizeJob({
    jobId: handle.jobId,
    attemptId: handle.attemptId,
    generation: handle.generation,
    fenceToken: handle.fenceToken,
    expectedStateVersion: jobStateVersion,
    status: finalization.status,
    outcome: finalization.outcome,
    finishReason: finalization.finishReason,
    evidence: finalization.evidence,
    jobCard: 'jobCard' in finalization ? finalization.jobCard : undefined,
    eventIdempotencyKey: `job-finalized:${handle.jobId}:${handle.generation}`,
    producer,
  });
  if (!jobFinished.applied) {
    throw new DurableJobLifecycleError(
      `Durable Job finalization rejected: ${jobFinished.conflict ?? 'unknown'}`,
      handle,
    );
  }
}
