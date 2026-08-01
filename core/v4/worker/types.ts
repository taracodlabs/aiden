/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

export type WorkerId = string;
export type WorkerTimestamp = number;

export interface WorkerDefinitionV1 {
  readonly schemaVersion: 1;
  readonly workerDefinitionId: WorkerId;
  readonly workerDefinitionVersion: number;
  readonly expectedResultSchemaId: string;
  readonly expectedEvidenceSchemaId: string | null;
  readonly requiredCapabilities: readonly string[];
}

export interface WorkerAssignmentRecord {
  readonly assignmentId: WorkerId;
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly workerDefinitionId: WorkerId;
  readonly workerDefinitionVersion: number;
  readonly parentJobId: string;
  readonly parentAttemptId: string;
  readonly parentGeneration: number;
  readonly parentFenceDigest: string;
  readonly childContractId: string;
  readonly childJobId: string;
  readonly repositorySnapshotId: string | null;
  readonly executionGraphNodeId: string | null;
  readonly contextEnvelopeId: WorkerId;
  readonly providerBindingId: WorkerId;
  readonly capabilitySetId: string | null;
  readonly goal: string;
  readonly expectedResultSchemaId: string;
  readonly expectedEvidenceSchemaId: string | null;
  readonly inputHash: string;
  readonly createdAt: WorkerTimestamp;
}

export interface WorkerRunRecord {
  readonly workerRunId: WorkerId;
  readonly schemaVersion: 1;
  readonly assignmentId: WorkerId;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly childGeneration: number;
  readonly executionGraphNodeId: string | null;
  readonly providerBindingId: WorkerId;
  readonly contextEnvelopeId: WorkerId;
  readonly acceptedResultId: WorkerId | null;
  readonly createdAt: WorkerTimestamp;
}

export interface WorkerProviderBindingRecord {
  readonly providerBindingId: WorkerId;
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerRuntimeIdentity: string;
  readonly credentialReference: string | null;
  readonly endpointReference: string | null;
  readonly capabilitySnapshotHash: string;
  readonly selectionReason: string;
  readonly fallbackPolicyId: string | null;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly supportsToolCalling: boolean;
  readonly supportsStreaming: boolean;
  readonly catalogDigest: string;
  readonly fallbackBindingIds: readonly string[];
  readonly bindingHash: string;
  readonly createdAt: WorkerTimestamp;
}

export type WorkerLogicalProviderCallState =
  | 'prepared'
  | 'attempting'
  | 'response_received'
  | 'accepted'
  | 'downstream_started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type WorkerProviderCallReconciliationState =
  | 'not_required'
  | 'pending'
  | 'inspecting'
  | 'reconciled'
  | 'blocked_unknown'
  | 'superseded'
  | 'terminal';

export type WorkerProviderCallOutcomeKnowledge =
  | 'no_request_started'
  | 'request_started_no_response_proven'
  | 'response_received'
  | 'response_accepted'
  | 'downstream_started'
  | 'provider_failed_known'
  | 'provider_cancelled_known'
  | 'provider_timed_out_known'
  | 'outcome_unknown';

export type WorkerProviderCallRetrySafety =
  | 'safe'
  | 'unsafe'
  | 'blocked_unknown'
  | 'not_applicable';

export type WorkerProviderCallInterruptionKind =
  | 'cancellation'
  | 'timeout'
  | 'lease_expired'
  | 'authority_lost';

