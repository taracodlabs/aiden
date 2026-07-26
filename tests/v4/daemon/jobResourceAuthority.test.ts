/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';

let db: Database.Database;
let jobs: JobEngine;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES ('resource-test', 1, 'localhost', ?, ?, '4.16.1')`,
  ).run(now, now);
  jobs = createJobEngine({ db });
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

function submit(key: string, parentJobId?: string) {
  return jobs.submitJob({
    entryPoint: 'test', source: 'test', sessionId: `session-${key}`, instanceId: 'resource-test',
    idempotencyNamespace: 'resource-test', idempotencyKey: key, requestFingerprint: key,
    goal: key, parentJobId, rootJobId: parentJobId,
  });
}

function claim(admission: ReturnType<typeof submit>) {
  const lease = jobs.claimAttempt({ attemptId: admission.attemptId, ownerId: 'resource-owner', ttlMs: 30_000 });
  if (!lease.fenceToken || lease.generation === undefined) throw new Error('lease unavailable');
  return { generation: lease.generation, fenceToken: lease.fenceToken };
}

describe('JobResourceAuthority', () => {
  it('atomically rejects spending beyond a durable limit and survives reconstruction', () => {
    const job = submit('durable-budget');
    const lease = claim(job);
    jobs.resources.configure({ jobId: job.jobId, budgets: { tool_calls: 2 } });

    for (const key of ['one', 'two']) {
      expect(jobs.resources.debit({
        jobId: job.jobId, attemptId: job.attemptId, generation: lease.generation,
        fenceToken: lease.fenceToken, kind: 'tool_calls', amount: 1,
        certainty: 'confirmed', idempotencyKey: key,
      }).applied).toBe(true);
    }
    expect(jobs.resources.debit({
      jobId: job.jobId, attemptId: job.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, kind: 'tool_calls', amount: 1,
      certainty: 'confirmed', idempotencyKey: 'three',
    })).toMatchObject({ applied: false, exhausted: true, remaining: 0 });

    const reopened = createJobEngine({ db });
    expect(reopened.resources.getBudgets(job.jobId)).toMatchObject([
      { kind: 'tool_calls', limit: 2, used: 2, hasUnknownUsage: false },
    ]);
  });

  it('rejects a stale worker and keeps duplicate debits idempotent', () => {
    const job = submit('stale-budget');
    const lease = claim(job);
    jobs.resources.configure({ jobId: job.jobId, budgets: { model_calls: 3 } });
    const command = {
      jobId: job.jobId, attemptId: job.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, kind: 'model_calls' as const, amount: 1,
      certainty: 'confirmed' as const, idempotencyKey: 'provider-one',
    };
    expect(jobs.resources.debit(command).applied).toBe(true);
    expect(jobs.resources.debit(command)).toMatchObject({ applied: false, duplicate: true, remaining: 2 });
    expect(() => jobs.resources.debit({ ...command, fenceToken: 'replacement-fence', idempotencyKey: 'stale' }))
      .toThrow(/Stale worker/);
  });

  it('enforces a child lower bound for budgets and capabilities', () => {
    const parent = submit('parent-budget');
    jobs.resources.configure({
      jobId: parent.jobId,
      budgets: { model_calls: 5 },
      capabilities: { tools: ['file_read'], paths: ['C:\\workspace'] },
    });
    const child = submit('child-budget', parent.jobId);

    expect(() => jobs.resources.configure({
      jobId: child.jobId, budgets: { model_calls: 6 }, capabilities: { tools: ['file_read'] },
    })).toThrow(/exceeds parent/);
    expect(() => jobs.resources.configure({
      jobId: child.jobId, budgets: { model_calls: 4 }, capabilities: { tools: ['shell_exec'] },
    })).toThrow(/capability exceeds parent/);
    jobs.resources.configure({
      jobId: child.jobId,
      budgets: { model_calls: 4 },
      capabilities: { tools: ['file_read'], paths: ['C:\\workspace\\child'] },
    });
    expect(jobs.resources.authorize({ jobId: child.jobId, kind: 'tool', value: 'file_read' })).toBe(true);
    expect(jobs.resources.authorize({ jobId: child.jobId, kind: 'tool', value: 'file_write' })).toBe(false);
  });

  it('preserves unknown cost as unknown rather than zero', () => {
    const job = submit('unknown-cost');
    const lease = claim(job);
    jobs.resources.configure({ jobId: job.jobId, budgets: { external_cost: null } });
    expect(jobs.resources.debit({
      jobId: job.jobId, attemptId: job.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, kind: 'external_cost', amount: null,
      certainty: 'unknown', idempotencyKey: 'unknown-cost',
    }).applied).toBe(true);
    expect(jobs.resources.getBudgets(job.jobId)).toMatchObject([
      { kind: 'external_cost', limit: null, used: 0, hasUnknownUsage: true },
    ]);
  });

  it('enforces canonical path boundaries', () => {
    const job = submit('path-boundary');
    jobs.resources.configure({ jobId: job.jobId, capabilities: { paths: ['C:\\workspace\\safe'] } });
    expect(jobs.resources.authorize({
      jobId: job.jobId, kind: 'path', value: 'C:\\workspace\\safe\\nested\\file.txt',
    })).toBe(true);
    expect(jobs.resources.authorize({
      jobId: job.jobId, kind: 'path', value: 'C:\\workspace\\safe\\..\\escape.txt',
    })).toBe(false);
    expect(jobs.resources.authorize({
      jobId: job.jobId, kind: 'path', value: 'c:\\WORKSPACE\\safe\\nested\\case-insensitive.txt',
    })).toBe(true);
  });
});
