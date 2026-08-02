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
  type WorkerGroupMemberOutcome,
  type WorkerGroupMemberRecord,
  type WorkerGroupPolicy,
  type WorkerGroupRecord,
  type WorkerGroupState,
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
  'bindingHash' | 'createdAt' | 'supportsToolCalling' | 'supportsStreaming' | 'catalogDigest' | 'fallbackBindingIds'> & {
    supportsToolCalling?: boolean;
    supportsStreaming?: boolean;
    catalogDigest?: string;
    fallbackBindingIds?: readonly string[];
  };

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

type BindRunFromAssignmentCommand = ChildAuthorityCommand & Omit<WorkerRunRecord,
  'idempotencyKey' | 'childJobId' | 'childAttemptId' | 'childGeneration'
  | 'executionGraphNodeId' | 'acceptedResultId' | 'createdAt'> & {
    producer: string;
    idempotencyKey: string;
    now?: number;
  };

interface RecordResultFromRunCommand extends ChildAuthorityCommand {
  workerResultId: string;
  workerRunId: string;
  assignmentId: string;
  payload: unknown;
  producer: string;
  idempotencyKey: string;
  now?: number;
}

interface CreateWorkerGroupCommand extends ParentAuthorityCommand {
  groupId: string;
  schemaVersion: 1;
  policy: WorkerGroupPolicy;
  members: ReadonlyArray<{ memberId: string; ordinal: number; requestedProviderId: string }>;
}

interface BindWorkerGroupMemberCommand extends ParentAuthorityCommand {
  groupId: string;
  memberId: string;
  assignmentId: string;
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  providerBindingId: string;
}

interface SettleWorkerGroupMemberCommand extends ParentAuthorityCommand {
  groupId: string;
  memberId: string;
  outcome: Exclude<WorkerGroupMemberOutcome, 'pending' | 'admitted'>;
  workerResultId?: string | null;
  resultHash?: string | null;
  reason: string;
}

interface SettleWorkerGroupCommand extends ParentAuthorityCommand {
  groupId: string;
  state: 'settled' | 'blocked_unknown';
  aggregateHash: string;
  reason: string;
}

