/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import path from 'node:path';

import type { AdmissionResult, JobEngine } from '../daemon/jobEngine';
import {
  executeDurableJob,
  type DurableJobExecutionResult,
} from '../daemon/jobLifecycle';
import type { JobBudgetReservationRecord } from '../daemon/jobResourceAuthority';
import {
  computeWorkerDigest,
  type WorkerAssignmentRecord,
  type WorkerContextEnvelopeRecord,
  type WorkerProviderBindingRecord,
} from '../worker/types';
import { compileExternalCodingProtectedPaths } from './securityPolicy';
import {
  executeExternalCodingSession,
  type ExecuteExternalCodingSessionRequest,
  type ExternalCodingExecutionResult,
} from './runtime';
import { ExternalCodingProviderRegistry } from './providerRegistry';
import {
  externalCodingIdentity,
  externalCodingSessionIdentity,
  externalCodingWorkerRunIdentity,
} from './identities';
import type { ExternalCodingCapabilitySnapshot, ExternalCodingTaskEnvelope } from './types';

export const EXTERNAL_CODING_WORKER_ID = 'external-coding-worker';
export const EXTERNAL_CODING_WORKER_VERSION = 1;

export interface ExternalCodingParentAuthority {
  readonly jobId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly fenceToken: string;
}

export interface AdmitExternalCodingWorkerRequest {
  readonly engine: JobEngine;
  readonly parent: ExternalCodingParentAuthority;
  readonly idempotencyKey: string;
  readonly repositorySnapshotId: string;
  readonly sourcePath: string;
  readonly instanceId: string;
  readonly providers: ExternalCodingProviderRegistry;
  readonly providerId: string;
  readonly modelId: string;
  readonly task: ExternalCodingTaskEnvelope;
  readonly planStepIds?: readonly string[];
  readonly sourceReferenceIds?: readonly string[];
  readonly instructionReferenceIds?: readonly string[];
  readonly boundedParentNote?: string | null;
  readonly credentialReference?: string | null;
  readonly endpointReference?: string | null;
  readonly producer?: string;
}

export interface ExternalCodingWorkerAdmission {
  readonly child: AdmissionResult;
  readonly assignment: WorkerAssignmentRecord;
  readonly providerBinding: WorkerProviderBindingRecord;
  readonly contextEnvelope: WorkerContextEnvelopeRecord;
  readonly reservation: JobBudgetReservationRecord;
  readonly capability: ExternalCodingCapabilitySnapshot;
  readonly modelId: string;
}

export interface ExecuteAdmittedExternalCodingWorkerRequest extends Omit<
  ExecuteExternalCodingSessionRequest,
  'handle' | 'assignmentId'
> {
  readonly ownerId: string;
  readonly admission: ExternalCodingWorkerAdmission;
}

export interface ExternalCodingWorkerExecution {
  readonly admission: ExternalCodingWorkerAdmission;
  readonly execution: DurableJobExecutionResult<ExternalCodingExecutionResult>;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/gu, '/');
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function requireParent(engine: JobEngine, authority: ExternalCodingParentAuthority): void {
  const job = engine.getJob(authority.jobId);
  const attempt = engine.getAttempt(authority.attemptId);
  if (!job || !attempt || job.activeAttemptId !== authority.attemptId
    || attempt.jobId !== authority.jobId || attempt.generation !== authority.generation
    || attempt.fenceToken !== authority.fenceToken || attempt.leaseOwner === null
    || /^(completed|failed|cancelled|dead_letter|completed_unverified|verification_failed|abandoned)$/u.test(job.status)) {
    throw new Error('External coding Worker parent authority is stale');
  }
}

function ensureParentClaims(
  engine: JobEngine,
  parent: ExternalCodingParentAuthority,
  task: ExternalCodingTaskEnvelope,
): string[] {
  const existing = engine.proof.listClaims(parent.jobId);
  return task.acceptanceCriteria.map((criterion) => {
    const prior = existing.find((claim) => claim.attemptId === parent.attemptId
      && claim.generation === parent.generation && claim.category === 'contract'
      && claim.statement === criterion.statement && claim.required === criterion.required);
    return (prior ?? engine.proof.createClaim({
      jobId: parent.jobId,
      attemptId: parent.attemptId,
      generation: parent.generation,
      category: 'contract',
      statement: criterion.statement,
      required: criterion.required,
    })).claimId;
  });
}

/**
 * Admits an external coding capability through Aiden's existing durable Worker
 * lineage. This creates immutable context and budget reservations, but does not
 * claim or run the child Attempt.
 */
