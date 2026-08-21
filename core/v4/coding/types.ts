/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type ExternalCodingProtocolMode = 'structured' | 'pty';
export type ExternalCodingCommandVisibility = 'mediated' | 'observable' | 'opaque';
export type ExternalCodingProcessTreeGuarantee = 'supervised' | 'root_only' | 'unknown';

export interface ExternalCodingSupportedFeatures {
  readonly structuredProtocol: boolean;
  readonly pty: boolean;
  readonly resume: boolean;
  readonly semanticEvents: boolean;
  readonly clarification: boolean;
  readonly approvalEvents: boolean;
  readonly nativeDiff: boolean;
  readonly nativeTestEvents: boolean;
  readonly networkRequired: boolean;
  readonly processTreeGuarantee: ExternalCodingProcessTreeGuarantee;
  readonly commandVisibility: ExternalCodingCommandVisibility;
}

export interface ExternalCodingCapabilitySnapshot {
  readonly schemaVersion: 1;
  readonly capabilityId: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly protocolMode: ExternalCodingProtocolMode;
  readonly protocolVersion: string;
  readonly capabilityDigest: string;
  readonly supportedFeatures: ExternalCodingSupportedFeatures;
  readonly runtimeCompatibility: Readonly<{
    platforms: readonly string[];
    node?: string;
    architecture?: readonly string[];
  }>;
  readonly capturedAt: number;
}

export interface ExternalCodingAcceptanceCriterion {
  readonly claimId: string;
  readonly statement: string;
  readonly required: boolean;
}

export interface ExternalCodingTaskEnvelope {
  readonly goal: string;
  readonly allowedScope: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly forbiddenOperations: readonly string[];
  readonly acceptanceCriteria: readonly ExternalCodingAcceptanceCriterion[];
  readonly validationCommands: readonly string[];
  readonly networkPolicy: 'disabled' | 'approved_adapter_only';
  readonly packagePolicy: 'deny' | 'approval_required';
  readonly budgets: Readonly<{
    runtimeMs: number;
    outputBytes: number;
    commandCount: number;
    eventCount?: number;
    inputCount?: number;
  }>;
  readonly promotionPolicy: 'human_approval_required';
}

export type ExternalCodingSessionState =
  | 'preparing'
  | 'starting'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'cancelling'
  | 'process_terminal'
  | 'reconciliation_required'
  | 'verification_pending'
  | 'ready_for_review'
  | 'terminal'
  | 'failed'
  | 'unknown';

export type ExternalCodingReconciliationState =
  | 'not_required'
  | 'required'
  | 'inspecting'
  | 'reconciled'
  | 'blocked_unknown';

export interface ExternalCodingSessionRecord {
  readonly codingSessionId: string;
  readonly schemaVersion: 1;
  readonly parentJobId: string;
  readonly assignmentId: string;
  readonly workerRunId: string;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly childGeneration: number;
  readonly workspaceLeaseId: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly capabilityDigest: string;
  readonly capability: ExternalCodingCapabilitySnapshot;
  readonly protocolMode: ExternalCodingProtocolMode;
  readonly protocolVersion: string;
  readonly state: ExternalCodingSessionState;
  readonly reconciliationState: ExternalCodingReconciliationState;
  readonly nextEventSequence: number;
  readonly nextInputSequence: number;
  readonly providerSessionId: string | null;
  readonly sessionHomePath: string;
  readonly processIdentity: ExternalCodingProcessIdentity | null;
  readonly taskEnvelope: ExternalCodingTaskEnvelope;
  readonly preSnapshotId: string | null;
  readonly postSnapshotId: string | null;
  readonly candidateResultRef: string | null;
  readonly resultRef: string | null;
  readonly validationRefs: readonly string[];
  readonly cancellationRequestedAt: number | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly lastActivityAt: number;
  readonly terminalAt: number | null;
}

export type ExternalCodingEventType =
  | 'session.started'
  | 'session.ready'
  | 'inspection.started'
  | 'inspection.completed'
  | 'command.requested'
  | 'command.started'
  | 'command.completed'
  | 'file.activity'
  | 'validation.reported'
  | 'clarification.requested'
  | 'approval.requested'
  | 'result.reported'
  | 'process.terminal'
  | 'reconciliation.started'
  | 'reconciliation.completed'
  | 'verification.started'
  | 'verification.completed'
  | 'session.cancel_requested'
  | 'session.stale_event_rejected';

export interface ExternalCodingEventRecord {
  readonly eventId: string;
  readonly codingSessionId: string;
  readonly sequence: number;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly type: ExternalCodingEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly producer: string;
  readonly idempotencyKey: string;
  readonly authoritative: boolean;
  readonly createdAt: number;
}

export type ExternalCodingInputKind = 'task' | 'clarification' | 'approval' | 'control';

export interface ExternalCodingInputRecord {
  readonly inputId: string;
  readonly codingSessionId: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly kind: ExternalCodingInputKind;
  readonly content: string;
  readonly state: 'accepted' | 'delivered' | 'rejected_stale';
  readonly idempotencyKey: string;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

export type ExternalCodingWorkspaceLeaseState =
  | 'allocating'
  | 'ready'
  | 'review_pending'
  | 'promotion_pending'
  | 'reconciliation_required'
  | 'released'
  | 'failed';

export interface ExternalCodingWorkspaceLeaseRecord {
  readonly workspaceLeaseId: string;
  readonly codingSessionId: string;
  readonly repositoryIdentity: string;
  readonly sourceWorkspaceId: string;
  readonly sourcePath: string;
  readonly worktreePath: string;
  readonly baseHead: string;
  readonly baseBranch: string | null;
  readonly state: ExternalCodingWorkspaceLeaseState;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly protectedPaths: readonly string[];
  readonly createdAt: number;
  readonly lastValidatedAt: number;
  readonly releasedAt: number | null;
}

export interface ExternalCodingProcessIdentity {
  readonly pid: number;
  readonly startTime: number | null;
  readonly executable: string;
  readonly version: string;
  readonly cwd: string;
  readonly mode: ExternalCodingProtocolMode;
}

export interface ExternalCodingProcessRecord {
  readonly processRecordId: string;
  readonly codingSessionId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly identity: ExternalCodingProcessIdentity;
  readonly state: 'starting' | 'running' | 'stopping' | 'exited' | 'unknown';
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly treeDeadVerified: boolean;
  readonly createdAt: number;
  readonly exitedAt: number | null;
}

export interface ExternalCodingRawOutputRecord {
  readonly codingSessionId: string;
  readonly chunkSequence: number;
  readonly stream: 'stdout' | 'stderr' | 'pty';
  readonly content: string;
  readonly byteCount: number;
  readonly truncated: boolean;
  readonly createdAt: number;
}

export interface ExternalCodingCandidateResult {
  readonly summary: string;
  readonly reportedFiles: readonly string[];
  readonly reportedValidations: readonly string[];
  readonly externalOutcome: 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly rawReference?: string;
}
