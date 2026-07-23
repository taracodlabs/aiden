/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Db } from './db/connection';
import type { JobEngine } from './jobEngine';

export type DurableInputKind = 'message' | 'steering' | 'control' | 'approval_decision' | 'credential';
export type DurableInputState =
  | 'received' | 'persisted' | 'queued' | 'claimed' | 'consumed'
  | 'superseded' | 'cancelled' | 'expired' | 'rejected_stale';

export interface DurableInputRecord {
  inputId: string;
  jobId: string;
  targetAttemptId: string | null;
  targetGeneration: number | null;
  sessionId: string;
  channelId: string | null;
  source: string;
  sequence: number;
  kind: DurableInputKind;
  content: string | null;
  contentHash: string;
  state: DurableInputState;
  claimedByAttemptId: string | null;
  claimedGeneration: number | null;
  claimedAt: number | null;
  consumedAt: number | null;
  createdAt: number;
}

export interface ReceiveInputCommand {
  jobId: string;
  targetAttemptId?: string | null;
  targetGeneration?: number | null;
  sessionId: string;
  channelId?: string | null;
  source: string;
  kind: DurableInputKind;
  content: string;
  idempotencyNamespace: string;
  idempotencyKey: string;
  supersedesInputId?: string | null;
  expiresAt?: number | null;
}

export interface InputAuthorityStore {
  receive(command: ReceiveInputCommand): { record: DurableInputRecord; persisted: true; duplicate: boolean };
  get(inputId: string): DurableInputRecord | null;
  listPending(jobId: string): DurableInputRecord[];
  listPendingForSession(sessionId: string): DurableInputRecord[];
  cancelPendingForSession(sessionId: string, now?: number): number;
  claimNext(command: {
    jobId: string;
    attemptId: string;
    generation: number;
    inputId?: string;
    kinds?: DurableInputKind[];
    now?: number;
  }): DurableInputRecord | null;
  consume(command: { inputId: string; attemptId: string; generation: number; now?: number }): {
    applied: boolean;
    duplicate?: boolean;
    conflict?: 'not_found' | 'stale_generation' | 'invalid_state';
  };
}

export interface SteeringRecord {
  steeringId: string;
  inputId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  targetScope: string;
  action: 'narrow_scope' | 'redirect' | 'skip' | 'stop' | 'replace_goal';
  payload: string | null;
  state: 'pending' | 'applied' | 'rejected';
  safeBoundarySequence: number | null;
  invalidatesPlanDigest: string | null;
  appliedAt: number | null;
  rejectionReason: string | null;
}

export interface SteeringAuthority {
  submit(command: {
    jobId: string;
    attemptId: string;
    generation: number;
    sessionId: string;
    channelId?: string | null;
    source: string;
    targetScope?: string;
    action: SteeringRecord['action'];
    payload?: string | null;
    invalidatesPlanDigest?: string | null;
    idempotencyNamespace: string;
    idempotencyKey: string;
  }): SteeringRecord;
  listPending(jobId: string): SteeringRecord[];
  applyNext(command: {
    jobId: string;
    attemptId: string;
    generation: number;
    safeBoundarySequence: number;
    instanceId?: string;
    now?: number;
  }): SteeringRecord | null;
}

export type JobControlKind = 'pause' | 'resume' | 'cancel' | 'interrupt';

export interface JobControlAuthority {
  inputs: InputAuthorityStore;
  steering: SteeringAuthority;
  commands: {
    request(command: {
      jobId: string;
      attemptId?: string | null;
      generation?: number | null;
      kind: Exclude<JobControlKind, 'resume'>;
      source: string;
      reason?: string;
      idempotencyNamespace: string;
      idempotencyKey: string;
      now?: number;
    }): { controlId: string; persisted: true; duplicate: boolean; applied: boolean };
    resume(command: {
      jobId: string;
      source: string;
      instanceId: string;
      idempotencyNamespace: string;
      idempotencyKey: string;
      now?: number;
    }): { controlId: string; attemptId: string; runId: number; generation: number; duplicate: boolean };
    listPending(jobId: string): Array<{ controlId: string; kind: JobControlKind; state: string }>;
    applyPendingAtBoundary(command: { jobId: string; now?: number }): { applied: boolean; kind?: JobControlKind };
  };
  runtime: {
    attach(attemptId: string, controller: AbortController): () => void;
    cancel(attemptId: string, reason?: string): boolean;
    isAttached(attemptId: string): boolean;
  };
}

