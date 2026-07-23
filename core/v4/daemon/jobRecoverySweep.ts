/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { JobEngine } from './jobEngine';
import type { TriggerBus } from './triggerBus';

export interface DurableRecoverySweepResult {
  expired: number;
  retried: number;
  needsUser: number;
  deadLettered: number;
  enqueued: number;
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
  const decisions = input.jobEngine.recoverExpiredAttempts({
    now: input.now,
    instanceId: input.instanceId,
    producer: input.producer,
    maxCrashes: input.maxCrashes ?? 3,
  });
  const result: DurableRecoverySweepResult = {
    expired: decisions.length,
    retried: decisions.filter((item) => item.decision === 'retry').length,
    needsUser: decisions.filter((item) => item.decision === 'ask_user').length,
    deadLettered: decisions.filter((item) => item.decision === 'dead_letter').length,
    enqueued: 0,
  };

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
