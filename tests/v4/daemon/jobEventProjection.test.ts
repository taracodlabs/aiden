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
  runMigrations(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES ('projection-test', 1, 'localhost', ?, ?, '4.16.1')`,
  ).run(now, now);
  jobs = createJobEngine({ db });
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

function admission() {
  return jobs.submitJob({
    entryPoint: 'test', source: 'test', sessionId: 'projection-session', instanceId: 'projection-test',
    idempotencyNamespace: 'projection', idempotencyKey: 'one', requestFingerprint: 'one', goal: 'project truth',
  });
}

describe('JobEventProjectionAuthority', () => {
  it('replays from a durable cursor and duplicate acknowledgement is harmless', () => {
    const admitted = admission();
    expect(jobs.projection.read('tui', admitted.jobId).map((event) => event.type)).toEqual([
      'job.submitted', 'attempt.created',
    ]);
    expect(jobs.projection.acknowledge('tui', admitted.jobId, 1)).toBe(1);
    expect(jobs.projection.acknowledge('tui', admitted.jobId, 1)).toBe(1);
    expect(jobs.projection.read('tui', admitted.jobId).map((event) => event.type)).toEqual(['attempt.created']);
    expect(jobs.projection.acknowledge('tui', admitted.jobId, 2)).toBe(2);
    expect(jobs.projection.read('tui', admitted.jobId)).toEqual([]);

    const restarted = createJobEngine({ db });
    expect(restarted.projection.cursor('tui', admitted.jobId)).toBe(2);
  });

  it('redacts event payloads before persistence', () => {
    const admitted = admission();
    expect(jobs.appendJobEvent({
      jobId: admitted.jobId, attemptId: admitted.attemptId, generation: 1,
      type: 'provider.observed', producer: 'test', idempotencyKey: 'secret-event',
      payload: { apiKey: 'secret-value', nested: { authorization: 'Bearer sensitivevalue12345' }, safe: 'visible' },
    }).applied).toBe(true);
    const event = jobs.listEvents(admitted.jobId).at(-1)!;
    expect(event.payload).toEqual({
      apiKey: '[redacted]', nested: { authorization: '[redacted]' }, safe: 'visible',
    });
    const raw = db.prepare("SELECT payload FROM run_events WHERE idempotency_key = 'secret-event'").get() as { payload: string };
    expect(raw.payload).not.toContain('secret-value');
    expect(raw.payload).not.toContain('sensitivevalue');
  });

  it('rebuilds the same terminal truth without live projection memory', () => {
    const admitted = admission();
    const lease = jobs.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'projection-owner', ttlMs: 30_000 });
    jobs.transitionAttempt({
      attemptId: admitted.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
      fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'attempt-running', producer: 'test',
    });
    jobs.transitionJob({
      jobId: admitted.jobId, attemptId: admitted.attemptId, expectedStateVersion: 0, generation: lease.generation!,
      fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'job-running', producer: 'test',
    });
    jobs.transitionAttempt({
      attemptId: admitted.attemptId, expectedStateVersion: 2, generation: lease.generation!,
      fenceToken: lease.fenceToken!, to: 'succeeded', eventIdempotencyKey: 'attempt-succeeded', producer: 'test',
    });
    jobs.finalizeJob({
      jobId: admitted.jobId, attemptId: admitted.attemptId, expectedStateVersion: 1, generation: lease.generation!,
      fenceToken: lease.fenceToken!, status: 'completed', outcome: 'completed', finishReason: 'done', evidence: {},
      eventIdempotencyKey: 'job-finalized', producer: 'test',
    });

    const tui = jobs.projection.rebuild(admitted.jobId);
    const workbench = createJobEngine({ db }).projection.rebuild(admitted.jobId);
    expect(tui).toEqual(workbench);
    expect(tui.job).toMatchObject({ status: 'completed', terminalOutcome: 'completed' });
    expect(tui.attempts).toMatchObject([{ status: 'succeeded' }]);
    expect(tui.events.at(-1)?.type).toBe('job.finalized');
  });

  it('bounds high-volume replay pages without losing cursor order', () => {
    const admitted = admission();
    for (let index = 0; index < 1_050; index += 1) {
      jobs.appendJobEvent({
        jobId: admitted.jobId, attemptId: admitted.attemptId, generation: 1,
        type: 'worker.heartbeat', producer: 'test', idempotencyKey: `heartbeat-${index}`, payload: { index },
      });
    }
    const first = jobs.projection.read('workbench', admitted.jobId, 5_000);
    expect(first).toHaveLength(1_000);
    expect(first[0]!.jobSequence).toBe(1);
    expect(first.at(-1)!.jobSequence).toBe(1_000);
    jobs.projection.acknowledge('workbench', admitted.jobId, 1_000);
    expect(jobs.projection.read('workbench', admitted.jobId, 1_000)).toHaveLength(52);
  });
});
