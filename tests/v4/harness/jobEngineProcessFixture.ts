/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';

import { createJobEngine } from '../../../core/v4/daemon/jobEngine';

type Payload = {
  action: 'claim' | 'claim_then_write' | 'claim_and_crash' | 'start_tool_and_crash' | 'recover' | 'prepare_tool';
  attemptId: string;
  ownerId?: string;
  ttlMs?: number;
  now?: number;
  jobId?: string;
  expectedStateVersion?: number;
  generation?: number;
  fenceToken?: string;
  toolCallId?: string;
  mutates?: boolean;
};

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

function finish(message: Record<string, unknown>): void {
  if (!process.send) return;
  process.send(message, () => process.disconnect());
}

async function waitForGo(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once('message', (message) => {
      if (message === 'go') resolve();
    });
    send({ type: 'ready' });
  });
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  const encoded = process.argv[3];
  if (!dbPath || !encoded) throw new Error('database path and payload are required');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Payload;
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  const engine = createJobEngine({ db });
  try {
    if (payload.action === 'claim') {
      await waitForGo();
      const result = engine.claimAttempt({
        attemptId: payload.attemptId,
        ownerId: payload.ownerId ?? 'process_worker',
        ttlMs: payload.ttlMs ?? 30_000,
        now: payload.now,
      });
      finish({ type: 'result', result });
      return;
    }

    if (payload.action === 'claim_then_write') {
      const lease = engine.claimAttempt({
        attemptId: payload.attemptId,
        ownerId: payload.ownerId ?? 'stale_process',
        ttlMs: payload.ttlMs ?? 10,
        now: payload.now,
      });
      send({ type: 'claimed', result: lease });
      await new Promise<void>((resolve) => process.once('message', () => resolve()));
      const result = engine.transitionAttempt({
        attemptId: payload.attemptId,
        expectedStateVersion: lease.stateVersion ?? -1,
        generation: lease.generation ?? -1,
        fenceToken: lease.fenceToken ?? '',
        to: 'succeeded',
        eventIdempotencyKey: `late-process-result:${payload.ownerId ?? 'stale_process'}`,
        producer: 'process-test',
        now: (payload.now ?? Date.now()) + (payload.ttlMs ?? 10) + 1,
      });
      finish({ type: 'result', result });
      return;
    }

    if (payload.action === 'claim_and_crash') {
      const lease = engine.claimAttempt({
        attemptId: payload.attemptId,
        ownerId: payload.ownerId ?? 'crashing_process',
        ttlMs: payload.ttlMs ?? 10,
        now: payload.now,
      });
      if (!lease.acquired || lease.stateVersion === undefined || lease.generation === undefined || !lease.fenceToken) {
        finish({ type: 'error', error: `claim failed: ${lease.conflict ?? 'unknown'}` });
        return;
      }
      const started = engine.transitionAttempt({
        attemptId: payload.attemptId,
        expectedStateVersion: lease.stateVersion,
        generation: lease.generation,
        fenceToken: lease.fenceToken,
        to: 'running',
        eventIdempotencyKey: `crashing-process-running:${payload.attemptId}`,
        producer: 'process-test',
        now: payload.now,
      });
      send({ type: 'claimed', result: { lease, started } });
      process.exit(17);
    }

    if (payload.action === 'start_tool_and_crash') {
      const lease = engine.claimAttempt({
        attemptId: payload.attemptId,
        ownerId: payload.ownerId ?? 'crashing_tool_process',
        ttlMs: payload.ttlMs ?? 10,
        now: payload.now,
      });
      if (!lease.acquired || lease.stateVersion === undefined || lease.generation === undefined || !lease.fenceToken) {
        finish({ type: 'error', error: `claim failed: ${lease.conflict ?? 'unknown'}` });
        return;
      }
      const attempt = engine.transitionAttempt({
        attemptId: payload.attemptId,
        expectedStateVersion: lease.stateVersion,
        generation: lease.generation,
        fenceToken: lease.fenceToken,
        to: 'running',
        eventIdempotencyKey: `crashing-tool-attempt:${payload.attemptId}`,
        producer: 'process-test',
        now: payload.now,
      });
      const toolCallId = payload.toolCallId ?? 'tool_process_crash';
      const prepared = engine.prepareToolCall({
        toolCallId,
        jobId: payload.jobId ?? '',
        attemptId: payload.attemptId,
        generation: lease.generation,
        fenceToken: lease.fenceToken,
        toolName: payload.mutates ? 'file_write' : 'file_read',
        normalizedArgsDigest: `${toolCallId}-digest`,
        riskTier: payload.mutates ? 'caution' : 'safe',
        mutates: payload.mutates ?? false,
        producer: 'process-test',
        now: (payload.now ?? Date.now()) + 1,
      });
      const started = engine.startToolCall({
        toolCallId,
        attemptId: payload.attemptId,
        generation: lease.generation,
        fenceToken: lease.fenceToken,
        producer: 'process-test',
        now: (payload.now ?? Date.now()) + 2,
      });
      send({ type: 'tool_started', result: { lease, attempt, prepared, started } });
      process.exit(17);
    }

    if (payload.action === 'recover') {
      const result = engine.recoverExpiredAttempts({
        now: payload.now,
        instanceId: payload.ownerId ?? 'process_instance',
        producer: 'process-recovery',
        maxCrashes: 3,
      });
      finish({ type: 'result', result: { recovered: result } });
      return;
    }

    await waitForGo();
    const result = engine.prepareToolCall({
      toolCallId: payload.toolCallId ?? 'tool_process',
      jobId: payload.jobId ?? '',
      attemptId: payload.attemptId,
      generation: payload.generation ?? -1,
      fenceToken: payload.fenceToken ?? '',
      toolName: 'file_read',
      normalizedArgsDigest: payload.toolCallId ?? 'tool_process',
      riskTier: 'safe',
      mutates: false,
      producer: 'process-test',
    });
    finish({ type: 'result', result });
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  finish({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
