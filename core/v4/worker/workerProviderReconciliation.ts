/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { JobEngine, WorkerAttemptReconciliationSummary } from '../daemon/jobEngine';
import type { ProviderAttemptLedger, ProviderAttemptRecord } from '../usageLedger';
import type {
  WorkerLogicalProviderCallRecord,
  WorkerProviderCallReconciliationResult,
} from './types';
import type { WorkerProviderPhysicalAttemptFact } from './workerProviderCallAuthority';
import { workerProviderUsageFacts } from './workerProviderUsage';

export interface WorkerProviderRecoverySummary {
  inspected: number;
  reconciled: number;
  safe: number;
  unsafe: number;
  blockedUnknown: number;
  usageFacts: number;
  reservationsSettled: number;
  results: WorkerProviderCallReconciliationResult[];
}

function physicalFact(attempt: ProviderAttemptRecord): WorkerProviderPhysicalAttemptFact {
  const knownNoResponse = attempt.status === 'failed_before_send' || attempt.status === 'validation_error'
    || ['rate_limit', 'authentication', 'context_overflow', 'request_size_limit'].includes(attempt.errorClass ?? '');
  const usageKnown = knownNoResponse || attempt.providerInputTokens !== null
    || attempt.providerOutputTokens !== null || attempt.providerReasoningTokens !== null;
  return {
    providerAttemptId: attempt.callId,
    status: attempt.status,
    responseHash: attempt.responseHash,
    providerRequestId: attempt.providerRequestId,
    noResponseProven: knownNoResponse,
    usageKnown,
    costKnown: knownNoResponse || attempt.costStatus !== 'unknown',
  };
}

function exactAttempts(
  call: WorkerLogicalProviderCallRecord,
  ledger: ProviderAttemptLedger | null,
): readonly ProviderAttemptRecord[] {
  if (!ledger) return [];
  const attempts = ledger.query({ parentCallId: call.logicalCallId });
  for (const attempt of attempts) {
    if (attempt.workerRunId !== call.workerRunId || attempt.jobId !== call.childJobId
      || attempt.attemptId !== call.childAttemptId || attempt.attemptGeneration !== call.childGeneration
      || attempt.providerBindingId !== call.providerBindingId) {
      throw new Error('ProviderAttempt reconciliation lineage is invalid');
    }
  }
  return attempts;
}

function attemptIsCurrent(engine: JobEngine, call: WorkerLogicalProviderCallRecord, now: number): boolean {
  const attempt = engine.getAttempt(call.childAttemptId);
  const job = engine.getJob(call.childJobId);
  return Boolean(attempt && job && attempt.generation === call.childGeneration
    && job.activeAttemptId === call.childAttemptId
    && !/^(succeeded|completed|failed|cancelled|timed_out|crashed|unknown|interrupted)$/u.test(attempt.status)
    && (attempt.leaseExpiresAt === null || attempt.leaseExpiresAt > now));
}

