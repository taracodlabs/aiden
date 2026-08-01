/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes } from 'node:crypto';

import { isPortablePathWithin, resolvePortablePath } from '../portablePath';
import type { Db } from './db/connection';

export type JobBudgetKind =
  | 'runtime_ms' | 'model_calls' | 'input_tokens' | 'output_tokens'
  | 'reasoning_tokens' | 'tool_calls' | 'retries' | 'workers'
  | 'external_cost' | 'effects' | 'concurrent_nodes' | 'storage_bytes'
  | 'output_bytes';

export type BudgetCertainty = 'estimated' | 'confirmed' | 'unknown';

export interface JobCapabilities {
  tools?: readonly string[];
  paths?: readonly string[];
  hosts?: readonly string[];
  applications?: readonly string[];
  connections?: readonly string[];
  accounts?: readonly string[];
  workers?: readonly string[];
  effectKinds?: readonly string[];
}

export interface JobBudgetRecord {
  jobId: string;
  kind: JobBudgetKind;
  limit: number | null;
  used: number;
  hasUnknownUsage: boolean;
  stateVersion: number;
}

export type JobBudgetReservationState =
  | 'reserved' | 'partially_committed' | 'committed' | 'released'
  | 'exhausted' | 'cancelled' | 'reconciled';

export interface JobBudgetReservationItemRecord {
  kind: JobBudgetKind;
  reserved: number;
  committed: number;
  released: number;
  hasUnknownUsage: boolean;
  state: 'reserved' | 'partially_committed' | 'committed' | 'released' | 'exhausted' | 'unknown';
}

export interface JobBudgetReservationRecord {
  reservationId: string;
  idempotencyKey: string;
  parentJobId: string;
  parentAttemptId: string;
  parentGeneration: number;
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  workerRunId: string;
  assignmentId: string;
  state: JobBudgetReservationState;
  items: JobBudgetReservationItemRecord[];
  createdAt: number;
  updatedAt: number;
  releasedAt: number | null;
  reconciliationState: 'not_required' | 'pending' | 'reconciled' | 'blocked_unknown';
  reconciliationReason: string | null;
  unknownSpendPending: boolean;
  lastReconciledAt: number | null;
  settlementBlockedAt: number | null;
}

export interface JobResourceAuthority {
  configure(command: {
    jobId: string;
    budgets?: Partial<Record<JobBudgetKind, number | null>>;
    capabilities?: JobCapabilities;
    now?: number;
  }): void;
  getBudgets(jobId: string): JobBudgetRecord[];
  debit(command: {
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    kind: JobBudgetKind;
    amount: number | null;
    certainty: BudgetCertainty;
    idempotencyKey: string;
    enforceLimit?: boolean;
    now?: number;
  }): { applied: boolean; duplicate?: boolean; exhausted?: boolean; remaining: number | null };
  reserveWorker(command: {
    reservationId: string;
    idempotencyKey: string;
    parentJobId: string;
    parentAttemptId: string;
    parentGeneration: number;
    parentFenceToken: string;
    childJobId: string;
    childAttemptId: string;
    childGeneration: number;
    workerRunId: string;
    assignmentId: string;
    amounts: Partial<Record<JobBudgetKind, number>>;
    now?: number;
  }): JobBudgetReservationRecord;
  getWorkerReservation(reservationId: string): JobBudgetReservationRecord | null;
  getWorkerReservationForChild(childJobId: string): JobBudgetReservationRecord | null;
  listWorkerReservations(parentJobId: string): JobBudgetReservationRecord[];
  available(jobId: string, kind: JobBudgetKind): number | null;
  commitWorkerUsage(command: {
    reservationId: string;
    childAttemptId: string;
    childGeneration: number;
    childFenceToken: string;
    kind: JobBudgetKind;
    amount: number | null;
    certainty: BudgetCertainty;
    sourceKind: 'provider_attempt' | 'tool_call' | 'runtime' | 'reconciliation';
    sourceId: string;
    idempotencyKey: string;
    now?: number;
  }): { applied: boolean; duplicate?: boolean; exhausted?: boolean; remaining: number };
  releaseWorker(command: {
    reservationId: string;
    childAttemptId: string;
    childGeneration: number;
    childFenceToken: string;
    cancelled?: boolean;
    now?: number;
  }): JobBudgetReservationRecord;
  reconcileWorkerUsage(command: {
    reservationId: string;
    logicalCallId: string;
    kind: JobBudgetKind;
    amount: number | null;
    certainty: BudgetCertainty;
    providerAttemptId: string;
    idempotencyKey: string;
    now?: number;
  }): { applied: boolean; duplicate?: boolean; repaired?: boolean; exhausted?: boolean; remaining: number };
  reconcileWorkerReservation(command: {
    reservationId: string;
    logicalCallId: string;
    outcomeKnowledge: string;
    retrySafety: 'safe' | 'unsafe' | 'blocked_unknown' | 'not_applicable';
    unknownSpend: boolean;
    safeToRelease: boolean;
    reason: string;
    idempotencyKey: string;
    now?: number;
  }): JobBudgetReservationRecord;
  authorize(command: {
    jobId: string;
    kind: 'tool' | 'path' | 'host' | 'application' | 'connection' | 'account' | 'worker' | 'effect';
    value: string;
  }): boolean;
}

