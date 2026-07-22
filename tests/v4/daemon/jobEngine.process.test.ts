/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';

type WorkerMessage = { type: string; result?: Record<string, unknown>; error?: string };

const fixture = resolve(__dirname, '../harness/jobEngineProcessFixture.ts');
let directory: string;
let dbPath: string;
let children: ChildProcess[];

function startWorker(payload: Record<string, unknown>): ChildProcess {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const child = fork(fixture, [dbPath, encoded], {
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  return child;
}

function message(child: ChildProcess, type: string): Promise<WorkerMessage> {
  return new Promise((resolveMessage, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const onMessage = (value: unknown): void => {
      const parsed = value as WorkerMessage;
      if (parsed.type === 'error') {
        cleanup();
        reject(new Error(parsed.error ?? 'worker failed'));
        return;
      }
      if (parsed.type !== type) return;
      cleanup();
      resolveMessage(parsed);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`worker exited before ${type} with code ${code}: ${stderr.trim()}`));
    };
    const cleanup = (): void => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function seed(): { jobId: string; attemptId: string } {
  const db = new Database(dbPath);
  runMigrations(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES ('process_instance', 1, 'localhost', ?, ?, '4.15.1')`,
  ).run(now, now);
  const admitted = createJobEngine({ db }).submitJob({
    entryPoint: 'process-test',
    source: 'process-test',
    sessionId: 'process-session',
    instanceId: 'process_instance',
    idempotencyNamespace: 'process-test',
    idempotencyKey: 'process-job',
    requestFingerprint: 'process-fingerprint',
    goal: 'Exercise process-level lease arbitration',
  });
  db.close();
  return admitted;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aiden-job-process-'));
  dbPath = join(directory, 'daemon.db');
  children = [];
});

afterEach(() => {
  for (const child of children) child.kill();
  rmSync(directory, { recursive: true, force: true });
});

describe('Job engine process arbitration', () => {
  it('allows exactly one of two real processes to claim an Attempt', async () => {
    const admitted = seed();
    const first = startWorker({ action: 'claim', attemptId: admitted.attemptId, ownerId: 'process_a' });
    const second = startWorker({ action: 'claim', attemptId: admitted.attemptId, ownerId: 'process_b' });
    await Promise.all([message(first, 'ready'), message(second, 'ready')]);
    const results = [message(first, 'result'), message(second, 'result')];
    first.send('go');
    second.send('go');

    const resolved = (await Promise.all(results)).map((entry) => entry.result);
    expect(resolved.filter((entry) => entry?.acquired === true)).toHaveLength(1);
    expect(resolved.filter((entry) => entry?.conflict === 'lease_held')).toHaveLength(1);
  });

  it('rejects a late result from a real process after another process reclaims the lease', async () => {
    const admitted = seed();
    const base = Date.now();
    const stale = startWorker({
      action: 'claim_then_write', attemptId: admitted.attemptId,
      ownerId: 'process_stale', ttlMs: 10, now: base,
    });
    const staleClaim = await message(stale, 'claimed');
    expect(staleClaim.result?.acquired).toBe(true);

    const recoveryDb = new Database(dbPath);
    const recovery = createJobEngine({ db: recoveryDb }).recoverExpiredAttempts({
      now: base + 11,
      instanceId: 'process_instance',
      producer: 'process-recovery',
      maxCrashes: 3,
    })[0]!;
    recoveryDb.close();
    const current = startWorker({
      action: 'claim', attemptId: recovery.recoveryAttemptId!,
      ownerId: 'process_current', ttlMs: 30_000, now: base + 11,
    });
    await message(current, 'ready');
    const currentResult = message(current, 'result');
    current.send('go');
    expect((await currentResult).result).toMatchObject({ acquired: true, generation: 2 });

    const lateResult = message(stale, 'result');
    stale.send('write');
    expect((await lateResult).result).toMatchObject({ applied: false, conflict: 'terminal_state' });
  });

  it('recovers a crashed process into a new Attempt after reopening the database', async () => {
    const admitted = seed();
    const base = Date.now();
    const crashing = startWorker({
      action: 'claim_and_crash', attemptId: admitted.attemptId,
      ownerId: 'process_crash', ttlMs: 10, now: base,
    });
    const claim = await message(crashing, 'claimed');
    expect(claim.result).toMatchObject({
      lease: { acquired: true, generation: 1 },
      started: { applied: true },
    });
    if (crashing.exitCode === null) {
      await new Promise<void>((resolveExit) => crashing.once('exit', () => resolveExit()));
    }

    const recovering = startWorker({
      action: 'recover', attemptId: admitted.attemptId,
      ownerId: 'process_instance', now: base + 11,
    });
    const recovered = await message(recovering, 'result');
    expect(recovered.result?.recovered).toEqual([expect.objectContaining({
      jobId: admitted.jobId,
      expiredAttemptId: admitted.attemptId,
      recoveryAttemptId: expect.stringMatching(/^attempt_/),
    })]);

    const reopened = new Database(dbPath);
    const engine = createJobEngine({ db: reopened });
    expect(engine.getJob(admitted.jobId)).toMatchObject({ status: 'recovering' });
    expect(engine.listAttempts(admitted.jobId)).toEqual([
      expect.objectContaining({ id: admitted.attemptId, status: 'crashed', generation: 1 }),
      expect.objectContaining({ status: 'queued', generation: 2, recoveryOfAttemptId: admitted.attemptId }),
    ]);
    reopened.close();
  });

  it.each([
    { mutates: false, expectedDecision: 'retry', expectedJobStatus: 'recovering', expectedAttempts: 2 },
    { mutates: true, expectedDecision: 'ask_user', expectedJobStatus: 'blocked', expectedAttempts: 1 },
  ])('recovers conservatively after a real process crashes during tool execution ($expectedDecision)', async ({
    mutates, expectedDecision, expectedJobStatus, expectedAttempts,
  }) => {
    const admitted = seed();
    const base = Date.now();
    const crashing = startWorker({
      action: 'start_tool_and_crash',
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      toolCallId: mutates ? 'tool_process_write' : 'tool_process_read',
      mutates,
      ownerId: 'process_tool_crash',
      ttlMs: 10,
      now: base,
    });
    const started = await message(crashing, 'tool_started');
    expect(started.result).toMatchObject({
      lease: { acquired: true, generation: 1 },
      attempt: { applied: true },
      prepared: { applied: true },
      started: { applied: true },
    });
    if (crashing.exitCode === null) {
      await new Promise<void>((resolveExit) => crashing.once('exit', () => resolveExit()));
    }

    const recovering = startWorker({
      action: 'recover', attemptId: admitted.attemptId,
      ownerId: 'process_instance', now: base + 11,
    });
    const recovered = await message(recovering, 'result');
    expect(recovered.result?.recovered).toEqual([expect.objectContaining({
      jobId: admitted.jobId,
      expiredAttemptId: admitted.attemptId,
      decision: expectedDecision,
    })]);

    const reopened = new Database(dbPath);
    const engine = createJobEngine({ db: reopened });
    expect(engine.getJob(admitted.jobId)?.status).toBe(expectedJobStatus);
    expect(engine.listAttempts(admitted.jobId)).toHaveLength(expectedAttempts);
    if (mutates) {
      expect(engine.getAttempt(admitted.attemptId)?.status).toBe('unknown');
    } else {
      expect(engine.listAttempts(admitted.jobId)[1]).toMatchObject({
        status: 'queued', generation: 2, recoveryOfAttemptId: admitted.attemptId,
      });
    }
    reopened.close();
  });

  it('allocates unique replayable Job event sequences under concurrent process writes', async () => {
    const admitted = seed();
    const db = new Database(dbPath);
    const engine = createJobEngine({ db });
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'event_owner', ttlMs: 30_000 });
    db.close();

    const first = startWorker({
      action: 'prepare_tool', jobId: admitted.jobId, attemptId: admitted.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken, toolCallId: 'tool_process_a',
    });
    const second = startWorker({
      action: 'prepare_tool', jobId: admitted.jobId, attemptId: admitted.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken, toolCallId: 'tool_process_b',
    });
    await Promise.all([message(first, 'ready'), message(second, 'ready')]);
    const results = [message(first, 'result'), message(second, 'result')];
    first.send('go');
    second.send('go');
    expect((await Promise.all(results)).map((entry) => entry.result?.applied)).toEqual([true, true]);

    const reopened = new Database(dbPath);
    const replay = createJobEngine({ db: reopened }).listEvents(admitted.jobId, 0);
    const sequences = replay.map((event) => event.jobSequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    const cursor = sequences.at(-2) ?? 0;
    expect(createJobEngine({ db: reopened }).listEvents(admitted.jobId, cursor).map((event) => event.jobSequence))
      .toEqual(sequences.filter((sequence) => sequence > cursor));
    reopened.close();
  });
});
