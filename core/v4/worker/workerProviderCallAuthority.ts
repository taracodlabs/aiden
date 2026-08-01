/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import type {
  WorkerLogicalProviderCallRecord,
  WorkerLogicalProviderCallState,
  WorkerProviderCallInterruptionKind,
  WorkerProviderCallOutcomeKnowledge,
  WorkerProviderCallReconciliationResult,
  WorkerProviderCallReconciliationState,
  WorkerProviderCallRetrySafety,
} from './types';

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const TERMINAL = new Set<WorkerLogicalProviderCallState>(['completed', 'failed', 'cancelled', 'unknown']);

export class WorkerProviderCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkerProviderCallError';
  }
}

interface AuthorityCommand {
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  childFenceToken: string;
  now?: number;
}

export interface PrepareWorkerProviderCallCommand extends AuthorityCommand {
  logicalCallId: string;
  idempotencyKey: string;
  workerRunId: string;
  assignmentId: string;
  providerBindingId: string;
  callOrdinal: number;
  requestHash: string;
  toolSchemaHash: string;
}

export interface WorkerProviderPhysicalAttemptFact {
  providerAttemptId: string;
  status: string;
  responseHash?: string | null;
  providerRequestId?: string | null;
  noResponseProven?: boolean;
  usageKnown?: boolean;
  costKnown?: boolean;
}

interface ReconciliationLineageCommand {
  logicalCallId: string;
  workerRunId: string;
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  idempotencyKey: string;
  reason: string;
  now?: number;
}

export interface WorkerProviderCallAuthority {
  prepare(command: PrepareWorkerProviderCallCommand): WorkerLogicalProviderCallRecord;
  markAttempting(command: AuthorityCommand & { logicalCallId: string }): WorkerLogicalProviderCallRecord;
  recordResponseReceived(command: AuthorityCommand & {
    logicalCallId: string;
    providerAttemptId: string;
    responseHash: string;
    providerRequestId?: string | null;
  }): WorkerLogicalProviderCallRecord;
  acceptResponse(command: AuthorityCommand & {
    logicalCallId: string;
    providerAttemptId: string;
    responseHash: string;
  }): WorkerLogicalProviderCallRecord;
  markDownstreamStarted(command: AuthorityCommand & { logicalCallId: string }): WorkerLogicalProviderCallRecord;
  linkToolCall(command: AuthorityCommand & {
    logicalCallId: string;
    providerToolCallId: string;
    toolName: string;
    argumentsHash: string;
  }): { applied: boolean; duplicate?: boolean };
  complete(command: AuthorityCommand & { logicalCallId: string }): WorkerLogicalProviderCallRecord;
  fail(command: AuthorityCommand & {
    logicalCallId: string;
    failureKind: string;
    outcomeKnown: boolean;
    cancelled?: boolean;
  }): WorkerLogicalProviderCallRecord;
  recordCancellationIntent(command: AuthorityCommand & {
    logicalCallId: string;
    reason: string;
    idempotencyKey: string;
  }): WorkerLogicalProviderCallRecord;
  recordTimeoutIntent(command: AuthorityCommand & {
    logicalCallId: string;
    reason: string;
    idempotencyKey: string;
  }): WorkerLogicalProviderCallRecord;
  recordInterruptionForAttempt(command: AuthorityCommand & {
    kind: 'cancellation' | 'timeout';
    reason: string;
    idempotencyKey: string;
  }): WorkerLogicalProviderCallRecord[];
  markAuthorityLost(command: ReconciliationLineageCommand & {
    kind: 'lease_expired' | 'authority_lost';
  }): WorkerLogicalProviderCallRecord;
  markAuthorityLostForAttempt(command: {
    childJobId: string;
    childAttemptId: string;
    childGeneration: number;
    kind: 'lease_expired' | 'authority_lost';
    reason: string;
    idempotencyKey: string;
    now?: number;
  }): WorkerLogicalProviderCallRecord[];
  rejectLateResponse(command: ReconciliationLineageCommand & {
    providerAttemptId: string;
    responseHash: string;
    providerRequestId?: string | null;
  }): { applied: boolean; duplicate?: boolean; call: WorkerLogicalProviderCallRecord };
  reconcile(command: ReconciliationLineageCommand & {
    physicalAttempts: readonly WorkerProviderPhysicalAttemptFact[];
    unknownSpend?: boolean;
  }): WorkerProviderCallReconciliationResult;
  listPendingReconciliation(input?: { limit?: number; afterLogicalCallId?: string }): WorkerLogicalProviderCallRecord[];
  listForAttempt(childAttemptId: string, childGeneration: number): WorkerLogicalProviderCallRecord[];
  get(logicalCallId: string): WorkerLogicalProviderCallRecord | null;
  listForWorkerRun(workerRunId: string): WorkerLogicalProviderCallRecord[];
}

