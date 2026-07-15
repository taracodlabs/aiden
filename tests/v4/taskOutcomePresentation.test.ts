import { describe, expect, it } from 'vitest';

import {
  mapTaskOutcomePresentation,
  taskOutcomeInputFromFinalization,
  type TaskOutcomePresentationInput,
} from '../../core/v4/taskOutcomePresentation';
import { computeTaskFinalization, type VerificationOutcome } from '../../core/v4/taskVerification';

const noEvidence: VerificationOutcome = { kind: 'no_evidence' };

function input(overrides: Partial<TaskOutcomePresentationInput> = {}): TaskOutcomePresentationInput {
  return {
    status: 'completed',
    outcome: noEvidence,
    finishReason: 'stop',
    toolCallCount: 1,
    ...overrides,
  };
}

describe('task outcome presentation mapper', () => {
  it.each([
    ['timed_out', 'error', 'Timed out', { timedOut: true }],
    ['cancelled', 'info', 'Cancelled', { cancelled: true }],
    ['denied', 'info', 'Denied', { denied: true }],
    ['failed', 'error', 'Failed', { executionFailed: true }],
    ['partial', 'warning', 'Partially completed', { partial: true }],
    ['unverified_required', 'error', 'Could not verify required outcome', { requiredEvidenceGap: true }],
    ['verified', 'success', 'Verified', {
      outcome: { kind: 'verified', handles: [{ tool: 'file_write', kind: 'path', value: 'x', verified: true }] },
      evidenceCount: 1,
    }],
    ['completed_limited', 'warning', 'Completed \u00b7 limited evidence', {
      status: 'completed_unverified',
      meaningfulEvidenceRequirement: true,
    }],
    ['completed', 'info', 'Completed', {}],
  ] as const)('%s has stable semantics', (kind, severity, label, overrides) => {
    const result = mapTaskOutcomePresentation(input(overrides as Partial<TaskOutcomePresentationInput>));
    expect(result).toMatchObject({ kind, severity, label });
    expect(result.prominent).toBe(['timed_out', 'failed', 'partial', 'unverified_required'].includes(kind));
  });

  it.each([
    [{ timedOut: true, cancelled: true, denied: true, executionFailed: true }, 'timed_out'],
    [{ cancelled: true, denied: true, executionFailed: true }, 'cancelled'],
    [{ denied: true, executionFailed: true }, 'denied'],
    [{ executionFailed: true, partial: true, requiredEvidenceGap: true }, 'failed'],
    [{ partial: true, requiredEvidenceGap: true }, 'partial'],
  ] as const)('applies deterministic precedence', (overrides, expected) => {
    expect(mapTaskOutcomePresentation(input(overrides)).kind).toBe(expected);
  });

  it.each([
    [{ requiredCompletedCount: 1, requiredDeniedCount: 1, executionFailed: true }, 'partial'],
    [{ requiredCompletedCount: 1, requiredFailedCount: 1, executionFailed: true }, 'partial'],
    [{ requiredCompletedCount: 1, requiredUnresolvedCount: 1 }, 'partial'],
    [{ requiredCompletedCount: 1, requiredSkippedCount: 1 }, 'partial'],
    [{ requiredCompletedCount: 1, timedOut: true }, 'partial'],
    [{ requiredCompletedCount: 1, cancelled: true }, 'partial'],
    [{ requiredCompletedCount: 0, requiredDeniedCount: 1, denied: true, executionStarted: false }, 'denied'],
    [{ requiredCompletedCount: 0, requiredFailedCount: 1, executionFailed: true }, 'failed'],
    [{ requiredCompletedCount: 0, requiredDeniedCount: 1, denied: true, executionStarted: false, requiredEvidenceGap: true }, 'denied'],
    [{
      requiredCompletedCount: 1,
      optionalDeniedCount: 1,
      outcome: { kind: 'verified', handles: [{ tool: 'file_write', kind: 'path', value: 'required.txt', verified: true }] },
      evidenceCount: 1,
    }, 'verified'],
  ] as const)('uses structured required-work precedence for %#', (overrides, expected) => {
    expect(mapTaskOutcomePresentation(input(overrides as Partial<TaskOutcomePresentationInput>)).kind).toBe(expected);
  });

  it('never calls zero-evidence execution verified', () => {
    expect(mapTaskOutcomePresentation(input()).kind).toBe('completed');
  });

  it('treats successful completion-only empty output as Completed', () => {
    expect(mapTaskOutcomePresentation(input({
      status: 'completed_unverified',
      completionOnlyNoOutput: true,
      meaningfulEvidenceRequirement: false,
    })).kind).toBe('completed');
  });

  it('keeps an empty-output required mutation prominent', () => {
    expect(mapTaskOutcomePresentation(input({
      status: 'verification_failed',
      completionOnlyNoOutput: false,
      meaningfulEvidenceRequirement: true,
      requiredEvidenceGap: true,
    })).kind).toBe('unverified_required');
  });

  it('keeps inspectability metadata serializable', () => {
    const result = mapTaskOutcomePresentation(input({ taskId: '42', evidenceCount: 2 }));
    expect(result).toMatchObject({ taskId: '42', evidenceCount: 2, inspectable: true });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it.each([
    ['approval denial', 'denied', [{ name: 'file_write', result: null, error: 'Tool execution denied by approval engine — policy', handlerMutates: true }]],
    ['approval interruption', 'cancelled', [{
      name: 'file_write',
      result: null,
      error: 'Approval interrupted before tool execution.',
      handlerMutates: true,
      approvalDecision: { state: 'interrupted', approved: false },
    }]],
    ['batch cancellation', 'cancelled', [{ name: 'plan_approval', result: { status: 'cancelled' }, handlerMutates: false }]],
    ['batch invalid exhaustion', 'cancelled', [{ name: 'plan_approval', result: { status: 'invalid' }, handlerMutates: false }]],
    ['hard security block', 'failed', [{
      name: 'shell_exec',
      result: null,
      error: 'Tool execution blocked by the approval safety floor.',
      handlerMutates: true,
      approvalDecision: { state: 'blocked', approved: false },
    }]],
    ['clarification cancellation', 'cancelled', [{ name: 'clarify', result: { status: 'cancelled' }, handlerMutates: false }]],
    ['structured timeout', 'timed_out', [{ name: 'shell_exec', result: null, error: 'stopped', handlerMutates: true, classification: { category: 'timeout', confidence: 1, recoverable: false } }]],
    ['execution failure', 'failed', [{ name: 'file_write', result: null, error: 'disk error', handlerMutates: true }]],
  ] as const)('derives %s without parsing assistant prose', (_name, expected, trace) => {
    const finalization = {
      status: 'verification_failed' as const,
      outcome: { kind: 'failed' as const, failures: [{ tool: 'x', reason: 'x' }] as const },
      evidence: { handles: [], failures: [{ tool: 'x', reason: 'x' }] },
    };
    const mapped = mapTaskOutcomePresentation(taskOutcomeInputFromFinalization({
      finalization,
      trace: trace as never,
      finishReason: 'stop',
    }));
    expect(mapped.kind).toBe(expected);
  });

  it('derives partial when one mutation lands and another fails', () => {
    const finalization = {
      status: 'verification_failed' as const,
      outcome: { kind: 'failed' as const, failures: [{ tool: 'file_write', reason: 'missing' }] as const },
      evidence: { handles: [{ verified: true }], failures: [{ tool: 'file_write', reason: 'missing' }] },
    };
    const trace = [
      { name: 'file_write', result: { path: 'a', bytesWritten: 1 }, handlerMutates: true, verification: { ok: true, confidence: 1, code: 'ok' } },
      { name: 'file_write', result: null, error: 'disk error', handlerMutates: true, verification: { ok: false, confidence: 1, code: 'failed' } },
    ];
    const mapped = mapTaskOutcomePresentation(taskOutcomeInputFromFinalization({ finalization, trace: trace as never, finishReason: 'stop' }));
    expect(mapped.kind).toBe('partial');
  });

  it('derives completion-only no-output without weakening persisted finalization', () => {
    const finalization = {
      status: 'completed_unverified' as const,
      outcome: { kind: 'unverifiable' as const, reason: 'weak' },
      evidence: { handles: [], failures: [] },
    };
    const trace = [{
      name: 'shell_exec',
      result: { exitCode: 0, stdout: '' },
      handlerMutates: true,
      verification: { ok: true, confidence: 0.4, code: 'low_signal', reason: 'exit 0 with empty stdout' },
    }];
    const mapped = mapTaskOutcomePresentation(taskOutcomeInputFromFinalization({ finalization, trace: trace as never, finishReason: 'stop' }));
    expect(mapped.kind).toBe('completed');
    expect(finalization.status).toBe('completed_unverified');
  });

  it('maps one verified required mutation plus one declined required plan operation to partial', () => {
    const finalization = {
      status: 'completed' as const,
      outcome: { kind: 'verified' as const, handles: [{ tool: 'file_write', kind: 'path' as const, value: 'approved.txt', verified: true }] as const },
      evidence: {
        handles: [{ verified: true }],
        failures: [],
        declined: [{ tool: 'file_write', target: 'denied.txt', reason: 'not approved' }],
      },
    };
    const trace = [
      { name: 'plan_approval', result: { approvedCount: 1, declinedCount: 1, declined: [{ tool: 'file_write', args: { path: 'denied.txt' }, reason: 'not approved' }] }, handlerMutates: false },
      { name: 'file_write', result: { path: 'approved.txt', bytesWritten: 1 }, handlerMutates: true, verification: { ok: true, confidence: 1, code: 'ok' } },
    ];
    const mapped = mapTaskOutcomePresentation(taskOutcomeInputFromFinalization({ finalization, trace: trace as never, finishReason: 'stop' }));
    expect(mapped.kind).toBe('partial');
    expect(mapped.evidenceCount).toBe(1);
    expect(mapped.requiredCompletedCount).toBe(1);
    expect(mapped.requiredDeniedCount).toBe(1);
    expect(mapped.inspectable).toBe(true);
  });

  it('keeps a verified required write plus a required decline partial when a denied-target absence check and generic failure follow', () => {
    const trace = [
      {
        name: 'plan_approval',
        result: {
          approvedCount: 1,
          declinedCount: 1,
          approved: [{ tool: 'file_write', args: { path: 'approved.txt', content: 'approved' }, reason: 'required A', required: true }],
          declined: [{ tool: 'file_write', args: { path: 'denied.txt', content: 'denied' }, reason: 'required B', required: true }],
        },
        handlerMutates: false,
        verification: { ok: true, confidence: 1, code: 'ok' },
      },
      {
        name: 'file_write',
        result: { success: true, path: 'approved.txt', bytesWritten: 8 },
        handlerMutates: true,
        verification: { ok: true, confidence: 1, code: 'ok' },
      },
      {
        name: 'file_read',
        result: { success: true, path: 'approved.txt', content: 'approved' },
        handlerMutates: false,
        verification: { ok: true, confidence: 1, code: 'ok' },
      },
      {
        name: 'file_read',
        result: { success: false, path: 'denied.txt' },
        error: 'ENOENT: denied.txt does not exist',
        handlerMutates: false,
        verification: { ok: false, confidence: 1, code: 'failed', reason: 'not found' },
      },
    ];
    const finalization = computeTaskFinalization({
      finishReason: 'stop',
      declaredStatus: 'failure',
      toolCallTrace: trace as never,
    });
    const mapped = mapTaskOutcomePresentation(taskOutcomeInputFromFinalization({
      finalization,
      trace: trace as never,
      finishReason: 'stop',
      taskId: 'task_partial_physical',
    }));

    expect(finalization.status).toBe('failed');
    expect(finalization.evidence.declined).toEqual([
      { tool: 'file_write', target: 'denied.txt', reason: 'required B' },
    ]);
    expect(finalization.evidence.handles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'file_write', value: 'approved.txt', verified: true }),
    ]));
    expect(mapped).toMatchObject({
      kind: 'partial',
      label: 'Partially completed',
      requiredCompletedCount: 1,
      requiredDeniedCount: 1,
      requiredFailedCount: 0,
    });
  });

  it('maps a wholly declined required plan to denied without execution failure language', () => {
    const finalization = {
      status: 'completed' as const,
      outcome: { kind: 'no_evidence' as const },
      evidence: { handles: [], failures: [], declined: [{ tool: 'file_write', target: 'denied.txt', reason: 'not approved' }] },
    };
    const trace = [{
      name: 'plan_approval',
      result: { approvedCount: 0, declinedCount: 1, declined: [{ tool: 'file_write', args: { path: 'denied.txt' }, reason: 'not approved' }] },
      handlerMutates: false,
    }];
    const mapped = mapTaskOutcomePresentation(taskOutcomeInputFromFinalization({ finalization, trace: trace as never, finishReason: 'stop' }));
    expect(mapped.kind).toBe('denied');
    expect(mapped.executionStarted).toBe(false);
    expect(mapped.hasRequiredEvidenceGap).toBe(false);
  });

  it('does not downgrade verified required work for an explicitly optional declined operation', () => {
    const finalization = {
      status: 'completed' as const,
      outcome: { kind: 'verified' as const, handles: [{ tool: 'file_write', kind: 'path' as const, value: 'required.txt', verified: true }] as const },
      evidence: { handles: [{ verified: true }], failures: [], declined: [] },
    };
    const trace = [
      { name: 'plan_approval', result: { approvedCount: 1, declinedCount: 1, declined: [{ tool: 'file_write', args: { path: 'courtesy.txt' }, reason: 'optional', required: false }] }, handlerMutates: false },
      { name: 'file_write', result: { path: 'required.txt', bytesWritten: 1 }, handlerMutates: true, verification: { ok: true, confidence: 1, code: 'ok' } },
    ];
    const mapped = mapTaskOutcomePresentation(taskOutcomeInputFromFinalization({ finalization, trace: trace as never, finishReason: 'stop' }));
    expect(mapped.kind).toBe('verified');
    expect(mapped.requiredDeniedCount).toBe(0);
    expect(mapped.optionalDeniedCount).toBe(1);
  });
});
