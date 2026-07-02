/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 Pillar 1 Gap 4 — the resume sweep + full kill-sim re-drive.
 *
 * Real sqlite (migrations v18), real triggerBus, real runner (stubbed
 * agentBuilder). Covers: lease idempotency (double sweep = one resume),
 * the never-re-fire guarantee for unverified mutations (zero tool
 * dispatches before a user decision), the wake-loop cap, no-card
 * honesty, runId scoping — and the end-to-end kill-sim: a run dies
 * after writing file A, the sweep re-drives with the revalidation
 * preamble, attempt 2 completes with evidence, and the job-card shows
 * both attempts' footprints on ONE task row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { createTaskStore } from '../../../core/v4/daemon/taskStore';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { sweepResumePending } from '../../../core/v4/daemon/resumeSweep';
import {
  createRealAgentRunner,
  type AgentBuilder,
} from '../../../core/v4/daemon/dispatcher/realAgentRunner';
import type { DaemonAgentInput } from '../../../core/v4/daemon/dispatcher/agentRunner';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';

let db: Database.Database;
let runStore: ReturnType<typeof createRunStore>;
let taskStore: ReturnType<typeof createTaskStore>;
let triggerBus: ReturnType<typeof createTriggerBus>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-1', 1, 'h', Date.now(), Date.now(), '4.13.0');
  runStore   = createRunStore({ db });
  taskStore  = createTaskStore({ db: db as never });
  triggerBus = createTriggerBus({ db: db as never });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* noop */ }
});

const probeAll = (_p: string) => ({ exists: true, bytes: 10 });

function mkDeadRun(taskOver: Parameters<typeof taskStore.finalizeVerification>[3] = {}): { runId: number; taskId: string } {
  const taskId = taskStore.create({ title: 't', goal: 'finish the report', sessionId: 's-dead', channelId: 'daemon' });
  taskStore.finalizeVerification(taskId, 'interrupted', {
    v: 1, verdict: 'interrupted', decidedAt: 1, handles: [], failures: [],
  }, taskOver);
  const runId = runStore.create({ sessionId: 's-dead', instanceId: 'inst-1', status: 'running', taskId });
  runStore.setStatus(runId, 'interrupted', { finishReason: 'interrupted' });
  runStore.markResumePending(runId, 'daemon_crashed');
  return { runId, taskId };
}

function pendingEvents(): Array<{ id: number; payload: Record<string, unknown> }> {
  return (db.prepare(`SELECT id, payload_json FROM trigger_events WHERE status = 'pending'`).all() as Array<{ id: number; payload_json: string }>)
    .map((r) => ({ id: r.id, payload: JSON.parse(r.payload_json) }));
}

describe('sweepResumePending — verdict paths', () => {
  it('clean world → re-drive event enqueued with preamble + task linkage; resume_pending cleared; attempt counted', () => {
    const { runId, taskId } = mkDeadRun({ filesTouched: ['C:/x/a.txt'] });
    const r = sweepResumePending({ runStore, taskStore, triggerBus, fileProbe: probeAll });
    expect(r).toEqual({ scanned: 1, resumed: 1, askedUser: 0, abandoned: 0, skipped: 0 });

    const evs = pendingEvents();
    expect(evs).toHaveLength(1);
    const resume = evs[0].payload.resume as { prompt: string; taskId: string; ofRunId: number; attempt: number };
    expect(resume.taskId).toBe(taskId);
    expect(resume.ofRunId).toBe(runId);
    expect(resume.attempt).toBe(1);
    expect(resume.prompt).toMatch(/RESUMED after the previous run died/);
    expect(resume.prompt).toMatch(/Original goal: finish the report/);
    expect(runStore.get(runId)!.resumePending).toBe(false);
    expect(taskStore.get(taskId)!.resumeCount).toBe(1);
  });

  it('IDEMPOTENT: double sweep → exactly one resume event (lease compare-and-clear)', () => {
    mkDeadRun();
    const first  = sweepResumePending({ runStore, taskStore, triggerBus, fileProbe: probeAll });
    const second = sweepResumePending({ runStore, taskStore, triggerBus, fileProbe: probeAll });
    expect(first.resumed).toBe(1);
    expect(second).toEqual({ scanned: 0, resumed: 0, askedUser: 0, abandoned: 0, skipped: 0 });
    expect(pendingEvents()).toHaveLength(1);
  });

  it('NEVER-RE-FIRE: unverified mutation → blocked_needs_user, question on the card, ZERO events enqueued', () => {
    const { taskId } = mkDeadRun({
      sideEffects: [{ tool: 'shell_exec', target: 'deploy.sh', verified: false }],
    });
    const r = sweepResumePending({ runStore, taskStore, triggerBus, fileProbe: probeAll });
    expect(r.askedUser).toBe(1);
    expect(r.resumed).toBe(0);
    expect(pendingEvents()).toHaveLength(0);   // nothing for a runner to dispatch
    const t = taskStore.get(taskId)!;
    expect(t.status).toBe('blocked_needs_user');
    expect(t.failureState!.class).toBe('needs_user');
    expect(t.failureState!.reason).toMatch(/unknown whether they landed/);
    expect(t.resumeCount).toBe(0);             // no attempt spent on a question
  });

  it('wake-loop cap: third wake → abandoned with reason on the failureState', () => {
    const { taskId } = mkDeadRun();
    taskStore.incrementResumeCount(taskId);
    taskStore.incrementResumeCount(taskId);
    const r = sweepResumePending({ runStore, taskStore, triggerBus, fileProbe: probeAll });
    expect(r.abandoned).toBe(1);
    const t = taskStore.get(taskId)!;
    expect(t.status).toBe('abandoned');
    expect(t.failureState!.class).toBe('resume_abandoned');
    expect(t.failureState!.reason).toMatch(/resume cap exhausted/);
    expect(pendingEvents()).toHaveLength(0);
  });

  it('no job-card → honestly skipped (no revalidation possible, no blind re-drive)', () => {
    const runId = runStore.create({ sessionId: 's-old', instanceId: 'inst-1', status: 'running' });
    runStore.setStatus(runId, 'interrupted');
    runStore.markResumePending(runId, 'daemon_crashed');
    const r = sweepResumePending({ runStore, taskStore, triggerBus, fileProbe: probeAll });
    expect(r).toEqual({ scanned: 1, resumed: 0, askedUser: 0, abandoned: 0, skipped: 1 });
    const run = runStore.get(runId)!;
    expect(run.resumePending).toBe(false);
    expect(run.resumeReason).toBe('no_task_card');
    expect(pendingEvents()).toHaveLength(0);
  });

  it('runId scoping (manual aiden runs resume): only the named run is processed', () => {
    const a = mkDeadRun();
    const b = mkDeadRun();
    const r = sweepResumePending({ runStore, taskStore, triggerBus, fileProbe: probeAll, runId: b.runId });
    expect(r.scanned).toBe(1);
    expect(runStore.get(a.runId)!.resumePending).toBe(true);    // untouched
    expect(runStore.get(b.runId)!.resumePending).toBe(false);
  });
});

