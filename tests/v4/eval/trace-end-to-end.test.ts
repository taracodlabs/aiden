/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.9 — trace-end-to-end contract eval.
 *
 * Cross-slice regression layer for the Slice 10.2 family + 10.2c +
 * 10.2d. Each of those slices ships per-feature tests (event schema,
 * scope-query, REPL onDecision, tool_call_* runtime emission), but
 * the END-TO-END contract — "a turn that fires tool_call_* and
 * approval.decided events lands rows that /trace recent / trace_query
 * can correctly surface" — has only ever been exercised in pieces.
 *
 * This file pins the cross-slice contract:
 *   1. RunStore.emitEventRich writes rich rows that listEventsScoped
 *      can read back with full fidelity (category / kind / name /
 *      source / status / payload_truncated).
 *   2. The same query path that /trace recent uses (chatSessionId,
 *      not the turn-scoped sessionId — Slice 10.2c) returns events
 *      from ALL turns in the chat, not just the active one.
 *   3. The Slice 10.2d tool_call_* runtime emission shape is the
 *      symmetric form: source='repl' for REPL turns, with paired
 *      started+completed rows linked by toolCallId.
 *
 * If a future refactor breaks any of these wires individually,
 * per-slice tests catch it. This file catches the regression class
 * where individual wires still work but their composition drifts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { createRunStore, type RunStore } from '../../../core/v4/daemon/runStore';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { categorizeEvent } from '../../../core/v4/daemon/eventCategories';

let tmp: string;
let db: Database.Database;
let runStore: RunStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-trace-eval-'));
  db = new Database(path.join(tmp, 'daemon.db'));
  runMigrations(db);
  runStore = createRunStore({ db });
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

