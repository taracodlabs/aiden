/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { JobEngine } from '../daemon/jobEngine';
import type { RunStore } from '../daemon/runStore';
import type { TriggerBus } from '../daemon/triggerBus';
import { isTerminalWorkbenchJob } from './activeJobs';

export interface WorkbenchQueueReconciliationDependencies {
  jobs: Pick<JobEngine, 'listJobs' | 'getAttempt' | 'cancelJob'>;
  runs: Pick<RunStore, 'get'>;
  triggers: Pick<TriggerBus, 'reclaimExpired' | 'get' | 'deadLetter'>;
}

export interface WorkbenchQueueReconciliationResult {
  reclaimed: number;
  orphaned: number;
  terminalTriggersRemoved: number;
}

const LIVE_TRIGGER = new Set(['pending', 'claimed', 'running']);

/**
 * Repairs only provable queue contradictions at Workbench startup. It does not
 * infer success, retry active work, or replace JobEngine recovery authority.
 */
export function reconcileWorkbenchQueue(
  deps: WorkbenchQueueReconciliationDependencies,
): WorkbenchQueueReconciliationResult {
  const reclaimed = deps.triggers.reclaimExpired().reclaimed;
  let orphaned = 0;
  let terminalTriggersRemoved = 0;

  for (const job of deps.jobs.listJobs({ limit: 1_000 })) {
    if (job.entryPoint !== 'workbench') continue;
    const attempt = job.activeAttemptId ? deps.jobs.getAttempt(job.activeAttemptId) : null;
    const run = attempt ? deps.runs.get(attempt.rowId) : null;
    const triggerId = run?.triggerEventId ?? null;
    const trigger = triggerId === null ? null : deps.triggers.get(triggerId);

    if (isTerminalWorkbenchJob(job.status)) {
      if (trigger && LIVE_TRIGGER.has(trigger.status)) {
        deps.triggers.deadLetter(trigger.id, 'terminal Workbench Job cannot be dispatched');
        terminalTriggersRemoved += 1;
      }
      continue;
    }

    if (job.status !== 'queued') continue;
    if (trigger && LIVE_TRIGGER.has(trigger.status)) continue;

    const reason = trigger
      ? `Workbench queue trigger is already ${trigger.status}`
      : 'Workbench queue trigger is missing';
    const result = deps.jobs.cancelJob({
      jobId: job.id,
      reason,
      producer: 'workbench-recovery',
      eventIdempotencyKey: `workbench-orphan:${job.id}:${trigger?.status ?? 'missing'}`,
    });
    if (result.applied || result.duplicate) orphaned += 1;
  }

  return { reclaimed, orphaned, terminalTriggersRemoved };
}
