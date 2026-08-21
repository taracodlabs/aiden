/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { JobEngine } from '../daemon/jobEngine';
import type { DurableJobDisposition, DurableJobHandle } from '../daemon/jobLifecycle';
import type { EvidenceRecord, JobVerdictRecord } from '../daemon/jobProofAuthority';
import type { ExternalCodingMutationReceipt } from './mutationAuthority';
import type { ExternalCodingPromotionPlanRecord } from './promotionAuthority';
import type {
  ExternalCodingCandidateResult,
  ExternalCodingEventRecord,
  ExternalCodingTaskEnvelope,
} from './types';
import type {
  ExternalCodingClaimVerification,
  ExternalCodingVerificationContext,
  ExternalCodingVerificationResult,
} from './runtime';

const PRODUCER = 'external-coding-recovery';

interface ChildAuthority {
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  childFenceToken: string;
}

export interface RecoverExternalCodingSessionRequest {
  readonly engine: JobEngine;
  readonly handle: DurableJobHandle;
  readonly codingSessionId: string;
  readonly recoveryOfAttemptId: string;
  verify(context: ExternalCodingVerificationContext): Promise<ExternalCodingVerificationResult>;
}

export interface RecoveredExternalCodingSession {
  readonly codingSessionId: string;
  readonly mutation: ExternalCodingMutationReceipt;
  readonly promotion: ExternalCodingPromotionPlanRecord | null;
  readonly proof: JobVerdictRecord;
  readonly validationRefs: readonly string[];
  readonly providerRerun: false;
  readonly finalization: DurableJobDisposition;
}

export function recoverableCompletedExternalCodingSession(input: {
  engine: JobEngine;
  childJobId: string;
  predecessorAttemptId?: string;
}): { codingSessionId: string; predecessorAttemptId: string } | null {
  const session = input.engine.coding.getForChildJob(input.childJobId);
  if (!session || (input.predecessorAttemptId && session.childAttemptId !== input.predecessorAttemptId)
    || !session.candidateResultRef
    || !['process_terminal', 'reconciliation_required', 'verification_pending', 'ready_for_review'].includes(session.state)) {
    return null;
  }
  let candidate: ExternalCodingCandidateResult;
  try {
    candidate = candidateFrom(input.engine.coding.listEvents(session.codingSessionId), session.candidateResultRef);
  } catch {
    return null;
  }
  if (candidate.externalOutcome === 'unknown') return null;
  const process = input.engine.coding.getProcess(session.codingSessionId);
  if (process && (process.state !== 'exited' || !process.treeDeadVerified)) return null;
  if (!process && session.processIdentity !== null) return null;
  return { codingSessionId: session.codingSessionId, predecessorAttemptId: session.childAttemptId };
}

function authority(handle: DurableJobHandle): ChildAuthority {
  return {
    childJobId: handle.jobId,
    childAttemptId: handle.attemptId,
    childGeneration: handle.generation,
    childFenceToken: handle.fenceToken,
  };
}

function isCandidate(value: unknown): value is ExternalCodingCandidateResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.summary === 'string'
    && Array.isArray(candidate.reportedFiles)
    && candidate.reportedFiles.every((item) => typeof item === 'string')
    && Array.isArray(candidate.reportedValidations)
    && candidate.reportedValidations.every((item) => typeof item === 'string')
    && ['completed', 'failed', 'cancelled', 'unknown'].includes(String(candidate.externalOutcome));
}

function candidateFrom(events: readonly ExternalCodingEventRecord[], resultRef: string): ExternalCodingCandidateResult {
  const event = events.find((item) => item.eventId === resultRef && item.type === 'result.reported');
  const candidate = event?.payload.candidate;
  if (!isCandidate(candidate)) throw new Error('Durable external coding candidate result is unavailable');
  return candidate;
}

function claimsFor(
  engine: JobEngine,
  handle: DurableJobHandle,
  task: ExternalCodingTaskEnvelope,
): Map<string, ReturnType<JobEngine['proof']['createClaim']>> {
  const existing = engine.proof.listClaims(handle.jobId);
  return new Map(task.acceptanceCriteria.map((criterion) => {
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
    return [criterion.claimId, claim] as const;
  }));
}