const CAPABILITY_COLUMN = {
  tool: 'allowed_tools_json',
  path: 'allowed_paths_json',
  host: 'allowed_hosts_json',
  application: 'allowed_applications_json',
  connection: 'allowed_connections_json',
  account: 'allowed_accounts_json',
  worker: 'allowed_workers_json',
  effect: 'allowed_effect_kinds_json',
} as const;

function parseList(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeCapabilities(value: JobCapabilities = {}): Required<JobCapabilities> {
  return {
    tools: value.tools === undefined ? ['*'] : [...value.tools],
    paths: value.paths === undefined
      ? ['*']
      : [...value.paths].map((path) => path === '*' ? path : resolvePortablePath(process.cwd(), path)),
    hosts: value.hosts === undefined ? ['*'] : [...value.hosts].map((host) => host.toLowerCase()),
    applications: value.applications === undefined ? ['*'] : [...value.applications],
    connections: value.connections === undefined ? ['*'] : [...value.connections],
    accounts: value.accounts === undefined ? ['*'] : [...value.accounts],
    workers: value.workers === undefined ? ['*'] : [...value.workers],
    effectKinds: value.effectKinds === undefined ? ['*'] : [...value.effectKinds],
  };
}

export function createJobResourceAuthority(db: Db): JobResourceAuthority {
  type ReservationRow = {
    reservation_id: string; idempotency_key: string; parent_job_id: string;
    parent_attempt_id: string; parent_generation: number; child_job_id: string;
    child_attempt_id: string; child_generation: number; worker_run_id: string;
    assignment_id: string; state: JobBudgetReservationState; created_at: number;
    updated_at: number; released_at: number | null;
    reconciliation_state: JobBudgetReservationRecord['reconciliationState'];
    reconciliation_reason: string | null; unknown_spend_pending: number;
    last_reconciled_at: number | null; settlement_blocked_at: number | null;
  };
  type ItemRow = {
    kind: JobBudgetKind; reserved_value: number; committed_value: number;
    released_value: number; has_unknown_usage: number;
    state: JobBudgetReservationItemRecord['state'];
  };
  const getReservation = (reservationId: string): JobBudgetReservationRecord | null => {
    const row = db.prepare('SELECT * FROM job_budget_reservations WHERE reservation_id=?')
      .get(reservationId) as ReservationRow | undefined;
    if (!row) return null;
    const items = (db.prepare(
      'SELECT kind,reserved_value,committed_value,released_value,has_unknown_usage,state FROM job_budget_reservation_items WHERE reservation_id=? ORDER BY kind',
    ).all(reservationId) as ItemRow[]).map((item) => ({
      kind: item.kind,
      reserved: item.reserved_value,
      committed: item.committed_value,
      released: item.released_value,
      hasUnknownUsage: item.has_unknown_usage === 1,
      state: item.state,
    }));
    return {
      reservationId: row.reservation_id,
      idempotencyKey: row.idempotency_key,
      parentJobId: row.parent_job_id,
      parentAttemptId: row.parent_attempt_id,
      parentGeneration: row.parent_generation,
      childJobId: row.child_job_id,
      childAttemptId: row.child_attempt_id,
      childGeneration: row.child_generation,
      workerRunId: row.worker_run_id,
      assignmentId: row.assignment_id,
      state: row.state,
      items,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      releasedAt: row.released_at,
      reconciliationState: row.reconciliation_state,
      reconciliationReason: row.reconciliation_reason,
      unknownSpendPending: row.unknown_spend_pending === 1,
      lastReconciledAt: row.last_reconciled_at,
      settlementBlockedAt: row.settlement_blocked_at,
    };
  };

  const activeAttempt = (jobId: string, attemptId: string, generation: number, fenceToken: string) => (
    db.prepare(
      `SELECT r.task_id,r.generation,r.fence_token,r.status,t.active_attempt_id,t.status AS job_status
         FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.attempt_id=?`,
    ).get(attemptId) as {
      task_id: string; generation: number; fence_token: string | null; status: string;
      active_attempt_id: string | null; job_status: string;
    } | undefined
  );
  const requireActiveAttempt = (jobId: string, attemptId: string, generation: number, fenceToken: string): void => {
    const attempt = activeAttempt(jobId, attemptId, generation, fenceToken);
    if (!attempt || attempt.task_id !== jobId || attempt.generation !== generation
      || attempt.fence_token !== fenceToken || attempt.active_attempt_id !== attemptId
      || /^(succeeded|failed|cancelled|timed_out|crashed|unknown)$/u.test(attempt.status)
      || /^(completed|failed|cancelled|dead_letter)$/u.test(attempt.job_status)) {
      throw new Error('Stale worker cannot reserve or consume Job budget');
    }
  };
  const requireReleasableAttempt = (jobId: string, attemptId: string, generation: number, fenceToken: string): void => {
    const attempt = activeAttempt(jobId, attemptId, generation, fenceToken);
    const terminalAttempt = /^(succeeded|failed|cancelled|timed_out|crashed|unknown)$/u.test(attempt?.status ?? '');
    const current = attempt?.active_attempt_id === attemptId && !terminalAttempt;
    const settled = attempt?.active_attempt_id === null && terminalAttempt;
    if (!attempt || attempt.task_id !== jobId || attempt.generation !== generation
      || attempt.fence_token !== fenceToken || (!current && !settled)) {
      throw new Error('Stale worker cannot release Job budget');
    }
  };

  const outstandingReserved = (jobId: string, kind: JobBudgetKind): number => {
    const row = db.prepare(
      `SELECT COALESCE(SUM(MAX(0,i.reserved_value-i.committed_value-i.released_value)),0) AS amount
         FROM job_budget_reservations r
         JOIN job_budget_reservation_items i ON i.reservation_id=r.reservation_id
        WHERE r.parent_job_id=? AND i.kind=?
          AND r.state IN ('reserved','partially_committed','committed','exhausted')`,
    ).get(jobId, kind) as { amount: number };
    return row.amount;
  };

  const available = (jobId: string, kind: JobBudgetKind): number | null => {
    const budget = db.prepare('SELECT limit_value,used_value FROM job_budgets WHERE job_id=? AND kind=?')
      .get(jobId, kind) as { limit_value: number | null; used_value: number } | undefined;
    if (!budget || budget.limit_value === null) return null;
    return Math.max(0, budget.limit_value - budget.used_value - outstandingReserved(jobId, kind));
  };

  const reserveWorker = db.transaction((command: Parameters<JobResourceAuthority['reserveWorker']>[0]) => {
    requireActiveAttempt(
      command.parentJobId, command.parentAttemptId, command.parentGeneration, command.parentFenceToken,
    );
    const child = db.prepare(
      `SELECT t.parent_task_id,t.active_attempt_id,r.generation
         FROM tasks t JOIN runs r ON r.attempt_id=t.active_attempt_id WHERE t.id=?`,
    ).get(command.childJobId) as {
      parent_task_id: string | null; active_attempt_id: string; generation: number;
    } | undefined;
    const assignment = db.prepare(
      'SELECT parent_job_id,child_job_id FROM worker_assignments WHERE assignment_id=?',
    ).get(command.assignmentId) as { parent_job_id: string; child_job_id: string } | undefined;
    if (!child || child.parent_task_id !== command.parentJobId
      || child.active_attempt_id !== command.childAttemptId || child.generation !== command.childGeneration
      || !assignment || assignment.parent_job_id !== command.parentJobId
      || assignment.child_job_id !== command.childJobId) {
      throw new Error('Worker budget reservation lineage is invalid');
    }
    const entries = Object.entries(command.amounts) as Array<[JobBudgetKind, number]>;
    if (entries.length === 0) throw new Error('Worker budget reservation requires at least one resource');
    for (const [kind, amount] of entries) {
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid ${kind} reservation`);
    }
    const existingByKey = db.prepare(
      'SELECT reservation_id FROM job_budget_reservations WHERE parent_job_id=? AND idempotency_key=?',
    ).get(command.parentJobId, command.idempotencyKey) as { reservation_id: string } | undefined;
    const existingById = getReservation(command.reservationId);
    const existing = existingByKey ? getReservation(existingByKey.reservation_id) : existingById;
    if (existing) {
      const same = existing.reservationId === command.reservationId
        && existing.parentAttemptId === command.parentAttemptId
        && existing.parentGeneration === command.parentGeneration
        && existing.childJobId === command.childJobId
        && existing.childAttemptId === command.childAttemptId
        && existing.childGeneration === command.childGeneration
        && existing.workerRunId === command.workerRunId
        && existing.assignmentId === command.assignmentId
        && JSON.stringify(existing.items.map((item) => [item.kind, item.reserved]))
          === JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
      if (!same) throw new Error('Worker budget reservation idempotency conflict');
      return existing;
    }
    for (const [kind, amount] of entries) {
      const remaining = available(command.parentJobId, kind);
      if (remaining !== null && amount > remaining) throw new Error(`Worker ${kind} reservation exceeds parent capacity`);
    }
    const now = command.now ?? Date.now();
    db.prepare(
      `INSERT INTO job_budget_reservations (
         reservation_id,idempotency_key,parent_job_id,parent_attempt_id,parent_generation,
         child_job_id,child_attempt_id,child_generation,worker_run_id,assignment_id,state,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`,
    ).run(
      command.reservationId, command.idempotencyKey, command.parentJobId, command.parentAttemptId,
      command.parentGeneration, command.childJobId, command.childAttemptId, command.childGeneration,
      command.workerRunId, command.assignmentId, now, now,
    );
    const insertItem = db.prepare(
      `INSERT INTO job_budget_reservation_items (
         reservation_id,kind,reserved_value,committed_value,released_value,has_unknown_usage,state,updated_at
       ) VALUES (?,?,?,0,0,0,'reserved',?)`,
    );
    for (const [kind, amount] of entries) insertItem.run(command.reservationId, kind, amount, now);
    return getReservation(command.reservationId)!;
  }).immediate;

  const applyDebit = (input: {
    jobId: string; attemptId: string; generation: number; kind: JobBudgetKind;
    amount: number | null; certainty: BudgetCertainty; idempotencyKey: string; now: number;
  }): boolean => {
    const existing = db.prepare(
      'SELECT kind,amount,certainty FROM job_budget_debits WHERE job_id=? AND idempotency_key=?',
    ).get(input.jobId, input.idempotencyKey) as {
      kind: JobBudgetKind; amount: number | null; certainty: BudgetCertainty;
    } | undefined;
    if (existing) {
      if (existing.kind !== input.kind || existing.amount !== input.amount || existing.certainty !== input.certainty) {
        throw new Error('Worker usage debit idempotency conflict');
      }
      return false;
    }
    const budget = db.prepare('SELECT used_value,has_unknown_usage FROM job_budgets WHERE job_id=? AND kind=?')
      .get(input.jobId, input.kind) as { used_value: number; has_unknown_usage: number } | undefined;
    if (!budget) return false;
    db.prepare(
      `INSERT INTO job_budget_debits
         (debit_id,job_id,attempt_id,generation,kind,amount,certainty,idempotency_key,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      `debit_${randomBytes(12).toString('hex')}`, input.jobId, input.attemptId, input.generation,
      input.kind, input.amount, input.certainty, input.idempotencyKey, input.now,
    );
    db.prepare(
      `UPDATE job_budgets SET used_value=used_value+?,has_unknown_usage=?,state_version=state_version+1,updated_at=?
        WHERE job_id=? AND kind=?`,
    ).run(
      input.amount ?? 0, input.amount === null ? 1 : budget.has_unknown_usage,
      input.now, input.jobId, input.kind,
    );
    return true;
  };

  const commitWorkerUsage = db.transaction((command: Parameters<JobResourceAuthority['commitWorkerUsage']>[0]) => {
    const reservation = getReservation(command.reservationId);
    if (!reservation) throw new Error('Worker budget reservation was not found');
    requireActiveAttempt(
      reservation.childJobId, command.childAttemptId, command.childGeneration, command.childFenceToken,
    );
    if (reservation.childAttemptId !== command.childAttemptId
      || reservation.childGeneration !== command.childGeneration) throw new Error('Worker budget reservation Attempt is stale');
    const prior = db.prepare(
      'SELECT kind,amount,certainty,source_kind,source_id FROM job_budget_reservation_commits WHERE reservation_id=? AND idempotency_key=?',
    ).get(command.reservationId, command.idempotencyKey) as {
      kind: JobBudgetKind; amount: number | null; certainty: BudgetCertainty;
      source_kind: string; source_id: string;
    } | undefined;
    if (prior) {
      if (prior.kind !== command.kind || prior.amount !== command.amount || prior.certainty !== command.certainty
        || prior.source_kind !== command.sourceKind || prior.source_id !== command.sourceId) {
        throw new Error('Worker usage commit idempotency conflict');
      }
      const item = reservation.items.find((candidate) => candidate.kind === command.kind)!;
      return { applied: false, duplicate: true, exhausted: item.state === 'exhausted', remaining: Math.max(0, item.reserved - item.committed - item.released) };
    }
    const item = reservation.items.find((candidate) => candidate.kind === command.kind);
    if (!item) throw new Error(`Worker ${command.kind} usage is outside the reservation`);
    const amount = command.certainty === 'unknown' ? null : command.amount;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error('Worker usage must be non-negative');
    const parentAttempt = db.prepare(
      `SELECT r.generation,r.status,t.active_attempt_id,t.status AS job_status
         FROM runs r JOIN tasks t ON t.id=r.task_id
        WHERE r.attempt_id=? AND r.task_id=?`,
    ).get(reservation.parentAttemptId, reservation.parentJobId) as {
      generation: number; status: string; active_attempt_id: string | null; job_status: string;
    } | undefined;
    if (!parentAttempt || parentAttempt.generation !== reservation.parentGeneration
      || parentAttempt.active_attempt_id !== reservation.parentAttemptId
      || /^(succeeded|failed|cancelled|timed_out|crashed|unknown)$/u.test(parentAttempt.status)
      || /^(completed|failed|cancelled|dead_letter)$/u.test(parentAttempt.job_status)) {
      throw new Error('Parent Worker budget authority is stale');
    }
    const now = command.now ?? Date.now();
    applyDebit({
      jobId: reservation.childJobId, attemptId: reservation.childAttemptId,
      generation: reservation.childGeneration, kind: command.kind, amount,
      certainty: command.certainty, idempotencyKey: command.idempotencyKey, now,
    });
    applyDebit({
      jobId: reservation.parentJobId, attemptId: reservation.parentAttemptId,
      generation: reservation.parentGeneration, kind: command.kind, amount,
      certainty: command.certainty, idempotencyKey: `worker-rollup:${reservation.reservationId}:${command.idempotencyKey}`, now,
    });
    db.prepare(
      `INSERT INTO job_budget_reservation_commits
         (commit_id,reservation_id,kind,amount,certainty,source_kind,source_id,idempotency_key,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      `budget_commit_${randomBytes(12).toString('hex')}`, reservation.reservationId, command.kind,
      amount, command.certainty, command.sourceKind, command.sourceId, command.idempotencyKey, now,
    );
    const nextCommitted = amount === null ? item.reserved : item.committed + amount;
    const exhausted = amount === null || nextCommitted >= item.reserved;
    const itemState: JobBudgetReservationItemRecord['state'] = amount === null
      ? 'unknown' : nextCommitted > item.reserved ? 'exhausted' : exhausted ? 'committed' : 'partially_committed';
    db.prepare(
      `UPDATE job_budget_reservation_items
          SET committed_value=?,has_unknown_usage=?,state=?,updated_at=? WHERE reservation_id=? AND kind=?`,
    ).run(nextCommitted, amount === null ? 1 : item.hasUnknownUsage ? 1 : 0, itemState, now, reservation.reservationId, command.kind);
    const all = (db.prepare(
      'SELECT state FROM job_budget_reservation_items WHERE reservation_id=?',
    ).all(reservation.reservationId) as Array<{ state: JobBudgetReservationItemRecord['state'] }>).map((row) => row.state);
    const nextState: JobBudgetReservationState = all.some((state) => state === 'exhausted' || state === 'unknown')
      ? 'exhausted'
      : all.every((state) => state === 'committed') ? 'committed' : 'partially_committed';
    db.prepare('UPDATE job_budget_reservations SET state=?,updated_at=? WHERE reservation_id=?')
      .run(nextState, now, reservation.reservationId);
    return { applied: true, exhausted, remaining: Math.max(0, item.reserved - nextCommitted - item.released) };
  }).immediate;

  const requireReconciliationLineage = (
    reservation: JobBudgetReservationRecord,
    logicalCallId: string,
  ): void => {
    const call = db.prepare(
      `SELECT worker_run_id,assignment_id,child_job_id,child_attempt_id,child_generation
         FROM worker_logical_provider_calls WHERE logical_call_id=?`,
    ).get(logicalCallId) as {
      worker_run_id: string; assignment_id: string; child_job_id: string;
      child_attempt_id: string; child_generation: number;
    } | undefined;
    if (!call || call.worker_run_id !== reservation.workerRunId || call.assignment_id !== reservation.assignmentId
      || call.child_job_id !== reservation.childJobId || call.child_attempt_id !== reservation.childAttemptId
      || call.child_generation !== reservation.childGeneration) {
      throw new Error('Worker budget reconciliation lineage is invalid');
    }
  };

  const refreshReservationItem = (
    reservation: JobBudgetReservationRecord,
    kind: JobBudgetKind,
    now: number,
  ): { exhausted: boolean; remaining: number } => {
    const item = getReservation(reservation.reservationId)?.items.find((candidate) => candidate.kind === kind);
    if (!item) throw new Error(`Worker ${kind} usage is outside the reservation`);
    const sums = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount IS NULL THEN 0 ELSE amount END),0) AS known,
              MAX(CASE WHEN amount IS NULL OR certainty='unknown' THEN 1 ELSE 0 END) AS unknown
         FROM job_budget_reservation_commits WHERE reservation_id=? AND kind=?`,
    ).get(reservation.reservationId, kind) as { known: number; unknown: number | null };
    const unknown = (sums.unknown ?? 0) === 1;
    const committed = unknown ? Math.max(item.reserved, sums.known) : sums.known;
    const exhausted = unknown || committed >= item.reserved;
    const state: JobBudgetReservationItemRecord['state'] = unknown
      ? 'unknown' : committed > item.reserved ? 'exhausted' : exhausted ? 'committed' : 'partially_committed';
    db.prepare(
      `UPDATE job_budget_reservation_items
          SET committed_value=?,has_unknown_usage=?,state=?,updated_at=? WHERE reservation_id=? AND kind=?`,
    ).run(committed, unknown ? 1 : item.hasUnknownUsage ? 1 : 0, state, now, reservation.reservationId, kind);
    const states = db.prepare('SELECT state FROM job_budget_reservation_items WHERE reservation_id=?')
      .all(reservation.reservationId) as Array<{ state: JobBudgetReservationItemRecord['state'] }>;
    const reservationState: JobBudgetReservationState = states.some((row) => row.state === 'unknown' || row.state === 'exhausted')
      ? 'exhausted' : states.every((row) => row.state === 'committed') ? 'committed' : 'partially_committed';
    db.prepare('UPDATE job_budget_reservations SET state=?,updated_at=? WHERE reservation_id=?')
      .run(reservationState, now, reservation.reservationId);
    return { exhausted, remaining: Math.max(0, item.reserved - committed - item.released) };
  };

  const reconcileWorkerUsage = db.transaction((command: Parameters<JobResourceAuthority['reconcileWorkerUsage']>[0]) => {
    const reservation = getReservation(command.reservationId);
    if (!reservation) throw new Error('Worker budget reservation was not found');
    requireReconciliationLineage(reservation, command.logicalCallId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(command.providerAttemptId)) {
      throw new Error('ProviderAttempt reconciliation identity is invalid');
    }
    const item = reservation.items.find((candidate) => candidate.kind === command.kind);
    if (!item) throw new Error(`Worker ${command.kind} usage is outside the reservation`);
    const amount = command.certainty === 'unknown' ? null : command.amount;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error('Worker usage must be non-negative');
    const prior = db.prepare(
      `SELECT kind,amount,certainty,source_kind,source_id FROM job_budget_reservation_commits
        WHERE reservation_id=? AND idempotency_key=?`,
    ).get(command.reservationId, command.idempotencyKey) as {
      kind: JobBudgetKind; amount: number | null; certainty: BudgetCertainty;
      source_kind: string; source_id: string;
    } | undefined;
    if (prior && (prior.kind !== command.kind || prior.amount !== amount || prior.certainty !== command.certainty
      || prior.source_kind !== 'provider_attempt' || prior.source_id !== command.providerAttemptId)) {
      throw new Error('Worker usage reconciliation idempotency conflict');
    }
    const now = command.now ?? Date.now();
    const childApplied = applyDebit({
      jobId: reservation.childJobId, attemptId: reservation.childAttemptId,
      generation: reservation.childGeneration, kind: command.kind, amount,
      certainty: command.certainty, idempotencyKey: command.idempotencyKey, now,
    });
    const parentApplied = applyDebit({
      jobId: reservation.parentJobId, attemptId: reservation.parentAttemptId,
      generation: reservation.parentGeneration, kind: command.kind, amount,
      certainty: command.certainty,
      idempotencyKey: `worker-rollup:${reservation.reservationId}:${command.idempotencyKey}`,
      now,
    });
    if (!prior) {
      db.prepare(
        `INSERT INTO job_budget_reservation_commits
           (commit_id,reservation_id,kind,amount,certainty,source_kind,source_id,idempotency_key,created_at)
         VALUES (?,?,?,?,?,'provider_attempt',?,?,?)`,
      ).run(
        `budget_commit_${randomBytes(12).toString('hex')}`, reservation.reservationId,
        command.kind, amount, command.certainty, command.providerAttemptId, command.idempotencyKey, now,
      );
    }
    const refreshed = refreshReservationItem(reservation, command.kind, now);
    const repaired = Boolean(prior && (childApplied || parentApplied));
    return {
      applied: !prior || repaired,
      ...(prior && !repaired ? { duplicate: true } : {}),
      ...(repaired ? { repaired: true } : {}),
      ...refreshed,
    };
  }).immediate;

  const reconcileWorkerReservation = db.transaction((
    command: Parameters<JobResourceAuthority['reconcileWorkerReservation']>[0],
  ) => {
    const reservation = getReservation(command.reservationId);
    if (!reservation) throw new Error('Worker budget reservation was not found');
    requireReconciliationLineage(reservation, command.logicalCallId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(command.reason)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(command.idempotencyKey)) {
      throw new Error('Worker reservation reconciliation contract is invalid');
    }
    const existing = db.prepare(
      `SELECT logical_call_id,outcome_knowledge,retry_safety,unknown_spend,safe_to_release,reason
         FROM job_budget_reservation_reconciliations WHERE reservation_id=? AND idempotency_key=?`,
    ).get(command.reservationId, command.idempotencyKey) as {
      logical_call_id: string; outcome_knowledge: string; retry_safety: string;
      unknown_spend: number; safe_to_release: number; reason: string;
    } | undefined;
    if (existing) {
      const same = existing.logical_call_id === command.logicalCallId
        && existing.outcome_knowledge === command.outcomeKnowledge
        && existing.retry_safety === command.retrySafety
        && existing.unknown_spend === (command.unknownSpend ? 1 : 0)
        && existing.safe_to_release === (command.safeToRelease ? 1 : 0)
        && existing.reason === command.reason;
      if (!same) throw new Error('Worker reservation reconciliation idempotency conflict');
      return getReservation(command.reservationId)!;
    }
    const now = command.now ?? Date.now();
    const reconciliationId = `budget_reconcile_${randomBytes(12).toString('hex')}`;
    db.prepare(
      `INSERT INTO job_budget_reservation_reconciliations
         (reconciliation_id,reservation_id,logical_call_id,idempotency_key,outcome_knowledge,
          retry_safety,unknown_spend,safe_to_release,reason,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      reconciliationId, command.reservationId, command.logicalCallId, command.idempotencyKey,
      command.outcomeKnowledge, command.retrySafety, command.unknownSpend ? 1 : 0,
      command.safeToRelease ? 1 : 0, command.reason, now,
    );
    if (command.unknownSpend) {
      db.prepare(
        `UPDATE job_budget_reservations
            SET reconciliation_state='blocked_unknown',reconciliation_reason=?,unknown_spend_pending=1,
                last_reconciled_at=?,settlement_blocked_at=COALESCE(settlement_blocked_at,?),updated_at=?
          WHERE reservation_id=?`,
      ).run(command.reason, now, now, now, command.reservationId);
      return getReservation(command.reservationId)!;
    }
    if (command.safeToRelease) {
      for (const candidate of reservation.items) {
        const release = candidate.hasUnknownUsage ? 0 : Math.max(0, candidate.reserved - candidate.committed - candidate.released);
        const state: JobBudgetReservationItemRecord['state'] = candidate.hasUnknownUsage
          ? 'unknown' : candidate.state === 'exhausted' ? 'exhausted' : 'released';
        db.prepare(
          `UPDATE job_budget_reservation_items SET released_value=released_value+?,state=?,updated_at=?
            WHERE reservation_id=? AND kind=?`,
        ).run(release, state, now, command.reservationId, candidate.kind);
      }
      db.prepare(
        `UPDATE job_budget_reservations
            SET state='reconciled',reconciliation_state='reconciled',reconciliation_reason=?,
                unknown_spend_pending=0,last_reconciled_at=?,released_at=COALESCE(released_at,?),updated_at=?
          WHERE reservation_id=?`,
      ).run(command.reason, now, now, now, command.reservationId);
    } else {
      db.prepare(
        `UPDATE job_budget_reservations
            SET reconciliation_state='pending',reconciliation_reason=?,last_reconciled_at=?,updated_at=?
          WHERE reservation_id=?`,
      ).run(command.reason, now, now, command.reservationId);
    }
    return getReservation(command.reservationId)!;
  }).immediate;

  const releaseWorker = db.transaction((command: Parameters<JobResourceAuthority['releaseWorker']>[0]) => {
    const reservation = getReservation(command.reservationId);
    if (!reservation) throw new Error('Worker budget reservation was not found');
    if (reservation.childAttemptId !== command.childAttemptId || reservation.childGeneration !== command.childGeneration) {
      throw new Error('Worker budget reservation Attempt is stale');
    }
    if (reservation.state === 'released' || reservation.state === 'cancelled' || reservation.state === 'reconciled') return reservation;
    requireReleasableAttempt(
      reservation.childJobId, command.childAttemptId, command.childGeneration, command.childFenceToken,
    );
    const now = command.now ?? Date.now();
    if (reservation.unknownSpendPending || reservation.items.some((item) => item.hasUnknownUsage)) {
      db.prepare(
        `UPDATE job_budget_reservations
            SET reconciliation_state='blocked_unknown',unknown_spend_pending=1,
                reconciliation_reason=COALESCE(reconciliation_reason,'unknown_spend'),
                settlement_blocked_at=COALESCE(settlement_blocked_at,?),updated_at=?
          WHERE reservation_id=?`,
      ).run(now, now, reservation.reservationId);
      return getReservation(reservation.reservationId)!;
    }
    for (const item of reservation.items) {
      const release = Math.max(0, item.reserved - item.committed - item.released);
      const state: JobBudgetReservationItemRecord['state'] = item.state === 'exhausted' ? 'exhausted' : 'released';
      db.prepare(
        'UPDATE job_budget_reservation_items SET released_value=released_value+?,state=?,updated_at=? WHERE reservation_id=? AND kind=?',
      ).run(release, state, now, reservation.reservationId, item.kind);
    }
    const state: JobBudgetReservationState = command.cancelled ? 'cancelled' : 'released';
    db.prepare('UPDATE job_budget_reservations SET state=?,updated_at=?,released_at=? WHERE reservation_id=?')
      .run(state, now, now, reservation.reservationId);
    return getReservation(reservation.reservationId)!;
  }).immediate;

  return {
    reserveWorker,
    getWorkerReservation: getReservation,
    getWorkerReservationForChild(childJobId) {
      const row = db.prepare('SELECT reservation_id FROM job_budget_reservations WHERE child_job_id=?')
        .get(childJobId) as { reservation_id: string } | undefined;
      return row ? getReservation(row.reservation_id) : null;
    },
    listWorkerReservations(parentJobId) {
      const rows = db.prepare(
        'SELECT reservation_id FROM job_budget_reservations WHERE parent_job_id=? ORDER BY created_at,reservation_id',
      ).all(parentJobId) as Array<{ reservation_id: string }>;
      return rows.map((row) => getReservation(row.reservation_id)!).filter(Boolean);
    },
    available,
    commitWorkerUsage,
    releaseWorker,
    reconcileWorkerUsage,
    reconcileWorkerReservation,
    configure(command) {
      const now = command.now ?? Date.now();
      db.transaction(() => {
        const job = db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(command.jobId) as
          { parent_task_id: string | null } | undefined;
        if (!job) throw new Error(`Job not found: ${command.jobId}`);
        for (const [kind, requested] of Object.entries(command.budgets ?? {}) as Array<[JobBudgetKind, number | null]>) {
          if (requested !== null && (!Number.isFinite(requested) || requested < 0)) {
            throw new Error(`Invalid ${kind} budget`);
          }
          if (job.parent_task_id) {
            const parent = db.prepare('SELECT limit_value, used_value FROM job_budgets WHERE job_id = ? AND kind = ?')
              .get(job.parent_task_id, kind) as { limit_value: number | null; used_value: number } | undefined;
            const parentRemaining = parent?.limit_value === null || parent === undefined
              ? null
              : Math.max(0, parent.limit_value - parent.used_value);
            if (parentRemaining !== null && (requested === null || requested > parentRemaining)) {
              throw new Error(`Child ${kind} budget exceeds parent remaining budget`);
            }
          }
          db.prepare(
            `INSERT INTO job_budgets (job_id, kind, limit_value, used_value, has_unknown_usage, state_version, updated_at)
             VALUES (?, ?, ?, 0, 0, 0, ?)`,
          ).run(command.jobId, kind, requested, now);
        }
        const capabilities = normalizeCapabilities(command.capabilities);
        if (job.parent_task_id) {
          const parent = db.prepare('SELECT * FROM job_capability_sets WHERE job_id = ?').get(job.parent_task_id) as
            Record<string, string> | undefined;
          if (parent) {
            for (const [kind, column] of Object.entries(CAPABILITY_COLUMN)) {
              const parentValues = parseList(parent[column]!);
              const childValues = capabilities[`${kind === 'effect' ? 'effectKinds' : `${kind}s`}` as keyof JobCapabilities] ?? [];
              const exceedsParent = !parentValues.includes('*') && (kind === 'path'
                ? childValues.some((item) => item === '*' || !parentValues.some((root) => isPortablePathWithin(item, root)))
                : childValues.some((item) => item === '*' || !parentValues.includes(item)));
              if (exceedsParent) {
                throw new Error(`Child ${kind} capability exceeds parent boundary`);
              }
            }
          }
        }
        db.prepare(
          `INSERT INTO job_capability_sets (
             job_id, allowed_tools_json, allowed_paths_json, allowed_hosts_json,
             allowed_applications_json, allowed_connections_json, allowed_accounts_json,
             allowed_workers_json, allowed_effect_kinds_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          command.jobId, JSON.stringify(capabilities.tools), JSON.stringify(capabilities.paths),
          JSON.stringify(capabilities.hosts), JSON.stringify(capabilities.applications),
          JSON.stringify(capabilities.connections), JSON.stringify(capabilities.accounts),
          JSON.stringify(capabilities.workers), JSON.stringify(capabilities.effectKinds), now, now,
        );
      }).immediate();
    },
    getBudgets(jobId) {
      const rows = db.prepare(
        'SELECT job_id, kind, limit_value, used_value, has_unknown_usage, state_version FROM job_budgets WHERE job_id = ? ORDER BY kind',
      ).all(jobId) as Array<{
        job_id: string; kind: JobBudgetKind; limit_value: number | null; used_value: number;
        has_unknown_usage: number; state_version: number;
      }>;
      return rows.map((row) => ({
        jobId: row.job_id, kind: row.kind, limit: row.limit_value, used: row.used_value,
        hasUnknownUsage: row.has_unknown_usage === 1, stateVersion: row.state_version,
      }));
    },
    debit(command) {
      return db.transaction(() => {
        const prior = db.prepare('SELECT 1 FROM job_budget_debits WHERE job_id = ? AND idempotency_key = ?')
          .get(command.jobId, command.idempotencyKey);
        const budget = db.prepare('SELECT * FROM job_budgets WHERE job_id = ? AND kind = ?')
          .get(command.jobId, command.kind) as {
            limit_value: number | null; used_value: number; state_version: number; has_unknown_usage: number;
          } | undefined;
        if (!budget) throw new Error(`Budget not configured: ${command.kind}`);
        const remaining = budget.limit_value === null ? null : Math.max(0, budget.limit_value - budget.used_value);
        if (prior) return { applied: false, duplicate: true, remaining };
        const attempt = db.prepare(
          `SELECT r.task_id, r.generation, r.fence_token, r.status AS attempt_status,
                  t.active_attempt_id, t.status AS job_status
             FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.attempt_id = ?`,
        ).get(command.attemptId) as {
          task_id: string; generation: number; fence_token: string | null; attempt_status: string;
          active_attempt_id: string | null; job_status: string;
        } | undefined;
        const terminalAccounting = attempt?.active_attempt_id === null
          && /^(succeeded|failed|cancelled|timed_out|crashed|unknown)$/.test(attempt.attempt_status)
          && /^(completed|failed|cancelled|dead_letter)$/.test(attempt.job_status);
        if (
          !attempt || attempt.task_id !== command.jobId
          || (attempt.active_attempt_id !== command.attemptId && !terminalAccounting)
          || attempt.generation !== command.generation || attempt.fence_token !== command.fenceToken
        ) throw new Error('Stale worker cannot debit Job budget');
        const amount = command.certainty === 'unknown' ? null : command.amount;
        if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error('Budget debit must be non-negative');
        const exceedsLimit = amount !== null && budget.limit_value !== null && budget.used_value + amount > budget.limit_value;
        if (exceedsLimit && command.enforceLimit !== false) {
          return { applied: false, exhausted: true, remaining };
        }
        db.prepare(
          `INSERT INTO job_budget_debits
             (debit_id, job_id, attempt_id, generation, kind, amount, certainty, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `debit_${randomBytes(12).toString('hex')}`, command.jobId, command.attemptId,
          command.generation, command.kind, amount, command.certainty,
          command.idempotencyKey, command.now ?? Date.now(),
        );
        const nextUsed = budget.used_value + (amount ?? 0);
        db.prepare(
          `UPDATE job_budgets SET used_value = ?, has_unknown_usage = ?,
             state_version = state_version + 1, updated_at = ? WHERE job_id = ? AND kind = ? AND state_version = ?`,
        ).run(
          nextUsed, amount === null ? 1 : budget.has_unknown_usage, command.now ?? Date.now(),
          command.jobId, command.kind, budget.state_version,
        );
        return {
          applied: true,
          ...(exceedsLimit ? { exhausted: true } : {}),
          remaining: budget.limit_value === null ? null : Math.max(0, budget.limit_value - nextUsed),
        };
      }).immediate();
    },
    authorize(command) {
      const column = CAPABILITY_COLUMN[command.kind];
      const row = db.prepare(`SELECT ${column} AS allowed FROM job_capability_sets WHERE job_id = ?`)
        .get(command.jobId) as { allowed: string } | undefined;
      if (!row) return true;
      const allowed = parseList(row.allowed);
      if (allowed.includes('*')) return true;
      if (allowed.length === 0) return false;
      if (command.kind === 'path') {
        const candidate = resolvePortablePath(process.cwd(), command.value);
        return allowed.some((root) => isPortablePathWithin(candidate, root));
      }
      if (command.kind === 'host') return allowed.includes(command.value.toLowerCase());
      return allowed.includes(command.value);
    },
  };
}
