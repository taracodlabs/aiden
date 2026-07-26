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
     VALUES ('proof-test', 1, 'localhost', ?, ?, '4.16.1')`,
  ).run(now, now);
  jobs = createJobEngine({ db });
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

function activeJob(key: string) {
  const admission = jobs.submitJob({
    entryPoint: 'test', source: 'test', sessionId: `session-${key}`, instanceId: 'proof-test',
    idempotencyNamespace: 'proof-test', idempotencyKey: key, requestFingerprint: key, goal: `goal ${key}`,
  });
  const lease = jobs.claimAttempt({ attemptId: admission.attemptId, ownerId: 'proof-owner', ttlMs: 30_000 });
  if (!lease.fenceToken || lease.generation === undefined) throw new Error('lease unavailable');
  return { ...admission, generation: lease.generation, fenceToken: lease.fenceToken };
}

describe('JobProofAuthority', () => {
  it('turns a clean execution with wrong observed result into a failed verdict', () => {
    const job = activeJob('wrong-result');
    const claim = jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'result equals expected value', required: true,
    });
    const evidence = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'tool', producer: 'test', observedAt: 100, coverage: 'full',
      verificationResult: 'failed', payload: { exitCode: 0, actual: 'wrong' }, now: 101,
    });
    jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [evidence.evidenceId], state: 'failed', now: 102,
    });
    expect(jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken, now: 103,
    }).verdict).toBe('failed');
  });

  it('rejects stale evidence and leaves a missing capture unknown', () => {
    const job = activeJob('stale-evidence');
    const claim = jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'artifact is current', required: true,
    });
    const stale = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'filesystem', producer: 'test', observedAt: 100, freshUntil: 110,
      coverage: 'full', verificationResult: 'verified', payload: { exists: true }, now: 105,
    });
    expect(() => jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [stale.evidenceId], state: 'verified', now: 111,
    })).toThrow(/Stale evidence/);
    expect(jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken, now: 112,
    }).verdict).toBe('unknown');
  });

  it('produces a partial verdict from mixed evidence and never trusts unsupported prose', () => {
    const job = activeJob('partial');
    const verified = jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'first artifact exists', required: true,
    });
    jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'worker prose says second is done', required: true,
    });
    const evidence = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'filesystem', producer: 'test', observedAt: 200, coverage: 'full',
      verificationResult: 'verified', payload: { path: 'artifact' }, now: 201,
    });
    jobs.proof.checkClaim({
      claimId: verified.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [evidence.evidenceId], state: 'verified', now: 202,
    });
    expect(jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken, now: 203,
    }).verdict).toBe('partially_verified');
  });

  it('keeps the final verdict immutable and records late evidence for review', () => {
    const job = activeJob('immutable');
    const claim = jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'artifact exists', required: true,
    });
    const evidence = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'filesystem', producer: 'test', observedAt: 300, coverage: 'full',
      verificationResult: 'verified', payload: { path: 'artifact' }, now: 301,
    });
    jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [evidence.evidenceId], state: 'verified', now: 302,
    });
    const first = jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken, now: 303,
    });
    const late = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'review', producer: 'test', observedAt: 304, coverage: 'full',
      verificationResult: 'failed', payload: { changed: true }, now: 304,
    });
    expect(late.late).toBe(true);
    expect(jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken, now: 305,
    })).toEqual(first);
    expect(() => jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [late.evidenceId], state: 'failed', now: 306,
    })).toThrow(/immutable/);
  });

  it('exports persisted proof as JSON and Markdown', () => {
    const job = activeJob('export');
    jobs.proof.createClaim({
      jobId: job.jobId, category: 'courtesy', statement: 'explanatory note', required: false,
    });
    const json = jobs.proof.exportJson(job.jobId);
    const markdown = jobs.proof.exportMarkdown(job.jobId);
    expect(json).toMatchObject({ job: { id: job.jobId, goal: 'goal export' } });
    expect(markdown).toContain('# Aiden Proof');
    expect(markdown).toContain('explanatory note');
  });
});
