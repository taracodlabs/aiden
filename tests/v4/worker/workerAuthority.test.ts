/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { computeWorkerResultHash } from '../../../core/v4/worker/types';
import {
  bindRun,
  createAssignment,
  createWorkerFixture,
  recordResult,
  resultPayload,
  type WorkerFixture,
} from './fixture';

describe('WorkerAuthority', () => {
  let fixture: WorkerFixture | undefined;
  const make = () => (fixture = createWorkerFixture());
  afterEach(() => fixture?.db.close());

  it('creates one immutable assignment for an active parent Attempt', () => {
    const current = make();
    const { assignment } = createAssignment(current);
    expect(current.engine.worker.getWorkerAssignment(assignment.assignmentId)).toEqual(assignment);
    expect(assignment).toMatchObject({
      parentJobId: current.parent.jobId,
      parentAttemptId: current.parent.attemptId,
      childJobId: current.child.jobId,
      workerDefinitionId: 'repository-reader',
    });
    expect(assignment.parentFenceDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('returns the original assignment for an identical idempotent request', () => {
    const current = make();
    const first = createAssignment(current);
    const second = current.engine.worker.createWorkerAssignment({
      ...current.parentAuthority,
      assignmentId: 'different-id-is-ignored-on-replay',
      schemaVersion: 1,
      workerDefinitionId: 'repository-reader', workerDefinitionVersion: 1,
      childContractId: current.child.jobId, childJobId: current.child.jobId,
      repositorySnapshotId: null,
      contextEnvelopeId: first.contextEnvelope.contextEnvelopeId,
      providerBindingId: first.providerBinding.providerBindingId,
      capabilitySetId: null,
      goal: 'Inspect the repository snapshot.',
      expectedResultSchemaId: 'worker-result-v1', expectedEvidenceSchemaId: null,
      producer: 'test', idempotencyKey: 'assignment-one', now: 30,
    });
    expect(second).toEqual(first.assignment);
  });

  it('rejects an idempotency key reused with different assignment input', () => {
    const current = make();
    const first = createAssignment(current);
    expect(() => current.engine.worker.createWorkerAssignment({
      ...current.parentAuthority,
      assignmentId: 'worker_assignment_conflict', schemaVersion: 1,
      workerDefinitionId: 'repository-reader', workerDefinitionVersion: 1,
      childContractId: current.child.jobId, childJobId: current.child.jobId,
      repositorySnapshotId: null,
      contextEnvelopeId: first.contextEnvelope.contextEnvelopeId,
      providerBindingId: first.providerBinding.providerBindingId,
      capabilitySetId: null,
      goal: 'Different goal', expectedResultSchemaId: 'worker-result-v1', expectedEvidenceSchemaId: null,
      producer: 'test', idempotencyKey: 'assignment-one', now: 30,
    })).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }));
  });

  it('rejects assignment creation under a stale parent generation', () => {
    const current = make();
    const { providerBinding, contextEnvelope } = createAssignment(current);
    expect(() => current.engine.worker.createWorkerAssignment({
      ...current.parentAuthority, parentGeneration: current.parentAuthority.parentGeneration + 1,
      assignmentId: 'worker_assignment_stale', schemaVersion: 1,
      workerDefinitionId: 'repository-reader', workerDefinitionVersion: 1,
      childContractId: current.child.jobId, childJobId: current.child.jobId, repositorySnapshotId: null,
      contextEnvelopeId: contextEnvelope.contextEnvelopeId, providerBindingId: providerBinding.providerBindingId,
      capabilitySetId: null, goal: 'stale', expectedResultSchemaId: 'worker-result-v1', expectedEvidenceSchemaId: null,
      producer: 'test', idempotencyKey: 'assignment-stale', now: 31,
    })).toThrowError(expect.objectContaining({ code: 'stale_authority' }));
  });

  it('rejects assignment creation with the wrong parent fence', () => {
    const current = make();
    const { providerBinding, contextEnvelope } = createAssignment(current);
    expect(() => current.engine.worker.createWorkerAssignment({
      ...current.parentAuthority, parentFenceToken: 'wrong-fence',
      assignmentId: 'worker_assignment_wrong_fence', schemaVersion: 1,
      workerDefinitionId: 'repository-reader', workerDefinitionVersion: 1,
      childContractId: current.child.jobId, childJobId: current.child.jobId, repositorySnapshotId: null,
      contextEnvelopeId: contextEnvelope.contextEnvelopeId, providerBindingId: providerBinding.providerBindingId,
      capabilitySetId: null, goal: 'wrong fence', expectedResultSchemaId: 'worker-result-v1', expectedEvidenceSchemaId: null,
      producer: 'test', idempotencyKey: 'assignment-wrong-fence', now: 31,
    })).toThrowError(expect.objectContaining({ code: 'stale_authority' }));
  });

  it('rejects an assignment that references an unrelated child contract', () => {
    const current = make();
    const unrelatedParent = current.engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'worker-session', instanceId: 'worker-instance',
      idempotencyNamespace: 'unrelated-parent', idempotencyKey: 'job', goal: 'unrelated parent',
    });
    const unrelated = current.engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'worker-session', instanceId: 'worker-instance',
      idempotencyNamespace: 'unrelated', idempotencyKey: 'job', goal: 'unrelated',
      parentJobId: unrelatedParent.jobId,
      childContract: { workerId: 'repository-reader', capabilities: [], allowedResources: {}, budget: {} },
    });
    const { providerBinding, contextEnvelope } = createAssignment(current);
    expect(() => current.engine.worker.createWorkerAssignment({
      ...current.parentAuthority,
      assignmentId: 'worker_assignment_unrelated', schemaVersion: 1,
      workerDefinitionId: 'repository-reader', workerDefinitionVersion: 1,
      childContractId: unrelated.jobId, childJobId: unrelated.jobId, repositorySnapshotId: null,
      contextEnvelopeId: contextEnvelope.contextEnvelopeId, providerBindingId: providerBinding.providerBindingId,
      capabilitySetId: null, goal: 'unrelated', expectedResultSchemaId: 'worker-result-v1', expectedEvidenceSchemaId: null,
      producer: 'test', idempotencyKey: 'assignment-unrelated', now: 31,
    })).toThrowError(expect.objectContaining({ code: 'lineage_mismatch' }));
  });

  it.each(['apiKey', 'accessToken', 'refreshToken', 'cookie', 'authorization', 'environment'])(
    'rejects provider binding secret field %s',
    (field) => {
      const current = make();
      const command: Record<string, unknown> = {
        ...current.parentAuthority,
        providerBindingId: `provider_${field}`, schemaVersion: 1,
        providerId: 'custom_openai', modelId: 'custom-default', providerRuntimeIdentity: 'runtime:custom',
        credentialReference: 'credential:custom', endpointReference: 'endpoint:configured',
        capabilitySnapshotHash: 'a'.repeat(64), selectionReason: 'configured', fallbackPolicyId: null,
        contextWindow: 32_768, maxOutputTokens: 4_096, producer: 'test', idempotencyKey: `provider-${field}`,
        [field]: 'secret-material',
      };
      expect(() => current.engine.worker.createWorkerProviderBinding(command as never))
        .toThrowError(expect.objectContaining({ code: 'sensitive_input' }));
    },
  );

  it('rejects a raw token supplied through a credential reference field', () => {
    const current = make();
    expect(() => current.engine.worker.createWorkerProviderBinding({
      ...current.parentAuthority,
      providerBindingId: 'provider_raw_token', schemaVersion: 1,
      providerId: 'custom_openai', modelId: 'custom-default', providerRuntimeIdentity: 'runtime:custom',
      credentialReference: `gsk_${'a'.repeat(32)}`, endpointReference: 'endpoint:configured',
      capabilitySnapshotHash: 'a'.repeat(64), selectionReason: 'configured', fallbackPolicyId: null,
      contextWindow: 32_768, maxOutputTokens: 4_096, producer: 'test', idempotencyKey: 'provider-raw-token',
    })).toThrowError(expect.objectContaining({ code: 'sensitive_input' }));
  });

  it('replays provider and context creation idempotently without duplicate events', () => {
    const current = make();
    const first = createAssignment(current);
    const second = createAssignment(current);
    expect(second.providerBinding).toEqual(first.providerBinding);
    expect(second.contextEnvelope).toEqual(first.contextEnvelope);
    expect(current.engine.worker.listWorkerEvents(current.parent.jobId).map((event) => event.kind)).toEqual([
      'worker.provider_binding_created', 'worker.context_finalized', 'worker.assignment_created',
    ]);
  });

  it.each(['env', 'environment', 'conversationHistory', 'messages', 'fenceToken'])(
    'rejects context envelope ambient field %s',
    (field) => {
      const current = make();
      const command: Record<string, unknown> = {
        ...current.parentAuthority,
        contextEnvelopeId: `context_${field}`, schemaVersion: 1, assignmentId: `assignment_${field}`,
        repositorySnapshotId: null, planStepIds: [], claimIds: [], sourceReferenceIds: [],
        instructionReferenceIds: [], boundedParentNote: null, toolSchemaDigest: 'b'.repeat(64),
        tokenEstimate: 0, producer: 'test', idempotencyKey: `context-${field}`,
        [field]: field === 'fenceToken' ? 'raw-fence' : { HOME: 'private' },
      };
      expect(() => current.engine.worker.createWorkerContextEnvelope(command as never))
        .toThrowError(expect.objectContaining({ code: 'sensitive_input' }));
    },
  );

  it('persists only bounded context references and digests', () => {
    const current = make();
    const { contextEnvelope } = createAssignment(current);
    expect(contextEnvelope).toMatchObject({
      planStepIds: ['parent-attempt'], claimIds: [], sourceReferenceIds: [], instructionReferenceIds: [],
      boundedParentNote: 'Inspect only the supplied immutable references.', tokenEstimate: 64,
    });
    expect(contextEnvelope.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    const raw = JSON.stringify(contextEnvelope);
    expect(raw).not.toMatch(/fenceToken|conversationHistory|process\.env|apiKey|accessToken/u);
  });

  it('binds one WorkerRun to one exact child Attempt generation', () => {
    const current = make();
    const { run } = bindRun(current);
    expect(run).toMatchObject({
      childJobId: current.child.jobId,
      childAttemptId: current.child.attemptId,
      childGeneration: current.childAuthority.childGeneration,
    });
    expect(current.engine.worker.getWorkerRun(run.workerRunId)).toEqual(run);
  });

  it('replays an identical WorkerRun binding idempotently', () => {
    const current = make();
    const first = bindRun(current);
    const second = current.engine.worker.bindWorkerRun({
      ...current.parentAuthority, ...current.childAuthority,
      workerRunId: 'different-run-id-is-ignored-on-replay', schemaVersion: 1,
      assignmentId: first.assignment.assignmentId,
      providerBindingId: first.providerBinding.providerBindingId,
      contextEnvelopeId: first.contextEnvelope.contextEnvelopeId,
      producer: 'test', idempotencyKey: 'run-one', now: 24,
    });
    expect(second).toEqual(first.run);
    expect(current.engine.worker.listWorkerRunsForChild(current.child.jobId)).toEqual([first.run]);
  });

  it('rejects a WorkerRun bound to an Attempt from another child Job', () => {
    const current = make();
    const records = createAssignment(current);
    const other = current.engine.submitJob({
      entryPoint: 'worker', source: 'worker', sessionId: 'worker-session', instanceId: 'worker-instance',
      idempotencyNamespace: 'other-child', idempotencyKey: 'other', goal: 'other', parentJobId: current.parent.jobId,
      childContract: { workerId: 'repository-reader', capabilities: [], allowedResources: {}, budget: {} },
    });
    const lease = current.engine.claimAttempt({ attemptId: other.attemptId, ownerId: 'other', ttlMs: 60_000, now: 10 });
    expect(() => current.engine.worker.bindWorkerRun({
      ...current.parentAuthority,
      childJobId: current.child.jobId, childAttemptId: other.attemptId,
      childGeneration: lease.generation!, childFenceToken: lease.fenceToken!,
      workerRunId: 'worker_run_wrong_job', schemaVersion: 1, assignmentId: records.assignment.assignmentId,
      providerBindingId: records.providerBinding.providerBindingId,
      contextEnvelopeId: records.contextEnvelope.contextEnvelopeId,
      producer: 'test', idempotencyKey: 'run-wrong-job', now: 23,
    })).toThrowError(expect.objectContaining({ code: 'lineage_mismatch' }));
  });

  it('rejects a conflicting second run binding for one child Attempt generation', () => {
    const current = make();
    bindRun(current);
    const records = createAssignment(current, 'two');
    expect(() => current.engine.worker.bindWorkerRun({
      ...current.parentAuthority, ...current.childAuthority,
      workerRunId: 'worker_run_two', schemaVersion: 1, assignmentId: records.assignment.assignmentId,
      providerBindingId: records.providerBinding.providerBindingId,
      contextEnvelopeId: records.contextEnvelope.contextEnvelopeId,
      producer: 'test', idempotencyKey: 'run-two', now: 23,
    })).toThrowError(expect.objectContaining({ code: 'binding_conflict' }));
  });

  it('accepts a WorkerResult with the exact run, generation, and input hash', () => {
    const current = make();
    const { result } = recordResult(current);
    expect(result.acceptanceState).toBe('accepted');
    expect(current.engine.worker.getWorkerRun('worker_run_one')?.acceptedResultId).toBe(result.workerResultId);
  });

  it('returns the original result for an identical duplicate delivery', () => {
    const current = make();
    const first = recordResult(current);
    const duplicate = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_duplicate-id', workerRunId: first.run.workerRunId,
      assignmentId: first.assignment.assignmentId, payload: first.payload,
      producer: 'test', idempotencyKey: 'result-one', now: 27,
    });
    expect(duplicate).toEqual(first.result);
  });

  it('retains a conflicting result hash under the same idempotency key as rejected', () => {
    const current = make();
    const first = recordResult(current);
    const payload = resultPayload(first.assignment.inputHash, { summary: 'conflicting result' });
    const conflict = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_conflict', workerRunId: first.run.workerRunId,
      assignmentId: first.assignment.assignmentId, payload,
      producer: 'test', idempotencyKey: 'result-one', now: 27,
    });
    expect(conflict).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'idempotency_conflict' });
    expect(current.engine.worker.getWorkerRun(first.run.workerRunId)?.acceptedResultId).toBe(first.result.workerResultId);
  });

  it('does not treat different forged payloads with the same declared hash as identical', () => {
    const current = make();
    const records = bindRun(current);
    const firstPayload = resultPayload(records.assignment.inputHash, { summary: 'first forged result' });
    firstPayload.resultHash = 'c'.repeat(64);
    const first = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_forged_first', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId, payload: firstPayload,
      producer: 'test', idempotencyKey: 'result-forged', now: 25,
    });
    const secondPayload = resultPayload(records.assignment.inputHash, { summary: 'second forged result' });
    secondPayload.resultHash = 'c'.repeat(64);
    const second = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_forged_second', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId, payload: secondPayload,
      producer: 'test', idempotencyKey: 'result-forged', now: 26,
    });
    expect(first).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'result_hash_mismatch' });
    expect(second).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'idempotency_conflict' });
    expect(second.workerResultId).not.toBe(first.workerResultId);
  });

  it('retains a stale child-generation result as rejected', () => {
    const current = make();
    const records = bindRun(current);
    const payload = resultPayload(records.assignment.inputHash);
    const stale = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      childGeneration: current.childAuthority.childGeneration + 1,
      workerResultId: 'worker_result_stale', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId, payload,
      producer: 'test', idempotencyKey: 'result-stale', now: 27,
    });
    expect(stale).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'stale_generation' });
    expect(current.engine.worker.getWorkerRun(records.run.workerRunId)?.acceptedResultId).toBeNull();
  });

  it('rejects a result after parent cancellation without altering Claims or parent truth', () => {
    const current = make();
    const records = bindRun(current);
    const claim = current.engine.proof.createClaim({
      jobId: current.parent.jobId, attemptId: current.parent.attemptId,
      generation: current.parentAuthority.parentGeneration, category: 'contract', statement: 'Parent outcome', required: true,
    });
    current.engine.cancelJob({ jobId: current.parent.jobId, reason: 'stop', producer: 'test', eventIdempotencyKey: 'cancel-parent', now: 24 });
    const rejected = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_cancelled', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId, payload: resultPayload(records.assignment.inputHash),
      producer: 'test', idempotencyKey: 'result-cancelled', now: 25,
    });
    expect(rejected).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'authority_lost' });
    expect(current.engine.proof.listClaims(current.parent.jobId)).toContainEqual(expect.objectContaining({ claimId: claim.claimId, state: 'unverified' }));
    expect(current.engine.getJob(current.parent.jobId)?.status).toBe('cancelled');
  });

  it('retains a result after child cancellation without changing parent truth', () => {
    const current = make();
    const records = bindRun(current);
    current.engine.cancelJob({
      jobId: current.child.jobId, reason: 'stop child', producer: 'test',
      eventIdempotencyKey: 'cancel-child', now: 24,
    });
    const rejected = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_child_cancelled', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId, payload: resultPayload(records.assignment.inputHash),
      producer: 'test', idempotencyKey: 'result-child-cancelled', now: 25,
    });
    expect(rejected).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'authority_lost' });
    expect(current.engine.getJob(current.child.jobId)?.status).toBe('cancelled');
    expect(current.engine.getJob(current.parent.jobId)?.status).toBe('queued');
  });

  it('retains malformed WorkerResult payload as a typed rejection', () => {
    const current = make();
    const records = bindRun(current);
    const rejected = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_malformed', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId,
      payload: { status: 'completed', summary: ['not-a-string'] } as never,
      producer: 'test', idempotencyKey: 'result-malformed', now: 25,
    });
    expect(rejected).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'malformed_payload' });
    expect(rejected.rejectionReason).not.toContain('not-a-string');
  });

  it('rejects malformed nested result fields and sensitive extension fields', () => {
    const current = make();
    const records = bindRun(current);
    const malformed = resultPayload(records.assignment.inputHash) as unknown as Record<string, unknown>;
    malformed.findings = [1];
    malformed.apiKey = 'not-persisted';
    const rejected = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_nested_malformed', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId, payload: malformed,
      producer: 'test', idempotencyKey: 'result-nested-malformed', now: 25,
    });
    expect(rejected).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'malformed_payload' });
    expect(JSON.stringify(rejected)).not.toContain('not-persisted');
  });

  it('rejects an incorrect declared result hash', () => {
    const current = make();
    const records = bindRun(current);
    const payload = resultPayload(records.assignment.inputHash);
    payload.resultHash = 'c'.repeat(64);
    expect(computeWorkerResultHash(payload)).not.toBe(payload.resultHash);
    const rejected = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_bad_hash', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId, payload,
      producer: 'test', idempotencyKey: 'result-bad-hash', now: 25,
    });
    expect(rejected).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'result_hash_mismatch' });
  });

  it('does not create or verify a Claim for completed output without Evidence', () => {
    const current = make();
    const claim = current.engine.proof.createClaim({
      jobId: current.parent.jobId, attemptId: current.parent.attemptId,
      generation: current.parentAuthority.parentGeneration, category: 'contract', statement: 'Requires proof', required: true,
    });
    const { result } = recordResult(current);
    expect(result.acceptanceState).toBe('accepted');
    expect(current.engine.proof.listClaims(current.parent.jobId)).toEqual([
      expect.objectContaining({ claimId: claim.claimId, state: 'unverified' }),
    ]);
  });

  it('does not create a parent Verdict or Proof when a WorkerResult is accepted', () => {
    const current = make();
    recordResult(current);
    expect(current.engine.proof.getVerdict(current.parent.jobId)).toBeNull();
    expect(current.engine.getJob(current.parent.jobId)?.status).toBe('queued');
  });

  it('replays ordered Worker events deterministically without sensitive payloads', () => {
    const current = make();
    recordResult(current);
    const events = current.engine.worker.listWorkerEvents(current.parent.jobId);
    expect(events.map((event) => event.kind)).toEqual([
      'worker.provider_binding_created',
      'worker.context_finalized',
      'worker.assignment_created',
      'worker.run_bound',
      'worker.result_received',
      'worker.result_accepted',
    ]);
    expect(current.engine.worker.rebuildWorkerProjection(current.parent.jobId)).toEqual({
      assignmentIds: ['worker_assignment_one'],
      providerBindingIds: ['worker_provider_one'],
      contextEnvelopeIds: ['worker_context_one'],
      workerRunIds: ['worker_run_one'],
      receivedResultIds: ['worker_result_one'],
      acceptedResultIds: ['worker_result_one'],
      rejectedResultIds: [],
    });
    expect(JSON.stringify(events)).not.toMatch(/raw-fence|secret-material|authorization|credential:custom_openai/u);
  });

  it('bounds result payload size and diagnostic arrays', () => {
    const current = make();
    const records = bindRun(current);
    const payload = resultPayload(records.assignment.inputHash, { summary: 'x'.repeat(70_000) });
    const rejected = current.engine.worker.recordWorkerResult({
      ...current.parentAuthority, ...current.childAuthority,
      workerResultId: 'worker_result_oversize', workerRunId: records.run.workerRunId,
      assignmentId: records.assignment.assignmentId, payload,
      producer: 'test', idempotencyKey: 'result-oversize', now: 25,
    });
    expect(rejected).toMatchObject({ acceptanceState: 'rejected', rejectionCode: 'payload_too_large' });
  });
});
