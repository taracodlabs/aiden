/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Db } from './db/connection';

export type JobStatus =
  | 'queued' | 'running' | 'waiting' | 'paused' | 'cancelling'
  | 'cancelled' | 'completed' | 'failed' | 'blocked' | 'unknown'
  | 'crashed' | 'recovering' | 'dead_letter';

export type AttemptStatus =
  | 'queued' | 'leased' | 'running' | 'waiting' | 'succeeded'
  | 'failed' | 'cancelled' | 'timed_out' | 'crashed' | 'unknown';

export type TransitionConflict =
  | 'not_found' | 'state_version' | 'illegal_transition' | 'terminal_state'
  | 'stale_fence' | 'lease_held' | 'lease_expired';

export interface JobRecord {
  id: string;
  status: string;
  stateVersion: number;
  activeAttemptId: string | null;
  rootJobId: string;
  parentJobId: string | null;
  sessionId: string;
  goal: string;
  entryPoint: string | null;
  source: string | null;
  terminalAt: number | null;
  terminalOutcome: string | null;
  finishReason: string | null;
  nextEventSequence: number;
}

export interface AttemptRecord {
  rowId: number;
  id: string;
  jobId: string | null;
  status: string;
  attemptNumber: number;
  generation: number;
  stateVersion: number;
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  leaseHeartbeatAt: number | null;
  fenceToken: string | null;
  recoveryOfAttemptId: string | null;
}

export interface JobEventRecord {
  eventId: number;
  jobSequence: number;
  jobId: string;
  attemptId: string | null;
  type: string;
  payload: Record<string, unknown> | null;
  producer: string | null;
  generation: number | null;
  idempotencyKey: string;
  createdAt: number;
}

export interface SubmitJobCommand {
  entryPoint: string;
  source: string;
  sessionId: string;
  workspaceId?: string | null;
  principalId?: string | null;
  instanceId: string;
  idempotencyNamespace: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
  goal: string;
  title?: string;
  channelId?: string | null;
  parentJobId?: string | null;
  rootJobId?: string | null;
  triggerEventId?: number | null;
}

export interface AdmissionResult {
  jobId: string;
  attemptId: string;
  runId: number;
  reused: boolean;
}

export interface TransitionResult {
  applied: boolean;
  stateVersion?: number;
  conflict?: TransitionConflict;
  duplicate?: boolean;
}

export interface LeaseResult extends TransitionResult {
  acquired: boolean;
  leaseId?: string;
  fenceToken?: string;
  generation?: number;
}

export interface JobEngine {
  submitJob(command: SubmitJobCommand): AdmissionResult;
  getJob(jobId: string): JobRecord | null;
  listJobs(filters?: {
    sessionId?: string;
    status?: string;
    rootJobId?: string;
    limit?: number;
  }): JobRecord[];
  getAttempt(attemptId: string): AttemptRecord | null;
  listAttempts(jobId: string): AttemptRecord[];
  listEvents(jobId: string, afterSequence?: number): JobEventRecord[];
  appendJobEvent(command: {
    jobId: string;
    attemptId: string;
    generation: number;
    type: string;
    payload?: Record<string, unknown> | null;
    producer: string;
    idempotencyKey: string;
    causationId?: string | null;
    correlationId?: string | null;
  }): { applied: boolean; duplicate: boolean; jobSequence?: number; conflict?: 'not_found' | 'stale_generation' };
  transitionJob(command: {
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    expectedStateVersion: number;
    to: JobStatus;
    eventIdempotencyKey: string;
    producer: string;
    finishReason?: string | null;
    terminalOutcome?: string | null;
    payload?: Record<string, unknown> | null;
    now?: number;
  }): TransitionResult;
  finalizeJob(command: {
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    expectedStateVersion: number;
    status: 'completed' | 'failed' | 'cancelled';
    outcome: string;
    finishReason: string;
    evidence: unknown;
    jobCard?: {
      filesTouched?: string[];
      sideEffects?: unknown[];
      failureState?: unknown | null;
      permissions?: Record<string, unknown> | null;
      constraints?: Record<string, unknown> | null;
    };
    eventIdempotencyKey: string;
    producer: string;
    now?: number;
  }): TransitionResult;
  cancelJob(command: {
    jobId: string;
    reason: string;
    producer: string;
    eventIdempotencyKey: string;
    now?: number;
  }): TransitionResult;
  pauseJob(command: {
    jobId: string;
    reason: string;
    producer: string;
    eventIdempotencyKey: string;
    now?: number;
  }): TransitionResult;
  resumeJob(command: {
    jobId: string;
    instanceId: string;
    triggerReason: string;
    producer: string;
    eventIdempotencyKey: string;
    now?: number;
  }): { attemptId: string; runId: number; attemptNumber: number; generation: number };
  transitionAttempt(command: {
    attemptId: string;
    expectedStateVersion: number;
    generation: number;
    fenceToken: string;
    to: AttemptStatus;
    eventIdempotencyKey: string;
    producer: string;
    finishReason?: string | null;
    payload?: Record<string, unknown> | null;
    now?: number;
  }): TransitionResult;
  claimAttempt(command: {
    attemptId: string;
    ownerId: string;
    ttlMs: number;
    now?: number;
  }): LeaseResult;
  renewAttemptLease(command: {
    attemptId: string;
    ownerId: string;
    generation: number;
    fenceToken: string;
    ttlMs: number;
    now?: number;
  }): TransitionResult;
  createRecoveryAttempt(command: {
    jobId: string;
    recoveryOfAttemptId: string;
    instanceId: string;
    triggerReason: string;
    eventIdempotencyKey: string;
    producer: string;
  }): { attemptId: string; runId: number; attemptNumber: number; generation: number };
  prepareToolCall(command: {
    toolCallId: string;
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    toolName: string;
    normalizedArgsDigest: string;
    riskTier: string;
    mutates: boolean;
    modelCallId?: string | null;
    producer: string;
    now?: number;
  }): TransitionResult;
  startToolCall(command: {
    toolCallId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    producer: string;
    now?: number;
  }): TransitionResult;
  completeToolCall(command: {
    toolCallId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    state: 'completed' | 'failed' | 'cancelled' | 'unknown';
    sideEffectState?: 'committed' | 'failed' | 'unknown';
    resultRef?: string | null;
    verificationRef?: string | null;
    producer: string;
    now?: number;
  }): TransitionResult;
  attachToolVerification(command: {
    toolCallId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    verificationRef: string;
    producer: string;
    now?: number;
  }): TransitionResult;
  recoverExpiredAttempts(command: {
    now?: number;
    instanceId: string;
    producer: string;
    maxCrashes: number;
  }): Array<{
    jobId: string;
    expiredAttemptId: string;
    recoveryAttemptId?: string;
    decision: 'retry' | 'ask_user' | 'dead_letter';
  }>;
}

export interface CreateJobEngineOptions {
  db: Db;
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(readonly namespace: string, readonly key: string) {
    super(`Idempotency key conflict in namespace ${namespace}`);
    this.name = 'IdempotencyConflictError';
  }
}

interface JobSqlRow {
  id: string;
  status: string;
  state_version: number;
  active_attempt_id: string | null;
  root_job_id: string | null;
  parent_task_id: string | null;
  session_id: string;
  goal: string;
  entry_point: string | null;
  source: string | null;
  terminal_at: number | null;
  terminal_outcome: string | null;
  finish_reason: string | null;
  next_event_sequence: number;
}

interface AttemptSqlRow {
  id: number;
  attempt_id: string;
  task_id: string | null;
  status: string;
  attempt_number: number;
  generation: number;
  state_version: number;
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  lease_heartbeat_at: number | null;
  fence_token: string | null;
  recovery_of_attempt_id: string | null;
  session_id: string;
}

interface ToolCallSqlRow {
  tool_call_id: string;
  job_id: string;
  attempt_id: string;
  generation: number;
  tool_name: string;
  normalized_args_digest: string;
  mutates: number;
  state: string;
  side_effect_id: string | null;
  verification_ref: string | null;
}

