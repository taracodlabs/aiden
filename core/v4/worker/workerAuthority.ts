/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import type { ExecutionGraphAuthority } from '../daemon/executionGraph';
import {
  computeWorkerDigest,
  computeWorkerResultHash,
  type WorkerAssignmentRecord,
  type WorkerContextEnvelopeRecord,
  type WorkerEventKind,
  type WorkerEventRecord,
  type WorkerProjection,
  type WorkerProviderBindingRecord,
  type WorkerResultPayloadV1,
  type WorkerResultRecord,
  type WorkerResultRejectionCode,
  type WorkerResultStatus,
  type WorkerRunRecord,
} from './types';

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const FINAL_RESULT_STATUS = new Set<WorkerResultStatus>(['completed', 'failed', 'cancelled', 'timed_out', 'blocked']);
const RESULT_STATUS = new Set<WorkerResultStatus>(['completed', 'partial', 'failed', 'cancelled', 'timed_out', 'blocked']);
const MAX_LIST_ITEMS = 256;
const MAX_NOTE_CHARS = 4_096;
const MAX_GOAL_CHARS = 16_384;
const MAX_SUMMARY_CHARS = 65_536;
const MAX_FIELD_CHARS = 8_192;
const MAX_RESULT_BYTES = 512 * 1024;

export class WorkerAuthorityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerAuthorityError';
    this.code = code;
  }
}

interface ParentAuthorityCommand {
  parentJobId: string;
  parentAttemptId: string;
  parentGeneration: number;
  parentFenceToken: string;
  producer: string;
  idempotencyKey: string;
  now?: number;
}

interface ChildAuthorityCommand {
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  childFenceToken: string;
}

interface WorkerAuthorityDeps {
  db: Db;
  graph: ExecutionGraphAuthority;
  validateActiveFence(command: {
    jobId: string; attemptId: string; generation: number; fenceToken: string; now?: number;
  }): { valid: boolean; runId?: number };
  appendOrderedEvent(command: {
    jobId: string; runId: number; attemptId: string; generation: number;
    kind: WorkerEventKind; payload: Record<string, unknown>;
    producer: string; idempotencyKey: string;
  }): { duplicate: boolean; sequence: number };
}

type ProviderBindingCommand = ParentAuthorityCommand & Omit<WorkerProviderBindingRecord,
  'bindingHash' | 'createdAt'>;

type ContextEnvelopeCommand = ParentAuthorityCommand & Omit<WorkerContextEnvelopeRecord,
  'contentDigest' | 'createdAt'>;

type AssignmentCommand = ParentAuthorityCommand & Omit<WorkerAssignmentRecord,
  'idempotencyKey' | 'parentFenceDigest' | 'executionGraphNodeId' | 'inputHash' | 'createdAt'>;

type BindRunCommand = ParentAuthorityCommand & ChildAuthorityCommand & Omit<WorkerRunRecord,
  'idempotencyKey' | 'childJobId' | 'childAttemptId' | 'childGeneration'
  | 'executionGraphNodeId' | 'acceptedResultId' | 'createdAt'>;

interface RecordResultCommand extends ParentAuthorityCommand, ChildAuthorityCommand {
  workerResultId: string;
  workerRunId: string;
  assignmentId: string;
  payload: unknown;
}

export interface WorkerAuthority {
  createWorkerProviderBinding(command: ProviderBindingCommand): WorkerProviderBindingRecord;
  createWorkerContextEnvelope(command: ContextEnvelopeCommand): WorkerContextEnvelopeRecord;
  createWorkerAssignment(command: AssignmentCommand): WorkerAssignmentRecord;
  bindWorkerRun(command: BindRunCommand): WorkerRunRecord;
  recordWorkerResult(command: RecordResultCommand): WorkerResultRecord;
  getWorkerAssignment(id: string): WorkerAssignmentRecord | null;
  getWorkerRun(id: string): WorkerRunRecord | null;
  getWorkerProviderBinding(id: string): WorkerProviderBindingRecord | null;
  getWorkerContextEnvelope(id: string): WorkerContextEnvelopeRecord | null;
  getWorkerResult(id: string): WorkerResultRecord | null;
  listWorkerRunsForParent(parentJobId: string): WorkerRunRecord[];
  listWorkerRunsForChild(childJobId: string): WorkerRunRecord[];
  listWorkerEvents(parentJobId: string): WorkerEventRecord[];
  rebuildWorkerProjection(parentJobId: string): WorkerProjection;
}

type AssignmentRow = {
  assignment_id: string; schema_version: number; idempotency_key: string;
  worker_definition_id: string; worker_definition_version: number;
  parent_job_id: string; parent_attempt_id: string; parent_generation: number; parent_fence_digest: string;
  child_contract_id: string; child_job_id: string; repository_snapshot_id: string | null;
  execution_graph_node_id: string | null; context_envelope_id: string; provider_binding_id: string;
  capability_set_id: string | null; goal: string; expected_result_schema_id: string;
  expected_evidence_schema_id: string | null; input_hash: string; created_at: number;
};

type RunRow = {
  worker_run_id: string; schema_version: number; idempotency_key: string; assignment_id: string;
  child_job_id: string; child_attempt_id: string; child_generation: number;
  execution_graph_node_id: string | null; provider_binding_id: string; context_envelope_id: string;
  accepted_result_id: string | null; created_at: number;
};

type BindingRow = {
  provider_binding_id: string; schema_version: number; provider_id: string; model_id: string;
  provider_runtime_identity: string; credential_reference: string | null; endpoint_reference: string | null;
  capability_snapshot_hash: string; selection_reason: string; fallback_policy_id: string | null;
  context_window: number; max_output_tokens: number; binding_hash: string; created_at: number;
};