// ── Kill-sim end-to-end: die after file A, resume completes file B ──────

describe('kill-sim re-drive through the real runner', () => {
  const PERSISTED = { provider: 'ollama', model: 'llama3.2' };

  function mkInput(over: Partial<DaemonAgentInput> = {}): DaemonAgentInput {
    return {
      sessionId:      's-kill',
      instanceId:     'inst-1',
      triggerEventId: 1,
      triggerContext: {
        triggerId: 't1', source: 'manual', sourceKey: 't1',
        fireReason: 'manual', eventId: 1, attempt: 1, maxAttempts: 3,
        promptTemplate: null,
      },
      initialMessage: 'write files A and B',
      deliverOnly:    false,
      ...over,
    };
  }

  function stubBuilder(trace: HonestyTraceEntry[], finishReason = 'stop', onInvoke?: (history: unknown) => void): AgentBuilder {
    return () => ({
      runConversation: async (history: unknown) => {
        onInvoke?.(history);
        return {
          messages: [], finalContent: 'done', finishReason,
          toolCallTrace: trace, totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    }) as never;
  }

  it('dies after A → sweep re-drives with the preamble → attempt 2 completes; ONE card shows both footprints', async () => {
    // ── Attempt 1: writes A, then the "process dies" (finish error). ──
    const runner1 = createRealAgentRunner({
      db: db as never, runStore, taskStore,
      agentBuilder: stubBuilder([{
        name: 'file_write',
        result: { success: true, path: 'C:/x/a.txt', bytesWritten: 10 },
        handlerMutates: true,
        verification: { ok: true, confidence: 1, code: 'ok' },
      } as never], 'error'),
      persistedDefault: PERSISTED,
    });
    const res1 = await runner1.invoke(mkInput());
    const run1 = runStore.get(res1.runId)!;
    expect(run1.taskId).not.toBeNull();
    const taskId = run1.taskId!;
    expect(taskStore.get(taskId)!.filesTouched).toEqual(['C:/x/a.txt']);
    // Crash marking (what reclaim would do for a true process death).
    runStore.markResumePending(res1.runId, 'daemon_crashed');

    // ── Boot pass: sweep builds the plan + enqueues the re-drive. ─────
    const sweep = sweepResumePending({ runStore, taskStore, triggerBus, fileProbe: probeAll });
    expect(sweep.resumed).toBe(1);
    const ev = pendingEvents()[0];
    const resume = ev.payload.resume as { prompt: string; taskId: string; ofRunId: number; attempt: number };
    expect(resume.prompt).toMatch(/CONFIRMED \(do not redo\).*a\.txt/s);

    // ── Attempt 2: the dispatcher would parse payload.resume → input. ─
    let seenHistory: unknown = null;
    const runner2 = createRealAgentRunner({
      db: db as never, runStore, taskStore,
      agentBuilder: stubBuilder([{
        name: 'file_write',
        result: { success: true, path: 'C:/x/b.txt', bytesWritten: 20 },
        handlerMutates: true,
        verification: { ok: true, confidence: 1, code: 'ok' },
      } as never], 'stop', (h) => { seenHistory = h; }),
      persistedDefault: PERSISTED,
    });
    const res2 = await runner2.invoke(mkInput({
      triggerEventId: ev.id,
      initialMessage: resume.prompt,
      resume: { taskId: resume.taskId, ofRunId: resume.ofRunId, attempt: resume.attempt },
    }));

    // Fresh conversation seeded from TRUTH: the model saw the preamble.
    const historyText = JSON.stringify(seenHistory);
    expect(historyText).toMatch(/RESUMED after the previous run died/);
    // Same card, both attempts' footprints, verified completion.
    const run2 = runStore.get(res2.runId)!;
    expect(run2.taskId).toBe(taskId);
    const t = taskStore.get(taskId)!;
    expect(t.status).toBe('completed');
    expect(t.filesTouched).toEqual(['C:/x/a.txt', 'C:/x/b.txt']);
    expect(t.resumeCount).toBe(1);
    expect(t.evidence!.verdict).toBe('completed');
  });
});
