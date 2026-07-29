/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachRawValidationOutput } from '../../../core/v4/codebase/validationOutput';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { shellExecTool } from '../../../tools/v4/terminal/shellExec';

describe('structured validation shell integration', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let root: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('validation-integration',1,'localhost',1,1,'4.17.0')`,
    ).run();
    engine = createJobEngine({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-validation-tool-'));
    await writeFile(path.join(root, 'source.test.ts'), 'test source\n');
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('records one shell execution without changing its provider-facing result', async () => {
    const admission = engine.submitJob({
      entryPoint: 'test', source: 'unit', sessionId: 'validation-tool', workspaceId: root,
      instanceId: 'validation-integration', idempotencyNamespace: 'validation-tool',
      idempotencyKey: path.basename(root), goal: 'run validation',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 60_000 });
    engine.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
      fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'attempt-running', producer: 'test',
    });
    engine.transitionJob({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation!,
      fenceToken: lease.fenceToken!, expectedStateVersion: 0, to: 'running',
      eventIdempotencyKey: 'job-running', producer: 'test',
    });
    const snapshot = await engine.repository.captureSnapshot({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation!,
      fenceToken: lease.fenceToken!, requestedPath: root, producer: 'test',
    });
    const executeProcess = vi.fn(async () => attachRawValidationOutput({
      success: true, exitCode: 0, stdout: 'Tests  2 passed (2)\n', stderr: '', timedOut: false,
    }, {
      stdout: `${'complete output\n'.repeat(5_000)}Tests  2 passed (2)\n`, stderr: '',
    }));
    const registry = new ToolRegistry();
    registry.register(withBuiltInEffectContract({ ...shellExecTool, execute: executeProcess }));
    const repositoryValidation = {
      baseSnapshotId: snapshot.id,
      rootPath: root,
      authority: engine.validation,
      environment: {
        platform: 'win32', architecture: 'x64', nodeVersion: 'v22.23.1', npmVersion: '11.8.0',
      },
    };
    const execute = registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
      repositoryValidation,
    });
    const result = await runWithJobExecutionContext({
      engine, jobId: admission.jobId, attemptId: admission.attemptId,
      generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test',
    }, () => execute({ id: 'provider-validation', name: 'shell_exec', arguments: { command: 'npm test', cwd: root } }));

    expect(result).toMatchObject({
      id: 'provider-validation', name: 'shell_exec',
      result: { success: true, exitCode: 0, stdout: 'Tests  2 passed (2)\n', stderr: '' },
    });
    expect(executeProcess).toHaveBeenCalledTimes(1);
    const run = db.prepare('SELECT run_id FROM validation_runs').get() as { run_id: string };
    expect(engine.validation.getRun(run.run_id)).toMatchObject({
      state: 'succeeded', passedCount: 2, failedCount: 0, repositorySnapshotId: snapshot.id,
    });
    expect(await engine.validation.assess(run.run_id, { repositorySnapshotId: snapshot.id }))
      .toEqual({ usable: true, reasons: [] });
    expect(engine.validation.readLogArtifact(engine.validation.getRun(run.run_id)!.artifactIds[0]!))
      .toContain('complete output');
  });
});