export async function admitExternalCodingWorker(
  request: AdmitExternalCodingWorkerRequest,
): Promise<ExternalCodingWorkerAdmission> {
  requireParent(request.engine, request.parent);
  if (!request.idempotencyKey.trim() || !request.modelId.trim()) {
    throw new Error('External coding Worker admission identity and model are required');
  }
  const snapshot = request.engine.repository.getSnapshot(request.repositorySnapshotId);
  if (!snapshot || snapshot.jobId !== request.parent.jobId
    || snapshot.attemptId !== request.parent.attemptId
    || snapshot.generation !== request.parent.generation
    || snapshot.vcsKind !== 'git' || !snapshot.repositoryRoot || !snapshot.headCommit
    || snapshot.incomplete || canonicalPath(snapshot.repositoryRoot) !== canonicalPath(request.sourcePath)) {
    throw new Error('External coding Worker requires a complete exact parent Git snapshot');
  }
  const protectedPaths = compileExternalCodingProtectedPaths(request.task.protectedPaths);
  const unprotectedDirty = [...snapshot.stagedPaths, ...snapshot.dirtyPaths, ...snapshot.untrackedPaths]
    .filter((candidate) => !protectedPaths.includes(candidate.replace(/\\/gu, '/')));
  if (unprotectedDirty.length > 0) {
    throw new Error('External coding Worker cannot omit uncommitted source-workspace changes');
  }
  const selected = await request.providers.select(request.providerId);
  if (!selected.capability.runtimeCompatibility.platforms.includes(process.platform)) {
    throw new Error(`External coding provider does not support ${process.platform}`);
  }
  const producer = request.producer ?? 'external-coding-worker-admission';
  const authority = {
    parentJobId: request.parent.jobId,
    parentAttemptId: request.parent.attemptId,
    parentGeneration: request.parent.generation,
    parentFenceToken: request.parent.fenceToken,
    producer,
  };
  const requestIdentity = {
    parentJobId: request.parent.jobId,
    parentAttemptId: request.parent.attemptId,
    parentGeneration: request.parent.generation,
    idempotencyKey: request.idempotencyKey,
  };
  const assignmentId = externalCodingIdentity('worker_assignment', requestIdentity);
  const providerBindingId = externalCodingIdentity('worker_provider', requestIdentity);
  const contextEnvelopeId = externalCodingIdentity('worker_context', requestIdentity);
  const childKey = externalCodingIdentity('worker_child', requestIdentity);
  const parentClaimIds = ensureParentClaims(request.engine, request.parent, request.task);
  const providerBinding = request.engine.worker.createWorkerProviderBinding({
    ...authority,
    providerBindingId,
    schemaVersion: 1,
    providerId: selected.provider.id,
    modelId: request.modelId,
    providerRuntimeIdentity: `${selected.provider.id}:${selected.version.normalized}:${selected.capability.capabilityDigest}`,
    credentialReference: request.credentialReference ?? null,
    endpointReference: request.endpointReference ?? null,
    capabilitySnapshotHash: selected.capability.capabilityDigest,
    selectionReason: 'Selected external coding capability for an isolated durable Worker.',
    fallbackPolicyId: null,
    contextWindow: 1,
    maxOutputTokens: 1,
    supportsToolCalling: false,
    supportsStreaming: true,
    catalogDigest: selected.capability.capabilityDigest,
    fallbackBindingIds: [],
    idempotencyKey: `${request.idempotencyKey}:provider`,
  });
  const contextEnvelope = request.engine.worker.createWorkerContextEnvelope({
    ...authority,
    contextEnvelopeId,
    schemaVersion: 1,
    assignmentId,
    repositorySnapshotId: snapshot.id,
    planStepIds: [...(request.planStepIds ?? [])],
    claimIds: parentClaimIds,
    sourceReferenceIds: [...(request.sourceReferenceIds ?? [])],
    instructionReferenceIds: [...(request.instructionReferenceIds ?? [])],
    boundedParentNote: request.boundedParentNote ?? null,
    toolSchemaDigest: computeWorkerDigest({
      contract: 'external-coding-session-v1',
      capabilityDigest: selected.capability.capabilityDigest,
      task: { ...request.task, protectedPaths },
    }),
    tokenEstimate: Math.ceil((request.task.goal.length + (request.boundedParentNote?.length ?? 0)) / 4),
    idempotencyKey: `${request.idempotencyKey}:context`,
  });
  const parentJob = request.engine.getJob(request.parent.jobId)!;
  const child = request.engine.submitJob({
    entryPoint: 'worker',
    source: producer,
    sessionId: parentJob.sessionId,
    workspaceId: parentJob.workspaceId,
    instanceId: request.instanceId,
    idempotencyNamespace: `worker:${request.parent.jobId}:${request.parent.attemptId}:${request.parent.generation}`,
    idempotencyKey: childKey,
    requestFingerprint: computeWorkerDigest({ requestIdentity, task: request.task, snapshotId: snapshot.id }),
    goal: request.task.goal,
    title: request.task.goal,
    parentJobId: request.parent.jobId,
    rootJobId: parentJob.rootJobId,
    childContract: {
      required: true,
      workerId: EXTERNAL_CODING_WORKER_ID,
      capabilities: ['external_coding_session'],
      allowedResources: {
        repositorySnapshotId: snapshot.id,
        sourceHead: snapshot.headCommit,
        protectedPaths,
        capabilityDigest: selected.capability.capabilityDigest,
      },
      budget: {
        runtimeMs: request.task.budgets.runtimeMs,
        commandCount: request.task.budgets.commandCount,
        outputBytes: request.task.budgets.outputBytes,
        providerCalls: 1,
      },
    },
    resourcePolicy: {
      budgets: {
        model_calls: 1,
        retries: 0,
        tool_calls: request.task.budgets.commandCount,
        runtime_ms: request.task.budgets.runtimeMs,
        output_bytes: request.task.budgets.outputBytes,
        workers: 0,
        effects: 0,
      },
      capabilities: {
        tools: [], paths: [snapshot.repositoryRoot], hosts: [], applications: [],
        connections: [], accounts: [], workers: [], effectKinds: [],
      },
    },
  });
  const assignment = request.engine.worker.createWorkerAssignment({
    ...authority,
    assignmentId,
    schemaVersion: 1,
    workerDefinitionId: EXTERNAL_CODING_WORKER_ID,
    workerDefinitionVersion: EXTERNAL_CODING_WORKER_VERSION,
    childContractId: child.jobId,
    childJobId: child.jobId,
    repositorySnapshotId: snapshot.id,
    contextEnvelopeId: contextEnvelope.contextEnvelopeId,
    providerBindingId: providerBinding.providerBindingId,
    capabilitySetId: child.jobId,
    goal: request.task.goal,
    expectedResultSchemaId: 'external-coding-result-v1',
    expectedEvidenceSchemaId: 'external-coding-proof-v1',
    idempotencyKey: request.idempotencyKey,
  });
  const codingSessionId = externalCodingSessionIdentity(assignment.assignmentId, child.attemptId, 1);
  const workerRunId = externalCodingWorkerRunIdentity(codingSessionId, assignment.assignmentId);
  const reservation = request.engine.resources.reserveWorker({
    reservationId: externalCodingIdentity('worker_budget', requestIdentity),
    idempotencyKey: `${request.idempotencyKey}:budget`,
    parentJobId: request.parent.jobId,
    parentAttemptId: request.parent.attemptId,
    parentGeneration: request.parent.generation,
    parentFenceToken: request.parent.fenceToken,
    childJobId: child.jobId,
    childAttemptId: child.attemptId,
    childGeneration: 1,
    workerRunId,
    assignmentId: assignment.assignmentId,
    amounts: {
      workers: 1,
      model_calls: 1,
      tool_calls: request.task.budgets.commandCount,
      runtime_ms: request.task.budgets.runtimeMs,
      output_bytes: request.task.budgets.outputBytes,
    },
  });
  request.engine.appendJobEvent({
    jobId: request.parent.jobId,
    attemptId: request.parent.attemptId,
    generation: request.parent.generation,
    type: 'worker.admitted',
    payload: {
      assignmentId: assignment.assignmentId,
      childJobId: child.jobId,
      workerDefinitionId: EXTERNAL_CODING_WORKER_ID,
      capabilityDigest: selected.capability.capabilityDigest,
    },
    producer,
    idempotencyKey: `external-coding-worker-admitted:${assignment.assignmentId}`,
  });
  return {
    child,
    assignment,
    providerBinding,
    contextEnvelope,
    reservation,
    capability: selected.capability,
    modelId: request.modelId,
  };
}

