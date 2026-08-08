/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { ContinuityCheckpointAuthority } from './continuityCheckpoint';
import type { Db } from './daemon/db/connection';
import type { JobEngine } from './daemon/jobEngine';
import type { TaskStore } from './daemon/taskStore';
import { buildResumePlan, type FileProbeResult, type ResumePlan } from './resumePlan';

export type SafeContinueDecision =
  | 'continued' | 'already_applied' | 'blocked_approval' | 'blocked_wait'
  | 'blocked_unknown_effect' | 'blocked_drift' | 'terminal' | 'invalid';

export interface SafeContinueResult {
  decision: SafeContinueDecision;
  checkpointId: string;
  jobId: string;
  priorAttemptId: string;
  attemptId?: string;
  generation?: number;
  runId?: number;
  reason: string;
  resumePlan?: ResumePlan;
  revalidation: {
    repositoryDrift: boolean;
    environmentDrift: boolean;
    unknownEffectIds: string[];
  };
}

export interface SafeContinueOptions {
  db: Db;
  checkpoints: ContinuityCheckpointAuthority;
  engine: JobEngine;
  taskStore: Pick<TaskStore, 'get'>;
  checkpointId: string;
  idempotencyKey: string;
  currentRepositoryFingerprint?: string | null;
  currentEnvironmentFingerprint?: string | null;
  fileProbe: (path: string) => FileProbeResult;
  /** Existing Job-control or recovery adapter. It must create a new Attempt. */
  resume: (input: {
    jobId: string;
    priorAttemptId: string;
    priorGeneration: number;
    preamble: string;
    idempotencyKey: string;
  }) => { attemptId: string; generation: number; runId: number };
  now?: number;
}

const actionId = (): string => `continue_${randomBytes(12).toString('hex')}`;
const actionKey = (value: string): string => createHash('sha256').update(value).digest('hex');
const MAX_CONTINUE_CONTEXT_CHARS = 16_000;
const boundedContext = (value: string): string => [...value].slice(0, MAX_CONTINUE_CONTEXT_CHARS).join('');

/** Continue from durable truth. This function never replays a transcript or an
 * uncertain effect; it only admits a fresh Attempt through the supplied existing
 * authority adapter after reconciliation and drift checks. */
export function continueFromCheckpoint(options: SafeContinueOptions): SafeContinueResult {
  const storedActionKey = actionKey(options.idempotencyKey);
  const existing = options.db.prepare(
    'SELECT result_json FROM continuity_actions WHERE checkpoint_id=? AND idempotency_key=?',
  ).get(options.checkpointId, storedActionKey) as { result_json: string } | undefined;
  if (existing) {
    const result = JSON.parse(existing.result_json) as SafeContinueResult;
    return { ...result, decision: result.decision === 'continued' ? 'already_applied' : result.decision };
  }

  const assessment = options.checkpoints.assess(options.checkpointId, {
    repositoryFingerprint: options.currentRepositoryFingerprint,
    environmentFingerprint: options.currentEnvironmentFingerprint,
  });
  const checkpoint = assessment.checkpoint;
  const job = options.engine.getJob(checkpoint.jobId);
  const attempt = options.engine.getAttempt(checkpoint.attemptId);
  if (!job || !attempt || attempt.jobId !== job.id || attempt.generation !== checkpoint.attemptGeneration) {
    throw new Error('Continuity checkpoint no longer identifies the durable Job and Attempt');
  }
  const { repositoryDrift, environmentDrift } = assessment;
  const effects = options.engine.listEffectsRequiringReconciliation(job.id);
  const unknownEffectIds = effects.map((effect) => effect.effectId);
  const base = {
    checkpointId: checkpoint.checkpointId,
    jobId: job.id,
    priorAttemptId: attempt.id,
    revalidation: { repositoryDrift, environmentDrift, unknownEffectIds },
  };

  const persist = (result: SafeContinueResult): SafeContinueResult => {
    const durableResult = { ...result, resumePlan: undefined };
    options.db.prepare(
      'INSERT INTO continuity_actions (action_id, checkpoint_id, idempotency_key, decision, result_json, created_at) VALUES (?,?,?,?,?,?)',
    ).run(actionId(), checkpoint.checkpointId, storedActionKey, result.decision, JSON.stringify(durableResult), options.now ?? Date.now());
    return result;
  };

  if (job.terminalAt !== null) {
    return persist({ ...base, decision: 'terminal', reason: `Job is already terminal: ${job.status}` });
  }
  if (job.status !== 'paused') {
    return persist({ ...base, decision: 'invalid', reason: `Job is ${job.status}; only paused work can continue safely` });
  }
  if (checkpoint.pendingApprovalIds.length > 0) {
    return persist({ ...base, decision: 'blocked_approval', reason: 'A pending approval must be resolved before continuing' });
  }
  if (checkpoint.pendingWaitIds.length > 0) {
    return persist({ ...base, decision: 'blocked_wait', reason: 'A durable wait must be resolved before continuing' });
  }
  if (unknownEffectIds.length > 0) {
    return persist({ ...base, decision: 'blocked_unknown_effect', reason: 'Unknown effects require reconciliation before continuing' });
  }
  const task = options.taskStore.get(job.id);
  if (!task) throw new Error('Durable Job card is unavailable for safe continuation');
  const resumePlan = buildResumePlan(task, { fileProbe: options.fileProbe });
  if (resumePlan.verdict !== 'resume') {
    return persist({ ...base, decision: 'blocked_drift', reason: resumePlan.reason, resumePlan });
  }
  const driftNotice = [
    repositoryDrift ? 'Repository fingerprint changed; all proposed work must be revalidated.' : '',
    environmentDrift ? 'Environment fingerprint changed; capabilities must be revalidated.' : '',
  ].filter(Boolean).join('\n');
  const resumed = options.resume({
    jobId: job.id,
    priorAttemptId: attempt.id,
    priorGeneration: attempt.generation,
    preamble: boundedContext([resumePlan.preamble, driftNotice].filter(Boolean).join('\n')),
    idempotencyKey: options.idempotencyKey,
  });
  if (resumed.attemptId === attempt.id || resumed.generation <= attempt.generation) {
    throw new Error('Safe continuation must create a new Attempt generation');
  }
  const authoritativeAttempt = options.engine.getAttempt(resumed.attemptId);
  const authoritativeJob = options.engine.getJob(job.id);
  if (
    !authoritativeAttempt
    || authoritativeAttempt.jobId !== job.id
    || authoritativeAttempt.generation !== resumed.generation
    || authoritativeAttempt.rowId !== resumed.runId
    || authoritativeJob?.activeAttemptId !== resumed.attemptId
  ) {
    throw new Error('Safe continuation adapter did not establish the claimed durable Attempt authority');
  }
  return persist({
    ...base,
    decision: 'continued',
    attemptId: resumed.attemptId,
    generation: resumed.generation,
    runId: resumed.runId,
    reason: repositoryDrift || environmentDrift ? 'Continued with drift revalidation' : 'Continued from durable checkpoint',
    resumePlan,
  });
}
