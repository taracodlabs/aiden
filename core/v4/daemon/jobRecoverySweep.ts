/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { JobEngine } from './jobEngine';
import type { TriggerBus } from './triggerBus';
import { reconcileFilesystemEffectSync } from '../effectReconciliation';
import { currentProviderAttemptLedger } from '../../../providers/v4/providerAttemptAccounting';
import {
  reconcileWorkerProviderAttempt,
  sweepWorkerProviderReconciliation,
} from '../worker/workerProviderReconciliation';
import {
  projectReadOnlyRepositoryWorkerGroups,
  reconcileInterruptedReadOnlyRepositoryWorkerGroups,
} from '../worker/workerParallel';

export interface DurableRecoverySweepResult {
  expired: number;
  retried: number;
  needsUser: number;
  deadLettered: number;
  enqueued: number;
  reconciled: number;
}

/**
 * Classify expired Attempt leases, then idempotently project every queued
 * recovery Attempt onto the existing trigger bus. Scanning all recovering
 * Jobs closes the crash window between the authoritative recovery transaction
 * and the compatibility queue insertion.
 */
export function sweepDurableJobRecovery(input: {
  jobEngine: JobEngine;
  triggerBus: TriggerBus;
  instanceId: string;
  producer: string;
  maxCrashes?: number;
  now?: number;
}): DurableRecoverySweepResult {
  const providerLedger = currentProviderAttemptLedger();
  const decisions = input.jobEngine.recoverExpiredAttempts({
    now: input.now,
    instanceId: input.instanceId,
    producer: input.producer,
    maxCrashes: input.maxCrashes ?? 3,
    reconcileWorkerAttempt: ({ childJobId, childAttemptId, childGeneration, now }) =>
      reconcileWorkerProviderAttempt({
        engine: input.jobEngine,
        ledger: providerLedger,
        childJobId,
        childAttemptId,
        childGeneration,
        ownerId: input.instanceId,
        producer: input.producer,
        reason: 'attempt_lease_expired',
        now,
      }),
  });
  const result: DurableRecoverySweepResult = {
    expired: decisions.length,
    retried: decisions.filter((item) => item.decision === 'retry').length,
    needsUser: decisions.filter((item) => item.decision === 'ask_user').length,
    deadLettered: decisions.filter((item) => item.decision === 'dead_letter').length,
    enqueued: 0,
    reconciled: 0,
  };
  const workerSweep = sweepWorkerProviderReconciliation({
    engine: input.jobEngine,
    ledger: providerLedger,
    ownerId: input.instanceId,
    producer: input.producer,
    now: input.now,
  });
  result.reconciled += workerSweep.reconciled;
  const interruptedParents = new Set(
    input.jobEngine.worker.listWorkerGroupsPendingSettlement({ limit: 1_000 })
      .filter((group) => group.state === 'cancelling' || group.state === 'timed_out')
      .map((group) => group.parentJobId),
  );
  for (const parentJobId of interruptedParents) {
    result.reconciled += reconcileInterruptedReadOnlyRepositoryWorkerGroups({
      engine: input.jobEngine,
      parentJobId,
      producer: input.producer,
    }).settled;
  }
  projectReadOnlyRepositoryWorkerGroups({ engine: input.jobEngine, limit: 100 });

  for (const decision of decisions.filter((item) => item.decision === 'ask_user')) {
    const job = input.jobEngine.getJob(decision.jobId);
    if (!job) continue;
    const workerRequiresResolution = decision.workerReconciliation?.retrySafety === 'blocked_unknown'
      || decision.workerReconciliation?.retrySafety === 'unsafe';
    const effects = input.jobEngine.listEffectsRequiringReconciliation(job.id);
    for (const effect of effects) {
      const reconciliation = reconcileFilesystemEffectSync(effect);
      const recorded = input.jobEngine.recordEffectReconciliation({
        effectId: effect.effectId,
        expectedJobStateVersion: input.jobEngine.getJob(job.id)?.stateVersion ?? job.stateVersion,
        ...reconciliation,
        producer: input.producer,
        idempotencyKey: `recovery:${effect.effectId}:${effect.generation}`,
        now: input.now,
      });
      if (recorded.applied) result.reconciled += 1;
    }
    if (!workerRequiresResolution && input.jobEngine.listEffectsRequiringReconciliation(job.id).length === 0) {
      input.jobEngine.createRecoveryAttempt({
        jobId: job.id,
        recoveryOfAttemptId: decision.expiredAttemptId,
        instanceId: input.instanceId,
        triggerReason: 'effect_reconciled',
        producer: input.producer,
        eventIdempotencyKey: `effect-reconciled-resume:${job.id}:${job.stateVersion}`,
      });
      result.needsUser = Math.max(0, result.needsUser - 1);
      result.retried += 1;
    }
  }

  for (const job of input.jobEngine.listJobs({ status: 'recovering' })) {
    const attempt = job.activeAttemptId
      ? input.jobEngine.getAttempt(job.activeAttemptId)
      : null;
    if (!attempt || attempt.jobId !== job.id || attempt.status !== 'queued') continue;

    const queued = input.triggerBus.insert({
      source: 'manual',
      sourceKey: `job-recovery:${job.id}`,
      idempotencyKey: `job-recovery:${attempt.id}`,
      payload: {
        resume: {
          prompt: `A previous Attempt lost its lease. Re-evaluate current state before continuing.\n\n${job.goal}`,
          taskId: job.id,
          ofRunId: attempt.rowId,
          attempt: attempt.attemptNumber,
        },
        durable_job: {
          job_id: job.id,
          attempt_id: attempt.id,
          run_id: attempt.rowId,
        },
      },
    });
    if (queued.inserted) result.enqueued += 1;
  }

  return result;
}
