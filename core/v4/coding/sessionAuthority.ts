/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { Db } from '../daemon/db/connection';
import type { WorkerAuthority } from '../worker/workerAuthority';
import { computeExternalCodingCapabilityDigest } from './capability';
import type {
  ExternalCodingCapabilitySnapshot,
  ExternalCodingEventRecord,
  ExternalCodingEventType,
  ExternalCodingInputKind,
  ExternalCodingInputRecord,
  ExternalCodingProcessIdentity,
  ExternalCodingProcessRecord,
  ExternalCodingRawOutputRecord,
  ExternalCodingReconciliationState,
  ExternalCodingSessionRecord,
  ExternalCodingSessionState,
  ExternalCodingTaskEnvelope,
} from './types';
import type { ExternalCodingWorkspaceAuthority } from './workspaceAuthority';

export class ExternalCodingSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingSessionError';
  }
}

interface ChildAuthority {
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  childFenceToken: string;
}

interface SessionAuthorityDeps {
  db: Db;
  worker: WorkerAuthority;
  workspaces: ExternalCodingWorkspaceAuthority;
  validateActiveFence(input: {
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    now?: number;
  }): boolean;
  validateLostAuthority(input: {
    jobId: string;
    attemptId: string;
    generation: number;
  }): boolean;
  validateCancelledAuthority(input: {
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
  }): boolean;
  validateRecoveryAuthority(input: {
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    recoveryOfAttemptId: string;
    recoveryOfGeneration: number;
    now?: number;
  }): boolean;
  terminateLostProcess?(identity: ExternalCodingProcessIdentity): {
    identityMatched: boolean;
    signalIssued: boolean;
    treeDeadVerified: boolean;
    reason: string;
  };
  appendOrderedEvent(input: ChildAuthority & {
    type: string;
    payload: Record<string, unknown>;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): void;
}

export interface ExternalCodingSessionAuthority {
  admit(input: ChildAuthority & {
    codingSessionId: string;
    parentJobId: string;
    assignmentId: string;
    workerRunId: string;
    workspaceLeaseId: string;
    sessionHomePath: string;
    capability: ExternalCodingCapabilitySnapshot;
    taskEnvelope: ExternalCodingTaskEnvelope;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  get(codingSessionId: string): ExternalCodingSessionRecord | null;
  getForChildJob(childJobId: string): ExternalCodingSessionRecord | null;
  listForJob(parentJobId: string): ExternalCodingSessionRecord[];
  transition(input: ChildAuthority & {
    codingSessionId: string;
    to: ExternalCodingSessionState;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  appendEvent(input: ChildAuthority & {
    codingSessionId: string;
    type: ExternalCodingEventType;
    payload: Record<string, unknown>;
    producer: string;
    idempotencyKey: string;
    authoritative?: boolean;
    now?: number;
  }): ExternalCodingEventRecord & { duplicate: boolean };
  listEvents(codingSessionId: string, afterSequence?: number): ExternalCodingEventRecord[];
  recordInput(input: ChildAuthority & {
    codingSessionId: string;
    requestId: string;
    kind: ExternalCodingInputKind;
    content: string;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingInputRecord & { duplicate: boolean };
  listInputs(codingSessionId: string, afterSequence?: number): ExternalCodingInputRecord[];
  markInputDelivered(input: ChildAuthority & {
    codingSessionId: string;
    inputId: string;
    now?: number;
  }): ExternalCodingInputRecord;
  bindProcess(input: ChildAuthority & {
    codingSessionId: string;
    processRecordId: string;
    processIdentity: ExternalCodingProcessIdentity;
    now?: number;
  }): ExternalCodingSessionRecord;
  getProcess(codingSessionId: string): ExternalCodingProcessRecord | null;
  recordProcessExit(input: ChildAuthority & {
    codingSessionId: string;
    processRecordId: string;
    state: 'exited' | 'unknown';
    exitCode: number | null;
    exitSignal: string | null;
    treeDeadVerified: boolean;
    now?: number;
  }): ExternalCodingProcessRecord;
  appendRawOutput(input: ChildAuthority & {
    codingSessionId: string;
    chunkSequence: number;
    stream: 'stdout' | 'stderr' | 'pty';
    content: string;
    observedByteCount: number;
    truncated: boolean;
    now?: number;
  }): ExternalCodingRawOutputRecord;
  listRawOutput(codingSessionId: string): ExternalCodingRawOutputRecord[];
  bindProviderSession(input: ChildAuthority & {
    codingSessionId: string;
    providerSessionId: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  attachSnapshots(input: ChildAuthority & {
    codingSessionId: string;
    preSnapshotId?: string;
    postSnapshotId?: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  attachResult(input: ChildAuthority & {
    codingSessionId: string;
    resultRef: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  attachCandidateResult(input: ChildAuthority & {
    codingSessionId: string;
    candidateResultRef: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  attachValidation(input: ChildAuthority & {
    codingSessionId: string;
    validationRef: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  requestCancellation(input: ChildAuthority & {
    codingSessionId: string;
    reason?: string;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  settleCancellation(input: ChildAuthority & {
    codingSessionId: string;
    processRecordId: string | null;
    exitCode: number | null;
    exitSignal: string | null;
    treeDeadVerified: boolean;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  recoverCancellation(input: ChildAuthority & {
    codingSessionId: string;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  requireReconciliation(input: ChildAuthority & {
    codingSessionId: string;
    reason: string;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  recoverAfterLeaseLoss(input: {
    childJobId: string;
    childAttemptId: string;
    childGeneration: number;
    reason: string;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingSessionRecord | null;
  claimRecovery(input: ChildAuthority & {
    codingSessionId: string;
    recoveryOfAttemptId: string;
    recoveryOfGeneration: number;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): ExternalCodingSessionRecord;
  discardUnknown(input: {
    codingSessionId: string;
    sessionHomeParent: string;
    decidedBy: string;
    decisionChannel: string;
    idempotencyKey: string;
    now?: number;
  }): Promise<ExternalCodingSessionRecord>;
}

interface SessionRow {
  coding_session_id: string;
  schema_version: 1;
  parent_job_id: string;
  assignment_id: string;
  worker_run_id: string;
  child_job_id: string;
  child_attempt_id: string;
  child_generation: number;
  workspace_lease_id: string;
  provider_id: string;
  provider_version: string;
  capability_digest: string;
  capability_json: string;
  protocol_mode: ExternalCodingSessionRecord['protocolMode'];
  protocol_version: string;
  state: ExternalCodingSessionState;
  reconciliation_state: ExternalCodingReconciliationState;
  next_event_sequence: number;
  next_input_sequence: number;
  provider_session_id: string | null;
  session_home_path: string;
  process_identity_json: string | null;
  task_envelope_json: string;
  pre_snapshot_id: string | null;
  post_snapshot_id: string | null;
  candidate_result_ref: string | null;
  result_ref: string | null;
  validation_refs_json: string;
  cancellation_requested_at: number | null;
  created_at: number;
  started_at: number | null;
  last_activity_at: number;
  terminal_at: number | null;
}

interface ProcessRow {
  process_record_id: string; coding_session_id: string; child_attempt_id: string; generation: number;
  pid: number; start_time: number | null; executable: string; executable_version: string; cwd: string;
  protocol_mode: ExternalCodingProcessIdentity['mode']; state: ExternalCodingProcessRecord['state'];
  exit_code: number | null; exit_signal: string | null; tree_dead_verified: number;
  created_at: number; exited_at: number | null;
}

interface RawOutputRow {
  coding_session_id: string; chunk_sequence: number; stream: ExternalCodingRawOutputRecord['stream'];
  content: string; byte_count: number; truncated: number; created_at: number;
}

interface EventRow {
  event_id: string;
  coding_session_id: string;
  sequence: number;
  child_attempt_id: string;
  generation: number;
  type: ExternalCodingEventType;
  payload_json: string;
  payload_digest: string;
  producer: string;
  idempotency_key: string;
  authoritative: number;
  created_at: number;
}

interface InputRow {
  input_id: string;
  coding_session_id: string;
  sequence: number;
  request_id: string;
  child_attempt_id: string;
  generation: number;
  kind: ExternalCodingInputKind;
  content: string;
  content_digest: string;
  state: ExternalCodingInputRecord['state'];
  idempotency_key: string;
  created_at: number;
  delivered_at: number | null;
}

const TERMINAL_SESSION_STATES = new Set<ExternalCodingSessionState>(['terminal', 'failed']);
const TRANSITIONS: Readonly<Record<ExternalCodingSessionState, ReadonlySet<ExternalCodingSessionState>>> = {
  preparing: new Set(['starting', 'cancelling', 'failed', 'unknown']),
  starting: new Set(['running', 'waiting_for_input', 'waiting_for_approval', 'cancelling', 'process_terminal', 'failed', 'unknown']),
  running: new Set(['waiting_for_input', 'waiting_for_approval', 'cancelling', 'process_terminal', 'failed', 'unknown']),
  waiting_for_input: new Set(['running', 'cancelling', 'process_terminal', 'failed', 'unknown']),
  waiting_for_approval: new Set(['running', 'cancelling', 'process_terminal', 'failed', 'unknown']),
  cancelling: new Set(['process_terminal', 'reconciliation_required', 'terminal', 'unknown']),
  process_terminal: new Set(['reconciliation_required', 'verification_pending', 'terminal', 'failed', 'unknown']),
  reconciliation_required: new Set(['verification_pending', 'failed', 'unknown']),
  verification_pending: new Set(['ready_for_review', 'failed', 'unknown']),
  ready_for_review: new Set(['terminal', 'failed', 'unknown']),
  terminal: new Set(),
  failed: new Set(),
  unknown: new Set(['reconciliation_required', 'verification_pending', 'failed']),
};

const SENSITIVE_KEY = /(?:authorization|api[_-]?key|token|secret|password|credential|cookie)/i;
const SENSITIVE_VALUE = /(?:bearer\s+[a-z0-9._-]{12,}|(?:sk|gsk|ghp)_[a-z0-9_-]{12,})/i;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function redact(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([nestedKey, item]) => [nestedKey, redact(item, nestedKey, depth + 1)]));
  }
  if (typeof value === 'string' && SENSITIVE_VALUE.test(value)) return '[redacted]';
  return value;
}

function parseArray(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseRecord<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function assertIdentity(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/.test(value)) {
    throw new ExternalCodingSessionError('INVALID_IDENTITY', `${label} is invalid`);
  }
}

function safeSessionHome(parent: string, sessionHome: string, codingSessionId: string): boolean {
  const root = path.resolve(parent);
  const target = path.resolve(sessionHome);
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    && path.basename(target) === codingSessionId;
}

function validateEnvelope(envelope: ExternalCodingTaskEnvelope): void {
  if (!envelope.goal.trim()) throw new ExternalCodingSessionError('INVALID_TASK_ENVELOPE', 'Coding task goal is required');
  if (envelope.budgets.runtimeMs <= 0 || envelope.budgets.outputBytes <= 0 || envelope.budgets.commandCount <= 0) {
    throw new ExternalCodingSessionError('INVALID_TASK_ENVELOPE', 'Coding task budgets must be positive');
  }
  if (envelope.networkPolicy !== 'disabled' && envelope.networkPolicy !== 'approved_adapter_only') {
    throw new ExternalCodingSessionError('INVALID_TASK_ENVELOPE', 'Coding task network policy is invalid');
  }
}

function mapSession(row: SessionRow): ExternalCodingSessionRecord {
  const capability = parseRecord<ExternalCodingCapabilitySnapshot>(row.capability_json);
  const taskEnvelope = parseRecord<ExternalCodingTaskEnvelope>(row.task_envelope_json);
  if (!capability || !taskEnvelope) throw new ExternalCodingSessionError('CORRUPT_SESSION', 'Coding session payload is corrupt');
  return {
    codingSessionId: row.coding_session_id,
    schemaVersion: row.schema_version,
    parentJobId: row.parent_job_id,
    assignmentId: row.assignment_id,
    workerRunId: row.worker_run_id,
    childJobId: row.child_job_id,
    childAttemptId: row.child_attempt_id,
    childGeneration: row.child_generation,
    workspaceLeaseId: row.workspace_lease_id,
    providerId: row.provider_id,
    providerVersion: row.provider_version,
    capabilityDigest: row.capability_digest,
    capability,
    protocolMode: row.protocol_mode,
    protocolVersion: row.protocol_version,
    state: row.state,
    reconciliationState: row.reconciliation_state,
    nextEventSequence: row.next_event_sequence,
    nextInputSequence: row.next_input_sequence,
    providerSessionId: row.provider_session_id,
    sessionHomePath: row.session_home_path,
    processIdentity: parseRecord<ExternalCodingProcessIdentity>(row.process_identity_json),
    taskEnvelope,
    preSnapshotId: row.pre_snapshot_id,
    postSnapshotId: row.post_snapshot_id,
    candidateResultRef: row.candidate_result_ref,
    resultRef: row.result_ref,
    validationRefs: parseArray(row.validation_refs_json),
    cancellationRequestedAt: row.cancellation_requested_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    terminalAt: row.terminal_at,
  };
}

function mapProcess(row: ProcessRow): ExternalCodingProcessRecord {
  return {
    processRecordId: row.process_record_id,
    codingSessionId: row.coding_session_id,
    childAttemptId: row.child_attempt_id,
    generation: row.generation,
    identity: {
      pid: row.pid,
      startTime: row.start_time,
      executable: row.executable,
      version: row.executable_version,
      cwd: row.cwd,
      mode: row.protocol_mode,
    },
    state: row.state,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    treeDeadVerified: row.tree_dead_verified === 1,
    createdAt: row.created_at,
    exitedAt: row.exited_at,
  };
}

function mapRawOutput(row: RawOutputRow): ExternalCodingRawOutputRecord {
  return {
    codingSessionId: row.coding_session_id,
    chunkSequence: row.chunk_sequence,
    stream: row.stream,
    content: row.content,
    byteCount: row.byte_count,
    truncated: row.truncated === 1,
    createdAt: row.created_at,
  };
}

function mapEvent(row: EventRow): ExternalCodingEventRecord {
  return {
    eventId: row.event_id,
    codingSessionId: row.coding_session_id,
    sequence: row.sequence,
    childAttemptId: row.child_attempt_id,
    generation: row.generation,
    type: row.type,
    payload: parseRecord<Record<string, unknown>>(row.payload_json) ?? {},
    producer: row.producer,
    idempotencyKey: row.idempotency_key,
    authoritative: row.authoritative === 1,
    createdAt: row.created_at,
  };
}

function mapInput(row: InputRow): ExternalCodingInputRecord {
  return {
    inputId: row.input_id,
    codingSessionId: row.coding_session_id,
    sequence: row.sequence,
    requestId: row.request_id,
    childAttemptId: row.child_attempt_id,
    generation: row.generation,
    kind: row.kind,
    content: row.content,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function createExternalCodingSessionAuthority(deps: SessionAuthorityDeps): ExternalCodingSessionAuthority {
  const sessionRow = (codingSessionId: string): SessionRow | undefined => deps.db.prepare(
    `SELECT s.*, c.capability_json
       FROM external_coding_sessions s
       JOIN external_coding_capability_snapshots c ON c.capability_digest=s.capability_digest
      WHERE s.coding_session_id=?`,
  ).get(codingSessionId) as SessionRow | undefined;
  const get = (codingSessionId: string): ExternalCodingSessionRecord | null => {
    const row = sessionRow(codingSessionId);
    return row ? mapSession(row) : null;
  };

  const assertFence = (
    input: ChildAuthority & { codingSessionId?: string; now?: number },
    requireSession = true,
  ): ExternalCodingSessionRecord | null => {
    if (!deps.validateActiveFence({
      jobId: input.childJobId,
      attemptId: input.childAttemptId,
      generation: input.childGeneration,
      fenceToken: input.childFenceToken,
      now: input.now,
    })) {
      throw new ExternalCodingSessionError('STALE_CODING_AUTHORITY', 'External coding authority is stale');
    }
    if (!requireSession || !input.codingSessionId) return null;
    const current = get(input.codingSessionId);
    if (!current
      || current.childJobId !== input.childJobId
      || current.childAttemptId !== input.childAttemptId
      || current.childGeneration !== input.childGeneration) {
      throw new ExternalCodingSessionError('SESSION_LINEAGE_MISMATCH', 'External coding session lineage does not match');
    }
    return current;
  };

  const persistEvent = (
    input: Parameters<ExternalCodingSessionAuthority['appendEvent']>[0],
    current: ExternalCodingSessionRecord,
    allowTerminal = false,
  ) => {
    const authoritative = input.authoritative !== false;
    if (!allowTerminal && authoritative && TERMINAL_SESSION_STATES.has(current.state)) {
      throw new ExternalCodingSessionError('SESSION_TERMINAL', 'Authoritative events cannot mutate a terminal coding session');
    }
    const payload = redact(input.payload) as Record<string, unknown>;
    const payloadJson = JSON.stringify(canonical(payload));
    const payloadDigest = digest({ type: input.type, payload, authoritative });
    const duplicate = deps.db.prepare(
      `SELECT * FROM external_coding_events WHERE coding_session_id=? AND idempotency_key=?`,
    ).get(input.codingSessionId, input.idempotencyKey) as EventRow | undefined;
    if (duplicate) {
      if (duplicate.payload_digest !== payloadDigest || duplicate.type !== input.type) {
        throw new ExternalCodingSessionError('IDEMPOTENCY_CONFLICT', 'Coding event idempotency key has different content');
      }
      return { ...mapEvent(duplicate), duplicate: true };
    }
    const now = input.now ?? Date.now();
    return deps.db.transaction(() => {
      const allocation = deps.db.prepare(
        `UPDATE external_coding_sessions
            SET next_event_sequence=next_event_sequence+1, last_activity_at=?
          WHERE coding_session_id=? AND child_attempt_id=? AND child_generation=?
          RETURNING next_event_sequence-1 AS sequence`,
      ).get(now, input.codingSessionId, input.childAttemptId, input.childGeneration) as { sequence: number } | undefined;
      if (!allocation) throw new ExternalCodingSessionError('SESSION_LINEAGE_MISMATCH', 'Coding event lineage is no longer current');
      const eventId = `coding_event_${randomBytes(16).toString('hex')}`;
      deps.db.prepare(
        `INSERT INTO external_coding_events
           (event_id,coding_session_id,sequence,child_attempt_id,generation,type,payload_json,
            payload_digest,producer,idempotency_key,authoritative,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        eventId, input.codingSessionId, allocation.sequence, input.childAttemptId,
        input.childGeneration, input.type, payloadJson, payloadDigest, input.producer,
        input.idempotencyKey, authoritative ? 1 : 0, now,
      );
      deps.appendOrderedEvent({
        ...input,
        type: `coding.${input.type}`,
        payload: { codingSessionId: input.codingSessionId, sequence: allocation.sequence, ...payload },
        idempotencyKey: `coding:${input.codingSessionId}:${input.idempotencyKey}`,
      });
      const row = deps.db.prepare('SELECT * FROM external_coding_events WHERE event_id=?').get(eventId) as EventRow;
      return { ...mapEvent(row), duplicate: false };
    }).immediate();
  };
  const appendEvent = (input: Parameters<ExternalCodingSessionAuthority['appendEvent']>[0]) => {
    const current = assertFence(input)!;
    return persistEvent(input, current);
  };

  return {
    admit(input) {
      assertFence(input, false);
      assertIdentity(input.codingSessionId, 'Coding session identity');
      assertIdentity(input.idempotencyKey, 'Coding session idempotency key');
      validateEnvelope(input.taskEnvelope);
      const expectedCapabilityDigest = computeExternalCodingCapabilityDigest({
        schemaVersion: 1,
        capabilityId: input.capability.capabilityId,
        providerId: input.capability.providerId,
        providerVersion: input.capability.providerVersion,
        protocolMode: input.capability.protocolMode,
        protocolVersion: input.capability.protocolVersion,
        supportedFeatures: input.capability.supportedFeatures,
        runtimeCompatibility: input.capability.runtimeCompatibility,
      });
      if (expectedCapabilityDigest !== input.capability.capabilityDigest) {
        throw new ExternalCodingSessionError('CAPABILITY_DIGEST_MISMATCH', 'External coding capability snapshot was modified');
      }
      const assignment = deps.worker.getWorkerAssignment(input.assignmentId);
      const run = deps.worker.getWorkerRun(input.workerRunId);
      if (!assignment || !run
        || assignment.parentJobId !== input.parentJobId
        || assignment.childJobId !== input.childJobId
        || run.assignmentId !== input.assignmentId
        || run.childJobId !== input.childJobId
        || run.childAttemptId !== input.childAttemptId
        || run.childGeneration !== input.childGeneration) {
        throw new ExternalCodingSessionError('WORKER_LINEAGE_MISMATCH', 'Coding session is not bound to the exact Worker run');
      }
      const lease = deps.workspaces.get(input.workspaceLeaseId);
      if (!lease || lease.codingSessionId !== input.codingSessionId
        || lease.childJobId !== input.childJobId
        || lease.childAttemptId !== input.childAttemptId
        || lease.generation !== input.childGeneration
        || lease.state !== 'ready') {
        throw new ExternalCodingSessionError('WORKSPACE_LINEAGE_MISMATCH', 'Coding session is not bound to a ready exact workspace lease');
      }
      const inputDigest = digest({
        parentJobId: input.parentJobId,
        assignmentId: input.assignmentId,
        workerRunId: input.workerRunId,
        childJobId: input.childJobId,
        childAttemptId: input.childAttemptId,
        childGeneration: input.childGeneration,
        workspaceLeaseId: input.workspaceLeaseId,
        sessionHomePath: input.sessionHomePath,
        capabilityDigest: input.capability.capabilityDigest,
        taskEnvelope: input.taskEnvelope,
      });
      const existing = get(input.codingSessionId);
      if (existing) {
        const row = deps.db.prepare('SELECT input_digest,idempotency_key FROM external_coding_sessions WHERE coding_session_id=?')
          .get(input.codingSessionId) as { input_digest: string; idempotency_key: string };
        if (row.input_digest !== inputDigest || row.idempotency_key !== input.idempotencyKey) {
          throw new ExternalCodingSessionError('IDEMPOTENCY_CONFLICT', 'Coding session identity has different immutable input');
        }
        return existing;
      }
      const now = input.now ?? Date.now();
      deps.db.transaction(() => {
        deps.db.prepare(
          `INSERT OR IGNORE INTO external_coding_capability_snapshots
             (capability_digest,schema_version,capability_id,provider_id,provider_version,
              protocol_mode,protocol_version,capability_json,captured_at)
           VALUES (?,1,?,?,?,?,?,?,?)`,
        ).run(
          input.capability.capabilityDigest, input.capability.capabilityId,
          input.capability.providerId, input.capability.providerVersion,
          input.capability.protocolMode, input.capability.protocolVersion,
          JSON.stringify(canonical(input.capability)), input.capability.capturedAt,
        );
        deps.db.prepare(
          `INSERT INTO external_coding_sessions
             (coding_session_id,schema_version,idempotency_key,input_digest,parent_job_id,
              assignment_id,worker_run_id,child_job_id,child_attempt_id,child_generation,
              workspace_lease_id,capability_digest,provider_id,provider_version,protocol_mode,
              protocol_version,state,reconciliation_state,session_home_path,task_envelope_json,created_at,last_activity_at)
           VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing','not_required',?,?,?,?)`,
        ).run(
          input.codingSessionId, input.idempotencyKey, inputDigest, input.parentJobId,
          input.assignmentId, input.workerRunId, input.childJobId, input.childAttemptId,
          input.childGeneration, input.workspaceLeaseId, input.capability.capabilityDigest,
          input.capability.providerId, input.capability.providerVersion,
          input.capability.protocolMode, input.capability.protocolVersion,
          input.sessionHomePath, JSON.stringify(canonical(input.taskEnvelope)), now, now,
        );
        deps.appendOrderedEvent({
          ...input,
          type: 'coding.session_admitted',
          payload: {
            codingSessionId: input.codingSessionId,
            assignmentId: input.assignmentId,
            workerRunId: input.workerRunId,
            workspaceLeaseId: input.workspaceLeaseId,
            capabilityDigest: input.capability.capabilityDigest,
          },
          idempotencyKey: `coding-session-admitted:${input.codingSessionId}`,
        });
      }).immediate();
      return get(input.codingSessionId)!;
    },
    get,
    getForChildJob(childJobId) {
      const row = deps.db.prepare(
        `SELECT s.*, c.capability_json
           FROM external_coding_sessions s
           JOIN external_coding_capability_snapshots c ON c.capability_digest=s.capability_digest
          WHERE s.child_job_id=? ORDER BY s.created_at DESC,s.coding_session_id DESC LIMIT 1`,
      ).get(childJobId) as SessionRow | undefined;
      return row ? mapSession(row) : null;
    },
    listForJob(parentJobId) {
      return (deps.db.prepare(
        `SELECT s.*, c.capability_json
           FROM external_coding_sessions s
           JOIN external_coding_capability_snapshots c ON c.capability_digest=s.capability_digest
          WHERE s.parent_job_id=? ORDER BY s.created_at,s.coding_session_id`,
      ).all(parentJobId) as SessionRow[]).map(mapSession);
    },
    transition(input) {
      const current = assertFence(input)!;
      if (current.state === input.to) return current;
      if (!TRANSITIONS[current.state].has(input.to)) {
        throw new ExternalCodingSessionError('ILLEGAL_TRANSITION', `Cannot transition coding session ${current.state} to ${input.to}`);
      }
      const now = input.now ?? Date.now();
      const terminalAt = TERMINAL_SESSION_STATES.has(input.to) ? now : null;
      const startedAt = input.to === 'running' && current.startedAt === null ? now : current.startedAt;
      deps.db.prepare(
        `UPDATE external_coding_sessions
            SET state=?,started_at=?,terminal_at=?,last_activity_at=?
          WHERE coding_session_id=? AND child_attempt_id=? AND child_generation=?`,
      ).run(input.to, startedAt, terminalAt, now, input.codingSessionId, input.childAttemptId, input.childGeneration);
      deps.appendOrderedEvent({
        ...input,
        type: 'coding.session_transitioned',
        payload: { codingSessionId: input.codingSessionId, from: current.state, to: input.to },
        idempotencyKey: input.idempotencyKey,
      });
      return get(input.codingSessionId)!;
    },
    appendEvent,
    listEvents(codingSessionId, afterSequence = 0) {
      return (deps.db.prepare(
        `SELECT * FROM external_coding_events
          WHERE coding_session_id=? AND sequence>? ORDER BY sequence`,
      ).all(codingSessionId, afterSequence) as EventRow[]).map(mapEvent);
    },
    recordInput(input) {
      assertFence(input);
      assertIdentity(input.requestId, 'Coding input request identity');
      const safeContent = SENSITIVE_VALUE.test(input.content) ? '[redacted]' : input.content;
      const contentDigest = digest({ requestId: input.requestId, kind: input.kind, content: safeContent });
      const duplicate = deps.db.prepare(
        `SELECT * FROM external_coding_inputs WHERE coding_session_id=? AND idempotency_key=?`,
      ).get(input.codingSessionId, input.idempotencyKey) as InputRow | undefined;
      if (duplicate) {
        if (duplicate.content_digest !== contentDigest || duplicate.request_id !== input.requestId) {
          throw new ExternalCodingSessionError('IDEMPOTENCY_CONFLICT', 'Coding input idempotency key has different content');
        }
        return { ...mapInput(duplicate), duplicate: true };
      }
      const now = input.now ?? Date.now();
      return deps.db.transaction(() => {
        const allocation = deps.db.prepare(
          `UPDATE external_coding_sessions
              SET next_input_sequence=next_input_sequence+1,last_activity_at=?
            WHERE coding_session_id=? AND child_attempt_id=? AND child_generation=?
              AND state NOT IN ('terminal','failed')
            RETURNING next_input_sequence-1 AS sequence`,
        ).get(now, input.codingSessionId, input.childAttemptId, input.childGeneration) as { sequence: number } | undefined;
        if (!allocation) throw new ExternalCodingSessionError('SESSION_TERMINAL', 'Coding session cannot accept durable input');
        const inputId = `coding_input_${randomBytes(16).toString('hex')}`;
        deps.db.prepare(
          `INSERT INTO external_coding_inputs
             (input_id,coding_session_id,sequence,request_id,child_attempt_id,generation,kind,
              content,content_digest,state,idempotency_key,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,'accepted',?,?)`,
        ).run(
          inputId, input.codingSessionId, allocation.sequence, input.requestId,
          input.childAttemptId, input.childGeneration, input.kind, safeContent,
          contentDigest, input.idempotencyKey, now,
        );
        deps.appendOrderedEvent({
          ...input,
          type: 'coding.input_accepted',
          payload: {
            codingSessionId: input.codingSessionId,
            inputId,
            sequence: allocation.sequence,
            requestId: input.requestId,
            kind: input.kind,
          },
          idempotencyKey: `coding-input:${input.codingSessionId}:${input.idempotencyKey}`,
        });
        const row = deps.db.prepare('SELECT * FROM external_coding_inputs WHERE input_id=?').get(inputId) as InputRow;
        return { ...mapInput(row), duplicate: false };
      }).immediate();
    },
    listInputs(codingSessionId, afterSequence = 0) {
      return (deps.db.prepare(
        `SELECT * FROM external_coding_inputs
          WHERE coding_session_id=? AND sequence>? ORDER BY sequence`,
      ).all(codingSessionId, afterSequence) as InputRow[]).map(mapInput);
    },
    markInputDelivered(input) {
      assertFence(input);
      const now = input.now ?? Date.now();
      const changed = deps.db.prepare(
        `UPDATE external_coding_inputs SET state='delivered',delivered_at=COALESCE(delivered_at,?)
          WHERE input_id=? AND coding_session_id=? AND child_attempt_id=? AND generation=?
            AND state IN ('accepted','delivered')`,
      ).run(now, input.inputId, input.codingSessionId, input.childAttemptId, input.childGeneration);
      if (changed.changes !== 1) throw new ExternalCodingSessionError('INPUT_NOT_FOUND', 'Coding input lineage does not match');
      return mapInput(deps.db.prepare('SELECT * FROM external_coding_inputs WHERE input_id=?').get(input.inputId) as InputRow);
    },
    bindProcess(input) {
      assertFence(input);
      assertIdentity(input.processRecordId, 'Coding process record identity');
      const now = input.now ?? Date.now();
      deps.db.transaction(() => {
        deps.db.prepare(
          `UPDATE external_coding_sessions SET process_identity_json=?,last_activity_at=?
            WHERE coding_session_id=? AND process_identity_json IS NULL`,
        ).run(JSON.stringify(canonical(input.processIdentity)), now, input.codingSessionId);
        deps.db.prepare(
          `INSERT OR IGNORE INTO external_coding_processes
             (process_record_id,coding_session_id,child_attempt_id,generation,pid,start_time,
              executable,executable_version,cwd,protocol_mode,state,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'running',?)`,
        ).run(
          input.processRecordId, input.codingSessionId, input.childAttemptId, input.childGeneration,
          input.processIdentity.pid, input.processIdentity.startTime, input.processIdentity.executable,
          input.processIdentity.version, input.processIdentity.cwd, input.processIdentity.mode, now,
        );
      }).immediate();
      const current = get(input.codingSessionId);
      if (!current?.processIdentity || digest(current.processIdentity) !== digest(input.processIdentity)) {
        throw new ExternalCodingSessionError('PROCESS_IDENTITY_IMMUTABLE', 'Coding process identity cannot be replaced');
      }
      const process = this.getProcess(input.codingSessionId);
      if (!process || process.processRecordId !== input.processRecordId
        || digest(process.identity) !== digest(input.processIdentity)) {
        throw new ExternalCodingSessionError('PROCESS_IDENTITY_IMMUTABLE', 'Coding process record cannot be replaced');
      }
      return current;
    },
    getProcess(codingSessionId) {
      const row = deps.db.prepare('SELECT * FROM external_coding_processes WHERE coding_session_id=?')
        .get(codingSessionId) as ProcessRow | undefined;
      return row ? mapProcess(row) : null;
    },
    recordProcessExit(input) {
      assertFence(input);
      const now = input.now ?? Date.now();
      const changed = deps.db.prepare(
        `UPDATE external_coding_processes
            SET state=?,exit_code=?,exit_signal=?,tree_dead_verified=?,exited_at=COALESCE(exited_at,?)
          WHERE process_record_id=? AND coding_session_id=? AND child_attempt_id=? AND generation=?
            AND state IN ('starting','running','stopping','unknown','exited')`,
      ).run(
        input.state, input.exitCode, input.exitSignal, input.treeDeadVerified ? 1 : 0, now,
        input.processRecordId, input.codingSessionId, input.childAttemptId, input.childGeneration,
      );
      if (changed.changes !== 1) throw new ExternalCodingSessionError('PROCESS_NOT_FOUND', 'Coding process lineage does not match');
      return this.getProcess(input.codingSessionId)!;
    },
    appendRawOutput(input) {
      assertFence(input);
      if (!Number.isInteger(input.chunkSequence) || input.chunkSequence < 1) {
        throw new ExternalCodingSessionError('INVALID_OUTPUT_SEQUENCE', 'Coding raw-output sequence is invalid');
      }
      const safeContent = SENSITIVE_VALUE.test(input.content) ? '[redacted]' : input.content;
      const contentDigest = digest({ stream: input.stream, content: safeContent, truncated: input.truncated });
      const prior = deps.db.prepare(
        'SELECT * FROM external_coding_raw_output WHERE coding_session_id=? AND chunk_sequence=?',
      ).get(input.codingSessionId, input.chunkSequence) as RawOutputRow | undefined;
      if (prior) {
        if (digest({ stream: prior.stream, content: prior.content, truncated: prior.truncated === 1 }) !== contentDigest) {
          throw new ExternalCodingSessionError('OUTPUT_SEQUENCE_CONFLICT', 'Coding raw-output sequence has different content');
        }
        return mapRawOutput(prior);
      }
      deps.db.prepare(
        `INSERT INTO external_coding_raw_output
           (coding_session_id,chunk_sequence,stream,content,content_digest,byte_count,truncated,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        input.codingSessionId, input.chunkSequence, input.stream, safeContent, contentDigest,
        input.observedByteCount, input.truncated ? 1 : 0, input.now ?? Date.now(),
      );
      return mapRawOutput(deps.db.prepare(
        'SELECT * FROM external_coding_raw_output WHERE coding_session_id=? AND chunk_sequence=?',
      ).get(input.codingSessionId, input.chunkSequence) as RawOutputRow);
    },
    listRawOutput(codingSessionId) {
      return (deps.db.prepare(
        'SELECT * FROM external_coding_raw_output WHERE coding_session_id=? ORDER BY chunk_sequence',
      ).all(codingSessionId) as RawOutputRow[]).map(mapRawOutput);
    },
    bindProviderSession(input) {
      assertFence(input);
      assertIdentity(input.providerSessionId, 'Provider session identity');
      deps.db.prepare(
        `UPDATE external_coding_sessions SET provider_session_id=COALESCE(provider_session_id,?),last_activity_at=?
          WHERE coding_session_id=?`,
      ).run(input.providerSessionId, input.now ?? Date.now(), input.codingSessionId);
      const current = get(input.codingSessionId)!;
      if (current.providerSessionId !== input.providerSessionId) {
        throw new ExternalCodingSessionError('PROVIDER_SESSION_IMMUTABLE', 'Coding provider session identity cannot be replaced');
      }
      return current;
    },
    attachSnapshots(input) {
      assertFence(input);
      const now = input.now ?? Date.now();
      deps.db.prepare(
        `UPDATE external_coding_sessions
            SET pre_snapshot_id=COALESCE(pre_snapshot_id,?),post_snapshot_id=COALESCE(post_snapshot_id,?),last_activity_at=?
          WHERE coding_session_id=?`,
      ).run(input.preSnapshotId ?? null, input.postSnapshotId ?? null, now, input.codingSessionId);
      return get(input.codingSessionId)!;
    },
    attachResult(input) {
      assertFence(input);
      deps.db.prepare(
        `UPDATE external_coding_sessions SET result_ref=COALESCE(result_ref,?),last_activity_at=?
          WHERE coding_session_id=?`,
      ).run(input.resultRef, input.now ?? Date.now(), input.codingSessionId);
      const current = get(input.codingSessionId)!;
      if (current.resultRef !== input.resultRef) throw new ExternalCodingSessionError('RESULT_IMMUTABLE', 'Coding result reference cannot be replaced');
      return current;
    },
    attachCandidateResult(input) {
      assertFence(input);
      deps.db.prepare(
        `UPDATE external_coding_sessions
            SET candidate_result_ref=COALESCE(candidate_result_ref,?),last_activity_at=?
          WHERE coding_session_id=?`,
      ).run(input.candidateResultRef, input.now ?? Date.now(), input.codingSessionId);
      const current = get(input.codingSessionId)!;
      if (current.candidateResultRef !== input.candidateResultRef) {
        throw new ExternalCodingSessionError('CANDIDATE_RESULT_IMMUTABLE', 'Coding candidate result reference cannot be replaced');
      }
      return current;
    },
    attachValidation(input) {
      const current = assertFence(input)!;
      const refs = [...new Set([...current.validationRefs, input.validationRef])].sort();
      deps.db.prepare(
        `UPDATE external_coding_sessions SET validation_refs_json=?,last_activity_at=? WHERE coding_session_id=?`,
      ).run(JSON.stringify(refs), input.now ?? Date.now(), input.codingSessionId);
      return get(input.codingSessionId)!;
    },
    requestCancellation(input) {
      const current = assertFence(input)!;
      if (TERMINAL_SESSION_STATES.has(current.state)) return current;
      const now = input.now ?? Date.now();
      deps.db.prepare(
        `UPDATE external_coding_sessions
            SET state='cancelling',cancellation_requested_at=COALESCE(cancellation_requested_at,?),last_activity_at=?
          WHERE coding_session_id=?`,
      ).run(now, now, input.codingSessionId);
      appendEvent({
        ...input,
        type: 'session.cancel_requested',
        payload: { persistedAt: now, ...(input.reason ? { reason: input.reason } : {}) },
      });
      return get(input.codingSessionId)!;
    },
    settleCancellation(input) {
      if (!deps.validateCancelledAuthority({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        fenceToken: input.childFenceToken,
      })) {
        throw new ExternalCodingSessionError(
          'CANCELLED_AUTHORITY_MISMATCH',
          'Cancelled Attempt does not own this coding session',
        );
      }
      const current = get(input.codingSessionId);
      if (!current
        || current.childJobId !== input.childJobId
        || current.childAttemptId !== input.childAttemptId
        || current.childGeneration !== input.childGeneration) {
        throw new ExternalCodingSessionError('SESSION_LINEAGE_MISMATCH', 'Cancelled coding session lineage does not match');
      }
      if (current.cancellationRequestedAt === null) {
        throw new ExternalCodingSessionError(
          'CANCELLATION_NOT_PERSISTED',
          'Coding session cancellation must be persisted before terminal settlement',
        );
      }
      const process = this.getProcess(input.codingSessionId);
      if ((process && process.processRecordId !== input.processRecordId)
        || (!process && input.processRecordId !== null)) {
        throw new ExternalCodingSessionError('PROCESS_IDENTITY_MISMATCH', 'Cancelled coding process identity does not match');
      }
      const eventType: ExternalCodingEventType = input.treeDeadVerified
        ? 'process.terminal'
        : 'reconciliation.started';
      const payload = redact({
        cancellation: true,
        processRecordId: input.processRecordId,
        exitCode: input.exitCode,
        exitSignal: input.exitSignal,
        treeDeadVerified: input.treeDeadVerified,
      }) as Record<string, unknown>;
      const payloadJson = JSON.stringify(canonical(payload));
      const payloadDigest = digest({ type: eventType, payload, authoritative: true });
      const now = input.now ?? Date.now();
      deps.db.transaction(() => {
        const prior = deps.db.prepare(
          'SELECT * FROM external_coding_events WHERE coding_session_id=? AND idempotency_key=?',
        ).get(input.codingSessionId, input.idempotencyKey) as EventRow | undefined;
        if (prior && (prior.type !== eventType || prior.payload_digest !== payloadDigest)) {
          throw new ExternalCodingSessionError('IDEMPOTENCY_CONFLICT', 'Cancelled coding settlement has different facts');
        }
        if (process) {
          deps.db.prepare(
            `UPDATE external_coding_processes
                SET state=?,exit_code=?,exit_signal=?,tree_dead_verified=?,exited_at=COALESCE(exited_at,?)
              WHERE process_record_id=? AND coding_session_id=? AND child_attempt_id=? AND generation=?`,
          ).run(
            input.treeDeadVerified ? 'exited' : 'unknown', input.exitCode, input.exitSignal,
            input.treeDeadVerified ? 1 : 0, now, process.processRecordId, input.codingSessionId,
            input.childAttemptId, input.childGeneration,
          );
        }
        deps.db.prepare(
          `UPDATE external_coding_sessions
              SET state=?,reconciliation_state=?,terminal_at=?,last_activity_at=?
            WHERE coding_session_id=? AND child_attempt_id=? AND child_generation=?
              AND cancellation_requested_at IS NOT NULL`,
        ).run(
          input.treeDeadVerified ? 'terminal' : 'reconciliation_required',
          input.treeDeadVerified ? 'reconciled' : 'required',
          input.treeDeadVerified ? now : null,
          now,
          input.codingSessionId,
          input.childAttemptId,
          input.childGeneration,
        );
        if (!prior) {
          const allocation = deps.db.prepare(
            `UPDATE external_coding_sessions
                SET next_event_sequence=next_event_sequence+1,last_activity_at=?
              WHERE coding_session_id=? AND child_attempt_id=? AND child_generation=?
              RETURNING next_event_sequence-1 AS sequence`,
          ).get(
            now, input.codingSessionId, input.childAttemptId, input.childGeneration,
          ) as { sequence: number } | undefined;
          if (!allocation) {
            throw new ExternalCodingSessionError('SESSION_LINEAGE_MISMATCH', 'Cancelled coding event lineage is no longer current');
          }
          const eventId = `coding_event_${randomBytes(16).toString('hex')}`;
          deps.db.prepare(
            `INSERT INTO external_coding_events
               (event_id,coding_session_id,sequence,child_attempt_id,generation,type,payload_json,
                payload_digest,producer,idempotency_key,authoritative,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
          ).run(
            eventId, input.codingSessionId, allocation.sequence, input.childAttemptId,
            input.childGeneration, eventType, payloadJson, payloadDigest, input.producer,
            input.idempotencyKey, now,
          );
          deps.appendOrderedEvent({
            ...input,
            type: `coding.${eventType}`,
            payload: { codingSessionId: input.codingSessionId, sequence: allocation.sequence, ...payload },
            idempotencyKey: `coding:${input.codingSessionId}:${input.idempotencyKey}`,
            now,
          });
        }
      }).immediate();
      return get(input.codingSessionId)!;
    },
    recoverCancellation(input) {
      if (!deps.validateCancelledAuthority({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        fenceToken: input.childFenceToken,
      })) {
        throw new ExternalCodingSessionError(
          'CANCELLED_AUTHORITY_MISMATCH',
          'Cancelled Attempt does not own this coding session',
        );
      }
      let current = get(input.codingSessionId);
      if (!current
        || current.childJobId !== input.childJobId
        || current.childAttemptId !== input.childAttemptId
        || current.childGeneration !== input.childGeneration) {
        throw new ExternalCodingSessionError('SESSION_LINEAGE_MISMATCH', 'Cancelled coding session lineage does not match');
      }
      const process = this.getProcess(input.codingSessionId);
      if (current.state === 'terminal' && current.cancellationRequestedAt !== null
        && (!process || process.treeDeadVerified)) {
        return current;
      }
      const now = input.now ?? Date.now();
      deps.db.prepare(
        `UPDATE external_coding_sessions
            SET state=CASE WHEN state='terminal' THEN state ELSE 'cancelling' END,
                cancellation_requested_at=COALESCE(cancellation_requested_at,?),last_activity_at=?
          WHERE coding_session_id=? AND child_attempt_id=? AND child_generation=?`,
      ).run(now, now, input.codingSessionId, input.childAttemptId, input.childGeneration);
      current = get(input.codingSessionId)!;
      persistEvent({
        ...input,
        type: 'session.cancel_requested',
        payload: { persistedAt: current.cancellationRequestedAt, recovered: true, reason: 'durable_job_already_cancelled' },
        authoritative: true,
      }, current, true);

      const termination = !process
        ? { treeDeadVerified: true }
        : process.treeDeadVerified
          ? { treeDeadVerified: true }
          : deps.terminateLostProcess?.(process.identity) ?? { treeDeadVerified: false };
      return this.settleCancellation({
        ...input,
        processRecordId: process?.processRecordId ?? null,
        exitCode: process?.exitCode ?? null,
        exitSignal: process?.exitSignal ?? null,
        treeDeadVerified: termination.treeDeadVerified,
        idempotencyKey: `${input.idempotencyKey}:settled`,
        now,
      });
    },
    requireReconciliation(input) {
      assertFence(input);
      const now = input.now ?? Date.now();
      deps.db.prepare(
        `UPDATE external_coding_sessions
            SET state='reconciliation_required',reconciliation_state='required',last_activity_at=?
          WHERE coding_session_id=?`,
      ).run(now, input.codingSessionId);
      deps.workspaces.markState({ ...input, workspaceLeaseId: get(input.codingSessionId)!.workspaceLeaseId, state: 'reconciliation_required' });
      appendEvent({
        ...input,
        type: 'reconciliation.started',
        payload: { reason: input.reason },
      });
      return get(input.codingSessionId)!;
    },
    recoverAfterLeaseLoss(input) {
      if (!deps.validateLostAuthority({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
      })) {
        throw new ExternalCodingSessionError('RECOVERY_AUTHORITY_MISMATCH', 'Lost Attempt is not an authoritative recovery target');
      }
      const row = deps.db.prepare(
        `SELECT coding_session_id FROM external_coding_sessions
          WHERE child_job_id=? AND child_attempt_id=? AND child_generation=?`,
      ).get(input.childJobId, input.childAttemptId, input.childGeneration) as { coding_session_id: string } | undefined;
      if (!row) return null;
      const current = get(row.coding_session_id)!;
      if (['terminal', 'failed', 'ready_for_review'].includes(current.state)) return current;
      const now = input.now ?? Date.now();
      const process = this.getProcess(current.codingSessionId);
      const termination = process && ['starting', 'running', 'stopping'].includes(process.state)
        ? deps.terminateLostProcess?.(process.identity) ?? null
        : null;
      deps.db.transaction(() => {
        deps.db.prepare(
          `UPDATE external_coding_sessions
              SET state='reconciliation_required',reconciliation_state='required',last_activity_at=?
            WHERE coding_session_id=? AND state NOT IN ('terminal','failed','ready_for_review')`,
        ).run(now, current.codingSessionId);
        deps.db.prepare(
          `UPDATE external_coding_processes
              SET state='unknown',exited_at=COALESCE(exited_at,?),
                  tree_dead_verified=CASE WHEN ?=1 THEN 1 ELSE tree_dead_verified END
            WHERE coding_session_id=? AND state IN ('starting','running','stopping')`,
        ).run(now, termination?.treeDeadVerified === true ? 1 : 0, current.codingSessionId);
      }).immediate();
      deps.workspaces.requireReconciliationAfterLeaseLoss({
        childJobId: input.childJobId,
        childAttemptId: input.childAttemptId,
        childGeneration: input.childGeneration,
        codingSessionId: current.codingSessionId,
        workspaceLeaseId: current.workspaceLeaseId,
        now,
      });
      const prior = deps.db.prepare(
        'SELECT 1 FROM external_coding_events WHERE coding_session_id=? AND idempotency_key=?',
      ).get(current.codingSessionId, input.idempotencyKey);
      if (!prior) {
        const payload = redact({
          reason: input.reason,
          authorityLost: true,
          processIdentityMatched: termination?.identityMatched ?? false,
          processSignalIssued: termination?.signalIssued ?? false,
          processTreeDeadVerified: termination?.treeDeadVerified ?? false,
        }) as Record<string, unknown>;
        const payloadJson = JSON.stringify(canonical(payload));
        const payloadDigest = digest({ type: 'reconciliation.started', payload, authoritative: true });
        const allocation = deps.db.prepare(
          `UPDATE external_coding_sessions
              SET next_event_sequence=next_event_sequence+1,last_activity_at=?
            WHERE coding_session_id=?
            RETURNING next_event_sequence-1 AS sequence`,
        ).get(now, current.codingSessionId) as { sequence: number };
        deps.db.prepare(
          `INSERT INTO external_coding_events
             (event_id,coding_session_id,sequence,child_attempt_id,generation,type,payload_json,
              payload_digest,producer,idempotency_key,authoritative,created_at)
           VALUES (?,?,?,?,?,'reconciliation.started',?,?,?,?,1,?)`,
        ).run(
          `coding_event_${randomBytes(16).toString('hex')}`,
          current.codingSessionId,
          allocation.sequence,
          input.childAttemptId,
          input.childGeneration,
          payloadJson,
          payloadDigest,
          input.producer,
          input.idempotencyKey,
          now,
        );
        deps.appendOrderedEvent({
          childJobId: input.childJobId,
          childAttemptId: input.childAttemptId,
          childGeneration: input.childGeneration,
          childFenceToken: '',
          type: 'coding.reconciliation.started',
          payload: { codingSessionId: current.codingSessionId, sequence: allocation.sequence, ...payload },
          producer: input.producer,
          idempotencyKey: `coding:${current.codingSessionId}:${input.idempotencyKey}`,
          now,
        });
      }
      return get(current.codingSessionId)!;
    },
    claimRecovery(input) {
      if (!deps.validateRecoveryAuthority({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        fenceToken: input.childFenceToken,
        recoveryOfAttemptId: input.recoveryOfAttemptId,
        recoveryOfGeneration: input.recoveryOfGeneration,
        now: input.now,
      })) {
        throw new ExternalCodingSessionError('RECOVERY_AUTHORITY_MISMATCH', 'Recovery Attempt does not descend from the lost coding authority');
      }
      const current = get(input.codingSessionId);
      if (!current || current.childJobId !== input.childJobId) {
        throw new ExternalCodingSessionError('SESSION_LINEAGE_MISMATCH', 'Recoverable coding session was not found for the child Job');
      }
      if (current.childAttemptId === input.childAttemptId && current.childGeneration === input.childGeneration) {
        return current;
      }
      if (current.childAttemptId !== input.recoveryOfAttemptId
        || current.childGeneration !== input.recoveryOfGeneration) {
        throw new ExternalCodingSessionError('SESSION_LINEAGE_MISMATCH', 'Coding session is not owned by the recovery predecessor');
      }
      if (!['process_terminal', 'reconciliation_required', 'verification_pending', 'ready_for_review'].includes(current.state)) {
        throw new ExternalCodingSessionError('RECOVERY_OUTCOME_UNKNOWN', 'Coding session has no settled provider outcome to recover');
      }
      const process = this.getProcess(current.codingSessionId);
      if (process && (process.state !== 'exited' || !process.treeDeadVerified)) {
        throw new ExternalCodingSessionError('RECOVERY_PROCESS_NOT_TERMINAL', 'Coding process tree is not durably terminal');
      }
      if (!current.candidateResultRef) {
        throw new ExternalCodingSessionError('RECOVERY_RESULT_MISSING', 'Coding candidate result is not durably recorded');
      }
      const resultEvent = deps.db.prepare(
        `SELECT payload_json FROM external_coding_events
          WHERE event_id=? AND coding_session_id=? AND type='result.reported'`,
      ).get(current.candidateResultRef, current.codingSessionId) as { payload_json: string } | undefined;
      if (!resultEvent) {
        throw new ExternalCodingSessionError('RECOVERY_RESULT_MISSING', 'Coding candidate result event is unavailable');
      }
      const now = input.now ?? Date.now();
      deps.db.transaction(() => {
        const session = deps.db.prepare(
          `UPDATE external_coding_sessions
              SET child_attempt_id=?,child_generation=?,state='verification_pending',
                  reconciliation_state='inspecting',last_activity_at=?
            WHERE coding_session_id=? AND child_attempt_id=? AND child_generation=?`,
        ).run(
          input.childAttemptId, input.childGeneration, now, input.codingSessionId,
          input.recoveryOfAttemptId, input.recoveryOfGeneration,
        );
        const workspace = deps.db.prepare(
          `UPDATE external_coding_workspace_leases
              SET child_attempt_id=?,generation=?,state='reconciliation_required',last_validated_at=?
            WHERE workspace_lease_id=? AND coding_session_id=?
              AND child_attempt_id=? AND generation=? AND state NOT IN ('released','failed')`,
        ).run(
          input.childAttemptId, input.childGeneration, now, current.workspaceLeaseId,
          input.codingSessionId, input.recoveryOfAttemptId, input.recoveryOfGeneration,
        );
        if (session.changes !== 1 || workspace.changes !== 1) {
          throw new ExternalCodingSessionError('RECOVERY_CLAIM_CONFLICT', 'Coding recovery ownership changed concurrently');
        }
      }).immediate();
      this.appendEvent({
        ...input,
        type: 'reconciliation.started',
        payload: {
          recoveryOfAttemptId: input.recoveryOfAttemptId,
          recoveryOfGeneration: input.recoveryOfGeneration,
          processTreeDeadVerified: process?.treeDeadVerified ?? true,
        },
        idempotencyKey: input.idempotencyKey,
      });
      return get(input.codingSessionId)!;
    },
    async discardUnknown(input) {
      assertIdentity(input.codingSessionId, 'Coding session identity');
      assertIdentity(input.idempotencyKey, 'Coding reconciliation idempotency key');
      if (!input.decidedBy.trim() || !input.decisionChannel.trim()) {
        throw new ExternalCodingSessionError(
          'INVALID_RECONCILIATION_DECISION',
          'Coding reconciliation requires an exact decision identity and channel',
        );
      }
      let current = get(input.codingSessionId);
      if (!current) {
        throw new ExternalCodingSessionError('SESSION_NOT_FOUND', 'Coding session was not found');
      }
      const workspace = deps.workspaces.get(current.workspaceLeaseId);
      if (current.state === 'failed' && current.reconciliationState === 'reconciled'
        && workspace?.state === 'released') {
        if (!safeSessionHome(input.sessionHomeParent, current.sessionHomePath, current.codingSessionId)) {
          throw new ExternalCodingSessionError('UNSAFE_SESSION_HOME', 'Coding session HOME is outside its managed root');
        }
        await rm(current.sessionHomePath, { recursive: true, force: true });
        return current;
      }
      if (!['unknown', 'reconciliation_required'].includes(current.state)
        || !['required', 'blocked_unknown'].includes(current.reconciliationState)) {
        throw new ExternalCodingSessionError(
          'RECONCILIATION_STATE_MISMATCH',
          'Coding session is not awaiting an explicit unknown-outcome decision',
        );
      }
      const process = this.getProcess(input.codingSessionId);
      if (process && (!['exited', 'unknown'].includes(process.state) || !process.treeDeadVerified)) {
        throw new ExternalCodingSessionError(
          'RECONCILIATION_PROCESS_ACTIVE',
          'Coding process termination must be verified before discarding its isolated attempt',
        );
      }
      if (!safeSessionHome(input.sessionHomeParent, current.sessionHomePath, current.codingSessionId)) {
        throw new ExternalCodingSessionError('UNSAFE_SESSION_HOME', 'Coding session HOME is outside its managed root');
      }
      const now = input.now ?? Date.now();
      await deps.workspaces.releaseReconciled({
        childJobId: current.childJobId,
        childAttemptId: current.childAttemptId,
        childGeneration: current.childGeneration,
        workspaceLeaseId: current.workspaceLeaseId,
        codingSessionId: current.codingSessionId,
        now,
      });
      await rm(current.sessionHomePath, { recursive: true, force: true });
      const changed = deps.db.prepare(
        `UPDATE external_coding_sessions
            SET state='failed',reconciliation_state='reconciled',terminal_at=COALESCE(terminal_at,?),last_activity_at=?
          WHERE coding_session_id=? AND child_attempt_id=? AND child_generation=?
            AND state IN ('unknown','reconciliation_required')
            AND reconciliation_state IN ('required','blocked_unknown')`,
      ).run(
        now, now, current.codingSessionId, current.childAttemptId, current.childGeneration,
      );
      if (changed.changes !== 1) {
        current = get(input.codingSessionId);
        if (!current || current.state !== 'failed' || current.reconciliationState !== 'reconciled') {
          throw new ExternalCodingSessionError(
            'RECONCILIATION_DECISION_CONFLICT',
            'Coding reconciliation state changed before the discard decision completed',
          );
        }
        return current;
      }
      current = get(input.codingSessionId)!;
      persistEvent({
        codingSessionId: current.codingSessionId,
        childJobId: current.childJobId,
        childAttemptId: current.childAttemptId,
        childGeneration: current.childGeneration,
        childFenceToken: '',
        type: 'reconciliation.completed',
        payload: {
          outcome: 'discarded',
          decidedBy: input.decidedBy,
          decisionChannel: input.decisionChannel,
          workspaceReleased: true,
          processTreeDeadVerified: process?.treeDeadVerified ?? true,
        },
        producer: 'external-coding-reconciliation',
        idempotencyKey: input.idempotencyKey,
        now,
      }, current, true);
      return get(input.codingSessionId)!;
    },
  };
}
