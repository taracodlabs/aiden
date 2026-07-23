/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../../core/v4/daemon/jobEngine';
import { buildToolCallHandler } from '../../../../core/v4/mcp/server/toolBridge';
import { resolveAidenPaths } from '../../../../core/v4/paths';
import { ToolRegistry } from '../../../../core/v4/toolRegistry';

describe('MCP direct durable identity', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('mcp_instance', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  it('creates a resolvable Job and Attempt before executing the tool', async () => {
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'mcp_read', description: 'read', inputSchema: { type: 'object' } },
      category: 'read', mutates: false, riskTier: 'safe', toolset: 'misc',
      execute: async () => {
        const job = engine.listJobs({ sessionId: 'mcp:mcp_instance' })[0];
        expect(job).toMatchObject({ status: 'running', entryPoint: 'mcp' });
        expect(engine.listAttempts(job!.id)[0]).toMatchObject({ status: 'running' });
        return { ok: true };
      },
    });
    const call = buildToolCallHandler(
      registry,
      { cwd: process.cwd(), paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-mcp-job' }) },
      { allowDestructive: false, allowlist: null },
      undefined,
      { engine, instanceId: 'mcp_instance' },
    );

    expect(await call('mcp_read', {})).toMatchObject({ isError: false });
    const job = engine.listJobs({ sessionId: 'mcp:mcp_instance' })[0]!;
    expect(job.status).toBe('completed');
    expect(engine.listAttempts(job.id)[0]!.status).toBe('succeeded');
  });

  it('durably records a deterministic denial when a mutating call has no approval channel', async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register({
      schema: { name: 'mcp_write', description: 'write', inputSchema: { type: 'object' } },
      category: 'write', mutates: true, riskTier: 'caution', toolset: 'misc',
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });
    const call = buildToolCallHandler(
      registry,
      { cwd: process.cwd(), paths: resolveAidenPaths({ rootOverride: 'C:/tmp/aiden-mcp-job' }) },
      { allowDestructive: true, allowlist: null },
      undefined,
      { engine, instanceId: 'mcp_instance' },
    );

    const result = await call('mcp_write', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('denied by approval engine');
    expect(executed).toBe(false);
    const job = engine.listJobs({ sessionId: 'mcp:mcp_instance' })[0]!;
    expect(job).toMatchObject({ status: 'failed', terminalOutcome: 'failed', finishReason: 'tool_error' });
    expect(engine.listAttempts(job.id)[0]).toMatchObject({ status: 'failed' });
  });
});