function finalization(
  candidate: ExternalCodingCandidateResult,
  mutation: ExternalCodingMutationReceipt,
  proof: JobVerdictRecord,
  codingSessionId: string,
): DurableJobDisposition {
  const evidence = { codingSessionId, mutationReceiptId: mutation.receiptId, proofVerdict: proof.verdict, recovered: true };
  if (candidate.externalOutcome === 'cancelled') {
    return { status: 'cancelled', attemptStatus: 'cancelled', outcome: 'cancelled', finishReason: 'interrupted', evidence };
  }
  if (candidate.externalOutcome === 'failed' || mutation.state === 'rejected' || proof.verdict === 'failed') {
    return { status: 'failed', attemptStatus: 'failed', outcome: 'external_coding_failed', finishReason: 'verification_failed', evidence };
  }
  if (candidate.externalOutcome === 'completed' && mutation.state === 'verified' && proof.verdict === 'verified') {
    return { status: 'completed', outcome: 'external_coding_verified', finishReason: 'stop', evidence };
  }
  return { status: 'unknown', outcome: 'external_coding_unknown', finishReason: 'verification_incomplete', evidence };
}

async function snapshotForRecovery(input: {
  engine: JobEngine;
  handle: DurableJobHandle;
  workspacePath: string;
  mutation: ExternalCodingMutationReceipt;
}): Promise<string> {
  const existing = input.mutation.postSnapshotId
    ? input.engine.repository.getSnapshot(input.mutation.postSnapshotId)
    : null;
  if (!existing) throw new Error('Reconciled coding candidate snapshot is unavailable');
  if (existing.attemptId === input.handle.attemptId && existing.generation === input.handle.generation) {
    return existing.id;
  }
  const recovered = await input.engine.repository.captureSnapshot({
    jobId: input.handle.jobId,
    attemptId: input.handle.attemptId,
    generation: input.handle.generation,
    fenceToken: input.handle.fenceToken,
    requestedPath: input.workspacePath,
    producer: PRODUCER,
  });
  if (recovered.incomplete || recovered.stateDigest !== existing.stateDigest) {
    throw new Error('Coding candidate changed before recovery validation');
  }
  return recovered.id;
}

function recordVerification(input: {
  engine: JobEngine;
  handle: DurableJobHandle;
  task: ExternalCodingTaskEnvelope;
  postSnapshotId: string;
  verification: ExternalCodingVerificationResult;
}): EvidenceRecord[] {
  const claims = claimsFor(input.engine, input.handle, input.task);
  const verificationById = new Map(input.verification.claims.map((claim) => [claim.claimId, claim]));
  const evidence: EvidenceRecord[] = [];
  for (const criterion of input.task.acceptanceCriteria) {
    const observed: ExternalCodingClaimVerification = verificationById.get(criterion.claimId) ?? {
      claimId: criterion.claimId,
      state: 'unknown',
      payload: { reason: 'independent verifier did not return this claim' },
    };
    const recorded = input.engine.proof.recordEvidence({
      jobId: input.handle.jobId,
      attemptId: input.handle.attemptId,
      generation: input.handle.generation,
      fenceToken: input.handle.fenceToken,
      repositorySnapshotId: input.postSnapshotId,
      source: 'external-coding.recovery-verification',
      producer: PRODUCER,
      observedAt: Date.now(),
      coverage: observed.state === 'unknown' ? 'unknown' : 'full',
      verificationResult: observed.state,
      payload: { externalClaimId: criterion.claimId, result: observed.payload, recovered: true },
    });
    evidence.push(recorded);
    input.engine.proof.checkClaim({
      claimId: claims.get(criterion.claimId)!.claimId,
      attemptId: input.handle.attemptId,
      generation: input.handle.generation,
      evidenceIds: [recorded.evidenceId],
      state: observed.state,
    });
  }
  return evidence;
}

/**
 * Continues a durably settled provider outcome under a replacement Attempt.
 * The provider is deliberately absent from this contract, so recovery cannot
 * dispatch the coding task a second time.
 */
