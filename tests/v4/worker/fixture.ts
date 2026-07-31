/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import {
  computeWorkerResultHash,
  type WorkerResultPayloadV1,
} from '../../../core/v4/worker/types';

export interface WorkerFixture {
  db: Database.Database;
  engine: JobEngine;
  parent: ReturnType<JobEngine['submitJob']>;
  child: ReturnType<JobEngine['submitJob']>;
  parentAuthority: { parentJobId: string; parentAttemptId: string; parentGeneration: number; parentFenceToken: string };
  childAuthority: { childJobId: string; childAttemptId: string; childGeneration: number; childFenceToken: string };
}

export function createWorkerFixture(): WorkerFixture {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES ('worker-instance', 1, 'localhost', 1, 1, '4.18.0')`,
  ).run();
  const engine = createJobEngine({ db });
  const parent = engine.submitJob({
    entryPoint: 'test', source: 'test', sessionId: 'worker-session', instanceId: 'worker-instance',
    idempotencyNamespace: 'worker-parent', idempotencyKey: 'parent', goal: 'coordinate worker',
  });
  const parentLease = engine.claimAttempt({ attemptId: parent.attemptId, ownerId: 'parent-owner', ttlMs: 60_000, now: 10 });
  const child = engine.submitJob({
    entryPoint: 'worker', source: 'worker', sessionId: 'worker-session', instanceId: 'worker-instance',
    idempotencyNamespace: 'worker-child', idempotencyKey: 'child', goal: 'inspect repository',
    parentJobId: parent.jobId,
    childContract: {
      required: true,
      workerId: 'repository-reader',
      capabilities: ['repository_snapshot_read'],
      allowedResources: { repository: 'snapshot' },
      budget: { modelCalls: 1 },
    },
  });
  const childLease = engine.claimAttempt({ attemptId: child.attemptId, ownerId: 'child-owner', ttlMs: 60_000, now: 10 });
  engine.graph.create({
    jobId: parent.jobId,
    planDigest: 'worker-plan',
    nodes: [{ nodeId: 'parent-attempt', kind: 'planning' }],
    producer: 'test',
    idempotencyKey: 'worker-graph',
    now: 10,
  });
  return {
    db,
    engine,
    parent,
    child,
    parentAuthority: {
      parentJobId: parent.jobId,
      parentAttemptId: parent.attemptId,
      parentGeneration: parentLease.generation!,
      parentFenceToken: parentLease.fenceToken!,
    },
    childAuthority: {
      childJobId: child.jobId,
      childAttemptId: child.attemptId,
      childGeneration: childLease.generation!,
      childFenceToken: childLease.fenceToken!,
    },
  };
}

export function createAssignment(fixture: WorkerFixture, suffix = 'one') {
  const { engine, parentAuthority, childAuthority } = fixture;
  const assignmentId = `worker_assignment_${suffix}`;
  const providerBinding = engine.worker.createWorkerProviderBinding({
    ...parentAuthority,
    providerBindingId: `worker_provider_${suffix}`,
    schemaVersion: 1,
    providerId: 'custom_openai',
    modelId: 'custom-default',
    providerRuntimeIdentity: 'runtime:custom_openai',
    credentialReference: 'credential:custom_openai',
    endpointReference: 'endpoint:configured',
    capabilitySnapshotHash: 'a'.repeat(64),
    selectionReason: 'configured provider',
    fallbackPolicyId: null,
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    producer: 'test',
    idempotencyKey: `provider-${suffix}`,
    now: 20,
  });
  const contextEnvelope = engine.worker.createWorkerContextEnvelope({
    ...parentAuthority,
    contextEnvelopeId: `worker_context_${suffix}`,
    schemaVersion: 1,
    assignmentId,
    repositorySnapshotId: null,
    planStepIds: ['parent-attempt'],
    claimIds: [],
    sourceReferenceIds: [],
    instructionReferenceIds: [],
    boundedParentNote: 'Inspect only the supplied immutable references.',
    toolSchemaDigest: 'b'.repeat(64),
    tokenEstimate: 64,
    producer: 'test',
    idempotencyKey: `context-${suffix}`,
    now: 21,
  });
  const assignment = engine.worker.createWorkerAssignment({
    ...parentAuthority,
    assignmentId,
    schemaVersion: 1,
    workerDefinitionId: 'repository-reader',
    workerDefinitionVersion: 1,
    childContractId: childAuthority.childJobId,
    childJobId: childAuthority.childJobId,
    repositorySnapshotId: null,
    contextEnvelopeId: contextEnvelope.contextEnvelopeId,
    providerBindingId: providerBinding.providerBindingId,
    capabilitySetId: null,
    goal: 'Inspect the repository snapshot.',
    expectedResultSchemaId: 'worker-result-v1',
    expectedEvidenceSchemaId: null,
    producer: 'test',
    idempotencyKey: `assignment-${suffix}`,
    now: 22,
  });
  return { assignment, providerBinding, contextEnvelope };
}

export function bindRun(fixture: WorkerFixture, suffix = 'one') {
  const records = createAssignment(fixture, suffix);
  const run = fixture.engine.worker.bindWorkerRun({
    ...fixture.parentAuthority,
    ...fixture.childAuthority,
    workerRunId: `worker_run_${suffix}`,
    schemaVersion: 1,
    assignmentId: records.assignment.assignmentId,
    providerBindingId: records.providerBinding.providerBindingId,
    contextEnvelopeId: records.contextEnvelope.contextEnvelopeId,
    producer: 'test',
    idempotencyKey: `run-${suffix}`,
    now: 23,
  });
  return { ...records, run };
}

export function resultPayload(inputHash: string, overrides: Partial<WorkerResultPayloadV1> = {}): WorkerResultPayloadV1 {
  const base: WorkerResultPayloadV1 = {
    schemaVersion: 1,
    status: 'completed',
    summary: 'Repository inspection completed.',
    findings: [],
    sourceReferences: [],
    filesInspected: [],
    commandsExecuted: [],
    diagnostics: [],
    evidenceIds: [],
    unresolvedQuestions: [],
    uncertainty: { level: 'low', reasons: [] },
    providerAttemptIds: [],
    budgetUsage: [],
    timing: { startedAt: 24, completedAt: 25, wallClockMs: 1 },
    failure: null,
    inputHash,
    resultHash: '',
  };
  const payload = { ...base, ...overrides };
  payload.resultHash = computeWorkerResultHash(payload);
  return payload;
}

export function recordResult(fixture: WorkerFixture, suffix = 'one') {
  const records = bindRun(fixture, suffix);
  const payload = resultPayload(records.assignment.inputHash);
  const result = fixture.engine.worker.recordWorkerResult({
    ...fixture.parentAuthority,
    ...fixture.childAuthority,
    workerResultId: `worker_result_${suffix}`,
    workerRunId: records.run.workerRunId,
    assignmentId: records.assignment.assignmentId,
    payload,
    producer: 'test',
    idempotencyKey: `result-${suffix}`,
    now: 26,
  });
  return { ...records, payload, result };
}
