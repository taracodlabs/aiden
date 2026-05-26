/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.9 — tasks-end-to-end contract eval.
 *
 * Cross-slice regression layer for Slice 10.8's Task-lite kernel
 * plus the Slice 10.2b run_events back-reference via `trace_ids`.
 * Each layer has per-feature tests; this file pins the END-TO-END
 * contract: a turn that creates a task AND emits events results in
 * a /tasks listing that reflects the right status + a /trace recent
 * surface that shows the same events back-referenced by the task.
 *
 * Drives the production factories directly (no PTY needed for the
 * substrate-level contract; the integration test in
 * chatSessionUiPersist.test.ts already pins the chatSession ↔
 * taskStore wire at the source-contract level).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { createRunStore, type RunStore } from '../../../core/v4/daemon/runStore';
import { createTaskStore, type TaskStore } from '../../../core/v4/daemon/taskStore';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { categorizeEvent } from '../../../core/v4/daemon/eventCategories';

let tmp: string;
let db: Database.Database;
let runStore: RunStore;
let taskStore: TaskStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-tasks-eval-'));
  db = new Database(path.join(tmp, 'daemon.db'));
  runMigrations(db);
  runStore = createRunStore({ db });
  taskStore = createTaskStore({ db });
  db.prepare(
    `INSERT OR IGNORE INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('eval-inst', process.pid, 'localhost', Date.now(), Date.now(), '4.10.0-eval');
});

afterEach(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('tasks-end-to-end — task lifecycle + traceIds back-reference (Slice 10.8 + 10.2b)', () => {
  it('full turn: create task → emit events → append traceIds → transition to completed', () => {
    const sessionId = 'eval-tasks-session';
    // Turn begins: chatSession.runAgentTurn shape — create both
    // the run row AND the task row.
    const runId = runStore.create({ sessionId, instanceId: 'eval-inst', status: 'running' });
    const taskId = taskStore.create({
      title:     'list files and tell me about the largest one',
      goal:      'list files and tell me about the largest one',
      sessionId,
      channelId: 'repl',
      status:    'active',
    });

    // Turn body: agent fires tool_call_started + ui_task_update +
    // tool_call_completed + ui_task_done. Each emit returns the
    // run_event.id; chatSession (production wire) would call
    // taskStore.appendTraceId on each — replay that here.
    const events: number[] = [];
    for (const sample of [
      { name: 'tool_call_started',  status: 'started', summary: 'ls' },
      { name: 'ui_task_update',     status: null,      summary: 'scanning files' },
      { name: 'tool_call_completed',status: 'ok',      summary: 'ls' },
      { name: 'ui_task_done',       status: null,      summary: 'scan complete' },
    ]) {
      const id = runStore.emitEventRich({
        runId, ...categorizeEvent(sample.name),
        name: sample.name, sessionId,
        status: sample.status, summary: sample.summary,
        source: 'repl', payload: { name: sample.name },
      });
      taskStore.appendTraceId(taskId, id);
      events.push(id);
    }
    // Turn end: transitions.
    runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
    taskStore.setStatus(taskId, 'completed');

    // Assertions:
    // 1. Task row carries all 4 traceIds in append order.
    const task = taskStore.get(taskId)!;
    expect(task.status).toBe('completed');
    expect(task.traceIds).toEqual(events);
    expect(task.sessionId).toBe(sessionId);
    expect(task.channelId).toBe('repl');

    // 2. /tasks listing surfaces the completed task with its title.
    const listing = taskStore.listRecent({ sessionId });
    expect(listing.length).toBe(1);
    expect(listing[0].id).toBe(taskId);
    expect(listing[0].status).toBe('completed');

    // 3. /trace recent (current_session scope) returns the events
    //    in newest-first order, and EVERY event id appears in the
    //    task's traceIds.
    const traceRows = runStore.listEventsScoped({ scope: 'current_session', sessionId });
    expect(traceRows.length).toBe(4);
    const traceIdSet = new Set(traceRows.map((r) => r.id));
    for (const eventId of task.traceIds) {
      expect(traceIdSet.has(eventId)).toBe(true);
    }
  });

  it('/adjust cancel: task transitions to cancelled; subsequent listing reflects the new state', () => {
    const sessionId = 'eval-tasks-cancel';
    const taskId = taskStore.create({
      title:     'long running build',
      goal:      'kick off a long build',
      sessionId,
      channelId: 'repl',
    });
    expect(taskStore.get(taskId)!.status).toBe('active');

    // /adjust <task_id> cancel — production wire calls setStatus.
    taskStore.setStatus(taskId, 'cancelled');

    expect(taskStore.get(taskId)!.status).toBe('cancelled');
    const cancelled = taskStore.listRecent({ sessionId, status: 'cancelled' });
    expect(cancelled.length).toBe(1);
    expect(cancelled[0].id).toBe(taskId);
    const active = taskStore.listRecent({ sessionId, status: 'active' });
    expect(active.length).toBe(0);
  });

  it('/adjust goal: task.goal mutates without disturbing title or createdAt', async () => {
    const sessionId = 'eval-tasks-adjust';
    const taskId = taskStore.create({
      title:     'original prompt that\'s about 80 chars long but might be longer than ti',
      goal:      'original prompt full text — could be very long, much longer than the title cap',
      sessionId,
      channelId: 'repl',
    });
    const before = taskStore.get(taskId)!;

    // small clock advance so updatedAt is distinguishable from createdAt
    await new Promise((res) => setTimeout(res, 5));

    // /adjust <task_id> goal <new text>
    taskStore.setGoal(taskId, 'redirected goal — focus on README instead');

    const after = taskStore.get(taskId)!;
    expect(after.goal).toBe('redirected goal — focus on README instead');
    expect(after.title).toBe(before.title);          // title preserved
    expect(after.createdAt).toBe(before.createdAt);  // immutable
    expect(after.updatedAt).toBeGreaterThan(before.createdAt);
  });

  it('source-contract guard — /tasks + /adjust slash registrations exist + read chatSessionId', async () => {
    const cliSrc = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/aidenCLI.ts'), 'utf8',
    );
    // /tasks registration present + reads chatSessionId (Slice
    // 10.2c long-lived id, not the turn-scoped one — same fix
    // class as /trace recent).
    expect(cliSrc).toMatch(/name:\s*['"]tasks['"]/);
    expect(cliSrc).toMatch(/replParentRunRef\.chatSessionId/);

    // /adjust registration present + handles cancel + goal ops.
    expect(cliSrc).toMatch(/name:\s*['"]adjust['"]/);
    expect(cliSrc).toMatch(/setStatus\(taskId,\s*['"]cancelled['"]\)/);
    expect(cliSrc).toMatch(/setGoal\(taskId,\s*newGoal\)/);
  });
});