export function reconcileWorkerProviderCall(input: {
  engine: JobEngine;
  ledger: ProviderAttemptLedger | null;
  call: WorkerLogicalProviderCallRecord;
  ownerId: string;
  producer: string;
  reason: string;
  now?: number;
}): { result: WorkerProviderCallReconciliationResult; usageFacts: number; reservationSettled: boolean } {
  const now = input.now ?? Date.now();
  let call = input.call;
  const terminalCall = ['completed', 'failed', 'cancelled', 'unknown'].includes(call.state);
  if (!terminalCall && !attemptIsCurrent(input.engine, call, now) && call.authorityLostAt === null) {
    call = input.engine.workerProviderCalls.markAuthorityLost({
      logicalCallId: call.logicalCallId,
      workerRunId: call.workerRunId,
      childJobId: call.childJobId,
      childAttemptId: call.childAttemptId,
      childGeneration: call.childGeneration,
      kind: 'authority_lost',
      reason: input.reason,
      idempotencyKey: `worker-authority-lost:${call.logicalCallId}:${call.childGeneration}`,
      now,
    });
  }
  const attempts = exactAttempts(call, input.ledger);
  const facts = attempts.map(physicalFact);
  const result = input.engine.workerProviderCalls.reconcile({
    logicalCallId: call.logicalCallId,
    workerRunId: call.workerRunId,
    childJobId: call.childJobId,
    childAttemptId: call.childAttemptId,
    childGeneration: call.childGeneration,
    idempotencyKey: `worker-reconcile:${call.logicalCallId}:${call.childGeneration}`,
    reason: input.reason,
    physicalAttempts: facts,
    now,
  });
  const groupMember = input.engine.worker.getWorkerGroupMemberForAssignment(call.assignmentId);
  if (groupMember && (result.retrySafety === 'blocked_unknown' || result.outcomeKnowledge === 'outcome_unknown')) {
    const providerSlot = input.engine.resources.getWorkerProviderConcurrencyForMember(groupMember.memberId);
    if (providerSlot?.state === 'reserved') {
      input.engine.resources.settleWorkerProviderConcurrency({
        providerSlotId: providerSlot.providerSlotId,
        unknown: true,
        safeToRelease: false,
        reason: 'provider_outcome_unknown',
        now,
      });
    }
  }
  const reservation = input.engine.resources.getWorkerReservationForChild(call.childJobId);
  let usageFacts = 0;
  if (reservation && reservation.workerRunId === call.workerRunId) {
    attempts.forEach((attempt, index) => {
      for (const fact of workerProviderUsageFacts(call.logicalCallId, attempt, index)) {
        if (!reservation.items.some((item) => item.kind === fact.kind)) continue;
        const settled = input.engine.resources.reconcileWorkerUsage({
          reservationId: reservation.reservationId,
          logicalCallId: call.logicalCallId,
          kind: fact.kind,
          amount: fact.amount,
          certainty: fact.amount === null ? 'unknown' : 'confirmed',
          providerAttemptId: attempt.callId,
          idempotencyKey: fact.idempotencyKey,
          now,
        });
        if (settled.applied || settled.repaired) usageFacts += 1;
      }
    });
    const safeToRelease = !result.unknownSpend && !result.unsettledDownstream
      && result.outcomeKnowledge !== 'downstream_started';
    input.engine.resources.reconcileWorkerReservation({
      reservationId: reservation.reservationId,
      logicalCallId: call.logicalCallId,
      outcomeKnowledge: result.outcomeKnowledge,
      retrySafety: result.retrySafety,
      unknownSpend: result.unknownSpend,
      safeToRelease,
      reason: input.reason,
      idempotencyKey: `worker-reservation-reconcile:${call.logicalCallId}:${call.childGeneration}`,
      now,
    });
    input.engine.appendJobEvent({
      jobId: call.childJobId,
      attemptId: call.childAttemptId,
      generation: call.childGeneration,
      type: 'worker.provider_reservation_reconciled',
      payload: {
        logicalCallId: call.logicalCallId,
        reservationId: reservation.reservationId,
        unknownSpend: result.unknownSpend,
        safelyReleased: safeToRelease,
      },
      producer: input.producer,
      idempotencyKey: `worker-provider-reservation-reconciled:${call.logicalCallId}:${call.childGeneration}`,
    });
  }
  return { result, usageFacts, reservationSettled: reservation !== null };
}

export function reconcileWorkerProviderAttempt(input: {
  engine: JobEngine;
  ledger: ProviderAttemptLedger | null;
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  ownerId: string;
  producer: string;
  reason: string;
  now?: number;
}): WorkerAttemptReconciliationSummary {
  const results = input.engine.workerProviderCalls
    .listForAttempt(input.childAttemptId, input.childGeneration)
    .filter((call) => call.childJobId === input.childJobId)
    .map((call) => reconcileWorkerProviderCall({ ...input, call }).result);
  const retrySafety = results.some((entry) => entry.retrySafety === 'blocked_unknown')
    ? 'blocked_unknown'
    : results.some((entry) => entry.retrySafety === 'unsafe')
      ? 'unsafe'
      : results.some((entry) => entry.retrySafety === 'safe')
        ? 'safe'
        : 'not_applicable';
  return {
    calls: results.length,
    retrySafety,
    outcomeKnowledge: results.map((entry) => entry.outcomeKnowledge),
  };
}

export function sweepWorkerProviderReconciliation(input: {
  engine: JobEngine;
  ledger: ProviderAttemptLedger | null;
  ownerId: string;
  producer: string;
  limit?: number;
  now?: number;
}): WorkerProviderRecoverySummary {
  const now = input.now ?? Date.now();
  const summary: WorkerProviderRecoverySummary = {
    inspected: 0,
    reconciled: 0,
    safe: 0,
    unsafe: 0,
    blockedUnknown: 0,
    usageFacts: 0,
    reservationsSettled: 0,
    results: [],
  };
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000));
  let afterLogicalCallId = '';
  let scanned = 0;
  while (summary.inspected < limit && scanned < 1_000) {
    const batch = input.engine.workerProviderCalls.listPendingReconciliation({
      limit: Math.min(100, 1_000 - scanned),
      afterLogicalCallId,
    });
    if (batch.length === 0) break;
    scanned += batch.length;
    afterLogicalCallId = batch[batch.length - 1]!.logicalCallId;
    for (const call of batch) {
      if (summary.inspected >= limit) break;
      if (attemptIsCurrent(input.engine, call, now)) continue;
      summary.inspected += 1;
      const reconciled = reconcileWorkerProviderCall({
        ...input,
        call,
        reason: call.interruptionKind ?? 'restart',
        now,
      });
      summary.reconciled += 1;
      summary.usageFacts += reconciled.usageFacts;
      if (reconciled.reservationSettled) summary.reservationsSettled += 1;
      if (reconciled.result.retrySafety === 'safe') summary.safe += 1;
      else if (reconciled.result.retrySafety === 'blocked_unknown') summary.blockedUnknown += 1;
      else summary.unsafe += 1;
      summary.results.push(reconciled.result);
    }
  }
  return summary;
}