type ContextRow = {
  context_envelope_id: string; schema_version: number; assignment_id: string;
  repository_snapshot_id: string | null; plan_step_ids_json: string; claim_ids_json: string;
  source_reference_ids_json: string; instruction_reference_ids_json: string; bounded_parent_note: string | null;
  tool_schema_digest: string; content_digest: string; token_estimate: number; created_at: number;
};

type ResultRow = {
  worker_result_id: string; schema_version: number; worker_run_id: string; assignment_id: string;
  child_job_id: string; child_attempt_id: string; child_generation: number; idempotency_key: string;
  status: WorkerResultStatus | 'invalid'; summary: string; structured_payload_json: string | null;
  evidence_ids_json: string; provider_attempt_ids_json: string; input_hash: string; result_hash: string;
  acceptance_state: WorkerResultRecord['acceptanceState']; rejection_code: WorkerResultRejectionCode | null;
  rejection_reason: string | null; created_at: number; accepted_at: number | null; rejected_at: number | null;
};

function array(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function mapAssignment(row: AssignmentRow): WorkerAssignmentRecord {
  return {
    assignmentId: row.assignment_id, schemaVersion: 1, idempotencyKey: row.idempotency_key,
    workerDefinitionId: row.worker_definition_id, workerDefinitionVersion: row.worker_definition_version,
    parentJobId: row.parent_job_id, parentAttemptId: row.parent_attempt_id,
    parentGeneration: row.parent_generation, parentFenceDigest: row.parent_fence_digest,
    childContractId: row.child_contract_id, childJobId: row.child_job_id,
    repositorySnapshotId: row.repository_snapshot_id, executionGraphNodeId: row.execution_graph_node_id,
    contextEnvelopeId: row.context_envelope_id, providerBindingId: row.provider_binding_id,
    capabilitySetId: row.capability_set_id, goal: row.goal,
    expectedResultSchemaId: row.expected_result_schema_id,
    expectedEvidenceSchemaId: row.expected_evidence_schema_id,
    inputHash: row.input_hash, createdAt: row.created_at,
  };
}

function mapRun(row: RunRow): WorkerRunRecord {
  return {
    workerRunId: row.worker_run_id, schemaVersion: 1, assignmentId: row.assignment_id,
    childJobId: row.child_job_id, childAttemptId: row.child_attempt_id,
    childGeneration: row.child_generation, executionGraphNodeId: row.execution_graph_node_id,
    providerBindingId: row.provider_binding_id, contextEnvelopeId: row.context_envelope_id,
    acceptedResultId: row.accepted_result_id, createdAt: row.created_at,
  };
}

function mapBinding(row: BindingRow): WorkerProviderBindingRecord {
  return {
    providerBindingId: row.provider_binding_id, schemaVersion: 1,
    providerId: row.provider_id, modelId: row.model_id,
    providerRuntimeIdentity: row.provider_runtime_identity,
    credentialReference: row.credential_reference, endpointReference: row.endpoint_reference,
    capabilitySnapshotHash: row.capability_snapshot_hash, selectionReason: row.selection_reason,
    fallbackPolicyId: row.fallback_policy_id, contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens, bindingHash: row.binding_hash, createdAt: row.created_at,
  };
}

function mapContext(row: ContextRow): WorkerContextEnvelopeRecord {
  return {
    contextEnvelopeId: row.context_envelope_id, schemaVersion: 1, assignmentId: row.assignment_id,
    repositorySnapshotId: row.repository_snapshot_id, planStepIds: array(row.plan_step_ids_json),
    claimIds: array(row.claim_ids_json), sourceReferenceIds: array(row.source_reference_ids_json),
    instructionReferenceIds: array(row.instruction_reference_ids_json), boundedParentNote: row.bounded_parent_note,
    toolSchemaDigest: row.tool_schema_digest, contentDigest: row.content_digest,
    tokenEstimate: row.token_estimate, createdAt: row.created_at,
  };
}

function mapResult(row: ResultRow): WorkerResultRecord {
  return {
    workerResultId: row.worker_result_id, schemaVersion: 1, workerRunId: row.worker_run_id,
    assignmentId: row.assignment_id, childJobId: row.child_job_id,
    childAttemptId: row.child_attempt_id, childGeneration: row.child_generation,
    idempotencyKey: row.idempotency_key, status: row.status, summary: row.summary,
    payload: row.structured_payload_json === null
      ? null
      : JSON.parse(row.structured_payload_json) as WorkerResultPayloadV1,
    evidenceIds: array(row.evidence_ids_json), providerAttemptIds: array(row.provider_attempt_ids_json),
    inputHash: row.input_hash, resultHash: row.result_hash,
    acceptanceState: row.acceptance_state, rejectionCode: row.rejection_code,
    rejectionReason: row.rejection_reason, createdAt: row.created_at,
    acceptedAt: row.accepted_at, rejectedAt: row.rejected_at,
  };
}

function assertId(value: string, label: string): void {
  if (!ID.test(value)) throw new WorkerAuthorityError('invalid_identity', `${label} is invalid`);
}

function assertHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new WorkerAuthorityError('invalid_hash', `${label} must be a SHA-256 digest`);
}

function assertString(value: unknown, label: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new WorkerAuthorityError('invalid_contract', `${label} is invalid`);
  }
}

function assertStringList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS
    || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 512)) {
    throw new WorkerAuthorityError('invalid_contract', `${label} is invalid`);
  }
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function hasForbiddenKey(value: unknown, forbidden: ReadonlySet<string>, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, forbidden, seen));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    forbidden.has(normalizedKey(key)) || hasForbiddenKey(item, forbidden, seen)
  ));
}

