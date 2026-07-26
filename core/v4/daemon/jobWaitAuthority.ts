/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { Db } from './db/connection';
import type { JobEngine } from './jobEngine';

export type DurableWaitKind =
  | 'approval' | 'clarification' | 'scheduled_time' | 'rate_limit_reset'
  | 'external_event' | 'child_job' | 'reconciliation' | 'resource_availability';
export type DurableWaitState = 'pending' | 'satisfied' | 'timed_out' | 'cancelled';

export interface DurableWaitRecord {
  waitId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  sequence: number;
  graphNodeKey: string | null;
  kind: DurableWaitKind;
  state: DurableWaitState;
  deadlineAt: number | null;
  externalKey: string | null;
  payloadRef: string | null;
  resolvedByInputId: string | null;
  resolutionRef: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface JobWaitAuthority {
  create(command: {
    jobId: string; attemptId: string; generation: number; kind: DurableWaitKind;
    graphNodeKey?: string | null; deadlineAt?: number | null; externalKey?: string | null;
    payloadRef?: string | null; producer: string; idempotencyNamespace: string;
    idempotencyKey: string; now?: number;
  }): { record: DurableWaitRecord; duplicate: boolean };
  get(waitId: string): DurableWaitRecord | null;
  listPending(jobId: string): DurableWaitRecord[];
  resolve(command: {
    waitId: string; attemptId: string; generation: number; producer: string;
    idempotencyKey: string; inputId?: string | null; resolutionRef?: string | null; now?: number;
  }): { applied: boolean; duplicate?: boolean; conflict?: 'not_found' | 'stale_generation' | 'terminal_state' };
  resolveExternal(command: {
    jobId: string; externalKey: string; attemptId: string; generation: number;
    producer: string; idempotencyKey: string; resolutionRef?: string | null; now?: number;
  }): { applied: boolean; duplicate?: boolean; conflict?: 'not_found' | 'stale_generation' | 'terminal_state' };
  cancel(command: {
    waitId: string; attemptId: string; generation: number; producer: string;
    idempotencyKey: string; now?: number;
  }): { applied: boolean; duplicate?: boolean; conflict?: 'not_found' | 'stale_generation' | 'terminal_state' };
  expireDue(now?: number, producer?: string): string[];
  cancelForJob(jobId: string, producer: string, idempotencyKey: string, now?: number): number;
  adoptPending(command: {
    jobId: string; attemptId: string; generation: number; producer: string;
    idempotencyKey: string; now?: number;
  }): number;
}

interface WaitRow {
  wait_id: string; job_id: string; attempt_id: string; generation: number;
  sequence: number;
  graph_node_key: string | null; kind: DurableWaitKind; state: DurableWaitState;
  deadline_at: number | null; external_key: string | null; payload_ref: string | null;
  resolved_by_input_id: string | null; resolution_ref: string | null;
  created_at: number; resolved_at: number | null;
}

const TERMINAL_JOBS = new Set(['cancelled', 'completed', 'failed', 'dead_letter', 'completed_unverified', 'verification_failed', 'abandoned']);

function map(row: WaitRow): DurableWaitRecord {
  return {
    waitId: row.wait_id, jobId: row.job_id, attemptId: row.attempt_id, generation: row.generation,
    sequence: row.sequence,
    graphNodeKey: row.graph_node_key, kind: row.kind, state: row.state,
    deadlineAt: row.deadline_at, externalKey: row.external_key, payloadRef: row.payload_ref,
    resolvedByInputId: row.resolved_by_input_id, resolutionRef: row.resolution_ref,
    createdAt: row.created_at, resolvedAt: row.resolved_at,
  };
}

function waitId(jobId: string, namespace: string, key: string): string {
  return `wait_${createHash('sha256').update(`${jobId}\0${namespace}\0${key}`).digest('hex')}`;
}

export function createJobWaitAuthority(db: Db, jobs: JobEngine): JobWaitAuthority {
  const get = (id: string): DurableWaitRecord | null => {
    const row = db.prepare('SELECT * FROM job_waits WHERE wait_id = ?').get(id) as WaitRow | undefined;
    return row ? map(row) : null;
  };
  const event = (record: DurableWaitRecord, type: string, producer: string, idempotencyKey: string, payload: Record<string, unknown>, now: number): void => {
    db.prepare(
      `INSERT OR IGNORE INTO job_wait_events
         (wait_id, job_id, type, payload_json, producer, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(record.waitId, record.jobId, type, JSON.stringify(payload), producer, idempotencyKey, now);
    jobs.appendJobEvent({
      jobId: record.jobId, attemptId: record.attemptId, generation: record.generation,
      type, payload: { waitId: record.waitId, kind: record.kind, state: record.state },
      producer, idempotencyKey: `wait-event:${record.waitId}:${idempotencyKey}`,
    });
  };
  const resolveTx = db.transaction((command: Parameters<JobWaitAuthority['resolve']>[0]) => {
    const row = db.prepare('SELECT * FROM job_waits WHERE wait_id = ?').get(command.waitId) as WaitRow | undefined;
    if (!row) return { applied: false, conflict: 'not_found' as const };
    const priorEvent = db.prepare('SELECT 1 FROM job_wait_events WHERE wait_id = ? AND idempotency_key = ?')
      .get(command.waitId, command.idempotencyKey);
    if (priorEvent) return { applied: false, duplicate: true };
    if (row.state !== 'pending') return { applied: false, conflict: 'terminal_state' as const };
    const job = jobs.getJob(row.job_id);
    const attempt = jobs.getAttempt(command.attemptId);
    if (
      !job || TERMINAL_JOBS.has(job.status) || job.activeAttemptId !== command.attemptId
      || !attempt || attempt.jobId !== row.job_id || attempt.generation !== command.generation
      || row.attempt_id !== command.attemptId || row.generation !== command.generation
    ) return { applied: false, conflict: 'stale_generation' as const };
    const now = command.now ?? Date.now();
    const changed = db.prepare(
      `UPDATE job_waits SET state = 'satisfied', resolved_by_input_id = ?, resolution_ref = ?,
              resolved_at = ?, updated_at = ?
        WHERE wait_id = ? AND state = 'pending' AND attempt_id = ? AND generation = ?`,
    ).run(command.inputId ?? null, command.resolutionRef ?? null, now, now, row.wait_id, command.attemptId, command.generation);
    if (changed.changes !== 1) return { applied: false, conflict: 'stale_generation' as const };
    const record = get(row.wait_id)!;
    event(record, 'wait.satisfied', command.producer, command.idempotencyKey, {
      inputId: command.inputId ?? null, resolutionRef: command.resolutionRef ?? null,
    }, now);
    return { applied: true };
  }).immediate;

  return {
    create(command) {
      return db.transaction(() => {
        const existing = db.prepare(
          'SELECT * FROM job_waits WHERE idempotency_namespace = ? AND idempotency_key = ?',
        ).get(command.idempotencyNamespace, command.idempotencyKey) as WaitRow | undefined;
        if (existing) {
          if (existing.job_id !== command.jobId || existing.kind !== command.kind) throw new Error('Wait idempotency conflict');
          return { record: map(existing), duplicate: true };
        }
        const job = jobs.getJob(command.jobId);
        const attempt = jobs.getAttempt(command.attemptId);
        if (!job || TERMINAL_JOBS.has(job.status)) throw new Error('Wait target Job is terminal or missing');
        if (
          job.activeAttemptId !== command.attemptId || !attempt || attempt.jobId !== command.jobId
          || attempt.generation !== command.generation
        ) throw new Error('Wait target has a stale Attempt or generation');
        const now = command.now ?? Date.now();
        const id = waitId(command.jobId, command.idempotencyNamespace, command.idempotencyKey);
        const allocated = db.prepare(
          `UPDATE tasks SET next_wait_sequence = next_wait_sequence + 1, updated_at = ?
            WHERE id = ? RETURNING next_wait_sequence - 1 AS sequence`,
        ).get(now, command.jobId) as { sequence: number } | undefined;
        if (!allocated) throw new Error('Wait target Job disappeared');
        db.prepare(
          `INSERT INTO job_waits
             (wait_id, job_id, attempt_id, generation, sequence, graph_node_key, kind, state,
              deadline_at, external_key, payload_ref, idempotency_namespace,
              idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, command.jobId, command.attemptId, command.generation, allocated.sequence, command.graphNodeKey ?? null,
          command.kind, command.deadlineAt ?? null, command.externalKey ?? null, command.payloadRef ?? null,
          command.idempotencyNamespace, command.idempotencyKey, now, now,
        );
        const record = get(id)!;
        event(record, 'wait.created', command.producer, 'created', {
          deadlineAt: record.deadlineAt, externalKey: record.externalKey, graphNodeKey: record.graphNodeKey,
        }, now);
        return { record, duplicate: false };
      }).immediate();
    },
    get,
    listPending(jobId) {
      return (db.prepare("SELECT * FROM job_waits WHERE job_id = ? AND state = 'pending' ORDER BY sequence")
        .all(jobId) as WaitRow[]).map(map);
    },
    resolve: resolveTx,
    resolveExternal(command) {
      const row = db.prepare(
        `SELECT wait_id FROM job_waits
          WHERE job_id = ? AND external_key = ? AND kind = 'external_event'
          ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, sequence LIMIT 1`,
      ).get(command.jobId, command.externalKey) as { wait_id: string } | undefined;
      if (!row) return { applied: false, conflict: 'not_found' };
      return resolveTx({ ...command, waitId: row.wait_id });
    },
    cancel(command) {
      return db.transaction(() => {
        const row = db.prepare('SELECT * FROM job_waits WHERE wait_id = ?').get(command.waitId) as WaitRow | undefined;
        if (!row) return { applied: false, conflict: 'not_found' as const };
        const prior = db.prepare('SELECT 1 FROM job_wait_events WHERE wait_id = ? AND idempotency_key = ?')
          .get(row.wait_id, command.idempotencyKey);
        if (prior) return { applied: false, duplicate: true };
        if (row.state !== 'pending') return { applied: false, conflict: 'terminal_state' as const };
        if (row.attempt_id !== command.attemptId || row.generation !== command.generation) {
          return { applied: false, conflict: 'stale_generation' as const };
        }
        const now = command.now ?? Date.now();
        db.prepare("UPDATE job_waits SET state = 'cancelled', resolved_at = ?, updated_at = ? WHERE wait_id = ? AND state = 'pending'")
          .run(now, now, row.wait_id);
        event(get(row.wait_id)!, 'wait.cancelled', command.producer, command.idempotencyKey, {}, now);
        return { applied: true };
      }).immediate();
    },
    expireDue(now = Date.now(), producer = 'wait-scheduler') {
      return db.transaction(() => {
        const rows = db.prepare(
          "SELECT * FROM job_waits WHERE state = 'pending' AND deadline_at IS NOT NULL AND deadline_at <= ? ORDER BY deadline_at, job_id, sequence",
        ).all(now) as WaitRow[];
        for (const row of rows) {
          db.prepare("UPDATE job_waits SET state = 'timed_out', resolved_at = ?, updated_at = ? WHERE wait_id = ? AND state = 'pending'")
            .run(now, now, row.wait_id);
          event(get(row.wait_id)!, 'wait.timed_out', producer, `timeout:${row.deadline_at}`, {}, now);
        }
        return rows.map((row) => row.wait_id);
      }).immediate();
    },
    cancelForJob(jobId, producer, idempotencyKey, now = Date.now()) {
      return db.transaction(() => {
        const rows = db.prepare("SELECT * FROM job_waits WHERE job_id = ? AND state = 'pending' ORDER BY sequence")
          .all(jobId) as WaitRow[];
        for (const row of rows) {
          db.prepare("UPDATE job_waits SET state = 'cancelled', resolved_at = ?, updated_at = ? WHERE wait_id = ? AND state = 'pending'")
            .run(now, now, row.wait_id);
          event(get(row.wait_id)!, 'wait.cancelled', producer, `${idempotencyKey}:${row.wait_id}`, {}, now);
        }
        return rows.length;
      }).immediate();
    },
    adoptPending(command) {
      const job = jobs.getJob(command.jobId);
      const attempt = jobs.getAttempt(command.attemptId);
      if (!job || job.activeAttemptId !== command.attemptId || !attempt || attempt.generation !== command.generation) {
        throw new Error('Wait adoption target is not the active generation');
      }
      return db.transaction(() => {
        const rows = db.prepare(
          "SELECT * FROM job_waits WHERE job_id = ? AND state = 'pending' AND (attempt_id <> ? OR generation <> ?) ORDER BY sequence",
        ).all(command.jobId, command.attemptId, command.generation) as WaitRow[];
        const now = command.now ?? Date.now();
        for (const row of rows) {
          db.prepare('UPDATE job_waits SET attempt_id = ?, generation = ?, updated_at = ? WHERE wait_id = ? AND state = \'pending\'')
            .run(command.attemptId, command.generation, now, row.wait_id);
          event(get(row.wait_id)!, 'wait.adopted', command.producer, `${command.idempotencyKey}:${row.wait_id}`, {
            previousAttemptId: row.attempt_id, previousGeneration: row.generation,
          }, now);
        }
        return rows.length;
      }).immediate();
    },
  };
}