export interface CreateJobControlAuthorityOptions {
  db: Db;
  jobEngine: JobEngine;
}

interface InputRow {
  input_id: string;
  job_id: string;
  target_attempt_id: string | null;
  target_generation: number | null;
  session_id: string;
  channel_id: string | null;
  source: string;
  sequence: number;
  kind: DurableInputKind;
  content: string | null;
  content_hash: string;
  state: DurableInputState;
  claimed_by_attempt_id: string | null;
  claimed_generation: number | null;
  claimed_at: number | null;
  consumed_at: number | null;
  created_at: number;
}

interface SteeringRow {
  steering_id: string;
  input_id: string;
  job_id: string;
  attempt_id: string;
  generation: number;
  target_scope: string;
  action: SteeringRecord['action'];
  payload: string | null;
  state: SteeringRecord['state'];
  safe_boundary_sequence: number | null;
  invalidates_plan_digest: string | null;
  applied_at: number | null;
  rejection_reason: string | null;
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mapInput(row: InputRow): DurableInputRecord {
  return {
    inputId: row.input_id,
    jobId: row.job_id,
    targetAttemptId: row.target_attempt_id,
    targetGeneration: row.target_generation,
    sessionId: row.session_id,
    channelId: row.channel_id,
    source: row.source,
    sequence: row.sequence,
    kind: row.kind,
    content: row.content,
    contentHash: row.content_hash,
    state: row.state,
    claimedByAttemptId: row.claimed_by_attempt_id,
    claimedGeneration: row.claimed_generation,
    claimedAt: row.claimed_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapSteering(row: SteeringRow): SteeringRecord {
  return {
    steeringId: row.steering_id,
    inputId: row.input_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    generation: row.generation,
    targetScope: row.target_scope,
    action: row.action,
    payload: row.payload,
    state: row.state,
    safeBoundarySequence: row.safe_boundary_sequence,
    invalidatesPlanDigest: row.invalidates_plan_digest,
    appliedAt: row.applied_at,
    rejectionReason: row.rejection_reason,
  };
}

export function createJobControlAuthority(options: CreateJobControlAuthorityOptions): JobControlAuthority {
  const { db, jobEngine } = options;
  const runtimeControllers = new Map<string, { registrationId: string; controller: AbortController }>();

  const getInput = (inputId: string): DurableInputRecord | null => {
    const row = db.prepare('SELECT * FROM durable_inputs WHERE input_id = ?').get(inputId) as InputRow | undefined;
    return row ? mapInput(row) : null;
  };

  const appendReferenceEvent = (command: {
    jobId: string;
    attemptId: string;
    generation: number;
    type: string;
    producer: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): void => {
    const result = jobEngine.appendJobEvent(command);
    if (!result.applied && !result.duplicate) {
      throw new Error(`Durable event rejected: ${result.conflict ?? 'unknown conflict'}`);
    }
  };

  const receiveTx = db.transaction((command: ReceiveInputCommand) => {
    if (command.kind === 'credential') {
      throw new Error('Credential input belongs to the credential authority and cannot enter the durable Job input store');
    }
    const existing = db.prepare(
      'SELECT * FROM durable_inputs WHERE idempotency_namespace = ? AND idempotency_key = ?',
    ).get(command.idempotencyNamespace, command.idempotencyKey) as InputRow | undefined;
    if (existing) {
      if (existing.content_hash !== digest(command.content) || existing.kind !== command.kind) {
        throw new Error('Input idempotency conflict');
      }
      return { record: mapInput(existing), persisted: true as const, duplicate: true };
    }
    const job = jobEngine.getJob(command.jobId);
    if (!job) throw new Error('Input target Job not found');
    if (['cancelled', 'completed', 'failed', 'dead_letter'].includes(job.status)) {
      throw new Error('Input target Job is terminal; submit a new Job or an explicit continuation');
    }
    if (command.targetAttemptId && command.targetAttemptId !== job.activeAttemptId) {
      throw new Error('Input target Attempt is stale');
    }
    if (command.targetAttemptId && command.targetGeneration !== null && command.targetGeneration !== undefined) {
      const attempt = jobEngine.getAttempt(command.targetAttemptId);
      if (!attempt || attempt.generation !== command.targetGeneration) throw new Error('Input target has a stale generation');
    }
    const allocated = db.prepare(
      `UPDATE tasks SET next_input_sequence = next_input_sequence + 1, updated_at = ?
        WHERE id = ? RETURNING next_input_sequence - 1 AS sequence`,
    ).get(Date.now(), command.jobId) as { sequence: number } | undefined;
    if (!allocated) throw new Error('Input target Job disappeared');
    const now = Date.now();
    const inputId = id('input');
    db.prepare(
      `INSERT INTO durable_inputs (
         input_id, job_id, target_attempt_id, target_generation, session_id,
         channel_id, source, sequence, kind, content, content_hash, state,
         idempotency_namespace, idempotency_key, supersedes_input_id,
         expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    ).run(
      inputId,
      command.jobId,
      command.targetAttemptId ?? null,
      command.targetGeneration ?? null,
      command.sessionId,
      command.channelId ?? null,
      command.source,
      allocated.sequence,
      command.kind,
      command.content,
      digest(command.content),
      command.idempotencyNamespace,
      command.idempotencyKey,
      command.supersedesInputId ?? null,
      command.expiresAt ?? null,
      now,
      now,
    );
    const record = getInput(inputId)!;
    const attemptId = record.targetAttemptId ?? job.activeAttemptId;
    const attempt = attemptId ? jobEngine.getAttempt(attemptId) : null;
    if (!attempt) throw new Error('Input target has no durable Attempt');
    appendReferenceEvent({
      jobId: command.jobId,
      attemptId,
      generation: record.targetGeneration ?? attempt.generation,
      type: 'input.queued',
      producer: command.source,
      idempotencyKey: `input:${inputId}:queued`,
      payload: {
        inputId,
        kind: record.kind,
        sequence: record.sequence,
        state: record.state,
        contentHash: record.contentHash,
      },
    });
    return { record, persisted: true as const, duplicate: false };
  }).immediate;

  const claimTx = db.transaction((command: {
    jobId: string;
    attemptId: string;
    generation: number;
    inputId?: string;
    kinds?: DurableInputKind[];
    now?: number;
  }) => {
    const attempt = jobEngine.getAttempt(command.attemptId);
    if (!attempt || attempt.jobId !== command.jobId || attempt.generation !== command.generation) return null;
    const now = command.now ?? Date.now();
    const kinds = command.kinds?.length ? command.kinds : null;
    const kindSql = kinds ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    if (command.inputId) {
      const exact = db.prepare(
        `SELECT * FROM durable_inputs
          WHERE input_id = ? AND job_id = ? AND state IN ('queued','claimed')
            AND (expires_at IS NULL OR expires_at > ?)
            AND (target_attempt_id IS NULL OR target_attempt_id = ?)
            AND (target_generation IS NULL OR target_generation = ?)
            ${kindSql}`,
      ).get(command.inputId, command.jobId, now, command.attemptId, command.generation, ...(kinds ?? [])) as InputRow | undefined;
      if (!exact) return null;
      if (exact.state === 'claimed') {
        return exact.claimed_by_attempt_id === command.attemptId && exact.claimed_generation === command.generation
          ? mapInput(exact)
          : null;
      }
    }
    const row = db.prepare(
      `SELECT * FROM durable_inputs
        WHERE job_id = ? AND state = 'queued'
          ${command.inputId ? 'AND input_id = ?' : ''}
          AND (expires_at IS NULL OR expires_at > ?)
          AND (target_attempt_id IS NULL OR target_attempt_id = ?)
          AND (target_generation IS NULL OR target_generation = ?)
          ${kindSql}
        ORDER BY sequence LIMIT 1`,
    ).get(
      command.jobId,
      ...(command.inputId ? [command.inputId] : []),
      now,
      command.attemptId,
      command.generation,
      ...(kinds ?? []),
    ) as InputRow | undefined;
    if (!row) return null;
    const changed = db.prepare(
      `UPDATE durable_inputs
          SET state = 'claimed', claimed_by_attempt_id = ?, claimed_generation = ?,
              claimed_at = ?, updated_at = ?
        WHERE input_id = ? AND state = 'queued'`,
    ).run(command.attemptId, command.generation, now, now, row.input_id);
    if (changed.changes !== 1) return null;
    const claimed = getInput(row.input_id)!;
    appendReferenceEvent({
      jobId: command.jobId,
      attemptId: command.attemptId,
      generation: command.generation,
      type: 'input.claimed',
      producer: claimed.source,
      idempotencyKey: `input:${row.input_id}:claimed:${command.attemptId}:${command.generation}`,
      payload: { inputId: row.input_id, kind: claimed.kind, sequence: claimed.sequence, state: claimed.state },
    });
    return claimed;
  }).immediate;

  const consumeTx = db.transaction((command: { inputId: string; attemptId: string; generation: number; now?: number }) => {
    const row = db.prepare('SELECT * FROM durable_inputs WHERE input_id = ?').get(command.inputId) as InputRow | undefined;
    if (!row) return { applied: false, conflict: 'not_found' as const };
    if (row.state === 'consumed') return { applied: false, duplicate: true };
    if (row.claimed_by_attempt_id !== command.attemptId || row.claimed_generation !== command.generation) {
      return { applied: false, conflict: 'stale_generation' as const };
    }
    if (row.state !== 'claimed') return { applied: false, conflict: 'invalid_state' as const };
    const now = command.now ?? Date.now();
    const changed = db.prepare(
      `UPDATE durable_inputs SET state = 'consumed', consumed_at = ?, updated_at = ?
        WHERE input_id = ? AND state = 'claimed' AND claimed_by_attempt_id = ? AND claimed_generation = ?`,
    ).run(now, now, command.inputId, command.attemptId, command.generation);
    if (changed.changes !== 1) return { applied: false, conflict: 'invalid_state' as const };
    appendReferenceEvent({
      jobId: row.job_id,
      attemptId: command.attemptId,
      generation: command.generation,
      type: 'input.consumed',
      producer: row.source,
      idempotencyKey: `input:${command.inputId}:consumed`,
      payload: { inputId: command.inputId, kind: row.kind, sequence: row.sequence, state: 'consumed' },
    });
    return { applied: true };
  }).immediate;

  const inputs: InputAuthorityStore = {
    receive: receiveTx,
    get: getInput,
    listPending(jobId) {
      return (db.prepare(
        `SELECT * FROM durable_inputs WHERE job_id = ? AND state IN ('queued','claimed') ORDER BY sequence`,
      ).all(jobId) as InputRow[]).map(mapInput);
    },
    listPendingForSession(sessionId) {
      return (db.prepare(
        `SELECT * FROM durable_inputs WHERE session_id = ? AND state IN ('queued','claimed') ORDER BY created_at, sequence`,
      ).all(sessionId) as InputRow[]).map(mapInput);
    },
    cancelPendingForSession(sessionId, now = Date.now()) {
      return db.prepare(
        `UPDATE durable_inputs SET state = 'cancelled', updated_at = ?
          WHERE session_id = ? AND state IN ('queued','claimed')`,
      ).run(now, sessionId).changes;
    },
    claimNext: claimTx,
    consume: consumeTx,
  };

  const steering: SteeringAuthority = {
    submit(command) {
      return db.transaction(() => {
        const received = inputs.receive({
        jobId: command.jobId,
        targetAttemptId: command.attemptId,
        targetGeneration: command.generation,
        sessionId: command.sessionId,
        channelId: command.channelId,
        source: command.source,
        kind: 'steering',
        content: command.payload ?? '',
        idempotencyNamespace: command.idempotencyNamespace,
        idempotencyKey: command.idempotencyKey,
      });
        const existing = db.prepare('SELECT * FROM steering_commands WHERE input_id = ?')
          .get(received.record.inputId) as SteeringRow | undefined;
        if (existing) return mapSteering(existing);
        const steeringId = id('steer');
        const now = Date.now();
        db.prepare(
        `INSERT INTO steering_commands (
           steering_id, input_id, job_id, attempt_id, generation, target_scope,
           action, payload, state, invalidates_plan_digest, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        ).run(
        steeringId,
        received.record.inputId,
        command.jobId,
        command.attemptId,
        command.generation,
        command.targetScope ?? 'attempt',
        command.action,
        command.payload ?? null,
        command.invalidatesPlanDigest ?? null,
        now,
        now,
        );
        const record = mapSteering(db.prepare('SELECT * FROM steering_commands WHERE steering_id = ?').get(steeringId) as SteeringRow);
        appendReferenceEvent({
          jobId: record.jobId,
          attemptId: record.attemptId,
          generation: record.generation,
          type: 'steering.pending',
          producer: command.source,
          idempotencyKey: `steering:${record.steeringId}:pending`,
          payload: {
            steeringId: record.steeringId,
            inputId: record.inputId,
            action: record.action,
            targetScope: record.targetScope,
            state: record.state,
          },
        });
        return record;
      }).immediate();
    },
    listPending(jobId) {
      return (db.prepare(
        `SELECT * FROM steering_commands WHERE job_id = ? AND state = 'pending' ORDER BY created_at, steering_id`,
      ).all(jobId) as SteeringRow[]).map(mapSteering);
    },
    applyNext(command) {
      return db.transaction(() => {
        const row = db.prepare(
        `SELECT * FROM steering_commands
          WHERE job_id = ? AND attempt_id = ? AND generation = ? AND state = 'pending'
          ORDER BY created_at, steering_id LIMIT 1`,
        ).get(command.jobId, command.attemptId, command.generation) as SteeringRow | undefined;
        if (!row) return null;
        const now = command.now ?? Date.now();
        const job = jobEngine.getJob(command.jobId);
        const attempt = jobEngine.getAttempt(command.attemptId);
        if (
        !job || job.activeAttemptId !== command.attemptId ||
        !attempt || attempt.jobId !== command.jobId || attempt.generation !== command.generation
        ) {
          db.prepare(
          `UPDATE steering_commands
              SET state = 'rejected', rejection_reason = 'stale generation', updated_at = ?
            WHERE steering_id = ? AND state = 'pending'`,
          ).run(now, row.steering_id);
          db.prepare(
          `UPDATE durable_inputs SET state = 'rejected_stale', updated_at = ?
            WHERE input_id = ? AND state = 'queued'`,
          ).run(now, row.input_id);
          const rejected = mapSteering(db.prepare('SELECT * FROM steering_commands WHERE steering_id = ?').get(row.steering_id) as SteeringRow);
          if (attempt) appendReferenceEvent({
            jobId: command.jobId,
            attemptId: command.attemptId,
            generation: attempt.generation,
            type: 'steering.rejected',
            producer: 'steering',
            idempotencyKey: `steering:${row.steering_id}:rejected`,
            payload: { steeringId: row.steering_id, inputId: row.input_id, action: row.action, state: 'rejected' },
          });
          return rejected;
        }
        if (row.action === 'replace_goal') {
          if (!command.instanceId) {
            db.prepare(
            `UPDATE steering_commands
                SET state = 'rejected', rejection_reason = 'replacement Attempt owner required', updated_at = ?
              WHERE steering_id = ? AND state = 'pending'`,
            ).run(now, row.steering_id);
            const rejected = mapSteering(db.prepare('SELECT * FROM steering_commands WHERE steering_id = ?').get(row.steering_id) as SteeringRow);
            appendReferenceEvent({
              jobId: command.jobId,
              attemptId: command.attemptId,
              generation: command.generation,
              type: 'steering.rejected',
              producer: 'steering',
              idempotencyKey: `steering:${row.steering_id}:rejected`,
              payload: { steeringId: row.steering_id, inputId: row.input_id, action: row.action, state: 'rejected' },
            });
            return rejected;
          }
          const paused = jobEngine.pauseJob({
          jobId: command.jobId,
          reason: 'goal replaced by steering',
          producer: 'steering',
          eventIdempotencyKey: `steering:${row.steering_id}:pause`,
          now,
          });
          if (!paused.applied && !paused.duplicate) return null;
          jobEngine.resumeJob({
          jobId: command.jobId,
          instanceId: command.instanceId,
          triggerReason: 'goal_changed',
          producer: 'steering',
          eventIdempotencyKey: `steering:${row.steering_id}:resume`,
          now,
          });
        }
        const changed = db.prepare(
        `UPDATE steering_commands
            SET state = 'applied', safe_boundary_sequence = ?, applied_at = ?, updated_at = ?
          WHERE steering_id = ? AND state = 'pending' AND generation = ?`,
        ).run(command.safeBoundarySequence, now, now, row.steering_id, command.generation);
        if (changed.changes !== 1) return null;
        db.prepare(
        `UPDATE durable_inputs SET state = 'consumed', consumed_at = ?, updated_at = ?
          WHERE input_id = ? AND state = 'queued'`,
        ).run(now, now, row.input_id);
        const applied = mapSteering(db.prepare('SELECT * FROM steering_commands WHERE steering_id = ?').get(row.steering_id) as SteeringRow);
        appendReferenceEvent({
          jobId: command.jobId,
          attemptId: command.attemptId,
          generation: command.generation,
          type: 'steering.applied',
          producer: 'steering',
          idempotencyKey: `steering:${row.steering_id}:applied`,
          payload: {
            steeringId: row.steering_id,
            inputId: row.input_id,
            action: row.action,
            state: 'applied',
            safeBoundarySequence: command.safeBoundarySequence,
          },
        });
        return applied;
      }).immediate();
    },
  };

  const persistControl = (command: {
    jobId: string;
    attemptId?: string | null;
    generation?: number | null;
    kind: JobControlKind;
    source: string;
    reason?: string;
    idempotencyNamespace: string;
    idempotencyKey: string;
    now?: number;
  }): { controlId: string; duplicate: boolean; state: string; attemptId: string | null; generation: number | null } => {
    const existing = db.prepare(
      `SELECT control_id, state, attempt_id, generation FROM job_control_commands
        WHERE idempotency_namespace = ? AND idempotency_key = ?`,
    ).get(command.idempotencyNamespace, command.idempotencyKey) as {
      control_id: string; state: string; attempt_id: string | null; generation: number | null;
    } | undefined;
    if (existing) return {
      controlId: existing.control_id,
      duplicate: true,
      state: existing.state,
      attemptId: existing.attempt_id,
      generation: existing.generation,
    };
    const job = jobEngine.getJob(command.jobId);
    if (!job) throw new Error('Control target Job not found');
    const attemptId = command.attemptId ?? job.activeAttemptId;
    const attempt = attemptId ? jobEngine.getAttempt(attemptId) : null;
    if (!attempt || attempt.jobId !== command.jobId) throw new Error('Control target Attempt not found');
    const generation = command.generation ?? attempt.generation;
    if (attempt.generation !== generation) throw new Error('Control target has a stale generation');
    const controlId = id('control');
    const now = command.now ?? Date.now();
    db.prepare(
      `INSERT INTO job_control_commands (
         control_id, job_id, attempt_id, generation, kind, source, reason, state,
         idempotency_namespace, idempotency_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'persisted', ?, ?, ?, ?)`,
    ).run(
      controlId,
      command.jobId,
      attemptId,
      generation,
      command.kind,
      command.source,
      command.reason ?? null,
      command.idempotencyNamespace,
      command.idempotencyKey,
      now,
      now,
    );
    appendReferenceEvent({
      jobId: command.jobId,
      attemptId,
      generation,
      type: 'control.persisted',
      producer: command.source,
      idempotencyKey: `control:${controlId}:persisted`,
      payload: { controlId, kind: command.kind, state: 'persisted' },
    });
    return { controlId, duplicate: false, state: 'persisted', attemptId, generation };
  };

  return {
    inputs,
    steering,
    commands: {
      request(command) {
        const reason = command.reason ?? command.kind;
        const outcome = db.transaction(() => {
          const persisted = persistControl(command);
          if (persisted.duplicate) {
            return {
              controlId: persisted.controlId,
              persisted: true as const,
              duplicate: true,
              applied: persisted.state === 'applied',
              attemptIds: persisted.attemptId ? [persisted.attemptId] : [],
            };
          }
          if (command.kind === 'pause') {
            // Pause is acknowledged durably now and applied only when the
            // active runner reaches an explicit safe boundary.
            return {
              controlId: persisted.controlId,
              persisted: true as const,
              duplicate: false,
              applied: false,
              attemptIds: persisted.attemptId ? [persisted.attemptId] : [],
            };
          }
          const result = jobEngine.cancelJob({
            jobId: command.jobId,
            reason,
            producer: command.source,
            eventIdempotencyKey: `control:${persisted.controlId}`,
            now: command.now,
          });
          const attemptIds = persisted.attemptId ? [persisted.attemptId] : [];
          if (result.applied) {
            const parent = jobEngine.getJob(command.jobId);
            if (parent) {
              const family = jobEngine.listJobs({ rootJobId: parent.rootJobId, limit: 1_000 });
              const byId = new Map(family.map((job) => [job.id, job]));
              const isDescendant = (candidateId: string): boolean => {
                let cursor = byId.get(candidateId)?.parentJobId ?? null;
                const visited = new Set<string>();
                while (cursor && !visited.has(cursor)) {
                  if (cursor === command.jobId) return true;
                  visited.add(cursor);
                  cursor = byId.get(cursor)?.parentJobId ?? null;
                }
                return false;
              };
              for (const child of family.filter((job) => isDescendant(job.id))) {
                if (!child.activeAttemptId) continue;
                const childAttemptId = child.activeAttemptId;
                const cancelled = jobEngine.cancelJob({
                  jobId: child.id,
                  reason: `parent ${command.kind}: ${reason}`,
                  producer: command.source,
                  eventIdempotencyKey: `control:${persisted.controlId}:child:${child.id}`,
                  now: command.now,
                });
                if (cancelled.applied || cancelled.duplicate) attemptIds.push(childAttemptId);
              }
            }
          }
          const now = command.now ?? Date.now();
          db.prepare(
            `UPDATE job_control_commands SET state = ?, applied_at = ?, updated_at = ?, rejection_reason = ?
              WHERE control_id = ?`,
          ).run(result.applied ? 'applied' : 'rejected', result.applied ? now : null, now, result.applied ? null : 'state conflict', persisted.controlId);
          return {
            controlId: persisted.controlId,
            persisted: true as const,
            duplicate: false,
            applied: result.applied,
            attemptIds,
          };
        }).immediate();
        if (command.kind !== 'pause' && outcome.applied) {
          for (const attemptId of outcome.attemptIds) {
            const active = runtimeControllers.get(attemptId);
            if (active && !active.controller.signal.aborted) active.controller.abort(reason);
          }
        }
        const { attemptIds: _attemptIds, ...result } = outcome;
        return result;
      },
      resume(command) {
        return db.transaction(() => {
          const persisted = persistControl({ ...command, kind: 'resume' });
          if (persisted.duplicate) {
            const row = db.prepare(
              `SELECT r.attempt_id, r.id, r.generation
                 FROM job_control_commands c JOIN runs r ON r.attempt_id = c.attempt_id
                WHERE c.control_id = ?`,
            ).get(persisted.controlId) as { attempt_id: string; id: number; generation: number } | undefined;
            if (!row || persisted.state !== 'applied') throw new Error('Resume command was not fully applied');
            return { controlId: persisted.controlId, attemptId: row.attempt_id, runId: row.id, generation: row.generation, duplicate: true };
          }
          const resumed = jobEngine.resumeJob({
            jobId: command.jobId,
            instanceId: command.instanceId,
            triggerReason: 'manual_resume',
            producer: command.source,
            eventIdempotencyKey: `control:${persisted.controlId}`,
            now: command.now,
          });
          const now = command.now ?? Date.now();
          db.prepare(
            `UPDATE job_control_commands
                SET state = 'applied', attempt_id = ?, generation = ?, applied_at = ?, updated_at = ?
              WHERE control_id = ?`,
          ).run(resumed.attemptId, resumed.generation, now, now, persisted.controlId);
          return { controlId: persisted.controlId, ...resumed, duplicate: false };
        }).immediate();
      },
      listPending(jobId) {
        return db.prepare(
          `SELECT control_id AS controlId, kind, state
             FROM job_control_commands WHERE job_id = ? AND state IN ('persisted','pending') ORDER BY created_at`,
        ).all(jobId) as Array<{ controlId: string; kind: JobControlKind; state: string }>;
      },
      applyPendingAtBoundary(command) {
        return db.transaction(() => {
          const row = db.prepare(
          `SELECT control_id, kind, reason, source FROM job_control_commands
            WHERE job_id = ? AND state = 'persisted' ORDER BY created_at, control_id LIMIT 1`,
          ).get(command.jobId) as {
            control_id: string;
            kind: JobControlKind;
            reason: string | null;
            source: string;
          } | undefined;
          if (!row) return { applied: false };
          if (row.kind !== 'pause') return { applied: false, kind: row.kind };
          const result = jobEngine.pauseJob({
            jobId: command.jobId,
            reason: row.reason ?? 'pause',
            producer: row.source,
            eventIdempotencyKey: `control:${row.control_id}`,
            now: command.now,
          });
          const now = command.now ?? Date.now();
          db.prepare(
            `UPDATE job_control_commands SET state = ?, applied_at = ?, updated_at = ?, rejection_reason = ?
              WHERE control_id = ? AND state = 'persisted'`,
          ).run(result.applied ? 'applied' : 'rejected', result.applied ? now : null, now, result.applied ? null : 'state conflict', row.control_id);
          return { applied: result.applied, kind: row.kind };
        }).immediate();
      },
    },
    runtime: {
      attach(attemptId, controller) {
        const registrationId = id('runtime');
        runtimeControllers.set(attemptId, { registrationId, controller });
        return () => {
          const current = runtimeControllers.get(attemptId);
          if (current?.registrationId === registrationId) runtimeControllers.delete(attemptId);
        };
      },
      cancel(attemptId, reason) {
        const current = runtimeControllers.get(attemptId);
        if (!current || current.controller.signal.aborted) return false;
        current.controller.abort(reason);
        return true;
      },
      isAttached(attemptId) {
        return runtimeControllers.has(attemptId);
      },
    },
  };
}
