/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { executeDurableJob } from '../../../core/v4/daemon/jobLifecycle';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { resolveAidenPaths } from '../../../core/v4/paths';
import {
  READ_ONLY_REPOSITORY_WORKER_TOOLS,
  admitReadOnlyRepositoryWorker,
  createReadOnlyRepositoryWorkerToolRegistry,
} from '../../../core/v4/worker/readOnlyRepositoryWorker';

describe('read-only repository Worker tools', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let root: string;
  let home: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      'INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)',
    ).run('worker-instance', 1, 'localhost', Date.now(), Date.now(), '4.18.0');
    engine = createJobEngine({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-worker-tools-'));
    home = await mkdtemp(path.join(os.tmpdir(), 'aiden-worker-home-'));
    await writeFile(path.join(root, 'AGENTS.md'), 'Read the source before reporting.\n');
    await writeFile(path.join(root, 'source.ts'), 'export const marker = "needle";\n');
    await mkdir(path.join(root, 'nested directory'), { recursive: true });
    await writeFile(path.join(root, 'nested directory', 'child.ts'), 'export const child = "needle";\n');
  });

  afterEach(async () => {
    db.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  });

  async function assignment() {
    const parent = engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'session', workspaceId: root,
      instanceId: 'worker-instance', idempotencyNamespace: 'parent', idempotencyKey: 'one', goal: 'inspect',
    });
    const parentLease = engine.claimAttempt({ attemptId: parent.attemptId, ownerId: 'worker-instance', ttlMs: 60_000 });
    if (!parentLease.acquired || !parentLease.fenceToken || parentLease.generation === undefined) throw new Error('lease');
    const snapshot = await engine.repository.captureSnapshot({
      jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation,
      fenceToken: parentLease.fenceToken, requestedPath: root, producer: 'test',
    });
    const admitted = admitReadOnlyRepositoryWorker({
      engine, triggerBus: createTriggerBus({ db }),
      parent: { jobId: parent.jobId, attemptId: parent.attemptId, generation: parentLease.generation, fenceToken: parentLease.fenceToken },
      idempotencyKey: 'one', goal: 'Inspect the marker.', repositorySnapshotId: snapshot.id,
      provider: {
        providerId: 'test', modelId: 'tool-model', providerRuntimeIdentity: 'runtime:test',
        credentialReference: null, endpointReference: null, supportsToolCalling: true,
        contextWindow: 8_192, maxOutputTokens: 1_024, selectionReason: 'test binding',
      },
    });
    return { admitted, parent, parentLease, snapshot };
  }

  it('exposes only three snapshot-bound tools through durable ToolCall execution', async () => {
    const { admitted, parent, parentLease } = await assignment();
    const values = await executeDurableJob({
      engine,
      ownerId: 'worker-instance',
      leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-test' },
      execute: async (handle) => {
        const workerRunId = `worker_run_${admitted.assignment.assignmentId.slice('worker_assignment_'.length)}`;
        engine.worker.bindWorkerRun({
          parentJobId: parent.jobId, parentAttemptId: parent.attemptId,
          parentGeneration: parentLease.generation!, parentFenceToken: parentLease.fenceToken!,
          childJobId: handle.jobId, childAttemptId: handle.attemptId,
          childGeneration: handle.generation, childFenceToken: handle.fenceToken,
          workerRunId, schemaVersion: 1, assignmentId: admitted.assignment.assignmentId,
          providerBindingId: admitted.providerBinding.providerBindingId,
          contextEnvelopeId: admitted.contextEnvelope.contextEnvelopeId,
          producer: 'test', idempotencyKey: 'run',
        });
        const registry = createReadOnlyRepositoryWorkerToolRegistry({
          engine, assignmentId: admitted.assignment.assignmentId, workerRunId,
        });
        const executor = registry.buildExecutor({
          cwd: root, paths: resolveAidenPaths({ rootOverride: home }), sessionId: 'worker-session',
        });
        const search = await executor({ id: 'search-one', name: 'repository_snapshot_search', arguments: { query: 'needle' } }, handle.signal);
        const read = await executor({ id: 'read-one', name: 'repository_snapshot_read', arguments: { path: 'source.ts' } }, handle.signal);
        const instruction = await executor({ id: 'instruction-one', name: 'repository_instruction_read', arguments: { path: 'AGENTS.md' } }, handle.signal);
        const shell = await executor({ id: 'shell-one', name: 'shell_exec', arguments: { command: 'echo forbidden' } }, handle.signal);
        return { names: registry.list(), search, read, instruction, shell };
      },
      finalize: () => ({ status: 'completed', outcome: 'inspected', finishReason: 'stop', evidence: { readOnly: true } }),
    });

    expect(values.value.names).toEqual([...READ_ONLY_REPOSITORY_WORKER_TOOLS]);
    expect(values.value.search.error).toBeUndefined();
    expect(values.value.search.result).toMatchObject({ snapshotId: admitted.assignment.repositorySnapshotId, stale: false });
    expect(values.value.read.result).toMatchObject({ path: 'source.ts', stale: false });
    expect(values.value.instruction.result).toMatchObject({ path: 'AGENTS.md', stale: false });
    expect(values.value.shell.error).toMatch(/not registered/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE job_id=?').get(admitted.child.jobId)).toEqual({ n: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM side_effect_ledger WHERE job_id=?').get(admitted.child.jobId)).toEqual({ n: 0 });
  });

  it('rejects path escape and refuses stale snapshot content', async () => {
    const { admitted, parent, parentLease } = await assignment();
    await executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-test' },
      execute: async (handle) => {
        const workerRunId = `worker_run_${admitted.assignment.assignmentId.slice('worker_assignment_'.length)}`;
        engine.worker.bindWorkerRun({
          parentJobId: parent.jobId, parentAttemptId: parent.attemptId,
          parentGeneration: parentLease.generation!, parentFenceToken: parentLease.fenceToken!,
          childJobId: handle.jobId, childAttemptId: handle.attemptId,
          childGeneration: handle.generation, childFenceToken: handle.fenceToken,
          workerRunId, schemaVersion: 1, assignmentId: admitted.assignment.assignmentId,
          providerBindingId: admitted.providerBinding.providerBindingId,
          contextEnvelopeId: admitted.contextEnvelope.contextEnvelopeId,
          producer: 'test', idempotencyKey: 'run',
        });
        const executor = createReadOnlyRepositoryWorkerToolRegistry({ engine, assignmentId: admitted.assignment.assignmentId, workerRunId })
          .buildExecutor({ cwd: root, paths: resolveAidenPaths({ rootOverride: home }) });
        const escaped = await executor({ id: 'escape', name: 'repository_snapshot_read', arguments: { path: '../outside.txt' } });
        await writeFile(path.join(root, 'source.ts'), 'changed after snapshot\n');
        const stale = await executor({ id: 'stale', name: 'repository_snapshot_read', arguments: { path: 'source.ts' } });
        expect(escaped.error).toMatch(/snapshot|path/i);
        expect(stale.error).toMatch(/stale/i);
        return null;
      },
      finalize: () => ({ status: 'completed', outcome: 'checked', finishReason: 'stop', evidence: {} }),
    });
  });

  it('uses canonical snapshot-relative paths instead of the caller working directory', async () => {
    const { admitted, parent, parentLease } = await assignment();
    const values = await executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-test' },
      execute: async (handle) => {
        const workerRunId = `worker_run_${admitted.assignment.assignmentId.slice('worker_assignment_'.length)}`;
        engine.worker.bindWorkerRun({
          parentJobId: parent.jobId, parentAttemptId: parent.attemptId,
          parentGeneration: parentLease.generation!, parentFenceToken: parentLease.fenceToken!,
          childJobId: handle.jobId, childAttemptId: handle.attemptId,
          childGeneration: handle.generation, childFenceToken: handle.fenceToken,
          workerRunId, schemaVersion: 1, assignmentId: admitted.assignment.assignmentId,
          providerBindingId: admitted.providerBinding.providerBindingId,
          contextEnvelopeId: admitted.contextEnvelope.contextEnvelopeId,
          producer: 'test', idempotencyKey: 'canonical-path-run',
        });
        const executor = createReadOnlyRepositoryWorkerToolRegistry({ engine, assignmentId: admitted.assignment.assignmentId, workerRunId })
          .buildExecutor({ cwd: path.dirname(root), paths: resolveAidenPaths({ rootOverride: home }) });
        return {
          windowsSeparators: await executor({ id: 'windows-separators', name: 'repository_snapshot_read', arguments: { path: 'nested directory\\child.ts' } }),
          posixSeparators: await executor({ id: 'posix-separators', name: 'repository_snapshot_read', arguments: { path: 'nested directory/child.ts' } }),
          escaped: await executor({ id: 'escaped', name: 'repository_snapshot_read', arguments: { path: '../outside.ts' } }),
          absoluteWindows: await executor({ id: 'absolute-windows', name: 'repository_snapshot_read', arguments: { path: 'C:\\outside.ts' } }),
          absolutePosix: await executor({ id: 'absolute-posix', name: 'repository_snapshot_read', arguments: { path: '/outside.ts' } }),
          unc: await executor({ id: 'unc', name: 'repository_snapshot_read', arguments: { path: '\\\\server\\share\\outside.ts' } }),
        };
      },
      finalize: () => ({ status: 'completed', outcome: 'checked', finishReason: 'stop', evidence: {} }),
    });
    expect(values.value.windowsSeparators.result).toMatchObject({ path: 'nested directory/child.ts', stale: false });
    expect(values.value.posixSeparators.result).toMatchObject({ path: 'nested directory/child.ts', stale: false });
    for (const outcome of [values.value.escaped, values.value.absoluteWindows, values.value.absolutePosix, values.value.unc]) {
      expect(outcome.error).toMatch(/snapshot|path/i);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE job_id=?').get(admitted.child.jobId)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM side_effect_ledger WHERE job_id=?').get(admitted.child.jobId)).toEqual({ n: 0 });
  });

  it('keeps every generic or mutating capability outside the Worker registry', async () => {
    const { admitted, parent, parentLease } = await assignment();
    await executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-test' },
      execute: async (handle) => {
        const workerRunId = `worker_run_${admitted.assignment.assignmentId.slice('worker_assignment_'.length)}`;
        engine.worker.bindWorkerRun({
          parentJobId: parent.jobId, parentAttemptId: parent.attemptId,
          parentGeneration: parentLease.generation!, parentFenceToken: parentLease.fenceToken!,
          childJobId: handle.jobId, childAttemptId: handle.attemptId,
          childGeneration: handle.generation, childFenceToken: handle.fenceToken,
          workerRunId, schemaVersion: 1, assignmentId: admitted.assignment.assignmentId,
          providerBindingId: admitted.providerBinding.providerBindingId,
          contextEnvelopeId: admitted.contextEnvelope.contextEnvelopeId,
          producer: 'test', idempotencyKey: 'restricted-run',
        });
        const registry = createReadOnlyRepositoryWorkerToolRegistry({
          engine, assignmentId: admitted.assignment.assignmentId, workerRunId,
        });
        const executor = registry.buildExecutor({ cwd: root, paths: resolveAidenPaths({ rootOverride: home }) });
        for (const tool of [
          'file_read', 'file_write', 'file_patch', 'shell_exec', 'git_status', 'browser_open',
          'web_search', 'mcp_call', 'plugin_execute', 'send_message', 'clarify', 'memory_search',
          'skill_run', 'spawn_sub_agent',
        ]) {
          const outcome = await executor({ id: `forbidden-${tool}`, name: tool, arguments: {} });
          expect(outcome.error, tool).toMatch(/not registered/i);
        }
        return null;
      },
      finalize: () => ({ status: 'completed', outcome: 'checked', finishReason: 'stop', evidence: {} }),
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE job_id=?').get(admitted.child.jobId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM side_effect_ledger WHERE job_id=?').get(admitted.child.jobId)).toEqual({ n: 0 });
  });

  it('denies every Worker tool when the immutable capability set is missing', async () => {
    const { admitted, parent, parentLease } = await assignment();
    db.prepare('UPDATE worker_assignments SET capability_set_id=NULL WHERE assignment_id=?')
      .run(admitted.assignment.assignmentId);
    await expect(executeDurableJob({
      engine, ownerId: 'worker-instance', leaseTtlMs: 60_000,
      admission: { existing: { ...admitted.child, reused: true }, source: 'worker-test' },
      execute: async (handle) => {
        const workerRunId = `worker_run_${admitted.assignment.assignmentId.slice('worker_assignment_'.length)}`;
        engine.worker.bindWorkerRun({
          parentJobId: parent.jobId, parentAttemptId: parent.attemptId,
          parentGeneration: parentLease.generation!, parentFenceToken: parentLease.fenceToken!,
          childJobId: handle.jobId, childAttemptId: handle.attemptId,
          childGeneration: handle.generation, childFenceToken: handle.fenceToken,
          workerRunId, schemaVersion: 1, assignmentId: admitted.assignment.assignmentId,
          providerBindingId: admitted.providerBinding.providerBindingId,
          contextEnvelopeId: admitted.contextEnvelope.contextEnvelopeId,
          producer: 'test', idempotencyKey: 'missing-capabilities',
        });
        return createReadOnlyRepositoryWorkerToolRegistry({
          engine, assignmentId: admitted.assignment.assignmentId, workerRunId,
        });
      },
      finalize: () => ({ status: 'completed', outcome: 'unexpected', finishReason: 'stop', evidence: {} }),
    })).rejects.toThrow(/capability/i);
  });
});