export async function recoverCompletedExternalCodingSession(
  request: RecoverExternalCodingSessionRequest,
): Promise<RecoveredExternalCodingSession> {
  const predecessor = request.engine.getAttempt(request.recoveryOfAttemptId);
  if (!predecessor || predecessor.jobId !== request.handle.jobId) {
    throw new Error('External coding recovery predecessor is unavailable');
  }
  const priorSession = request.engine.coding.get(request.codingSessionId);
  if (!priorSession || !priorSession.candidateResultRef) throw new Error('External coding recovery session is unavailable');
  const candidate = candidateFrom(
    request.engine.coding.listEvents(request.codingSessionId),
    priorSession.candidateResultRef,
  );
  if (candidate.externalOutcome === 'unknown') throw new Error('External coding provider outcome remains unknown');
  const recoveredAuthority = authority(request.handle);
  const session = request.engine.coding.claimRecovery({
    ...recoveredAuthority,
    codingSessionId: request.codingSessionId,
    recoveryOfAttemptId: predecessor.id,
    recoveryOfGeneration: predecessor.generation,
    producer: PRODUCER,
    idempotencyKey: `external-coding-recovery-claim:${request.codingSessionId}:${request.handle.attemptId}`,
  });
  const workspace = request.engine.codingWorkspaces.get(session.workspaceLeaseId);
  if (!workspace) throw new Error('External coding recovery workspace is unavailable');
  const process = request.engine.coding.getProcess(session.codingSessionId);
  const processTreeSettled = process ? process.state === 'exited' && process.treeDeadVerified : session.processIdentity === null;
  if (!processTreeSettled) throw new Error('External coding process tree is not durably terminal');

  let mutation = await request.engine.codingMutations.reconcile({
    ...recoveredAuthority,
    codingSessionId: session.codingSessionId,
    reportedResult: candidate,
    producer: PRODUCER,
  });
  let proof = request.engine.proof.getVerdict(request.handle.jobId);
  let validationRefs = [...session.validationRefs];
  if (!proof) {
    const postSnapshotId = await snapshotForRecovery({
      engine: request.engine,
      handle: request.handle,
      workspacePath: workspace.worktreePath,
      mutation,
    });
    const verification = await request.verify({
      engine: request.engine,
      authority: {
        jobId: request.handle.jobId,
        attemptId: request.handle.attemptId,
        generation: request.handle.generation,
        fenceToken: request.handle.fenceToken,
      },
      signal: request.handle.signal,
      codingSessionId: session.codingSessionId,
      workspace,
      preSnapshotId: mutation.preSnapshotId,
      postSnapshotId,
      mutation: { ...mutation, postSnapshotId },
      processTreeSettled,
      candidate,
      task: session.taskEnvelope,
    });
    const evidence = recordVerification({
      engine: request.engine,
      handle: request.handle,
      task: session.taskEnvelope,
      postSnapshotId,
      verification,
    });
    validationRefs = [...new Set([...validationRefs, ...verification.validationRefs])];
    for (const validationRef of validationRefs) {
      request.engine.coding.attachValidation({ ...recoveredAuthority, codingSessionId: session.codingSessionId, validationRef });
    }
    proof = request.engine.proof.finalize({
      jobId: request.handle.jobId,
      attemptId: request.handle.attemptId,
      generation: request.handle.generation,
      fenceToken: request.handle.fenceToken,
    });
    if (proof.verdict === 'verified') {
      mutation = request.engine.codingMutations.markVerified({
        ...recoveredAuthority,
        codingSessionId: session.codingSessionId,
        receiptId: mutation.receiptId,
        validationRefs: [...validationRefs, ...evidence.map((item) => item.evidenceId)],
        producer: PRODUCER,
      });
    }
  }

  const disposition = finalization(candidate, mutation, proof, session.codingSessionId);
  const existingContract = request.engine.getChildContract(request.handle.jobId);
  if (!existingContract?.resultAttemptId) {
    const recorded = request.engine.recordChildResult({
      childJobId: request.handle.jobId,
      attemptId: request.handle.attemptId,
      generation: request.handle.generation,
      fenceToken: request.handle.fenceToken,
      status: disposition.status === 'completed' ? 'completed'
        : disposition.status === 'cancelled' ? 'cancelled'
          : disposition.status === 'failed' ? 'failed' : 'blocked',
      evidence: disposition.evidence,
      evidenceHandles: request.engine.proof.listEvidence(request.handle.jobId).map((item) => item.evidenceId),
      producer: PRODUCER,
      idempotencyKey: `external-coding-recovery-result:${session.codingSessionId}`,
    });
    if (!recorded.applied && !recorded.duplicate) throw new Error('Recovered coding child result was rejected');
  }

  let promotion: ExternalCodingPromotionPlanRecord | null = null;
  if (disposition.status === 'completed') {
    const current = request.engine.coding.get(session.codingSessionId);
    if (current?.state !== 'ready_for_review') {
      request.engine.coding.transition({
        ...recoveredAuthority,
        codingSessionId: session.codingSessionId,
        to: 'ready_for_review',
        producer: PRODUCER,
        idempotencyKey: `session-state:${session.codingSessionId}:ready_for_review`,
      });
    }
    request.engine.codingWorkspaces.markState({
      ...recoveredAuthority,
      codingSessionId: session.codingSessionId,
      workspaceLeaseId: workspace.workspaceLeaseId,
      state: 'review_pending',
    });
    promotion = await request.engine.codingPromotions.prepareCandidate({
      ...recoveredAuthority,
      codingSessionId: session.codingSessionId,
      producer: PRODUCER,
    });
  }

  return {
    codingSessionId: session.codingSessionId,
    mutation,
    promotion,
    proof,
    validationRefs,
    providerRerun: false,
    finalization: disposition,
  };
}
