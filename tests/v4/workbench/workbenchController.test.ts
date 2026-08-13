import { describe, expect, it } from 'vitest';
import { parseTaskAdmission } from '../../../dashboard-next/lib/aidenClient';
import {
  WorkbenchController,
  emptySelection,
  normalizeActiveJobStatus,
  selectionFromSearch,
  selectionToSearch,
  shouldAttachAdmission,
} from '../../../dashboard-next/lib/workbenchController';

const admission = (jobId: string, runId: number) => parseTaskAdmission({
  accepted: true, job_id: jobId, attempt_id: `${jobId}_attempt`, run_id: runId,
});

describe('Workbench foreground controller', () => {
  it('keeps selected context independent from active background Jobs', () => {
    const controller = new WorkbenchController();
    controller.newChat('session-a');
    controller.register(admission('job-a', 1), 'session-a');
    controller.newChat('session-b');
    controller.register(admission('job-b', 2), 'session-b');
    expect(controller.snapshot().selected).toEqual(emptySelection('session-b'));
    expect(controller.active().map((job) => job.jobId)).toEqual(['job-b', 'job-a']);
    expect(controller.isSelectedJob('job-a')).toBe(false);
  });

  it('invalidates stale foreground loads when selection changes', () => {
    const controller = new WorkbenchController();
    const generation = controller.select({ ...emptySelection('session-a'), jobId: 'job-a', attemptId: 'a', runId: 1 });
    controller.select({ ...emptySelection('session-b'), jobId: 'job-b', attemptId: 'b', runId: 2 });
    expect(controller.isCurrent(generation)).toBe(false);
  });

  it('round-trips exact deep-link identity without making it lifecycle authority', () => {
    const selection = selectionFromSearch('?session=s&job=j&attempt=a&run=7');
    expect(selectionToSearch(selection)).toBe('?session=s&job=j&attempt=a&run=7');
    expect(selectionFromSearch(selectionToSearch(selection))).toEqual(selection);
  });

  it('settles one Job without changing foreground selection or other Jobs', () => {
    const controller = new WorkbenchController();
    controller.select({ ...emptySelection('session-b'), jobId: 'job-b', attemptId: 'b', runId: 2 });
    controller.register(admission('job-a', 1), 'session-a');
    controller.register(admission('job-b', 2), 'session-b');
    controller.settle('job-a');
    expect(controller.snapshot().selected.jobId).toBe('job-b');
    expect(controller.active().map((job) => job.jobId)).toEqual(['job-b']);
  });

  it('reconciles the active list from the durable bootstrap without changing selection', () => {
    const controller = new WorkbenchController();
    controller.select({ ...emptySelection('session-a'), jobId: 'job-a', attemptId: 'a', runId: 1 });
    controller.register(admission('job-a', 1), 'session-a');
    controller.register(admission('job-stale', 3), 'session-stale');
    controller.reconcileActive([{
      sessionId: 'session-b', jobId: 'job-b', attemptId: 'b', runId: 2,
      status: 'running', updatedAt: 50,
    }]);
    expect(controller.snapshot().selected.jobId).toBe('job-a');
    expect(controller.active().map((job) => job.jobId)).toEqual(['job-b']);
  });

  it.each([
    'queued', 'running', 'waiting', 'approval_required', 'paused', 'cancelling',
    'recovering', 'blocked', 'state_unknown',
  ] as const)('preserves the durable semantic state %s', (status) => {
    const controller = new WorkbenchController();
    controller.registerView({
      sessionId: 'session-a', jobId: 'job-a', attemptId: 'a', runId: 1,
      status, updatedAt: 10,
    });
    expect(controller.active()[0]?.status).toBe(status);
  });

  it('maps an unrecognized backend state to honest uncertainty', () => {
    expect(normalizeActiveJobStatus('future_state')).toBe('state_unknown');
    expect(normalizeActiveJobStatus('approval_required')).toBe('approval_required');
  });

  it('settles three Jobs out of order without stealing foreground selection', () => {
    const controller = new WorkbenchController();
    for (const [jobId, runId] of [['job-a', 1], ['job-b', 2], ['job-c', 3]] as const) {
      controller.register(admission(jobId, runId), `session-${jobId}`);
    }
    controller.select({ sessionId: 'session-job-b', jobId: 'job-b', attemptId: 'job-b_attempt', runId: 2 });
    controller.settle('job-c');
    controller.settle('job-a');
    expect(controller.snapshot().selected.jobId).toBe('job-b');
    expect(controller.active().map((job) => job.jobId)).toEqual(['job-b']);
  });

  it('reconciles duplicate bootstrap snapshots idempotently', () => {
    const controller = new WorkbenchController();
    const view = {
      sessionId: 'session-a', jobId: 'job-a', attemptId: 'attempt-a', runId: 1,
      status: 'running' as const, updatedAt: 10,
    };
    controller.reconcileActive([view]);
    controller.reconcileActive([view]);
    expect(controller.active()).toEqual([view]);
  });

  it('drops orphan Attempt and run parameters from invalid deep links', () => {
    expect(selectionFromSearch('?session=s&attempt=a&run=7')).toEqual(emptySelection('s'));
    expect(selectionFromSearch('?session=s&job=j&run=7')).toEqual({
      sessionId: 's', jobId: 'j', attemptId: null, runId: null,
    });
    expect(selectionFromSearch('?session=s&job=j&attempt=a&run=not-a-number')).toEqual({
      sessionId: 's', jobId: 'j', attemptId: 'a', runId: null,
    });
  });

  it('attaches admission only while the original empty conversation remains selected', () => {
    expect(shouldAttachAdmission(emptySelection('session-a'), 'session-a')).toBe(true);
    expect(shouldAttachAdmission(emptySelection('session-b'), 'session-a')).toBe(false);
    expect(shouldAttachAdmission({
      sessionId: 'session-a', jobId: 'job-existing', attemptId: 'attempt-existing', runId: 1,
    }, 'session-a')).toBe(false);
  });

  it('keeps the prompt title on the admission projection until durable refresh', () => {
    const controller = new WorkbenchController();
    controller.register(admission('job-a', 1), 'session-a', 'hey');
    expect(controller.active()[0]).toMatchObject({ jobId: 'job-a', title: 'hey', status: 'queued' });
  });
});
