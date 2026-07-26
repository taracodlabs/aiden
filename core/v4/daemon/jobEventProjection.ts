/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { Db } from './db/connection';
import type { AttemptRecord, JobEventRecord, JobRecord } from './jobEngine';

export interface JobProjectionSnapshot {
  job: JobRecord;
  attempts: AttemptRecord[];
  children: Array<Record<string, unknown>>;
  inputs: Array<Record<string, unknown>>;
  waits: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  effects: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown>>;
  verdict: Record<string, unknown> | null;
  budgets: Array<Record<string, unknown>>;
  events: JobEventRecord[];
}

export interface JobEventProjectionAuthority {
  cursor(consumerId: string, jobId: string): number;
  read(consumerId: string, jobId: string, limit?: number): JobEventRecord[];
  acknowledge(consumerId: string, jobId: string, sequence: number, now?: number): number;
  rebuild(jobId: string): JobProjectionSnapshot;
}

type JobRow = {
  id: string; status: string; state_version: number; active_attempt_id: string | null;
  root_job_id: string | null; parent_task_id: string | null; session_id: string; goal: string;
  entry_point: string | null; source: string | null; terminal_at: number | null;
  terminal_outcome: string | null; finish_reason: string | null; next_event_sequence: number;
};
type AttemptRow = {
  id: number; attempt_id: string; task_id: string | null; status: string; attempt_number: number;
  generation: number; state_version: number; lease_id: string | null; lease_owner: string | null;
  lease_expires_at: number | null; lease_heartbeat_at: number | null; fence_token: string | null;
  recovery_of_attempt_id: string | null;
};
type EventRow = {
  id: number; job_sequence: number; job_id: string; attempt_id: string | null; kind: string;
  payload: string; producer: string | null; generation: number | null; idempotency_key: string; ts: number;
};

const mapJob = (row: JobRow): JobRecord => ({
  id: row.id, status: row.status, stateVersion: row.state_version, activeAttemptId: row.active_attempt_id,
  rootJobId: row.root_job_id ?? row.id, parentJobId: row.parent_task_id, sessionId: row.session_id,
  goal: row.goal, entryPoint: row.entry_point, source: row.source, terminalAt: row.terminal_at,
  terminalOutcome: row.terminal_outcome, finishReason: row.finish_reason,
  nextEventSequence: row.next_event_sequence,
});
const mapAttempt = (row: AttemptRow): AttemptRecord => ({
  rowId: row.id, id: row.attempt_id, jobId: row.task_id, status: row.status,
  attemptNumber: row.attempt_number, generation: row.generation, stateVersion: row.state_version,
  leaseId: row.lease_id, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at,
  leaseHeartbeatAt: row.lease_heartbeat_at, fenceToken: row.fence_token,
  recoveryOfAttemptId: row.recovery_of_attempt_id,
});
const mapEvent = (row: EventRow): JobEventRecord => {
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* legacy malformed payload remains null */ }
  return {
    eventId: row.id, jobSequence: row.job_sequence, jobId: row.job_id, attemptId: row.attempt_id,
    type: row.kind, payload, producer: row.producer, generation: row.generation,
    idempotencyKey: row.idempotency_key, createdAt: row.ts,
  };
};

export function createJobEventProjectionAuthority(db: Db): JobEventProjectionAuthority {
  const cursor = (consumerId: string, jobId: string): number => {
    const row = db.prepare(
      'SELECT last_sequence FROM job_event_cursors WHERE consumer_id = ? AND job_id = ?',
    ).get(consumerId, jobId) as { last_sequence: number } | undefined;
    return row?.last_sequence ?? 0;
  };
  const eventsAfter = (jobId: string, sequence: number, limit: number): JobEventRecord[] => (
    db.prepare(
      `SELECT id, job_sequence, job_id, attempt_id, kind, payload, producer,
              generation, idempotency_key, ts
         FROM run_events WHERE job_id = ? AND job_sequence > ?
        ORDER BY job_sequence LIMIT ?`,
    ).all(jobId, sequence, limit) as EventRow[]
  ).map(mapEvent);
  const rows = (table: string, where: string, order: string, jobId: string): Array<Record<string, unknown>> =>
    db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order}`).all(jobId) as Array<Record<string, unknown>>;
  return {
    cursor,
    read(consumerId, jobId, limit = 500) {
      return eventsAfter(jobId, cursor(consumerId, jobId), Math.max(1, Math.min(1_000, limit)));
    },
    acknowledge(consumerId, jobId, sequence, now = Date.now()) {
      const job = db.prepare('SELECT next_event_sequence FROM tasks WHERE id = ?').get(jobId) as
        { next_event_sequence: number } | undefined;
      if (!job) throw new Error('Job not found');
      const bounded = Math.max(0, Math.min(sequence, job.next_event_sequence - 1));
      db.prepare(
        `INSERT INTO job_event_cursors (consumer_id, job_id, last_sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(consumer_id, job_id) DO UPDATE SET
           last_sequence = MAX(last_sequence, excluded.last_sequence), updated_at = excluded.updated_at`,
      ).run(consumerId, jobId, bounded, now);
      return cursor(consumerId, jobId);
    },
    rebuild(jobId) {
      const jobRow = db.prepare(
        `SELECT id, status, state_version, active_attempt_id, root_job_id, parent_task_id,
                session_id, goal, entry_point, source, terminal_at, terminal_outcome,
                finish_reason, next_event_sequence FROM tasks WHERE id = ?`,
      ).get(jobId) as JobRow | undefined;
      if (!jobRow) throw new Error('Job not found');
      const attempts = (db.prepare(
        `SELECT id, attempt_id, task_id, status, attempt_number, generation, state_version,
                lease_id, lease_owner, lease_expires_at, lease_heartbeat_at, fence_token,
                recovery_of_attempt_id FROM runs WHERE task_id = ? ORDER BY attempt_number`,
      ).all(jobId) as AttemptRow[]).map(mapAttempt);
      return {
        job: mapJob(jobRow),
        attempts,
        children: rows('child_job_contracts', 'parent_job_id = ?', 'created_at, child_job_id', jobId),
        inputs: rows('durable_inputs', 'job_id = ?', 'sequence', jobId),
        waits: rows('job_waits', 'job_id = ?', 'sequence', jobId),
        approvals: rows('approvals', 'job_id = ?', 'rowid', jobId),
        effects: rows('side_effect_ledger', 'job_id = ?', 'attempted_at, key', jobId),
        evidence: rows('job_evidence', 'job_id = ?', 'captured_at, evidence_id', jobId),
        claims: rows('job_claims', 'job_id = ?', 'created_at, claim_id', jobId),
        verdict: db.prepare('SELECT * FROM job_verdicts WHERE job_id = ?').get(jobId) as Record<string, unknown> | undefined ?? null,
        budgets: rows('job_budgets', 'job_id = ?', 'kind', jobId),
        events: eventsAfter(jobId, 0, 1_000),
      };
    },
  };
}
