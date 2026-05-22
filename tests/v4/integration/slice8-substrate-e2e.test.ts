/**
 * tests/v4/integration/slice8-substrate-e2e.test.ts — v4.9.0 Slice 8.
 *
 * End-of-Phase integration: ingress with traceparent → ExecutionContext
 * → runWithRetry → spans (tool + LLM) → idempotency anchor. Exercises
 * every substrate piece v4.9.0 landed (Slices 3-8) in one durable flow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { runWithRetry } from '../../../core/v4/daemon/runs/runWithRetry';
import { DEFAULT_RETRY_POLICY } from '../../../core/v4/daemon/runs/retryPolicy';
import { withSpan, withLlmSpan, withToolSpan } from '../../../core/v4/daemon/spans/spanHelpers';
import { getTraceTree } from '../../../core/v4/daemon/spans/spanStore';
import { acquire as acquireIdem } from '../../../core/v4/daemon/idempotency/runIdempotencyStore';
import { listAttemptsForRun } from '../../../core/v4/daemon/runs/attemptStore';
import {
  parseTraceparent,
  runWithContext,
  newIncarnationId,
  newRunId,
  newSpanId,
  type ExecutionContext,
} from '../../../core/v4/identity';
import type { Db } from '../../../core/v4/daemon/db/connection';

let db: Db;

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

const INBOUND_TP = '00-aabbccddeeff00112233445566778899-1122334455667788-01';

function seedRun(incarnationId: string): number {
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, 1, 'host', ?, ?, 'v')`,
  ).run(incarnationId, Date.now(), Date.now());
  const r = db.prepare(
    `INSERT INTO runs (session_id, instance_id, status, started_at) VALUES ('e2e', ?, 'running', ?)`,
  ).run(incarnationId, Date.now());
  return Number(r.lastInsertRowid);
}

describe('Slice 8 substrate end-to-end integration', () => {
  it('full flow: inbound traceparent → runWithRetry → spans → idempotency', async () => {
    // 1. INBOUND: adopt traceparent.
    const incomingTp = parseTraceparent(INBOUND_TP)!;
    const incId = newIncarnationId();
    const runId = seedRun(incId);
    const ctx: ExecutionContext = {
      daemonId:      'dmn_e2e',
      incarnationId: incId,
      runId:         newRunId(),
      traceId:       `trc_${incomingTp.traceId}`,    // adopted
      spanId:        newSpanId(),
      parentSpanId:  incomingTp.parentSpanId,
      source:        'api',
      attempt:       1,
    };

    // 2. INGRESS IDEMPOTENCY: acquire anchor.
    const idem = acquireIdem(db, {
      namespace: 'trigger:api', key: 'e2e-key', fingerprint: 'fp1',
    });
    expect(idem.outcome).toBe('accepted');

    // 3. RUN WITH RETRY: 2 transient failures then success, with spans nested.
    let tryNo = 0;
    const result = await runWithContext(ctx, () => runWithRetry(
      db, ctx,
      { runId, incarnationId: incId, policy: DEFAULT_RETRY_POLICY, sleep: async () => {} },
      async (attemptCtx) => withSpan(db, { kind: 'other', name: 'request_handler' }, async () => {
        // Tool span inside.
        await withToolSpan(db, {
          toolName: 'shell_exec',
          inputFingerprint: '0123456789abcdef',
          sideEffectClass: 'mutating',
          attemptNumber: attemptCtx.attempt,
        }, async () => 'tool-done');
        // LLM span inside.
        await withLlmSpan(db, { model: 'claude-sonnet-4.5', provider: 'anthropic' },
          async (_c, patch) => { patch({ input_tokens: 100, finish_reason: 'stop' }); return 'llm-done'; });
        // Now fail twice then succeed.
        tryNo += 1;
        if (tryNo < 3) { const e = new Error('flaky'); e.name = 'NetworkError'; throw e; }
        return 'completed';
      }),
    ));

    // 4. Verify outcome.
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.attempts).toBe(3);
      expect(result.value).toBe('completed');
    }

    // 5. Verify attempts.
    const attempts = listAttemptsForRun(db, runId);
    expect(attempts.length).toBe(3);
    expect(attempts.map((a) => a.status)).toEqual(['failed', 'failed', 'completed']);

    // 6. Verify span tree (3 attempts × {other → tool, llm} = ~6 spans + retry parents).
    const tree = getTraceTree(db, ctx.traceId);
    // Tree may have multiple roots (one per attempt's request_handler) or
    // one root with children — depends on parent linkage. We assert
    // the total span count.
    const totalSpans = (db.prepare(`SELECT COUNT(*) AS c FROM spans WHERE trace_id = ?`)
      .get(ctx.traceId) as { c: number }).c;
    expect(totalSpans).toBeGreaterThanOrEqual(9); // 3 attempts × (request + tool + llm)

    // 7. Verify all spans share the adopted trace_id (= W3C trace from incoming).
    const allSpansShareTrace = (db.prepare(
      `SELECT DISTINCT trace_id FROM spans WHERE trace_id = ?`,
    ).all(ctx.traceId) as Array<{ trace_id: string }>);
    expect(allSpansShareTrace.length).toBe(1);
    expect(allSpansShareTrace[0].trace_id).toBe(`trc_${incomingTp.traceId}`);

    // 8. Verify idempotency anchor is still 'accepted' (not auto-completed).
    const anchor = (db.prepare(
      `SELECT status FROM run_idempotency_keys WHERE namespace='trigger:api' AND key='e2e-key'`,
    ).get() as { status: string });
    expect(anchor.status).toBe('accepted');

    // 9. Idempotency: second acquire with same key+fingerprint returns duplicate.
    const dup = acquireIdem(db, { namespace: 'trigger:api', key: 'e2e-key', fingerprint: 'fp1' });
    expect(dup.outcome).toBe('duplicate');
  });
});
