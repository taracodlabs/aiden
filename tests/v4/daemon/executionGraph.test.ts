/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';

describe('durable execution graph', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let admitted: ReturnType<JobEngine['submitJob']>;
  let authority: { attemptId: string; generation: number; fenceToken: string };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('instance', 1, 'localhost', 1, 1, '4.16.1')`,
    ).run();
    engine = createJobEngine({ db });
    admitted = engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'session', instanceId: 'instance',
      idempotencyNamespace: 'graph', idempotencyKey: 'job', goal: 'execute graph',
    });
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'owner', ttlMs: 30_000 });
    authority = { attemptId: admitted.attemptId, generation: lease.generation!, fenceToken: lease.fenceToken! };
  });

  afterEach(() => db.close());

  const create = () => engine.graph.create({
    jobId: admitted.jobId, planDigest: 'plan-digest', producer: 'test', idempotencyKey: 'graph-create',
    nodes: [
      { nodeId: 'plan', kind: 'planning' as const },
      { nodeId: 'read-a', kind: 'tool' as const, dependsOn: ['plan'] },
      { nodeId: 'read-b', kind: 'tool' as const, dependsOn: ['plan'] },
      { nodeId: 'verify', kind: 'verification' as const, dependsOn: ['read-a', 'read-b'], requiresVerification: true },
      { nodeId: 'finish', kind: 'finalization' as const, dependsOn: ['verify'] },
    ],
  });

  it('persists dependency order and schedules independent nodes in parallel', () => {
    create();
    expect(engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule-1' }))
      .toEqual(['plan']);
    engine.graph.claim({ jobId: admitted.jobId, nodeId: 'plan', ...authority, producer: 'test', idempotencyKey: 'claim-plan' });
    engine.graph.complete({
      jobId: admitted.jobId, nodeId: 'plan', ...authority, state: 'succeeded',
      outputRef: 'plan:sha256:1', producer: 'test', idempotencyKey: 'complete-plan',
    });
    expect(engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule-2' }))
      .toEqual(['read-a', 'read-b']);
  });

  it('rejects cycles on initial and dynamic graph edits', () => {
    expect(() => engine.graph.create({
      jobId: admitted.jobId, planDigest: 'cycle', producer: 'test', idempotencyKey: 'cycle',
      nodes: [
        { nodeId: 'a', kind: 'tool', dependsOn: ['b'] },
        { nodeId: 'b', kind: 'tool', dependsOn: ['a'] },
      ],
    })).toThrow(/cycle/i);
    create();
    expect(() => engine.graph.edit({
      jobId: admitted.jobId, expectedVersion: 1, producer: 'test', idempotencyKey: 'edit-cycle',
      nodes: [{ nodeId: 'later', kind: 'aggregation', dependsOn: ['finish'] }],
      edges: [{ from: 'later', to: 'plan' }],
    })).toThrow(/cycle/i);
  });

  it('audits dynamic graph edits and prevents duplicate scheduling', () => {
    create();
    const edited = engine.graph.edit({
      jobId: admitted.jobId, expectedVersion: 1, producer: 'test', idempotencyKey: 'edit-1',
      nodes: [{ nodeId: 'wait', kind: 'wait', dependsOn: ['plan'] }],
    });
    expect(edited.version).toBe(2);
    expect(engine.graph.events(admitted.jobId).map((event) => event.type)).toEqual(['graph.created', 'graph.edited']);
    expect(engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule-a' }))
      .toEqual(['plan']);
    expect(engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule-b' }))
      .toEqual([]);
  });

  it('replays completed state after restart and resets only a stale running node', () => {
    create();
    engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule' });
    engine.graph.claim({ jobId: admitted.jobId, nodeId: 'plan', ...authority, producer: 'test', idempotencyKey: 'claim' });
    engine.graph.complete({
      jobId: admitted.jobId, nodeId: 'plan', ...authority, state: 'succeeded',
      outputRef: 'plan:sha256:1', producer: 'test', idempotencyKey: 'complete',
    });
    engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule-tools' });
    engine.graph.claim({ jobId: admitted.jobId, nodeId: 'read-a', ...authority, producer: 'test', idempotencyKey: 'claim-a' });

    db.prepare("UPDATE runs SET lease_expires_at = 1 WHERE attempt_id = ?").run(admitted.attemptId);
    engine.recoverExpiredAttempts({ now: 2, instanceId: 'instance', producer: 'test', maxCrashes: 3 });
    engine = createJobEngine({ db });
    const recovery = engine.listAttempts(admitted.jobId)[1]!;
    const next = engine.claimAttempt({ attemptId: recovery.id, ownerId: 'next', ttlMs: 30_000, now: 3 });
    const reset = engine.graph.recover({
      jobId: admitted.jobId, attemptId: recovery.id, generation: next.generation!,
      fenceToken: next.fenceToken!, producer: 'test', idempotencyKey: 'recover-graph', now: 3,
    });
    expect(reset).toEqual(['read-a']);
    expect(engine.graph.nodes(admitted.jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'plan', state: 'succeeded' }),
      expect.objectContaining({ nodeId: 'read-a', state: 'pending' }),
      expect.objectContaining({ nodeId: 'read-b', state: 'runnable' }),
    ]));
  });

  it('rejects stale completion and requires verification proof', () => {
    create();
    engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule' });
    engine.graph.claim({ jobId: admitted.jobId, nodeId: 'plan', ...authority, producer: 'test', idempotencyKey: 'claim' });
    expect(engine.graph.complete({
      jobId: admitted.jobId, nodeId: 'plan', attemptId: authority.attemptId,
      generation: authority.generation + 1, fenceToken: authority.fenceToken,
      state: 'succeeded', producer: 'test', idempotencyKey: 'stale',
    })).toMatchObject({ applied: false, conflict: 'stale_fence' });

    db.prepare("UPDATE execution_graph_nodes SET state = 'runnable' WHERE node_key = 'verify'").run();
    engine.graph.claim({ jobId: admitted.jobId, nodeId: 'verify', ...authority, producer: 'test', idempotencyKey: 'claim-verify' });
    expect(engine.graph.complete({
      jobId: admitted.jobId, nodeId: 'verify', ...authority, state: 'succeeded',
      producer: 'test', idempotencyKey: 'verify-without-proof',
    })).toMatchObject({ applied: false, conflict: 'verification_required' });
  });

  it('prevents a cancelled parent graph from scheduling or completing', () => {
    create();
    engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule' });
    engine.graph.claim({ jobId: admitted.jobId, nodeId: 'plan', ...authority, producer: 'test', idempotencyKey: 'claim' });
    engine.cancelJob({ jobId: admitted.jobId, reason: 'user', producer: 'test', eventIdempotencyKey: 'cancel' });
    expect(db.prepare('SELECT state FROM execution_graphs WHERE job_id = ?').get(admitted.jobId)).toEqual({ state: 'cancelled' });
    expect(engine.graph.complete({
      jobId: admitted.jobId, nodeId: 'plan', ...authority, state: 'succeeded',
      producer: 'test', idempotencyKey: 'late-complete',
    })).toMatchObject({ applied: false, conflict: 'terminal_job' });
    expect(engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'late-schedule' }))
      .toEqual([]);
  });

  it('supports wait, child Job, reconciliation, and verification as first-class node kinds', () => {
    engine.graph.create({
      jobId: admitted.jobId, planDigest: 'kinds', producer: 'test', idempotencyKey: 'kinds',
      nodes: [
        { nodeId: 'wait', kind: 'wait' },
        { nodeId: 'child', kind: 'child_job', dependsOn: ['wait'] },
        { nodeId: 'reconcile', kind: 'reconciliation', dependsOn: ['child'] },
        { nodeId: 'verify', kind: 'verification', dependsOn: ['reconcile'], requiresVerification: true },
      ],
    });
    expect(engine.graph.nodes(admitted.jobId).map((node) => node.kind))
      .toEqual(['wait', 'child_job', 'reconciliation', 'verification']);
  });

  it('blocks dependents when a required predecessor fails', () => {
    create();
    engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule-plan' });
    engine.graph.claim({ jobId: admitted.jobId, nodeId: 'plan', ...authority, producer: 'test', idempotencyKey: 'claim-plan' });
    engine.graph.complete({
      jobId: admitted.jobId, nodeId: 'plan', ...authority, state: 'failed',
      producer: 'test', idempotencyKey: 'fail-plan',
    });
    expect(engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule-blocked' }))
      .toEqual([]);
    expect(engine.graph.nodes(admitted.jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'read-a', state: 'blocked' }),
      expect.objectContaining({ nodeId: 'read-b', state: 'blocked' }),
    ]));
  });

  it('allows authoritative Job completion only after every graph node succeeds', () => {
    engine.graph.create({
      jobId: admitted.jobId, planDigest: 'single', producer: 'test', idempotencyKey: 'single',
      nodes: [{ nodeId: 'execute', kind: 'tool' }],
    });
    engine.transitionJob({
      jobId: admitted.jobId, ...authority, expectedStateVersion: 0, to: 'running',
      producer: 'test', eventIdempotencyKey: 'job-running',
    });
    expect(engine.finalizeJob({
      jobId: admitted.jobId, ...authority, expectedStateVersion: 1, status: 'completed',
      outcome: 'verified', finishReason: 'done', evidence: {}, producer: 'test',
      eventIdempotencyKey: 'too-early',
    })).toMatchObject({ applied: false, conflict: 'illegal_transition' });
    engine.graph.schedule({ jobId: admitted.jobId, ...authority, producer: 'test', idempotencyKey: 'schedule' });
    engine.graph.claim({ jobId: admitted.jobId, nodeId: 'execute', ...authority, producer: 'test', idempotencyKey: 'claim' });
    engine.graph.complete({
      jobId: admitted.jobId, nodeId: 'execute', ...authority, state: 'succeeded',
      outputRef: 'result:sha256:1', producer: 'test', idempotencyKey: 'complete',
    });
    expect(engine.finalizeJob({
      jobId: admitted.jobId, ...authority, expectedStateVersion: 1, status: 'completed',
      outcome: 'verified', finishReason: 'done', evidence: {}, producer: 'test',
      eventIdempotencyKey: 'complete-job',
    }).applied).toBe(true);
    expect(db.prepare('SELECT state FROM execution_graphs WHERE job_id = ?').get(admitted.jobId)).toEqual({ state: 'completed' });
  });
});
