/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { executeOneShotTurn } from '../../../cli/v4/aidenCLI';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';

describe('headless durable Job admission', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('instance_oneshot', 1, 'localhost', ?, ?, '4.15.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

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
});
