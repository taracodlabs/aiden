/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { executeOneShotTurn } from '../../../cli/v4/aidenCLI';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { fileReadTool } from '../../../tools/v4/files/fileRead';

describe('headless durable Job admission', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let root: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('instance_oneshot', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-oneshot-codebase-'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('creates identity before the first provider-facing agent call', async () => {
    const agent = {
      runConversation: vi.fn(async () => {
        expect(engine.listJobs({ sessionId: 'session_oneshot' })).toHaveLength(1);
        expect(engine.listAttempts(engine.listJobs({ sessionId: 'session_oneshot' })[0]!.id)[0]).toMatchObject({
          status: 'running',
        });
        return { finalContent: 'ok', finishReason: 'stop', toolCallTrace: [] };
      }),
    };

    expect(await executeOneShotTurn({
      agent,
      prompt: 'headless work',
      writeOut: () => {},
      writeErr: () => {},
      jobEngine: engine,
      instanceId: 'instance_oneshot',
      sessionId: 'session_oneshot',
    })).toBe(0);

    expect(agent.runConversation).toHaveBeenCalledOnce();
    expect(engine.listJobs({ sessionId: 'session_oneshot' })[0]).toMatchObject({ status: 'completed' });
  });

  it('binds repository inspection to the one-shot durable workspace', async () => {
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    const registry = new ToolRegistry();
    registry.register(fileReadTool);
    const execute = registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
    });
    let readResult: unknown;
    const agent = {
      runConversation: vi.fn(async () => {
        readResult = await execute({
          id: 'oneshot-read',
          name: 'file_read',
          arguments: { path: 'source.ts' },
        });
        return { finalContent: 'ok', finishReason: 'stop', toolCallTrace: [] };
      }),
    };

    expect(await executeOneShotTurn({
      agent,
      prompt: 'inspect source.ts',
      writeOut: () => {},
      writeErr: () => {},
      jobEngine: engine,
      instanceId: 'instance_oneshot',
      sessionId: 'session_codebase_oneshot',
      cwd: root,
    })).toBe(0);

    expect(readResult).toMatchObject({
      result: {
        success: true,
        content: 'export const value = 1;\n',
        snapshotId: expect.stringMatching(/^repository_snapshot_/),
      },
    });
    const job = engine.listJobs({ sessionId: 'session_codebase_oneshot' })[0]!;
    expect(job).toMatchObject({ status: 'completed', workspaceId: root });
    const snapshot = engine.repository.getAttemptSnapshot(job.id, engine.listAttempts(job.id)[0]!.id)!;
    expect(snapshot.repositoryRoot).toBeNull();
    expect(engine.repository.getWorkspace(snapshot.workspaceId)?.canonicalPath).toBe(await realpath(root));
  });
});