export interface WorkerAuthority {
  createWorkerProviderBinding(command: ProviderBindingCommand): WorkerProviderBindingRecord;
  createWorkerContextEnvelope(command: ContextEnvelopeCommand): WorkerContextEnvelopeRecord;
  createWorkerAssignment(command: AssignmentCommand): WorkerAssignmentRecord;
  bindWorkerRun(command: BindRunCommand): WorkerRunRecord;
  bindWorkerRunFromAssignment(command: BindRunFromAssignmentCommand): WorkerRunRecord;
  recordWorkerResult(command: RecordResultCommand): WorkerResultRecord;
  recordWorkerResultFromRun(command: RecordResultFromRunCommand): WorkerResultRecord;
  createWorkerGroup(command: CreateWorkerGroupCommand): WorkerGroupRecord;
  bindWorkerGroupMember(command: BindWorkerGroupMemberCommand): WorkerGroupMemberRecord;
  completeWorkerGroupAdmission(command: ParentAuthorityCommand & { groupId: string }): WorkerGroupRecord;
  settleWorkerGroupMember(command: SettleWorkerGroupMemberCommand): WorkerGroupMemberRecord;
  reconcileWorkerGroupMember(command: {
    groupId: string;
    memberId: string;
    outcome: Exclude<WorkerGroupMemberOutcome, 'pending' | 'admitted' | 'verified'>;
    reason: string;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): WorkerGroupMemberRecord;
  requestWorkerGroupInterruption(command: ParentAuthorityCommand & {
    groupId: string;
    kind: 'cancellation' | 'timeout';
    reason: string;
  }): WorkerGroupRecord;
  requestWorkerGroupInterruptionForParent(command: ParentAuthorityCommand & {
    kind: 'cancellation' | 'timeout';
    reason: string;
  }): number;
  settleWorkerGroup(command: SettleWorkerGroupCommand): WorkerGroupRecord;
  reconcileWorkerGroup(command: {
    groupId: string;
    state: 'settled' | 'blocked_unknown';
    aggregateHash: string;
    reason: string;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): WorkerGroupRecord;
  getWorkerGroup(groupId: string): WorkerGroupRecord | null;
  getWorkerGroupMember(memberId: string): WorkerGroupMemberRecord | null;
  getWorkerGroupMemberForAssignment(assignmentId: string): WorkerGroupMemberRecord | null;
  getWorkerGroupForAssignment(assignmentId: string): WorkerGroupRecord | null;
  listWorkerGroupMembers(groupId: string): WorkerGroupMemberRecord[];
  listWorkerGroupsForParent(parentJobId: string): WorkerGroupRecord[];
  listWorkerGroupsPendingSettlement(input?: { limit?: number; afterGroupId?: string }): WorkerGroupRecord[];
  getWorkerAssignment(id: string): WorkerAssignmentRecord | null;
  getWorkerRun(id: string): WorkerRunRecord | null;
  getWorkerProviderBinding(id: string): WorkerProviderBindingRecord | null;
  getWorkerContextEnvelope(id: string): WorkerContextEnvelopeRecord | null;
  getWorkerResult(id: string): WorkerResultRecord | null;
  listWorkerAssignmentsForParent(parentJobId: string): WorkerAssignmentRecord[];
  getWorkerAssignmentForChild(childJobId: string): WorkerAssignmentRecord | null;
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

type GroupRow = {
  group_id: string; schema_version: number; idempotency_key: string;
  parent_job_id: string; parent_attempt_id: string; parent_generation: number; parent_fence_digest: string;
  policy: WorkerGroupPolicy; state: WorkerGroupState; requested_member_count: number;
  admitted_member_count: number; settled_member_count: number; successful_member_count: number;
  failed_member_count: number; unknown_member_count: number; cancelled_member_count: number;
  input_hash: string; aggregate_hash: string | null; created_at: number;
  cancellation_requested_at: number | null; timeout_requested_at: number | null;
  settled_at: number | null; settlement_version: number; settlement_reason: string | null;
};

type GroupMemberRow = {
  group_id: string; member_id: string; ordinal: number; requested_provider_id: string;
  assignment_id: string | null; child_job_id: string | null; child_attempt_id: string | null;
  child_generation: number | null; provider_binding_id: string | null; outcome: WorkerGroupMemberOutcome;
  worker_result_id: string | null; result_hash: string | null; joined_at: number | null;
  settlement_reason: string | null; created_at: number; updated_at: number;
};

type BindingRow = {
  provider_binding_id: string; schema_version: number; provider_id: string; model_id: string;
  provider_runtime_identity: string; credential_reference: string | null; endpoint_reference: string | null;
  capability_snapshot_hash: string; selection_reason: string; fallback_policy_id: string | null;
  context_window: number; max_output_tokens: number; supports_tool_calling: number;
  supports_streaming: number; catalog_digest: string; fallback_binding_ids_json: string;
  binding_hash: string; created_at: number;
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
    maxOutputTokens: row.max_output_tokens, supportsToolCalling: row.supports_tool_calling === 1,
    supportsStreaming: row.supports_streaming === 1, catalogDigest: row.catalog_digest,
    fallbackBindingIds: array(row.fallback_binding_ids_json),
    bindingHash: row.binding_hash, createdAt: row.created_at,
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

function mapGroup(row: GroupRow): WorkerGroupRecord {
  return {
    groupId: row.group_id, schemaVersion: 1, idempotencyKey: row.idempotency_key,
    parentJobId: row.parent_job_id, parentAttemptId: row.parent_attempt_id,
    parentGeneration: row.parent_generation, parentFenceDigest: row.parent_fence_digest,
    policy: row.policy, state: row.state, requestedMemberCount: row.requested_member_count,
    admittedMemberCount: row.admitted_member_count, settledMemberCount: row.settled_member_count,
    successfulMemberCount: row.successful_member_count, failedMemberCount: row.failed_member_count,
    unknownMemberCount: row.unknown_member_count, cancelledMemberCount: row.cancelled_member_count,
    inputHash: row.input_hash, aggregateHash: row.aggregate_hash, createdAt: row.created_at,
    cancellationRequestedAt: row.cancellation_requested_at, timeoutRequestedAt: row.timeout_requested_at,
    settledAt: row.settled_at, settlementVersion: row.settlement_version,
    settlementReason: row.settlement_reason,
  };
}

function mapGroupMember(row: GroupMemberRow): WorkerGroupMemberRecord {
  return {
    groupId: row.group_id, memberId: row.member_id, ordinal: row.ordinal,
    requestedProviderId: row.requested_provider_id, assignmentId: row.assignment_id,
    childJobId: row.child_job_id, childAttemptId: row.child_attempt_id,
    childGeneration: row.child_generation, providerBindingId: row.provider_binding_id,
    outcome: row.outcome, workerResultId: row.worker_result_id, resultHash: row.result_hash,
    joinedAt: row.joined_at, settlementReason: row.settlement_reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
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
  const getGroup = (id: string): WorkerGroupRecord | null => {
    const row = db.prepare('SELECT * FROM worker_groups WHERE group_id=?').get(id) as GroupRow | undefined;
    return row ? mapGroup(row) : null;
  };
  const getGroupMember = (id: string): WorkerGroupMemberRecord | null => {
    const row = db.prepare('SELECT * FROM worker_group_members WHERE member_id=?').get(id) as GroupMemberRow | undefined;
    return row ? mapGroupMember(row) : null;
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

  const parentAuthorityForAssignment = (
    assignment: WorkerAssignmentRecord,
    producer: string,
    idempotencyKey: string,
    now?: number,
  ): ParentAuthorityCommand => {
    const row = db.prepare(
      `SELECT r.fence_token
         FROM runs r JOIN tasks t ON t.id=r.task_id
        WHERE r.attempt_id=? AND r.task_id=? AND r.generation=?
          AND t.active_attempt_id=r.attempt_id
          AND t.status IN ('queued','running','waiting','paused','cancelling','recovering')`,
    ).get(
      assignment.parentAttemptId,
      assignment.parentJobId,
      assignment.parentGeneration,
    ) as { fence_token: string | null } | undefined;
    if (!row?.fence_token
      || createHash('sha256').update(row.fence_token).digest('hex') !== assignment.parentFenceDigest) {
      throw new WorkerAuthorityError('stale_authority', 'Assignment parent authority is no longer active');
    }
    const active = deps.validateActiveFence({
      jobId: assignment.parentJobId,
      attemptId: assignment.parentAttemptId,
      generation: assignment.parentGeneration,
      fenceToken: row.fence_token,
      now,
    });
    if (!active.valid) throw new WorkerAuthorityError('stale_authority', 'Assignment parent authority is no longer active');
    return {
      parentJobId: assignment.parentJobId,
      parentAttemptId: assignment.parentAttemptId,
      parentGeneration: assignment.parentGeneration,
      parentFenceToken: row.fence_token,
      producer,
      idempotencyKey,
      now,
    };
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
    const supportsToolCalling = command.supportsToolCalling ?? true;
    const supportsStreaming = command.supportsStreaming ?? false;
    const catalogDigest = command.catalogDigest ?? command.capabilitySnapshotHash;
    const fallbackBindingIds = [...(command.fallbackBindingIds ?? [])];
    assertHash(catalogDigest, 'Provider catalog digest');
    assertStringList(fallbackBindingIds, 'Fallback provider binding references');
    if (fallbackBindingIds.includes(command.providerBindingId)) {
      throw new WorkerAuthorityError('invalid_contract', 'Provider binding cannot fall back to itself');
    }
    for (const fallbackBindingId of fallbackBindingIds) {
      if (!getBinding(fallbackBindingId)) {
        throw new WorkerAuthorityError('reference_mismatch', 'Fallback provider binding is not registered');
      }
    }
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
      maxOutputTokens: command.maxOutputTokens, supportsToolCalling, supportsStreaming,
      catalogDigest, fallbackBindingIds,
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
          fallback_policy_id,context_window,max_output_tokens,supports_tool_calling,supports_streaming,
          catalog_digest,fallback_binding_ids_json,binding_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      command.providerBindingId, 1, command.providerId, command.modelId, command.providerRuntimeIdentity,
      command.credentialReference, command.endpointReference, command.capabilitySnapshotHash,
      command.selectionReason, command.fallbackPolicyId, command.contextWindow,
      command.maxOutputTokens, supportsToolCalling ? 1 : 0, supportsStreaming ? 1 : 0,
      catalogDigest, JSON.stringify(fallbackBindingIds), bindingHash, now,
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

  const refreshGroupCounts = (groupId: string, now: number): WorkerGroupRecord => {
    const counts = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN assignment_id IS NOT NULL THEN 1 ELSE 0 END) AS admitted,
              SUM(CASE WHEN outcome NOT IN ('pending','admitted') THEN 1 ELSE 0 END) AS settled,
              SUM(CASE WHEN outcome='verified' THEN 1 ELSE 0 END) AS successful,
              SUM(CASE WHEN outcome IN ('rejected','failed','blocked','timed_out') THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN outcome='unknown' THEN 1 ELSE 0 END) AS unknown_count,
              SUM(CASE WHEN outcome='cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM worker_group_members WHERE group_id=?`,
    ).get(groupId) as {
      total: number; admitted: number | null; settled: number | null; successful: number | null;
      failed: number | null; unknown_count: number | null; cancelled: number | null;
    };
    db.prepare(
      `UPDATE worker_groups
          SET admitted_member_count=?,settled_member_count=?,successful_member_count=?,
              failed_member_count=?,unknown_member_count=?,cancelled_member_count=?,
              state=CASE WHEN state='admitting' AND ?=requested_member_count THEN 'active' ELSE state END
        WHERE group_id=?`,
    ).run(
      counts.admitted ?? 0, counts.settled ?? 0, counts.successful ?? 0,
      counts.failed ?? 0, counts.unknown_count ?? 0, counts.cancelled ?? 0,
      counts.admitted ?? 0, groupId,
    );
    const group = getGroup(groupId);
    if (!group) throw new WorkerAuthorityError('not_found', 'Worker group was not found');
    void now;
    return group;
  };

  const createGroup = db.transaction((command: CreateWorkerGroupCommand): WorkerGroupRecord => {
    assertId(command.groupId, 'Worker group identity');
    assertId(command.idempotencyKey, 'Worker group idempotency key');
    if (command.schemaVersion !== 1 || !['require_all', 'allow_partial'].includes(command.policy)) {
      throw new WorkerAuthorityError('invalid_contract', 'Worker group contract is invalid');
    }
    if (command.members.length < 1 || command.members.length > 4) {
      throw new WorkerAuthorityError('limit_exceeded', 'Worker group size exceeds the maximum of 4');
    }
    const memberIds = new Set<string>();
    const ordinals = new Set<number>();
    for (const member of command.members) {
      assertId(member.memberId, 'Worker group member identity');
      assertString(member.requestedProviderId, 'Worker group provider identity', 192);
      if (!Number.isSafeInteger(member.ordinal) || member.ordinal < 1 || member.ordinal > 4
        || memberIds.has(member.memberId) || ordinals.has(member.ordinal)) {
        throw new WorkerAuthorityError('invalid_contract', 'Worker group member identity or ordinal is invalid');
      }
      memberIds.add(member.memberId);
      ordinals.add(member.ordinal);
    }
    const inputHash = computeWorkerDigest({
      groupId: command.groupId, parentJobId: command.parentJobId,
      parentAttemptId: command.parentAttemptId, parentGeneration: command.parentGeneration,
      policy: command.policy,
      members: [...command.members].sort((a, b) => a.ordinal - b.ordinal || a.memberId.localeCompare(b.memberId)),
    });
    const existing = db.prepare(
      `SELECT * FROM worker_groups
        WHERE parent_job_id=? AND parent_attempt_id=? AND parent_generation=? AND idempotency_key=?`,
    ).get(
      command.parentJobId, command.parentAttemptId, command.parentGeneration, command.idempotencyKey,
    ) as GroupRow | undefined;
    if (existing) {
      if (existing.group_id !== command.groupId || existing.input_hash !== inputHash) {
        throw new WorkerAuthorityError('idempotency_conflict', 'Worker group idempotency key has different input');
      }
      return mapGroup(existing);
    }
    if (getGroup(command.groupId)) throw new WorkerAuthorityError('immutable_conflict', 'Worker group identity already exists');
    const { runId } = parentFence(command);
    const now = command.now ?? Date.now();
    const parentFenceDigest = createHash('sha256').update(command.parentFenceToken).digest('hex');
    db.prepare(
      `INSERT INTO worker_groups
         (group_id,schema_version,idempotency_key,parent_job_id,parent_attempt_id,parent_generation,
          parent_fence_digest,policy,state,requested_member_count,input_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,'admitting',?,?,?)`,
    ).run(
      command.groupId, 1, command.idempotencyKey, command.parentJobId, command.parentAttemptId,
      command.parentGeneration, parentFenceDigest, command.policy, command.members.length, inputHash, now,
    );
    const insert = db.prepare(
      `INSERT INTO worker_group_members
         (group_id,member_id,ordinal,requested_provider_id,outcome,created_at,updated_at)
       VALUES (?,?,?,?,'pending',?,?)`,
    );
    for (const member of command.members) {
      insert.run(command.groupId, member.memberId, member.ordinal, member.requestedProviderId, now, now);
    }
    append(command, runId, 'worker.group_created', {
      groupId: command.groupId, policy: command.policy, memberCount: command.members.length,
    }, `group-created:${command.groupId}`);
    return getGroup(command.groupId)!;
  }).immediate;

  const bindGroupMember = db.transaction((command: BindWorkerGroupMemberCommand): WorkerGroupMemberRecord => {
    const { runId } = parentFence(command);
    const group = getGroup(command.groupId);
    const member = getGroupMember(command.memberId);
    const assignment = getAssignment(command.assignmentId);
    const binding = getBinding(command.providerBindingId);
    if (!group || !member || member.groupId !== group.groupId
      || group.parentJobId !== command.parentJobId || group.parentAttemptId !== command.parentAttemptId
      || group.parentGeneration !== command.parentGeneration || !assignment
      || assignment.parentJobId !== command.parentJobId || assignment.parentAttemptId !== command.parentAttemptId
      || assignment.parentGeneration !== command.parentGeneration || assignment.childJobId !== command.childJobId
      || assignment.providerBindingId !== command.providerBindingId || !binding
      || binding.providerId !== member.requestedProviderId) {
      throw new WorkerAuthorityError('lineage_mismatch', 'Worker group member lineage is invalid');
    }
    const same = member.assignmentId === command.assignmentId && member.childJobId === command.childJobId
      && member.childAttemptId === command.childAttemptId && member.childGeneration === command.childGeneration
      && member.providerBindingId === command.providerBindingId;
    if (member.assignmentId !== null) {
      if (!same) throw new WorkerAuthorityError('immutable_conflict', 'Worker group member binding is immutable');
      return member;
    }
    const now = command.now ?? Date.now();
    db.prepare(
      `UPDATE worker_group_members
          SET assignment_id=?,child_job_id=?,child_attempt_id=?,child_generation=?,provider_binding_id=?,
              outcome='admitted',updated_at=? WHERE member_id=? AND group_id=? AND assignment_id IS NULL`,
    ).run(
      command.assignmentId, command.childJobId, command.childAttemptId, command.childGeneration,
      command.providerBindingId, now, command.memberId, command.groupId,
    );
    refreshGroupCounts(command.groupId, now);
    append(command, runId, 'worker.group_member_bound', {
      groupId: command.groupId, memberId: command.memberId, ordinal: member.ordinal,
      assignmentId: command.assignmentId, childJobId: command.childJobId,
    }, `group-member-bound:${command.memberId}`);
    return getGroupMember(command.memberId)!;
  }).immediate;

  const settleGroupMember = db.transaction((command: SettleWorkerGroupMemberCommand): WorkerGroupMemberRecord => {
    const { runId } = parentFence(command);
    assertString(command.reason, 'Worker group settlement reason', 192);
    const group = getGroup(command.groupId);
    const member = getGroupMember(command.memberId);
    if (!group || !member || member.groupId !== group.groupId
      || group.parentJobId !== command.parentJobId || group.parentAttemptId !== command.parentAttemptId
      || group.parentGeneration !== command.parentGeneration) {
      throw new WorkerAuthorityError('lineage_mismatch', 'Worker group settlement lineage is invalid');
    }
    const resultId = command.workerResultId ?? null;
    const resultHash = command.resultHash ?? null;
    if (command.outcome === 'verified') {
      const result = resultId ? getResult(resultId) : null;
      const verification = result ? db.prepare(
        `SELECT 1 FROM run_events
          WHERE job_id=? AND attempt_id=? AND generation=?
            AND kind='worker.parent_verification_completed'
            AND json_extract(payload,'$.workerResultId')=? LIMIT 1`,
      ).get(
        command.parentJobId, command.parentAttemptId, command.parentGeneration, result.workerResultId,
      ) : undefined;
      if (!result || result.acceptanceState !== 'accepted' || result.assignmentId !== member.assignmentId
        || result.resultHash !== resultHash || !verification) {
        throw new WorkerAuthorityError(
          'verification_required',
          'Verified group member requires an independently verified exact Worker result',
        );
      }
    }
    if (!['pending', 'admitted'].includes(member.outcome)) {
      const same = member.outcome === command.outcome && member.workerResultId === resultId
        && member.resultHash === resultHash && member.settlementReason === command.reason;
      if (!same) throw new WorkerAuthorityError('final_result_conflict', 'Worker group member result cannot be replaced');
      return member;
    }
    const now = command.now ?? Date.now();
    db.prepare(
      `UPDATE worker_group_members SET outcome=?,worker_result_id=?,result_hash=?,joined_at=?,
              settlement_reason=?,updated_at=? WHERE member_id=? AND group_id=?`,
    ).run(command.outcome, resultId, resultHash, now, command.reason, now, command.memberId, command.groupId);
    refreshGroupCounts(command.groupId, now);
    append(command, runId, 'worker.group_member_settled', {
      groupId: command.groupId, memberId: command.memberId, outcome: command.outcome,
      workerResultId: resultId, resultHash,
    }, `group-member-settled:${command.memberId}`);
    return getGroupMember(command.memberId)!;
  }).immediate;

  const completeGroupAdmission = db.transaction((
    command: ParentAuthorityCommand & { groupId: string },
  ): WorkerGroupRecord => {
    const { runId } = parentFence(command);
    const group = refreshGroupCounts(command.groupId, command.now ?? Date.now());
    if (group.parentJobId !== command.parentJobId || group.parentAttemptId !== command.parentAttemptId
      || group.parentGeneration !== command.parentGeneration) {
      throw new WorkerAuthorityError('lineage_mismatch', 'Worker group admission lineage is invalid');
    }
    if (group.state !== 'admitting') return group;
    const unresolved = db.prepare(
      `SELECT COUNT(*) AS count FROM worker_group_members
        WHERE group_id=? AND assignment_id IS NULL AND outcome='pending'`,
    ).get(command.groupId) as { count: number };
    if (unresolved.count !== 0) {
      throw new WorkerAuthorityError('incomplete_group', 'Worker group admission has unresolved members');
    }
    db.prepare("UPDATE worker_groups SET state='active',settlement_version=settlement_version+1 WHERE group_id=?")
      .run(command.groupId);
    append(command, runId, 'worker.group_admission_completed', {
      groupId: command.groupId,
      admittedMemberCount: group.admittedMemberCount,
      rejectedMemberCount: group.requestedMemberCount - group.admittedMemberCount,
    }, `group-admission-completed:${command.groupId}`);
    return getGroup(command.groupId)!;
  }).immediate;

  const groupProjectionRun = (group: WorkerGroupRecord): number => {
    const row = db.prepare(
      'SELECT id FROM runs WHERE task_id=? AND attempt_id=? AND generation=?',
    ).get(group.parentJobId, group.parentAttemptId, group.parentGeneration) as { id: number } | undefined;
    if (!row) throw new WorkerAuthorityError('lineage_mismatch', 'Worker group parent Attempt is unavailable');
    return row.id;
  };

  const appendGroupProjection = (
    group: WorkerGroupRecord,
    runId: number,
    producer: string,
    idempotencyKey: string,
    kind: WorkerEventKind,
    payload: Record<string, unknown>,
  ): void => {
    deps.appendOrderedEvent({
      jobId: group.parentJobId,
      runId,
      attemptId: group.parentAttemptId,
      generation: group.parentGeneration,
      kind,
      payload,
      producer,
      idempotencyKey,
    });
  };

  const reconcileGroupMember = db.transaction((command: Parameters<WorkerAuthority['reconcileWorkerGroupMember']>[0]) => {
    assertString(command.reason, 'Worker group reconciliation reason', 192);
    const group = getGroup(command.groupId);
    const member = getGroupMember(command.memberId);
    if (!group || !member || member.groupId !== group.groupId) {
      throw new WorkerAuthorityError('lineage_mismatch', 'Worker group reconciliation lineage is invalid');
    }
    if (!['pending', 'admitted'].includes(member.outcome)) {
      if (member.outcome !== command.outcome || member.settlementReason !== command.reason) {
        throw new WorkerAuthorityError('final_result_conflict', 'Worker group member result cannot be replaced');
      }
      return member;
    }
    const child = member.childJobId ? db.prepare('SELECT status FROM tasks WHERE id=?')
      .get(member.childJobId) as { status: string } | undefined : undefined;
    const canonical = command.outcome === 'rejected'
      ? member.childJobId === null && member.assignmentId === null
      : command.outcome === 'timed_out'
        ? group.timeoutRequestedAt !== null && child?.status === 'cancelled'
        : command.outcome === 'cancelled'
          ? child?.status === 'cancelled'
          : command.outcome === 'failed'
            ? ['failed', 'crashed', 'dead_letter'].includes(child?.status ?? '')
            : command.outcome === 'blocked'
              ? child?.status === 'blocked'
              : command.outcome === 'unknown' && child?.status === 'unknown';
    if (!canonical) {
      throw new WorkerAuthorityError('verification_required', 'Worker group projection does not match canonical child state');
    }
    const now = command.now ?? Date.now();
    db.prepare(
      `UPDATE worker_group_members SET outcome=?,joined_at=?,settlement_reason=?,updated_at=?
        WHERE group_id=? AND member_id=? AND outcome IN ('pending','admitted')`,
    ).run(command.outcome, now, command.reason, now, group.groupId, member.memberId);
    refreshGroupCounts(group.groupId, now);
    appendGroupProjection(
      group, groupProjectionRun(group), command.producer, command.idempotencyKey,
      'worker.group_member_settled',
      { groupId: group.groupId, memberId: member.memberId, outcome: command.outcome },
    );
    return getGroupMember(member.memberId)!;
  }).immediate;

  const requestGroupInterruption = db.transaction((command: ParentAuthorityCommand & {
    groupId: string; kind: 'cancellation' | 'timeout'; reason: string;
  }): WorkerGroupRecord => {
    const { runId } = parentFence(command);
    const group = getGroup(command.groupId);
    if (!group || group.parentJobId !== command.parentJobId || group.parentAttemptId !== command.parentAttemptId
      || group.parentGeneration !== command.parentGeneration) {
      throw new WorkerAuthorityError('lineage_mismatch', 'Worker group interruption lineage is invalid');
    }
    const timestamp = command.kind === 'cancellation' ? group.cancellationRequestedAt : group.timeoutRequestedAt;
    if (timestamp !== null) return group;
    const now = command.now ?? Date.now();
    const column = command.kind === 'cancellation' ? 'cancellation_requested_at' : 'timeout_requested_at';
    const state = command.kind === 'cancellation' ? 'cancelling' : 'timed_out';
    db.prepare(
      `UPDATE worker_groups SET ${column}=?,state=?,settlement_reason=?,settlement_version=settlement_version+1
        WHERE group_id=?`,
    ).run(now, state, command.reason, command.groupId);
    append(command, runId, 'worker.group_interruption_requested', {
      groupId: command.groupId, kind: command.kind, reason: command.reason,
    }, `group-${command.kind}-requested:${command.groupId}`);
    return getGroup(command.groupId)!;
  }).immediate;

  const settleGroup = db.transaction((command: SettleWorkerGroupCommand): WorkerGroupRecord => {
    const { runId } = parentFence(command);
    assertHash(command.aggregateHash, 'Worker group aggregate hash');
    assertString(command.reason, 'Worker group settlement reason', 192);
    const group = refreshGroupCounts(command.groupId, command.now ?? Date.now());
    if (group.parentJobId !== command.parentJobId || group.parentAttemptId !== command.parentAttemptId
      || group.parentGeneration !== command.parentGeneration) {
      throw new WorkerAuthorityError('lineage_mismatch', 'Worker group settlement lineage is invalid');
    }
    if (group.state === 'settled' || group.state === 'blocked_unknown') {
      if (group.state !== command.state || group.aggregateHash !== command.aggregateHash) {
        throw new WorkerAuthorityError('final_result_conflict', 'Worker group aggregate cannot be replaced');
      }
      return group;
    }
    if (group.settledMemberCount !== group.requestedMemberCount) {
      throw new WorkerAuthorityError('incomplete_group', 'Worker group cannot settle before every member is represented');
    }
    const now = command.now ?? Date.now();
    db.prepare(
      `UPDATE worker_groups SET state=?,aggregate_hash=?,settled_at=?,settlement_reason=?,
              settlement_version=settlement_version+1 WHERE group_id=?`,
    ).run(command.state, command.aggregateHash, now, command.reason, command.groupId);
    append(command, runId, 'worker.group_settled', {
      groupId: command.groupId, state: command.state, aggregateHash: command.aggregateHash,
    }, `group-settled:${command.groupId}`);
    return getGroup(command.groupId)!;
  }).immediate;

  const reconcileGroup = db.transaction((command: Parameters<WorkerAuthority['reconcileWorkerGroup']>[0]) => {
    assertHash(command.aggregateHash, 'Worker group aggregate hash');
    assertString(command.reason, 'Worker group reconciliation reason', 192);
    const group = refreshGroupCounts(command.groupId, command.now ?? Date.now());
    if (group.state === 'settled' || group.state === 'blocked_unknown') {
      if (group.state !== command.state || group.aggregateHash !== command.aggregateHash) {
        throw new WorkerAuthorityError('final_result_conflict', 'Worker group aggregate cannot be replaced');
      }
      return group;
    }
    if (group.settledMemberCount !== group.requestedMemberCount) {
      throw new WorkerAuthorityError('incomplete_group', 'Worker group cannot settle before every member is represented');
    }
    const now = command.now ?? Date.now();
    db.prepare(
      `UPDATE worker_groups SET state=?,aggregate_hash=?,settled_at=?,settlement_reason=?,
              settlement_version=settlement_version+1 WHERE group_id=?`,
    ).run(command.state, command.aggregateHash, now, command.reason, group.groupId);
    appendGroupProjection(
      group, groupProjectionRun(group), command.producer, command.idempotencyKey,
      'worker.group_settled',
      { groupId: group.groupId, state: command.state, aggregateHash: command.aggregateHash },
    );
    return getGroup(group.groupId)!;
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
    bindWorkerRunFromAssignment(command) {
      const assignment = getAssignment(command.assignmentId);
      if (!assignment) throw new WorkerAuthorityError('not_found', 'Worker Assignment was not found');
      return bindRun({
        ...parentAuthorityForAssignment(assignment, command.producer, command.idempotencyKey, command.now),
        childJobId: command.childJobId,
        childAttemptId: command.childAttemptId,
        childGeneration: command.childGeneration,
        childFenceToken: command.childFenceToken,
        workerRunId: command.workerRunId,
        schemaVersion: command.schemaVersion,
        assignmentId: command.assignmentId,
        providerBindingId: command.providerBindingId,
        contextEnvelopeId: command.contextEnvelopeId,
      });
    },
    recordWorkerResult: recordResult,
    recordWorkerResultFromRun(command) {
      const assignment = getAssignment(command.assignmentId);
      if (!assignment) throw new WorkerAuthorityError('not_found', 'Worker Assignment was not found');
      return recordResult({
        ...parentAuthorityForAssignment(assignment, command.producer, command.idempotencyKey, command.now),
        childJobId: command.childJobId,
        childAttemptId: command.childAttemptId,
        childGeneration: command.childGeneration,
        childFenceToken: command.childFenceToken,
        workerResultId: command.workerResultId,
        workerRunId: command.workerRunId,
        assignmentId: command.assignmentId,
        payload: command.payload,
      });
    },
    createWorkerGroup: createGroup,
    bindWorkerGroupMember: bindGroupMember,
    completeWorkerGroupAdmission: completeGroupAdmission,
    settleWorkerGroupMember: settleGroupMember,
    reconcileWorkerGroupMember: reconcileGroupMember,
    requestWorkerGroupInterruption: requestGroupInterruption,
    requestWorkerGroupInterruptionForParent(command) {
      return db.transaction(() => {
        const groups = (db.prepare(
          `SELECT * FROM worker_groups
            WHERE parent_job_id=? AND parent_attempt_id=? AND parent_generation=?
              AND state NOT IN ('settled','blocked_unknown')
            ORDER BY created_at,group_id`,
        ).all(command.parentJobId, command.parentAttemptId, command.parentGeneration) as GroupRow[]).map(mapGroup);
        for (const group of groups) {
          requestGroupInterruption({
            ...command,
            groupId: group.groupId,
            idempotencyKey: `${command.idempotencyKey}:${group.groupId}`,
          });
        }
        return groups.length;
      }).immediate();
    },
    settleWorkerGroup: settleGroup,
    reconcileWorkerGroup: reconcileGroup,
    getWorkerGroup: getGroup,
    getWorkerGroupMember: getGroupMember,
    getWorkerGroupMemberForAssignment(assignmentId) {
      const row = db.prepare('SELECT * FROM worker_group_members WHERE assignment_id=?')
        .get(assignmentId) as GroupMemberRow | undefined;
      return row ? mapGroupMember(row) : null;
    },
    getWorkerGroupForAssignment(assignmentId) {
      const row = db.prepare(
        `SELECT g.* FROM worker_groups g JOIN worker_group_members m ON m.group_id=g.group_id
          WHERE m.assignment_id=?`,
      ).get(assignmentId) as GroupRow | undefined;
      return row ? mapGroup(row) : null;
    },
    listWorkerGroupMembers(groupId) {
      return (db.prepare(
        'SELECT * FROM worker_group_members WHERE group_id=? ORDER BY ordinal,member_id',
      ).all(groupId) as GroupMemberRow[]).map(mapGroupMember);
    },
    listWorkerGroupsForParent(parentJobId) {
      return (db.prepare(
        'SELECT * FROM worker_groups WHERE parent_job_id=? ORDER BY created_at,group_id',
      ).all(parentJobId) as GroupRow[]).map(mapGroup);
    },
    listWorkerGroupsPendingSettlement(input = {}) {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000));
      return (db.prepare(
        `SELECT * FROM worker_groups
          WHERE group_id>? AND state NOT IN ('settled','blocked_unknown')
          ORDER BY group_id LIMIT ?`,
      ).all(input.afterGroupId ?? '', limit) as GroupRow[]).map(mapGroup);
    },
    getWorkerAssignment: getAssignment,
    getWorkerRun: getRun,
    getWorkerProviderBinding: getBinding,
    getWorkerContextEnvelope: getContext,
    getWorkerResult: getResult,
    listWorkerAssignmentsForParent(parentJobId) {
      return (db.prepare(
        'SELECT * FROM worker_assignments WHERE parent_job_id=? ORDER BY created_at,assignment_id',
      ).all(parentJobId) as AssignmentRow[]).map(mapAssignment);
    },
    getWorkerAssignmentForChild(childJobId) {
      const row = db.prepare(
        'SELECT * FROM worker_assignments WHERE child_job_id=? ORDER BY created_at,assignment_id LIMIT 1',
      ).get(childJobId) as AssignmentRow | undefined;
      return row ? mapAssignment(row) : null;
    },
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
