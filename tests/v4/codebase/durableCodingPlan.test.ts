/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { normalizedArgsDigest } from '../../../core/v4/daemon/jobExecutionContext';

describe('durable coding plan projection', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let root: string;
  let admission: AdmissionResult;
  let generation: number;
  let fenceToken: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('plan-test',1,'localhost',1,1,'4.17.0')`,
    ).run();
    engine = createJobEngine({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-plan-'));
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    admission = engine.submitJob({
      entryPoint: 'test', source: 'unit', sessionId: 'plan', workspaceId: root,
      instanceId: 'plan-test', idempotencyNamespace: 'plan', idempotencyKey: path.basename(root),
      goal: 'repair the source safely',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 60_000 });
    generation = lease.generation!;
    fenceToken = lease.fenceToken!;
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const authority = () => ({
    attemptId: admission.attemptId,
    generation,
    fenceToken,
    producer: 'test',
  });

  async function snapshot() {
    return engine.repository.captureSnapshot({
      jobId: admission.jobId, ...authority(), requestedPath: root,
    });
  }

  async function createPlan() {
    const source = await snapshot();
    engine.graph.createCodingPlan({
      jobId: admission.jobId, planDigest: 'coding-plan-v1', producer: 'test', idempotencyKey: 'plan-create',
      steps: [
        {
          stepId: 'inspect', label: 'Inspect source', repositorySnapshotId: source.id,
          references: [{ kind: 'inspected_file', snapshotId: source.id, path: 'source.ts' }],
        },
        {
          stepId: 'change', label: 'Change implementation', repositorySnapshotId: source.id,
          dependsOn: ['inspect'],
          references: [{ kind: 'source_reference', snapshotId: source.id, path: 'source.ts', lineStart: 1, lineEnd: 1 }],
        },
        {
          stepId: 'validate', label: 'Run focused validation', repositorySnapshotId: source.id,
          dependsOn: ['change'], requiresVerification: true,
        },
      ],
    });
    return source;
  }

  it('survives context loss and restart with completed steps and exact references intact', async () => {
    const source = await createPlan();
    expect(engine.graph.schedule({ jobId: admission.jobId, ...authority(), idempotencyKey: 'schedule-inspect' }))
      .toEqual(['inspect']);
    expect(engine.graph.claim({ jobId: admission.jobId, nodeId: 'inspect', ...authority(), idempotencyKey: 'claim-inspect' }).applied)
      .toBe(true);
    expect(engine.graph.complete({
      jobId: admission.jobId, nodeId: 'inspect', ...authority(), idempotencyKey: 'complete-inspect',
      state: 'succeeded', outputRef: 'inspection:source.ts',
    }).applied).toBe(true);
    engine.graph.schedule({ jobId: admission.jobId, ...authority(), idempotencyKey: 'schedule-change' });
    engine.graph.claim({ jobId: admission.jobId, nodeId: 'change', ...authority(), idempotencyKey: 'claim-change' });
    engine.graph.addNodeReferences({
      jobId: admission.jobId, nodeId: 'change', ...authority(), idempotencyKey: 'reference-change',
      references: [{ kind: 'source_reference', snapshotId: source.id, path: 'source.ts', lineStart: 1, lineEnd: 1 }],
    });

    engine = createJobEngine({ db });
    expect(engine.graph.getCodingPlan(admission.jobId)).toMatchObject({
      jobId: admission.jobId,
      goal: 'repair the source safely',
      planDigest: 'coding-plan-v1',
      steps: [
        expect.objectContaining({ stepId: 'inspect', state: 'completed', filesInspected: ['source.ts'] }),
        expect.objectContaining({ stepId: 'change', state: 'active', sourceReferences: [expect.objectContaining({ path: 'source.ts', lineStart: 1 })] }),
        expect.objectContaining({ stepId: 'validate', state: 'pending' }),
      ],
    });
  });

  it('prevents a superseded step from completing', async () => {
    await createPlan();
    engine.graph.schedule({ jobId: admission.jobId, ...authority(), idempotencyKey: 'schedule' });
    engine.graph.claim({ jobId: admission.jobId, nodeId: 'inspect', ...authority(), idempotencyKey: 'claim' });
    expect(engine.graph.retireNode({
      jobId: admission.jobId, nodeId: 'inspect', state: 'superseded', reason: 'new source path',
      ...authority(), idempotencyKey: 'supersede',
    }).applied).toBe(true);
    expect(engine.graph.complete({
      jobId: admission.jobId, nodeId: 'inspect', state: 'succeeded', outputRef: 'late',
      ...authority(), idempotencyKey: 'late-complete',
    })).toMatchObject({ applied: false, conflict: 'illegal_transition' });
    expect(engine.graph.getCodingPlan(admission.jobId)?.steps[0]?.state).toBe('superseded');
  });

  it('reports a newer repository snapshot as drift from the persisted plan', async () => {
    const planned = await createPlan();
    await writeFile(path.join(root, 'source.ts'), 'export const value = 3;\n');
    const current = await engine.repository.captureSnapshot({
      jobId: admission.jobId, ...authority(), requestedPath: root,
      previousSnapshotId: planned.id,
    });
    expect(engine.graph.getCodingPlan(admission.jobId)).toMatchObject({
      currentRepositorySnapshotId: current.id,
      repositoryDriftDetected: true,
      remainingStepIds: ['inspect', 'change', 'validate'],
    });
  });

  it('restores a completed mutation reference and failed TestRun after restart', async () => {
    const source = await createPlan();
    engine.graph.schedule({ jobId: admission.jobId, ...authority(), idempotencyKey: 'schedule-inspect' });
    engine.graph.claim({ jobId: admission.jobId, nodeId: 'inspect', ...authority(), idempotencyKey: 'claim-inspect' });
    engine.graph.complete({
      jobId: admission.jobId, nodeId: 'inspect', state: 'succeeded', outputRef: 'inspection:source.ts',
      ...authority(), idempotencyKey: 'complete-inspect',
    });
    engine.graph.schedule({ jobId: admission.jobId, ...authority(), idempotencyKey: 'schedule-change' });
    engine.graph.claim({ jobId: admission.jobId, nodeId: 'change', ...authority(), idempotencyKey: 'claim-change' });

    const changeToolCallId = 'plan-change-tool';
    const preparedChange = engine.prepareToolCall({
      jobId: admission.jobId, ...authority(), toolCallId: changeToolCallId, toolName: 'file_write',
      normalizedArgsDigest: normalizedArgsDigest({ path: 'source.ts', content: 'export const value = 2;\n' }),
      riskTier: 'caution', mutates: true,
      effect: {
        classification: 'reconcilable_mutation', kind: 'filesystem.write', target: 'source.ts',
        retrySafety: 'reconcile_before_retry', idempotencySupported: false, idempotencyKey: null,
        reconciliationSupported: true, verificationSupported: true,
        approvalRequirement: 'policy', approvalState: 'not_required', sensitiveFields: [],
        redactionRules: ['digest_arguments'], trusted: true,
      },
    });
    const changeClaim = engine.proof.createClaim({
      jobId: admission.jobId, attemptId: admission.attemptId, generation,
      category: 'observed', statement: 'source mutation completed', required: false,
    });
    const changeId = 'change_plan_fixture';
    db.prepare(
      `INSERT INTO repository_change_intents
         (intent_id,job_id,attempt_id,generation,fence_token,tool_call_id,base_snapshot_id,operation,
          canonical_target,canonical_destination,expected_scope_json,original_hash,original_metadata_json,
          destination_original_metadata_json,plan_digest,planned_result_hash,planned_result_size,effect_id,
          approval_id,action_digest,claim_id,state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'modify',?,NULL,'["source.ts"]',NULL,'{}',NULL,'plan',NULL,NULL,?,NULL,NULL,?,'executed',1,1)`,
    ).run(
      'intent_plan_fixture', admission.jobId, admission.attemptId, generation, fenceToken,
      changeToolCallId, source.id, path.join(root, 'source.ts'), preparedChange.effectId, changeClaim.claimId,
    );
    db.prepare(
      `INSERT INTO repository_change_records
         (change_id,intent_id,job_id,attempt_id,generation,fence_token,effect_id,base_snapshot_id,state,created_at,completed_at)
       VALUES (?,'intent_plan_fixture',?,?,?,?,?,?,'succeeded',1,2)`,
    ).run(changeId, admission.jobId, admission.attemptId, generation, fenceToken, preparedChange.effectId, source.id);
    engine.graph.addNodeReferences({
      jobId: admission.jobId, nodeId: 'change', ...authority(), idempotencyKey: 'reference-change-record',
      references: [{ kind: 'change_record', id: changeId, snapshotId: source.id }],
    });
    engine.graph.complete({
      jobId: admission.jobId, nodeId: 'change', state: 'succeeded', outputRef: `change:${changeId}`,
      ...authority(), idempotencyKey: 'complete-change',
    });
    engine.graph.schedule({ jobId: admission.jobId, ...authority(), idempotencyKey: 'schedule-validation' });
    engine.graph.claim({ jobId: admission.jobId, nodeId: 'validate', ...authority(), idempotencyKey: 'claim-validation' });

    const validationToolCallId = 'plan-validation-tool';
    const preparedValidation = engine.prepareToolCall({
      jobId: admission.jobId, ...authority(), toolCallId: validationToolCallId, toolName: 'shell_exec',
      normalizedArgsDigest: normalizedArgsDigest({ command: 'npm test', cwd: root }),
      riskTier: 'dangerous', mutates: true,
      effect: {
        classification: 'non_reconcilable_mutation', kind: 'process.execute', target: 'npm test',
        retrySafety: 'never_retry', idempotencySupported: false, idempotencyKey: null,
        reconciliationSupported: false, verificationSupported: true,
        approvalRequirement: 'policy', approvalState: 'not_required', sensitiveFields: ['command'],
        redactionRules: ['digest_arguments'], trusted: true,
      },
    });
    engine.startToolCall({ toolCallId: validationToolCallId, jobId: admission.jobId, ...authority() });
    const run = engine.validation.start({
      jobId: admission.jobId, ...authority(), repositorySnapshotId: source.id,
      toolCallId: validationToolCallId, effectId: preparedValidation.effectId!,
      plan: { kind: 'test', command: 'npm test', workingDirectory: root, scope: 'focused' },
      environment: { platform: 'win32', architecture: 'x64', nodeVersion: 'v22.23.1', npmVersion: '11.8.0' },
    });
    await engine.validation.complete({
      jobId: admission.jobId, ...authority(), runId: run.runId,
      execution: { exitCode: 1, stdout: 'Tests 1 failed (1)\n', stderr: '', timedOut: false, cancelled: false },
    });
    engine.graph.addNodeReferences({
      jobId: admission.jobId, nodeId: 'validate', ...authority(), idempotencyKey: 'reference-test-run',
      references: [{ kind: 'test_run', id: run.runId, snapshotId: source.id }],
    });
    engine.graph.complete({
      jobId: admission.jobId, nodeId: 'validate', state: 'failed', outputRef: `test:${run.runId}`,
      ...authority(), idempotencyKey: 'fail-validation',
    });

    engine = createJobEngine({ db });
    const restored = engine.graph.getCodingPlan(admission.jobId)!;
    expect(restored.steps.find((step) => step.stepId === 'change')).toMatchObject({
      state: 'completed', references: expect.arrayContaining([expect.objectContaining({ kind: 'change_record', id: changeId })]),
    });
    expect(restored.steps.find((step) => step.stepId === 'validate')).toMatchObject({
      state: 'failed', references: expect.arrayContaining([expect.objectContaining({ kind: 'test_run', id: run.runId })]),
    });
  });

  it('rejects stale worker references and completion after recovery generation advances', async () => {
    await createPlan();
    engine.graph.schedule({ jobId: admission.jobId, ...authority(), idempotencyKey: 'schedule' });
    engine.graph.claim({ jobId: admission.jobId, nodeId: 'inspect', ...authority(), idempotencyKey: 'claim' });
    const stale = authority();
    db.prepare('UPDATE runs SET lease_expires_at = 1 WHERE attempt_id = ?').run(admission.attemptId);
    engine.recoverExpiredAttempts({ now: 2, instanceId: 'plan-test', producer: 'test', maxCrashes: 3 });
    const recovery = engine.listAttempts(admission.jobId)[1]!;
    const next = engine.claimAttempt({ attemptId: recovery.id, ownerId: 'next', ttlMs: 60_000, now: 3 });
    engine.graph.recover({
      jobId: admission.jobId, attemptId: recovery.id, generation: next.generation!, fenceToken: next.fenceToken!,
      producer: 'test', idempotencyKey: 'recover', now: 3,
    });

    expect(engine.graph.addNodeReferences({
      jobId: admission.jobId, nodeId: 'inspect', ...stale, idempotencyKey: 'stale-reference',
      references: [{ kind: 'inspected_file', snapshotId: engine.graph.getCodingPlan(admission.jobId)!.steps[0]!.repositorySnapshotId, path: 'source.ts' }],
    })).toMatchObject({ applied: false, conflict: 'stale_fence' });
    expect(engine.graph.complete({
      jobId: admission.jobId, nodeId: 'inspect', state: 'succeeded', outputRef: 'stale',
      ...stale, idempotencyKey: 'stale-complete',
    })).toMatchObject({ applied: false, conflict: 'stale_fence' });
  });

  it('binds code Claims to exact source references and rejects child Job evidence', async () => {
    const source = await snapshot();
    const claim = engine.proof.createClaim({
      jobId: admission.jobId, attemptId: admission.attemptId, generation,
      category: 'contract', statement: 'source exports value', required: true,
      repositorySnapshotId: source.id,
      sourceReferences: [{ snapshotId: source.id, path: 'source.ts', lineStart: 1, lineEnd: 1 }],
      requiredEvidenceCategories: ['source.readback'],
    });
    expect(claim).toMatchObject({
      repositorySnapshotId: source.id,
      sourceReferences: [{ snapshotId: source.id, path: 'source.ts', lineStart: 1, lineEnd: 1 }],
      requiredEvidenceCategories: ['source.readback'],
    });

    const child = engine.submitJob({
      entryPoint: 'child', source: 'test', sessionId: 'plan', instanceId: 'plan-test',
      idempotencyNamespace: 'plan-child', idempotencyKey: 'child', goal: 'inspect source',
      parentJobId: admission.jobId, rootJobId: admission.jobId,
      childContract: { workerId: 'child-worker', capabilities: ['read'], allowedResources: {}, budget: {} },
    });
    const childLease = engine.claimAttempt({ attemptId: child.attemptId, ownerId: 'child-worker', ttlMs: 60_000 });
    const childEvidence = engine.proof.recordEvidence({
      jobId: child.jobId, attemptId: child.attemptId, generation: childLease.generation!, fenceToken: childLease.fenceToken!,
      repositorySnapshotId: null, source: 'source.readback', producer: 'child', observedAt: 10,
      coverage: 'full', verificationResult: 'verified', payload: { statement: 'looks correct' }, now: 11,
    });
    expect(() => engine.proof.checkClaim({
      claimId: claim.claimId, attemptId: admission.attemptId, generation,
      evidenceIds: [childEvidence.evidenceId], state: 'verified', now: 12,
    })).toThrow(/unrelated evidence/i);
  });

  it('enforces required validation and Evidence categories for source-bound Claims', async () => {
    const source = await snapshot();
    const toolCallId = 'claim-validation-tool';
    const prepared = engine.prepareToolCall({
      jobId: admission.jobId, ...authority(), toolCallId, toolName: 'shell_exec',
      normalizedArgsDigest: normalizedArgsDigest({ command: 'npm test', cwd: root }),
      riskTier: 'dangerous', mutates: true,
      effect: {
        classification: 'non_reconcilable_mutation', kind: 'process.execute', target: 'npm test',
        retrySafety: 'never_retry', idempotencySupported: false, idempotencyKey: null,
        reconciliationSupported: false, verificationSupported: true,
        approvalRequirement: 'policy', approvalState: 'not_required', sensitiveFields: [],
        redactionRules: ['digest_arguments'], trusted: true,
      },
    });
    const runId = 'test_run_claim_requirement';
    db.prepare(
      `INSERT INTO validation_runs
         (run_id,kind,job_id,attempt_id,generation,fence_token,tool_call_id,effect_id,
          repository_snapshot_id,source_state_digest,command,working_directory,
          environment_fingerprint,environment_json,scope,state,started_at,completed_at,
          exit_code,parse_state,source_mutations_json)
       VALUES (?,'test',?,?,?,?,?,?,?,?,'npm test',?,'environment','{}','full','succeeded',1,2,0,'parsed','[]')`,
    ).run(
      runId, admission.jobId, admission.attemptId, generation, fenceToken, toolCallId,
      prepared.effectId, source.id, source.stateDigest, root,
    );
    const claim = engine.proof.createClaim({
      jobId: admission.jobId, attemptId: admission.attemptId, generation,
      category: 'contract', statement: 'source passes the full validation contract', required: true,
      repositorySnapshotId: source.id,
      sourceReferences: [{ snapshotId: source.id, path: 'source.ts', lineStart: 1, lineEnd: 1 }],
      requiredValidation: [{ kind: 'test', scope: 'full' }],
      requiredEvidenceCategories: ['validation.test'],
    });
    const evidence = engine.proof.recordEvidence({
      jobId: admission.jobId, ...authority(), repositorySnapshotId: source.id,
      source: 'validation.test', observedAt: 2, coverage: 'full', verificationResult: 'verified',
      payload: { runId }, now: 3,
    });
    await writeFile(path.join(root, 'source.ts'), 'export const value = 4;\n');
    const newer = await engine.repository.captureSnapshot({
      jobId: admission.jobId, ...authority(), requestedPath: root, previousSnapshotId: source.id,
    });
    const wrongSnapshotEvidence = engine.proof.recordEvidence({
      jobId: admission.jobId, ...authority(), repositorySnapshotId: newer.id,
      source: 'validation.test', observedAt: 3, coverage: 'full', verificationResult: 'verified',
      payload: { runId }, now: 3,
    });
    expect(() => engine.proof.checkClaim({
      claimId: claim.claimId, attemptId: admission.attemptId, generation,
      evidenceIds: [wrongSnapshotEvidence.evidenceId], validationRunIds: [runId], state: 'verified', now: 4,
    })).toThrow(/snapshot/i);

    expect(() => engine.proof.checkClaim({
      claimId: claim.claimId, attemptId: admission.attemptId, generation,
      evidenceIds: [evidence.evidenceId], state: 'verified', now: 4,
    })).toThrow(/required validation/i);
    expect(engine.proof.checkClaim({
      claimId: claim.claimId, attemptId: admission.attemptId, generation,
      evidenceIds: [evidence.evidenceId], validationRunIds: [runId], state: 'verified', now: 5,
    }).state).toBe('verified');

    const partial = engine.proof.createClaim({
      jobId: admission.jobId, category: 'observed', statement: 'source is partially understood',
      repositorySnapshotId: source.id,
    });
    expect(engine.proof.checkClaim({
      claimId: partial.claimId, attemptId: admission.attemptId, generation,
      evidenceIds: [evidence.evidenceId], state: 'partial', now: 6,
    }).state).toBe('partial');
  });
});