const JOB_TERMINAL = new Set<string>([
  'cancelled', 'completed', 'failed', 'dead_letter',
  'completed_unverified', 'verification_failed', 'abandoned',
]);

const ATTEMPT_TERMINAL = new Set<string>([
  'succeeded', 'completed', 'failed', 'cancelled', 'timed_out', 'crashed', 'unknown', 'interrupted',
]);

const JOB_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pending: new Set(['queued', 'running', 'cancelled', 'failed']),
  active: new Set(['running', 'waiting', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'blocked', 'unknown', 'crashed', 'pending_verification']),
  pending_verification: new Set(['completed', 'completed_unverified', 'verification_failed', 'failed', 'cancelled']),
  queued: new Set(['running', 'cancelling', 'cancelled', 'failed', 'blocked', 'crashed']),
  running: new Set(['waiting', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'blocked', 'unknown', 'crashed']),
  waiting: new Set(['running', 'paused', 'cancelling', 'cancelled', 'failed', 'blocked', 'unknown', 'crashed']),
  paused: new Set(['cancelling', 'cancelled', 'recovering']),
  cancelling: new Set(['cancelled', 'failed', 'unknown']),
  blocked: new Set(['recovering', 'cancelled', 'dead_letter']),
  unknown: new Set(['recovering', 'failed', 'dead_letter']),
  crashed: new Set(['recovering', 'failed', 'dead_letter']),
  recovering: new Set(['queued', 'running', 'blocked', 'failed', 'dead_letter']),
  interrupted: new Set(['recovering', 'failed', 'dead_letter']),
  blocked_needs_user: new Set(['recovering', 'cancelled', 'abandoned']),
};

