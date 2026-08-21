/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeExternalCodingSession } from '../../../core/v4/coding/runtime';
import { FakeExternalCodingProvider, type FakeExternalCodingScenario } from '../../../core/v4/coding/fakeProvider';
import { ExternalCodingProviderRegistry } from '../../../core/v4/coding/providerRegistry';
import { externalCodingSessionIdentity, externalCodingWorkerRunIdentity } from '../../../core/v4/coding/identities';
import { createExternalCodingVerifier } from '../../../core/v4/coding/verification';
import { recoverCompletedExternalCodingSession } from '../../../core/v4/coding/recovery';
import { computeWorkerDigest } from '../../../core/v4/worker/types';
import type { ValidationExecutionResult } from '../../../core/v4/codebase/structuredValidationAuthority';
import { executeDurableJob, type DurableJobHandle } from '../../../core/v4/daemon/jobLifecycle';
import { sweepDurableJobRecovery } from '../../../core/v4/daemon/jobRecoverySweep';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { createWorkerFixture } from '../worker/fixture';

const roots: string[] = [];

async function setup(scenario: FakeExternalCodingScenario) {
  const fixture = createWorkerFixture(':memory:', Date.now(), 'external-coding-worker');
  const source = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-runtime-source-'));
  const worktreeParent = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-runtime-worktrees-'));
  const homeParent = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-runtime-homes-'));
  roots.push(source, worktreeParent, homeParent);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(source, 'source.txt'), 'source remains untouched\n');
  await writeFile(path.join(source, 'test.js'), "console.log('FIXTURE_TEST_OK');\n");
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);

  const provider = new FakeExternalCodingProvider({ scenario });
  const capability = await provider.capabilities();
  const binding = fixture.engine.worker.createWorkerProviderBinding({
    ...fixture.parentAuthority,
    providerBindingId: `coding_provider_${scenario}`,
    schemaVersion: 1,
    providerId: provider.id,
    modelId: capability.protocolVersion,
    providerRuntimeIdentity: `${provider.id}:${capability.providerVersion}`,
    credentialReference: null,
    endpointReference: null,
    capabilitySnapshotHash: capability.capabilityDigest,
    selectionReason: 'coding capability requested',
    fallbackPolicyId: null,
    contextWindow: 65_536,
    maxOutputTokens: 16_384,
    supportsToolCalling: true,
    supportsStreaming: true,
    catalogDigest: capability.capabilityDigest,
    fallbackBindingIds: [],
    producer: 'test', idempotencyKey: `coding-provider-${scenario}`,
  });
  const assignmentId = `coding_assignment_${scenario}`;
  const context = fixture.engine.worker.createWorkerContextEnvelope({
    ...fixture.parentAuthority,
    contextEnvelopeId: `coding_context_${scenario}`,
    schemaVersion: 1,
    assignmentId,
    repositorySnapshotId: null,
    planStepIds: [], claimIds: [], sourceReferenceIds: [], instructionReferenceIds: [],
    boundedParentNote: 'Prepare an isolated candidate change.',
    toolSchemaDigest: computeWorkerDigest(['external_coding']),
    tokenEstimate: 128,
    producer: 'test', idempotencyKey: `coding-context-${scenario}`,
  });
  const assignment = fixture.engine.worker.createWorkerAssignment({
    ...fixture.parentAuthority,
    assignmentId,
    schemaVersion: 1,
    workerDefinitionId: 'external-coding-worker',
    workerDefinitionVersion: 1,
    childContractId: fixture.child.jobId,
    childJobId: fixture.child.jobId,
    repositorySnapshotId: null,
    contextEnvelopeId: context.contextEnvelopeId,
    providerBindingId: binding.providerBindingId,
    capabilitySetId: null,
    goal: 'Prepare result.txt in an isolated worktree.',
    expectedResultSchemaId: 'external-coding-result-v1',
    expectedEvidenceSchemaId: 'external-coding-proof-v1',
    producer: 'test', idempotencyKey: `coding-assignment-${scenario}`,
  });
  const codingSessionId = externalCodingSessionIdentity(assignment.assignmentId, fixture.child.attemptId, 1);
  fixture.engine.resources.reserveWorker({
    reservationId: `coding_budget_${scenario}`,
    idempotencyKey: `coding-budget-${scenario}`,
    parentJobId: fixture.parent.jobId,
    parentAttemptId: fixture.parent.attemptId,
    parentGeneration: fixture.parentAuthority.parentGeneration,
    parentFenceToken: fixture.parentAuthority.parentFenceToken,
    childJobId: fixture.child.jobId,
    childAttemptId: fixture.child.attemptId,
    childGeneration: 1,
    workerRunId: externalCodingWorkerRunIdentity(codingSessionId, assignment.assignmentId),
    assignmentId: assignment.assignmentId,
    amounts: { workers: 1, model_calls: 1, tool_calls: 8, runtime_ms: 30_000, output_bytes: 32_768 },
  });
  const registry = new ExternalCodingProviderRegistry();
  registry.register(provider);
  const controller = new AbortController();
  const attempt = fixture.engine.getAttempt(fixture.child.attemptId)!;
  const handle: DurableJobHandle = {
    jobId: fixture.child.jobId,
    attemptId: fixture.child.attemptId,
    runId: attempt.rowId,
    generation: fixture.childAuthority.childGeneration,
    fenceToken: fixture.childAuthority.childFenceToken,
    signal: controller.signal,
    pauseAtBoundary() {},
    resumeAttempt() {},
  };
  return {
    fixture, source, worktreeParent, homeParent, provider, registry, assignment, handle, controller,
    modelId: capability.protocolVersion,
  };
}

