/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import http from 'node:http';

import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createHttpJobCoordinator } from '../../../core/v4/daemon/httpJobIngress';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { currentJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { executeTool } from '../../../core/toolRegistry';

describe('HTTP durable Job ingress', () => {
  let db: Database.Database;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('http_test', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
    const engine = createJobEngine({ db });
    const coordinator = createHttpJobCoordinator({ engine, instanceId: 'http_test' });
    const app = express();
    app.use(express.json());
    app.post('/direct', coordinator.middleware({ entryPoint: 'compatibility_api', source: 'test' }), async (_req, res) => {
      const context = currentJobExecutionContext();
      await executeTool('respond', { message: 'ok' });
      res.json({ seen_job_id: context?.jobId, seen_attempt_id: context?.attemptId });
    });
    app.post('/outer', coordinator.middleware({ entryPoint: 'openai_compatible_api', source: 'test' }), async (_req, res) => {
      const outer = currentJobExecutionContext();
      const response = await fetch(`http://127.0.0.1:${port}/inner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...coordinator.internalHeaders(coordinator.internalToken(res)) },
        body: JSON.stringify({ message: 'internal' }),
      });
      const inner = await response.json() as Record<string, unknown>;
      res.json({ outer_job_id: outer?.jobId, inner_job_id: inner.seen_job_id });
    });
    app.post('/outer-reuse', coordinator.middleware({ entryPoint: 'openai_compatible_api', source: 'test' }), async (_req, res) => {
      const headers = { 'content-type': 'application/json', ...coordinator.internalHeaders(coordinator.internalToken(res)) };
      const first = await fetch(`http://127.0.0.1:${port}/inner`, {
        method: 'POST', headers, body: JSON.stringify({ message: 'first' }),
      });
      const second = await fetch(`http://127.0.0.1:${port}/inner`, {
        method: 'POST', headers, body: JSON.stringify({ message: 'second' }),
      });
      res.json({ first: first.status, second: second.status });
    });
    app.post('/inner', coordinator.middleware({ entryPoint: 'compatibility_api', source: 'test' }), (_req, res) => {
      res.json({ seen_job_id: currentJobExecutionContext()?.jobId });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('persists and starts identity before the route, then finalizes after the response', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.job_id).toBe(body.seen_job_id);
    expect(body.attempt_id).toBe(body.seen_attempt_id);
    expect(typeof body.run_id).toBe('number');
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.prepare('SELECT status, active_attempt_id FROM tasks WHERE id = ?').get(body.job_id)).toEqual({
      status: 'completed',
      active_attempt_id: null,
    });
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(body.run_id)).toEqual({ status: 'succeeded' });
    expect(db.prepare('SELECT job_id, attempt_id, state FROM tool_calls').get()).toEqual({
      job_id: body.job_id,
      attempt_id: body.attempt_id,
      state: 'completed',
    });
  });

  it('borrows the outer identity for the internal compatibility hop', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/outer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(body.inner_job_id).toBe(body.outer_job_id);
    expect(body.job_id).toBe(body.outer_job_id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
  });

  it('allows an internal identity loan token to be consumed only once', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/outer-reuse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(await response.json()).toMatchObject({ first: 200, second: 409 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  });
});
