/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { executeDurableJob, type DurableJobHandle } from '../../../core/v4/daemon/jobLifecycle';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry, type ToolHandler, type ToolCallResult } from '../../../core/v4/toolRegistry';
import { attachRawValidationOutput } from '../../../core/v4/codebase/validationOutput';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { __resetFileReadCache, fileReadTool } from '../../../tools/v4/files/fileRead';
import { fileWriteTool } from '../../../tools/v4/files/fileWrite';
import { shellExecTool } from '../../../tools/v4/terminal/shellExec';

describe('Codebase Mode production lifecycle acceptance', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let root: string;
  let ordinal: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('codebase-acceptance',1,'localhost',1,1,'4.17.0')`,
    ).run();
    engine = createJobEngine({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-codebase-acceptance-'));
    __resetFileReadCache();
    ordinal = 0;
  });

  function buildExecutor(
    handlers: ToolHandler[],
    promptUser: () => Promise<'allow' | 'deny'> = async () => 'allow',
  ) {
    const registry = new ToolRegistry();
    for (const handler of handlers) {
      registry.register(handler.schema.name === 'delegated_mutation'
        ? handler
        : withBuiltInEffectContract(handler));
    }
    return registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
      approvalEngine: new ApprovalEngine('manual', { promptUser }),
      actionAuthority: createActionAuthority({ db, jobEngine: engine }),
      policySnapshot: {
        trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'manual',
        toolMetadataVersion: 'codebase-v1', sandboxPolicy: { roots: [root], deny: [] },
        networkPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
      },
    });
  }

  async function runJob<T>(input: {
    execute: (handle: DurableJobHandle) => Promise<T>;
    finalStatus?: 'completed' | 'failed';
    outcome?: string;
    capabilities?: { tools?: string[]; paths?: string[]; effectKinds?: string[] };
  }) {
    ordinal += 1;
    return executeDurableJob({
      engine,
      ownerId: 'codebase-acceptance',
      admission: {
        entryPoint: 'interactive', source: 'test', sessionId: `codebase-acceptance-${ordinal}`,
        workspaceId: root, instanceId: 'codebase-acceptance',
        idempotencyNamespace: 'codebase-acceptance', idempotencyKey: `${path.basename(root)}-${ordinal}`,
        goal: 'complete a source-bound repository task',
        ...(input.capabilities ? { resourcePolicy: { capabilities: input.capabilities } } : {}),
      },
      execute: input.execute,
      finalize: () => ({
        status: input.finalStatus ?? 'completed',
        outcome: input.outcome ?? (input.finalStatus === 'failed' ? 'failed' : 'verified'),
        finishReason: input.finalStatus === 'failed' ? 'blocked' : 'stop',
        evidence: { accepted: true },
      }),
    });
  }

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('automatically binds repository inspection and safe changes to a durable workspace', async () => {
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    const execute = buildExecutor([fileReadTool, fileWriteTool]);

    const result = await runJob({
      execute: async () => ({
        read: await execute({ id: 'read-source', name: 'file_read', arguments: { path: 'source.ts' } }),
        write: await execute({
          id: 'write-source', name: 'file_write',
          arguments: { path: 'source.ts', content: 'export const value = 2;\n' },
        }),
      }),
    });

    expect(result.value.read.error).toBeUndefined();
    expect(result.value.read.result).toMatchObject({
      success: true,
      snapshotId: expect.stringMatching(/^repository_snapshot_/),
      content: 'export const value = 1;\n',
    });
    expect(result.value.write.error).toBeUndefined();
    expect(result.value.write.result).toMatchObject({
      success: true,
      changeId: expect.stringMatching(/^change_/),
      verified: true,
      descendantSnapshotId: expect.stringMatching(/^repository_snapshot_/),
    });
    await expect(readFile(path.join(root, 'source.ts'), 'utf8'))
      .resolves.toBe('export const value = 2;\n');
    expect(engine.changes.listRecords(result.jobId)).toHaveLength(1);
    expect(engine.proof.listEvidence(result.jobId)).toEqual([
      expect.objectContaining({ source: 'repository.change.readback', verificationResult: 'verified' }),
    ]);
    expect(engine.proof.getVerdict(result.jobId)?.verdict).toBe('verified');
    expect(engine.proof.exportJson(result.jobId)).toMatchObject({
      job: { id: result.jobId },
      verdict: { verdict: 'verified' },
    });
  });

  it('keeps an external file change on the ordinary approval path', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aiden-codebase-external-'));
    const target = path.join(outside, 'denied.txt');
    let prompts = 0;
    try {
      const execute = buildExecutor([fileWriteTool], async () => {
        prompts += 1;
        return 'deny';
      });
      const result = await runJob({
        execute: async () => execute({
          id: 'external-write', name: 'file_write',
          arguments: { path: target, content: 'must not be written' },
        }),
        finalStatus: 'failed',
      });

      expect(prompts).toBe(1);
      expect(result.value.error).toMatch(/denied/i);
      expect(engine.changes.listRecords(result.jobId)).toHaveLength(0);
      await expect(readFile(target, 'utf8')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('completes a durable inspect-change-validate plan with source-bound Proof', async () => {
    await writeFile(path.join(root, 'calculator.ts'), 'export const add = (a: number, b: number) => a - b;\n');
    await writeFile(path.join(root, 'calculator.test.ts'), 'expect(add(2, 1)).toBe(3);\n');
    const validationShell: ToolHandler = {
      ...shellExecTool,
      execute: async () => attachRawValidationOutput({
        success: true, exitCode: 0, stdout: 'Tests  1 passed (1)\n', stderr: '', timedOut: false,
      }, { stdout: 'Tests  1 passed (1)\n', stderr: '' }),
    };
    const execute = buildExecutor([fileReadTool, fileWriteTool, validationShell]);

    const result = await runJob({
      execute: async (handle) => {
        const authority = {
          jobId: handle.jobId, attemptId: handle.attemptId, generation: handle.generation,
          fenceToken: handle.fenceToken, producer: 'test',
        };
        const read = await execute({ id: 'bug-read', name: 'file_read', arguments: { path: 'calculator.ts' } });
        const sourceSnapshotId = String((read.result as Record<string, unknown>).snapshotId);
        const understanding = await engine.understanding.indexSnapshot({
          ...authority, repositorySnapshotId: sourceSnapshotId,
        });
        const located = await engine.understanding.search(sourceSnapshotId, 'a - b');
        engine.graph.createCodingPlan({
          jobId: handle.jobId, planDigest: 'calculator-repair-v1', producer: 'test', idempotencyKey: 'plan',
          steps: [
            {
              stepId: 'inspect', label: 'Locate defect', repositorySnapshotId: sourceSnapshotId,
              references: [{ kind: 'inspected_file', snapshotId: sourceSnapshotId, path: 'calculator.ts' }],
            },
            { stepId: 'change', label: 'Repair implementation', repositorySnapshotId: sourceSnapshotId, dependsOn: ['inspect'] },
            {
              stepId: 'validate', label: 'Run regression', repositorySnapshotId: sourceSnapshotId,
              dependsOn: ['change'], requiresVerification: true,
            },
          ],
        });
        engine.graph.schedule({ ...authority, idempotencyKey: 'schedule-inspect' });
        engine.graph.claim({ ...authority, nodeId: 'inspect', idempotencyKey: 'claim-inspect' });
        engine.graph.complete({
          ...authority, nodeId: 'inspect', state: 'succeeded', outputRef: `search:${sourceSnapshotId}`,
          idempotencyKey: 'complete-inspect',
        });

        engine.graph.schedule({ ...authority, idempotencyKey: 'schedule-change' });
        engine.graph.claim({ ...authority, nodeId: 'change', idempotencyKey: 'claim-change' });
        const changed = await execute({
          id: 'bug-write', name: 'file_write',
          arguments: { path: 'calculator.ts', content: 'export const add = (a: number, b: number) => a + b;\n' },
        });
        const change = engine.changes.listRecords(handle.jobId)[0]!;
        engine.graph.addNodeReferences({
          ...authority, nodeId: 'change', idempotencyKey: 'reference-change',
          references: [{ kind: 'change_record', id: change.changeId, snapshotId: change.descendantSnapshotId }],
        });
        engine.graph.complete({
          ...authority, nodeId: 'change', state: 'succeeded', outputRef: `change:${change.changeId}`,
          idempotencyKey: 'complete-change',
        });

        engine.graph.schedule({ ...authority, idempotencyKey: 'schedule-validation' });
        engine.graph.claim({ ...authority, nodeId: 'validate', idempotencyKey: 'claim-validation' });
        const validation = await execute({
          id: 'bug-test', name: 'shell_exec',
          arguments: { command: 'npm test -- --run calculator.test.ts', cwd: root },
        });
        const testRun = (db.prepare('SELECT run_id FROM validation_runs WHERE job_id = ?').get(handle.jobId) as { run_id: string }).run_id;
        const run = engine.validation.getRun(testRun)!;
        engine.graph.addNodeReferences({
          ...authority, nodeId: 'validate', idempotencyKey: 'reference-validation',
          references: [{ kind: 'test_run', id: testRun, snapshotId: run.repositorySnapshotId }],
        });
        engine.graph.complete({
          ...authority, nodeId: 'validate', state: 'succeeded', outputRef: `test:${testRun}`,
          verificationRef: run.rawLogEvidenceId, idempotencyKey: 'complete-validation',
        });
        return { read, changed, validation, understanding, located, testRun };
      },
    });

    expect(result.value.located.lexicalMatches).toEqual([
      expect.objectContaining({ path: 'calculator.ts', line: 1 }),
    ]);
    expect(result.value.understanding.stale).toBe(false);
    expect(result.value.changed.result).toMatchObject({ verified: true });
    expect(result.value.validation.error).toBeUndefined();
    expect(engine.validation.getRun(result.value.testRun)).toMatchObject({
      state: 'succeeded', passedCount: 1, sourceMutations: [],
    });
    expect(engine.graph.getCodingPlan(result.jobId)).toMatchObject({
      state: 'completed', remainingStepIds: [],
      steps: [
        expect.objectContaining({ stepId: 'inspect', state: 'completed' }),
        expect.objectContaining({ stepId: 'change', state: 'completed' }),
        expect.objectContaining({ stepId: 'validate', state: 'completed' }),
      ],
    });
    expect(engine.proof.getVerdict(result.jobId)?.verdict).toBe('verified');
    expect(engine.proof.exportMarkdown(result.jobId)).toContain('Verdict: verified');
  });

  it('updates connected files while preserving unrelated dirty work and restart identity', async () => {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'service.ts'), 'export const service = 1;\n');
    await writeFile(path.join(root, 'src', 'service.test.ts'), 'expect(service).toBe(1);\n');
    await writeFile(path.join(root, 'user-notes.txt'), 'private draft\n');
    const execute = buildExecutor([fileReadTool, fileWriteTool]);

    const result = await runJob({
      execute: async (handle) => {
        const inspected = await execute({ id: 'read-service', name: 'file_read', arguments: { path: 'src/service.ts' } });
        const implementation = await execute({
          id: 'write-service', name: 'file_write',
          arguments: { path: 'src/service.ts', content: 'export const service = 2;\n' },
        });
        const regression = await execute({
          id: 'write-test', name: 'file_write',
          arguments: { path: 'src/service.test.ts', content: 'expect(service).toBe(2);\n' },
        });
        const duplicate = await execute({
          id: 'write-test', name: 'file_write',
          arguments: { path: 'src/service.test.ts', content: 'expect(service).toBe(2);\n' },
        });
        const reopened = createJobEngine({ db });
        return {
          inspected, implementation, regression, duplicate,
          restoredChanges: reopened.changes.listRecords(handle.jobId),
        };
      },
    });

    expect(result.value.inspected.result).toMatchObject({ snapshotId: expect.any(String) });
    expect(result.value.implementation.result).toMatchObject({ verified: true, changeId: expect.any(String) });
    expect(result.value.regression.result).toMatchObject({ verified: true, changeId: expect.any(String) });
    expect(result.value.duplicate).toMatchObject({
      id: result.value.regression.id,
      name: result.value.regression.name,
      result: result.value.regression.result,
    });
    expect(result.value.restoredChanges).toHaveLength(2);
    await expect(readFile(path.join(root, 'user-notes.txt'), 'utf8')).resolves.toBe('private draft\n');
    expect(engine.proof.getVerdict(result.jobId)?.verdict).toBe('verified');
  });

  it('blocks a stale write after a user edit and leaves the Job recoverably unknown', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const execute = buildExecutor([fileReadTool, fileWriteTool], async () => {
      await writeFile(path.join(root, 'source.ts'), 'user edit\n');
      return 'allow';
    });

    const result = await runJob({
      execute: async () => {
        const inspected = await execute({ id: 'read-stale', name: 'file_read', arguments: { path: 'source.ts' } });
        const blocked = await execute({
          id: 'write-stale', name: 'file_write', arguments: { path: 'source.ts', content: 'planned\n' },
        });
        return { inspected, blocked };
      },
    });

    expect(result.value.inspected.error).toBeUndefined();
    expect(result.value.blocked.error).toContain('Source metadata or content changed after approval');
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('user edit\n');
    expect(engine.getJob(result.jobId)).toMatchObject({
      status: 'unknown', terminalOutcome: 'unknown', finishReason: 'verification_incomplete',
    });
    expect(engine.proof.getVerdict(result.jobId)?.verdict).toBe('unknown');
  });

  it('records terminal-created mutations and refuses to reuse their validation as current proof', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'test source\n');
    const mutatingShell: ToolHandler = {
      ...shellExecTool,
      execute: async () => {
        await writeFile(path.join(root, 'terminal-output.txt'), 'created by validation\n');
        return attachRawValidationOutput({
          success: true, exitCode: 0, stdout: 'Tests  1 passed (1)\n', stderr: '', timedOut: false,
        }, { stdout: 'Tests  1 passed (1)\n', stderr: '' });
      },
    };
    const execute = buildExecutor([mutatingShell]);

    const result = await runJob({
      execute: async () => execute({
        id: 'focused-validation', name: 'shell_exec',
        arguments: { command: 'npm test -- --run source.test.ts', cwd: root },
      }),
    });
    const runId = (db.prepare('SELECT run_id FROM validation_runs WHERE job_id = ?').get(result.jobId) as { run_id: string }).run_id;
    const run = engine.validation.getRun(runId)!;
    expect(run).toMatchObject({
      state: 'succeeded', passedCount: 1,
      sourceMutations: expect.arrayContaining(['terminal-output.txt']),
      resultingSnapshotId: expect.stringMatching(/^repository_snapshot_/),
    });
    await expect(engine.validation.assess(runId, { repositorySnapshotId: run.repositorySnapshotId }))
      .resolves.toMatchObject({ usable: false, reasons: expect.arrayContaining(['source_mutated']) });
  });

  it('enforces inspect-only capability boundaries for direct, shell, and delegated mutations', async () => {
    await writeFile(path.join(root, 'source.ts'), 'unchanged\n');
    let delegatedExecutionCount = 0;
    const delegatedMutation: ToolHandler = {
      schema: { name: 'delegated_mutation', description: 'delegated mutation', inputSchema: { type: 'object' } },
      category: 'write', mutates: true, riskTier: 'caution', toolset: 'misc',
      execute: async () => { delegatedExecutionCount += 1; return { success: true }; },
    };
    const execute = buildExecutor([fileReadTool, fileWriteTool, shellExecTool, delegatedMutation]);

    const result = await runJob({
      capabilities: { tools: ['file_read'], paths: [root], effectKinds: [] },
      execute: async () => ({
        read: await execute({ id: 'inspect-read', name: 'file_read', arguments: { path: 'source.ts' } }),
        write: await execute({
          id: 'inspect-write', name: 'file_write', arguments: { path: 'source.ts', content: 'changed\n' },
        }),
        shell: await execute({
          id: 'inspect-shell', name: 'shell_exec', arguments: { command: 'echo changed > source.ts', cwd: root },
        }),
        delegated: await execute({ id: 'inspect-delegated', name: 'delegated_mutation', arguments: {} }),
      }),
    });

    expect(result.value.read.error).toBeUndefined();
    for (const blocked of [result.value.write, result.value.shell, result.value.delegated] as ToolCallResult[]) {
      expect(blocked.error).toBe('Tool is outside this Job capability boundary');
    }
    expect(delegatedExecutionCount).toBe(0);
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('unchanged\n');
  });
});
