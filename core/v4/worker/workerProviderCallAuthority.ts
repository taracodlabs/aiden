/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import type { WorkerLogicalProviderCallRecord, WorkerLogicalProviderCallState } from './types';

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
    responseReceivedAt: row.response_received_at,
    acceptedAt: row.accepted_at,
    downstreamStartedAt: row.downstream_started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    db.prepare(
      `INSERT INTO worker_logical_provider_calls (
         logical_call_id,schema_version,idempotency_key,worker_run_id,assignment_id,provider_binding_id,
         child_job_id,child_attempt_id,child_generation,call_ordinal,request_hash,tool_schema_hash,
         provider_id,model_id,fallback_policy_id,state,outcome_known,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',1,?,?)`,
    ).run(
      command.logicalCallId, 1, command.idempotencyKey, command.workerRunId, command.assignmentId,
      command.providerBindingId, command.childJobId, command.childAttemptId, command.childGeneration,
      command.callOrdinal, command.requestHash, command.toolSchemaHash, binding.provider_id,
      binding.model_id, binding.fallback_policy_id, now, now,
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

  return {
    prepare,
    markAttempting,
    recordResponseReceived,
    acceptResponse,
    markDownstreamStarted,
    linkToolCall,
    complete,
    fail,
    get,
    listForWorkerRun(workerRunId) {
      return (db.prepare(
        'SELECT * FROM worker_logical_provider_calls WHERE worker_run_id=? ORDER BY call_ordinal,created_at,logical_call_id',
      ).all(workerRunId) as Row[]).map(mapRow);
    },
  };
}
