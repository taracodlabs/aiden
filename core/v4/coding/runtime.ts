/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeExecutionPlan,
  type ActionAuthority,
  type ApprovalRecord,
} from '../actionAuthority';
import type { JobEngine } from '../daemon/jobEngine';
import type { DurableJobDisposition, DurableJobHandle } from '../daemon/jobLifecycle';
import type { ClaimState, EvidenceRecord, JobVerdictRecord } from '../daemon/jobProofAuthority';
import {
  computeWorkerDigest,
  computeWorkerResultHash,
  type WorkerProviderCallReconciliationResult,
  type WorkerResultPayloadV1,
  type WorkerResultRecord,
  type WorkerRunRecord,
} from '../worker/types';
import { createExternalCodingEnvironment } from './environmentPolicy';
import { recoverCancelledExternalCodingSessions } from './cancellationRecovery';
import type { ExternalCodingMutationReceipt } from './mutationAuthority';
import type { ExternalCodingPromotionPlanRecord } from './promotionAuthority';
import type { ExternalCodingProviderEvent } from './provider';
import { ExternalCodingProviderRegistry } from './providerRegistry';
import { compileExternalCodingProtectedPaths } from './securityPolicy';
import {
  externalCodingIdentity,
  externalCodingSessionIdentity,
  externalCodingWorkerRunIdentity,
} from './identities';
import type {
  ExternalCodingAcceptanceCriterion,
  ExternalCodingCandidateResult,
  ExternalCodingTaskEnvelope,
  ExternalCodingWorkspaceLeaseRecord,
} from './types';

const PRODUCER = 'external-coding-runtime';

interface ChildAuthority {
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  childFenceToken: string;
}

export interface ExternalCodingClaimVerification {
  readonly claimId: string;
  readonly state: Exclude<ClaimState, 'unverified'>;
  readonly payload: unknown;
}

export interface ExternalCodingVerificationResult {
  readonly claims: readonly ExternalCodingClaimVerification[];
  readonly validationRefs: readonly string[];
}

export interface ExternalCodingVerificationContext {
  readonly engine: JobEngine;
  readonly authority: Readonly<{
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
  }>;
  readonly signal: AbortSignal;
  readonly codingSessionId: string;
  readonly workspace: ExternalCodingWorkspaceLeaseRecord;
  readonly preSnapshotId: string;
  readonly postSnapshotId: string;
  readonly mutation: ExternalCodingMutationReceipt;
  readonly processTreeSettled: boolean;
  readonly candidate: ExternalCodingCandidateResult;
  readonly task: ExternalCodingTaskEnvelope;
}

export interface ExternalCodingClarificationRequest {
  readonly codingSessionId: string;
  readonly parentJobId: string;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly question: string;
}

export interface ExternalCodingApprovalRequest {
  readonly codingSessionId: string;
  readonly parentJobId: string;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly operation: string;
  readonly approval: ApprovalRecord;
}

export interface ExternalCodingInteractionPort {
  requestClarification(request: ExternalCodingClarificationRequest): Promise<{
    content: string;
    respondedBy: string;
    responseChannel: string;
  }>;
  requestApproval(request: ExternalCodingApprovalRequest): Promise<{
    decision: 'approved' | 'denied' | 'cancelled';
    decidedBy: string;
    decisionChannel: string;
  }>;
}

export interface ExecuteExternalCodingSessionRequest {
  readonly engine: JobEngine;
  readonly handle: DurableJobHandle;
  readonly assignmentId: string;
  readonly providers: ExternalCodingProviderRegistry;
  readonly providerId: string;
  readonly modelId: string;
  readonly sourcePath: string;
  readonly worktreeParent?: string;
  readonly sessionHomeParent: string;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly approvedEnvironment?: Readonly<Record<string, string>>;
  readonly approvedEnvironmentKeys?: readonly string[];
  readonly task: ExternalCodingTaskEnvelope;
  readonly sandboxAvailable: boolean;
  readonly interaction?: ExternalCodingInteractionPort;
  readonly approvalAuthority?: ActionAuthority;
  verify(context: ExternalCodingVerificationContext): Promise<ExternalCodingVerificationResult>;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

export interface ExternalCodingExecutionResult {
  readonly codingSessionId: string;
  readonly workerRun: WorkerRunRecord;
  readonly workerResult: WorkerResultRecord;
  readonly workspace: ExternalCodingWorkspaceLeaseRecord;
  readonly mutation: ExternalCodingMutationReceipt;
  readonly promotion: ExternalCodingPromotionPlanRecord | null;
  readonly proof: JobVerdictRecord;
  readonly finalization: DurableJobDisposition;
}

class ExternalCodingRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingRuntimeError';
  }
}

function identity(prefix: string, value: unknown): string {
  return externalCodingIdentity(prefix, value);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref?.();
  });
}

function childAuthority(handle: DurableJobHandle): ChildAuthority {
  return {
    childJobId: handle.jobId,
    childAttemptId: handle.attemptId,
    childGeneration: handle.generation,
    childFenceToken: handle.fenceToken,
  };
}

function claimKey(criterion: ExternalCodingAcceptanceCriterion): string {
  return `${criterion.claimId}\0${criterion.statement}`;
}

function resultStatus(
  candidate: ExternalCodingCandidateResult,
  proof: JobVerdictRecord,
  mutation: ExternalCodingMutationReceipt,
  cancelled: boolean,
  policyViolation: string | null,
): WorkerResultPayloadV1['status'] {
  if (policyViolation) return 'failed';
  if (candidate.externalOutcome === 'unknown') return 'blocked';
  if (cancelled || candidate.externalOutcome === 'cancelled') return 'cancelled';
  if (mutation.state === 'rejected' || proof.verdict === 'failed' || candidate.externalOutcome === 'failed') return 'failed';
  if (mutation.state === 'verified' && proof.verdict === 'verified') return 'completed';
  return 'blocked';
}

function dispositionFor(
  status: WorkerResultPayloadV1['status'],
  workerResultId: string,
  proof: JobVerdictRecord,
): DurableJobDisposition {
  const evidence = { workerResultId, proofVerdict: proof.verdict };
  if (status === 'completed') {
    return { status: 'completed', outcome: 'external_coding_verified', finishReason: 'stop', evidence };
  }
  if (status === 'cancelled') {
    return { status: 'cancelled', attemptStatus: 'cancelled', outcome: 'cancelled', finishReason: 'interrupted', evidence };
  }
  if (status === 'failed') {
    return { status: 'failed', attemptStatus: 'failed', outcome: 'external_coding_failed', finishReason: 'verification_failed', evidence };
  }
  return { status: 'unknown', outcome: 'external_coding_unknown', finishReason: 'verification_incomplete', evidence };
}