type Row = {
  logical_call_id: string; schema_version: number; idempotency_key: string;
  worker_run_id: string; assignment_id: string; provider_binding_id: string;
  child_job_id: string; child_attempt_id: string; child_generation: number;
  call_ordinal: number; request_hash: string; tool_schema_hash: string;
  provider_id: string; model_id: string; fallback_policy_id: string | null;
  state: WorkerLogicalProviderCallState; accepted_provider_attempt_id: string | null;
  response_hash: string | null; provider_request_id: string | null; failure_kind: string | null;
  outcome_known: number; response_received_at: number | null; accepted_at: number | null;
  downstream_started_at: number | null; completed_at: number | null;
  reconciliation_state: WorkerProviderCallReconciliationState;
  outcome_knowledge: WorkerProviderCallOutcomeKnowledge;
  retry_safety: WorkerProviderCallRetrySafety;
  interruption_kind: WorkerProviderCallInterruptionKind | null;
  cancellation_requested_at: number | null; timeout_requested_at: number | null;
  authority_lost_at: number | null; stale_response_rejected_at: number | null;
  late_response_observed_at: number | null; reconciliation_started_at: number | null;
  reconciled_at: number | null; reconciliation_reason: string | null;
  reconciliation_version: number; recovery_predecessor_logical_call_id: string | null;
  created_at: number; updated_at: number;
};

function mapRow(row: Row): WorkerLogicalProviderCallRecord {
  return {
    logicalCallId: row.logical_call_id,
    schemaVersion: 1,
    idempotencyKey: row.idempotency_key,
    workerRunId: row.worker_run_id,
    assignmentId: row.assignment_id,
    providerBindingId: row.provider_binding_id,
    childJobId: row.child_job_id,
    childAttemptId: row.child_attempt_id,
    childGeneration: row.child_generation,
    callOrdinal: row.call_ordinal,
    requestHash: row.request_hash,
    toolSchemaHash: row.tool_schema_hash,
    providerId: row.provider_id,
    modelId: row.model_id,
    fallbackPolicyId: row.fallback_policy_id,
    state: row.state,
    acceptedProviderAttemptId: row.accepted_provider_attempt_id,
    responseHash: row.response_hash,
    providerRequestId: row.provider_request_id,
    failureKind: row.failure_kind,
    outcomeKnown: row.outcome_known === 1,
    reconciliationState: row.reconciliation_state,
    outcomeKnowledge: row.outcome_knowledge,
    retrySafety: row.retry_safety,
    interruptionKind: row.interruption_kind,
    cancellationRequestedAt: row.cancellation_requested_at,
    timeoutRequestedAt: row.timeout_requested_at,
    authorityLostAt: row.authority_lost_at,
    staleResponseRejectedAt: row.stale_response_rejected_at,
    lateResponseObservedAt: row.late_response_observed_at,
    reconciliationStartedAt: row.reconciliation_started_at,
    reconciledAt: row.reconciled_at,
    reconciliationReason: row.reconciliation_reason,
    reconciliationVersion: row.reconciliation_version,
    recoveryPredecessorLogicalCallId: row.recovery_predecessor_logical_call_id,
    responseReceivedAt: row.response_received_at,
    acceptedAt: row.accepted_at,
    downstreamStartedAt: row.downstream_started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function classifyWorkerProviderCall(
  call: WorkerLogicalProviderCallRecord,
  physicalAttempts: readonly WorkerProviderPhysicalAttemptFact[],
): Pick<WorkerProviderCallReconciliationResult, 'outcomeKnowledge' | 'retrySafety' | 'unknownSpend'> {
  if (call.state === 'downstream_started') {
    return { outcomeKnowledge: 'downstream_started', retrySafety: 'unsafe', unknownSpend: false };
  }
  if (call.state === 'accepted' || call.state === 'completed') {
    return { outcomeKnowledge: 'response_accepted', retrySafety: 'unsafe', unknownSpend: false };
  }
  if (call.state === 'response_received') {
    return { outcomeKnowledge: 'response_received', retrySafety: 'unsafe', unknownSpend: false };
  }
  if (call.cancellationRequestedAt !== null || call.state === 'cancelled') {
    if (call.state === 'prepared' && physicalAttempts.length === 0) {
      return { outcomeKnowledge: 'no_request_started', retrySafety: 'unsafe', unknownSpend: false };
    }
    const known = call.outcomeKnown && physicalAttempts.every((attempt) => attempt.status === 'interrupted');
    return known
      ? { outcomeKnowledge: 'provider_cancelled_known', retrySafety: 'unsafe', unknownSpend: false }
      : { outcomeKnowledge: 'outcome_unknown', retrySafety: 'blocked_unknown', unknownSpend: call.state !== 'prepared' };
  }
  if (call.state === 'failed' && call.outcomeKnown) {
    const timeout = call.interruptionKind === 'timeout' || /timeout/iu.test(call.failureKind ?? '');
    return {
      outcomeKnowledge: timeout ? 'provider_timed_out_known' : 'provider_failed_known',
      retrySafety: 'safe',
      unknownSpend: false,
    };
  }
  if (call.state === 'unknown' || physicalAttempts.some((attempt) => !attempt.noResponseProven
    && !['success', 'failed_before_send', 'validation_error'].includes(attempt.status))) {
    return { outcomeKnowledge: 'outcome_unknown', retrySafety: 'blocked_unknown', unknownSpend: true };
  }
  if (call.state === 'prepared' && physicalAttempts.length === 0) {
    return { outcomeKnowledge: 'no_request_started', retrySafety: 'safe', unknownSpend: false };
  }
  if (physicalAttempts.length > 0 && physicalAttempts.every((attempt) => (
    attempt.noResponseProven === true || attempt.status === 'failed_before_send' || attempt.status === 'validation_error'
  ))) {
    return { outcomeKnowledge: 'provider_failed_known', retrySafety: 'safe', unknownSpend: false };
  }
  return { outcomeKnowledge: 'outcome_unknown', retrySafety: 'blocked_unknown', unknownSpend: true };
}

function safeId(value: string, label: string): void {
  if (!ID.test(value)) throw new WorkerProviderCallError('invalid_contract', `${label} is invalid`);
}

function safeHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new WorkerProviderCallError('invalid_contract', `${label} is invalid`);
}

function safeRequestId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!ID.test(value) || /(?:token|secret|bearer|api[_-]?key)/iu.test(value)) {
    throw new WorkerProviderCallError('invalid_contract', 'Provider request identity is invalid');
  }
  return value;
}

