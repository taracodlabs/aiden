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
  return {
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
