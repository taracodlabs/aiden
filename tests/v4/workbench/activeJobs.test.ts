import { describe, expect, it } from 'vitest';

import {
  listWorkbenchActiveJobs,
  summarizeWorkbenchActiveJobs,
  type WorkbenchActiveJobDependencies,
} from '../../../core/v4/workbench/activeJobs';

function fixture(status: string, overrides: Partial<WorkbenchActiveJobDependencies> = {}) {
  const job = {
    id: 'job_1', status, stateVersion: 0, activeAttemptId: 'attempt_1',
    rootJobId: 'job_1', parentJobId: null, sessionId: 'session_1',
    goal: 'Inspect the repository', entryPoint: 'workbench', source: 'workbench',
    terminalAt: null, terminalOutcome: null, finishReason: null, nextEventSequence: 1,
  };
  const attempt = {
    rowId: 9, id: 'attempt_1', jobId: 'job_1', status: status === 'queued' ? 'queued' : 'running',
    attemptNumber: 1, generation: 1, stateVersion: 0, leaseId: null,
    leaseOwner: null, leaseExpiresAt: null, leaseHeartbeatAt: 40,
    fenceToken: null, recoveryOfAttemptId: null,
  };
  return {
    jobs: {
      listJobs: () => [job],
      getAttempt: () => attempt,
    },
    runs: {
      get: () => ({ id: 9, triggerEventId: 7, sessionId: 'session_1', instanceId: 'workbench', status: 'queued', finishReason: null, startedAt: 20, completedAt: null, resumePending: false, resumeReason: null, taskId: 'job_1' }),
    },
    triggers: {
      get: () => ({ id: 7, source: 'manual', sourceKey: 'workbench-web', idempotencyKey: 'k', payload: {}, status: 'pending', attempts: 0, claimOwner: null, claimExpiresAt: null, lastError: null, createdAt: 10, updatedAt: 30, completedAt: null, runId: null }),
      stats: () => ({ pending: 1, claimed: 0, running: 0, deadLetter: 0, oldestPendingMs: 25 }),
    },
    approvals: { listPending: () => [] },
    waits: { listPending: () => [] },
    ...overrides,
  } as unknown as WorkbenchActiveJobDependencies;
}

describe('Workbench active Job projection', () => {
  it.each([
    ['queued', 'queued'],
    ['running', 'running'],
    ['waiting', 'waiting'],
    ['paused', 'paused'],
    ['cancelling', 'cancelling'],
    ['recovering', 'recovering'],
    ['blocked', 'blocked'],
    ['unknown', 'state_unknown'],
    ['crashed', 'state_unknown'],
  ])('projects nonterminal %s truth as %s', (jobStatus, expected) => {
    expect(listWorkbenchActiveJobs(fixture(jobStatus))[0]?.status).toBe(expected);
  });

  it('projects a pending approval instead of a generic waiting state', () => {
    const deps = fixture('waiting', {
      approvals: { listPending: () => [{ approvalId: 'approval_1' }] } as never,
    });
    expect(listWorkbenchActiveJobs(deps)[0]).toMatchObject({
      status: 'approval_required',
      statusDetail: 'Approval required',
    });
  });

  it('keeps recoverable blocked/unknown/crashed Jobs visible and excludes only real terminal Jobs', () => {
    for (const status of ['blocked', 'unknown', 'crashed', 'recovering']) {
      expect(listWorkbenchActiveJobs(fixture(status))).toHaveLength(1);
    }
    for (const status of ['cancelled', 'completed', 'failed', 'dead_letter', 'completed_unverified', 'verification_failed', 'abandoned']) {
      expect(listWorkbenchActiveJobs(fixture(status))).toEqual([]);
    }
  });

  it('reports bounded queue diagnostics without exposing payload data', () => {
    const value = listWorkbenchActiveJobs(fixture('queued'))[0]!;
    expect(value).toMatchObject({
      title: 'Inspect the repository', triggerEventId: 7, triggerStatus: 'pending',
      queue: { pending: 1, claimed: 0, oldestPendingMs: 25 },
    });
    expect(JSON.stringify(value)).not.toMatch(/payload|idempotencyKey|secret/i);
  });

  it('finds a recent durable Workbench Job after more than 100 older Jobs exist', () => {
    const live = fixture('running');
    const liveJob = live.jobs.listJobs()[0]!;
    const older = Array.from({ length: 100 }, (_, index) => ({
      ...liveJob,
      id: `old_${index}`,
      activeAttemptId: null,
      entryPoint: 'daemon',
      status: 'completed',
      terminalAt: index + 1,
    }));
    const all = [...older, liveJob];
    const deps = fixture('running', {
      jobs: {
        listJobs: (filters?: { limit?: number; entryPoint?: string; terminal?: boolean }) => all
          .filter((job) => !filters?.entryPoint || job.entryPoint === filters.entryPoint)
          .filter((job) => filters?.terminal === undefined || Boolean(job.terminalAt) === filters.terminal)
          .slice(0, filters?.limit ?? 100),
        getAttempt: live.jobs.getAttempt,
      } as never,
    });

    expect(listWorkbenchActiveJobs(deps)).toMatchObject([{ jobId: 'job_1', status: 'running' }]);
  });

  it('summarizes running, queued, waiting, paused, and claimed truth from active Jobs only', () => {
    expect(summarizeWorkbenchActiveJobs([
      { status: 'running', triggerStatus: 'claimed' },
      { status: 'queued', triggerStatus: 'pending' },
      { status: 'approval_required', triggerStatus: 'claimed' },
      { status: 'paused', triggerStatus: 'claimed' },
      { status: 'cancelling', triggerStatus: 'claimed' },
    ])).toEqual({ total: 5, running: 2, queued: 1, claimed: 4, waiting: 1, paused: 1 });
    expect(summarizeWorkbenchActiveJobs([])).toEqual({
      total: 0, running: 0, queued: 0, claimed: 0, waiting: 0, paused: 0,
    });
  });
});
