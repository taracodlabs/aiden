/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type {
  AttemptRecord,
  JobEventRecord,
  JobRecord,
} from '../daemon/jobEngine';
import type {
  ClaimRecord,
  EvidenceRecord,
  JobVerdictRecord,
} from '../daemon/jobProofAuthority';
import { operatorStatusMessage } from '../operatorStatusMessage';

export type WorkbenchProjectionStatus =
  | 'queued' | 'running' | 'waiting' | 'paused' | 'cancelling'
  | 'completed' | 'verified' | 'partially_verified' | 'failed' | 'cancelled'
  | 'unknown' | 'blocked';

export interface WorkbenchJobProjectionReader {
  getJob(jobId: string): JobRecord | null;
  getAttempt(attemptId: string): AttemptRecord | null;
  listAttempts(jobId: string): AttemptRecord[];
  listEvents(jobId: string, afterSequence?: number): JobEventRecord[];
  getChildContract?(childJobId: string): unknown | null;
  listChildContracts?(parentJobId: string): unknown[];
  listEffectsRequiringReconciliation?(jobId: string): unknown[];
  proof?: {
    listClaims(jobId: string): ClaimRecord[];
    listEvidence(jobId: string): EvidenceRecord[];
    getVerdict(jobId: string): JobVerdictRecord | null;
    exportJson(jobId: string): Record<string, unknown>;
  };
}

export interface WorkbenchIdentityProjection {
  jobId: string;
  rootJobId: string;
  attemptId: string;
  runId: number;
  generation: number;
  sessionId: string;
  workspaceId: string | null;
}

export interface WorkbenchResultReceipt {
  terminal: boolean;
  status: WorkbenchProjectionStatus;
  outcome: string | null;
  finishReason: string | null;
  verdict: JobVerdictRecord | null;
  summary: string;
}

export interface WorkbenchJobProjection {
  schemaVersion: 1;
  identity: WorkbenchIdentityProjection;
  job: JobRecord;
  activeAttempt: AttemptRecord;
  attempts: AttemptRecord[];
  timeline: JobEventRecord[];
  workers: unknown[];
  approvals: unknown[];
  effects: unknown[];
  claims: ClaimRecord[];
  evidence: EvidenceRecord[];
  verification: JobVerdictRecord | null;
  receipt: WorkbenchResultReceipt;
  eventCursor: number;
}

const TERMINAL_JOBS = new Set([
  'cancelled', 'completed', 'failed', 'dead_letter',
  'completed_unverified', 'verification_failed', 'abandoned',
]);

export function projectWorkbenchStatus(
  job: JobRecord,
  verdict: JobVerdictRecord | null,
  hasRequiredClaims = false,
): WorkbenchProjectionStatus {
  if (verdict?.verdict === 'verified') return 'verified';
  if (verdict?.verdict === 'partially_verified') return 'partially_verified';
  if (verdict?.verdict === 'failed') return 'failed';
  if (verdict?.verdict === 'cancelled') return 'cancelled';
  if (verdict?.verdict === 'unknown') return 'unknown';
  if (job.status === 'completed') return hasRequiredClaims ? 'unknown' : 'completed';
  if (job.status === 'completed_unverified' || job.status === 'abandoned') return 'unknown';
  if (job.status === 'failed' || job.status === 'dead_letter' || job.status === 'verification_failed') return 'failed';
  if (job.status === 'cancelled') return 'cancelled';
  if (job.status === 'blocked') return 'blocked';
  if (job.status === 'unknown') return 'unknown';
  if (job.status === 'crashed') return 'unknown';
  if (job.status === 'waiting') return 'waiting';
  if (job.status === 'paused') return 'paused';
  if (job.status === 'cancelling') return 'cancelling';
  if (job.status === 'queued') return 'queued';
  return 'running';
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function failureSummary(
  status: WorkbenchProjectionStatus,
  job: JobRecord,
  verdict: JobVerdictRecord | null,
  timeline: JobEventRecord[],
): string {
  if (!['failed', 'unknown', 'blocked'].includes(status)) {
    return verdict?.verdict ?? job.terminalOutcome ?? status;
  }
  for (const event of [...timeline].reverse()) {
    const payload = event.payload ?? {};
    const raw = payload.error ?? payload.invocationError ?? payload.reason ?? payload.lastError;
    if (typeof raw === 'string' && raw.trim()) return operatorStatusMessage(raw, status);
  }
  return operatorStatusMessage(job.finishReason, verdict?.verdict ?? status);
}

/** Build a read-only projection from existing durable authorities. */
export function projectWorkbenchJob(
  reader: WorkbenchJobProjectionReader,
  request: { jobId: string; attemptId?: string; runId?: number },
): WorkbenchJobProjection | null {
  const job = reader.getJob(request.jobId);
  if (!job) return null;
  const attemptId = request.attemptId ?? job.activeAttemptId;
  if (!attemptId) return null;
  const attempt = reader.getAttempt(attemptId);
  if (!attempt || attempt.jobId !== job.id) return null;
  if (request.runId !== undefined && attempt.rowId !== request.runId) return null;
  const timeline = reader.listEvents(job.id, 0).sort((a, b) => a.jobSequence - b.jobSequence);
  const proof = reader.proof;
  const claims = proof?.listClaims(job.id) ?? [];
  const evidence = proof?.listEvidence(job.id) ?? [];
  const verdict = proof?.getVerdict(job.id) ?? null;
  const exported = proof ? proof.exportJson(job.id) : {};
  const status = projectWorkbenchStatus(job, verdict, claims.some((claim) => claim.required));
  const terminal = TERMINAL_JOBS.has(job.status);
  return {
    schemaVersion: 1,
    identity: {
      jobId: job.id,
      rootJobId: job.rootJobId,
      attemptId: attempt.id,
      runId: attempt.rowId,
      generation: attempt.generation,
      sessionId: job.sessionId,
      workspaceId: job.workspaceId ?? null,
    },
    job,
    activeAttempt: attempt,
    attempts: reader.listAttempts(job.id),
    timeline,
    workers: reader.listChildContracts?.(job.id) ?? [],
    approvals: array(exported.approvals),
    effects: array(exported.effects),
    claims,
    evidence,
    verification: verdict,
    receipt: {
      terminal,
      status,
      outcome: job.terminalOutcome,
      finishReason: job.finishReason,
      verdict,
        summary: failureSummary(status, job, verdict, timeline),
    },
    eventCursor: timeline.length > 0 ? timeline[timeline.length - 1].jobSequence : 0,
  };
}