async function executeWithStructuredVerification(execution: ValidationExecutionResult) {
  const value = await setup('success');
  const result = await executeExternalCodingSession({
    engine: value.fixture.engine,
    handle: value.handle,
    assignmentId: value.assignment.assignmentId,
    providers: value.registry,
    providerId: value.provider.id,
    modelId: value.modelId,
    sourcePath: value.source,
    worktreeParent: value.worktreeParent,
    sessionHomeParent: value.homeParent,
    sourceEnvironment: process.env,
    task: {
      goal: 'Create result.txt.',
      allowedScope: ['result.txt'],
      protectedPaths: [],
      forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
      acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt passes the admitted validation', required: true }],
      validationCommands: ['npm test'],
      networkPolicy: 'disabled',
      packagePolicy: 'deny',
      budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
      promotionPolicy: 'human_approval_required',
    },
    sandboxAvailable: true,
    verify: createExternalCodingVerifier({
      executor: { execute: async () => execution },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        npmVersion: 'test',
      },
    }),
  });
  return { value, result };
}

async function executeWithMismatchedProviderReport(
  reportedFiles: readonly string[],
  execution: ValidationExecutionResult,
  acceptanceCriteria = [{
    claimId: 'claim_result',
    statement: 'node test.js passes and prints FIXTURE_TEST_OK',
    required: true,
  }],
) {
  const value = await setup('success');
  const collectResult = value.provider.collectResult.bind(value.provider);
  vi.spyOn(value.provider, 'collectResult').mockImplementation(async (providerSessionId) => {
    const candidate = await collectResult(providerSessionId);
    return candidate ? { ...candidate, reportedFiles: [...reportedFiles] } : candidate;
  });
  const execute = vi.fn(async () => execution);
  const result = await executeExternalCodingSession({
    engine: value.fixture.engine,
    handle: value.handle,
    assignmentId: value.assignment.assignmentId,
    providers: value.registry,
    providerId: value.provider.id,
    modelId: value.modelId,
    sourcePath: value.source,
    worktreeParent: value.worktreeParent,
    sessionHomeParent: value.homeParent,
    sourceEnvironment: process.env,
    task: {
      goal: 'Create result.txt.',
      allowedScope: ['result.txt'],
      protectedPaths: [],
      forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
      acceptanceCriteria,
      validationCommands: ['node test.js'],
      networkPolicy: 'disabled',
      packagePolicy: 'deny',
      budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
      promotionPolicy: 'human_approval_required',
    },
    sandboxAvailable: true,
    verify: createExternalCodingVerifier({
      executor: { execute },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        npmVersion: 'test',
      },
    }),
  });
  return { value, result, execute };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('durable external coding Worker runtime', () => {
  it.each([
    ['under-reported', []],
    ['wrongly reported', ['wrong-file.js']],
    ['over-reported', ['result.txt', 'nonexistent.js']],
  ] as const)('independently verifies a known candidate when files are %s', async (_label, reportedFiles) => {
    const { value, result, execute } = await executeWithMismatchedProviderReport(reportedFiles, {
      exitCode: 0,
      stdout: 'FIXTURE_TEST_OK\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    });
    try {
      expect(result.mutation).toMatchObject({
        changedPaths: ['result.txt'],
        reportMismatch: true,
        state: 'verified',
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(value.fixture.engine.coding.get(result.codingSessionId)?.validationRefs).toHaveLength(1);
      expect(result.finalization.status).toBe('completed');
      expect(result.proof.verdict).toBe('verified');
      expect(value.fixture.engine.coding.get(result.codingSessionId)?.state).toBe('ready_for_review');
    } finally {
      value.fixture.db.close();
    }
  });

  it('records a failing direct Node validation instead of classifying a known candidate as unknown', async () => {
    const { value, result, execute } = await executeWithMismatchedProviderReport([], {
      exitCode: 1,
      stdout: '',
      stderr: 'expected 2 but received 1\n',
      timedOut: false,
      cancelled: false,
    });
    try {
      expect(execute).toHaveBeenCalledTimes(1);
      expect(value.fixture.engine.coding.get(result.codingSessionId)?.validationRefs).toHaveLength(1);
      expect(result.finalization.status).toBe('failed');
      expect(result.proof.verdict).toBe('failed');
      expect(result.mutation.state).toBe('observed');
    } finally {
      value.fixture.db.close();
    }
  });

  it('does not verify a direct Node command from exit code zero without its required output marker', async () => {
    const { value, result, execute } = await executeWithMismatchedProviderReport([], {
      exitCode: 0,
      stdout: 'command finished\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    });
    try {
      expect(execute).toHaveBeenCalledTimes(1);
      expect(value.fixture.engine.coding.get(result.codingSessionId)?.validationRefs).toHaveLength(1);
      expect(result.finalization.status).toBe('unknown');
      expect(result.proof.verdict).toBe('unknown');
      expect(result.mutation.state).toBe('observed');
    } finally {
      value.fixture.db.close();
    }
  });

  it('uses observed repository truth for safety claims while independently validating the required marker', async () => {
    const value = await setup('success');
    const execute = vi.fn(async (): Promise<ValidationExecutionResult> => ({
      exitCode: 0,
      stdout: 'FIXTURE_TEST_OK\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    }));
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine,
        handle: value.handle,
        assignmentId: value.assignment.assignmentId,
        providers: value.registry,
        providerId: value.provider.id,
        modelId: value.modelId,
        sourcePath: value.source,
        worktreeParent: value.worktreeParent,
        sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env,
        task: {
          goal: 'Prepare the isolated fixture candidate.',
          allowedScope: ['result.txt'],
          protectedPaths: ['protected.txt'],
          forbiddenOperations: ['git.commit', 'git.push', 'git.tag', 'git.merge', 'git.reset', 'git.clean'],
          acceptanceCriteria: [
            { claimId: 'claim_git', statement: 'No commit, push, tag, merge, reset, or clean operations are performed', required: true },
            { claimId: 'claim_protected', statement: 'protected.txt is unchanged', required: true },
            { claimId: 'claim_scope', statement: 'Only result.txt is modified', required: true },
            { claimId: 'claim_validation', statement: 'node test.js exits with status 0 and prints FIXTURE_TEST_OK', required: true },
          ],
          validationCommands: ['node test.js', 'git diff -- result.txt', 'git status --short'],
          networkPolicy: 'disabled',
          packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        sandboxAvailable: true,
        verify: createExternalCodingVerifier({
          executor: { execute },
          environment: {
            platform: process.platform,
            architecture: process.arch,
            nodeVersion: process.version,
            npmVersion: 'test',
          },
        }),
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.mutation).toMatchObject({
        changedPaths: ['result.txt'],
        protectedPathViolations: [],
        unexpectedPaths: [],
        state: 'verified',
      });
      expect(result.proof).toMatchObject({
        verdict: 'verified',
        summary: { requiredClaims: 4, verifiedClaims: 4, failedClaims: 0, unknownClaims: 0 },
      });
      expect(result.finalization.status).toBe('completed');
      expect(value.fixture.engine.coding.get(result.codingSessionId)?.state).toBe('ready_for_review');
    } finally {
      value.fixture.db.close();
    }
  });

  it('verifies separately stated direct command and observed diff claims from independent evidence', async () => {
    const { value, result } = await executeWithMismatchedProviderReport([], {
      exitCode: 0,
      stdout: 'FIXTURE_TEST_OK\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    }, [
      { claimId: 'claim_command', statement: '`node test.js` passes successfully.', required: true },
      { claimId: 'claim_command_exit', statement: '`node test.js` exits successfully.', required: true },
      { claimId: 'claim_marker', statement: 'The test output includes `FIXTURE_TEST_OK`.', required: true },
      { claimId: 'claim_scope', statement: 'Only `result.txt` is modified.', required: true },
      { claimId: 'claim_git', statement: 'No commit, push, or reset operations are performed.', required: true },
      { claimId: 'claim_diff', statement: 'Provide the actual reconciled diff for review.', required: true },
    ]);
    try {
      expect(result.proof).toMatchObject({
        verdict: 'verified',
        summary: { requiredClaims: 6, verifiedClaims: 6, failedClaims: 0, unknownClaims: 0 },
      });
      expect(result.finalization.status).toBe('completed');
      expect(value.fixture.engine.coding.get(result.codingSessionId)?.state).toBe('ready_for_review');
    } finally {
      value.fixture.db.close();
    }
  });

  it('accepts independent structured test totals as verification evidence', async () => {
    const { value, result } = await executeWithStructuredVerification({
      exitCode: 0,
      stdout: 'Tests  4 passed (4)\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    });
    try {
      expect(result.finalization.status).toBe('completed');
      expect(result.proof.verdict).toBe('verified');
      const validationRefs = value.fixture.engine.coding.get(result.codingSessionId)!.validationRefs;
      expect(validationRefs).toHaveLength(1);
      expect(value.fixture.engine.validation.getRun(validationRefs[0]!)).toMatchObject({
        state: 'succeeded',
        parseState: 'parsed',
        passedCount: 4,
        failedCount: 0,
      });
    } finally {
      value.fixture.db.close();
    }
  });

  it('does not treat exit code zero with unparsed output as verified', async () => {
    const { value, result } = await executeWithStructuredVerification({
      exitCode: 0,
      stdout: 'command finished\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    });
    try {
      expect(result.finalization.status).toBe('unknown');
      expect(result.proof.verdict).toBe('unknown');
      expect(result.mutation.state).not.toBe('verified');
    } finally {
      value.fixture.db.close();
    }
  });

  it('records a failing independent validation as a failed coding result', async () => {
    const { value, result } = await executeWithStructuredVerification({
      exitCode: 1,
      stdout: 'Test Files  1 failed (1)\nTests  1 failed (1)\nFAIL result.test.ts > rejects invalid output\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    });
    try {
      expect(result.finalization.status).toBe('failed');
      expect(result.proof.verdict).toBe('failed');
      expect(result.mutation.state).not.toBe('verified');
    } finally {
      value.fixture.db.close();
    }
  });

  it('accepts a candidate only after fresh diff and independent claim verification', async () => {
    const value = await setup('success');
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine,
        handle: value.handle,
        assignmentId: value.assignment.assignmentId,
        providers: value.registry,
        providerId: value.provider.id,
        modelId: value.modelId,
        sourcePath: value.source,
        worktreeParent: value.worktreeParent,
        sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env,
        task: {
          goal: 'Create result.txt.', allowedScope: ['result.txt'], protectedPaths: ['protected.txt'],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt contains the fixture result', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8, eventCount: 20 },
          promotionPolicy: 'human_approval_required',
        },
        sandboxAvailable: true,
        verify: async ({ postSnapshotId, engine }) => {
          const observed = await engine.repository.readFile(postSnapshotId, 'result.txt');
          return {
            claims: [{
              claimId: 'claim_result', state: observed.content === 'FAKE_CODING_RESULT\n' ? 'verified' : 'failed',
              payload: { contentHash: observed.fullContentHash },
            }],
            validationRefs: [],
          };
        },
      });

      expect(result.finalization.status).toBe('completed');
      expect(result.workerResult.acceptanceState).toBe('accepted');
      expect(result.mutation.changedPaths).toEqual(['result.txt']);
      expect(result.proof.verdict).toBe('verified');
      expect(value.fixture.engine.coding.get(result.codingSessionId)?.state).toBe('ready_for_review');
      expect(await readFile(path.join(value.source, 'source.txt'), 'utf8')).toMatch(/source remains untouched/);
      await expect(readFile(path.join(value.source, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      value.fixture.db.close();
    }
  });

  it('blocks a false success report when independent verification fails', async () => {
    const value = await setup('false_success');
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true,
        task: {
          goal: 'Create result.txt.', allowedScope: ['result.txt'], protectedPaths: [],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt exists', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify: async () => ({ claims: [{ claimId: 'claim_result', state: 'failed', payload: { reason: 'missing' } }], validationRefs: [] }),
      });
      expect(result.finalization.status).toBe('failed');
      expect(result.proof.verdict).toBe('failed');
      expect(value.fixture.engine.coding.get(result.codingSessionId)?.state).not.toBe('ready_for_review');
    } finally {
      value.fixture.db.close();
    }
  });

  it('requires reconciliation when a completed provider result remains unverified', async () => {
    const value = await setup('success');
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true,
        task: {
          goal: 'Create result.txt.', allowedScope: ['result.txt'], protectedPaths: [],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt is independently verified', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify: async () => ({
          claims: [{ claimId: 'claim_result', state: 'unknown', payload: { reason: 'validation did not settle' } }],
          validationRefs: [],
        }),
      });

      expect(result.finalization.status).toBe('unknown');
      expect(result.workerResult.status).toBe('blocked');
      expect(result.proof.verdict).toBe('unknown');
      expect(result.workspace.state).toBe('reconciliation_required');
      expect(value.fixture.engine.coding.get(result.codingSessionId)).toMatchObject({
        state: 'unknown',
        reconciliationState: 'required',
      });
    } finally {
      value.fixture.db.close();
    }
  });

  it('persists cancellation before stopping a running provider and reconciles the worktree', async () => {
    const value = await setup('hang');
    const cancel = setTimeout(() => value.controller.abort(new Error('cancelled by test')), 25);
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true, pollIntervalMs: 5,
        task: {
          goal: 'Inspect until cancelled.', allowedScope: ['result.txt'], protectedPaths: [],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt exists', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify: vi.fn(async () => ({ claims: [], validationRefs: [] })),
      });
      const session = value.fixture.engine.coding.get(result.codingSessionId)!;
      const events = value.fixture.engine.coding.listEvents(result.codingSessionId);
      expect(result.finalization.status).toBe('cancelled');
      expect(result.workerResult.status).toBe('cancelled');
      expect(result.proof.verdict).toBe('cancelled');
      expect(session.cancellationRequestedAt).not.toBeNull();
      expect(session.state).toBe('terminal');
      expect(events.findIndex((event) => event.type === 'session.cancel_requested'))
        .toBeLessThan(events.findIndex((event) => event.type === 'process.terminal'));
    } finally {
      clearTimeout(cancel);
      value.fixture.db.close();
    }
  });

  it('keeps a mutation with unknown process outcome blocked for reconciliation without retry', async () => {
    const value = await setup('unknown_outcome');
    const verify = vi.fn(async () => ({ claims: [], validationRefs: [] }));
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true,
        task: {
          goal: 'Prepare a partial candidate.', allowedScope: ['partial.txt'], protectedPaths: [],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_result', statement: 'candidate is verified', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify,
      });
      const session = value.fixture.engine.coding.get(result.codingSessionId)!;
      expect(result.finalization.status).toBe('unknown');
      expect(result.mutation.state).toBe('unknown');
      expect(result.workspace.state).toBe('reconciliation_required');
      expect(session).toMatchObject({ state: 'unknown', reconciliationState: 'required' });
      expect(verify).not.toHaveBeenCalled();
    } finally {
      value.fixture.db.close();
    }
  });

  it('discards one exact unknown isolated attempt and releases the repository for fresh work', async () => {
    const value = await setup('unknown_outcome');
    try {
      const admittedAttempt = value.fixture.engine.getAttempt(value.fixture.child.attemptId)!;
      const admittedJob = value.fixture.engine.getJob(value.fixture.child.jobId)!;
      expect(value.fixture.engine.transitionAttempt({
        attemptId: admittedAttempt.id,
        expectedStateVersion: admittedAttempt.stateVersion,
        generation: value.handle.generation,
        fenceToken: value.handle.fenceToken,
        to: 'running',
        eventIdempotencyKey: 'unknown-discard-attempt-running',
        producer: 'test',
      })).toMatchObject({ applied: true });
      expect(value.fixture.engine.transitionJob({
        jobId: admittedJob.id,
        attemptId: admittedAttempt.id,
        generation: value.handle.generation,
        fenceToken: value.handle.fenceToken,
        expectedStateVersion: admittedJob.stateVersion,
        to: 'running',
        eventIdempotencyKey: 'unknown-discard-job-running',
        producer: 'test',
      })).toMatchObject({ applied: true });
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true,
        task: {
          goal: 'Prepare a partial candidate.', allowedScope: ['partial.txt'], protectedPaths: [],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_result', statement: 'candidate is verified', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify: vi.fn(async () => ({ claims: [], validationRefs: [] })),
      });
      const session = value.fixture.engine.coding.get(result.codingSessionId)!;
      await expect(value.fixture.engine.coding.discardUnknown({
        codingSessionId: session.codingSessionId,
        sessionHomeParent: value.homeParent,
        decidedBy: 'workbench-user',
        decisionChannel: 'workbench-coding-reconciliation',
        idempotencyKey: `discard-unknown:${session.codingSessionId}`,
      })).rejects.toMatchObject({ code: 'RECONCILIATION_AUTHORITY_MISMATCH' });
      const attempt = value.fixture.engine.getAttempt(value.fixture.child.attemptId)!;
      const job = value.fixture.engine.getJob(value.fixture.child.jobId)!;
      expect(value.fixture.engine.transitionAttempt({
        attemptId: attempt.id,
        expectedStateVersion: attempt.stateVersion,
        generation: value.handle.generation,
        fenceToken: value.handle.fenceToken,
        to: 'unknown',
        eventIdempotencyKey: 'unknown-discard-attempt',
        producer: 'test',
      })).toMatchObject({ applied: true });
      const unknownJobTransition = value.fixture.engine.transitionJob({
        jobId: job.id,
        attemptId: attempt.id,
        generation: value.handle.generation,
        fenceToken: value.handle.fenceToken,
        expectedStateVersion: job.stateVersion,
        to: 'unknown',
        eventIdempotencyKey: 'unknown-discard-job',
        producer: 'test',
        finishReason: 'verification_incomplete',
      });
      expect(unknownJobTransition).toMatchObject({ applied: true });

      const discarded = await value.fixture.engine.coding.discardUnknown({
        codingSessionId: session.codingSessionId,
        sessionHomeParent: value.homeParent,
        decidedBy: 'workbench-user',
        decisionChannel: 'workbench-coding-reconciliation',
        idempotencyKey: `discard-unknown:${session.codingSessionId}`,
      });

      expect(discarded).toMatchObject({ state: 'failed', reconciliationState: 'reconciled' });
      expect(value.fixture.engine.codingWorkspaces.get(session.workspaceLeaseId)).toMatchObject({ state: 'released' });
      expect(value.fixture.engine.codingWorkspaces.listActive()).toEqual([]);
      expect(value.fixture.db.prepare('SELECT COUNT(*) AS count FROM external_coding_repository_locks').get())
        .toEqual({ count: 0 });
      await expect(readFile(result.workspace.worktreePath, 'utf8')).rejects.toThrow();
      await expect(readFile(session.sessionHomePath, 'utf8')).rejects.toThrow();
      expect(execFileSync('git', ['-C', value.source, 'status', '--short'], { encoding: 'utf8' })).toBe('');

      const fresh = value.fixture.engine.submitJob({
        entryPoint: 'worker', source: 'worker', sessionId: 'worker-session', instanceId: 'worker-instance',
        idempotencyNamespace: 'external-coding-fresh-after-discard', idempotencyKey: 'fresh-after-discard',
        goal: 'start fresh isolated work', parentJobId: value.fixture.parent.jobId,
        childContract: {
          required: true, workerId: 'external-coding-worker', capabilities: ['external_coding'],
          allowedResources: { repository: 'isolated' }, budget: { modelCalls: 1 },
        },
      });
      const freshAuthority = value.fixture.engine.claimAttempt({
        attemptId: fresh.attemptId, ownerId: 'fresh-owner', ttlMs: 60_000,
      });
      const freshWorkspace = await value.fixture.engine.codingWorkspaces.allocate({
        codingSessionId: 'coding_session_fresh_after_discard',
        childJobId: fresh.jobId,
        childAttemptId: fresh.attemptId,
        childGeneration: freshAuthority.generation!,
        childFenceToken: freshAuthority.fenceToken!,
        sourcePath: value.source,
        worktreeParent: value.worktreeParent,
        protectedPaths: [],
      });
      expect(freshWorkspace.state).toBe('ready');

      await expect(value.fixture.engine.coding.discardUnknown({
        codingSessionId: session.codingSessionId,
        sessionHomeParent: value.homeParent,
        decidedBy: 'workbench-user',
        decisionChannel: 'workbench-coding-reconciliation',
        idempotencyKey: `discard-unknown:${session.codingSessionId}`,
      })).resolves.toMatchObject({ state: 'failed', reconciliationState: 'reconciled' });
      await value.fixture.engine.codingWorkspaces.release({
        workspaceLeaseId: freshWorkspace.workspaceLeaseId,
        codingSessionId: freshWorkspace.codingSessionId,
        childJobId: fresh.jobId,
        childAttemptId: fresh.attemptId,
        childGeneration: freshAuthority.generation!,
        childFenceToken: freshAuthority.fenceToken!,
        disposition: 'discard',
      });
    } finally {
      value.fixture.db.close();
    }
  });

  it('discards a reconciliation-required workspace after its enclosing lifecycle settles failed', async () => {
    const value = await setup('unknown_outcome');
    try {
      const admittedAttempt = value.fixture.engine.getAttempt(value.fixture.child.attemptId)!;
      const admittedJob = value.fixture.engine.getJob(value.fixture.child.jobId)!;
      expect(value.fixture.engine.transitionAttempt({
        attemptId: admittedAttempt.id,
        expectedStateVersion: admittedAttempt.stateVersion,
        generation: value.handle.generation,
        fenceToken: value.handle.fenceToken,
        to: 'running',
        eventIdempotencyKey: 'restart-discard-attempt-running',
        producer: 'test',
      })).toMatchObject({ applied: true });
      expect(value.fixture.engine.transitionJob({
        jobId: admittedJob.id,
        attemptId: admittedAttempt.id,
        generation: value.handle.generation,
        fenceToken: value.handle.fenceToken,
        expectedStateVersion: admittedJob.stateVersion,
        to: 'running',
        eventIdempotencyKey: 'restart-discard-job-running',
        producer: 'test',
      })).toMatchObject({ applied: true });

      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true,
        task: {
          goal: 'Prepare a partial candidate.', allowedScope: ['partial.txt'], protectedPaths: [],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_result', statement: 'candidate is verified', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify: vi.fn(async () => ({ claims: [], validationRefs: [] })),
      });
      const session = value.fixture.engine.coding.get(result.codingSessionId)!;
      value.fixture.db.prepare(
        `UPDATE external_coding_sessions SET state='reconciliation_required' WHERE coding_session_id=?`,
      ).run(session.codingSessionId);

      const attempt = value.fixture.engine.getAttempt(value.fixture.child.attemptId)!;
      const job = value.fixture.engine.getJob(value.fixture.child.jobId)!;
      expect(value.fixture.engine.transitionAttempt({
        attemptId: attempt.id,
        expectedStateVersion: attempt.stateVersion,
        generation: value.handle.generation,
        fenceToken: value.handle.fenceToken,
        to: 'failed',
        eventIdempotencyKey: 'restart-discard-attempt-failed',
        producer: 'test',
      })).toMatchObject({ applied: true });
      expect(value.fixture.engine.transitionJob({
        jobId: job.id,
        attemptId: attempt.id,
        generation: value.handle.generation,
        fenceToken: value.handle.fenceToken,
        expectedStateVersion: job.stateVersion,
        to: 'failed',
        eventIdempotencyKey: 'restart-discard-job-failed',
        producer: 'test',
      })).toMatchObject({ applied: true });

      const discarded = await value.fixture.engine.coding.discardUnknown({
        codingSessionId: session.codingSessionId,
        sessionHomeParent: value.homeParent,
        decidedBy: 'workbench-user',
        decisionChannel: 'workbench-coding-reconciliation',
        idempotencyKey: `restart-discard:${session.codingSessionId}`,
      });

      expect(discarded).toMatchObject({ state: 'failed', reconciliationState: 'reconciled' });
      expect(value.fixture.engine.codingWorkspaces.get(session.workspaceLeaseId)).toMatchObject({ state: 'released' });
      expect(value.fixture.engine.codingWorkspaces.listActive()).toEqual([]);
      expect(value.fixture.db.prepare('SELECT COUNT(*) AS count FROM external_coding_repository_locks').get())
        .toEqual({ count: 0 });
      await expect(readFile(result.workspace.worktreePath, 'utf8')).rejects.toThrow();
      await expect(readFile(session.sessionHomePath, 'utf8')).rejects.toThrow();
      expect(execFileSync('git', ['-C', value.source, 'status', '--short'], { encoding: 'utf8' })).toBe('');
    } finally {
      value.fixture.db.close();
    }
  });

  it('rejects a provider-reported success that changes a protected path', async () => {
    const value = await setup('forbidden_path');
    const verify = vi.fn(async () => ({ claims: [], validationRefs: [] }));
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true,
        task: {
          goal: 'Do not modify protected.txt.', allowedScope: ['result.txt'], protectedPaths: ['protected.txt'],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_result', statement: 'only allowed files changed', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify,
      });
      expect(result.finalization.status).toBe('failed');
      expect(result.mutation).toMatchObject({ state: 'rejected', protectedPathViolations: ['protected.txt'] });
      expect(result.workerResult.status).toBe('failed');
      expect(verify).not.toHaveBeenCalled();
    } finally {
      value.fixture.db.close();
    }
  });

  it.each([
    ['network_attempt', 'network'],
    ['spawn_child', 'child_process'],
  ] as const)('fails closed when a mediated provider requests forbidden %s work', async (scenario, commandClass) => {
    const value = await setup(scenario);
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true, pollIntervalMs: 5,
        task: {
          goal: 'Remain inside the isolated repository.', allowedScope: [], protectedPaths: [],
          forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
          acceptanceCriteria: [{ claimId: 'claim_policy', statement: 'forbidden work did not execute', required: true }],
          validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 2_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify: vi.fn(async () => ({ claims: [], validationRefs: [] })),
      });
      const events = value.fixture.engine.coding.listEvents(result.codingSessionId);
      expect(result.finalization.status).toBe('failed');
      expect(result.workerResult.payload?.failure).toMatchObject({ category: 'auth' });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'session.cancel_requested',
        payload: expect.objectContaining({ reason: `policy_violation:${commandClass}` }),
      }));
      expect(result.mutation.changedPaths).toEqual([]);
    } finally {
      value.fixture.db.close();
    }
  });

  it('releases the isolated workspace when the provider fails before task dispatch', async () => {
    const value = await setup('start_failure');
    try {
      await expect(executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true,
        task: {
          goal: 'Fail before dispatch.', allowedScope: [], protectedPaths: [], forbiddenOperations: [],
          acceptanceCriteria: [], validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify: vi.fn(async () => ({ claims: [], validationRefs: [] })),
      })).rejects.toMatchObject({ code: 'START_FAILED' });
      expect(value.fixture.engine.codingWorkspaces.listActive()).toEqual([]);
      expect(value.fixture.engine.coding.listForJob(value.fixture.parent.jobId))
        .toEqual([expect.objectContaining({ state: 'failed' })]);
      expect(value.fixture.db.prepare('SELECT COUNT(*) AS count FROM external_coding_repository_locks').get())
        .toEqual({ count: 0 });
    } finally {
      value.fixture.db.close();
    }
  });

  it('preserves an unknown isolated outcome when provider transport is lost after mutation', async () => {
    const value = await setup('transport_loss_after_edit');
    try {
      const result = await executeExternalCodingSession({
        engine: value.fixture.engine, handle: value.handle, assignmentId: value.assignment.assignmentId,
        providers: value.registry, providerId: value.provider.id, modelId: value.modelId, sourcePath: value.source,
        worktreeParent: value.worktreeParent, sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env, sandboxAvailable: true,
        task: {
          goal: 'Make one isolated partial change.', allowedScope: ['partial.txt'], protectedPaths: [], forbiddenOperations: [],
          acceptanceCriteria: [], validationCommands: [], networkPolicy: 'disabled', packagePolicy: 'deny',
          budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
          promotionPolicy: 'human_approval_required',
        },
        verify: vi.fn(async () => ({ claims: [], validationRefs: [] })),
      });
      expect(result.finalization.status).toBe('unknown');
      expect(result.mutation.changedPaths).toEqual(['partial.txt']);
      expect(result.workspace.state).toBe('reconciliation_required');
      expect(value.fixture.engine.coding.get(result.codingSessionId)).toMatchObject({
        state: 'unknown', reconciliationState: 'required',
      });
    } finally {
      value.fixture.db.close();
    }
  });

  it('recovers a provider-terminal candidate without rerunning provider or completed validation', async () => {
    const value = await setup('success');
    const execute = vi.fn(async (): Promise<ValidationExecutionResult> => ({
      exitCode: 0,
      stdout: 'FIXTURE_TEST_OK\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    }));
    const verifier = createExternalCodingVerifier({
      executor: { execute },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        npmVersion: 'test',
      },
    });
    const task = {
      goal: 'Create result.txt.',
      allowedScope: ['result.txt'],
      protectedPaths: [],
      forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
      acceptanceCriteria: [{
        claimId: 'claim_recovery',
        statement: 'node test.js passes and prints FIXTURE_TEST_OK',
        required: true,
      }],
      validationCommands: ['node test.js'],
      networkPolicy: 'disabled' as const,
      packagePolicy: 'deny' as const,
      budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
      promotionPolicy: 'human_approval_required' as const,
    };
    try {
      await expect(executeExternalCodingSession({
        engine: value.fixture.engine,
        handle: value.handle,
        assignmentId: value.assignment.assignmentId,
        providers: value.registry,
        providerId: value.provider.id,
        modelId: value.modelId,
        sourcePath: value.source,
        worktreeParent: value.worktreeParent,
        sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env,
        sandboxAvailable: true,
        task,
        verify: async (context) => {
          await verifier(context);
          throw new Error('simulated crash after validation receipt');
        },
      })).rejects.toThrow('simulated crash after validation receipt');
      expect(execute).toHaveBeenCalledTimes(1);
      const originalSession = value.fixture.engine.coding.getForChildJob(value.fixture.child.jobId)!;
      expect(originalSession).toMatchObject({ state: 'reconciliation_required' });
      expect(originalSession.candidateResultRef).toMatch(/^coding_event_/u);

      value.fixture.engine.prepareToolCall({
        toolCallId: 'parent_external_coding_effect',
        jobId: value.fixture.parent.jobId,
        attemptId: value.fixture.parent.attemptId,
        generation: value.fixture.parentAuthority.parentGeneration,
        fenceToken: value.fixture.parentAuthority.parentFenceToken,
        toolName: 'external_coding',
        normalizedArgsDigest: 'parent-external-coding-effect',
        riskTier: 'dangerous',
        mutates: true,
        effect: {
          classification: 'unsafe_mutation',
          kind: 'worker.external_coding',
          target: value.source,
          retrySafety: 'never_automatic',
          idempotencySupported: false,
          idempotencyKey: null,
          reconciliationSupported: false,
          verificationSupported: false,
          approvalRequirement: 'policy',
          approvalState: 'approved',
          sensitiveFields: [],
          redactionRules: ['digest_arguments'],
          trusted: true,
        },
        producer: 'test',
      });
      value.fixture.engine.startToolCall({
        toolCallId: 'parent_external_coding_effect',
        attemptId: value.fixture.parent.attemptId,
        generation: value.fixture.parentAuthority.parentGeneration,
        fenceToken: value.fixture.parentAuthority.parentFenceToken,
        producer: 'test',
      });

      const triggerBus = createTriggerBus({ db: value.fixture.db });
      const recoveryNow = Date.now() + 120_000;
      const swept = sweepDurableJobRecovery({
        jobEngine: value.fixture.engine,
        triggerBus,
        instanceId: 'worker-instance',
        producer: 'test-recovery',
        now: recoveryNow,
      });
      expect(swept.retried).toBeGreaterThanOrEqual(1);
      expect(value.fixture.engine.getJob(value.fixture.parent.jobId)).toMatchObject({
        status: 'blocked',
        activeAttemptId: null,
        finishReason: 'unknown_side_effect',
      });
      const recoveryAttempt = value.fixture.engine.listAttempts(value.fixture.child.jobId)
        .find((attempt) => attempt.recoveryOfAttemptId === value.fixture.child.attemptId)!;
      const recovery = await executeDurableJob({
        engine: value.fixture.engine,
        ownerId: 'recovery-owner',
        admission: {
          existing: {
            jobId: value.fixture.child.jobId,
            attemptId: recoveryAttempt.id,
            runId: recoveryAttempt.rowId,
            reused: true,
          },
          source: 'test-recovery',
        },
        execute: (handle) => recoverCompletedExternalCodingSession({
          engine: value.fixture.engine,
          handle,
          codingSessionId: originalSession.codingSessionId,
          recoveryOfAttemptId: value.fixture.child.attemptId,
          verify: verifier,
        }),
        finalize: (result) => result.finalization,
      });

      expect(recovery.value.providerRerun).toBe(false);
      expect(recovery.value.finalization.status).toBe('completed');
      expect(recovery.value.proof.verdict).toBe('verified');
      expect(recovery.value.promotion?.state).toBe('prepared');
      expect(value.fixture.engine.coding.get(originalSession.codingSessionId)?.state).toBe('ready_for_review');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(value.fixture.engine.validation.getRunForToolCall(
        value.fixture.engine.validation.getRun(recovery.value.validationRefs[0]!)!.toolCallId,
      )?.runId).toBe(recovery.value.validationRefs[0]);
    } finally {
      value.fixture.db.close();
    }
  });

  it('recovers a provider-terminal candidate before mutation reconciliation without crossing Attempt snapshot ancestry', async () => {
    const value = await setup('success');
    const startSession = vi.spyOn(value.provider, 'startSession');
    const reconcile = vi.spyOn(value.fixture.engine.codingMutations, 'reconcile')
      .mockRejectedValueOnce(new Error('simulated crash before candidate reconciliation'));
    const execute = vi.fn(async (): Promise<ValidationExecutionResult> => ({
      exitCode: 0,
      stdout: 'FIXTURE_TEST_OK\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
    }));
    const verifier = createExternalCodingVerifier({
      executor: { execute },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        npmVersion: 'test',
      },
    });
    const task = {
      goal: 'Create result.txt.',
      allowedScope: ['result.txt'],
      protectedPaths: [],
      forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
      acceptanceCriteria: [{
        claimId: 'claim_recovery_before_reconcile',
        statement: 'node test.js passes and prints FIXTURE_TEST_OK',
        required: true,
      }],
      validationCommands: ['node test.js'],
      networkPolicy: 'disabled' as const,
      packagePolicy: 'deny' as const,
      budgets: { runtimeMs: 30_000, outputBytes: 32_768, commandCount: 8 },
      promotionPolicy: 'human_approval_required' as const,
    };
    try {
      await expect(executeExternalCodingSession({
        engine: value.fixture.engine,
        handle: value.handle,
        assignmentId: value.assignment.assignmentId,
        providers: value.registry,
        providerId: value.provider.id,
        modelId: value.modelId,
        sourcePath: value.source,
        worktreeParent: value.worktreeParent,
        sessionHomeParent: value.homeParent,
        sourceEnvironment: process.env,
        sandboxAvailable: true,
        task,
        verify: verifier,
      })).rejects.toThrow('simulated crash before candidate reconciliation');
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      const originalSession = value.fixture.engine.coding.getForChildJob(value.fixture.child.jobId)!;
      expect(originalSession).toMatchObject({ state: 'reconciliation_required' });
      expect(originalSession.candidateResultRef).toMatch(/^coding_event_/u);
      expect(value.fixture.engine.codingMutations.getForSession(originalSession.codingSessionId)).toBeNull();

      const triggerBus = createTriggerBus({ db: value.fixture.db });
      const recoveryNow = Date.now() + 120_000;
      const swept = sweepDurableJobRecovery({
        jobEngine: value.fixture.engine,
        triggerBus,
        instanceId: 'worker-instance',
        producer: 'test-recovery',
        now: recoveryNow,
      });
      expect(swept.retried).toBeGreaterThanOrEqual(1);
      const recoveryAttempt = value.fixture.engine.listAttempts(value.fixture.child.jobId)
        .find((attempt) => attempt.recoveryOfAttemptId === value.fixture.child.attemptId)!;
      const recovery = await executeDurableJob({
        engine: value.fixture.engine,
        ownerId: 'recovery-owner',
        admission: {
          existing: {
            jobId: value.fixture.child.jobId,
            attemptId: recoveryAttempt.id,
            runId: recoveryAttempt.rowId,
            reused: true,
          },
          source: 'test-recovery',
        },
        execute: (handle) => recoverCompletedExternalCodingSession({
          engine: value.fixture.engine,
          handle,
          codingSessionId: originalSession.codingSessionId,
          recoveryOfAttemptId: value.fixture.child.attemptId,
          verify: verifier,
        }),
        finalize: (result) => result.finalization,
      });

      expect(recovery.value.providerRerun).toBe(false);
      expect(recovery.value.finalization.status).toBe('completed');
      expect(recovery.value.proof.verdict).toBe('verified');
      expect(recovery.value.promotion?.state).toBe('prepared');
      expect(value.fixture.engine.coding.get(originalSession.codingSessionId)?.state).toBe('ready_for_review');
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(recovery.value.mutation.preSnapshotId).toBe(originalSession.preSnapshotId);
      expect(value.fixture.engine.repository.getSnapshot(recovery.value.mutation.preSnapshotId))
        .toMatchObject({ attemptId: value.fixture.child.attemptId, generation: 1 });
      expect(value.fixture.engine.repository.getSnapshot(recovery.value.mutation.postSnapshotId!))
        .toMatchObject({ attemptId: recoveryAttempt.id, generation: recoveryAttempt.generation });
    } finally {
      value.fixture.db.close();
    }
  });
});
