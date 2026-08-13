import { describe, expect, it, vi } from 'vitest';

import { reconcileWorkbenchQueue } from '../../../core/v4/workbench/queueReconciliation';

function fixture(jobStatus = 'queued', triggerStatus: string | null = 'pending') {
  const cancelJob = vi.fn(() => ({ applied: true }));
  const deadLetter = vi.fn();
  const job = {
    id: 'job_1', status: jobStatus, activeAttemptId: 'attempt_1',
    entryPoint: 'workbench', source: 'workbench',
  };
  return {
    deps: {
      jobs: {
        listJobs: () => [job],
        getAttempt: () => ({ id: 'attempt_1', rowId: 11, jobId: 'job_1' }),
        cancelJob,
      },
      runs: { get: () => ({ id: 11, triggerEventId: triggerStatus === null ? null : 7, taskId: 'job_1' }) },
      triggers: {
        reclaimExpired: vi.fn(() => ({ reclaimed: 1 })),
        get: () => triggerStatus === null ? null : ({ id: 7, status: triggerStatus }),
        deadLetter,
      },
    } as never,
    cancelJob,
    deadLetter,
  };
}

describe('Workbench queue startup reconciliation', () => {
  it('preserves legitimate pending and claimed work', () => {
    for (const status of ['pending', 'claimed']) {
      const value = fixture('queued', status);
      expect(reconcileWorkbenchQueue(value.deps)).toMatchObject({ orphaned: 0, terminalTriggersRemoved: 0 });
      expect(value.cancelJob).not.toHaveBeenCalled();
      expect(value.deadLetter).not.toHaveBeenCalled();
    }
  });

  it.each([null, 'done', 'failed', 'dead_letter'])('cancels a queued Job whose trigger is %s', (triggerStatus) => {
    const value = fixture('queued', triggerStatus);
    expect(reconcileWorkbenchQueue(value.deps).orphaned).toBe(1);
    expect(value.cancelJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job_1', producer: 'workbench-recovery',
    }));
  });

  it('removes pending queue work for a Job that is already terminal', () => {
    const value = fixture('cancelled', 'pending');
    expect(reconcileWorkbenchQueue(value.deps).terminalTriggersRemoved).toBe(1);
    expect(value.deadLetter).toHaveBeenCalledWith(7, 'terminal Workbench Job cannot be dispatched');
    expect(value.cancelJob).not.toHaveBeenCalled();
  });

  it('reclaims expired TriggerBus claims before reconciliation', () => {
    const value = fixture('queued', 'pending');
    expect(reconcileWorkbenchQueue(value.deps).reclaimed).toBe(1);
    expect(value.deps.triggers.reclaimExpired).toHaveBeenCalledOnce();
  });
});
