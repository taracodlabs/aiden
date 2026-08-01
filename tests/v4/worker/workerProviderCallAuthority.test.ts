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
});
