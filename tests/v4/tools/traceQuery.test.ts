/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.2 — trace_query tool + listEventsForSession query helper.
 *
 * Covers the read-side surface in isolation. The chained-persistence
 * wire (chatSession.onUiEvent → emitEvent → listEventsForSession) is
 * tested separately in tests/v4/cli/chatSessionUiPersist.test.ts so
 * a future regression in either layer fails the right test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { createRunStore, type RunStore } from '../../../core/v4/daemon/runStore';
import { makeTraceQueryTool } from '../../../tools/v4/trace/traceQuery';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';

let tmp: string;
let db: Database.Database;
let store: RunStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-trace-query-'));
  db = new Database(path.join(tmp, 'daemon.db'));
  runMigrations(db);
  store = createRunStore({ db });
  // Seed a daemon_instances row so the runs FK is satisfied.
  db.prepare(
    `INSERT OR IGNORE INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('test-inst', process.pid, 'localhost', Date.now(), Date.now(), '4.10.0-test');
});

afterEach(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

// ─── listEventsForSession ─────────────────────────────────────────────

describe('RunStore.listEventsForSession', () => {
  it('returns events keyed to the given sessionId only', async () => {
    const r1 = store.create({ sessionId: 'sess-A', instanceId: 'test-inst', status: 'running' });
    const r2 = store.create({ sessionId: 'sess-B', instanceId: 'test-inst', status: 'running' });
    store.emitEvent(r1, 'ui_task_update', { task_id: 't1', label: 'doing A', status: 'running' });
    store.emitEvent(r2, 'ui_task_update', { task_id: 't2', label: 'doing B', status: 'running' });
    store.emitEvent(r1, 'ui_task_done',   { task_id: 't1', status: 'success' });

    const rows = store.listEventsForSession({ sessionId: 'sess-A' });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.runId === r1)).toBe(true);
    // newest-first ordering
    expect(rows[0].kind).toBe('ui_task_done');
    expect(rows[1].kind).toBe('ui_task_update');
  });

  it('filters by kindPrefix', async () => {
    const r = store.create({ sessionId: 'sess-K', instanceId: 'test-inst', status: 'running' });
    store.emitEvent(r, 'ui_task_update', { task_id: 'a' });
    store.emitEvent(r, 'tool_call_started', { name: 'foo' });
    store.emitEvent(r, 'ui_command_result', { command: 'ls' });

    const ui = store.listEventsForSession({ sessionId: 'sess-K', kindPrefix: 'ui_' });
    expect(ui.length).toBe(2);
    expect(ui.every((r) => r.kind.startsWith('ui_'))).toBe(true);

    const tool = store.listEventsForSession({ sessionId: 'sess-K', kindPrefix: 'tool_' });
    expect(tool.length).toBe(1);
    expect(tool[0].kind).toBe('tool_call_started');
  });

  it('respects sinceMs cutoff', async () => {
    const r = store.create({ sessionId: 'sess-T', instanceId: 'test-inst', status: 'running' });
    // Emit with a manual ts override is not part of the API — but Date.now()
    // moves forward between calls. Wait 5ms between writes; sinceMs at the
    // midpoint should split.
    store.emitEvent(r, 'old', { v: 1 });
    await new Promise((res) => setTimeout(res, 10));
    const cutoff = Date.now();
    await new Promise((res) => setTimeout(res, 10));
    store.emitEvent(r, 'new', { v: 2 });

    const recent = store.listEventsForSession({ sessionId: 'sess-T', sinceMs: cutoff });
    expect(recent.length).toBe(1);
    expect(recent[0].kind).toBe('new');
  });

  it('enforces limit cap (default 100, hard cap 5000)', async () => {
    const r = store.create({ sessionId: 'sess-L', instanceId: 'test-inst', status: 'running' });
    for (let i = 0; i < 150; i++) store.emitEvent(r, 'tick', { i });

    const noLimit = store.listEventsForSession({ sessionId: 'sess-L' });
    expect(noLimit.length).toBe(100);    // default

    const small = store.listEventsForSession({ sessionId: 'sess-L', limit: 5 });
    expect(small.length).toBe(5);

    const huge = store.listEventsForSession({ sessionId: 'sess-L', limit: 99999 });
    expect(huge.length).toBeLessThanOrEqual(150);   // capped by what exists
  });

  it('returns empty array when no events match', () => {
    const rows = store.listEventsForSession({ sessionId: 'never-existed' });
    expect(rows).toEqual([]);
  });
});

// ─── trace_query tool ─────────────────────────────────────────────────

describe('trace_query tool', () => {
  it('returns events for the current REPL session, newest first', async () => {
    const r = store.create({ sessionId: 'sess-tool', instanceId: 'test-inst', status: 'running' });
    store.emitEvent(r, 'ui_task_update', { task_id: 'a', label: 'first', status: 'running' });
    store.emitEvent(r, 'ui_task_done',   { task_id: 'a', status: 'success' });

    const tool = makeTraceQueryTool({
      runStore:         store,
      resolveSessionId: () => 'sess-tool',
    });
    const result = (await tool.execute!({}, { cwd: tmp, paths: {} as never })) as {
      success: boolean; count: number; events: Array<{ kind: string }>;
    };
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.events[0].kind).toBe('ui_task_done');
    expect(result.events[1].kind).toBe('ui_task_update');
  });

  it('returns synthetic failure when no session is active', async () => {
    const tool = makeTraceQueryTool({
      runStore:         store,
      resolveSessionId: () => null,
    });
    const result = (await tool.execute!({}, { cwd: tmp, paths: {} as never })) as {
      success: boolean; error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no active repl session/i);
  });

  it('parses since arg: "5min" returns events within last 5 minutes', async () => {
    const r = store.create({ sessionId: 'sess-since', instanceId: 'test-inst', status: 'running' });
    store.emitEvent(r, 'event-now', {});
    const tool = makeTraceQueryTool({
      runStore:         store,
      resolveSessionId: () => 'sess-since',
    });
    const result = (await tool.execute!({ since: '5min' }, { cwd: tmp, paths: {} as never })) as {
      success: boolean; count: number; filters: { since_ms: number | null };
    };
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.filters.since_ms).not.toBeNull();
  });

  it('parses since arg: garbage input becomes null (no filter)', async () => {
    const r = store.create({ sessionId: 'sess-junk', instanceId: 'test-inst', status: 'running' });
    store.emitEvent(r, 'e', {});
    const tool = makeTraceQueryTool({
      runStore:         store,
      resolveSessionId: () => 'sess-junk',
    });
    const result = (await tool.execute!({ since: 'tomorrow afternoon maybe' }, { cwd: tmp, paths: {} as never })) as {
      success: boolean; count: number; filters: { since_ms: number | null };
    };
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.filters.since_ms).toBeNull();
  });

  it('truncated flag fires when payload hits the runStore 4096-char cap', async () => {
    const r = store.create({ sessionId: 'sess-trunc', instanceId: 'test-inst', status: 'running' });
    // Build a payload whose JSON exceeds 4096 chars. runStore.emitEvent
    // slices to 4096; trace_query reads it back and the .length >= cap
    // marks `truncated: true`.
    const huge = 'x'.repeat(5000);
    store.emitEvent(r, 'ui_artifact_created', { path: '/tmp/x', kind: 'file', preview: huge });

    const tool = makeTraceQueryTool({
      runStore:         store,
      resolveSessionId: () => 'sess-trunc',
    });
    const result = (await tool.execute!({}, { cwd: tmp, paths: {} as never })) as {
      events: Array<{ truncated: boolean }>;
    };
    expect(result.events[0].truncated).toBe(true);
  });

  it('schema enumerates the three optional args', () => {
    const tool = makeTraceQueryTool({
      runStore:         store,
      resolveSessionId: () => null,
    });
    expect(tool.schema.name).toBe('trace_query');
    expect(tool.toolset).toBe('trace');
    expect(tool.mutates).toBe(false);
    const props = tool.schema.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['kind_prefix', 'limit', 'since']);
  });
});