const ATTEMPT_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  queued: new Set(['leased', 'cancelled', 'failed', 'crashed']),
  leased: new Set(['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out', 'crashed', 'unknown']),
  running: new Set(['waiting', 'succeeded', 'failed', 'cancelled', 'timed_out', 'crashed', 'unknown']),
  waiting: new Set(['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'crashed', 'unknown']),
};

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function fingerprintOf(command: SubmitJobCommand): string {
  if (command.requestFingerprint) return command.requestFingerprint;
  return createHash('sha256')
    .update(JSON.stringify({
      entryPoint: command.entryPoint,
      source: command.source,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId ?? null,
      principalId: command.principalId ?? null,
      goal: command.goal,
      parentJobId: command.parentJobId ?? null,
    }))
    .digest('hex');
}

function mapJob(row: JobSqlRow): JobRecord {
  return {
    id: row.id,
    status: row.status,
    stateVersion: row.state_version,
    activeAttemptId: row.active_attempt_id,
    rootJobId: row.root_job_id ?? row.id,
    parentJobId: row.parent_task_id,
    sessionId: row.session_id,
    goal: row.goal,
    entryPoint: row.entry_point,
    source: row.source,
    terminalAt: row.terminal_at,
    terminalOutcome: row.terminal_outcome,
    finishReason: row.finish_reason,
    nextEventSequence: row.next_event_sequence,
  };
}

function mapAttempt(row: AttemptSqlRow): AttemptRecord {
  return {
    rowId: row.id,
    id: row.attempt_id,
    jobId: row.task_id,
    status: row.status,
    attemptNumber: row.attempt_number,
    generation: row.generation,
    stateVersion: row.state_version,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    leaseHeartbeatAt: row.lease_heartbeat_at,
    fenceToken: row.fence_token,
    recoveryOfAttemptId: row.recovery_of_attempt_id,
  };
}

function isLegal(
  transitions: Readonly<Record<string, ReadonlySet<string>>>,
  from: string,
  to: string,
): boolean {
  return from === to || transitions[from]?.has(to) === true;
}

function parseArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createJobEngine(opts: CreateJobEngineOptions): JobEngine {
  const { db } = opts;

  const getJobRow = (jobId: string): JobSqlRow | undefined => db.prepare(
    `SELECT id, status, state_version, active_attempt_id, root_job_id,
            parent_task_id, session_id, goal, entry_point, source,
            terminal_at, terminal_outcome, finish_reason, next_event_sequence
       FROM tasks WHERE id = ?`,
  ).get(jobId) as JobSqlRow | undefined;

  const getAttemptRow = (attemptId: string): AttemptSqlRow | undefined => db.prepare(
    `SELECT id, attempt_id, task_id, status, attempt_number, generation,
            state_version, lease_id, lease_owner, lease_expires_at,
            lease_heartbeat_at, fence_token, recovery_of_attempt_id, session_id
       FROM runs WHERE attempt_id = ?`,
  ).get(attemptId) as AttemptSqlRow | undefined;

  const getToolCallRow = (toolCallId: string): ToolCallSqlRow | undefined => db.prepare(
    `SELECT tool_call_id, job_id, attempt_id, generation, tool_name,
            normalized_args_digest, mutates, state, side_effect_id, verification_ref
       FROM tool_calls WHERE tool_call_id = ?`,
  ).get(toolCallId) as ToolCallSqlRow | undefined;

  const activeFence = (
    attemptId: string,
    generation: number,
    fenceToken: string,
    now = Date.now(),
  ): AttemptSqlRow | null => {
    const attempt = getAttemptRow(attemptId);
    if (
      !attempt
      || !attempt.task_id
      || attempt.generation !== generation
      || attempt.fence_token !== fenceToken
      || ATTEMPT_TERMINAL.has(attempt.status)
      || attempt.lease_expires_at === null
      || attempt.lease_expires_at <= now
    ) return null;
    return attempt;
  };

  const existingEvent = (jobId: string, key: string): { id: number; job_sequence: number } | undefined => db.prepare(
    'SELECT id, job_sequence FROM run_events WHERE job_id = ? AND idempotency_key = ?',
  ).get(jobId, key) as { id: number; job_sequence: number } | undefined;

  const appendEvent = (event: {
    jobId: string;
    runId: number;
    attemptId: string | null;
    generation: number | null;
    type: string;
    payload?: Record<string, unknown> | null;
    producer: string;
    idempotencyKey: string;
    causationId?: string | null;
    correlationId?: string | null;
  }): { eventId: number; jobSequence: number; duplicate: boolean } => {
    const duplicate = existingEvent(event.jobId, event.idempotencyKey);
    if (duplicate) return { eventId: duplicate.id, jobSequence: duplicate.job_sequence, duplicate: true };

    const allocated = db.prepare(
      `UPDATE tasks
          SET next_event_sequence = next_event_sequence + 1
        WHERE id = ?
        RETURNING next_event_sequence - 1 AS job_sequence`,
    ).get(event.jobId) as { job_sequence: number } | undefined;
    if (!allocated) throw new Error(`Job not found: ${event.jobId}`);
    const jobSequence = allocated.job_sequence;
    const runSequence = db.prepare(
      `UPDATE runs
          SET next_event_sequence = next_event_sequence + 1
        WHERE id = ?
        RETURNING next_event_sequence - 1 AS run_sequence`,
    ).get(event.runId) as { run_sequence: number } | undefined;
    if (!runSequence) throw new Error(`Attempt row not found: ${event.runId}`);
    const now = Date.now();
    const payload = JSON.stringify(event.payload ?? null);
    const inserted = db.prepare(
      `INSERT INTO run_events (
         run_id, session_id, seq, ts, category, kind, name, payload,
         visibility, source, schema_version,
         job_id, attempt_id, job_sequence, producer, generation,
         causation_id, correlation_id, idempotency_key
       ) VALUES (
         ?, (SELECT session_id FROM runs WHERE id = ?), ?, ?, 'job', ?, ?, ?,
         'system', ?, 2,
         ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    ).run(
      event.runId,
      event.runId,
      runSequence.run_sequence,
      now,
      event.type,
      event.type,
      payload,
      event.producer,
      event.jobId,
      event.attemptId,
      jobSequence,
      event.producer,
      event.generation,
      event.causationId ?? null,
      event.correlationId ?? null,
      event.idempotencyKey,
    );
    return { eventId: Number(inserted.lastInsertRowid), jobSequence, duplicate: false };
  };

  const submitTx = db.transaction((command: SubmitJobCommand): AdmissionResult => {
    const key = command.idempotencyKey ?? randomId('internal');
    const fingerprint = fingerprintOf(command);
    const existing = db.prepare(
      `SELECT id, request_fingerprint, active_attempt_id
         FROM tasks
        WHERE idempotency_namespace = ? AND idempotency_key = ?`,
    ).get(command.idempotencyNamespace, key) as {
      id: string;
      request_fingerprint: string | null;
      active_attempt_id: string | null;
    } | undefined;
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new IdempotencyConflictError(command.idempotencyNamespace, key);
      }
      const attempt = existing.active_attempt_id ? getAttemptRow(existing.active_attempt_id) : undefined;
      if (!attempt) throw new Error(`Job ${existing.id} has no active Attempt`);
      return { jobId: existing.id, attemptId: attempt.attempt_id, runId: attempt.id, reused: true };
    }

    const now = Date.now();
    const jobId = randomId('task');
    const attemptId = randomId('attempt');
    const rootJobId = command.rootJobId ?? command.parentJobId ?? jobId;
    db.prepare(
      `INSERT INTO tasks (
         id, title, goal, status, created_at, updated_at,
         channel_id, session_id, parent_task_id, trace_ids, artifact_ids,
         state_version, active_attempt_id, root_job_id,
         idempotency_namespace, idempotency_key, request_fingerprint,
         entry_point, source, workspace_id, principal_id,
         recovery_state, crash_count, next_event_sequence
       ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, '[]', '[]',
                 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 0, 1)`,
    ).run(
      jobId,
      (command.title ?? command.goal).slice(0, 80),
      command.goal,
      now,
      now,
      command.channelId ?? null,
      command.sessionId,
      command.parentJobId ?? null,
      attemptId,
      rootJobId,
      command.idempotencyNamespace,
      key,
      fingerprint,
      command.entryPoint,
      command.source,
      command.workspaceId ?? null,
      command.principalId ?? null,
    );
    const inserted = db.prepare(
      `INSERT INTO runs (
         trigger_event_id, session_id, instance_id, status, started_at,
         resume_pending, task_id, attempt_id, attempt_number, generation,
         state_version, trigger_reason
       ) VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, 1, 1, 0, 'submission')`,
    ).run(
      command.triggerEventId ?? null,
      command.sessionId,
      command.instanceId,
      now,
      jobId,
      attemptId,
    );
    const runId = Number(inserted.lastInsertRowid);
    appendEvent({
      jobId, runId, attemptId, generation: 1,
      type: 'job.submitted', producer: command.source,
      idempotencyKey: `job-submitted:${jobId}`,
      payload: { entryPoint: command.entryPoint, source: command.source },
    });
    appendEvent({
      jobId, runId, attemptId, generation: 1,
      type: 'attempt.created', producer: command.source,
      idempotencyKey: `attempt-created:${attemptId}`,
      payload: { attemptNumber: 1, triggerReason: 'submission' },
    });
    return { jobId, attemptId, runId, reused: false };
  }).immediate;

  const appendJobEventTx = db.transaction((command: {
    jobId: string;
    attemptId: string;
    generation: number;
    type: string;
    payload?: Record<string, unknown> | null;
    producer: string;
    idempotencyKey: string;
    causationId?: string | null;
    correlationId?: string | null;
  }) => {
    const attempt = getAttemptRow(command.attemptId);
    if (!attempt || attempt.task_id !== command.jobId) {
      return { applied: false, duplicate: false, conflict: 'not_found' as const };
    }
    if (attempt.generation !== command.generation) {
      return { applied: false, duplicate: false, conflict: 'stale_generation' as const };
    }
    const appended = appendEvent({
      jobId: command.jobId,
      runId: attempt.id,
      attemptId: command.attemptId,
      generation: command.generation,
      type: command.type,
      payload: command.payload,
      producer: command.producer,
      idempotencyKey: command.idempotencyKey,
      causationId: command.causationId,
      correlationId: command.correlationId,
    });
    return {
      applied: !appended.duplicate,
      duplicate: appended.duplicate,
      jobSequence: appended.jobSequence,
    };
  }).immediate;

  const transitionJobTx = db.transaction((command: Parameters<JobEngine['transitionJob']>[0]): TransitionResult => {
    if (existingEvent(command.jobId, command.eventIdempotencyKey)) {
      return { applied: false, duplicate: true };
    }
    const job = getJobRow(command.jobId);
    if (!job) return { applied: false, conflict: 'not_found' };
    if (JOB_TERMINAL.has(job.status)) {
      return { applied: false, conflict: 'terminal_state', stateVersion: job.state_version };
    }
    if (!isLegal(JOB_TRANSITIONS, job.status, command.to)) {
      return { applied: false, conflict: 'illegal_transition', stateVersion: job.state_version };
    }
    const attempt = job.active_attempt_id ? getAttemptRow(job.active_attempt_id) : undefined;
    if (!attempt) return { applied: false, conflict: 'not_found' };
    if (
      attempt.attempt_id !== command.attemptId
      || attempt.generation !== command.generation
      || attempt.fence_token !== command.fenceToken
    ) {
      return { applied: false, conflict: 'stale_fence', stateVersion: job.state_version };
    }
    if (job.state_version !== command.expectedStateVersion) {
      return { applied: false, conflict: 'state_version', stateVersion: job.state_version };
    }
    if (
      !ATTEMPT_TERMINAL.has(attempt.status)
      && (attempt.lease_expires_at === null || attempt.lease_expires_at <= (command.now ?? Date.now()))
    ) {
      return { applied: false, conflict: 'lease_expired', stateVersion: job.state_version };
    }
    const nextVersion = job.state_version + 1;
    const terminal = JOB_TERMINAL.has(command.to);
    const changed = db.prepare(
      `UPDATE tasks
          SET status = ?, state_version = ?, updated_at = ?,
              terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END,
              terminal_outcome = COALESCE(?, terminal_outcome),
              finish_reason = COALESCE(?, finish_reason)
        WHERE id = ? AND state_version = ? AND active_attempt_id = ?`,
    ).run(
      command.to,
      nextVersion,
      command.now ?? Date.now(),
      terminal ? 1 : 0,
      terminal ? (command.now ?? Date.now()) : null,
      command.terminalOutcome ?? null,
      command.finishReason ?? null,
      command.jobId,
      command.expectedStateVersion,
      command.attemptId,
    );
    if (changed.changes !== 1) return { applied: false, conflict: 'stale_fence' };
    appendEvent({
      jobId: command.jobId,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: `job.${command.to}`,
      payload: command.payload,
      producer: command.producer,
      idempotencyKey: command.eventIdempotencyKey,
    });
    return { applied: true, stateVersion: nextVersion };
  }).immediate;

  const transitionAttemptTx = db.transaction((command: Parameters<JobEngine['transitionAttempt']>[0]): TransitionResult => {
    const attempt = getAttemptRow(command.attemptId);
    if (!attempt || !attempt.task_id) return { applied: false, conflict: 'not_found' };
    if (existingEvent(attempt.task_id, command.eventIdempotencyKey)) {
      return { applied: false, duplicate: true };
    }
    if (attempt.generation !== command.generation || attempt.fence_token !== command.fenceToken) {
      return { applied: false, conflict: 'stale_fence', stateVersion: attempt.state_version };
    }
    if (ATTEMPT_TERMINAL.has(attempt.status)) {
      return { applied: false, conflict: 'terminal_state', stateVersion: attempt.state_version };
    }
    if (attempt.lease_expires_at === null || attempt.lease_expires_at <= (command.now ?? Date.now())) {
      return { applied: false, conflict: 'lease_expired', stateVersion: attempt.state_version };
    }
    if (attempt.state_version !== command.expectedStateVersion) {
      return { applied: false, conflict: 'state_version', stateVersion: attempt.state_version };
    }
    if (!isLegal(ATTEMPT_TRANSITIONS, attempt.status, command.to)) {
      return { applied: false, conflict: 'illegal_transition', stateVersion: attempt.state_version };
    }
    const nextVersion = attempt.state_version + 1;
    const terminal = ATTEMPT_TERMINAL.has(command.to);
    const now = command.now ?? Date.now();
    const changed = db.prepare(
      `UPDATE runs
          SET status = ?, state_version = ?,
              finish_reason = COALESCE(?, finish_reason),
              completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
              ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
              lease_id = CASE WHEN ? THEN NULL ELSE lease_id END,
              lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
              lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
              lease_heartbeat_at = CASE WHEN ? THEN NULL ELSE lease_heartbeat_at END
        WHERE attempt_id = ? AND state_version = ? AND generation = ? AND fence_token = ?`,
    ).run(
      command.to,
      nextVersion,
      command.finishReason ?? null,
      terminal ? 1 : 0,
      terminal ? now : null,
      terminal ? 1 : 0,
      terminal ? now : null,
      terminal ? 1 : 0,
      terminal ? 1 : 0,
      terminal ? 1 : 0,
      terminal ? 1 : 0,
      command.attemptId,
      command.expectedStateVersion,
      command.generation,
      command.fenceToken,
    );
    if (changed.changes !== 1) return { applied: false, conflict: 'stale_fence' };
    appendEvent({
      jobId: attempt.task_id,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: `attempt.${command.to}`,
      payload: command.payload,
      producer: command.producer,
      idempotencyKey: command.eventIdempotencyKey,
    });
    return { applied: true, stateVersion: nextVersion };
  }).immediate;

  const finalizeJobTx = db.transaction((command: Parameters<JobEngine['finalizeJob']>[0]): TransitionResult => {
    if (existingEvent(command.jobId, command.eventIdempotencyKey)) {
      return { applied: false, duplicate: true };
    }
    const job = getJobRow(command.jobId);
    if (!job) return { applied: false, conflict: 'not_found' };
    if (JOB_TERMINAL.has(job.status)) {
      return { applied: false, conflict: 'terminal_state', stateVersion: job.state_version };
    }
    const attempt = job.active_attempt_id ? getAttemptRow(job.active_attempt_id) : undefined;
    if (!attempt) return { applied: false, conflict: 'not_found' };
    if (
      attempt.attempt_id !== command.attemptId
      || attempt.generation !== command.generation
      || attempt.fence_token !== command.fenceToken
    ) {
      return { applied: false, conflict: 'stale_fence', stateVersion: job.state_version };
    }
    if (job.state_version !== command.expectedStateVersion) {
      return { applied: false, conflict: 'state_version', stateVersion: job.state_version };
    }
    if (!isLegal(JOB_TRANSITIONS, job.status, command.status)) {
      return { applied: false, conflict: 'illegal_transition', stateVersion: job.state_version };
    }
    if (
      !ATTEMPT_TERMINAL.has(attempt.status)
      && (attempt.lease_expires_at === null || attempt.lease_expires_at <= (command.now ?? Date.now()))
    ) {
      return { applied: false, conflict: 'lease_expired', stateVersion: job.state_version };
    }
    const stored = db.prepare(
      `SELECT files_touched, side_effects, failure_state, permissions, constraints
         FROM tasks WHERE id = ?`,
    ).get(command.jobId) as {
      files_touched: string;
      side_effects: string;
      failure_state: string | null;
      permissions: string | null;
      constraints: string | null;
    };
    const files = parseArray(stored.files_touched).filter((value): value is string => typeof value === 'string');
    for (const file of command.jobCard?.filesTouched ?? []) {
      if (!files.includes(file)) files.push(file);
    }
    const sideEffects = parseArray(stored.side_effects);
    const sideEffectKeys = new Set(sideEffects.map((value) => JSON.stringify(value)));
    for (const effect of command.jobCard?.sideEffects ?? []) {
      const key = JSON.stringify(effect);
      if (!sideEffectKeys.has(key)) {
        sideEffects.push(effect);
        sideEffectKeys.add(key);
      }
    }
    const serializeReplacement = (value: unknown | undefined, current: string | null): string | null => {
      if (value === undefined) return current;
      return value === null ? null : JSON.stringify(value);
    };
    const toolCallIds = (db.prepare(
      `SELECT tool_call_id FROM tool_calls
        WHERE job_id = ? AND attempt_id = ? AND generation = ?
        ORDER BY created_at, tool_call_id`,
    ).all(command.jobId, command.attemptId, command.generation) as Array<{ tool_call_id: string }>)
      .map((row) => row.tool_call_id);
    const evidenceRecord = command.evidence && typeof command.evidence === 'object' && !Array.isArray(command.evidence)
      ? { ...(command.evidence as Record<string, unknown>) }
      : { value: command.evidence };
    const linkedEvidence = {
      ...evidenceRecord,
      durableExecution: {
        jobId: command.jobId,
        attemptId: command.attemptId,
        generation: command.generation,
        toolCallIds,
      },
    };
    const nextVersion = job.state_version + 1;
    const now = command.now ?? Date.now();
    const changed = db.prepare(
      `UPDATE tasks
          SET status = ?, state_version = ?, evidence = ?,
              files_touched = ?, side_effects = ?,
              failure_state = ?, permissions = ?, constraints = ?,
              terminal_at = ?, terminal_outcome = ?, finish_reason = ?,
              active_attempt_id = NULL,
              updated_at = ?
        WHERE id = ? AND state_version = ? AND active_attempt_id = ?`,
    ).run(
      command.status,
      nextVersion,
      JSON.stringify(linkedEvidence),
      JSON.stringify(files),
      JSON.stringify(sideEffects),
      serializeReplacement(command.jobCard?.failureState, stored.failure_state),
      serializeReplacement(command.jobCard?.permissions, stored.permissions),
      serializeReplacement(command.jobCard?.constraints, stored.constraints),
      now,
      command.outcome,
      command.finishReason,
      now,
      command.jobId,
      command.expectedStateVersion,
      command.attemptId,
    );
    if (changed.changes !== 1) return { applied: false, conflict: 'stale_fence' };
    appendEvent({
      jobId: command.jobId,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: 'job.finalized',
      payload: { status: command.status, outcome: command.outcome, finishReason: command.finishReason },
      producer: command.producer,
      idempotencyKey: command.eventIdempotencyKey,
    });
    return { applied: true, stateVersion: nextVersion };
  }).immediate;

  const cancelJobTx = db.transaction((command: Parameters<JobEngine['cancelJob']>[0]): TransitionResult => {
    if (existingEvent(command.jobId, command.eventIdempotencyKey)) {
      return { applied: false, duplicate: true };
    }
    const job = getJobRow(command.jobId);
    if (!job) return { applied: false, conflict: 'not_found' };
    if (JOB_TERMINAL.has(job.status)) {
      return { applied: false, conflict: 'terminal_state', stateVersion: job.state_version };
    }
    const attempt = job.active_attempt_id ? getAttemptRow(job.active_attempt_id) : undefined;
    if (!attempt) return { applied: false, conflict: 'not_found' };
    const now = command.now ?? Date.now();
    if (!ATTEMPT_TERMINAL.has(attempt.status)) {
      const attemptChanged = db.prepare(
        `UPDATE runs
            SET status = 'cancelled', state_version = state_version + 1,
                finish_reason = ?, completed_at = ?, ended_at = ?,
                lease_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
                lease_heartbeat_at = NULL
          WHERE attempt_id = ? AND state_version = ? AND generation = ?`,
      ).run(command.reason, now, now, attempt.attempt_id, attempt.state_version, attempt.generation);
      if (attemptChanged.changes !== 1) return { applied: false, conflict: 'state_version' };
      appendEvent({
        jobId: job.id,
        runId: attempt.id,
        attemptId: attempt.attempt_id,
        generation: attempt.generation,
        type: 'attempt.cancelled',
        payload: { reason: command.reason },
        producer: command.producer,
        idempotencyKey: `${command.eventIdempotencyKey}:attempt`,
      });
    }
    const nextVersion = job.state_version + 1;
    const jobChanged = db.prepare(
      `UPDATE tasks
          SET status = 'cancelled', state_version = ?, active_attempt_id = NULL,
              terminal_at = ?, terminal_outcome = 'cancelled', finish_reason = ?,
              updated_at = ?
        WHERE id = ? AND state_version = ? AND active_attempt_id = ?`,
    ).run(nextVersion, now, command.reason, now, job.id, job.state_version, attempt.attempt_id);
    if (jobChanged.changes !== 1) return { applied: false, conflict: 'state_version' };
    appendEvent({
      jobId: job.id,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: 'job.cancelled',
      payload: { reason: command.reason },
      producer: command.producer,
      idempotencyKey: command.eventIdempotencyKey,
    });
    return { applied: true, stateVersion: nextVersion };
  }).immediate;

  const pauseJobTx = db.transaction((command: Parameters<JobEngine['pauseJob']>[0]): TransitionResult => {
    if (existingEvent(command.jobId, command.eventIdempotencyKey)) {
      return { applied: false, duplicate: true };
    }
    const job = getJobRow(command.jobId);
    if (!job) return { applied: false, conflict: 'not_found' };
    if (JOB_TERMINAL.has(job.status)) return { applied: false, conflict: 'terminal_state' };
    if (job.status === 'paused') return { applied: false, duplicate: true, stateVersion: job.state_version };
    const attempt = job.active_attempt_id ? getAttemptRow(job.active_attempt_id) : undefined;
    if (!attempt || ATTEMPT_TERMINAL.has(attempt.status)) return { applied: false, conflict: 'not_found' };
    const now = command.now ?? Date.now();
    const attemptVersion = attempt.state_version + 1;
    const attemptChanged = db.prepare(
      `UPDATE runs
          SET status = 'waiting', state_version = ?, finish_reason = ?,
              lease_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
              lease_heartbeat_at = NULL, fence_token = NULL
        WHERE attempt_id = ? AND state_version = ? AND generation = ?`,
    ).run(attemptVersion, command.reason, attempt.attempt_id, attempt.state_version, attempt.generation);
    if (attemptChanged.changes !== 1) return { applied: false, conflict: 'state_version' };
    appendEvent({
      jobId: job.id,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: 'attempt.paused',
      payload: { reason: command.reason },
      producer: command.producer,
      idempotencyKey: `${command.eventIdempotencyKey}:attempt`,
    });
    const nextVersion = job.state_version + 1;
    const jobChanged = db.prepare(
      `UPDATE tasks SET status = 'paused', state_version = ?, finish_reason = ?, updated_at = ?
        WHERE id = ? AND state_version = ? AND active_attempt_id = ?`,
    ).run(nextVersion, command.reason, now, job.id, job.state_version, attempt.attempt_id);
    if (jobChanged.changes !== 1) return { applied: false, conflict: 'state_version' };
    appendEvent({
      jobId: job.id,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: 'job.paused',
      payload: { reason: command.reason },
      producer: command.producer,
      idempotencyKey: command.eventIdempotencyKey,
    });
    return { applied: true, stateVersion: nextVersion };
  }).immediate;

  const resumeJobTx = db.transaction((command: Parameters<JobEngine['resumeJob']>[0]) => {
    const job = getJobRow(command.jobId);
    if (!job) throw new Error('Resume Job not found');
    if (JOB_TERMINAL.has(job.status)) throw new Error('Cannot resume a terminal Job');
    if (job.status !== 'paused') throw new Error('Resume requires a paused Job');
    const previous = job.active_attempt_id ? getAttemptRow(job.active_attempt_id) : undefined;
    if (!previous) throw new Error('Paused Job has no active Attempt');
    const now = command.now ?? Date.now();
    const previousChanged = db.prepare(
      `UPDATE runs
          SET status = 'cancelled', state_version = state_version + 1,
              finish_reason = 'superseded by resume', completed_at = ?, ended_at = ?
        WHERE attempt_id = ? AND generation = ? AND status = 'waiting'`,
    ).run(now, now, previous.attempt_id, previous.generation);
    if (previousChanged.changes !== 1) throw new Error('Paused Attempt changed concurrently');
    appendEvent({
      jobId: job.id,
      runId: previous.id,
      attemptId: previous.attempt_id,
      generation: previous.generation,
      type: 'attempt.cancelled',
      payload: { reason: 'superseded by resume' },
      producer: command.producer,
      idempotencyKey: `${command.eventIdempotencyKey}:previous`,
    });
    const max = db.prepare(
      'SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number, COALESCE(MAX(generation), 0) AS generation FROM runs WHERE task_id = ?',
    ).get(job.id) as { attempt_number: number; generation: number };
    const attemptNumber = max.attempt_number + 1;
    const generation = max.generation + 1;
    const attemptId = randomId('attempt');
    const inserted = db.prepare(
      `INSERT INTO runs (
         session_id, instance_id, status, started_at, resume_pending,
         task_id, attempt_id, attempt_number, generation, state_version,
         recovery_of_attempt_id, trigger_reason
       ) VALUES (?, ?, 'queued', ?, 0, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      previous.session_id,
      command.instanceId,
      now,
      job.id,
      attemptId,
      attemptNumber,
      generation,
      previous.attempt_id,
      command.triggerReason,
    );
    const jobChanged = db.prepare(
      `UPDATE tasks
          SET status = 'queued', state_version = state_version + 1,
              active_attempt_id = ?, finish_reason = NULL, updated_at = ?
        WHERE id = ? AND state_version = ? AND status = 'paused'`,
    ).run(attemptId, now, job.id, job.state_version);
    if (jobChanged.changes !== 1) throw new Error('Paused Job changed concurrently');
    const runId = Number(inserted.lastInsertRowid);
    appendEvent({
      jobId: job.id,
      runId,
      attemptId,
      generation,
      type: 'job.resumed',
      payload: { previousAttemptId: previous.attempt_id },
      producer: command.producer,
      idempotencyKey: command.eventIdempotencyKey,
    });
    appendEvent({
      jobId: job.id,
      runId,
      attemptId,
      generation,
      type: 'attempt.created',
      payload: { attemptNumber, recoveryOfAttemptId: previous.attempt_id, triggerReason: command.triggerReason },
      producer: command.producer,
      idempotencyKey: `${command.eventIdempotencyKey}:attempt`,
    });
    return { attemptId, runId, attemptNumber, generation };
  }).immediate;

  const claimAttemptTx = db.transaction((command: Parameters<JobEngine['claimAttempt']>[0]): LeaseResult => {
    const attempt = getAttemptRow(command.attemptId);
    if (!attempt || !attempt.task_id) return { acquired: false, applied: false, conflict: 'not_found' };
    if (ATTEMPT_TERMINAL.has(attempt.status)) {
      return { acquired: false, applied: false, conflict: 'terminal_state', stateVersion: attempt.state_version };
    }
    const now = command.now ?? Date.now();
    if (attempt.lease_id && attempt.lease_expires_at !== null && attempt.lease_expires_at > now) {
      return { acquired: false, applied: false, conflict: 'lease_held', stateVersion: attempt.state_version };
    }
    if (attempt.lease_id) {
      return { acquired: false, applied: false, conflict: 'lease_expired', stateVersion: attempt.state_version };
    }
    const generation = attempt.generation;
    const leaseId = randomId('lease');
    const fenceToken = randomId('fence');
    const nextVersion = attempt.state_version + 1;
    const changed = db.prepare(
      `UPDATE runs
          SET status = 'leased', generation = ?, state_version = ?,
              lease_id = ?, lease_owner = ?, lease_expires_at = ?,
              lease_heartbeat_at = ?, fence_token = ?
        WHERE attempt_id = ? AND state_version = ?
          AND lease_id IS NULL`,
    ).run(
      generation,
      nextVersion,
      leaseId,
      command.ownerId,
      now + Math.max(1, command.ttlMs),
      now,
      fenceToken,
      command.attemptId,
      attempt.state_version,
    );
    if (changed.changes !== 1) return { acquired: false, applied: false, conflict: 'lease_held' };
    appendEvent({
      jobId: attempt.task_id,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation,
      type: 'attempt.leased',
      payload: { ownerId: command.ownerId, expiresAt: now + Math.max(1, command.ttlMs) },
      producer: command.ownerId,
      idempotencyKey: `lease-claimed:${leaseId}`,
    });
    return {
      acquired: true,
      applied: true,
      leaseId,
      fenceToken,
      generation,
      stateVersion: nextVersion,
    };
  }).immediate;

  const renewAttemptTx = db.transaction((command: Parameters<JobEngine['renewAttemptLease']>[0]): TransitionResult => {
    const attempt = getAttemptRow(command.attemptId);
    if (!attempt || !attempt.task_id) return { applied: false, conflict: 'not_found' };
    const now = command.now ?? Date.now();
    if (
      attempt.generation !== command.generation
      || attempt.fence_token !== command.fenceToken
      || attempt.lease_owner !== command.ownerId
    ) return { applied: false, conflict: 'stale_fence', stateVersion: attempt.state_version };
    if (attempt.lease_expires_at !== null && attempt.lease_expires_at <= now) {
      return { applied: false, conflict: 'lease_expired', stateVersion: attempt.state_version };
    }
    const nextVersion = attempt.state_version + 1;
    const changed = db.prepare(
      `UPDATE runs
          SET lease_expires_at = ?, lease_heartbeat_at = ?, state_version = ?
        WHERE attempt_id = ? AND generation = ? AND fence_token = ?
          AND lease_owner = ? AND state_version = ? AND lease_expires_at > ?`,
    ).run(
      now + Math.max(1, command.ttlMs),
      now,
      nextVersion,
      command.attemptId,
      command.generation,
      command.fenceToken,
      command.ownerId,
      attempt.state_version,
      now,
    );
    if (changed.changes !== 1) return { applied: false, conflict: 'stale_fence' };
    appendEvent({
      jobId: attempt.task_id,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: 'attempt.lease_renewed',
      payload: { expiresAt: now + Math.max(1, command.ttlMs) },
      producer: command.ownerId,
      idempotencyKey: `lease-renewed:${attempt.lease_id}:${nextVersion}`,
    });
    return { applied: true, stateVersion: nextVersion };
  }).immediate;

  const recoveryTx = db.transaction((command: Parameters<JobEngine['createRecoveryAttempt']>[0]) => {
    const job = getJobRow(command.jobId);
    const previous = getAttemptRow(command.recoveryOfAttemptId);
    if (!job || !previous || previous.task_id !== command.jobId) {
      throw new Error('Recovery Job or Attempt not found');
    }
    if (!ATTEMPT_TERMINAL.has(previous.status)) {
      throw new Error('Recovery requires a terminal Attempt');
    }
    const max = db.prepare(
      'SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number, COALESCE(MAX(generation), 0) AS generation FROM runs WHERE task_id = ?',
    ).get(command.jobId) as { attempt_number: number; generation: number };
    const attemptNumber = max.attempt_number + 1;
    const generation = max.generation + 1;
    const attemptId = randomId('attempt');
    const now = Date.now();
    const inserted = db.prepare(
      `INSERT INTO runs (
         session_id, instance_id, status, started_at, resume_pending,
         task_id, attempt_id, attempt_number, generation, state_version,
         recovery_of_attempt_id, trigger_reason
       ) VALUES (?, ?, 'queued', ?, 0, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      previous.session_id,
      command.instanceId,
      now,
      command.jobId,
      attemptId,
      attemptNumber,
      generation,
      command.recoveryOfAttemptId,
      command.triggerReason,
    );
    const jobChanged = db.prepare(
      `UPDATE tasks
          SET status = 'recovering', state_version = state_version + 1,
              active_attempt_id = ?, recovery_state = 'recovering',
              terminal_at = NULL, terminal_outcome = NULL, finish_reason = NULL,
              updated_at = ?
        WHERE id = ? AND state_version = ?`,
    ).run(attemptId, now, command.jobId, job.state_version);
    if (jobChanged.changes !== 1) throw new Error('Recovery Job changed concurrently');
    const runId = Number(inserted.lastInsertRowid);
    appendEvent({
      jobId: command.jobId,
      runId,
      attemptId,
      generation,
      type: 'job.recovering',
      payload: { recoveryOfAttemptId: command.recoveryOfAttemptId, triggerReason: command.triggerReason },
      producer: command.producer,
      idempotencyKey: `job-recovering:${attemptId}`,
    });
    appendEvent({
      jobId: command.jobId,
      runId,
      attemptId,
      generation,
      type: 'attempt.created',
      payload: { attemptNumber, recoveryOfAttemptId: command.recoveryOfAttemptId, triggerReason: command.triggerReason },
      producer: command.producer,
      idempotencyKey: command.eventIdempotencyKey,
    });
    return { attemptId, runId, attemptNumber, generation };
  }).immediate;

  const prepareToolCallTx = db.transaction((command: Parameters<JobEngine['prepareToolCall']>[0]): TransitionResult => {
    const attempt = activeFence(command.attemptId, command.generation, command.fenceToken, command.now);
    if (!attempt || attempt.task_id !== command.jobId) {
      return { applied: false, conflict: 'stale_fence' };
    }
    const existing = getToolCallRow(command.toolCallId);
    if (existing) {
      const sameIdentity = existing.job_id === command.jobId
        && existing.attempt_id === command.attemptId
        && existing.generation === command.generation
        && existing.tool_name === command.toolName
        && existing.normalized_args_digest === command.normalizedArgsDigest;
      return sameIdentity
        ? { applied: false, duplicate: true }
        : { applied: false, conflict: 'illegal_transition' };
    }

    const now = Date.now();
    const sideEffectId = command.mutates ? `side_effect:${command.toolCallId}` : null;
    db.prepare(
      `INSERT INTO tool_calls (
         tool_call_id, job_id, attempt_id, generation, model_call_id,
         tool_name, normalized_args_digest, risk_tier, mutates, state,
         side_effect_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`,
    ).run(
      command.toolCallId,
      command.jobId,
      command.attemptId,
      command.generation,
      command.modelCallId ?? null,
      command.toolName,
      command.normalizedArgsDigest,
      command.riskTier,
      command.mutates ? 1 : 0,
      sideEffectId,
      now,
      now,
    );
    if (sideEffectId) {
      const ordinal = db.prepare(
        'SELECT COUNT(*) + 1 AS ordinal FROM side_effect_ledger WHERE job_id = ?',
      ).get(command.jobId) as { ordinal: number };
      db.prepare(
        `INSERT INTO side_effect_ledger (
           key, task_id, step, tool, args_hash, status, attempted_at,
           job_id, attempt_id, generation, tool_call_id, effect_state
         ) VALUES (?, ?, ?, ?, ?, 'attempting', ?, ?, ?, ?, ?, 'prepared')`,
      ).run(
        sideEffectId,
        command.jobId,
        ordinal.ordinal,
        command.toolName,
        command.normalizedArgsDigest,
        now,
        command.jobId,
        command.attemptId,
        command.generation,
        command.toolCallId,
      );
    }
    appendEvent({
      jobId: command.jobId,
      runId: attempt.id,
      attemptId: command.attemptId,
      generation: command.generation,
      type: 'tool_call.prepared',
      payload: { toolCallId: command.toolCallId, toolName: command.toolName, mutates: command.mutates },
      producer: command.producer,
      idempotencyKey: `tool-call-prepared:${command.toolCallId}`,
    });
    return { applied: true };
  }).immediate;

  const startToolCallTx = db.transaction((command: Parameters<JobEngine['startToolCall']>[0]): TransitionResult => {
    const attempt = activeFence(command.attemptId, command.generation, command.fenceToken, command.now);
    const toolCall = getToolCallRow(command.toolCallId);
    if (!attempt || !toolCall || toolCall.attempt_id !== command.attemptId || toolCall.generation !== command.generation) {
      return { applied: false, conflict: 'stale_fence' };
    }
    if (toolCall.state === 'started') return { applied: false, duplicate: true };
    if (toolCall.state !== 'prepared') return { applied: false, conflict: 'illegal_transition' };
    const now = Date.now();
    const changed = db.prepare(
      `UPDATE tool_calls SET state = 'started', started_at = ?, updated_at = ?
        WHERE tool_call_id = ? AND state = 'prepared' AND generation = ?`,
    ).run(now, now, command.toolCallId, command.generation);
    if (changed.changes !== 1) return { applied: false, conflict: 'illegal_transition' };
    if (toolCall.side_effect_id) {
      db.prepare(
        `UPDATE side_effect_ledger SET effect_state = 'started'
          WHERE key = ? AND attempt_id = ? AND generation = ? AND effect_state = 'prepared'`,
      ).run(toolCall.side_effect_id, command.attemptId, command.generation);
    }
    appendEvent({
      jobId: toolCall.job_id,
      runId: attempt.id,
      attemptId: command.attemptId,
      generation: command.generation,
      type: 'tool_call.started',
      payload: { toolCallId: command.toolCallId },
      producer: command.producer,
      idempotencyKey: `tool-call-started:${command.toolCallId}`,
    });
    return { applied: true };
  }).immediate;

  const completeToolCallTx = db.transaction((command: Parameters<JobEngine['completeToolCall']>[0]): TransitionResult => {
    const attempt = activeFence(command.attemptId, command.generation, command.fenceToken, command.now);
    const toolCall = getToolCallRow(command.toolCallId);
    if (!attempt || !toolCall || toolCall.attempt_id !== command.attemptId || toolCall.generation !== command.generation) {
      return { applied: false, conflict: 'stale_fence' };
    }
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(toolCall.state)) {
      return toolCall.state === command.state
        ? { applied: false, duplicate: true }
        : { applied: false, conflict: 'terminal_state' };
    }
    if (toolCall.state !== 'started') return { applied: false, conflict: 'illegal_transition' };
    const now = Date.now();
    const changed = db.prepare(
      `UPDATE tool_calls
          SET state = ?, ended_at = ?, result_ref = ?, verification_ref = ?, updated_at = ?
        WHERE tool_call_id = ? AND state = 'started' AND generation = ?`,
    ).run(
      command.state,
      now,
      command.resultRef ?? null,
      command.verificationRef ?? null,
      now,
      command.toolCallId,
      command.generation,
    );
    if (changed.changes !== 1) return { applied: false, conflict: 'illegal_transition' };
    if (toolCall.side_effect_id) {
      const sideEffectState = command.sideEffectState ?? (command.state === 'completed' ? 'committed' : 'unknown');
      db.prepare(
        `UPDATE side_effect_ledger
            SET effect_state = ?, status = ?, confirmed_at = CASE WHEN ? = 'committed' THEN ? ELSE confirmed_at END
          WHERE key = ? AND attempt_id = ? AND generation = ? AND effect_state = 'started'`,
      ).run(
        sideEffectState,
        sideEffectState === 'committed' ? 'confirmed' : sideEffectState,
        sideEffectState,
        now,
        toolCall.side_effect_id,
        command.attemptId,
        command.generation,
      );
    }
    appendEvent({
      jobId: toolCall.job_id,
      runId: attempt.id,
      attemptId: command.attemptId,
      generation: command.generation,
      type: `tool_call.${command.state}`,
      payload: { toolCallId: command.toolCallId, sideEffectState: command.sideEffectState ?? null },
      producer: command.producer,
      idempotencyKey: `tool-call-${command.state}:${command.toolCallId}`,
    });
    return { applied: true };
  }).immediate;

  const attachToolVerificationTx = db.transaction((
    command: Parameters<JobEngine['attachToolVerification']>[0],
  ): TransitionResult => {
    const attempt = activeFence(command.attemptId, command.generation, command.fenceToken, command.now);
    const toolCall = getToolCallRow(command.toolCallId);
    if (!attempt || !toolCall || toolCall.attempt_id !== command.attemptId || toolCall.generation !== command.generation) {
      return { applied: false, conflict: 'stale_fence' };
    }
    if (!['completed', 'failed', 'cancelled', 'unknown'].includes(toolCall.state)) {
      return { applied: false, conflict: 'illegal_transition' };
    }
    if (toolCall.verification_ref === command.verificationRef) return { applied: false, duplicate: true };
    if (toolCall.verification_ref) return { applied: false, conflict: 'terminal_state' };
    const now = command.now ?? Date.now();
    const changed = db.prepare(
      `UPDATE tool_calls SET verification_ref = ?, updated_at = ?
        WHERE tool_call_id = ? AND attempt_id = ? AND generation = ? AND verification_ref IS NULL`,
    ).run(
      command.verificationRef,
      now,
      command.toolCallId,
      command.attemptId,
      command.generation,
    );
    if (changed.changes !== 1) return { applied: false, conflict: 'stale_fence' };
    appendEvent({
      jobId: toolCall.job_id,
      runId: attempt.id,
      attemptId: command.attemptId,
      generation: command.generation,
      type: 'tool_call.verification_linked',
      payload: { toolCallId: command.toolCallId, verificationRef: command.verificationRef },
      producer: command.producer,
      idempotencyKey: `tool-call-verification:${command.toolCallId}`,
    });
    return { applied: true };
  }).immediate;

  const recoverExpiredAttemptTx = db.transaction((command: {
    attemptId: string;
    now: number;
    instanceId: string;
    producer: string;
    maxCrashes: number;
  }): {
    jobId: string;
    expiredAttemptId: string;
    recoveryAttemptId?: string;
    decision: 'retry' | 'ask_user' | 'dead_letter';
  } | null => {
    const attempt = getAttemptRow(command.attemptId);
    if (
      !attempt
      || !attempt.task_id
      || ATTEMPT_TERMINAL.has(attempt.status)
      || attempt.lease_expires_at === null
      || attempt.lease_expires_at > command.now
    ) return null;
    const job = getJobRow(attempt.task_id);
    if (!job || job.active_attempt_id !== attempt.attempt_id || JOB_TERMINAL.has(job.status)) return null;

    const ambiguous = db.prepare(
      `SELECT 1
         FROM tool_calls tc
         LEFT JOIN side_effect_ledger se ON se.tool_call_id = tc.tool_call_id
        WHERE tc.attempt_id = ? AND tc.generation = ? AND tc.mutates = 1
          AND (tc.state = 'started' OR se.effect_state IN ('started', 'committed', 'partial', 'unknown'))
        LIMIT 1`,
    ).get(attempt.attempt_id, attempt.generation) !== undefined;
    const crashRow = db.prepare('SELECT crash_count FROM tasks WHERE id = ?').get(job.id) as { crash_count: number };
    const crashCount = crashRow.crash_count + 1;
    const decision: 'retry' | 'ask_user' | 'dead_letter' = ambiguous
      ? 'ask_user'
      : crashCount >= Math.max(1, command.maxCrashes) ? 'dead_letter' : 'retry';
    const attemptStatus = ambiguous ? 'unknown' : 'crashed';
    const attemptVersion = attempt.state_version + 1;
    const cleared = db.prepare(
      `UPDATE runs
          SET status = ?, state_version = ?, finish_reason = ?,
              completed_at = ?, ended_at = ?,
              lease_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
              lease_heartbeat_at = NULL
        WHERE attempt_id = ? AND state_version = ? AND generation = ?
          AND fence_token = ? AND lease_expires_at <= ?`,
    ).run(
      attemptStatus,
      attemptVersion,
      ambiguous ? 'unknown_side_effect' : 'lease_expired',
      command.now,
      command.now,
      attempt.attempt_id,
      attempt.state_version,
      attempt.generation,
      attempt.fence_token,
      command.now,
    );
    if (cleared.changes !== 1) return null;
    appendEvent({
      jobId: job.id,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: `attempt.${attemptStatus}`,
      payload: { reason: ambiguous ? 'unknown_side_effect' : 'lease_expired' },
      producer: command.producer,
      idempotencyKey: `attempt-recovered:${attempt.attempt_id}:${attempt.generation}`,
    });

    if (decision !== 'retry') {
      const jobStatus = decision === 'ask_user' ? 'blocked' : 'dead_letter';
      const jobChanged = db.prepare(
        `UPDATE tasks
            SET status = ?, state_version = state_version + 1,
                active_attempt_id = NULL, crash_count = ?, recovery_state = ?,
                finish_reason = ?, terminal_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE terminal_at END,
                terminal_outcome = CASE WHEN ? = 'dead_letter' THEN 'dead_letter' ELSE terminal_outcome END,
                updated_at = ?
          WHERE id = ? AND state_version = ?`,
      ).run(
        jobStatus,
        crashCount,
        decision === 'ask_user' ? 'user_required' : 'dead_letter',
        ambiguous ? 'unknown_side_effect' : 'crash_loop',
        jobStatus,
        command.now,
        jobStatus,
        command.now,
        job.id,
        job.state_version,
      );
      if (jobChanged.changes !== 1) throw new Error('Recovery Job changed concurrently');
      appendEvent({
        jobId: job.id,
        runId: attempt.id,
        attemptId: attempt.attempt_id,
        generation: attempt.generation,
        type: `job.${jobStatus}`,
        payload: { decision, crashCount },
        producer: command.producer,
        idempotencyKey: `job-recovery:${job.id}:${attempt.generation}`,
      });
      return { jobId: job.id, expiredAttemptId: attempt.attempt_id, decision };
    }

    const max = db.prepare(
      `SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number,
              COALESCE(MAX(generation), 0) AS generation
         FROM runs WHERE task_id = ?`,
    ).get(job.id) as { attempt_number: number; generation: number };
    const attemptNumber = max.attempt_number + 1;
    const generation = max.generation + 1;
    const recoveryAttemptId = randomId('attempt');
    const inserted = db.prepare(
      `INSERT INTO runs (
         session_id, instance_id, status, started_at, resume_pending,
         task_id, attempt_id, attempt_number, generation, state_version,
         recovery_of_attempt_id, trigger_reason
       ) VALUES (?, ?, 'queued', ?, 0, ?, ?, ?, ?, 0, ?, 'lease_expired')`,
    ).run(
      attempt.session_id,
      command.instanceId,
      command.now,
      job.id,
      recoveryAttemptId,
      attemptNumber,
      generation,
      attempt.attempt_id,
    );
    const jobChanged = db.prepare(
      `UPDATE tasks
          SET status = 'recovering', state_version = state_version + 1,
              active_attempt_id = ?, crash_count = ?, recovery_state = 'recovering',
              finish_reason = 'lease_expired', updated_at = ?
        WHERE id = ? AND state_version = ?`,
    ).run(recoveryAttemptId, crashCount, command.now, job.id, job.state_version);
    if (jobChanged.changes !== 1) throw new Error('Recovery Job changed concurrently');
    appendEvent({
      jobId: job.id,
      runId: attempt.id,
      attemptId: attempt.attempt_id,
      generation: attempt.generation,
      type: 'job.recovering',
      payload: { crashCount, recoveryAttemptId },
      producer: command.producer,
      idempotencyKey: `job-recovery:${job.id}:${attempt.generation}`,
    });
    appendEvent({
      jobId: job.id,
      runId: Number(inserted.lastInsertRowid),
      attemptId: recoveryAttemptId,
      generation,
      type: 'attempt.created',
      payload: { attemptNumber, recoveryOfAttemptId: attempt.attempt_id, triggerReason: 'lease_expired' },
      producer: command.producer,
      idempotencyKey: `attempt-created:${recoveryAttemptId}`,
    });
    return { jobId: job.id, expiredAttemptId: attempt.attempt_id, recoveryAttemptId, decision };
  }).immediate;

  return {
    submitJob: submitTx,
    getJob(jobId) {
      const row = getJobRow(jobId);
      return row ? mapJob(row) : null;
    },
    listJobs(filters = {}) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filters.sessionId) { clauses.push('session_id = ?'); params.push(filters.sessionId); }
      if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
      if (filters.rootJobId) { clauses.push('root_job_id = ?'); params.push(filters.rootJobId); }
      const limit = Math.max(1, Math.min(1_000, filters.limit ?? 100));
      const rows = db.prepare(
        `SELECT id, status, state_version, active_attempt_id, root_job_id,
                parent_task_id, session_id, goal, entry_point, source,
                terminal_at, terminal_outcome, finish_reason, next_event_sequence
           FROM tasks
          ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      ).all(...params, limit) as JobSqlRow[];
      return rows.map(mapJob);
    },
    getAttempt(attemptId) {
      const row = getAttemptRow(attemptId);
      return row ? mapAttempt(row) : null;
    },
    listAttempts(jobId) {
      const rows = db.prepare(
        `SELECT id, attempt_id, task_id, status, attempt_number, generation,
                state_version, lease_id, lease_owner, lease_expires_at,
                lease_heartbeat_at, fence_token, recovery_of_attempt_id, session_id
           FROM runs WHERE task_id = ? ORDER BY attempt_number`,
      ).all(jobId) as AttemptSqlRow[];
      return rows.map(mapAttempt);
    },
    listEvents(jobId, afterSequence = 0) {
      const rows = db.prepare(
        `SELECT id, job_sequence, job_id, attempt_id, kind, payload, producer,
                generation, idempotency_key, ts
           FROM run_events
          WHERE job_id = ? AND job_sequence > ?
          ORDER BY job_sequence`,
      ).all(jobId, afterSequence) as Array<{
        id: number;
        job_sequence: number;
        job_id: string;
        attempt_id: string | null;
        kind: string;
        payload: string;
        producer: string | null;
        generation: number | null;
        idempotency_key: string;
        ts: number;
      }>;
      return rows.map((row) => {
        let payload: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(row.payload);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
          }
        } catch { /* malformed legacy payload remains null */ }
        return {
          eventId: row.id,
          jobSequence: row.job_sequence,
          jobId: row.job_id,
          attemptId: row.attempt_id,
          type: row.kind,
          payload,
          producer: row.producer,
          generation: row.generation,
          idempotencyKey: row.idempotency_key,
          createdAt: row.ts,
        };
      });
    },
    appendJobEvent: appendJobEventTx,
    transitionJob: transitionJobTx,
    finalizeJob: finalizeJobTx,
    cancelJob: cancelJobTx,
    pauseJob: pauseJobTx,
    resumeJob: resumeJobTx,
    transitionAttempt: transitionAttemptTx,
    claimAttempt: claimAttemptTx,
    renewAttemptLease: renewAttemptTx,
    createRecoveryAttempt: recoveryTx,
    prepareToolCall: prepareToolCallTx,
    startToolCall: startToolCallTx,
    completeToolCall: completeToolCallTx,
    attachToolVerification: attachToolVerificationTx,
    recoverExpiredAttempts(command) {
      const now = command.now ?? Date.now();
      const rows = db.prepare(
        `SELECT r.attempt_id
           FROM runs r
           JOIN tasks t ON t.active_attempt_id = r.attempt_id
          WHERE r.lease_expires_at IS NOT NULL AND r.lease_expires_at <= ?
            AND r.status NOT IN ('succeeded','completed','failed','cancelled','timed_out','crashed','unknown','interrupted')
            AND t.status NOT IN ('cancelled','completed','failed','dead_letter','completed_unverified','verification_failed','abandoned')
          ORDER BY r.lease_expires_at ASC, r.id ASC`,
      ).all(now) as Array<{ attempt_id: string }>;
      const decisions: Array<{
        jobId: string;
        expiredAttemptId: string;
        recoveryAttemptId?: string;
        decision: 'retry' | 'ask_user' | 'dead_letter';
      }> = [];
      for (const row of rows) {
        const result = recoverExpiredAttemptTx({ ...command, now, attemptId: row.attempt_id });
        if (result) decisions.push(result);
      }
      return decisions;
    },
  };
}
