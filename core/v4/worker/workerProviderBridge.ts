/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ProviderAdapter, ProviderCallInput, ProviderCallOutput, StreamEvent } from '../../../providers/v4/types';
import {
  computeProviderRequestHash,
  computeProviderResponseHash,
  computeProviderToolSchemaHash,
  currentProviderAttemptLedger,
  extractProviderRequestId,
} from '../../../providers/v4/providerAttemptAccounting';
import type { ProviderAttemptRecord } from '../usageLedger';
import type { DurableJobHandle } from '../daemon/jobLifecycle';
import type { JobEngine } from '../daemon/jobEngine';
import type { JobBudgetKind, JobBudgetReservationRecord } from '../daemon/jobResourceAuthority';
import { computeWorkerDigest, type WorkerAssignmentRecord, type WorkerProviderBindingRecord, type WorkerRunRecord } from './types';

export interface DurableWorkerProviderBridge {
  adapter: ProviderAdapter;
  linkToolCall(call: { id: string; name: string; arguments: unknown }): void;
  completeAcceptedCalls(): void;
}

interface BridgeOptions {
  engine: JobEngine;
  handle: DurableJobHandle;
  assignment: WorkerAssignmentRecord;
  workerRun: WorkerRunRecord;
  binding: WorkerProviderBindingRecord;
  reservation: JobBudgetReservationRecord;
  adapter: ProviderAdapter;
}

function authority(options: BridgeOptions) {
  return {
    childJobId: options.handle.jobId,
    childAttemptId: options.handle.attemptId,
    childGeneration: options.handle.generation,
    childFenceToken: options.handle.fenceToken,
  };
}

function event(options: BridgeOptions, type: string, payload: Record<string, unknown>, idempotencyKey: string): void {
  const result = options.engine.appendJobEvent({
    jobId: options.handle.jobId,
    attemptId: options.handle.attemptId,
    generation: options.handle.generation,
    type,
    payload,
    producer: 'repository-worker-provider-bridge',
    idempotencyKey,
  });
  if (!result.applied && !result.duplicate) throw new Error(`Worker provider event rejected: ${result.conflict ?? 'unknown'}`);
}

function knownZero(attempt: ProviderAttemptRecord): boolean {
  return attempt.status === 'failed_before_send'
    || attempt.errorClass === 'rate_limit'
    || attempt.errorClass === 'authentication'
    || attempt.errorClass === 'context_overflow'
    || attempt.errorClass === 'request_size_limit';
}

function usageValue(attempt: ProviderAttemptRecord, kind: JobBudgetKind): number | null {
  if (knownZero(attempt)) return 0;
  if (kind === 'input_tokens') return attempt.providerInputTokens;
  if (kind === 'output_tokens') return attempt.providerOutputTokens;
  if (kind === 'reasoning_tokens') return attempt.providerReasoningTokens;
  if (kind === 'external_cost') return attempt.costStatus === 'unknown' ? null : attempt.costAmount;
  if (kind === 'output_bytes') return attempt.responseBytes;
  return null;
}

function failureOutcome(attempts: readonly ProviderAttemptRecord[], error: unknown): {
  kind: string; known: boolean; cancelled: boolean;
} {
  const cancelled = error instanceof Error && error.name === 'AbortError';
  if (cancelled) return { kind: 'cancelled', known: false, cancelled: true };
  const missingAcceptance = error instanceof Error && /returned without|not linked|response/i.test(error.message);
  const ambiguous = missingAcceptance || attempts.some((attempt) => (
    attempt.status === 'success'
    ||
    attempt.status === 'failed_after_send' || attempt.status === 'timeout' || attempt.status === 'interrupted'
  ));
  const finalClass = attempts.length > 0 ? attempts[attempts.length - 1]?.errorClass : undefined;
  return {
    kind: finalClass && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(finalClass) ? finalClass : 'provider_failure',
    known: !ambiguous,
    cancelled: false,
  };
}