export interface WorkerLogicalProviderCallRecord {
  readonly logicalCallId: string;
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly workerRunId: string;
  readonly assignmentId: string;
  readonly providerBindingId: string;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly childGeneration: number;
  readonly callOrdinal: number;
  readonly requestHash: string;
  readonly toolSchemaHash: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly fallbackPolicyId: string | null;
  readonly state: WorkerLogicalProviderCallState;
  readonly acceptedProviderAttemptId: string | null;
  readonly responseHash: string | null;
  readonly providerRequestId: string | null;
  readonly failureKind: string | null;
  readonly outcomeKnown: boolean;
  readonly reconciliationState: WorkerProviderCallReconciliationState;
  readonly outcomeKnowledge: WorkerProviderCallOutcomeKnowledge;
  readonly retrySafety: WorkerProviderCallRetrySafety;
  readonly interruptionKind: WorkerProviderCallInterruptionKind | null;
  readonly cancellationRequestedAt: number | null;
  readonly timeoutRequestedAt: number | null;
  readonly authorityLostAt: number | null;
  readonly staleResponseRejectedAt: number | null;
  readonly lateResponseObservedAt: number | null;
  readonly reconciliationStartedAt: number | null;
  readonly reconciledAt: number | null;
  readonly reconciliationReason: string | null;
  readonly reconciliationVersion: number;
  readonly recoveryPredecessorLogicalCallId: string | null;
  readonly responseReceivedAt: number | null;
  readonly acceptedAt: number | null;
  readonly downstreamStartedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkerProviderCallReconciliationResult {
  readonly logicalCallId: string;
  readonly workerRunId: string;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly childGeneration: number;
  readonly reconciliationState: WorkerProviderCallReconciliationState;
  readonly outcomeKnowledge: WorkerProviderCallOutcomeKnowledge;
  readonly retrySafety: WorkerProviderCallRetrySafety;
  readonly reason: string;
  readonly physicalAttemptIds: readonly string[];
  readonly unknownSpend: boolean;
  readonly unsettledDownstream: boolean;
  readonly reconciledAt: number | null;
}

export interface WorkerContextEnvelopeRecord {
  readonly contextEnvelopeId: WorkerId;
  readonly schemaVersion: 1;
  readonly assignmentId: WorkerId;
  readonly repositorySnapshotId: string | null;
  readonly planStepIds: string[];
  readonly claimIds: string[];
  readonly sourceReferenceIds: string[];
  readonly instructionReferenceIds: string[];
  readonly boundedParentNote: string | null;
  readonly toolSchemaDigest: string;
  readonly contentDigest: string;
  readonly tokenEstimate: number;
  readonly createdAt: WorkerTimestamp;
}

export type WorkerResultAcceptanceState = 'received' | 'accepted' | 'rejected';

export type WorkerResultRejectionCode =
  | 'malformed_payload'
  | 'payload_too_large'
  | 'linkage_mismatch'
  | 'stale_generation'
  | 'authority_lost'
  | 'input_hash_mismatch'
  | 'result_hash_mismatch'
  | 'idempotency_conflict'
  | 'evidence_reference_invalid'
  | 'final_result_conflict';

export type WorkerResultStatus =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'blocked';

export interface WorkerResultSourceReference {
  readonly snapshotId: string;
  readonly snapshotEntryId: string;
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly contentHash: string;
}

export interface WorkerResultPayloadV1 {
  schemaVersion: 1;
  status: WorkerResultStatus;
  summary: string;
  findings: Array<{
    findingId: string;
    statement: string;
    sourceReferences: WorkerResultSourceReference[];
    evidenceIds: string[];
    uncertainty: 'low' | 'medium' | 'high';
  }>;
  sourceReferences: WorkerResultSourceReference[];
  filesInspected: Array<{ snapshotEntryId: string; path: string; contentHash: string }>;
  commandsExecuted: Array<{ toolCallId: string; tool: string; inputHash: string; status: string }>;
  diagnostics: Array<{ code: string; message: string; severity: 'info' | 'warning' | 'error' }>;
  evidenceIds: string[];
  unresolvedQuestions: string[];
  uncertainty: { level: 'low' | 'medium' | 'high'; reasons: string[] };
  providerAttemptIds: string[];
  budgetUsage: Array<{ kind: string; amount: number | null; debitId?: string; unknownReason?: string }>;
  timing: { startedAt: number; completedAt: number; wallClockMs: number };
  failure: null | {
    category: 'provider' | 'auth' | 'budget' | 'timeout' | 'cancelled' | 'tool' | 'validation' | 'authority_lost' | 'unknown';
    code: string;
    message: string;
    retryable: boolean;
    externalOutcomeUnknown: boolean;
  };
  inputHash: string;
  resultHash: string;
}

export interface WorkerResultRecord {
  readonly workerResultId: WorkerId;
  readonly schemaVersion: 1;
  readonly workerRunId: WorkerId;
  readonly assignmentId: WorkerId;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly childGeneration: number;
  readonly idempotencyKey: string;
  readonly status: WorkerResultStatus | 'invalid';
  readonly summary: string;
  readonly payload: WorkerResultPayloadV1 | null;
  readonly evidenceIds: string[];
  readonly providerAttemptIds: string[];
  readonly inputHash: string;
  readonly resultHash: string;
  readonly acceptanceState: WorkerResultAcceptanceState;
  readonly rejectionCode: WorkerResultRejectionCode | null;
  readonly rejectionReason: string | null;
  readonly createdAt: WorkerTimestamp;
  readonly acceptedAt: WorkerTimestamp | null;
  readonly rejectedAt: WorkerTimestamp | null;
}

export type WorkerEventKind =
  | 'worker.assignment_created'
  | 'worker.provider_binding_created'
  | 'worker.context_finalized'
  | 'worker.run_bound'
  | 'worker.result_received'
  | 'worker.result_accepted'
  | 'worker.result_rejected';

export type WorkerReferenceKind = 'worker_assignment' | 'worker_run' | 'child_attempt' | 'worker_result';

export interface WorkerEventRecord {
  readonly sequence: number;
  readonly kind: WorkerEventKind;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
}

export interface WorkerProjection {
  assignmentIds: string[];
  providerBindingIds: string[];
  contextEnvelopeIds: string[];
  workerRunIds: string[];
  receivedResultIds: string[];
  acceptedResultIds: string[];
  rejectedResultIds: string[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonical(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return String(value);
}

export function computeWorkerDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function computeWorkerResultHash(payload: WorkerResultPayloadV1): string {
  return computeWorkerDigest({ ...payload, resultHash: '' });
}
