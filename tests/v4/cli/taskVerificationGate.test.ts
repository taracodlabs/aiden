/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 Pillar 1 Gap 1 — the verify-before-done gate at the REAL seam.
 *
 * Drives ChatSession.runAgentTurn (the production turn path) with a
 * stubbed agent and a REAL better-sqlite3 task store (temp db, full
 * migrations), then asserts the durable row: a clean `stop` no longer
 * completes a task on prose — the verdict policy decides from the
 * turn's verifier evidence, and the evidence envelope lands on the row.
 *
 * Also covers: the model-declared ui_task_done failure path (through
 * the real onUiEvent collector), the pending_verification crash state
 * (via sweepOrphaned), and the v16 migration leaving pre-existing rows
 * untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { ChatSession, type ChatSessionOptions, type ChatPromptApi } from '../../../cli/v4/chatSession';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { createTaskStore, type TaskStore } from '../../../core/v4/daemon/taskStore';
import { runMigrations, MIGRATIONS_FOR_TESTS } from '../../../core/v4/daemon/db/migrations';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';

let tmp: string;
let db: InstanceType<typeof Database>;
let taskStore: TaskStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-verify-gate-'));
  db = new Database(path.join(tmp, 'daemon.db'));
  runMigrations(db);
  taskStore = createTaskStore({ db });
});

afterEach(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

// ── ChatSession scaffolding (greeter integration-test pattern) ─────────

function mkDisplay() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
  const display = new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out, stderr: err });
  return { display, chunks };
}

function mkPromptApi(): ChatPromptApi {
  return {
    async readLine() { throw new Error('User force closed'); },
    async selectSlashCommand() { return null; },
  };
}

interface StubTurn {
  finishReason?: string;
  toolCallTrace?: HonestyTraceEntry[];
  /** Called with the runConversation opts so a scenario can fire ui events. */
  onOpts?: (opts: Record<string, unknown>) => void;
}

function buildSession(stub: StubTurn) {
  const { display, chunks } = mkDisplay();
  const agent = {
    runConversation: vi.fn(async (_history: unknown, opts?: Record<string, unknown>) => {
      if (opts && stub.onOpts) stub.onOpts(opts);
      return {
        messages:      [],
        finalContent:  'done.',
        finishReason:  stub.finishReason ?? 'stop',
        toolCallTrace: stub.toolCallTrace ?? [],
        totalUsage:    { inputTokens: 1, outputTokens: 1 },
      };
    }),
    setProvider:    vi.fn(),
    setActiveModel: vi.fn(() => true),
  };
  const opts: ChatSessionOptions = {
    agent: agent as never,
    display,
    commandRegistry: new CommandRegistry(),
    callbacks: {} as never,
    sessionManager: {
      startSession:   vi.fn(() => ({ id: 'sess-verify', title: null } as never)),
      recordTurn:     vi.fn(),
      resumeLatest:   vi.fn(),
      resumeById:     vi.fn(),
      listSessions:   vi.fn(() => []),
      setSessionTitle: vi.fn(),
      search:         vi.fn(() => []),
    } as never,
    approvalEngine: {
      setMode: vi.fn(), getMode: () => 'manual' as const,
      checkApproval: vi.fn(async () => true),
      allowForSession: vi.fn(), allowAlways: vi.fn(), resetSession: vi.fn(),
    } as never,
    skin: new SkinEngine({ forceMono: true }),
    toolRegistry: {
      list: () => [], get: () => undefined, getSchemas: () => [],
      register: vi.fn(), unregister: vi.fn(), byCategory: () => [],
      buildExecutor: () => async () => ({ id: '1', name: 'noop', result: null }),
    } as never,
    skillLoader: {
      list: vi.fn(async () => []), load: vi.fn(),
      loadAll: vi.fn(async () => []), readSkillFile: vi.fn(),
    } as never,
    resolver: {
      resolve: vi.fn(async () => ({ call: vi.fn() })), describe: vi.fn(),
      listProviders: vi.fn(() => []), listModels: vi.fn(() => []),
    } as never,
    config: {} as never,
    initialProviderId: 'groq',
    initialModelId: 'llama-3.3-70b-versatile',
    installSignalHandler: false,
    paths: { root: tmp } as never,
    promptApi: mkPromptApi(),
    replTaskStore: taskStore,
  };
  const session = new ChatSession(opts);
  // runAgentTurn gates task creation on this.sessionId, normally set by
  // run(); set it directly so the test drives ONLY the turn path.
  (session as unknown as { sessionId: string }).sessionId = 'sess-verify';
  return { session, chunks };
}

async function runTurn(stub: StubTurn): Promise<{ task: ReturnType<TaskStore['get']>; chunks: string[] }> {
  const { session, chunks } = buildSession(stub);
  await (session as unknown as { runAgentTurn(input: string): Promise<void> }).runAgentTurn('do the thing');
  const rows = taskStore.listRecent({ sessionId: 'sess-verify' });
  expect(rows.length).toBe(1);
  return { task: taskStore.get(rows[0].id), chunks };
}