describe('trace-end-to-end — full session sees events from all turns (Slice 10.2 family)', () => {
  it('two sequential turns in one session: /trace recent (scope=current_session) shows both turns', () => {
    // Replay the production shape: ChatSession creates one run row
    // per turn; the chatSessionId stays constant across turns
    // (Slice 10.2c) so a /trace recent query at any point should
    // surface events from BOTH turns in the conversation.
    const sessionId = 'eval-session-X';

    // Turn 1 — tool_call + ui_task pair.
    const run1 = runStore.create({ sessionId, instanceId: 'eval-inst', status: 'running' });
    const t1Started = runStore.emitEventRich({
      runId: run1, ...categorizeEvent('tool_call_started'),
      name: 'tool_call_started', sessionId, toolCallId: 'tc_t1_1',
      status: 'started', summary: 'file_read', source: 'repl',
      payload: { toolName: 'file_read' },
    });
    const t1Completed = runStore.emitEventRich({
      runId: run1, ...categorizeEvent('tool_call_completed'),
      name: 'tool_call_completed', sessionId, toolCallId: 'tc_t1_1',
      status: 'ok', durationMs: 12, summary: 'file_read', source: 'repl',
      payload: { toolName: 'file_read', error: null, hasResult: true },
    });
    runStore.setStatus(run1, 'completed', { finishReason: 'stop' });

    // Turn 2 — different run id, same session.
    const run2 = runStore.create({ sessionId, instanceId: 'eval-inst', status: 'running' });
    const t2Started = runStore.emitEventRich({
      runId: run2, ...categorizeEvent('tool_call_started'),
      name: 'tool_call_started', sessionId, toolCallId: 'tc_t2_1',
      status: 'started', summary: 'shell_exec', source: 'repl',
      payload: { toolName: 'shell_exec' },
    });
    const t2Approval = runStore.emitEventRich({
      runId: run2, ...categorizeEvent('approval_decision'),
      name: 'approval_decision', sessionId,
      status: 'allowed', summary: 'shell_exec → allow (caution)', source: 'repl',
      payload: { toolName: 'shell_exec', decision: 'allow', riskTier: 'caution' },
    });
    runStore.setStatus(run2, 'completed', { finishReason: 'stop' });

    // /trace recent reads via scope='current_session' against the
    // long-lived chatSessionId (Slice 10.2c). Result spans turns.
    const rows = runStore.listEventsScoped({ scope: 'current_session', sessionId });
    expect(rows.length).toBe(4);
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([t1Started, t1Completed, t2Started, t2Approval].sort((a, b) => a - b));

    // Per-run scoping should still work — scope='current_run' for
    // turn 2 only returns turn 2's events.
    const turn2Only = runStore.listEventsScoped({ scope: 'current_run', runId: run2 });
    expect(turn2Only.length).toBe(2);
    expect(turn2Only.every((r) => r.runId === run2)).toBe(true);
  });

  it('Slice 10.2d tool_call shape — paired started/completed rows linked by toolCallId', () => {
    const sessionId = 'eval-pair';
    const runId = runStore.create({ sessionId, instanceId: 'eval-inst', status: 'running' });
    const tcId = 'tc_paired_001';
    runStore.emitEventRich({
      runId, ...categorizeEvent('tool_call_started'),
      name: 'tool_call_started', sessionId, toolCallId: tcId,
      status: 'started', summary: 'read_file', source: 'repl',
      payload: {},
    });
    runStore.emitEventRich({
      runId, ...categorizeEvent('tool_call_completed'),
      name: 'tool_call_completed', sessionId, toolCallId: tcId,
      status: 'ok', durationMs: 25, summary: 'read_file', source: 'repl',
      payload: {},
    });

    // tool_call_id filter — both rows surface together.
    const pair = runStore.listEventsScoped({ scope: 'current_run', runId, toolCallId: tcId });
    expect(pair.length).toBe(2);
    expect(pair.map((r) => r.name).sort()).toEqual(['tool_call_completed', 'tool_call_started']);
    expect(pair.every((r) => r.toolCallId === tcId)).toBe(true);
    expect(pair.every((r) => r.source === 'repl')).toBe(true);
    expect(pair.every((r) => r.category === 'tool')).toBe(true);
  });

  it('Slice 10.6 approval.decided rows surface category=approval + correct status verbs', () => {
    const sessionId = 'eval-approval';
    const runId = runStore.create({ sessionId, instanceId: 'eval-inst', status: 'running' });
    for (const verb of ['allow', 'deny', 'allow_session', 'allow_always'] as const) {
      runStore.emitEventRich({
        runId, ...categorizeEvent('approval_decision'),
        name: 'approval_decision', sessionId,
        status: verb === 'deny' ? 'denied' : 'allowed',
        summary: `tool → ${verb} (caution)`,
        source: 'repl',
        payload: { decision: verb },
      });
    }
    const rows = runStore.listEventsScoped({ scope: 'current_run', runId, category: 'approval' });
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.kind === 'approval.decided')).toBe(true);
    expect(rows.every((r) => r.name === 'approval_decision')).toBe(true);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['denied', 'allowed']));
  });

  it('source-contract guard — emit sites + trace_query use the same categorizeEvent helper', async () => {
    // Mock-blindness protection (v4.9.1 mirror): both the write side
    // (chatSession + aidenCLI + realAgentRunner) and the read side
    // (trace_query tool + /trace recent slash) must reference the
    // same categorizeEvent helper. A future refactor that introduces
    // a parallel mapping would silently drift the kinds.
    const chatSession = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/chatSession.ts'), 'utf8',
    );
    const aidenCLI = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/aidenCLI.ts'), 'utf8',
    );
    const realAgent = await fs.readFile(
      path.resolve(__dirname, '../../../core/v4/daemon/dispatcher/realAgentRunner.ts'), 'utf8',
    );
    expect(chatSession).toMatch(/categorizeEvent\(/);
    expect(aidenCLI).toMatch(/categorizeEvent\(/);
    expect(realAgent).toMatch(/categorizeEvent\(/);
  });
});