export function createDurableWorkerProviderBridge(options: BridgeOptions): DurableWorkerProviderBridge {
  let activeLogicalCallId: string | null = null;

  const reservationItem = (kind: JobBudgetKind) => options.engine.resources
    .getWorkerReservation(options.reservation.reservationId)?.items.find((item) => item.kind === kind);

  const commit = (
    logicalCallId: string,
    attempt: ProviderAttemptRecord,
    kind: JobBudgetKind,
    amount: number | null,
    idempotencyKey: string,
  ): void => {
    if (!reservationItem(kind)) return;
    const result = options.engine.resources.commitWorkerUsage({
      reservationId: options.reservation.reservationId,
      ...authority(options),
      kind,
      amount,
      certainty: amount === null ? 'unknown' : 'confirmed',
      sourceKind: 'provider_attempt',
      sourceId: attempt.callId,
      idempotencyKey,
    });
    event(options, 'worker.budget_commit_recorded', {
      reservationId: options.reservation.reservationId,
      logicalCallId,
      providerAttemptId: attempt.callId,
      kind,
      amountKnown: amount !== null,
      applied: result.applied,
      exhausted: result.exhausted === true,
    }, `worker-budget-commit:${options.reservation.reservationId}:${idempotencyKey}`);
  };

  const accountAttempts = (logicalCallId: string, attempts: readonly ProviderAttemptRecord[]): void => {
    attempts.forEach((attempt, index) => {
      commit(
        logicalCallId,
        attempt,
        'model_calls',
        1,
        index === 0 ? `model-call:${logicalCallId}` : `provider-attempt:${attempt.callId}:model-call`,
      );
      if (attempt.purpose === 'retry' || attempt.purpose === 'fallback') {
        commit(logicalCallId, attempt, 'retries', 1, `provider-attempt:${attempt.callId}:retry`);
      }
      for (const kind of ['input_tokens', 'output_tokens', 'reasoning_tokens', 'external_cost', 'output_bytes'] as const) {
        commit(logicalCallId, attempt, kind, usageValue(attempt, kind), `provider-attempt:${attempt.callId}:${kind}`);
      }
    });
  };

  const physicalAttempts = (logicalCallId: string): readonly ProviderAttemptRecord[] => {
    const ledger = currentProviderAttemptLedger();
    if (!ledger) throw new Error('Worker provider attempt ledger is unavailable');
    const attempts = ledger.query({ parentCallId: logicalCallId });
    for (const attempt of attempts) {
      if (attempt.workerRunId !== options.workerRun.workerRunId
        || attempt.providerBindingId !== options.binding.providerBindingId
        || attempt.jobId !== options.handle.jobId
        || attempt.attemptId !== options.handle.attemptId
        || attempt.attemptGeneration !== options.handle.generation) {
        throw new Error('Physical ProviderAttempt is not bound to the active Worker call');
      }
      const allowed = [options.binding, ...options.binding.fallbackBindingIds.map((id) => options.engine.worker.getWorkerProviderBinding(id))]
        .filter((item): item is WorkerProviderBindingRecord => item !== null);
      if (!allowed.some((item) => item.providerId === attempt.providerActual && item.modelId === attempt.modelActual)) {
        throw new Error('Physical ProviderAttempt used an unapproved provider binding');
      }
    }
    return attempts;
  };

  const completeActive = (): void => {
    if (!activeLogicalCallId) return;
    const call = options.engine.workerProviderCalls.get(activeLogicalCallId);
    if (call?.state === 'accepted' || call?.state === 'downstream_started') {
      options.engine.workerProviderCalls.complete({ ...authority(options), logicalCallId: activeLogicalCallId });
      event(options, 'worker.logical_call_completed', {
        logicalCallId: activeLogicalCallId,
        workerRunId: options.workerRun.workerRunId,
      }, `worker-logical-call-completed:${activeLogicalCallId}`);
    }
    activeLogicalCallId = null;
  };

  const runCall = async (input: ProviderCallInput, stream: boolean): Promise<ProviderCallOutput | StreamEvent[]> => {
    completeActive();
    const logicalCallId = input.usageContext?.logicalCallId;
    if (!logicalCallId) throw new Error('Worker provider call is missing a logical identity');
    const ordinal = options.engine.workerProviderCalls.listForWorkerRun(options.workerRun.workerRunId).length + 1;
    const requestHash = computeProviderRequestHash(input);
    const toolSchemaHash = computeProviderToolSchemaHash(input);
    const prepared = options.engine.workerProviderCalls.prepare({
      ...authority(options),
      logicalCallId,
      idempotencyKey: `worker-provider-call:${options.workerRun.workerRunId}:${ordinal}`,
      workerRunId: options.workerRun.workerRunId,
      assignmentId: options.assignment.assignmentId,
      providerBindingId: options.binding.providerBindingId,
      callOrdinal: ordinal,
      requestHash,
      toolSchemaHash,
    });
    const modelBudget = reservationItem('model_calls');
    if (!modelBudget || modelBudget.hasUnknownUsage
      || modelBudget.committed + modelBudget.released >= modelBudget.reserved) {
      options.engine.workerProviderCalls.fail({
        ...authority(options), logicalCallId, failureKind: 'budget_exhausted', outcomeKnown: true,
      });
      event(options, 'worker.provider_attempt_failed', {
        logicalCallId,
        failureKind: 'budget_exhausted',
        outcomeKnown: true,
      }, `worker-provider-failed:${logicalCallId}`);
      throw new Error('Worker model-call budget exhausted before provider send');
    }
    options.engine.workerProviderCalls.markAttempting({ ...authority(options), logicalCallId });
    event(options, 'worker.logical_call_prepared', {
      logicalCallId,
      workerRunId: options.workerRun.workerRunId,
      providerBindingId: options.binding.providerBindingId,
      callOrdinal: prepared.callOrdinal,
      requestHash,
      toolSchemaHash,
    }, `worker-logical-call-prepared:${logicalCallId}`);
    const forwarded: ProviderCallInput = {
      ...input,
      stream,
      usageContext: {
        ...input.usageContext,
        logicalCallId,
        jobId: options.handle.jobId,
        attemptId: options.handle.attemptId,
        attemptGeneration: options.handle.generation,
        workerRunId: options.workerRun.workerRunId,
        providerBindingId: options.binding.providerBindingId,
        providerConfigured: options.binding.providerId,
        modelConfigured: options.binding.modelId,
      },
    };
    try {
      let output: ProviderCallOutput;
      let events: StreamEvent[] | null = null;
      if (stream) {
        events = [];
        if (typeof options.adapter.callStream === 'function') {
          for await (const item of options.adapter.callStream(forwarded)) {
            events.push(item);
          }
          let done: Extract<StreamEvent, { type: 'done' }> | undefined;
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const candidate = events[index];
            if (candidate?.type === 'done') { done = candidate; break; }
          }
          if (!done) throw new Error('Worker provider stream closed without a terminal response');
          output = done.output;
        } else {
          output = await options.adapter.call(forwarded);
          events.push({ type: 'done', output });
        }
      } else {
        output = await options.adapter.call(forwarded);
      }
      const attempts = physicalAttempts(logicalCallId);
      if (attempts.length === 0) throw new Error('Worker provider returned without a physical ProviderAttempt record');
      const responseHash = computeProviderResponseHash(output);
      let acceptedAttempt: ProviderAttemptRecord | undefined;
      for (let index = attempts.length - 1; index >= 0; index -= 1) {
        const candidate = attempts[index];
        if (candidate?.status === 'success' && candidate.responseHash === responseHash) {
          acceptedAttempt = candidate;
          break;
        }
      }
      if (!acceptedAttempt) throw new Error('Worker provider response is not linked to a successful physical attempt');
      accountAttempts(logicalCallId, attempts);
      options.engine.workerProviderCalls.recordResponseReceived({
        ...authority(options),
        logicalCallId,
        providerAttemptId: acceptedAttempt.callId,
        responseHash,
        providerRequestId: acceptedAttempt.providerRequestId ?? extractProviderRequestId(output),
      });
      event(options, 'worker.provider_response_received', {
        logicalCallId,
        providerAttemptId: acceptedAttempt.callId,
        responseHash,
      }, `worker-provider-response-received:${logicalCallId}`);
      options.engine.workerProviderCalls.acceptResponse({
        ...authority(options), logicalCallId, providerAttemptId: acceptedAttempt.callId, responseHash,
      });
      event(options, 'worker.provider_response_accepted', {
        logicalCallId,
        providerAttemptId: acceptedAttempt.callId,
        responseHash,
      }, `worker-provider-response-accepted:${logicalCallId}`);
      if (output.toolCalls.length > 0) {
        options.engine.workerProviderCalls.markDownstreamStarted({ ...authority(options), logicalCallId });
        event(options, 'worker.provider_downstream_started', {
          logicalCallId,
          toolCallCount: output.toolCalls.length,
        }, `worker-provider-downstream-started:${logicalCallId}`);
      }
      activeLogicalCallId = logicalCallId;
      return events ?? output;
    } catch (error) {
      const attempts = currentProviderAttemptLedger()?.query({ parentCallId: logicalCallId }) ?? [];
      if (attempts.length > 0) accountAttempts(logicalCallId, attempts);
      const call = options.engine.workerProviderCalls.get(logicalCallId);
      if (call && call.state !== 'accepted' && call.state !== 'downstream_started' && call.state !== 'completed') {
        const failure = failureOutcome(attempts, error);
        options.engine.workerProviderCalls.fail({
          ...authority(options), logicalCallId, failureKind: failure.kind,
          outcomeKnown: failure.known, cancelled: failure.cancelled,
        });
        event(options, failure.known ? 'worker.provider_attempt_failed' : 'worker.logical_call_unknown', {
          logicalCallId,
          failureKind: failure.kind,
          outcomeKnown: failure.known,
        }, `worker-provider-failed:${logicalCallId}`);
      }
      throw error;
    }
  };

  const adapter: ProviderAdapter = {
    apiMode: options.adapter.apiMode,
    async call(input) {
      return runCall(input, false) as Promise<ProviderCallOutput>;
    },
    ...(options.adapter.callStream ? {
      async *callStream(input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void> {
        const events = await runCall(input, true) as StreamEvent[];
        for (const item of events) yield item;
      },
    } : {}),
  };

  return {
    adapter,
    linkToolCall(call) {
      if (!activeLogicalCallId) throw new Error('Worker tool call has no accepted provider response');
      options.engine.workerProviderCalls.linkToolCall({
        ...authority(options),
        logicalCallId: activeLogicalCallId,
        providerToolCallId: call.id,
        toolName: call.name,
        argumentsHash: computeWorkerDigest(call.arguments),
      });
    },
    completeAcceptedCalls: completeActive,
  };
}