/** Runs an already-admitted coding Worker through the canonical Job lifecycle. */
export async function executeAdmittedExternalCodingWorker(
  request: ExecuteAdmittedExternalCodingWorkerRequest,
): Promise<DurableJobExecutionResult<ExternalCodingExecutionResult>> {
  if (request.providerId !== request.admission.providerBinding.providerId
    || request.modelId !== request.admission.providerBinding.modelId) {
    throw new Error('External coding execution does not match the immutable provider/model binding');
  }
  return executeDurableJob({
    engine: request.engine,
    ownerId: request.ownerId,
    admission: { existing: { ...request.admission.child, reused: true }, source: 'external-coding-worker-dispatch' },
    execute: (handle) => executeExternalCodingSession({
      ...request,
      handle,
      assignmentId: request.admission.assignment.assignmentId,
    }),
    finalize: (value) => value.finalization,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * A verified child result is evidence for the parent, not parent truth by
 * itself. Rebind the exact accepted result and its independently verified
 * child Evidence to the still-active parent Attempt before parent settlement.
 */
function verifyExternalCodingParentClaims(
  request: AdmitExternalCodingWorkerRequest,
  admission: ExternalCodingWorkerAdmission,
  execution: DurableJobExecutionResult<ExternalCodingExecutionResult>,
): void {
  const value = execution.value;
  if (value.proof.verdict !== 'verified') return;
  requireParent(request.engine, request.parent);

  const workerResult = value.workerResult;
  if (workerResult.acceptanceState !== 'accepted' || !workerResult.payload
    || workerResult.childJobId !== admission.child.jobId
    || workerResult.childAttemptId !== execution.attemptId
    || workerResult.childGeneration !== execution.generation) {
    throw new Error('Verified external coding result does not match the accepted child authority');
  }

  const parentClaims = request.engine.proof.listClaims(request.parent.jobId);
  const childClaims = request.engine.proof.listClaims(admission.child.jobId);
  const childEvidence = request.engine.proof.listEvidence(admission.child.jobId);
  const priorParentEvidence = request.engine.proof.listEvidence(request.parent.jobId);

  request.task.acceptanceCriteria.forEach((criterion, index) => {
    const parentClaimId = admission.contextEnvelope.claimIds[index];
    const parentClaim = parentClaims.find((claim) => claim.claimId === parentClaimId);
    const childClaim = childClaims.find((claim) => claim.statement === criterion.statement
      && claim.required === criterion.required);
    const finding = workerResult.payload!.findings.find((item) => item.findingId === criterion.claimId);
    if (!parentClaim || parentClaim.statement !== criterion.statement
      || parentClaim.required !== criterion.required) {
      throw new Error('Verified external coding result does not match the parent Claim contract');
    }
    if (!childClaim || childClaim.state !== 'verified' || !finding || finding.evidenceIds.length === 0) {
      if (!criterion.required) return;
      throw new Error('Verified external coding result does not prove every required parent Claim');
    }

    const provingEvidence = finding.evidenceIds.map((evidenceId) => (
      childEvidence.find((item) => item.evidenceId === evidenceId)
    ));
    if (provingEvidence.some((item) => !item || item.attemptId !== execution.attemptId
      || item.generation !== execution.generation || item.verificationResult !== 'verified'
      || item.coverage !== 'full' || item.late)) {
      if (!criterion.required) return;
      throw new Error('External coding child Evidence is incomplete or outside the accepted Attempt');
    }

    const evidenceKey = `${workerResult.workerResultId}:${parentClaim.claimId}`;
    const existing = priorParentEvidence.find((item) => {
      const payload = asRecord(item.payload);
      return item.source === 'external-coding.parent-verification'
        && payload?.evidenceKey === evidenceKey;
    });
    const evidence = existing ?? request.engine.proof.recordEvidence({
      jobId: request.parent.jobId,
      attemptId: request.parent.attemptId,
      generation: request.parent.generation,
      fenceToken: request.parent.fenceToken,
      repositorySnapshotId: admission.assignment.repositorySnapshotId,
      source: 'external-coding.parent-verification',
      producer: request.producer ?? 'external-coding-worker-parent-verifier',
      observedAt: Math.max(...provingEvidence.map((item) => item!.observedAt)),
      coverage: 'full',
      verificationResult: 'verified',
      payload: {
        evidenceKey,
        workerResultId: workerResult.workerResultId,
        childJobId: admission.child.jobId,
        childAttemptId: execution.attemptId,
        childGeneration: execution.generation,
        externalClaimId: criterion.claimId,
        childEvidence: provingEvidence.map((item) => ({
          evidenceId: item!.evidenceId,
          integritySha256: item!.integritySha256,
        })),
      },
    });
    if (parentClaim.state !== 'verified') {
      request.engine.proof.checkClaim({
        claimId: parentClaim.claimId,
        attemptId: request.parent.attemptId,
        generation: request.parent.generation,
        evidenceIds: [evidence.evidenceId],
        state: 'verified',
      });
    }
  });
}

/** Convenience boundary used by production adapters that admit and run now. */
export async function runExternalCodingWorker(
  request: AdmitExternalCodingWorkerRequest & Omit<
    ExecuteAdmittedExternalCodingWorkerRequest,
    'engine' | 'admission' | 'providers' | 'providerId' | 'modelId' | 'sourcePath' | 'task'
  >,
): Promise<ExternalCodingWorkerExecution> {
  const admission = await admitExternalCodingWorker(request);
  const execution = await executeAdmittedExternalCodingWorker({
    ...request,
    admission,
  });
  verifyExternalCodingParentClaims(request, admission, execution);
  return { admission, execution };
}
