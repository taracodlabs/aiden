/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bindRun, createWorkerFixture, type WorkerFixture } from './fixture';

describe('Worker logical provider-call authority', () => {
  let fixture: WorkerFixture | undefined;
  const make = () => (fixture = createWorkerFixture());
  afterEach(() => fixture?.db.close());

  function prepared() {
    const current = make();
    const records = bindRun(current);
    const command = {
      ...current.childAuthority,
      logicalCallId: 'logical_worker_one',
      idempotencyKey: 'logical-one',
      workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId,
      providerBindingId: records.providerBinding.providerBindingId,
      callOrdinal: 1,
      requestHash: 'c'.repeat(64),
      toolSchemaHash: 'd'.repeat(64),
      now: 30,
    };
    return { current, records, command, call: current.engine.workerProviderCalls.prepare(command) };
  }

  it('persists the exact WorkerRun, child generation, binding, and request hashes before send', () => {
    const { current, records, command, call } = prepared();
    expect(call).toMatchObject({
      logicalCallId: command.logicalCallId,
      workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId,
      providerBindingId: records.providerBinding.providerBindingId,
      childJobId: current.child.jobId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
      requestHash: command.requestHash,
      toolSchemaHash: command.toolSchemaHash,
      state: 'prepared',
    });
    expect(current.engine.workerProviderCalls.prepare(command)).toEqual(call);
    expect(() => current.engine.workerProviderCalls.prepare({ ...command, requestHash: 'e'.repeat(64) }))
      .toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }));
  });

  it('durably receives then accepts one physical response before linking downstream tools', () => {
    const { current, command } = prepared();
    current.engine.workerProviderCalls.markAttempting(command);
    const received = current.engine.workerProviderCalls.recordResponseReceived({
      ...command,
      providerAttemptId: 'physical_attempt_one',
      responseHash: 'e'.repeat(64),
      providerRequestId: 'request_one',
      now: 31,
    });
    expect(received).toMatchObject({
      state: 'response_received', acceptedProviderAttemptId: 'physical_attempt_one',
      responseHash: 'e'.repeat(64), providerRequestId: 'request_one',
    });
    const accepted = current.engine.workerProviderCalls.acceptResponse({
      ...command, providerAttemptId: 'physical_attempt_one', responseHash: 'e'.repeat(64), now: 32,
    });
    expect(accepted.state).toBe('accepted');
    expect(current.engine.workerProviderCalls.markDownstreamStarted(command).state).toBe('downstream_started');
    expect(current.engine.workerProviderCalls.linkToolCall({
      ...command,
      providerToolCallId: 'provider_tool_one',
      toolName: 'repository_snapshot_read',
      argumentsHash: 'f'.repeat(64),
    })).toEqual({ applied: true });
    expect(current.engine.workerProviderCalls.linkToolCall({
      ...command,
      providerToolCallId: 'provider_tool_one',
      toolName: 'repository_snapshot_read',
      argumentsHash: 'f'.repeat(64),
    })).toMatchObject({ applied: false, duplicate: true });
    expect(() => current.engine.workerProviderCalls.linkToolCall({
      ...command,
      providerToolCallId: 'provider_tool_one',
      toolName: 'repository_snapshot_read',
      argumentsHash: 'a'.repeat(64),
    })).toThrowError(expect.objectContaining({ code: 'tool_call_conflict' }));
  });

  it('allows only the first accepted physical response and rejects a conflicting duplicate', () => {
    const { current, command } = prepared();
    current.engine.workerProviderCalls.markAttempting(command);
    current.engine.workerProviderCalls.recordResponseReceived({
      ...command, providerAttemptId: 'physical_attempt_one', responseHash: 'e'.repeat(64),
    });
    current.engine.workerProviderCalls.acceptResponse({
      ...command, providerAttemptId: 'physical_attempt_one', responseHash: 'e'.repeat(64),
    });
    expect(current.engine.workerProviderCalls.acceptResponse({
      ...command, providerAttemptId: 'physical_attempt_one', responseHash: 'e'.repeat(64),
    }).state).toBe('accepted');
    expect(() => current.engine.workerProviderCalls.recordResponseReceived({
      ...command, providerAttemptId: 'physical_attempt_two', responseHash: 'a'.repeat(64),
    })).toThrowError(expect.objectContaining({ code: 'response_conflict' }));
    expect(() => current.engine.workerProviderCalls.fail({
      ...command, failureKind: 'late_failure', outcomeKnown: true,
    })).toThrowError(expect.objectContaining({ code: 'accepted_response' }));
  });

  it('records ambiguous post-send failure as unknown and blocks stale generations', () => {
    const { current, command } = prepared();
    current.engine.workerProviderCalls.markAttempting(command);
    expect(current.engine.workerProviderCalls.fail({
      ...command, failureKind: 'transport_unknown', outcomeKnown: false,
    })).toMatchObject({ state: 'unknown', outcomeKnown: false, failureKind: 'transport_unknown' });
    expect(current.engine.workerProviderCalls.listForWorkerRun(command.workerRunId)).toHaveLength(1);

    const next = { ...command, logicalCallId: 'logical_worker_two', idempotencyKey: 'logical-two', callOrdinal: 2 };
    current.engine.cancelJob({
      jobId: current.child.jobId, reason: 'cancelled', producer: 'test', eventIdempotencyKey: 'cancel-child',
    });
    expect(() => current.engine.workerProviderCalls.prepare(next))
      .toThrowError(expect.objectContaining({ code: 'stale_authority' }));
  });

  it('stores hashes and identifiers without raw prompts, responses, credentials, or fence tokens', () => {
    const { current, command } = prepared();
    current.engine.workerProviderCalls.markAttempting(command);
    current.engine.workerProviderCalls.recordResponseReceived({
      ...command, providerAttemptId: 'physical_attempt_one', responseHash: 'e'.repeat(64),
    });
    const raw = JSON.stringify(current.db.prepare('SELECT * FROM worker_logical_provider_calls').all());
    expect(raw).not.toContain('messages');
    expect(raw).not.toContain('authorization');
    expect(raw).not.toContain(current.childAuthority.childFenceToken);
    expect(raw).not.toContain('raw response');
  });

  it('persists cancellation intent before rejecting a late response', () => {
    const { current, command } = prepared();
    current.engine.workerProviderCalls.markAttempting(command);
    const cancelled = current.engine.workerProviderCalls.recordCancellationIntent({
      ...command,
      reason: 'job_cancelled',
      idempotencyKey: 'cancel-logical-one',
      now: 31,
    });
    expect(cancelled).toMatchObject({
      interruptionKind: 'cancellation',
      cancellationRequestedAt: 31,
      retrySafety: 'blocked_unknown',
    });
    expect(() => current.engine.workerProviderCalls.recordResponseReceived({
      ...command,
      providerAttemptId: 'physical_attempt_late',
      responseHash: 'e'.repeat(64),
      providerRequestId: 'request_late',
      now: 32,
    })).toThrowError(expect.objectContaining({ code: 'interrupted' }));
    const rejected = current.engine.workerProviderCalls.rejectLateResponse({
      logicalCallId: command.logicalCallId,
      workerRunId: command.workerRunId,
      childJobId: command.childJobId,
      childAttemptId: command.childAttemptId,
      childGeneration: command.childGeneration,
      providerAttemptId: 'physical_attempt_late',
      responseHash: 'e'.repeat(64),
      providerRequestId: 'request_late',
      reason: 'response_after_cancellation',
      idempotencyKey: 'late-logical-one',
      now: 32,
    });
    expect(rejected.call).toMatchObject({
      lateResponseObservedAt: 32,
      staleResponseRejectedAt: 32,
    });
    expect(current.engine.workerProviderCalls.rejectLateResponse({
      logicalCallId: command.logicalCallId,
      workerRunId: command.workerRunId,
      childJobId: command.childJobId,
      childAttemptId: command.childAttemptId,
      childGeneration: command.childGeneration,
      providerAttemptId: 'physical_attempt_late',
      responseHash: 'e'.repeat(64),
      providerRequestId: 'request_late',
      reason: 'response_after_cancellation',
      idempotencyKey: 'late-logical-one',
      now: 33,
    })).toMatchObject({ applied: false, duplicate: true });
    expect(() => current.engine.workerProviderCalls.rejectLateResponse({
      logicalCallId: command.logicalCallId,
      workerRunId: command.workerRunId,
      childJobId: command.childJobId,
      childAttemptId: command.childAttemptId,
      childGeneration: command.childGeneration,
      providerAttemptId: 'physical_attempt_late',
      responseHash: 'a'.repeat(64),
      providerRequestId: 'request_late',
      reason: 'response_after_cancellation',
      idempotencyKey: 'late-logical-one',
      now: 34,
    })).toThrowError(expect.objectContaining({ code: 'late_response_conflict' }));
  });

  it('classifies restart recovery from canonical physical-attempt facts', () => {
    const { current, command } = prepared();
    const safe = current.engine.workerProviderCalls.markAuthorityLost({
      logicalCallId: command.logicalCallId,
      workerRunId: command.workerRunId,
      childJobId: command.childJobId,
      childAttemptId: command.childAttemptId,
      childGeneration: command.childGeneration,
      kind: 'lease_expired',
      reason: 'restart',
      idempotencyKey: 'authority-lost-prepared',
      now: 60_011,
    });
    expect(safe.retrySafety).toBe('safe');
    expect(current.engine.workerProviderCalls.reconcile({
      logicalCallId: command.logicalCallId,
      workerRunId: command.workerRunId,
      childJobId: command.childJobId,
      childAttemptId: command.childAttemptId,
      childGeneration: command.childGeneration,
      physicalAttempts: [],
      reason: 'restart',
      idempotencyKey: 'reconcile-prepared',
      now: 60_012,
    })).toMatchObject({ outcomeKnowledge: 'no_request_started', retrySafety: 'safe' });

    current.db.close();
    const second = prepared();
    second.current.engine.workerProviderCalls.markAttempting(second.command);
    second.current.engine.workerProviderCalls.markAuthorityLost({
      logicalCallId: second.command.logicalCallId,
      workerRunId: second.command.workerRunId,
      childJobId: second.command.childJobId,
      childAttemptId: second.command.childAttemptId,
      childGeneration: second.command.childGeneration,
      kind: 'lease_expired',
      reason: 'restart',
      idempotencyKey: 'authority-lost-attempting',
      now: 60_011,
    });
    expect(second.current.engine.workerProviderCalls.reconcile({
      logicalCallId: second.command.logicalCallId,
      workerRunId: second.command.workerRunId,
      childJobId: second.command.childJobId,
      childAttemptId: second.command.childAttemptId,
      childGeneration: second.command.childGeneration,
      physicalAttempts: [{ providerAttemptId: 'physical_unknown', status: 'attempting' }],
      unknownSpend: true,
      reason: 'restart',
      idempotencyKey: 'reconcile-attempting',
      now: 60_012,
    })).toMatchObject({ outcomeKnowledge: 'outcome_unknown', retrySafety: 'blocked_unknown' });
  });

  it('distinguishes a pre-send timeout from an ambiguous in-flight timeout', () => {
    const first = prepared();
    expect(first.current.engine.workerProviderCalls.recordTimeoutIntent({
      ...first.command,
      reason: 'runtime_budget_exceeded',
      idempotencyKey: 'timeout-before-send',
      now: 31,
    })).toMatchObject({
      interruptionKind: 'timeout', timeoutRequestedAt: 31,
      outcomeKnowledge: 'no_request_started', retrySafety: 'safe',
    });
    first.current.db.close();

    const second = prepared();
    second.current.engine.workerProviderCalls.markAttempting(second.command);
    expect(second.current.engine.workerProviderCalls.recordTimeoutIntent({
      ...second.command,
      reason: 'runtime_budget_exceeded',
      idempotencyKey: 'timeout-in-flight',
      now: 31,
    })).toMatchObject({
      interruptionKind: 'timeout', timeoutRequestedAt: 31,
      outcomeKnowledge: 'outcome_unknown', retrySafety: 'blocked_unknown',
    });
  });

  it('records a bounded human-readable parent cancellation reason for every active call', () => {
    const { current, command } = prepared();
    current.engine.workerProviderCalls.markAttempting(command);
    expect(() => current.engine.workerProviderCalls.recordCancellationIntent({
      ...command,
      reason: 'invalid\nreason',
      idempotencyKey: 'cancel-invalid-control',
    })).toThrowError(expect.objectContaining({ code: 'invalid_contract' }));
    expect(() => current.engine.workerProviderCalls.recordCancellationIntent({
      ...command,
      reason: 'x'.repeat(513),
      idempotencyKey: 'cancel-invalid-length',
    })).toThrowError(expect.objectContaining({ code: 'invalid_contract' }));
    const [cancelled] = current.engine.workerProviderCalls.recordInterruptionForAttempt({
      ...current.childAuthority,
      kind: 'cancellation',
      reason: 'parent cancel: stopped from workbench web',
      idempotencyKey: 'cancel-parent-worker-call',
      now: 33,
    });
    expect(cancelled).toMatchObject({
      logicalCallId: command.logicalCallId,
      interruptionKind: 'cancellation',
      cancellationRequestedAt: 33,
      reconciliationReason: 'parent cancel: stopped from workbench web',
    });
  });
});
