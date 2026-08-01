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
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { executeDurableJob } from '../../../core/v4/daemon/jobLifecycle';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ProviderAttemptLedger } from '../../../core/v4/usageLedger';
import {
  admitReadOnlyRepositoryWorker,
  executeReadOnlyRepositoryWorker,
  verifyReadOnlyRepositoryWorkerResult,
} from '../../../core/v4/worker/readOnlyRepositoryWorker';
import { createDurableWorkerProviderBridge } from '../../../core/v4/worker/workerProviderBridge';
import {
  beginPhysicalProviderAttempt,
  createLogicalProviderCallId,
  setProviderAttemptLedger,
} from '../../../providers/v4/providerAttemptAccounting';
import type { ProviderAdapter, ProviderCallInput, ProviderCallOutput } from '../../../providers/v4/types';
import { ProviderRateLimitError } from '../../../providers/v4/errors';

describe('read-only repository Worker runtime', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let root: string;
  let home: string;
  let ledgerPath: string;
  let ledger: ProviderAttemptLedger;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      'INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)',
    ).run('worker-instance', 1, 'localhost', Date.now(), Date.now(), '4.18.0');
    engine = createJobEngine({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-worker-runtime-'));
    home = await mkdtemp(path.join(os.tmpdir(), 'aiden-worker-runtime-home-'));
    ledgerPath = path.join(home, 'usage.db');
    ledger = new ProviderAttemptLedger(ledgerPath);
    setProviderAttemptLedger(ledger);
    await writeFile(path.join(root, 'AGENTS.md'), 'Inspect source.ts before reporting.\n');
    await writeFile(path.join(root, 'source.ts'), 'export const marker = "durable-worker";\n');
  });

  afterEach(async () => {
    setProviderAttemptLedger(null);
    ledger.close();
    db.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  });

  async function setup(maxModelCalls = 4) {
    const parent = engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'parent-session', workspaceId: root,
      instanceId: 'worker-instance', idempotencyNamespace: 'worker-parent', idempotencyKey: 'one',
      goal: 'Verify the durable Worker marker.',
    });
    engine.resources.configure({
      jobId: parent.jobId,
      budgets: {
        workers: 1, model_calls: 10, retries: 4, tool_calls: 20, runtime_ms: 300_000,
        input_tokens: 100_000, output_tokens: 40_000, reasoning_tokens: 40_000,
        output_bytes: 2_000_000,
      },
    });
    const parentLease = engine.claimAttempt({ attemptId: parent.attemptId, ownerId: 'worker-instance', ttlMs: 60_000 });
    if (!parentLease.acquired || !parentLease.fenceToken || parentLease.generation === undefined) throw new Error('parent lease');
    const snapshot = await engine.repository.captureSnapshot({
      jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation,
      fenceToken: parentLease.fenceToken, requestedPath: root, producer: 'test',
    });
    engine.graph.createCodingPlan({
      jobId: parent.jobId, planDigest: 'read-worker-plan', producer: 'test', idempotencyKey: 'plan',
      steps: [{
        stepId: 'inspect-source', label: 'Inspect source', repositorySnapshotId: snapshot.id,
        requiresVerification: true,
      }],
    });
    const entry = engine.repository.getEntry(snapshot.id, 'source.ts')!;
    const claim = engine.proof.createClaim({
      jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation,
      category: 'observed', statement: 'source.ts contains the durable Worker marker.', required: true,
      repositorySnapshotId: snapshot.id,
      sourceReferences: [{ snapshotId: snapshot.id, path: 'source.ts', lineStart: 1, lineEnd: 1 }],
      requiredEvidenceCategories: ['repository_readback'],
    });
    const admitted = admitReadOnlyRepositoryWorker({
      engine, triggerBus: createTriggerBus({ db }),
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation, fenceToken: parentLease.fenceToken },
      idempotencyKey: 'inspect-source', goal: 'Find the marker in source.ts and cite line 1.',
      repositorySnapshotId: snapshot.id, planStepIds: ['inspect-source'], claimIds: [claim.claimId],
      boundedParentNote: 'Use only the pinned snapshot.',
      provider: {
        providerId: 'fixture', modelId: 'fixture-tool-model', providerRuntimeIdentity: 'runtime:fixture',
        credentialReference: null, endpointReference: null, supportsToolCalling: true,
        contextWindow: 8_192, maxOutputTokens: 2_048, selectionReason: 'deterministic test provider',
      },
      maxModelCalls,
    });
    return { parent, parentLease, snapshot, entry, claim, admitted };
  }

  function resolvedProvider(adapter: ProviderAdapter) {
    return {
      adapter,
      paths: resolveAidenPaths({ rootOverride: home }),
      providerId: 'fixture',
      modelId: 'fixture-tool-model',
      providerRuntimeIdentity: 'runtime:fixture',
      credentialReference: null,
      endpointReference: null,
    };
  }

  function directBridge(admitted: Awaited<ReturnType<typeof setup>>['admitted'], adapter: ProviderAdapter) {
    const controller = new AbortController();
    const lease = engine.claimAttempt({
      attemptId: admitted.child.attemptId, ownerId: 'worker-instance', ttlMs: 60_000,
    });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('worker lease');
    const handle = {
      jobId: admitted.child.jobId,
      attemptId: admitted.child.attemptId,
      runId: admitted.child.runId,
      generation: lease.generation,
      fenceToken: lease.fenceToken,
      signal: controller.signal,
      pauseAtBoundary() {},
      resumeAttempt() {},
    };
    const workerRun = engine.worker.bindWorkerRunFromAssignment({
      childJobId: handle.jobId,
      childAttemptId: handle.attemptId,
      childGeneration: handle.generation,
      childFenceToken: handle.fenceToken,
      workerRunId: admitted.reservation.workerRunId,
      schemaVersion: 1,
      assignmentId: admitted.assignment.assignmentId,
      providerBindingId: admitted.providerBinding.providerBindingId,
      contextEnvelopeId: admitted.contextEnvelope.contextEnvelopeId,
      producer: 'test',
      idempotencyKey: `worker-run:${handle.attemptId}:${handle.generation}`,
    });
    return createDurableWorkerProviderBridge({
      engine,
      handle,
      assignment: admitted.assignment,
      workerRun,
      binding: admitted.providerBinding,
      reservation: admitted.reservation,
      adapter,
    });
  }

  async function runWorker(
    admitted: Awaited<ReturnType<typeof setup>>['admitted'],
    adapter: ProviderAdapter,
  ) {
    let attemptIndex = 0;
    const accounted: ProviderAdapter = {
      apiMode: adapter.apiMode,
      async call(providerInput) {
        const lifecycle = beginPhysicalProviderAttempt(providerInput, {
          providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: adapter.apiMode,
          transport: 'fixture', attemptIndex: attemptIndex++,
          logicalCallId: providerInput.usageContext?.logicalCallId ?? createLogicalProviderCallId(),
          requestBytes: JSON.stringify(providerInput.messages).length,
        });
        try {
          const output = await adapter.call(providerInput);
          lifecycle.success(output, JSON.stringify(output).length);
          return output;
        } catch (error) {
          lifecycle.failure(error, { sent: true });
          throw error;
        }
      },
    };
    return executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-dispatch' },
      execute: (handle) => executeReadOnlyRepositoryWorker({
        engine, handle, assignmentId: admitted.assignment.assignmentId,
        resolveProvider: async () => resolvedProvider(accounted),
      }),
      finalize: (value) => value.finalization,
    });
  }

  it('runs one pinned provider binding, records child Evidence, and independently verifies the parent Claim', async () => {
    const { parent, parentLease, snapshot, entry, claim, admitted } = await setup();
    const inputs: ProviderCallInput[] = [];
    const responses: ProviderCallOutput[] = [
      {
        content: null,
        toolCalls: [
          { id: 'search', name: 'repository_snapshot_search', arguments: { query: 'durable-worker' } },
          { id: 'read', name: 'repository_snapshot_read', arguments: { path: 'source.ts' } },
          { id: 'instructions', name: 'repository_instruction_read', arguments: { path: 'AGENTS.md' } },
        ],
        finishReason: 'tool_use', usage: { inputTokens: 30, outputTokens: 10 },
      },
      {
        content: JSON.stringify({
          schemaVersion: 1,
          status: 'completed',
          summary: 'The marker is declared in source.ts.',
          findings: [{
            findingId: 'marker', statement: 'source.ts declares durable-worker.', uncertainty: 'low',
            sourceReferences: [{
              snapshotId: snapshot.id, snapshotEntryId: entry.canonicalIdentity,
              path: 'source.ts', startLine: 1, endLine: 1, contentHash: entry.contentHash,
            }],
          }],
          unresolvedQuestions: [],
          uncertainty: { level: 'low', reasons: [] },
        }),
        toolCalls: [], finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 20 },
      },
    ];
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call(input) {
        inputs.push(input);
        const output = responses.shift();
        if (!output) throw new Error('unexpected provider call');
        const lifecycle = beginPhysicalProviderAttempt(input, {
          providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: 'chat_completions',
          transport: 'fixture', attemptIndex: inputs.length,
          logicalCallId: input.usageContext?.logicalCallId ?? createLogicalProviderCallId(),
          requestBytes: JSON.stringify(input.messages).length,
        });
        lifecycle.success(output, JSON.stringify(output).length);
        return output;
      },
    };

    const childExecution = await executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-dispatch' },
      execute: (handle) => executeReadOnlyRepositoryWorker({
        engine, handle, assignmentId: admitted.assignment.assignmentId,
        resolveProvider: async () => resolvedProvider(adapter),
      }),
      finalize: (value) => value.finalization,
    });

    expect(childExecution.value.workerResult.acceptanceState).toBe('accepted');
    expect(childExecution.value.workerResult.providerAttemptIds).toHaveLength(2);
    expect(engine.proof.listEvidence(admitted.child.jobId)).toHaveLength(1);
    expect(engine.getChildContract(admitted.child.jobId)).toMatchObject({
      resultAttemptId: admitted.child.attemptId,
      resultGeneration: 1,
      resultStatus: 'completed',
    });
    expect(engine.getJob(parent.jobId)?.terminalAt).toBeNull();
    expect(engine.proof.getVerdict(parent.jobId)).toBeNull();

    const verified = await verifyReadOnlyRepositoryWorkerResult({
      engine,
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation!, fenceToken: parentLease.fenceToken! },
      workerResultId: childExecution.value.workerResult.workerResultId,
      producer: 'parent-verifier', idempotencyKey: 'verify-marker',
    });
    expect(verified.claims).toEqual([expect.objectContaining({ claimId: claim.claimId, state: 'verified' })]);
    expect(verified.evidence).toHaveLength(1);
    expect(verified.evidence[0]).toMatchObject({
      jobId: parent.jobId, attemptId: parent.attemptId,
      repositorySnapshotId: snapshot.id, source: 'repository_readback', verificationResult: 'verified',
    });
    expect(engine.proof.listEvidence(admitted.child.jobId)[0].evidenceId)
      .not.toBe(verified.evidence[0].evidenceId);
    const repeated = await verifyReadOnlyRepositoryWorkerResult({
      engine,
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation!, fenceToken: parentLease.fenceToken! },
      workerResultId: childExecution.value.workerResult.workerResultId,
      producer: 'parent-verifier', idempotencyKey: 'verify-marker',
    });
    expect(repeated.evidence).toHaveLength(1);
    expect(engine.proof.listEvidence(parent.jobId).filter((item) => item.source === 'repository_readback')).toHaveLength(1);
    expect(engine.graph.getCodingPlan(parent.jobId)?.steps[0].references).toContainEqual({
      kind: 'evidence', id: verified.evidence[0].evidenceId,
      snapshotId: null, path: null, lineStart: null, lineEnd: null,
    });
    expect(inputs).toHaveLength(2);
    expect(new Set(ledger.query({ jobId: admitted.child.jobId }).map((record) => `${record.providerActual}/${record.modelActual}`)))
      .toEqual(new Set(['fixture/fixture-tool-model']));
    expect(engine.workerProviderCalls.listForWorkerRun(childExecution.value.workerRun.workerRunId))
      .toMatchObject([
        { callOrdinal: 1, state: 'completed', acceptedProviderAttemptId: expect.any(String) },
        { callOrdinal: 2, state: 'completed', acceptedProviderAttemptId: expect.any(String) },
      ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_provider_tool_links WHERE worker_run_id=?')
      .get(childExecution.value.workerRun.workerRunId)).toEqual({ n: 3 });
    expect(engine.resources.getWorkerReservation(admitted.reservation.reservationId)).toMatchObject({ state: 'released' });
    expect(engine.resources.getBudgets(parent.jobId).find((budget) => budget.kind === 'model_calls')?.used).toBe(2);
    expect(engine.resources.getBudgets(parent.jobId).find((budget) => budget.kind === 'tool_calls')?.used).toBe(3);
    expect(JSON.stringify(inputs[0].messages)).not.toContain(parentLease.fenceToken!);
    expect(JSON.stringify(inputs[0].messages)).not.toContain(process.env.PATH ?? '<unset>');
    expect(inputs[0].tools.map((tool) => tool.name).sort()).toEqual([
      'repository_instruction_read', 'repository_snapshot_read', 'repository_snapshot_search',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM side_effect_ledger WHERE job_id=?').get(admitted.child.jobId)).toEqual({ n: 0 });
    expect(engine.graph.workerReferences(parent.jobId).map((reference) => reference.kind)).toEqual([
      'worker_assignment', 'child_attempt', 'worker_result', 'worker_run',
    ]);
  });

  it('rejects a provider result that cites content outside the assigned snapshot', async () => {
    const { admitted, snapshot } = await setup();
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        return {
          content: JSON.stringify({
            schemaVersion: 1, status: 'completed', summary: 'unsupported',
            findings: [{
              findingId: 'bad', statement: 'outside', uncertainty: 'low',
              sourceReferences: [{
                snapshotId: snapshot.id, snapshotEntryId: 'outside', path: '../outside.txt',
                startLine: 1, endLine: 1, contentHash: 'a'.repeat(64),
              }],
            }],
            unresolvedQuestions: [], uncertainty: { level: 'low', reasons: [] },
          }),
          toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    await expect(executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-dispatch' },
      execute: (handle) => executeReadOnlyRepositoryWorker({
        engine, handle, assignmentId: admitted.assignment.assignmentId,
        resolveProvider: async () => {
          let attemptIndex = 0;
          const accounted: ProviderAdapter = {
            apiMode: adapter.apiMode,
            async call(providerInput) {
              const lifecycle = beginPhysicalProviderAttempt(providerInput, {
                providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: adapter.apiMode,
                transport: 'fixture', attemptIndex: attemptIndex++,
                logicalCallId: providerInput.usageContext?.logicalCallId ?? createLogicalProviderCallId(),
                requestBytes: JSON.stringify(providerInput.messages).length,
              });
              const output = await adapter.call(providerInput);
              lifecycle.success(output, JSON.stringify(output).length);
              return output;
            },
          };
          return resolvedProvider(accounted);
        },
      }),
      finalize: (value) => value.finalization,
    })).rejects.toThrow(/source reference|snapshot/i);
    expect(engine.worker.listWorkerRunsForChild(admitted.child.jobId)[0]?.acceptedResultId).toBeNull();
    expect(engine.worker.listWorkerEvents(engine.getJob(admitted.child.jobId)?.parentJobId ?? '')
      .filter((event) => event.kind === 'worker.result_rejected')).toHaveLength(1);
    expect(engine.proof.listEvidence(admitted.child.jobId)).toHaveLength(0);
  });

  it('persists malformed output as a rejected candidate and never creates Evidence', async () => {
    const { admitted } = await setup();
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        return {
          content: '{"schemaVersion":1,"status":"completed"}',
          toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    await expect(runWorker(admitted, adapter)).rejects.toThrow(/summary|result|schema/i);
    expect(engine.worker.listWorkerEvents(engine.getJob(admitted.child.jobId)?.parentJobId ?? '')
      .filter((event) => event.kind === 'worker.result_rejected')).toHaveLength(1);
    expect(engine.worker.listWorkerRunsForChild(admitted.child.jobId)[0]?.acceptedResultId).toBeNull();
    expect(engine.proof.listEvidence(admitted.child.jobId)).toHaveLength(0);
  });

  it('does not fall back or accept a result when the pinned provider fails', async () => {
    const { admitted } = await setup();
    let calls = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        calls += 1;
        throw new Error('fixture provider unavailable');
      },
    };
    await expect(runWorker(admitted, adapter)).rejects.toThrow(/fixture provider unavailable/i);
    expect(calls).toBe(1);
    expect(engine.worker.listWorkerRunsForChild(admitted.child.jobId)).toHaveLength(1);
    expect(engine.worker.listWorkerRunsForChild(admitted.child.jobId)[0].acceptedResultId).toBeNull();
    expect(engine.worker.rebuildWorkerProjection(engine.getJob(admitted.child.jobId)?.parentJobId ?? '').acceptedResultIds)
      .toHaveLength(0);
  });

  it('blocks a resolved provider identity that differs from the immutable binding', async () => {
    const { admitted } = await setup();
    let calls = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        calls += 1;
        throw new Error('must not send');
      },
    };
    await expect(executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-dispatch' },
      execute: (handle) => executeReadOnlyRepositoryWorker({
        engine, handle, assignmentId: admitted.assignment.assignmentId,
        resolveProvider: async () => ({ ...resolvedProvider(adapter), modelId: 'unapproved-model' }),
      }),
      finalize: (value) => value.finalization,
    })).rejects.toThrow(/immutable provider binding/i);
    expect(calls).toBe(0);
    expect(ledger.query({ jobId: admitted.child.jobId })).toHaveLength(0);
  });

  it('accepts a terminal streamed response before exposing its first buffered event', async () => {
    const { admitted } = await setup();
    const output: ProviderCallOutput = {
      content: 'stream complete', toolCalls: [], finishReason: 'stop',
      usage: { inputTokens: 6, outputTokens: 3 },
    };
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() { throw new Error('plain call must not run'); },
      async *callStream(input) {
        const lifecycle = beginPhysicalProviderAttempt(input, {
          providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: 'chat_completions',
          transport: 'fixture-stream', attemptIndex: 0,
          logicalCallId: input.usageContext?.logicalCallId ?? createLogicalProviderCallId(),
          requestBytes: JSON.stringify(input.messages).length,
        });
        yield { type: 'delta' as const, content: 'stream ' };
        lifecycle.success(output, JSON.stringify(output).length);
        yield { type: 'done' as const, output };
      },
    };
    const bridge = directBridge(admitted, adapter);
    const logicalCallId = 'logical_stream_acceptance';
    const stream = bridge.adapter.callStream!({
      messages: [{ role: 'user', content: 'inspect' }], tools: [], stream: true,
      usageContext: { logicalCallId },
    });
    const first = await stream.next();
    expect(first.value).toEqual({ type: 'delta', content: 'stream ' });
    expect(engine.workerProviderCalls.get(logicalCallId)).toMatchObject({
      state: 'accepted', responseHash: expect.any(String), acceptedProviderAttemptId: expect.any(String),
    });
    expect((await stream.next()).value).toMatchObject({ type: 'done' });
    bridge.completeAcceptedCalls();
    expect(engine.workerProviderCalls.get(logicalCallId)?.state).toBe('completed');
  });

  it('records a partial ambiguous stream as unknown without a second physical attempt', async () => {
    const { admitted } = await setup();
    let calls = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() { throw new Error('plain call must not run'); },
      async *callStream(input) {
        calls += 1;
        const lifecycle = beginPhysicalProviderAttempt(input, {
          providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: 'chat_completions',
          transport: 'fixture-stream', attemptIndex: 0,
          logicalCallId: input.usageContext?.logicalCallId ?? createLogicalProviderCallId(),
          requestBytes: JSON.stringify(input.messages).length,
        });
        yield { type: 'delta' as const, content: 'partial' };
        const error = new Error('stream interrupted after response bytes');
        lifecycle.failure(error, { sent: true, status: 'interrupted' });
        throw error;
      },
    };
    const bridge = directBridge(admitted, adapter);
    const logicalCallId = 'logical_stream_unknown';
    const consume = async () => {
      for await (const _event of bridge.adapter.callStream!({
        messages: [{ role: 'user', content: 'inspect' }], tools: [], stream: true,
        usageContext: { logicalCallId },
      })) { /* buffered until a terminal provider response */ }
    };
    await expect(consume()).rejects.toThrow(/stream interrupted/i);
    expect(calls).toBe(1);
    expect(ledger.query({ parentCallId: logicalCallId })).toHaveLength(1);
    expect(engine.workerProviderCalls.get(logicalCallId)).toMatchObject({ state: 'unknown', outcomeKnown: false });
  });

  it('settles a bridge-level budget denial before transport send', async () => {
    const { admitted } = await setup(1);
    db.prepare(
      'UPDATE job_budget_reservation_items SET committed_value=reserved_value,state=? WHERE reservation_id=? AND kind=?',
    ).run('committed', admitted.reservation.reservationId, 'model_calls');
    let calls = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        calls += 1;
        throw new Error('must not send');
      },
    };
    const bridge = directBridge(admitted, adapter);
    const logicalCallId = 'logical_budget_denied';
    await expect(bridge.adapter.call({
      messages: [{ role: 'user', content: 'inspect' }], tools: [],
      usageContext: { logicalCallId },
    })).rejects.toThrow(/budget exhausted before provider send/i);
    expect(calls).toBe(0);
    expect(ledger.query({ parentCallId: logicalCallId })).toHaveLength(0);
    expect(engine.workerProviderCalls.get(logicalCallId)).toMatchObject({
      state: 'failed', failureKind: 'budget_exhausted', outcomeKnown: true,
    });
  });

  it('accounts a safe pre-response fallback as two physical attempts under one logical call', async () => {
    const { admitted, snapshot, entry } = await setup();
    let logicalCalls = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call(providerInput) {
        logicalCalls += 1;
        const logicalCallId = providerInput.usageContext?.logicalCallId ?? createLogicalProviderCallId();
        if (logicalCalls === 1) {
          const primary = beginPhysicalProviderAttempt(providerInput, {
            providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: 'chat_completions',
            transport: 'fixture', attemptIndex: 0, fallbackIndex: 0, logicalCallId,
            requestBytes: JSON.stringify(providerInput.messages).length,
          });
          primary.failure(new ProviderRateLimitError('fixture'), { sent: true });
          const fallback = beginPhysicalProviderAttempt(providerInput, {
            providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: 'chat_completions',
            transport: 'fixture', attemptIndex: 1, fallbackIndex: 1, logicalCallId,
            requestBytes: JSON.stringify(providerInput.messages).length,
          });
          const output: ProviderCallOutput = {
            content: null,
            toolCalls: [{ id: 'read-fallback', name: 'repository_snapshot_read', arguments: { path: 'source.ts' } }],
            finishReason: 'tool_use', usage: { inputTokens: 12, outputTokens: 4 },
          };
          fallback.success(output, JSON.stringify(output).length);
          return output;
        }
        const finalAttempt = beginPhysicalProviderAttempt(providerInput, {
          providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: 'chat_completions',
          transport: 'fixture', attemptIndex: 0, fallbackIndex: 0, logicalCallId,
          requestBytes: JSON.stringify(providerInput.messages).length,
        });
        const output: ProviderCallOutput = {
          content: JSON.stringify({
            schemaVersion: 1, status: 'completed', summary: 'The marker is present.',
            findings: [{
              findingId: 'marker', statement: 'source.ts declares durable-worker.', uncertainty: 'low',
              sourceReferences: [{
                snapshotId: snapshot.id, snapshotEntryId: entry.canonicalIdentity,
                path: 'source.ts', startLine: 1, endLine: 1, contentHash: entry.contentHash,
              }],
            }],
            unresolvedQuestions: [], uncertainty: { level: 'low', reasons: [] },
          }),
          toolCalls: [], finishReason: 'stop', usage: { inputTokens: 14, outputTokens: 6 },
        };
        finalAttempt.success(output, JSON.stringify(output).length);
        return output;
      },
    };
    const result = await executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-dispatch' },
      execute: (handle) => executeReadOnlyRepositoryWorker({
        engine, handle, assignmentId: admitted.assignment.assignmentId,
        resolveProvider: async () => resolvedProvider(adapter),
      }),
      finalize: (value) => value.finalization,
    });
    const attempts = ledger.query({ jobId: admitted.child.jobId });
    expect(attempts.map((item) => [item.purpose, item.status])).toEqual([
      ['primary', 'provider_error'], ['fallback', 'success'], ['primary', 'success'],
    ]);
    expect(engine.workerProviderCalls.listForWorkerRun(result.value.workerRun.workerRunId)).toHaveLength(2);
    expect(engine.resources.getBudgets(result.value.workerRun.childJobId).find((item) => item.kind === 'model_calls')?.used).toBe(3);
    expect(engine.resources.getBudgets(result.value.workerRun.childJobId).find((item) => item.kind === 'retries')?.used).toBe(1);
  });

  it('blocks the next logical call before send when the physical model-call reservation is exhausted', async () => {
    const { admitted } = await setup(1);
    let calls = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call(providerInput) {
        calls += 1;
        const lifecycle = beginPhysicalProviderAttempt(providerInput, {
          providerActual: 'fixture', modelActual: 'fixture-tool-model', apiMode: 'chat_completions',
          transport: 'fixture', attemptIndex: 0,
          logicalCallId: providerInput.usageContext?.logicalCallId ?? createLogicalProviderCallId(),
          requestBytes: JSON.stringify(providerInput.messages).length,
        });
        const output: ProviderCallOutput = {
          content: null,
          toolCalls: [{ id: 'read-once', name: 'repository_snapshot_read', arguments: { path: 'source.ts' } }],
          finishReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 4 },
        };
        lifecycle.success(output, JSON.stringify(output).length);
        return output;
      },
    };
    await expect(executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-dispatch' },
      execute: (handle) => executeReadOnlyRepositoryWorker({
        engine, handle, assignmentId: admitted.assignment.assignmentId,
        resolveProvider: async () => resolvedProvider(adapter),
      }),
      finalize: (value) => value.finalization,
    })).rejects.toThrow(/model-call budget exhausted/i);
    expect(calls).toBe(1);
    expect(ledger.query({ jobId: admitted.child.jobId })).toHaveLength(1);
    expect(engine.workerProviderCalls.listForWorkerRun(admitted.reservation.workerRunId))
      .toMatchObject([{ callOrdinal: 1, state: 'completed' }]);
    expect(engine.resources.getWorkerReservation(admitted.reservation.reservationId)?.state).toBe('released');
  });

  it('prevents cancelled parent authority from creating parent Evidence or changing its Claim', async () => {
    const { parent, parentLease, snapshot, entry, claim, admitted } = await setup();
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        return {
          content: JSON.stringify({
            schemaVersion: 1, status: 'completed', summary: 'The marker is present.',
            findings: [{
              findingId: 'marker', statement: 'source.ts declares durable-worker.', uncertainty: 'low',
              sourceReferences: [{
                snapshotId: snapshot.id, snapshotEntryId: entry.canonicalIdentity,
                path: 'source.ts', startLine: 1, endLine: 1, contentHash: entry.contentHash,
              }],
            }],
            unresolvedQuestions: [], uncertainty: { level: 'low', reasons: [] },
          }),
          toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const child = await runWorker(admitted, adapter);
    expect(child.value.workerResult.acceptanceState).toBe('accepted');
    engine.cancelJob({
      jobId: parent.jobId, reason: 'parent cancelled', producer: 'test', eventIdempotencyKey: 'cancel-parent',
    });
    await expect(verifyReadOnlyRepositoryWorkerResult({
      engine,
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation!, fenceToken: parentLease.fenceToken! },
      workerResultId: child.value.workerResult.workerResultId,
      producer: 'parent-verifier', idempotencyKey: 'cancelled-parent-verification',
    })).rejects.toThrow(/authority/i);
    expect(engine.proof.listEvidence(parent.jobId)).toHaveLength(0);
    expect(engine.proof.listClaims(parent.jobId)).toContainEqual(expect.objectContaining({
      claimId: claim.claimId, state: 'unverified',
    }));
    expect(engine.worker.getWorkerResult(child.value.workerResult.workerResultId)).toMatchObject({
      acceptanceState: 'accepted',
    });
  });

  it('preserves the accepted candidate and records failed parent Verification when readback becomes stale', async () => {
    const { parent, parentLease, snapshot, entry, claim, admitted } = await setup();
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        return {
          content: JSON.stringify({
            schemaVersion: 1, status: 'completed', summary: 'The marker is present.',
            findings: [{
              findingId: 'marker', statement: 'source.ts declares durable-worker.', uncertainty: 'low',
              sourceReferences: [{
                snapshotId: snapshot.id, snapshotEntryId: entry.canonicalIdentity,
                path: 'source.ts', startLine: 1, endLine: 1, contentHash: entry.contentHash,
              }],
            }],
            unresolvedQuestions: [], uncertainty: { level: 'low', reasons: [] },
          }),
          toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const child = await runWorker(admitted, adapter);
    await writeFile(path.join(root, 'source.ts'), 'changed after Worker completion\n');
    await expect(verifyReadOnlyRepositoryWorkerResult({
      engine,
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation!, fenceToken: parentLease.fenceToken! },
      workerResultId: child.value.workerResult.workerResultId,
      producer: 'parent-verifier', idempotencyKey: 'stale-parent-readback',
    })).rejects.toThrow(/stale|incomplete/i);
    expect(engine.worker.getWorkerResult(child.value.workerResult.workerResultId)).toMatchObject({
      acceptanceState: 'accepted',
    });
    expect(engine.proof.listEvidence(parent.jobId)).toContainEqual(expect.objectContaining({
      source: 'repository_readback', verificationResult: 'failed', coverage: 'unknown',
    }));
    expect(engine.proof.listClaims(parent.jobId)).toContainEqual(expect.objectContaining({
      claimId: claim.claimId, state: 'failed',
    }));
    expect(engine.proof.getVerdict(parent.jobId)).toBeNull();
  });
});
