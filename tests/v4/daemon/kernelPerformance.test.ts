/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';

type Measurement = { elapsedMs: number };

function measure(work: () => void): Measurement {
  const started = performance.now();
  work();
  return { elapsedMs: performance.now() - started };
}

describe('durable kernel performance and query shape', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('performance-instance', 1, 'localhost', 1, 1, '4.16.1')`,
    ).run();
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  it('keeps ordered kernel queries index-backed', () => {
    const plan = (sql: string): string[] => (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
    ).map((row) => row.detail);
    const queries = [
      "SELECT * FROM tasks WHERE status = 'running' ORDER BY created_at, id LIMIT 100",
      "SELECT * FROM tasks WHERE session_id = 'session' ORDER BY created_at, id LIMIT 100",
      "SELECT * FROM side_effect_ledger WHERE job_id = 'job' ORDER BY attempted_at, key",
      "SELECT * FROM child_job_contracts WHERE parent_job_id = 'job' ORDER BY created_at, child_job_id",
      "SELECT * FROM job_claims WHERE job_id = 'job' ORDER BY created_at, claim_id",
      "SELECT * FROM job_evidence WHERE job_id = 'job' ORDER BY captured_at, evidence_id",
      "SELECT * FROM run_events WHERE job_id = 'job' AND job_sequence > 100 ORDER BY job_sequence LIMIT 500",
    ];

    for (const query of queries) {
      const details = plan(query);
      expect(details.join(' | '), query).toMatch(/USING (?:COVERING )?INDEX/);
      expect(details.join(' | '), query).not.toContain('USE TEMP B-TREE');
      expect(details.join(' | '), query).not.toMatch(/^SCAN /);
    }
  });

  it('measures realistic admission, event, graph, Effect, proof, replay, and recovery workloads', () => {
    const admissions: ReturnType<JobEngine['submitJob']>[] = [];
    const measurements: Record<string, number> = {};
    measurements.admission = measure(() => {
      for (let index = 0; index < 300; index += 1) {
        admissions.push(engine.submitJob({
          entryPoint: index % 2 === 0 ? 'daemon' : 'interactive', source: 'performance',
          sessionId: `session-${index % 20}`, instanceId: 'performance-instance',
          idempotencyNamespace: 'performance', idempotencyKey: `job-${index}`,
          requestFingerprint: `fingerprint-${index}`, goal: `measured Job ${index}`,
        }));
      }
    }).elapsedMs;

    const primary = admissions[0]!;
    const lease = engine.claimAttempt({
      attemptId: primary.attemptId, ownerId: 'performance-worker', ttlMs: 100_000, now: 100,
    });
    const authority = {
      attemptId: primary.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
    };

    measurements.events = measure(() => {
      for (let index = 0; index < 1_500; index += 1) {
        const result = engine.appendJobEvent({
          jobId: primary.jobId, attemptId: primary.attemptId, generation: 1,
          type: 'performance.observed', payload: { index }, producer: 'performance',
          idempotencyKey: `performance-event-${index}`,
        });
        if (!result.applied) throw new Error(`event ${index} was not appended`);
      }
    }).elapsedMs;

    const nodes = Array.from({ length: 120 }, (_, index) => ({
      nodeId: `node-${index}`, kind: 'tool' as const,
      dependsOn: index === 0 ? [] : [`node-${index - 1}`],
    }));
    measurements.graph = measure(() => {
      engine.graph.create({
        jobId: primary.jobId, planDigest: 'performance-plan', nodes,
        producer: 'performance', idempotencyKey: 'performance-graph', now: 200,
      });
      expect(engine.graph.schedule({
        jobId: primary.jobId, ...authority, producer: 'performance',
        idempotencyKey: 'performance-schedule', now: 200,
      })).toEqual(['node-0']);
    }).elapsedMs;

    measurements.effects = measure(() => {
      for (let index = 0; index < 100; index += 1) {
        const prepared = engine.prepareToolCall({
          toolCallId: `performance-tool-${index}`, jobId: primary.jobId, ...authority,
          toolName: 'file_write', normalizedArgsDigest: `digest-${index}`,
          riskTier: 'caution', mutates: true, producer: 'performance', now: 201 + index,
          effect: {
            classification: 'reconcilable_mutation', kind: 'filesystem.write', target: `C:/workspace/${index}.txt`,
            retrySafety: 'reconcile_before_retry', idempotencySupported: true,
            idempotencyKey: `performance-effect-${index}`, reconciliationSupported: true,
            verificationSupported: true, approvalRequirement: 'policy', approvalState: 'not_required',
            sensitiveFields: ['content'], redactionRules: ['digest_arguments'], trusted: true,
          },
        });
        if (!prepared.applied) throw new Error(`Effect ${index} was not prepared`);
      }
      expect(engine.projection.rebuild(primary.jobId).effects).toHaveLength(100);
    }).elapsedMs;

    measurements.evidence = measure(() => {
      for (let index = 0; index < 100; index += 1) {
        engine.proof.createClaim({
          jobId: primary.jobId, attemptId: primary.attemptId, generation: 1,
          category: index % 2 === 0 ? 'contract' : 'observed',
          statement: `measured claim ${index}`, required: index % 2 === 0, now: 400 + index,
        });
        engine.proof.recordEvidence({
          jobId: primary.jobId, ...authority, source: 'performance', producer: 'performance',
          observedAt: 400 + index, coverage: 'full', verificationResult: 'verified',
          payload: { index }, now: 400 + index,
        });
      }
      expect(engine.proof.listEvidence(primary.jobId)).toHaveLength(100);
    }).elapsedMs;

    measurements.proofExport = measure(() => {
      const proof = engine.proof.exportJson(primary.jobId) as { claims: unknown[]; evidence: unknown[] };
      expect(proof.claims).toHaveLength(100);
      expect(proof.evidence).toHaveLength(100);
      expect(engine.proof.exportMarkdown(primary.jobId)).toContain('measured claim 99');
    }).elapsedMs;

    measurements.reconstruction = measure(() => {
      const snapshot = engine.projection.rebuild(primary.jobId);
      expect(snapshot.events).toHaveLength(1_000);
      expect(snapshot.attempts).toHaveLength(1);
      expect(snapshot.claims).toHaveLength(100);
    }).elapsedMs;

    const firstPage = engine.projection.read('performance-ui', primary.jobId, 500);
    engine.projection.acknowledge('performance-ui', primary.jobId, firstPage.at(-1)!.jobSequence, 1_000);
    measurements.replay = measure(() => {
      const secondPage = engine.projection.read('performance-ui', primary.jobId, 500);
      expect(secondPage).toHaveLength(500);
      expect(secondPage[0]!.jobSequence).toBeGreaterThan(firstPage.at(-1)!.jobSequence);
    }).elapsedMs;

    for (const admitted of admissions.slice(1, 41)) {
      const expired = engine.claimAttempt({
        attemptId: admitted.attemptId, ownerId: 'expired-worker', ttlMs: 10, now: 100,
      });
      if (!expired.acquired) throw new Error('recovery fixture lease unavailable');
    }
    measurements.recovery = measure(() => {
      const recovered = engine.recoverExpiredAttempts({
        now: 111, instanceId: 'performance-instance', producer: 'performance-recovery', maxCrashes: 3,
      });
      expect(recovered).toHaveLength(40);
      expect(recovered.every((item) => item.decision === 'retry')).toBe(true);
    }).elapsedMs;

    for (const [operation, elapsedMs] of Object.entries(measurements)) {
      expect(elapsedMs, `${operation} measured ${elapsedMs.toFixed(1)}ms`).toBeGreaterThanOrEqual(0);
      expect(elapsedMs, `${operation} exceeded the deterministic 5s budget`).toBeLessThan(5_000);
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 300 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 340 });
  });
});
