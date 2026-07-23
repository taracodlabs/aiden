/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import http from 'node:http';

import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountRunsRoutes } from '../../../../core/v4/daemon/api/runs';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createJobControlAuthority, type JobControlAuthority } from '../../../../core/v4/daemon/jobControlAuthority';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../../../core/v4/daemon/jobEngine';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';

describe('daemon API durable run controls', () => {
  let db: Database.Database;
  let server: http.Server;
  let port: number;
  let jobs: JobEngine;
  let controls: JobControlAuthority;
  let admission: AdmissionResult;

  const post = async (url: string, body: unknown, key?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('api-test', 1, 'test', 1, 1, '4.15.1')`,
    ).run();
    jobs = createJobEngine({ db });
    controls = createJobControlAuthority({ db, jobEngine: jobs });
    admission = jobs.submitJob({
      entryPoint: 'daemon_api', source: 'test', sessionId: 'api-session', instanceId: 'api-test',
      idempotencyNamespace: 'test', idempotencyKey: 'job', goal: 'control test',
    });
    const app = express();
    mountRunsRoutes({
      app, db, jobEngine: jobs, jobControlAuthority: controls,
      triggerBus: createTriggerBus({ db }), instanceId: 'api-test', log: () => {},
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('persists exact ordinary input before acknowledgment and deduplicates delivery', async () => {
    const first = await post(`/api/runs/${admission.attemptId}/input`, { message: 'yes\n' }, 'input-exact');
    const duplicate = await post(`/api/runs/${admission.attemptId}/input`, { message: 'yes\n' }, 'input-exact');
    expect(first).toMatchObject({ status: 202, body: { accepted: true, duplicate: false } });
    expect(duplicate).toMatchObject({
      status: 202,
      body: { accepted: true, duplicate: true, input_id: first.body.input_id },
    });
    expect(controls.inputs.get(String(first.body.input_id))).toMatchObject({ kind: 'message', content: 'yes\n' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({ count: 0 });
  });

  it('persists pause for a safe boundary and resumes with a new generation', async () => {
    const lease = jobs.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 30_000 });
    jobs.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!, fenceToken: lease.fenceToken!, to: 'running',
      producer: 'test', eventIdempotencyKey: 'attempt-running',
    });
    jobs.transitionJob({
      jobId: admission.jobId, attemptId: admission.attemptId, expectedStateVersion: 0,
      generation: lease.generation!, fenceToken: lease.fenceToken!, to: 'running',
      producer: 'test', eventIdempotencyKey: 'job-running',
    });

    const paused = await post(`/api/runs/${admission.attemptId}/pause`, {}, 'pause-exact');
    expect(paused).toMatchObject({ status: 202, body: { persisted: true, applied: false } });
    expect(jobs.getJob(admission.jobId)?.status).toBe('running');
    expect(controls.commands.applyPendingAtBoundary({ jobId: admission.jobId }).applied).toBe(true);
    const resumed = await post(`/api/runs/${admission.attemptId}/resume`, {}, 'resume-exact');
    expect(resumed).toMatchObject({
      status: 202,
      body: {
        accepted: true,
        generation: 2,
        attempt_id: expect.any(String),
        trigger_event_id: expect.any(Number),
      },
    });
    expect(resumed.body.attempt_id).not.toBe(admission.attemptId);
    expect(db.prepare('SELECT trigger_event_id FROM runs WHERE attempt_id = ?').get(resumed.body.attempt_id))
      .toEqual({ trigger_event_id: resumed.body.trigger_event_id });
  });

  it('physically aborts the exact active runtime after durable cancellation wins', async () => {
    const controller = new AbortController();
    controls.runtime.attach(admission.attemptId, controller);
    const cancelled = await post(`/api/runs/${admission.attemptId}/cancel`, {}, 'cancel-exact');
    expect(cancelled).toMatchObject({ status: 202, body: { persisted: true, applied: true } });
    expect(controller.signal.aborted).toBe(true);
    expect(jobs.getJob(admission.jobId)?.status).toBe('cancelled');
  });
});
