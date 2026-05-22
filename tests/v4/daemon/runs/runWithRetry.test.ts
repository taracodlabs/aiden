/**
 * tests/v4/daemon/runs/runWithRetry.test.ts — v4.9.0 Slice 8.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { runWithRetry } from '../../../../core/v4/daemon/runs/runWithRetry';
import { listAttemptsForRun } from '../../../../core/v4/daemon/runs/attemptStore';
import { DEFAULT_RETRY_POLICY } from '../../../../core/v4/daemon/runs/retryPolicy';
import {
  newIncarnationId, newRunId, newTraceId, newSpanId,
  type ExecutionContext,
} from '../../../../core/v4/identity';
import type { Db } from '../../../../core/v4/daemon/db/connection';

let db: Db;

function seedRun(): { runId: number; incId: string; ctx: ExecutionContext } {
  const incId = newIncarnationId();
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, 1, 'host', ?, ?, 'v')`,
  ).run(incId, Date.now(), Date.now());
  const r = db.prepare(
    `INSERT INTO runs (session_id, instance_id, status, started_at) VALUES ('s', ?, 'running', ?)`,
  ).run(incId, Date.now());
  const runId = Number(r.lastInsertRowid);
  const ctx: ExecutionContext = {
    daemonId: 'dmn_t', incarnationId: incId, runId: newRunId(),
    traceId: newTraceId(), spanId: newSpanId(), source: 'cli', attempt: 1,
  };
  return { runId, incId, ctx };
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('runWithRetry — Slice 8', () => {
  it('completed on first attempt', async () => {
    const { runId, incId, ctx } = seedRun();
    const result = await runWithRetry(db, ctx,
      { runId, incarnationId: incId, policy: DEFAULT_RETRY_POLICY, sleep: async () => {} },
      async () => 'ok',
    );
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.value).toBe('ok');
      expect(result.attempts).toBe(1);
    }
    expect(listAttemptsForRun(db, runId).map((a) => a.status)).toEqual(['completed']);
  });

  it('retries on transient + succeeds eventually', async () => {
    const { runId, incId, ctx } = seedRun();
    let tries = 0;
    const result = await runWithRetry(db, ctx,
      { runId, incarnationId: incId, policy: DEFAULT_RETRY_POLICY, sleep: async () => {} },
      async () => {
        tries += 1;
        if (tries < 3) { const e = new Error('flaky'); e.name = 'NetworkError'; throw e; }
        return 'finally';
      },
    );
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') expect(result.attempts).toBe(3);
    const attempts = listAttemptsForRun(db, runId);
    expect(attempts.length).toBe(3);
    expect(attempts.map((a) => a.status)).toEqual(['failed', 'failed', 'completed']);
  });

  it('non-retryable returns dead_letter immediately', async () => {
    const { runId, incId, ctx } = seedRun();
    const result = await runWithRetry(db, ctx,
      { runId, incarnationId: incId, policy: DEFAULT_RETRY_POLICY, sleep: async () => {} },
      async () => { const e = new Error('nope'); e.name = 'AuthError'; throw e; },
    );
    expect(result.outcome).toBe('dead_letter');
    if (result.outcome === 'dead_letter') {
      expect(result.attempts).toBe(1);
      expect(result.lastError.name).toBe('AuthError');
    }
    expect(listAttemptsForRun(db, runId).length).toBe(1);
  });

  it('max-attempts cap on retryable → dead_letter', async () => {
    const { runId, incId, ctx } = seedRun();
    const result = await runWithRetry(db, ctx,
      { runId, incarnationId: incId, policy: DEFAULT_RETRY_POLICY, sleep: async () => {} },
      async () => { const e = new Error('lasting'); e.name = 'TimeoutError'; throw e; },
    );
    expect(result.outcome).toBe('dead_letter');
    if (result.outcome === 'dead_letter') expect(result.attempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(listAttemptsForRun(db, runId).length).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
  });

  it('unknown error class returns failed (not dead_letter)', async () => {
    const { runId, incId, ctx } = seedRun();
    const result = await runWithRetry(db, ctx,
      { runId, incarnationId: incId, policy: DEFAULT_RETRY_POLICY, sleep: async () => {} },
      async () => { const e = new Error('mystery'); e.name = 'WeirdError'; throw e; },
    );
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') expect(result.attempts).toBe(1);
  });

  it('ctx.attempt is incremented on each attempt visible to fn', async () => {
    const { runId, incId, ctx } = seedRun();
    const seen: number[] = [];
    await runWithRetry(db, ctx,
      { runId, incarnationId: incId, policy: DEFAULT_RETRY_POLICY, sleep: async () => {} },
      async (childCtx, n) => {
        seen.push(childCtx.attempt);
        if (n < 2) { const e = new Error('once'); e.name = 'NetworkError'; throw e; }
        return 'done';
      },
    );
    expect(seen).toEqual([1, 2]);
  });
});
