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
  const unsafeEffect = {
    classification: 'unsafe_mutation' as const,
    kind: 'fixture.external',
    target: 'fixture-target',
    retrySafety: 'never_automatic' as const,
    idempotencySupported: false,
    idempotencyKey: null,
    reconciliationSupported: false,
    verificationSupported: false,
    approvalRequirement: 'policy' as const,
    approvalState: 'not_required' as const,
    sensitiveFields: [] as string[],
    redactionRules: ['digest_arguments'],
    trusted: true,
  };

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

  it('does not let failed non-contract evidence poison satisfied required claims', () => {
    const job = activeJob('recovered-helper');
    const claim = jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'required artifact is exact', required: true,
    });
    jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'helper', producer: 'test', observedAt: 400, coverage: 'full',
      verificationResult: 'failed', payload: { optional: true }, now: 401,
    });
    const required = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'filesystem.readback', producer: 'test', observedAt: 402, coverage: 'full',
      verificationResult: 'verified', payload: { path: 'artifact', exact: true }, now: 403,
    });
    jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [required.evidenceId], state: 'verified', now: 404,
    });

    expect(jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, now: 405,
    }).verdict).toBe('verified');
  });

  it('does not let incomplete optional capture poison independently verified required claims', () => {
    const job = activeJob('optional-capture');
    const claim = jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'required output is exact', required: true,
      requiredEvidenceCategories: ['filesystem.readback'],
    });
    jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'optional.capture', producer: 'test', observedAt: 410, coverage: 'unknown',
      verificationResult: 'unknown', payload: { captured: false }, now: 411,
    });
    const required = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'filesystem.readback', producer: 'test', observedAt: 412, coverage: 'full',
      verificationResult: 'verified', payload: { exact: true }, now: 413,
    });
    jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [required.evidenceId], state: 'verified', now: 414,
    });

    expect(jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, now: 415,
    }).verdict).toBe('verified');
  });

  it('rejects evidence linked to a different durable Effect', () => {
    const job = activeJob('effect-binding');
    db.prepare(
      `INSERT INTO side_effect_ledger
         (key, task_id, step, tool, args_hash, status, attempted_at, job_id, attempt_id,
          generation, effect_state)
       VALUES (?, ?, ?, 'shell_exec', ?, 'confirmed', ?, ?, ?, ?, 'committed')`,
    ).run('effect_expected', job.jobId, 0, 'digest-a', 420, job.jobId, job.attemptId, job.generation);
    db.prepare(
      `INSERT INTO side_effect_ledger
         (key, task_id, step, tool, args_hash, status, attempted_at, job_id, attempt_id,
          generation, effect_state)
       VALUES (?, ?, ?, 'shell_exec', ?, 'confirmed', ?, ?, ?, ?, 'committed')`,
    ).run('effect_other', job.jobId, 1, 'digest-b', 421, job.jobId, job.attemptId, job.generation);
    const claim = jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'expected Effect is verified', required: true,
      effectIds: ['effect_expected'],
    });
    const unrelated = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      effectId: 'effect_other', source: 'effect.readback', producer: 'test', observedAt: 422,
      coverage: 'full', verificationResult: 'verified', payload: { exact: true }, now: 423,
    });

    expect(() => jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [unrelated.evidenceId], state: 'verified', now: 424,
    })).toThrow(/Effect/);
  });

  it('verifies the complete file, hash, and repository acceptance workflow', () => {
    const job = activeJob('acceptance-workflow');
    const definitions = [
      ['input.txt has exact content', 'filesystem.readback', { path: 'input.txt', content: 'Aiden proof input' }],
      ['result.json has exact content', 'filesystem.readback', { path: 'result.json', exact: true }],
      ['input.txt SHA-256 matches', 'filesystem.sha256', { path: 'input.txt', sha256: 'expected-sha256' }],
      ['repository remains unchanged', 'repository.diff', { changed: [] }],
    ] as const;
    const claims = definitions.map(([statement, source]) => jobs.proof.createClaim({
      jobId: job.jobId,
      category: 'contract',
      statement,
      required: true,
      requiredEvidenceCategories: [source],
    }));
    jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'optional.capture', producer: 'test', observedAt: 430, coverage: 'partial',
      verificationResult: 'unknown', payload: { helper: 'unavailable' }, now: 431,
    });
    definitions.forEach(([_, source, payload], index) => {
      const evidence = jobs.proof.recordEvidence({
        jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
        source, producer: 'test', observedAt: 432 + index, coverage: 'full',
        verificationResult: 'verified', payload, now: 440 + index,
      });
      jobs.proof.checkClaim({
        claimId: claims[index]!.claimId, attemptId: job.attemptId, generation: job.generation,
        evidenceIds: [evidence.evidenceId], state: 'verified', now: 450 + index,
      });
    });

    const verdict = jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, now: 460,
    });
    expect(verdict.verdict).toBe('verified');
    expect(verdict.summary).toMatchObject({ requiredClaims: 4, verifiedClaims: 4 });
  });

  it('keeps an unresolved unsafe Effect from producing a verified verdict', () => {
    const job = activeJob('unsafe-unknown');
    const claim = jobs.proof.createClaim({
      jobId: job.jobId, category: 'contract', statement: 'required artifact is exact', required: true,
    });
    const evidence = jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation, fenceToken: job.fenceToken,
      source: 'filesystem.readback', producer: 'test', observedAt: 450, coverage: 'full',
      verificationResult: 'verified', payload: { exact: true }, now: 451,
    });
    jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: job.attemptId, generation: job.generation,
      evidenceIds: [evidence.evidenceId], state: 'verified', now: 452,
    });
    jobs.prepareToolCall({
      toolCallId: 'unsafe_unknown_call', jobId: job.jobId, attemptId: job.attemptId,
      generation: job.generation, fenceToken: job.fenceToken, toolName: 'external_send',
      normalizedArgsDigest: 'digest', riskTier: 'dangerous', mutates: true,
      effect: unsafeEffect, producer: 'test', now: 453,
    });
    jobs.startToolCall({
      toolCallId: 'unsafe_unknown_call', attemptId: job.attemptId,
      generation: job.generation, fenceToken: job.fenceToken, producer: 'test', now: 454,
    });

    expect(jobs.proof.finalize({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, now: 455,
    }).verdict).toBe('partially_verified');
  });

  it('retains a crashed Attempt in proof history after a later Attempt verifies', () => {
    const first = activeJob('attempt-history');
    expect(jobs.recoverExpiredAttempts({
      now: Date.now() + 31_000, instanceId: 'proof-test', producer: 'test', maxCrashes: 3,
    })).toEqual([expect.objectContaining({ jobId: first.jobId, decision: 'retry' })]);
    const attempts = jobs.listAttempts(first.jobId);
    const second = attempts[1]!;
    const lease = jobs.claimAttempt({ attemptId: second.id, ownerId: 'proof-owner-2', ttlMs: 30_000 });
    const claim = jobs.proof.createClaim({
      jobId: first.jobId, category: 'contract', statement: 'recovered artifact verified', required: true,
    });
    const evidence = jobs.proof.recordEvidence({
      jobId: first.jobId, attemptId: second.id, generation: lease.generation!, fenceToken: lease.fenceToken!,
      source: 'filesystem.readback', producer: 'test', observedAt: Date.now(), coverage: 'full',
      verificationResult: 'verified', payload: { exact: true },
    });
    jobs.proof.checkClaim({
      claimId: claim.claimId, attemptId: second.id, generation: lease.generation!,
      evidenceIds: [evidence.evidenceId], state: 'verified',
    });

    expect(jobs.proof.finalize({
      jobId: first.jobId, attemptId: second.id, generation: lease.generation!,
      fenceToken: lease.fenceToken!,
    }).verdict).toBe('verified');
    expect(jobs.proof.exportJson(first.jobId)).toMatchObject({
      attempts: [
        expect.objectContaining({ attempt_id: first.attemptId, status: 'crashed' }),
        expect.objectContaining({ attempt_id: second.id }),
      ],
    });
  });

  it('rejects evidence captured before its linked Effect began', () => {
    const job = activeJob('pre-effect-evidence');
    db.prepare(
      `INSERT INTO side_effect_ledger
         (key, task_id, step, tool, args_hash, status, attempted_at, job_id, attempt_id,
          generation, effect_state)
       VALUES ('effect_pre', ?, 0, 'file_write', 'digest', 'attempting', 500, ?, ?, ?, 'started')`,
    ).run(job.jobId, job.jobId, job.attemptId, job.generation);

    expect(() => jobs.proof.recordEvidence({
      jobId: job.jobId, attemptId: job.attemptId, generation: job.generation,
      fenceToken: job.fenceToken, effectId: 'effect_pre', source: 'filesystem.readback',
      producer: 'test', observedAt: 499, coverage: 'full', verificationResult: 'verified',
      payload: { exists: true }, now: 501,
    })).toThrow(/after the linked Effect began/);
  });
});