function assertAssignment(
  engine: JobEngine,
  handle: DurableJobHandle,
  assignmentId: string,
  providerId: string,
  modelId: string,
  capabilityDigest: string,
) {
  const assignment = engine.worker.getWorkerAssignment(assignmentId);
  if (!assignment || assignment.childJobId !== handle.jobId || assignment.workerDefinitionId !== 'external-coding-worker') {
    throw new ExternalCodingRuntimeError('ASSIGNMENT_LINEAGE_MISMATCH', 'External coding Assignment does not match the active child Job');
  }
  const binding = engine.worker.getWorkerProviderBinding(assignment.providerBindingId);
  const context = engine.worker.getWorkerContextEnvelope(assignment.contextEnvelopeId);
  if (!binding || !context || context.assignmentId !== assignment.assignmentId
    || binding.providerId !== providerId || binding.modelId !== modelId
    || binding.capabilitySnapshotHash !== capabilityDigest) {
    throw new ExternalCodingRuntimeError('IMMUTABLE_PROVIDER_BINDING_MISMATCH', 'External coding provider binding does not match its immutable capability');
  }
  return { assignment, binding, context };
}

function appendProviderEvent(
  engine: JobEngine,
  authority: ChildAuthority,
  codingSessionId: string,
  event: ExternalCodingProviderEvent,
): void {
  engine.coding.appendEvent({
    ...authority,
    codingSessionId,
    type: event.type,
    payload: { providerEventId: event.providerEventId, cursor: event.cursor, ...event.payload },
    producer: PRODUCER,
    idempotencyKey: `provider-event:${event.providerEventId}`,
    now: event.observedAt,
  });
}

function interactionRequestId(event: ExternalCodingProviderEvent): string {
  const requestId = typeof event.payload.requestId === 'string' ? event.payload.requestId : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(requestId)) {
    throw new ExternalCodingRuntimeError(
      'INVALID_INTERACTION_REQUEST',
      'External coding interaction request identity is invalid',
    );
  }
  return requestId;
}

function approvalOperation(event: ExternalCodingProviderEvent): string {
  const operation = typeof event.payload.operation === 'string' ? event.payload.operation : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(operation)) {
    throw new ExternalCodingRuntimeError(
      'INVALID_APPROVAL_OPERATION',
      'External coding approval operation is invalid',
    );
  }
  return operation;
}

async function routeProviderInteraction(input: {
  request: ExecuteExternalCodingSessionRequest;
  providerSessionId: string;
  codingSessionId: string;
  authority: ChildAuthority;
  event: ExternalCodingProviderEvent;
  workspacePath: string;
}): Promise<void> {
  const { request, providerSessionId, codingSessionId, authority, event, workspacePath } = input;
  const provider = request.providers.require(request.providerId);
  const session = request.engine.coding.get(codingSessionId);
  if (!session) throw new ExternalCodingRuntimeError('SESSION_NOT_FOUND', 'Coding session is unavailable');
  const requestId = interactionRequestId(event);
  const inputBudget = request.task.budgets.inputCount ?? 32;
  if (request.engine.coding.listInputs(codingSessionId).length >= inputBudget) {
    throw new ExternalCodingRuntimeError('INPUT_BUDGET_EXCEEDED', 'Coding session input budget is exhausted');
  }

  if (event.type === 'clarification.requested') {
    transitionIfNeeded(request.engine, authority, codingSessionId, 'waiting_for_input');
    if (!request.interaction) {
      throw new ExternalCodingRuntimeError(
        'DURABLE_INPUT_REQUIRED',
        'External coding clarification requires the parent interaction channel',
      );
    }
    const question = typeof event.payload.question === 'string'
      ? event.payload.question.slice(0, 8_192)
      : 'The external coding session requested clarification.';
    const response = await request.interaction.requestClarification({
      codingSessionId,
      parentJobId: session.parentJobId,
      childJobId: authority.childJobId,
      childAttemptId: authority.childAttemptId,
      generation: authority.childGeneration,
      requestId,
      question,
    });
    if (!response.content.trim() || response.content.length > 16_384) {
      throw new ExternalCodingRuntimeError('INVALID_CLARIFICATION_RESPONSE', 'Clarification response is empty or too large');
    }
    const durable = request.engine.coding.recordInput({
      ...authority,
      codingSessionId,
      requestId,
      kind: 'clarification',
      content: response.content,
      producer: `parent-interaction:${response.responseChannel}`,
      idempotencyKey: `provider-input:${event.providerEventId}`,
    });
    await provider.sendInput({
      providerSessionId,
      codingSessionId,
      childAttemptId: authority.childAttemptId,
      generation: authority.childGeneration,
      requestId,
      sequence: durable.sequence,
      kind: 'clarification',
      content: durable.content,
    });
    request.engine.coding.markInputDelivered({ ...authority, codingSessionId, inputId: durable.inputId });
    transitionIfNeeded(request.engine, authority, codingSessionId, 'running');
    return;
  }

  const operation = approvalOperation(event);
  transitionIfNeeded(request.engine, authority, codingSessionId, 'waiting_for_approval');
  const prohibited = /^(?:git\.(?:commit|push|tag|merge|reset|clean|remote)|package\.publish|agent\.recursive)$/u.test(operation)
    || request.task.forbiddenOperations.includes(operation);
  const permittedElevatedOperation = operation === 'package.install'
    && request.task.packagePolicy === 'approval_required';
  let decision: 'approved' | 'denied' | 'cancelled' = 'denied';
  let decidedBy = 'external-coding-policy';
  let decisionChannel = 'policy';
  let approval: ApprovalRecord | null = null;
  if (!prohibited && permittedElevatedOperation && request.approvalAuthority && request.interaction) {
    const normalized = normalizeExecutionPlan({
      toolName: 'external_coding_operation',
      args: { operation, request: event.payload },
      cwd: workspacePath,
      mutates: true,
      riskTier: 'dangerous',
      policy: {
        trustLevel: 'untrusted_external_runtime',
        autonomyPolicy: 'bounded',
        approvalMode: 'explicit',
        toolMetadataVersion: 'external-coding-v1',
        sandboxPolicy: { required: true, workspace: 'isolated' },
        networkPolicy: { mode: request.task.networkPolicy },
        pluginGrants: [],
        mcpGrants: [],
        workspaceOverrides: { codingSessionId },
        jobOverrides: { packagePolicy: request.task.packagePolicy },
      },
    });
    approval = request.approvalAuthority.request({
      jobId: authority.childJobId,
      attemptId: authority.childAttemptId,
      generation: authority.childGeneration,
      fenceToken: authority.childFenceToken,
      toolCallId: externalCodingIdentity('external_coding_request', { codingSessionId, requestId }),
      effectId: null,
      toolName: 'external_coding_operation',
      riskTier: 'dangerous',
      riskReasons: [`External coding runtime requested ${operation}.`],
      normalized,
    });
    request.approvalAuthority.markDisplayed(approval.approvalId);
    const response = await request.interaction.requestApproval({
      codingSessionId,
      parentJobId: session.parentJobId,
      childJobId: authority.childJobId,
      childAttemptId: authority.childAttemptId,
      generation: authority.childGeneration,
      requestId,
      operation,
      approval,
    });
    decision = response.decision;
    decidedBy = response.decidedBy;
    decisionChannel = response.decisionChannel;
  }
  const durable = request.engine.coding.recordInput({
    ...authority,
    codingSessionId,
    requestId,
    kind: 'approval',
    content: decision,
    producer: `parent-approval:${decisionChannel}`,
    idempotencyKey: `provider-input:${event.providerEventId}`,
  });
  if (approval && request.approvalAuthority) {
    const decided = request.approvalAuthority.decide({
      approvalId: approval.approvalId,
      jobId: authority.childJobId,
      attemptId: authority.childAttemptId,
      generation: authority.childGeneration,
      actionDigest: approval.actionDigest,
      policySnapshotId: approval.policySnapshotId,
      decision,
      decisionScope: 'once',
      decidedBy,
      decisionChannel,
    });
    if (decision === 'approved') {
      const authorized = request.approvalAuthority.authorizeExecution({
        approvalId: decided.approvalId,
        jobId: authority.childJobId,
        attemptId: authority.childAttemptId,
        generation: authority.childGeneration,
        fenceToken: authority.childFenceToken,
        toolCallId: decided.toolCallId,
        effectId: null,
        actionDigest: decided.actionDigest,
        policySnapshotId: decided.policySnapshotId,
      });
      if (!authorized.authorized) {
        throw new ExternalCodingRuntimeError(
          'APPROVAL_AUTHORITY_REJECTED',
          `Exact external coding approval could not be authorized: ${authorized.reason ?? 'unknown'}`,
        );
      }
    }
  }
  await provider.sendInput({
    providerSessionId,
    codingSessionId,
    childAttemptId: authority.childAttemptId,
    generation: authority.childGeneration,
    requestId,
    sequence: durable.sequence,
    kind: 'approval',
    content: decision,
  });
  request.engine.coding.markInputDelivered({ ...authority, codingSessionId, inputId: durable.inputId });
  transitionIfNeeded(request.engine, authority, codingSessionId, 'running');
}

