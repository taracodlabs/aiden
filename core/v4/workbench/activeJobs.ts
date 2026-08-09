/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ActionAuthority } from '../actionAuthority';
import type { JobEngine, JobRecord } from '../daemon/jobEngine';
import type { JobWaitAuthority } from '../daemon/jobWaitAuthority';
import type { RunStore } from '../daemon/runStore';
import type { TriggerBus } from '../daemon/triggerBus';

export type WorkbenchActiveStatus =
  | 'queued' | 'running' | 'waiting' | 'approval_required' | 'paused'
  | 'cancelling' | 'recovering' | 'blocked' | 'state_unknown';

export interface WorkbenchQueueView {
  pending: number;
  claimed: number;
  oldestPendingMs: number | null;
}

export interface WorkbenchActiveJobView {
  sessionId: string | null;
  jobId: string;
  attemptId: string | null;
  runId: number | null;
  title: string;
  status: WorkbenchActiveStatus;
  statusDetail: string;
  updatedAt: number;
  triggerEventId: number | null;
  triggerStatus: string | null;
  queue: WorkbenchQueueView;
}

export interface WorkbenchActiveJobDependencies {
  jobs: Pick<JobEngine, 'listJobs' | 'getAttempt'>;
  runs: Pick<RunStore, 'get'>;
  triggers: Pick<TriggerBus, 'get' | 'stats'>;
  approvals?: Pick<ActionAuthority, 'listPending'>;
  waits?: Pick<JobWaitAuthority, 'listPending'>;
}

export interface WorkbenchActiveSummary {
  total: number;
  running: number;
  queued: number;
  claimed: number;
  waiting: number;
  paused: number;
}

const TERMINAL = new Set([
  'cancelled', 'completed', 'failed', 'dead_letter',
  'completed_unverified', 'verification_failed', 'abandoned',
]);

export function isTerminalWorkbenchJob(status: string): boolean {
  return TERMINAL.has(status);
}

/** One semantic counter projection for every Workbench surface. Dispatcher
 * counters are diagnostic only; durable Job state owns whether work is active. */
export function summarizeWorkbenchActiveJobs(
  jobs: ReadonlyArray<{ status: string; triggerStatus: string | null }>,
): WorkbenchActiveSummary {
  return jobs.reduce<WorkbenchActiveSummary>((summary, job) => {
    summary.total += 1;
    if (job.status === 'queued') summary.queued += 1;
    if (job.status === 'running' || job.status === 'cancelling' || job.status === 'recovering') {
      summary.running += 1;
    }
    if (job.status === 'waiting' || job.status === 'approval_required') summary.waiting += 1;
    if (job.status === 'paused') summary.paused += 1;
    if (job.triggerStatus === 'claimed') summary.claimed += 1;
    return summary;
  }, { total: 0, running: 0, queued: 0, claimed: 0, waiting: 0, paused: 0 });
}

function semanticStatus(
  job: JobRecord,
  approvalCount: number,
  waitKinds: readonly string[],
): Pick<WorkbenchActiveJobView, 'status' | 'statusDetail'> {
  if (approvalCount > 0 || waitKinds.includes('approval')) {
    return { status: 'approval_required', statusDetail: 'Approval required' };
  }
  switch (job.status) {
    case 'queued': return { status: 'queued', statusDetail: 'Queued for execution' };
    case 'running': return { status: 'running', statusDetail: 'Running' };
    case 'waiting': {
      const kind = waitKinds[0];
      return { status: 'waiting', statusDetail: kind ? `Waiting for ${kind.replace(/_/g, ' ')}` : 'Waiting' };
    }
    case 'paused': return { status: 'paused', statusDetail: 'Paused' };
    case 'cancelling': return { status: 'cancelling', statusDetail: 'Cancelling' };
    case 'recovering': return { status: 'recovering', statusDetail: 'Recovering' };
    case 'blocked': return { status: 'blocked', statusDetail: job.finishReason ?? 'Blocked' };
    case 'unknown':
    case 'crashed':
      return { status: 'state_unknown', statusDetail: job.finishReason ?? 'State requires reconciliation' };
    default:
      return { status: 'state_unknown', statusDetail: `Unrecognized state: ${job.status}` };
  }
}

/**
 * Read-only active-work projection. It preserves JobEngine truth and never
 * mutates lifecycle state or promotes an uncertain Job to success.
 */
export function listWorkbenchActiveJobs(
  deps: WorkbenchActiveJobDependencies,
  limit = 100,
): WorkbenchActiveJobView[] {
  const queueStats = deps.triggers.stats();
  const queue: WorkbenchQueueView = {
    pending: queueStats.pending,
    claimed: queueStats.claimed,
    oldestPendingMs: queueStats.oldestPendingMs,
  };
  return deps.jobs.listJobs({
    entryPoint: 'workbench',
    terminal: false,
    limit: Math.max(1, Math.min(1_000, limit)),
  })
    .filter((job) => !isTerminalWorkbenchJob(job.status))
    .map((job) => {
      const attempt = job.activeAttemptId ? deps.jobs.getAttempt(job.activeAttemptId) : null;
      const run = attempt ? deps.runs.get(attempt.rowId) : null;
      const trigger = run?.triggerEventId ? deps.triggers.get(run.triggerEventId) : null;
      const approvals = deps.approvals?.listPending(job.id) ?? [];
      const waits = deps.waits?.listPending(job.id) ?? [];
      const status = semanticStatus(job, approvals.length, waits.map((wait) => wait.kind));
      return {
        sessionId: job.sessionId || null,
        jobId: job.id,
        attemptId: attempt?.id ?? job.activeAttemptId,
        runId: attempt?.rowId ?? null,
        title: job.goal,
        ...status,
        updatedAt: Math.max(
          trigger?.updatedAt ?? 0,
          attempt?.leaseHeartbeatAt ?? 0,
          trigger?.createdAt ?? 0,
        ),
        triggerEventId: trigger?.id ?? run?.triggerEventId ?? null,
        triggerStatus: trigger?.status ?? null,
        queue,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.jobId.localeCompare(b.jobId));
}