export function createWorkerProviderCallAuthority(
  db: Db,
  validateActiveFence: (command: AuthorityCommand) => boolean,
  appendEvent?: (input: {
    call: WorkerLogicalProviderCallRecord;
    type: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    now: number;
  }) => void,
): WorkerProviderCallAuthority {
  const get = (logicalCallId: string): WorkerLogicalProviderCallRecord | null => {
    const row = db.prepare('SELECT * FROM worker_logical_provider_calls WHERE logical_call_id=?')
      .get(logicalCallId) as Row | undefined;
    return row ? mapRow(row) : null;
  };

  const requireAuthority = (command: AuthorityCommand): void => {
    if (!validateActiveFence(command)) {
      throw new WorkerProviderCallError('stale_authority', 'Worker provider call authority is no longer active');
    }
  };

  const requireCall = (command: AuthorityCommand & { logicalCallId: string }): WorkerLogicalProviderCallRecord => {
    requireAuthority(command);
    const call = get(command.logicalCallId);
    if (!call || call.childJobId !== command.childJobId || call.childAttemptId !== command.childAttemptId
      || call.childGeneration !== command.childGeneration) {
      throw new WorkerProviderCallError('lineage_mismatch', 'Logical provider call does not match the active Worker Attempt');
    }
    return call;
  };

  const requireLineage = (command: ReconciliationLineageCommand): WorkerLogicalProviderCallRecord => {
    const call = get(command.logicalCallId);
    if (!call || call.workerRunId !== command.workerRunId || call.childJobId !== command.childJobId
      || call.childAttemptId !== command.childAttemptId || call.childGeneration !== command.childGeneration) {
      throw new WorkerProviderCallError('lineage_mismatch', 'Logical provider reconciliation lineage is invalid');
    }
    safeId(command.idempotencyKey, 'Reconciliation idempotency key');
    safeId(command.reason, 'Reconciliation reason');
    return call;
  };

  const emit = (
    call: WorkerLogicalProviderCallRecord,
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    now: number,
  ): void => appendEvent?.({ call, type, payload, idempotencyKey, now });

  const authorityStillActive = (call: WorkerLogicalProviderCallRecord, now: number): boolean => {
    const row = db.prepare(
      `SELECT r.status,r.lease_expires_at,t.active_attempt_id,t.status AS job_status
         FROM runs r JOIN tasks t ON t.id=r.task_id
        WHERE r.attempt_id=? AND r.task_id=? AND r.generation=?`,
    ).get(call.childAttemptId, call.childJobId, call.childGeneration) as {
      status: string; lease_expires_at: number | null; active_attempt_id: string | null; job_status: string;
    } | undefined;
    return Boolean(row && row.active_attempt_id === call.childAttemptId
      && !/^(succeeded|failed|cancelled|timed_out|crashed|unknown|interrupted)$/u.test(row.status)
      && !/^(completed|failed|cancelled|dead_letter)$/u.test(row.job_status)
      && (row.lease_expires_at === null || row.lease_expires_at > now));
  };

  const prepare = db.transaction((command: PrepareWorkerProviderCallCommand): WorkerLogicalProviderCallRecord => {
    requireAuthority(command);
    for (const [value, label] of [
      [command.logicalCallId, 'Logical call identity'], [command.workerRunId, 'WorkerRun identity'],
      [command.assignmentId, 'Assignment identity'], [command.providerBindingId, 'Provider binding identity'],
    ] as const) safeId(value, label);
    safeHash(command.requestHash, 'Provider request hash');
    safeHash(command.toolSchemaHash, 'Tool schema hash');
    if (!Number.isSafeInteger(command.callOrdinal) || command.callOrdinal < 1) {
      throw new WorkerProviderCallError('invalid_contract', 'Logical call ordinal is invalid');
    }
    const run = db.prepare(
      `SELECT wr.assignment_id,wr.provider_binding_id,wr.child_job_id,wr.child_attempt_id,wr.child_generation,
              wa.provider_binding_id AS assignment_binding_id
         FROM worker_runs wr JOIN worker_assignments wa ON wa.assignment_id=wr.assignment_id
        WHERE wr.worker_run_id=?`,
    ).get(command.workerRunId) as {
      assignment_id: string; provider_binding_id: string; child_job_id: string;
      child_attempt_id: string; child_generation: number; assignment_binding_id: string;
    } | undefined;
    const binding = db.prepare(
      'SELECT provider_id,model_id,fallback_policy_id FROM worker_provider_bindings WHERE provider_binding_id=?',
    ).get(command.providerBindingId) as {
      provider_id: string; model_id: string; fallback_policy_id: string | null;
    } | undefined;
    if (!run || !binding || run.assignment_id !== command.assignmentId
      || run.provider_binding_id !== command.providerBindingId
      || run.assignment_binding_id !== command.providerBindingId
      || run.child_job_id !== command.childJobId
      || run.child_attempt_id !== command.childAttemptId
      || run.child_generation !== command.childGeneration) {
      throw new WorkerProviderCallError('lineage_mismatch', 'Logical provider call lineage is invalid');
    }
    const existingByKey = db.prepare(
      'SELECT * FROM worker_logical_provider_calls WHERE worker_run_id=? AND idempotency_key=?',
    ).get(command.workerRunId, command.idempotencyKey) as Row | undefined;
    const existingById = db.prepare('SELECT * FROM worker_logical_provider_calls WHERE logical_call_id=?')
      .get(command.logicalCallId) as Row | undefined;
    const existing = existingByKey ?? existingById;
    if (existing) {
      const record = mapRow(existing);
      if (record.logicalCallId !== command.logicalCallId || record.workerRunId !== command.workerRunId
        || record.assignmentId !== command.assignmentId || record.providerBindingId !== command.providerBindingId
        || record.callOrdinal !== command.callOrdinal || record.requestHash !== command.requestHash
        || record.toolSchemaHash !== command.toolSchemaHash) {
        throw new WorkerProviderCallError('idempotency_conflict', 'Logical provider call identity has conflicting input');
      }
      return record;
    }
    const now = command.now ?? Date.now();
    const recovery = db.prepare('SELECT recovery_of_attempt_id FROM runs WHERE attempt_id=?')
      .get(command.childAttemptId) as { recovery_of_attempt_id: string | null } | undefined;
    const predecessor = recovery?.recovery_of_attempt_id
      ? db.prepare(
        `SELECT logical_call_id FROM worker_logical_provider_calls
          WHERE child_job_id=? AND child_attempt_id=? AND call_ordinal=?
          ORDER BY created_at DESC,logical_call_id DESC LIMIT 1`,
      ).get(command.childJobId, recovery.recovery_of_attempt_id, command.callOrdinal) as {
        logical_call_id: string;
      } | undefined
      : undefined;
    db.prepare(
      `INSERT INTO worker_logical_provider_calls (
         logical_call_id,schema_version,idempotency_key,worker_run_id,assignment_id,provider_binding_id,
         child_job_id,child_attempt_id,child_generation,call_ordinal,request_hash,tool_schema_hash,
         provider_id,model_id,fallback_policy_id,state,outcome_known,recovery_predecessor_logical_call_id,
         created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',1,?,?,?)`,
    ).run(
      command.logicalCallId, 1, command.idempotencyKey, command.workerRunId, command.assignmentId,
      command.providerBindingId, command.childJobId, command.childAttemptId, command.childGeneration,
      command.callOrdinal, command.requestHash, command.toolSchemaHash, binding.provider_id,
      binding.model_id, binding.fallback_policy_id, predecessor?.logical_call_id ?? null, now, now,
    );
    return get(command.logicalCallId)!;
  }).immediate;

  const markAttempting = db.transaction((command: AuthorityCommand & { logicalCallId: string }) => {
    const call = requireCall(command);
    if (call.state === 'attempting') return call;
    if (call.state !== 'prepared') throw new WorkerProviderCallError('invalid_transition', 'Logical call cannot begin another attempt');
    db.prepare("UPDATE worker_logical_provider_calls SET state='attempting',updated_at=? WHERE logical_call_id=?")
      .run(command.now ?? Date.now(), command.logicalCallId);
    return get(command.logicalCallId)!;
  }).immediate;

  const recordResponseReceived = db.transaction((command: AuthorityCommand & {
    logicalCallId: string; providerAttemptId: string; responseHash: string; providerRequestId?: string | null;
  }) => {
    const call = requireCall(command);
    safeId(command.providerAttemptId, 'ProviderAttempt identity');
    safeHash(command.responseHash, 'Provider response hash');
    const providerRequestId = safeRequestId(command.providerRequestId);
    if (call.cancellationRequestedAt !== null || call.timeoutRequestedAt !== null || call.authorityLostAt !== null) {
      throw new WorkerProviderCallError('interrupted', 'Interrupted provider output cannot be received authoritatively');
    }
    if (call.responseHash !== null || call.acceptedProviderAttemptId !== null) {
      if (call.responseHash === command.responseHash && call.acceptedProviderAttemptId === command.providerAttemptId) return call;
      throw new WorkerProviderCallError('response_conflict', 'A competing provider response cannot replace the received response');
    }
    if (call.state !== 'attempting') throw new WorkerProviderCallError('invalid_transition', 'Provider response arrived outside an active attempt');
    const now = command.now ?? Date.now();
    db.prepare(
      `UPDATE worker_logical_provider_calls
          SET state='response_received',accepted_provider_attempt_id=?,response_hash=?,provider_request_id=?,
              response_received_at=?,updated_at=? WHERE logical_call_id=?`,
    ).run(command.providerAttemptId, command.responseHash, providerRequestId, now, now, command.logicalCallId);
    return get(command.logicalCallId)!;
  }).immediate;

  const acceptResponse = db.transaction((command: AuthorityCommand & {
    logicalCallId: string; providerAttemptId: string; responseHash: string;
  }) => {
    const call = requireCall(command);
    safeId(command.providerAttemptId, 'ProviderAttempt identity');
    safeHash(command.responseHash, 'Provider response hash');
    if (call.cancellationRequestedAt !== null || call.timeoutRequestedAt !== null || call.authorityLostAt !== null) {
      throw new WorkerProviderCallError('interrupted', 'Interrupted provider output cannot be accepted');
    }
    if (call.state === 'accepted' || call.state === 'downstream_started' || call.state === 'completed') {
      if (call.acceptedProviderAttemptId === command.providerAttemptId && call.responseHash === command.responseHash) return call;
      throw new WorkerProviderCallError('response_conflict', 'A competing provider response cannot replace the accepted response');
    }
    if (call.state !== 'response_received' || call.acceptedProviderAttemptId !== command.providerAttemptId
      || call.responseHash !== command.responseHash) {
      throw new WorkerProviderCallError('invalid_transition', 'Provider response must be durably received before acceptance');
    }
    const now = command.now ?? Date.now();
    db.prepare("UPDATE worker_logical_provider_calls SET state='accepted',accepted_at=?,updated_at=? WHERE logical_call_id=?")
      .run(now, now, command.logicalCallId);
    return get(command.logicalCallId)!;
  }).immediate;

  const markDownstreamStarted = db.transaction((command: AuthorityCommand & { logicalCallId: string }) => {
    const call = requireCall(command);
    if (call.state === 'downstream_started' || call.state === 'completed') return call;
    if (call.state !== 'accepted') throw new WorkerProviderCallError('invalid_transition', 'Downstream work requires an accepted provider response');
    const now = command.now ?? Date.now();
    db.prepare("UPDATE worker_logical_provider_calls SET state='downstream_started',downstream_started_at=?,updated_at=? WHERE logical_call_id=?")
      .run(now, now, command.logicalCallId);
    return get(command.logicalCallId)!;
  }).immediate;

  const complete = db.transaction((command: AuthorityCommand & { logicalCallId: string }) => {
    const call = requireCall(command);
    if (call.state === 'completed') return call;
    if (call.state !== 'accepted' && call.state !== 'downstream_started') {
      throw new WorkerProviderCallError('invalid_transition', 'Only an accepted provider call can complete');
    }
    const now = command.now ?? Date.now();
    db.prepare("UPDATE worker_logical_provider_calls SET state='completed',completed_at=?,updated_at=? WHERE logical_call_id=?")
      .run(now, now, command.logicalCallId);
    return get(command.logicalCallId)!;
  }).immediate;

  const linkToolCall = db.transaction((command: AuthorityCommand & {
    logicalCallId: string; providerToolCallId: string; toolName: string; argumentsHash: string;
  }) => {
    const call = requireCall(command);
    safeId(command.providerToolCallId, 'Provider tool-call identity');
    safeId(command.toolName, 'Tool name');
    safeHash(command.argumentsHash, 'Tool arguments hash');
    if ((call.state !== 'accepted' && call.state !== 'downstream_started') || !call.responseHash) {
      throw new WorkerProviderCallError('invalid_transition', 'Tool dispatch requires an accepted provider response');
    }
    const existing = db.prepare(
      'SELECT logical_call_id,tool_name,arguments_hash,response_hash FROM worker_provider_tool_links WHERE worker_run_id=? AND provider_tool_call_id=?',
    ).get(call.workerRunId, command.providerToolCallId) as {
      logical_call_id: string; tool_name: string; arguments_hash: string; response_hash: string;
    } | undefined;
    if (existing) {
      if (existing.logical_call_id !== call.logicalCallId || existing.tool_name !== command.toolName
        || existing.arguments_hash !== command.argumentsHash || existing.response_hash !== call.responseHash) {
        throw new WorkerProviderCallError('tool_call_conflict', 'Provider tool-call identity has conflicting arguments');
      }
      return { applied: false, duplicate: true };
    }
    const linkId = `worker_tool_link_${createHash('sha256')
      .update(`${call.workerRunId}\0${command.providerToolCallId}`)
      .digest('hex').slice(0, 32)}`;
    db.prepare(
      `INSERT INTO worker_provider_tool_links
         (link_id,logical_call_id,worker_run_id,provider_tool_call_id,tool_name,arguments_hash,response_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      linkId, call.logicalCallId, call.workerRunId, command.providerToolCallId,
      command.toolName, command.argumentsHash, call.responseHash, command.now ?? Date.now(),
    );
    return { applied: true };
  }).immediate;

  const fail = db.transaction((command: AuthorityCommand & {
    logicalCallId: string; failureKind: string; outcomeKnown: boolean; cancelled?: boolean;
  }) => {
    const call = requireCall(command);
    if (TERMINAL.has(call.state)) return call;
    if (call.state === 'accepted' || call.state === 'downstream_started') {
      throw new WorkerProviderCallError('accepted_response', 'Accepted provider work cannot be replaced by a failure');
    }
    if (!ID.test(command.failureKind)) throw new WorkerProviderCallError('invalid_contract', 'Provider failure kind is invalid');
    const state: WorkerLogicalProviderCallState = command.cancelled
      ? 'cancelled'
      : command.outcomeKnown ? 'failed' : 'unknown';
    const now = command.now ?? Date.now();
    db.prepare(
      `UPDATE worker_logical_provider_calls SET state=?,failure_kind=?,outcome_known=?,completed_at=?,updated_at=?
        WHERE logical_call_id=?`,
    ).run(state, command.failureKind, command.outcomeKnown ? 1 : 0, now, now, command.logicalCallId);
    return get(command.logicalCallId)!;
  }).immediate;

  const recordInterruption = db.transaction((command: AuthorityCommand & {
    logicalCallId: string; kind: 'cancellation' | 'timeout'; reason: string; idempotencyKey: string;
  }) => {
    const call = requireCall(command);
    safeId(command.reason, 'Interruption reason');
    safeId(command.idempotencyKey, 'Interruption idempotency key');
    const existingAt = command.kind === 'cancellation'
      ? call.cancellationRequestedAt
      : call.timeoutRequestedAt;
    if (existingAt !== null) return call;
    const now = command.now ?? Date.now();
    const outcome = call.state === 'prepared'
      ? 'no_request_started'
      : call.state === 'response_received'
        ? 'response_received'
        : call.state === 'accepted'
          ? 'response_accepted'
          : call.state === 'downstream_started' || call.state === 'completed'
            ? 'downstream_started'
            : 'outcome_unknown';
    const retrySafety = outcome === 'no_request_started' && command.kind === 'timeout' ? 'safe'
      : outcome === 'outcome_unknown' ? 'blocked_unknown' : 'unsafe';
    const timestampColumn = command.kind === 'cancellation'
      ? 'cancellation_requested_at'
      : 'timeout_requested_at';
    db.prepare(
      `UPDATE worker_logical_provider_calls
          SET interruption_kind=?,${timestampColumn}=?,reconciliation_state='pending',
              outcome_knowledge=?,retry_safety=?,reconciliation_reason=?,
              reconciliation_version=reconciliation_version+1,updated_at=?
        WHERE logical_call_id=?`,
    ).run(command.kind, now, outcome, retrySafety, command.reason, now, command.logicalCallId);
    const updated = get(command.logicalCallId)!;
    emit(updated, command.kind === 'cancellation'
      ? 'worker.provider_cancellation_requested'
      : 'worker.provider_timeout_requested', {
      logicalCallId: updated.logicalCallId,
      workerRunId: updated.workerRunId,
      reason: command.reason,
      outcomeKnowledge: updated.outcomeKnowledge,
      retrySafety: updated.retrySafety,
    }, command.idempotencyKey, now);
    return updated;
  }).immediate;

  const markAuthorityLost = db.transaction((command: ReconciliationLineageCommand & {
    kind: 'lease_expired' | 'authority_lost';
  }) => {
    const call = requireLineage(command);
    const now = command.now ?? Date.now();
    if (authorityStillActive(call, now)) {
      throw new WorkerProviderCallError('authority_active', 'Active Worker provider authority cannot be marked lost');
    }
    if (call.authorityLostAt !== null) return call;
    const classification = classifyWorkerProviderCall(call, []);
    db.prepare(
      `UPDATE worker_logical_provider_calls
          SET interruption_kind=COALESCE(interruption_kind,?),authority_lost_at=?,
              reconciliation_state='pending',outcome_knowledge=?,retry_safety=?,
              reconciliation_reason=?,reconciliation_version=reconciliation_version+1,updated_at=?
        WHERE logical_call_id=?`,
    ).run(
      command.kind, now, classification.outcomeKnowledge, classification.retrySafety,
      command.reason, now, call.logicalCallId,
    );
    const updated = get(call.logicalCallId)!;
    emit(updated, 'worker.provider_authority_lost', {
      logicalCallId: updated.logicalCallId,
      workerRunId: updated.workerRunId,
      reason: command.reason,
      outcomeKnowledge: updated.outcomeKnowledge,
      retrySafety: updated.retrySafety,
    }, command.idempotencyKey, now);
    return updated;
  }).immediate;

  const rejectLateResponse = db.transaction((command: ReconciliationLineageCommand & {
    providerAttemptId: string; responseHash: string; providerRequestId?: string | null;
  }) => {
    const call = requireLineage(command);
    const now = command.now ?? Date.now();
    safeId(command.providerAttemptId, 'ProviderAttempt identity');
    safeHash(command.responseHash, 'Late provider response hash');
    const providerRequestId = safeRequestId(command.providerRequestId);
    if (authorityStillActive(call, now) && call.cancellationRequestedAt === null
      && call.timeoutRequestedAt === null && call.authorityLostAt === null) {
      throw new WorkerProviderCallError('authority_active', 'Current provider output must use the acceptance path');
    }
    const existing = db.prepare(
      `SELECT response_hash,provider_request_id,reason FROM worker_provider_late_responses
        WHERE logical_call_id=? AND provider_attempt_id=?`,
    ).get(call.logicalCallId, command.providerAttemptId) as {
      response_hash: string; provider_request_id: string | null; reason: string;
    } | undefined;
    if (existing) {
      if (existing.response_hash !== command.responseHash || existing.provider_request_id !== providerRequestId
        || existing.reason !== command.reason) {
        throw new WorkerProviderCallError('late_response_conflict', 'Conflicting late provider response was rejected');
      }
      return { applied: false, duplicate: true, call: get(call.logicalCallId)! };
    }
    const lateResponseId = `worker_late_${createHash('sha256')
      .update(`${call.logicalCallId}\0${command.providerAttemptId}`)
      .digest('hex').slice(0, 32)}`;
    db.prepare(
      `INSERT INTO worker_provider_late_responses
         (late_response_id,logical_call_id,provider_attempt_id,response_hash,provider_request_id,reason,observed_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      lateResponseId, call.logicalCallId, command.providerAttemptId,
      command.responseHash, providerRequestId, command.reason, now,
    );
    db.prepare(
      `UPDATE worker_logical_provider_calls
          SET late_response_observed_at=?,stale_response_rejected_at=?,reconciliation_state='pending',
              retry_safety='unsafe',reconciliation_reason=?,
              reconciliation_version=reconciliation_version+1,updated_at=?
        WHERE logical_call_id=?`,
    ).run(now, now, command.reason, now, call.logicalCallId);
    const updated = get(call.logicalCallId)!;
    emit(updated, 'worker.provider_late_response_rejected', {
      logicalCallId: updated.logicalCallId,
      workerRunId: updated.workerRunId,
      providerAttemptId: command.providerAttemptId,
      responseHash: command.responseHash,
      reason: command.reason,
    }, command.idempotencyKey, now);
    return { applied: true, call: updated };
  }).immediate;

  const reconcile = db.transaction((command: ReconciliationLineageCommand & {
    physicalAttempts: readonly WorkerProviderPhysicalAttemptFact[]; unknownSpend?: boolean;
  }): WorkerProviderCallReconciliationResult => {
    const call = requireLineage(command);
    const now = command.now ?? Date.now();
    const physicalAttemptIds = [...new Set(command.physicalAttempts.map((attempt) => {
      safeId(attempt.providerAttemptId, 'ProviderAttempt identity');
      return attempt.providerAttemptId;
    }))].sort();
    const classification = classifyWorkerProviderCall(call, command.physicalAttempts);
    const unknownSpend = command.unknownSpend ?? (
      classification.unknownSpend
      || command.physicalAttempts.some((attempt) => attempt.usageKnown === false || attempt.costKnown === false)
    );
    const unsettledDownstream = db.prepare(
      `SELECT 1 FROM worker_provider_tool_links link
         LEFT JOIN tool_calls tc ON tc.tool_call_id=link.provider_tool_call_id
        WHERE link.logical_call_id=?
          AND (tc.tool_call_id IS NULL OR tc.state NOT IN ('completed','failed','cancelled','unknown')) LIMIT 1`,
    ).get(call.logicalCallId) !== undefined;
    const state: WorkerProviderCallReconciliationState = classification.retrySafety === 'blocked_unknown'
      ? 'blocked_unknown' : 'reconciled';
    const existing = db.prepare(
      'SELECT * FROM worker_provider_call_reconciliations WHERE logical_call_id=? AND idempotency_key=?',
    ).get(call.logicalCallId, command.idempotencyKey) as {
      worker_run_id: string; child_job_id: string; child_attempt_id: string; child_generation: number;
      outcome_knowledge: WorkerProviderCallOutcomeKnowledge; retry_safety: WorkerProviderCallRetrySafety;
      reason: string; physical_attempt_ids_json: string; unknown_spend: number;
      unsettled_downstream: number; state: WorkerProviderCallReconciliationState; completed_at: number | null;
    } | undefined;
    const result = (): WorkerProviderCallReconciliationResult => ({
      logicalCallId: call.logicalCallId,
      workerRunId: call.workerRunId,
      childJobId: call.childJobId,
      childAttemptId: call.childAttemptId,
      childGeneration: call.childGeneration,
      reconciliationState: state,
      outcomeKnowledge: classification.outcomeKnowledge,
      retrySafety: classification.retrySafety,
      reason: command.reason,
      physicalAttemptIds,
      unknownSpend,
      unsettledDownstream,
      reconciledAt: now,
    });
    if (existing) {
      const same = existing.worker_run_id === call.workerRunId && existing.child_job_id === call.childJobId
        && existing.child_attempt_id === call.childAttemptId && existing.child_generation === call.childGeneration
        && existing.outcome_knowledge === classification.outcomeKnowledge
        && existing.retry_safety === classification.retrySafety && existing.reason === command.reason
        && existing.physical_attempt_ids_json === JSON.stringify(physicalAttemptIds)
        && existing.unknown_spend === (unknownSpend ? 1 : 0)
        && existing.unsettled_downstream === (unsettledDownstream ? 1 : 0);
      if (!same) throw new WorkerProviderCallError('reconciliation_conflict', 'Provider reconciliation identity has conflicting facts');
      return { ...result(), reconciliationState: existing.state, reconciledAt: existing.completed_at };
    }
    const reconciliationId = `worker_reconcile_${createHash('sha256')
      .update(`${call.logicalCallId}\0${command.idempotencyKey}`)
      .digest('hex').slice(0, 32)}`;
    db.prepare(
      `INSERT INTO worker_provider_call_reconciliations
         (reconciliation_id,logical_call_id,idempotency_key,worker_run_id,child_job_id,child_attempt_id,
          child_generation,outcome_knowledge,retry_safety,reason,physical_attempt_ids_json,
          unknown_spend,unsettled_downstream,state,created_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      reconciliationId, call.logicalCallId, command.idempotencyKey, call.workerRunId,
      call.childJobId, call.childAttemptId, call.childGeneration, classification.outcomeKnowledge,
      classification.retrySafety, command.reason, JSON.stringify(physicalAttemptIds), unknownSpend ? 1 : 0,
      unsettledDownstream ? 1 : 0, state, now, now,
    );
    db.prepare(
      `UPDATE worker_logical_provider_calls
          SET reconciliation_state=?,outcome_knowledge=?,retry_safety=?,
              reconciliation_started_at=COALESCE(reconciliation_started_at,?),reconciled_at=?,
              reconciliation_reason=?,reconciliation_version=reconciliation_version+1,updated_at=?
        WHERE logical_call_id=?`,
    ).run(
      state, classification.outcomeKnowledge, classification.retrySafety,
      now, now, command.reason, now, call.logicalCallId,
    );
    const updated = get(call.logicalCallId)!;
    emit(updated, 'worker.provider_reconciliation_completed', {
      logicalCallId: updated.logicalCallId,
      workerRunId: updated.workerRunId,
      outcomeKnowledge: classification.outcomeKnowledge,
      retrySafety: classification.retrySafety,
      unknownSpend,
      reason: command.reason,
    }, command.idempotencyKey, now);
    return result();
  }).immediate;

  return {
    prepare,
    markAttempting,
    recordResponseReceived,
    acceptResponse,
    markDownstreamStarted,
    linkToolCall,
    complete,
    fail,
    recordCancellationIntent(command) {
      return recordInterruption({ ...command, kind: 'cancellation' });
    },
    recordTimeoutIntent(command) {
      return recordInterruption({ ...command, kind: 'timeout' });
    },
    recordInterruptionForAttempt(command) {
      return db.transaction(() => (db.prepare(
        `SELECT logical_call_id FROM worker_logical_provider_calls
          WHERE child_job_id=? AND child_attempt_id=? AND child_generation=?
            AND state NOT IN ('completed','failed','cancelled','unknown')
          ORDER BY call_ordinal,logical_call_id`,
      ).all(command.childJobId, command.childAttemptId, command.childGeneration) as Array<{ logical_call_id: string }>)
        .map((row) => recordInterruption({ ...command, logicalCallId: row.logical_call_id })))
        .immediate();
    },
    markAuthorityLost,
    markAuthorityLostForAttempt(command) {
      return db.transaction(() => (db.prepare(
        `SELECT logical_call_id,worker_run_id FROM worker_logical_provider_calls
          WHERE child_job_id=? AND child_attempt_id=? AND child_generation=?
          ORDER BY call_ordinal,logical_call_id`,
      ).all(command.childJobId, command.childAttemptId, command.childGeneration) as Array<{
        logical_call_id: string; worker_run_id: string;
      }>).map((row) => markAuthorityLost({
        ...command, logicalCallId: row.logical_call_id, workerRunId: row.worker_run_id,
      }))).immediate();
    },
    rejectLateResponse,
    reconcile,
    listPendingReconciliation(input = {}) {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000));
      return (db.prepare(
        `SELECT * FROM worker_logical_provider_calls
          WHERE logical_call_id>? AND reconciliation_state IN ('not_required','pending','inspecting')
          ORDER BY logical_call_id LIMIT ?`,
      ).all(input.afterLogicalCallId ?? '', limit) as Row[]).map(mapRow);
    },
    listForAttempt(childAttemptId, childGeneration) {
      return (db.prepare(
        `SELECT * FROM worker_logical_provider_calls
          WHERE child_attempt_id=? AND child_generation=? ORDER BY call_ordinal,logical_call_id`,
      ).all(childAttemptId, childGeneration) as Row[]).map(mapRow);
    },
    get,
    listForWorkerRun(workerRunId) {
      return (db.prepare(
        'SELECT * FROM worker_logical_provider_calls WHERE worker_run_id=? ORDER BY call_ordinal,created_at,logical_call_id',
      ).all(workerRunId) as Row[]).map(mapRow);
    },
  };
}