function transitionIfNeeded(
  engine: JobEngine,
  authority: ChildAuthority,
  codingSessionId: string,
  to: Parameters<JobEngine['coding']['transition']>[0]['to'],
): void {
  const current = engine.coding.get(codingSessionId);
  if (!current || current.state === to || ['terminal', 'failed'].includes(current.state)) return;
  engine.coding.transition({
    ...authority,
    codingSessionId,
    to,
    producer: PRODUCER,
    idempotencyKey: `session-state:${codingSessionId}:${to}`,
  });
}

function createClaims(engine: JobEngine, handle: DurableJobHandle, criteria: readonly ExternalCodingAcceptanceCriterion[]) {
  const existing = engine.proof.listClaims(handle.jobId);
  return new Map(criteria.map((criterion) => {
    const prior = existing.find((claim) => claim.category === 'contract'
      && claim.statement === criterion.statement && claim.required === criterion.required);
    const claim = prior ?? engine.proof.createClaim({
      jobId: handle.jobId,
      attemptId: handle.attemptId,
      generation: handle.generation,
      category: 'contract',
      statement: criterion.statement,
      required: criterion.required,
    });
    return [claimKey(criterion), claim] as const;
  }));
}

async function collectProviderOutcome(input: {
  request: ExecuteExternalCodingSessionRequest;
  providerSessionId: string;
  codingSessionId: string;
  authority: ChildAuthority;
  logicalCallId: string;
}): Promise<{
  candidate: ExternalCodingCandidateResult;
  cancelled: boolean;
  eventCount: number;
  outputBytes: number;
  commandCount: number;
  policyViolation: string | null;
}> {
  const { request, providerSessionId, codingSessionId, authority, logicalCallId } = input;
  const provider = request.providers.require(request.providerId);
  const startedAt = (request.now ?? Date.now)();
  const runtimeLimit = request.task.budgets.runtimeMs;
  const eventLimit = request.task.budgets.eventCount ?? 1_000;
  const outputLimit = request.task.budgets.outputBytes;
  const commandLimit = request.task.budgets.commandCount;
  let cursor = 0;
  let eventCount = 0;
  let outputBytes = 0;
  let commandCount = 0;
  let cancellationPersisted = false;
  let cancelled = false;
  let policyViolation: string | null = null;

  const persistCancellation = async (reason: string): Promise<void> => {
    if (cancellationPersisted) return;
    const currentCall = request.engine.workerProviderCalls.get(logicalCallId);
    if (reason === 'runtime_budget_exceeded') {
      if (currentCall?.timeoutRequestedAt === null) {
        request.engine.workerProviderCalls.recordTimeoutIntent({
          ...authority,
          logicalCallId,
          reason,
          idempotencyKey: `external-coding-timeout:${codingSessionId}`,
        });
      }
    } else if (currentCall?.cancellationRequestedAt === null) {
      request.engine.workerProviderCalls.recordCancellationIntent({
        ...authority,
        logicalCallId,
        reason,
        idempotencyKey: `external-coding-cancel:${codingSessionId}:${reason}`,
      });
    }
    if (request.engine.coding.get(codingSessionId)?.cancellationRequestedAt === null) {
      request.engine.coding.requestCancellation({
        ...authority,
        codingSessionId,
        reason,
        producer: PRODUCER,
        idempotencyKey: `session-cancel:${codingSessionId}:${reason}`,
      });
    }
    cancellationPersisted = true;
    cancelled = true;
    try {
      await provider.cancel(providerSessionId, reason);
    } catch {
      await provider.terminate(providerSessionId).catch(() => undefined);
    }
  };

  const unknownTransportOutcome = (reason: string) => ({
    candidate: {
      summary: reason,
      reportedFiles: [],
      reportedValidations: [],
      externalOutcome: 'unknown' as const,
    },
    cancelled,
    eventCount,
    outputBytes,
    commandCount,
    policyViolation,
  });

  while (true) {
    if (request.handle.signal.aborted) {
      await persistCancellation('durable_job_cancelled');
      if (['cancelling', 'cancelled'].includes(request.engine.getJob(request.handle.jobId)?.status ?? '')) {
        return {
          candidate: {
            summary: 'Durable Job cancellation stopped the external coding session.',
            reportedFiles: [],
            reportedValidations: [],
            externalOutcome: 'cancelled',
          },
          cancelled: true,
          eventCount,
          outputBytes,
          commandCount,
          policyViolation,
        };
      }
    }
    if ((request.now ?? Date.now)() - startedAt > runtimeLimit) await persistCancellation('runtime_budget_exceeded');

    let events: readonly ExternalCodingProviderEvent[];
    try {
      events = await provider.events(providerSessionId, cursor);
    } catch {
      await persistCancellation('provider_transport_lost');
      return unknownTransportOutcome('Provider transport was lost after task dispatch; outcome requires reconciliation.');
    }
    for (const event of events) {
      eventCount += 1;
      outputBytes += Buffer.byteLength(JSON.stringify(event.payload), 'utf8');
      if (event.type === 'command.requested' || event.type === 'command.started') commandCount += 1;
      if (eventCount > eventLimit || outputBytes > outputLimit || commandCount > commandLimit) {
        await persistCancellation('coding_budget_exceeded');
        break;
      }
      appendProviderEvent(request.engine, authority, codingSessionId, event);
      cursor = Math.max(cursor, event.cursor);
      const commandClass = typeof event.payload.commandClass === 'string'
        ? event.payload.commandClass.slice(0, 128)
        : event.type;
      const violatesPolicy = event.payload.policyViolation === true
        || (event.type === 'command.requested' && commandClass === 'network'
          && request.task.networkPolicy === 'disabled')
        || (event.type === 'command.started' && event.payload.childRequested === true);
      if (violatesPolicy) {
        policyViolation = commandClass;
        await persistCancellation(`policy_violation:${commandClass}`);
        break;
      }
      if (event.type === 'clarification.requested' || event.type === 'approval.requested') {
        await routeProviderInteraction({
          request,
          providerSessionId,
          codingSessionId,
          authority,
          event,
          workspacePath: request.engine.codingWorkspaces.getForSession(codingSessionId)!.worktreePath,
        });
      }
    }

    let state;
    try {
      state = await provider.inspectState(providerSessionId);
    } catch {
      await persistCancellation('provider_state_lost');
      return unknownTransportOutcome('Provider state could not be observed after task dispatch; outcome requires reconciliation.');
    }
    if (state.state === 'terminal' || state.state === 'missing' || state.state === 'unknown') break;
    if (state.state === 'waiting') {
      throw new ExternalCodingRuntimeError('DURABLE_INPUT_REQUIRED', 'External coding session is waiting for durable input');
    }
    await sleep(Math.max(5, request.pollIntervalMs ?? 20));
  }

  let candidate: ExternalCodingCandidateResult | null;
  try {
    candidate = await provider.collectResult(providerSessionId);
  } catch {
    await persistCancellation('provider_result_lost');
    return unknownTransportOutcome('Provider result could not be collected; outcome requires reconciliation.');
  }
  if (request.handle.signal.aborted && !cancelled) await persistCancellation('durable_job_cancelled');
  if (candidate) return { candidate, cancelled, eventCount, outputBytes, commandCount, policyViolation };
  let reconciliation;
  try {
    reconciliation = await provider.reconcile(providerSessionId);
  } catch {
    return unknownTransportOutcome('Provider reconciliation failed; outcome remains unknown.');
  }
  if (reconciliation.result) {
    return { candidate: reconciliation.result, cancelled, eventCount, outputBytes, commandCount, policyViolation };
  }
  return {
    candidate: {
      summary: reconciliation.reason,
      reportedFiles: [],
      reportedValidations: [],
      externalOutcome: 'unknown',
    },
    cancelled,
    eventCount,
    outputBytes,
    commandCount,
    policyViolation,
  };
}