function secretValuePath(value: unknown, path = 'record', seen = new Set<object>()): string | null {
  if (typeof value === 'string') {
    return /(?:bearer\s+[a-z0-9._-]{12,}|(?:^|[^a-z0-9])(?:sk|gsk|ghp|gho|npm)_[a-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/iu.test(value)
      ? path
      : null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const match = secretValuePath(item, `${path}.${key}`, seen);
    if (match) return match;
  }
  return null;
}

function assertSafeInput(value: unknown, forbidden: ReadonlySet<string>): void {
  if (hasForbiddenKey(value, forbidden)) {
    throw new WorkerAuthorityError('sensitive_input', 'Sensitive fields are not permitted in Worker records');
  }
  const secretPath = secretValuePath(value);
  if (secretPath) {
    throw new WorkerAuthorityError('sensitive_input', `Secret values are not permitted in Worker records (${secretPath})`);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, max = MAX_FIELD_CHARS): value is string {
  return typeof value === 'string' && value.length <= max;
}

function boundedStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_LIST_ITEMS
    && value.every((item) => boundedString(item, 512));
}

function validSourceReference(value: unknown): boolean {
  const item = object(value);
  if (!item || !boundedString(item.snapshotId, 512) || !boundedString(item.snapshotEntryId, 512)
    || !boundedString(item.path) || !boundedString(item.contentHash, 64) || !HASH.test(item.contentHash)) return false;
  const start = item.startLine;
  const end = item.endLine;
  if (start === undefined && end === undefined) return true;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && Number(start) >= 1 && Number(end) >= Number(start);
}

function validResultShape(item: Partial<WorkerResultPayloadV1>): boolean {
  const findings = item.findings;
  const files = item.filesInspected;
  const commands = item.commandsExecuted;
  const diagnostics = item.diagnostics;
  const budgets = item.budgetUsage;
  const uncertainty = object(item.uncertainty);
  const timing = object(item.timing);
  const failure = item.failure === null ? null : object(item.failure);
  return item.schemaVersion === 1
    && typeof item.status === 'string' && RESULT_STATUS.has(item.status as WorkerResultStatus)
    && boundedString(item.summary, MAX_SUMMARY_CHARS)
    && Array.isArray(findings) && findings.every((value) => {
      const finding = object(value);
      return Boolean(finding && boundedString(finding.findingId, 512)
        && boundedString(finding.statement, MAX_SUMMARY_CHARS)
        && Array.isArray(finding.sourceReferences) && finding.sourceReferences.every(validSourceReference)
        && boundedStringArray(finding.evidenceIds)
        && ['low', 'medium', 'high'].includes(String(finding.uncertainty)));
    })
    && Array.isArray(item.sourceReferences) && item.sourceReferences.every(validSourceReference)
    && Array.isArray(files) && files.every((value) => {
      const file = object(value);
      return Boolean(file && boundedString(file.snapshotEntryId, 512) && boundedString(file.path)
        && boundedString(file.contentHash, 64) && HASH.test(file.contentHash));
    })
    && Array.isArray(commands) && commands.every((value) => {
      const command = object(value);
      return Boolean(command && boundedString(command.toolCallId, 512) && boundedString(command.tool, 512)
        && boundedString(command.inputHash, 64) && HASH.test(command.inputHash)
        && boundedString(command.status, 128));
    })
    && Array.isArray(diagnostics) && diagnostics.every((value) => {
      const diagnostic = object(value);
      return Boolean(diagnostic && boundedString(diagnostic.code, 512)
        && boundedString(diagnostic.message, MAX_FIELD_CHARS)
        && ['info', 'warning', 'error'].includes(String(diagnostic.severity)));
    })
    && boundedStringArray(item.evidenceIds)
    && boundedStringArray(item.unresolvedQuestions)
    && Boolean(uncertainty && ['low', 'medium', 'high'].includes(String(uncertainty.level))
      && boundedStringArray(uncertainty.reasons))
    && boundedStringArray(item.providerAttemptIds)
    && Array.isArray(budgets) && budgets.every((value) => {
      const budget = object(value);
      return Boolean(budget && boundedString(budget.kind, 128)
        && (budget.amount === null || (typeof budget.amount === 'number' && Number.isFinite(budget.amount)))
        && (budget.debitId === undefined || boundedString(budget.debitId, 512))
        && (budget.unknownReason === undefined || boundedString(budget.unknownReason, MAX_FIELD_CHARS)));
    })
    && Boolean(timing && typeof timing.startedAt === 'number' && Number.isFinite(timing.startedAt)
      && typeof timing.completedAt === 'number' && Number.isFinite(timing.completedAt)
      && timing.completedAt >= timing.startedAt
      && typeof timing.wallClockMs === 'number' && Number.isFinite(timing.wallClockMs)
      && timing.wallClockMs >= 0)
    && (item.failure === null || Boolean(failure
      && ['provider', 'auth', 'budget', 'timeout', 'cancelled', 'tool', 'validation', 'authority_lost', 'unknown']
        .includes(String(failure.category))
      && boundedString(failure.code, 512) && boundedString(failure.message, MAX_FIELD_CHARS)
      && typeof failure.retryable === 'boolean' && typeof failure.externalOutcomeUnknown === 'boolean'))
    && typeof item.inputHash === 'string' && HASH.test(item.inputHash)
    && typeof item.resultHash === 'string' && HASH.test(item.resultHash);
}

function resultPayload(value: unknown): { payload: WorkerResultPayloadV1 | null; serialized: string | null; tooLarge: boolean } {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return { payload: null, serialized: null, tooLarge: false }; }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) return { payload: null, serialized: null, tooLarge: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { payload: null, serialized: null, tooLarge: false };
  const item = value as Partial<WorkerResultPayloadV1>;
  const boundedLists = [
    item.findings, item.sourceReferences, item.filesInspected, item.commandsExecuted,
    item.diagnostics, item.evidenceIds, item.unresolvedQuestions,
    item.providerAttemptIds, item.budgetUsage, item.uncertainty?.reasons,
  ];
  if ((typeof item.summary === 'string' && item.summary.length > MAX_SUMMARY_CHARS)
    || boundedLists.some((list) => Array.isArray(list) && list.length > MAX_LIST_ITEMS)) {
    return { payload: null, serialized: null, tooLarge: true };
  }
  if (!validResultShape(item)) return { payload: null, serialized: null, tooLarge: false };
  if (hasForbiddenKey(item, new Set(['apikey', 'accesstoken', 'refreshtoken', 'cookie', 'cookies', 'authorization', 'authorizationheader']))
    || secretValuePath(item)) return { payload: null, serialized: null, tooLarge: false };
  return { payload: item as WorkerResultPayloadV1, serialized, tooLarge: false };
}

export function createWorkerAuthority(deps: WorkerAuthorityDeps): WorkerAuthority {
  const { db, graph } = deps;

  const getAssignment = (id: string): WorkerAssignmentRecord | null => {
    const row = db.prepare('SELECT * FROM worker_assignments WHERE assignment_id=?').get(id) as AssignmentRow | undefined;
    return row ? mapAssignment(row) : null;
  };
  const getRun = (id: string): WorkerRunRecord | null => {
    const row = db.prepare('SELECT * FROM worker_runs WHERE worker_run_id=?').get(id) as RunRow | undefined;
    return row ? mapRun(row) : null;
  };
  const getBinding = (id: string): WorkerProviderBindingRecord | null => {
    const row = db.prepare('SELECT * FROM worker_provider_bindings WHERE provider_binding_id=?').get(id) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  };
  const getContext = (id: string): WorkerContextEnvelopeRecord | null => {
    const row = db.prepare('SELECT * FROM worker_context_envelopes WHERE context_envelope_id=?').get(id) as ContextRow | undefined;
    return row ? mapContext(row) : null;
  };
  const getResult = (id: string): WorkerResultRecord | null => {
    const row = db.prepare('SELECT * FROM worker_results WHERE worker_result_id=?').get(id) as ResultRow | undefined;
    return row ? mapResult(row) : null;
  };

  const parentFence = (command: ParentAuthorityCommand): { runId: number } => {
    const result = deps.validateActiveFence({
      jobId: command.parentJobId, attemptId: command.parentAttemptId,
      generation: command.parentGeneration, fenceToken: command.parentFenceToken, now: command.now,
    });
    if (!result.valid || result.runId === undefined) {
      throw new WorkerAuthorityError('stale_authority', 'Parent Attempt authority is no longer active');
    }
    return { runId: result.runId };
  };

  const append = (command: ParentAuthorityCommand, runId: number, kind: WorkerEventKind, payload: Record<string, unknown>, suffix: string): void => {
    deps.appendOrderedEvent({
      jobId: command.parentJobId, runId, attemptId: command.parentAttemptId,
      generation: command.parentGeneration, kind, payload, producer: command.producer,
      idempotencyKey: `${command.idempotencyKey}:${suffix}`,
    });
  };

  const createBinding = db.transaction((command: ProviderBindingCommand): WorkerProviderBindingRecord => {
    assertSafeInput(command, new Set(['apikey', 'accesstoken', 'refreshtoken', 'cookie', 'cookies', 'authorization', 'authorizationheader', 'environment', 'env']));
    assertId(command.providerBindingId, 'Provider binding identity');
    if (command.schemaVersion !== 1) throw new WorkerAuthorityError('invalid_contract', 'Unsupported provider binding schema');
    for (const [value, label] of [[command.providerId, 'Provider'], [command.modelId, 'Model'], [command.providerRuntimeIdentity, 'Runtime identity']] as const) {
      assertString(value, label, 512);
    }
    assertHash(command.capabilitySnapshotHash, 'Capability snapshot hash');
    assertString(command.selectionReason, 'Selection reason', 2_048);
    if (!Number.isSafeInteger(command.contextWindow) || command.contextWindow < 1
      || !Number.isSafeInteger(command.maxOutputTokens) || command.maxOutputTokens < 1) {
      throw new WorkerAuthorityError('invalid_contract', 'Provider token limits are invalid');
    }
    const bindingHash = computeWorkerDigest({
      schemaVersion: 1, providerId: command.providerId, modelId: command.modelId,
      providerRuntimeIdentity: command.providerRuntimeIdentity,
      credentialReference: command.credentialReference, endpointReference: command.endpointReference,
      capabilitySnapshotHash: command.capabilitySnapshotHash, selectionReason: command.selectionReason,
      fallbackPolicyId: command.fallbackPolicyId, contextWindow: command.contextWindow,
      maxOutputTokens: command.maxOutputTokens,
    });
    const existing = getBinding(command.providerBindingId);
    if (existing) {
      if (existing.bindingHash !== bindingHash) throw new WorkerAuthorityError('immutable_conflict', 'Provider binding identity already exists');
      return existing;
    }
    const { runId } = parentFence(command);
    const now = command.now ?? Date.now();
    db.prepare(
      `INSERT INTO worker_provider_bindings
         (provider_binding_id,schema_version,provider_id,model_id,provider_runtime_identity,
          credential_reference,endpoint_reference,capability_snapshot_hash,selection_reason,
          fallback_policy_id,context_window,max_output_tokens,binding_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      command.providerBindingId, 1, command.providerId, command.modelId, command.providerRuntimeIdentity,
      command.credentialReference, command.endpointReference, command.capabilitySnapshotHash,
      command.selectionReason, command.fallbackPolicyId, command.contextWindow,
      command.maxOutputTokens, bindingHash, now,
    );
    append(command, runId, 'worker.provider_binding_created', {
      providerBindingId: command.providerBindingId, bindingHash,
    }, 'provider-binding-created');
    return getBinding(command.providerBindingId)!;
  }).immediate;

  const createContext = db.transaction((command: ContextEnvelopeCommand): WorkerContextEnvelopeRecord => {
    assertSafeInput(command, new Set(['env', 'environment', 'environmentvariables', 'conversationhistory', 'messages', 'fencetoken', 'apikey', 'accesstoken', 'refreshtoken', 'authorization']));
    assertId(command.contextEnvelopeId, 'Context envelope identity');
    assertId(command.assignmentId, 'Assignment identity');
    if (command.schemaVersion !== 1) throw new WorkerAuthorityError('invalid_contract', 'Unsupported context schema');
    assertStringList(command.planStepIds, 'Plan step references');
    assertStringList(command.claimIds, 'Claim references');
    assertStringList(command.sourceReferenceIds, 'Source references');
    assertStringList(command.instructionReferenceIds, 'Instruction references');
    if (command.boundedParentNote !== null) assertString(command.boundedParentNote, 'Parent note', MAX_NOTE_CHARS, true);
    assertHash(command.toolSchemaDigest, 'Tool schema digest');
    if (!Number.isSafeInteger(command.tokenEstimate) || command.tokenEstimate < 0) {
      throw new WorkerAuthorityError('invalid_contract', 'Token estimate is invalid');
    }
    if (command.repositorySnapshotId) {
      const snapshot = db.prepare('SELECT job_id FROM repository_snapshots WHERE snapshot_id=?')
        .get(command.repositorySnapshotId) as { job_id: string } | undefined;
      if (!snapshot || snapshot.job_id !== command.parentJobId) {
        throw new WorkerAuthorityError('reference_mismatch', 'Repository snapshot does not belong to the parent Job');
      }
    }
    for (const claimId of command.claimIds) {
      if (!db.prepare('SELECT 1 FROM job_claims WHERE claim_id=? AND job_id=?').get(claimId, command.parentJobId)) {
        throw new WorkerAuthorityError('reference_mismatch', 'Claim reference does not belong to the parent Job');
      }
    }
    const graphNodeIds = new Set(graph.nodes(command.parentJobId).map((node) => node.nodeId));
    if (command.planStepIds.some((id) => !graphNodeIds.has(id))) {
      throw new WorkerAuthorityError('reference_mismatch', 'Plan step reference does not belong to the parent graph');
    }
    const contentDigest = computeWorkerDigest({
      schemaVersion: 1, assignmentId: command.assignmentId,
      repositorySnapshotId: command.repositorySnapshotId,
      planStepIds: command.planStepIds, claimIds: command.claimIds,
      sourceReferenceIds: command.sourceReferenceIds,
      instructionReferenceIds: command.instructionReferenceIds,
      boundedParentNote: command.boundedParentNote,
      toolSchemaDigest: command.toolSchemaDigest, tokenEstimate: command.tokenEstimate,
    });
    const existing = getContext(command.contextEnvelopeId);
    if (existing) {
      if (existing.contentDigest !== contentDigest) throw new WorkerAuthorityError('immutable_conflict', 'Context envelope identity already exists');
      return existing;
    }
    const { runId } = parentFence(command);
    const now = command.now ?? Date.now();
    db.prepare(
      `INSERT INTO worker_context_envelopes
         (context_envelope_id,schema_version,assignment_id,repository_snapshot_id,
          plan_step_ids_json,claim_ids_json,source_reference_ids_json,instruction_reference_ids_json,
          bounded_parent_note,tool_schema_digest,content_digest,token_estimate,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      command.contextEnvelopeId, 1, command.assignmentId, command.repositorySnapshotId,
      JSON.stringify(command.planStepIds), JSON.stringify(command.claimIds),
      JSON.stringify(command.sourceReferenceIds), JSON.stringify(command.instructionReferenceIds),
      command.boundedParentNote, command.toolSchemaDigest, contentDigest, command.tokenEstimate, now,
    );
    append(command, runId, 'worker.context_finalized', {
      contextEnvelopeId: command.contextEnvelopeId, assignmentId: command.assignmentId, contentDigest,
    }, 'context-finalized');
    return getContext(command.contextEnvelopeId)!;
  }).immediate;

  const createAssignment = db.transaction((command: AssignmentCommand): WorkerAssignmentRecord => {
    assertId(command.assignmentId, 'Assignment identity');
    if (command.schemaVersion !== 1) throw new WorkerAuthorityError('invalid_contract', 'Unsupported assignment schema');
    assertString(command.workerDefinitionId, 'Worker definition', 192);
    if (!Number.isSafeInteger(command.workerDefinitionVersion) || command.workerDefinitionVersion < 1) {
      throw new WorkerAuthorityError('invalid_contract', 'Worker definition version is invalid');
    }
    assertString(command.goal, 'Worker goal', MAX_GOAL_CHARS);
    const inputHash = computeWorkerDigest({
      schemaVersion: 1, workerDefinitionId: command.workerDefinitionId,
      workerDefinitionVersion: command.workerDefinitionVersion,
      parentJobId: command.parentJobId, parentAttemptId: command.parentAttemptId,
      parentGeneration: command.parentGeneration, childContractId: command.childContractId,
      childJobId: command.childJobId, repositorySnapshotId: command.repositorySnapshotId,
      contextEnvelopeId: command.contextEnvelopeId, providerBindingId: command.providerBindingId,
      capabilitySetId: command.capabilitySetId, goal: command.goal,
      expectedResultSchemaId: command.expectedResultSchemaId,
      expectedEvidenceSchemaId: command.expectedEvidenceSchemaId,
    });
    const idempotent = db.prepare('SELECT * FROM worker_assignments WHERE idempotency_key=?')
      .get(command.idempotencyKey) as AssignmentRow | undefined;
    if (idempotent) {
      if (idempotent.input_hash !== inputHash) throw new WorkerAuthorityError('idempotency_conflict', 'Assignment idempotency key has different input');
      return mapAssignment(idempotent);
    }
    if (getAssignment(command.assignmentId)) throw new WorkerAuthorityError('immutable_conflict', 'Assignment identity already exists');
    const { runId } = parentFence(command);
    const child = db.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(command.childJobId) as { parent_task_id: string | null } | undefined;
    const contract = db.prepare('SELECT parent_job_id,worker_id FROM child_job_contracts WHERE child_job_id=?')
      .get(command.childContractId) as { parent_job_id: string; worker_id: string } | undefined;
    if (!child || child.parent_task_id !== command.parentJobId || command.childContractId !== command.childJobId
      || !contract || contract.parent_job_id !== command.parentJobId || contract.worker_id !== command.workerDefinitionId) {
      throw new WorkerAuthorityError('lineage_mismatch', 'Child Job contract does not belong to the parent assignment');
    }
    const binding = getBinding(command.providerBindingId);
    const context = getContext(command.contextEnvelopeId);
    if (!binding || !context || context.assignmentId !== command.assignmentId) {
      throw new WorkerAuthorityError('reference_mismatch', 'Assignment references are incomplete or inconsistent');
    }
    if (command.repositorySnapshotId !== context.repositorySnapshotId) {
      throw new WorkerAuthorityError('reference_mismatch', 'Assignment and context snapshot references differ');
    }
    if (command.capabilitySetId
      && !db.prepare('SELECT 1 FROM job_capability_sets WHERE job_id=?').get(command.capabilitySetId)) {
      throw new WorkerAuthorityError('reference_mismatch', 'Capability set does not exist');
    }
    let executionGraphNodeId: string | null = null;
    if (graph.nodes(command.parentJobId).length > 0) {
      const linked = graph.attachWorkerAssignment({
        parentJobId: command.parentJobId, parentAttemptId: command.parentAttemptId,
        parentGeneration: command.parentGeneration, parentFenceToken: command.parentFenceToken,
        assignmentId: command.assignmentId, producer: command.producer,
        idempotencyKey: `${command.idempotencyKey}:graph`, now: command.now,
      });
      if (!linked.applied && !linked.duplicate) throw new WorkerAuthorityError('graph_conflict', 'Assignment graph reference was rejected');
      executionGraphNodeId = linked.nodeId ?? null;
    }
    const now = command.now ?? Date.now();
    const parentFenceDigest = createHash('sha256').update(command.parentFenceToken).digest('hex');
    db.prepare(
      `INSERT INTO worker_assignments
         (assignment_id,schema_version,idempotency_key,worker_definition_id,worker_definition_version,
          parent_job_id,parent_attempt_id,parent_generation,parent_fence_digest,child_contract_id,child_job_id,
          repository_snapshot_id,execution_graph_node_id,context_envelope_id,provider_binding_id,capability_set_id,
          goal,expected_result_schema_id,expected_evidence_schema_id,input_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      command.assignmentId, 1, command.idempotencyKey, command.workerDefinitionId,
      command.workerDefinitionVersion, command.parentJobId, command.parentAttemptId,
      command.parentGeneration, parentFenceDigest, command.childContractId, command.childJobId,
      command.repositorySnapshotId, executionGraphNodeId, command.contextEnvelopeId,
      command.providerBindingId, command.capabilitySetId, command.goal,
      command.expectedResultSchemaId, command.expectedEvidenceSchemaId, inputHash, now,
    );
    append(command, runId, 'worker.assignment_created', {
      assignmentId: command.assignmentId, childJobId: command.childJobId,
      workerDefinitionId: command.workerDefinitionId, inputHash,
    }, 'assignment-created');
    return getAssignment(command.assignmentId)!;
  }).immediate;

  const bindRun = db.transaction((command: BindRunCommand): WorkerRunRecord => {
    assertId(command.workerRunId, 'Worker run identity');
    if (command.schemaVersion !== 1) throw new WorkerAuthorityError('invalid_contract', 'Unsupported WorkerRun schema');
    const sameBinding = (existing: WorkerRunRecord): boolean => (
      existing.assignmentId === command.assignmentId
      && existing.childJobId === command.childJobId
      && existing.childAttemptId === command.childAttemptId
      && existing.childGeneration === command.childGeneration
      && existing.providerBindingId === command.providerBindingId
      && existing.contextEnvelopeId === command.contextEnvelopeId
    );
    const idempotent = db.prepare('SELECT * FROM worker_runs WHERE assignment_id=? AND idempotency_key=?')
      .get(command.assignmentId, command.idempotencyKey) as RunRow | undefined;
    if (idempotent) {
      const existing = mapRun(idempotent);
      if (!sameBinding(existing)) {
        throw new WorkerAuthorityError('idempotency_conflict', 'WorkerRun idempotency key has different input');
      }
      return existing;
    }
    const existing = getRun(command.workerRunId);
    if (existing) {
      if (!sameBinding(existing)) {
        throw new WorkerAuthorityError('immutable_conflict', 'WorkerRun identity already exists');
      }
      return existing;
    }
    const conflict = db.prepare('SELECT worker_run_id FROM worker_runs WHERE child_attempt_id=? AND child_generation=?')
      .get(command.childAttemptId, command.childGeneration) as { worker_run_id: string } | undefined;
    if (conflict) throw new WorkerAuthorityError('binding_conflict', 'Child Attempt generation is already bound');
    const assignment = getAssignment(command.assignmentId);
    if (!assignment || assignment.parentJobId !== command.parentJobId || assignment.parentAttemptId !== command.parentAttemptId
      || assignment.parentGeneration !== command.parentGeneration || assignment.childJobId !== command.childJobId
      || assignment.providerBindingId !== command.providerBindingId
      || assignment.contextEnvelopeId !== command.contextEnvelopeId) {
      throw new WorkerAuthorityError('lineage_mismatch', 'WorkerRun does not match its assignment');
    }
    const { runId } = parentFence(command);
    const childFence = deps.validateActiveFence({
      jobId: command.childJobId, attemptId: command.childAttemptId,
      generation: command.childGeneration, fenceToken: command.childFenceToken, now: command.now,
    });
    const childAttempt = db.prepare('SELECT task_id,generation FROM runs WHERE attempt_id=?')
      .get(command.childAttemptId) as { task_id: string | null; generation: number } | undefined;
    if (!childFence.valid || !childAttempt || childAttempt.task_id !== command.childJobId
      || childAttempt.generation !== command.childGeneration) {
      throw new WorkerAuthorityError('lineage_mismatch', 'Child Attempt authority does not match the WorkerRun');
    }
    let executionGraphNodeId: string | null = null;
    if (assignment.executionGraphNodeId) {
      const linked = graph.attachWorkerRun({
        parentJobId: command.parentJobId, parentAttemptId: command.parentAttemptId,
        parentGeneration: command.parentGeneration, parentFenceToken: command.parentFenceToken,
        assignmentNodeId: assignment.executionGraphNodeId, workerRunId: command.workerRunId,
        childJobId: command.childJobId, childAttemptId: command.childAttemptId,
        childGeneration: command.childGeneration, producer: command.producer,
        idempotencyKey: `${command.idempotencyKey}:graph`, now: command.now,
      });
      if (!linked.applied && !linked.duplicate) throw new WorkerAuthorityError('graph_conflict', 'WorkerRun graph reference was rejected');
      executionGraphNodeId = linked.nodeId ?? null;
    }
    const now = command.now ?? Date.now();
    db.prepare(
      `INSERT INTO worker_runs
         (worker_run_id,schema_version,idempotency_key,assignment_id,child_job_id,child_attempt_id,
          child_generation,execution_graph_node_id,provider_binding_id,context_envelope_id,
          accepted_result_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`,
    ).run(
      command.workerRunId, 1, command.idempotencyKey, command.assignmentId,
      command.childJobId, command.childAttemptId, command.childGeneration,
      executionGraphNodeId, command.providerBindingId, command.contextEnvelopeId, now,
    );
    append(command, runId, 'worker.run_bound', {
      assignmentId: command.assignmentId, workerRunId: command.workerRunId,
      childJobId: command.childJobId, childAttemptId: command.childAttemptId,
      childGeneration: command.childGeneration,
    }, 'run-bound');
    return getRun(command.workerRunId)!;
  }).immediate;

  const recordResult = db.transaction((command: RecordResultCommand): WorkerResultRecord => {
    assertId(command.workerResultId, 'Worker result identity');
    const run = getRun(command.workerRunId);
    const assignment = getAssignment(command.assignmentId);
    if (!run || !assignment) throw new WorkerAuthorityError('not_found', 'WorkerRun or Assignment was not found');

    const decoded = resultPayload(command.payload);
    const rawHash = computeWorkerDigest(command.payload);
    const candidateHash = decoded.payload ? computeWorkerResultHash(decoded.payload) : rawHash;
    const exact = db.prepare(
      'SELECT * FROM worker_results WHERE worker_run_id=? AND idempotency_key=? AND result_hash=?',
    ).get(command.workerRunId, command.idempotencyKey, candidateHash) as ResultRow | undefined;
    if (exact) return mapResult(exact);
    const conflicting = db.prepare(
      'SELECT worker_result_id FROM worker_results WHERE worker_run_id=? AND idempotency_key=? LIMIT 1',
    ).get(command.workerRunId, command.idempotencyKey) as { worker_result_id: string } | undefined;
    if (getResult(command.workerResultId)) throw new WorkerAuthorityError('immutable_conflict', 'Worker result identity already exists');

    let rejectionCode: WorkerResultRejectionCode | null = null;
    let rejectionReason: string | null = null;
    const reject = (code: WorkerResultRejectionCode, reason: string): void => {
      if (rejectionCode === null) { rejectionCode = code; rejectionReason = reason; }
    };

    if (conflicting) reject('idempotency_conflict', 'Result idempotency key was reused with different content');
    if (decoded.tooLarge) reject('payload_too_large', 'Worker result exceeds the accepted size limit');
    if (!decoded.payload) reject('malformed_payload', 'Worker result payload does not match schema version 1');
    if (run.assignmentId !== command.assignmentId || run.childJobId !== command.childJobId
      || run.childAttemptId !== command.childAttemptId) {
      reject('linkage_mismatch', 'Worker result linkage does not match the WorkerRun');
    }
    if (run.childGeneration !== command.childGeneration) {
      reject('stale_generation', 'Worker result generation is stale');
    }
    if (decoded.payload) {
      if (decoded.payload.inputHash !== assignment.inputHash) {
        reject('input_hash_mismatch', 'Worker result input hash does not match the Assignment');
      }
      if (candidateHash !== decoded.payload.resultHash) {
        reject('result_hash_mismatch', 'Worker result hash does not match its payload');
      }
      for (const evidenceId of decoded.payload.evidenceIds) {
        if (!ID.test(evidenceId) || !db.prepare(
          'SELECT 1 FROM job_evidence WHERE evidence_id=? AND job_id=? AND attempt_id=? AND generation=?',
        ).get(evidenceId, command.childJobId, command.childAttemptId, command.childGeneration)) {
          reject('evidence_reference_invalid', 'Worker result Evidence reference is not authorized');
          break;
        }
      }
    }
    const parentActive = deps.validateActiveFence({
      jobId: command.parentJobId, attemptId: command.parentAttemptId,
      generation: command.parentGeneration, fenceToken: command.parentFenceToken, now: command.now,
    });
    const childActive = deps.validateActiveFence({
      jobId: command.childJobId, attemptId: command.childAttemptId,
      generation: command.childGeneration, fenceToken: command.childFenceToken, now: command.now,
    });
    if (!parentActive.valid || !childActive.valid) reject('authority_lost', 'Worker result authority is no longer active');
    const finalAccepted = db.prepare(
      `SELECT worker_result_id FROM worker_results
        WHERE worker_run_id=? AND acceptance_state='accepted' AND status<>'partial' LIMIT 1`,
    ).get(command.workerRunId) as { worker_result_id: string } | undefined;
    if (decoded.payload && FINAL_RESULT_STATUS.has(decoded.payload.status) && finalAccepted) {
      reject('final_result_conflict', 'WorkerRun already has an accepted final result');
    }

    const now = command.now ?? Date.now();
    const accepted = rejectionCode === null;
    const status: WorkerResultStatus | 'invalid' = decoded.payload?.status ?? 'invalid';
    const summary = decoded.payload?.summary ?? '';
    db.prepare(
      `INSERT INTO worker_results
         (worker_result_id,schema_version,worker_run_id,assignment_id,child_job_id,child_attempt_id,
          child_generation,idempotency_key,status,summary,structured_payload_json,evidence_ids_json,
          provider_attempt_ids_json,input_hash,result_hash,acceptance_state,rejection_code,rejection_reason,
          created_at,accepted_at,rejected_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      command.workerResultId, 1, command.workerRunId, command.assignmentId,
      command.childJobId, command.childAttemptId, command.childGeneration,
      command.idempotencyKey, status, summary, decoded.serialized,
      JSON.stringify(decoded.payload?.evidenceIds ?? []),
      JSON.stringify(decoded.payload?.providerAttemptIds ?? []),
      decoded.payload?.inputHash ?? '', candidateHash, accepted ? 'accepted' : 'rejected',
      rejectionCode, rejectionReason, now, accepted ? now : null, accepted ? null : now,
    );
    const fallbackRun = db.prepare('SELECT id FROM runs WHERE attempt_id=?')
      .get(command.parentAttemptId) as { id: number } | undefined;
    const parentRunId = parentActive.runId ?? fallbackRun?.id;
    if (parentRunId !== undefined) {
      append(command, parentRunId, 'worker.result_received', {
        workerResultId: command.workerResultId, workerRunId: command.workerRunId,
        assignmentId: command.assignmentId, status,
      }, `result-received:${command.workerResultId}`);
      append(command, parentRunId, accepted ? 'worker.result_accepted' : 'worker.result_rejected', {
        workerResultId: command.workerResultId, workerRunId: command.workerRunId,
        rejectionCode, status,
      }, `result-${accepted ? 'accepted' : 'rejected'}:${command.workerResultId}`);
    }
    if (accepted && decoded.payload && FINAL_RESULT_STATUS.has(decoded.payload.status)) {
      db.prepare('UPDATE worker_runs SET accepted_result_id=? WHERE worker_run_id=? AND accepted_result_id IS NULL')
        .run(command.workerResultId, command.workerRunId);
    }
    if (accepted && run.executionGraphNodeId) {
      const linked = graph.attachWorkerResultReference({
        parentJobId: command.parentJobId, parentAttemptId: command.parentAttemptId,
        parentGeneration: command.parentGeneration, parentFenceToken: command.parentFenceToken,
        workerRunNodeId: run.executionGraphNodeId, workerResultId: command.workerResultId,
        producer: command.producer, idempotencyKey: `${command.idempotencyKey}:graph-result`, now,
      });
      if (!linked.applied && !linked.duplicate) {
        throw new WorkerAuthorityError('graph_conflict', 'Worker result graph reference was rejected');
      }
    }
    return getResult(command.workerResultId)!;
  }).immediate;

  const listEvents = (parentJobId: string): WorkerEventRecord[] => (
    db.prepare(
      `SELECT job_sequence,kind,payload,ts FROM run_events
        WHERE job_id=? AND kind LIKE 'worker.%' ORDER BY job_sequence`,
    ).all(parentJobId) as Array<{ job_sequence: number; kind: WorkerEventKind; payload: string; ts: number }>
  ).map((row) => ({
    sequence: row.job_sequence, kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>, createdAt: row.ts,
  }));

  return {
    createWorkerProviderBinding: createBinding,
    createWorkerContextEnvelope: createContext,
    createWorkerAssignment: createAssignment,
    bindWorkerRun: bindRun,
    recordWorkerResult: recordResult,
    getWorkerAssignment: getAssignment,
    getWorkerRun: getRun,
    getWorkerProviderBinding: getBinding,
    getWorkerContextEnvelope: getContext,
    getWorkerResult: getResult,
    listWorkerRunsForParent(parentJobId) {
      return (db.prepare(
        `SELECT r.* FROM worker_runs r JOIN worker_assignments a ON a.assignment_id=r.assignment_id
          WHERE a.parent_job_id=? ORDER BY r.created_at,r.worker_run_id`,
      ).all(parentJobId) as RunRow[]).map(mapRun);
    },
    listWorkerRunsForChild(childJobId) {
      return (db.prepare(
        'SELECT * FROM worker_runs WHERE child_job_id=? ORDER BY created_at,worker_run_id',
      ).all(childJobId) as RunRow[]).map(mapRun);
    },
    listWorkerEvents: listEvents,
    rebuildWorkerProjection(parentJobId) {
      const projection: WorkerProjection = {
        assignmentIds: [], providerBindingIds: [], contextEnvelopeIds: [], workerRunIds: [],
        receivedResultIds: [], acceptedResultIds: [], rejectedResultIds: [],
      };
      const add = (values: string[], value: unknown): void => {
        if (typeof value === 'string' && !values.includes(value)) values.push(value);
      };
      for (const event of listEvents(parentJobId)) {
        if (event.kind === 'worker.assignment_created') add(projection.assignmentIds, event.payload.assignmentId);
        if (event.kind === 'worker.provider_binding_created') add(projection.providerBindingIds, event.payload.providerBindingId);
        if (event.kind === 'worker.context_finalized') add(projection.contextEnvelopeIds, event.payload.contextEnvelopeId);
        if (event.kind === 'worker.run_bound') add(projection.workerRunIds, event.payload.workerRunId);
        if (event.kind === 'worker.result_received') add(projection.receivedResultIds, event.payload.workerResultId);
        if (event.kind === 'worker.result_accepted') add(projection.acceptedResultIds, event.payload.workerResultId);
        if (event.kind === 'worker.result_rejected') add(projection.rejectedResultIds, event.payload.workerResultId);
      }
      return projection;
    },
  };
}