const V_OK   = { ok: true,  confidence: 1,   code: 'ok' as const };
const V_FAIL = { ok: false, confidence: 1,   code: 'failed' as const, reason: 'file-write unconfirmed (bytesWritten: 0)' };
const V_LOW  = { ok: true,  confidence: 0.4, code: 'low_signal' as const, reason: 'exit 0, empty stdout' };

// ── The gate, end to end ────────────────────────────────────────────────

describe('verify-before-done gate (real runAgentTurn seam)', () => {
  it('CRON-BUG REGRESSION: clean stop + mutating tool with no evidence → verification_failed on the DURABLE row, never completed', async () => {
    const { task, chunks } = await runTurn({
      toolCallTrace: [{
        name: 'file_write',
        result: { success: true, path: 'C:/x/out.txt', bytesWritten: 0 },
        handlerMutates: true,
        verification: V_FAIL,
      }],
    });
    expect(task!.status).toBe('verification_failed');
    expect(task!.evidence!.verdict).toBe('verification_failed');
    expect(task!.evidence!.failures[0].tool).toBe('file_write');
    // Honest surface: the user is told what was claimed without evidence.
    expect(chunks.join('')).toMatch(/verification failed/i);
    expect(chunks.join('')).toMatch(/file_write/);
  });

  it('happy path: evidence-backed mutation → completed with handles persisted on the row', async () => {
    const { task } = await runTurn({
      toolCallTrace: [{
        name: 'file_write',
        result: { success: true, path: 'C:/x/out.txt', bytesWritten: 42 },
        handlerMutates: true,
        verification: V_OK,
      }],
    });
    expect(task!.status).toBe('completed');
    const handles = task!.evidence!.handles;
    expect(handles.some((h) => h.kind === 'path' && h.value === 'C:/x/out.txt' && h.verified)).toBe(true);
    expect(handles.some((h) => h.kind === 'bytes' && h.value === 42)).toBe(true);
  });

  it('honest downgrade: weak-evidence mutation → completed_unverified, surfaced, never silently completed', async () => {
    const { task, chunks } = await runTurn({
      toolCallTrace: [{
        name: 'shell_exec',
        result: { exitCode: 0 },
        handlerMutates: true,
        verification: V_LOW,
      }],
    });
    expect(task!.status).toBe('completed_unverified');
    expect(chunks.join('')).toMatch(/completed unverified/i);
  });

  it('pure prose turn → completed (nothing claimed, nothing gates)', async () => {
    const { task } = await runTurn({ toolCallTrace: [] });
    expect(task!.status).toBe('completed');
    expect(task!.evidence!.verdict).toBe('completed');
  });

  it('model-declared ui_task_done failure → row finalized as failed with the declaration recorded (never upgraded by a clean stop)', async () => {
    const { task } = await runTurn({
      toolCallTrace: [],
      onOpts: (opts) => {
        const onUiEvent = opts.onUiEvent as (name: string, args: Record<string, unknown>) => void;
        onUiEvent('ui_task_done', { task_id: 't', status: 'failure' });
      },
    });
    expect(task!.status).toBe('failed');
    expect(task!.evidence!.reportedFailure).toBe('failure');
  });

  it('non-stop finish still routes to failed (unchanged behavior)', async () => {
    const { task } = await runTurn({ finishReason: 'error', toolCallTrace: [] });
    expect(task!.status).toBe('failed');
  });
});

// ── Crash honesty + migration safety ────────────────────────────────────

describe('pending_verification crash state + v16 migration', () => {
  it('sweepOrphaned retires a stranded pending_verification row (crash between the gate writes)', () => {
    const id = taskStore.create({ title: 't', goal: 't', sessionId: 's' });
    taskStore.setStatus(id, 'pending_verification');
    // Pretend it predates boot.
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, id);
    const swept = taskStore.sweepOrphaned(Date.now() - 1_000);
    expect(swept).toBe(1);
    expect(taskStore.get(id)!.status).toBe('interrupted');
  });

  it('v16 migration: rows created on the v15 schema are untouched — status intact, evidence null', async () => {
    const db2 = new Database(path.join(tmp, 'pre16.db'));
    try {
      // Apply everything below v16, marking the version like production.
      for (const m of MIGRATIONS_FOR_TESTS) {
        if (m.version <= 15) db2.exec(m.sql);
      }
      db2.prepare(
        'INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, 15, ?)',
      ).run(new Date().toISOString());
      db2.prepare(
        `INSERT INTO tasks (id, title, goal, status, created_at, updated_at,
           channel_id, session_id, parent_task_id, trace_ids, artifact_ids)
         VALUES ('task_old01', 'old', 'old goal', 'completed', 1, 1, 'repl', 's-old', NULL, '[]', '[]')`,
      ).run();
      runMigrations(db2);   // applies v16 only
      const store2 = createTaskStore({ db: db2 as never });
      const t = store2.get('task_old01');
      expect(t!.status).toBe('completed');
      expect(t!.evidence).toBeNull();
      // And the new write path works on the migrated table.
      store2.finalizeVerification('task_old01', 'completed', {
        v: 1, verdict: 'completed', decidedAt: 2, handles: [], failures: [],
      });
      expect(store2.get('task_old01')!.evidence!.decidedAt).toBe(2);
    } finally {
      db2.close();
    }
  });
});