export async function executeExternalCodingSession(
  request: ExecuteExternalCodingSessionRequest,
): Promise<ExternalCodingExecutionResult> {
  request = {
    ...request,
    task: Object.freeze({
      ...request.task,
      protectedPaths: Object.freeze(compileExternalCodingProtectedPaths(request.task.protectedPaths)),
    }),
  };
  await recoverCancelledExternalCodingSessions({
    engine: request.engine,
    sourcePath: request.sourcePath,
    sessionHomeParent: request.sessionHomeParent,
    producer: PRODUCER,
  });
  const authority = childAuthority(request.handle);
  const selected = await request.providers.select(request.providerId);
  const { assignment, binding, context } = assertAssignment(
    request.engine,
    request.handle,
    request.assignmentId,
    selected.provider.id,
    request.modelId,
    selected.capability.capabilityDigest,
  );
  const codingSessionId = externalCodingSessionIdentity(
    assignment.assignmentId,
    request.handle.attemptId,
    request.handle.generation,
  );
  const workerRunId = externalCodingWorkerRunIdentity(codingSessionId, assignment.assignmentId);
  const workerRun = request.engine.worker.bindWorkerRunFromAssignment({
    ...authority,
    workerRunId,
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    providerBindingId: binding.providerBindingId,
    contextEnvelopeId: context.contextEnvelopeId,
    producer: PRODUCER,
    idempotencyKey: `external-coding-run:${codingSessionId}`,
  });
  const reservation = request.engine.resources.getWorkerReservationForChild(request.handle.jobId);
  if (!reservation || reservation.workerRunId !== workerRun.workerRunId
    || reservation.assignmentId !== assignment.assignmentId
    || reservation.childAttemptId !== request.handle.attemptId
    || reservation.childGeneration !== request.handle.generation
    || reservation.state === 'released' || reservation.state === 'cancelled') {
    throw new ExternalCodingRuntimeError(
      'WORKER_RESERVATION_MISMATCH',
      'External coding execution requires its exact active Worker budget reservation',
    );
  }
  const logicalCallId = identity('worker_provider_call', { workerRunId, ordinal: 1 });
  request.engine.workerProviderCalls.prepare({
    ...authority,
    logicalCallId,
    idempotencyKey: `external-coding-provider-call:${workerRunId}:1`,
    workerRunId,
    assignmentId: assignment.assignmentId,
    providerBindingId: binding.providerBindingId,
    callOrdinal: 1,
    requestHash: computeWorkerDigest({ task: request.task, modelId: request.modelId }),
    toolSchemaHash: computeWorkerDigest([]),
  });

  const sessionHomeParent = path.resolve(request.sessionHomeParent);
  const sessionHome = path.join(sessionHomeParent, codingSessionId);
  const sessionTemp = path.join(sessionHome, 'tmp');
  const relativeHome = path.relative(sessionHomeParent, sessionHome);
  if (relativeHome.startsWith(`..${path.sep}`) || path.isAbsolute(relativeHome)) {
    throw new ExternalCodingRuntimeError('INVALID_SESSION_HOME', 'Coding session HOME escapes its configured parent');
  }
  await mkdir(sessionTemp, { recursive: true });
  if (process.platform === 'win32') {
    await Promise.all([
      mkdir(path.join(sessionHome, 'AppData', 'Roaming'), { recursive: true }),
      mkdir(path.join(sessionHome, 'AppData', 'Local'), { recursive: true }),
    ]);
  }

  const workspace = await request.engine.codingWorkspaces.allocate({
    ...authority,
    codingSessionId,
    sourcePath: request.sourcePath,
    worktreeParent: request.worktreeParent,
    protectedPaths: request.task.protectedPaths,
  });
  request.engine.coding.admit({
    ...authority,
    codingSessionId,
    parentJobId: assignment.parentJobId,
    assignmentId: assignment.assignmentId,
    workerRunId,
    workspaceLeaseId: workspace.workspaceLeaseId,
    sessionHomePath: sessionHome,
    capability: selected.capability,
    taskEnvelope: request.task,
    producer: PRODUCER,
    idempotencyKey: `external-coding-session:${codingSessionId}`,
  });
  const taskInput = request.engine.coding.recordInput({
    ...authority,
    codingSessionId,
    requestId: `task_${codingSessionId}`,
    kind: 'task',
    content: request.task.goal,
    producer: PRODUCER,
    idempotencyKey: `external-coding-task:${codingSessionId}`,
  });
  const claimMap = createClaims(request.engine, request.handle, request.task.acceptanceCriteria);
  const preSnapshot = await request.engine.codingMutations.captureBaseline({
    ...authority,
    codingSessionId,
    producer: PRODUCER,
  });
  const environment = createExternalCodingEnvironment({
    source: request.sourceEnvironment,
    sessionHome,
    sessionTemp,
    approved: request.approvedEnvironment,
    approvedKeys: request.approvedEnvironmentKeys,
  });

  let providerSessionId: string | null = null;
  let keepSessionHome = false;
  let candidateOutcome: ExternalCodingCandidateResult['externalOutcome'] | null = null;
  let processTreeSettled = false;
  let durableCancellationObserved = false;
  let cancellationReconciliation: WorkerProviderCallReconciliationResult | null = null;
  const executionStartedAt = Date.now();
  try {
    transitionIfNeeded(request.engine, authority, codingSessionId, 'starting');
    request.engine.workerProviderCalls.markAttempting({ ...authority, logicalCallId });
    const providerSession = await selected.provider.startSession({
      codingSessionId,
      childJobId: request.handle.jobId,
      childAttemptId: request.handle.attemptId,
      generation: request.handle.generation,
      modelId: request.modelId,
      workspacePath: workspace.worktreePath,
      sessionHome,
      task: request.task,
      environment,
      redactionCanaries: Object.values(request.approvedEnvironment ?? {}).filter((value) => value.length >= 8),
      sandbox: {
        required: true,
        available: request.sandboxAvailable,
        network: request.task.networkPolicy === 'disabled' ? 'disabled' : 'adapter_only',
      },
    });
    processTreeSettled = providerSession.processIdentity === null;
    providerSessionId = providerSession.providerSessionId;
    request.engine.resources.commitWorkerUsage({
      reservationId: reservation.reservationId,
      childAttemptId: request.handle.attemptId,
      childGeneration: request.handle.generation,
      childFenceToken: request.handle.fenceToken,
      kind: 'model_calls',
      amount: 1,
      certainty: 'confirmed',
      sourceKind: 'provider_attempt',
      sourceId: providerSessionId,
      idempotencyKey: `external-coding-provider-attempt:${providerSessionId}`,
    });
    request.engine.coding.bindProviderSession({ ...authority, codingSessionId, providerSessionId });
    if (providerSession.processIdentity) {
      request.engine.coding.bindProcess({
        ...authority,
        codingSessionId,
        processRecordId: providerSession.processRecordId
          ?? identity('coding_process', { codingSessionId, providerSessionId }),
        processIdentity: providerSession.processIdentity,
      });
    }
    transitionIfNeeded(request.engine, authority, codingSessionId, 'running');
    await selected.provider.sendTask({
      providerSessionId,
      codingSessionId,
      childAttemptId: request.handle.attemptId,
      generation: request.handle.generation,
      modelId: request.modelId,
      task: request.task,
    });
    request.engine.coding.markInputDelivered({ ...authority, codingSessionId, inputId: taskInput.inputId });

    const outcome = await collectProviderOutcome({
      request, providerSessionId, codingSessionId, authority, logicalCallId,
    });
    if (['cancelling', 'cancelled'].includes(request.engine.getJob(request.handle.jobId)?.status ?? '')) {
      durableCancellationObserved = true;
      candidateOutcome = 'cancelled';
      const providerState = await selected.provider.inspectState(providerSessionId).catch(() => ({
        state: 'unknown' as const,
        processIdentity: null,
        lastCursor: 0,
        detail: 'unavailable',
      }));
      const forensic = await selected.provider.forensicOutput?.(providerSessionId).catch(() => null) ?? null;
      const process = request.engine.coding.getProcess(codingSessionId);
      processTreeSettled = forensic?.treeDeadVerified === true
        || (process === null && providerState.processIdentity === null && providerState.state === 'terminal');
      const call = request.engine.workerProviderCalls.get(logicalCallId);
      if (!call) {
        throw new ExternalCodingRuntimeError('PROVIDER_CALL_MISSING', 'Cancelled coding provider call is unavailable');
      }
      cancellationReconciliation = request.engine.workerProviderCalls.reconcile({
        logicalCallId,
        workerRunId: call.workerRunId,
        childJobId: call.childJobId,
        childAttemptId: call.childAttemptId,
        childGeneration: call.childGeneration,
        physicalAttempts: [{
          providerAttemptId: providerSessionId,
          status: processTreeSettled ? 'interrupted' : providerState.state,
          noResponseProven: processTreeSettled,
          usageKnown: processTreeSettled,
          costKnown: processTreeSettled,
        }],
        unknownSpend: !processTreeSettled,
        reason: 'durable_job_cancelled',
        idempotencyKey: `external-coding-cancel-reconcile:${codingSessionId}`,
      });
      request.engine.coding.settleCancellation({
        ...authority,
        codingSessionId,
        processRecordId: forensic?.processRecordId ?? process?.processRecordId ?? null,
        exitCode: forensic?.exitCode ?? null,
        exitSignal: forensic?.exitSignal ?? null,
        treeDeadVerified: processTreeSettled,
        producer: PRODUCER,
        idempotencyKey: `external-coding-cancel-settled:${codingSessionId}`,
      });
      if (processTreeSettled) {
        await request.engine.codingWorkspaces.releaseCancelled({
          ...authority,
          codingSessionId,
          workspaceLeaseId: workspace.workspaceLeaseId,
        });
      } else {
        keepSessionHome = true;
      }
      throw new ExternalCodingRuntimeError(
        'DURABLE_JOB_CANCELLED',
        'Durable Job cancellation stopped the external coding session',
      );
    }
    const durableResult = request.engine.coding.appendEvent({
      ...authority,
      codingSessionId,
      type: 'result.reported',
      payload: { candidate: outcome.candidate },
      producer: PRODUCER,
      idempotencyKey: `external-coding-candidate:${codingSessionId}`,
    });
    request.engine.coding.attachCandidateResult({
      ...authority,
      codingSessionId,
      candidateResultRef: durableResult.eventId,
    });
    const forensic = await selected.provider.forensicOutput?.(providerSessionId).catch(() => null);
    if (forensic) {
      processTreeSettled = forensic.treeDeadVerified;
      let chunkSequence = 1;
      for (const [stream, content] of [['stdout', forensic.stdout], ['stderr', forensic.stderr]] as const) {
        if (!content) continue;
        request.engine.coding.appendRawOutput({
          ...authority,
          codingSessionId,
          chunkSequence,
          stream,
          content,
          observedByteCount: Buffer.byteLength(content, 'utf8'),
          truncated: forensic.truncated,
        });
        chunkSequence += 1;
      }
      request.engine.coding.recordProcessExit({
        ...authority,
        codingSessionId,
        processRecordId: forensic.processRecordId,
        state: outcome.candidate.externalOutcome === 'unknown' || !forensic.treeDeadVerified ? 'unknown' : 'exited',
        exitCode: forensic.exitCode,
        exitSignal: forensic.exitSignal,
        treeDeadVerified: forensic.treeDeadVerified,
      });
    }
    candidateOutcome = outcome.candidate.externalOutcome;
    request.engine.resources.commitWorkerUsage({
      reservationId: reservation.reservationId,
      childAttemptId: request.handle.attemptId,
      childGeneration: request.handle.generation,
      childFenceToken: request.handle.fenceToken,
      kind: 'tool_calls',
      amount: outcome.commandCount,
      certainty: 'confirmed',
      sourceKind: 'tool_call',
      sourceId: codingSessionId,
      idempotencyKey: `external-coding-command-count:${codingSessionId}`,
    });
    request.engine.resources.commitWorkerUsage({
      reservationId: reservation.reservationId,
      childAttemptId: request.handle.attemptId,
      childGeneration: request.handle.generation,
      childFenceToken: request.handle.fenceToken,
      kind: 'output_bytes',
      amount: outcome.outputBytes,
      certainty: 'confirmed',
      sourceKind: 'reconciliation',
      sourceId: codingSessionId,
      idempotencyKey: `external-coding-output-bytes:${codingSessionId}`,
    });
    if (outcome.policyViolation) {
      request.engine.workerProviderCalls.fail({
        ...authority, logicalCallId, failureKind: `policy_violation:${outcome.policyViolation}`, outcomeKnown: true,
      });
    } else if (outcome.cancelled) {
      request.engine.workerProviderCalls.fail({
        ...authority, logicalCallId, failureKind: 'cancelled', outcomeKnown: true, cancelled: true,
      });
    } else if (!processTreeSettled) {
      request.engine.workerProviderCalls.fail({
        ...authority, logicalCallId, failureKind: 'process_tree_unsettled', outcomeKnown: false,
      });
    } else if (outcome.candidate.externalOutcome === 'unknown') {
      request.engine.workerProviderCalls.fail({
        ...authority, logicalCallId, failureKind: 'outcome_unknown', outcomeKnown: false,
      });
    } else if (outcome.candidate.externalOutcome === 'failed') {
      request.engine.workerProviderCalls.fail({
        ...authority, logicalCallId, failureKind: 'provider_failed', outcomeKnown: true,
      });
    } else {
      const responseHash = computeWorkerDigest(outcome.candidate);
      request.engine.workerProviderCalls.recordResponseReceived({
        ...authority,
        logicalCallId,
        providerAttemptId: providerSessionId,
        responseHash,
        providerRequestId: providerSessionId,
      });
      request.engine.workerProviderCalls.acceptResponse({
        ...authority, logicalCallId, providerAttemptId: providerSessionId, responseHash,
      });
      request.engine.workerProviderCalls.markDownstreamStarted({ ...authority, logicalCallId });
    }
    transitionIfNeeded(request.engine, authority, codingSessionId, 'process_terminal');

    if (outcome.candidate.externalOutcome === 'unknown' || !processTreeSettled) {
      keepSessionHome = true;
      request.engine.coding.requireReconciliation({
        ...authority,
        codingSessionId,
        reason: outcome.candidate.externalOutcome === 'unknown'
          ? 'Provider process outcome is unknown'
          : 'Provider process tree has not been proven terminal',
        producer: PRODUCER,
        idempotencyKey: `external-coding-reconcile:${codingSessionId}`,
      });
    } else if (!outcome.cancelled) {
      transitionIfNeeded(request.engine, authority, codingSessionId, 'verification_pending');
    }

    let mutation = await request.engine.codingMutations.reconcile({
      ...authority,
      codingSessionId,
      reportedResult: outcome.candidate,
      producer: PRODUCER,
    });

    const evidence: EvidenceRecord[] = [];
    if (!outcome.cancelled && processTreeSettled
      && outcome.candidate.externalOutcome !== 'unknown' && mutation.state !== 'rejected') {
      const verification = await request.verify({
        engine: request.engine,
        authority: {
          jobId: request.handle.jobId,
          attemptId: request.handle.attemptId,
          generation: request.handle.generation,
          fenceToken: request.handle.fenceToken,
        },
        signal: request.handle.signal,
        codingSessionId,
        workspace,
        preSnapshotId: preSnapshot.id,
        postSnapshotId: mutation.postSnapshotId!,
        mutation,
        processTreeSettled,
        candidate: outcome.candidate,
        task: request.task,
      });
      const verificationById = new Map(verification.claims.map((claim) => [claim.claimId, claim]));
      for (const criterion of request.task.acceptanceCriteria) {
        const observed = verificationById.get(criterion.claimId) ?? {
          claimId: criterion.claimId,
          state: 'unknown' as const,
          payload: { reason: 'independent verifier did not return this claim' },
        };
        const recorded = request.engine.proof.recordEvidence({
          jobId: request.handle.jobId,
          attemptId: request.handle.attemptId,
          generation: request.handle.generation,
          fenceToken: request.handle.fenceToken,
          repositorySnapshotId: mutation.postSnapshotId,
          source: 'external-coding.independent-verification',
          producer: PRODUCER,
          observedAt: Date.now(),
          coverage: observed.state === 'unknown' ? 'unknown' : 'full',
          verificationResult: observed.state,
          payload: { externalClaimId: criterion.claimId, result: observed.payload },
        });
        evidence.push(recorded);
        request.engine.proof.checkClaim({
          claimId: claimMap.get(claimKey(criterion))!.claimId,
          attemptId: request.handle.attemptId,
          generation: request.handle.generation,
          evidenceIds: [recorded.evidenceId],
          state: observed.state,
        });
      }
      for (const validationRef of verification.validationRefs) {
        request.engine.coding.attachValidation({ ...authority, codingSessionId, validationRef });
      }
      const proofPreview = request.engine.proof.finalize({
        jobId: request.handle.jobId,
        attemptId: request.handle.attemptId,
        generation: request.handle.generation,
        fenceToken: request.handle.fenceToken,
      });
      if (proofPreview.verdict === 'verified') {
        mutation = request.engine.codingMutations.markVerified({
          ...authority,
          codingSessionId,
          receiptId: mutation.receiptId,
          validationRefs: [...verification.validationRefs, ...evidence.map((item) => item.evidenceId)],
          producer: PRODUCER,
        });
      }
    }

    const proof = request.engine.proof.getVerdict(request.handle.jobId) ?? request.engine.proof.finalize({
      jobId: request.handle.jobId,
      attemptId: request.handle.attemptId,
      generation: request.handle.generation,
      fenceToken: request.handle.fenceToken,
      cancelled: outcome.cancelled,
    });
    const status = resultStatus(outcome.candidate, proof, mutation, outcome.cancelled, outcome.policyViolation);
    const completedAt = Date.now();
    const allEvidence = request.engine.proof.listEvidence(request.handle.jobId);
    const payload: WorkerResultPayloadV1 = {
      schemaVersion: 1,
      status,
      summary: outcome.candidate.summary,
      findings: request.task.acceptanceCriteria.map((criterion) => ({
        findingId: criterion.claimId,
        statement: criterion.statement,
        sourceReferences: [],
        evidenceIds: evidence.filter((item) => (item.payload as { externalClaimId?: string }).externalClaimId === criterion.claimId)
          .map((item) => item.evidenceId),
        uncertainty: proof.verdict === 'verified' ? 'low' : proof.verdict === 'failed' ? 'medium' : 'high',
      })),
      sourceReferences: [],
      filesInspected: [],
      commandsExecuted: request.engine.coding.listEvents(codingSessionId)
        .filter((event) => event.type === 'command.completed')
        .map((event) => ({
          toolCallId: String(event.payload.providerEventId ?? event.eventId),
          tool: String(event.payload.commandClass ?? 'external-command'),
          inputHash: computeWorkerDigest(event.payload),
          status: 'completed',
        })),
      diagnostics: mutation.reportMismatch
        ? [{ code: 'provider_report_mismatch', message: 'Provider file report differed from the observed diff.', severity: 'warning' }]
        : [],
      evidenceIds: allEvidence.map((item) => item.evidenceId),
      unresolvedQuestions: proof.verdict === 'verified' ? [] : ['Independent verification did not prove every required claim.'],
      uncertainty: {
        level: proof.verdict === 'verified' ? 'low' : proof.verdict === 'failed' ? 'medium' : 'high',
        reasons: proof.verdict === 'verified' ? [] : [proof.verdict],
      },
      providerAttemptIds: providerSessionId ? [providerSessionId] : [],
      budgetUsage: request.engine.resources.getBudgets(request.handle.jobId).map((budget) => ({
        kind: budget.kind,
        amount: budget.hasUnknownUsage ? null : budget.used,
        ...(budget.hasUnknownUsage ? { unknownReason: 'usage was not fully observed' } : {}),
      })),
      timing: {
        startedAt: request.engine.coding.get(codingSessionId)?.startedAt ?? completedAt,
        completedAt,
        wallClockMs: Math.max(0, completedAt - (request.engine.coding.get(codingSessionId)?.startedAt ?? completedAt)),
      },
      failure: status === 'completed' ? null : {
        category: outcome.policyViolation ? 'auth'
          : status === 'cancelled' ? 'cancelled' : proof.verdict === 'failed' ? 'validation' : 'unknown',
        code: status,
        message: outcome.candidate.summary,
        retryable: false,
        externalOutcomeUnknown: outcome.candidate.externalOutcome === 'unknown',
      },
      inputHash: assignment.inputHash,
      resultHash: '',
    };
    payload.resultHash = computeWorkerResultHash(payload);
    const workerResult = request.engine.worker.recordWorkerResultFromRun({
      ...authority,
      workerResultId: identity('worker_result', { workerRunId, resultHash: payload.resultHash }),
      workerRunId,
      assignmentId: assignment.assignmentId,
      payload,
      producer: PRODUCER,
      idempotencyKey: `external-coding-result:${workerRunId}:${payload.resultHash}`,
    });
    if (workerResult.acceptanceState !== 'accepted') {
      throw new ExternalCodingRuntimeError(
        'WORKER_RESULT_REJECTED',
        `External coding Worker result was rejected: ${workerResult.rejectionCode ?? 'unknown'}`,
      );
    }
    if (outcome.candidate.externalOutcome === 'completed' && !outcome.cancelled && processTreeSettled) {
      request.engine.workerProviderCalls.complete({ ...authority, logicalCallId });
    }
    const childResult = request.engine.recordChildResult({
      childJobId: request.handle.jobId,
      attemptId: request.handle.attemptId,
      generation: request.handle.generation,
      fenceToken: request.handle.fenceToken,
      status: workerResult.status,
      evidence: { workerResultId: workerResult.workerResultId, mutationReceiptId: mutation.receiptId },
      evidenceHandles: workerResult.evidenceIds,
      producer: PRODUCER,
      idempotencyKey: `external-coding-child-result:${workerResult.workerResultId}`,
    });
    if (!childResult.applied && !childResult.duplicate) {
      throw new ExternalCodingRuntimeError('CHILD_RESULT_REJECTED', 'External coding child result could not be recorded');
    }

    let promotion: ExternalCodingPromotionPlanRecord | null = null;
    if (status === 'completed') {
      transitionIfNeeded(request.engine, authority, codingSessionId, 'ready_for_review');
      request.engine.codingWorkspaces.markState({
        ...authority,
        codingSessionId,
        workspaceLeaseId: workspace.workspaceLeaseId,
        state: 'review_pending',
      });
      promotion = await request.engine.codingPromotions.prepareCandidate({
        ...authority,
        codingSessionId,
        producer: PRODUCER,
      });
    } else if (status === 'cancelled') {
      transitionIfNeeded(request.engine, authority, codingSessionId, 'terminal');
    } else if (status === 'failed') {
      transitionIfNeeded(request.engine, authority, codingSessionId, 'failed');
    } else {
      keepSessionHome = true;
      const current = request.engine.coding.get(codingSessionId);
      if (current && !['required', 'blocked_unknown'].includes(current.reconciliationState)) {
        request.engine.coding.requireReconciliation({
          ...authority,
          codingSessionId,
          reason: 'Independent verification did not prove the isolated candidate safe for promotion.',
          producer: PRODUCER,
          idempotencyKey: `external-coding-unverified:${codingSessionId}`,
        });
      }
      transitionIfNeeded(request.engine, authority, codingSessionId, 'unknown');
    }

    return {
      codingSessionId,
      workerRun,
      workerResult,
      workspace: request.engine.codingWorkspaces.get(workspace.workspaceLeaseId)!,
      mutation,
      promotion,
      proof,
      finalization: dispositionFor(status, workerResult.workerResultId, proof),
    };
  } catch (error) {
    const call = request.engine.workerProviderCalls.get(logicalCallId);
    if (durableCancellationObserved
      || ['cancelling', 'cancelled'].includes(request.engine.getJob(request.handle.jobId)?.status ?? '')) {
      keepSessionHome = !processTreeSettled;
    } else if (providerSessionId === null) {
      if (call && ['prepared', 'attempting', 'response_received'].includes(call.state)) {
        request.engine.workerProviderCalls.fail({
          ...authority, logicalCallId, failureKind: 'provider_start_failed', outcomeKnown: true,
        });
      }
      transitionIfNeeded(request.engine, authority, codingSessionId, 'failed');
      await request.engine.codingWorkspaces.release({
        ...authority,
        codingSessionId,
        workspaceLeaseId: workspace.workspaceLeaseId,
        disposition: 'discard',
      });
    } else {
      keepSessionHome = true;
      if (call && ['prepared', 'attempting', 'response_received'].includes(call.state)) {
        request.engine.workerProviderCalls.fail({
          ...authority, logicalCallId, failureKind: 'runtime_interrupted', outcomeKnown: false,
        });
      }
      try {
        request.engine.coding.requireReconciliation({
          ...authority,
          codingSessionId,
          reason: 'External coding runtime stopped before authoritative settlement.',
          producer: PRODUCER,
          idempotencyKey: `external-coding-runtime-error:${codingSessionId}`,
        });
      } catch {
        transitionIfNeeded(request.engine, authority, codingSessionId, 'unknown');
      }
    }
    throw error;
  } finally {
    if (providerSessionId) await selected.provider.close(providerSessionId).catch(() => undefined);
    if (durableCancellationObserved) {
      if (cancellationReconciliation) {
        request.engine.resources.reconcileWorkerUsage({
          reservationId: reservation.reservationId,
          logicalCallId,
          kind: 'runtime_ms',
          amount: Math.max(0, Date.now() - executionStartedAt),
          certainty: 'confirmed',
          providerAttemptId: providerSessionId ?? logicalCallId,
          idempotencyKey: `runtime:${request.handle.attemptId}:${request.handle.generation}`,
        });
        request.engine.resources.reconcileWorkerReservation({
          reservationId: reservation.reservationId,
          logicalCallId,
          outcomeKnowledge: cancellationReconciliation.outcomeKnowledge,
          retrySafety: cancellationReconciliation.retrySafety,
          unknownSpend: cancellationReconciliation.unknownSpend,
          safeToRelease: processTreeSettled
            && !cancellationReconciliation.unknownSpend
            && !cancellationReconciliation.unsettledDownstream,
          reason: 'durable_job_cancelled',
          idempotencyKey: `external-coding-reservation-cancelled:${codingSessionId}`,
        });
      }
    } else {
      try {
        request.engine.resources.commitWorkerUsage({
          reservationId: reservation.reservationId,
          childAttemptId: request.handle.attemptId,
          childGeneration: request.handle.generation,
          childFenceToken: request.handle.fenceToken,
          kind: 'runtime_ms',
          amount: Math.max(0, Date.now() - executionStartedAt),
          certainty: 'confirmed',
          sourceKind: 'runtime',
          sourceId: `${request.handle.attemptId}:${request.handle.generation}`,
          idempotencyKey: `runtime:${request.handle.attemptId}:${request.handle.generation}`,
        });
      } finally {
        request.engine.resources.releaseWorker({
          reservationId: reservation.reservationId,
          childAttemptId: request.handle.attemptId,
          childGeneration: request.handle.generation,
          childFenceToken: request.handle.fenceToken,
          cancelled: request.handle.signal.aborted || candidateOutcome === 'cancelled',
        });
      }
    }
    if (!keepSessionHome) await rm(sessionHome, { recursive: true, force: true });
  }
}
