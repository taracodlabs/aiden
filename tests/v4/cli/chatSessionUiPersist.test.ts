/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.2 — chatSession onUiEvent persistence integration test.
 *
 * THE bug this guards: the model→render→persist wire could trivially
 * silently regress if a future refactor severs the runStore call from
 * the onUiEvent callback. v4.9.1/Slice 1/Slice 10.1 all shipped that
 * exact class of bug (handler accepts call → does nothing observable).
 *
 * Slice 10.1b's fix pattern: extract a single-source-of-truth helper
 * (createOnUiEventHandler) that production calls inline at the
 * dispatch site (chatSession.ts:1486-ish). The test drives THAT
 * helper with a real RunStore + a real Display surface — no
 * hand-rolled shortcut, no inline closure reconstruction.
 *
 * If a future refactor severs the runStore call (e.g. someone deletes
 * the persistence branch from the helper, or chatSession stops
 * calling the helper), these tests fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { createOnUiEventHandler } from '../../../cli/v4/chatSession';
import { createRunStore, type RunStore } from '../../../core/v4/daemon/runStore';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
// v4.10 Slice 10.2d — categoriser shared by production REPL tool-call
// emission (aidenCLI.ts onToolCall) and the integration test below.
import { categorizeEvent } from '../../../core/v4/daemon/eventCategories';

let tmp: string;
let db: Database.Database;
let runStore: RunStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-ui-persist-'));
  db = new Database(path.join(tmp, 'daemon.db'));
  runMigrations(db);
  runStore = createRunStore({ db });
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

interface DisplaySpy {
  display: { renderUiEvent(name: string, args: Record<string, unknown>): void };
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}
function spyDisplay(): DisplaySpy {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    display: {
      renderUiEvent(name, args) { calls.push({ name, args }); },
    },
    calls,
  };
}

describe('chatSession onUiEvent — render + persistence wire (Slice 10.2 / 10.2b regression layer)', () => {
  it('persists every ui_* emission with rich (category, kind, name) taxonomy', () => {
    // Set up a real run row so the FK is satisfied.
    const runId = runStore.create({
      sessionId:  'sess-int-1',
      instanceId: 'test-inst',
      status:     'running',
    });
    const spy = spyDisplay();
    let indicatorStops = 0;

    const handler = createOnUiEventHandler({
      display:           spy.display,
      runStore,
      runId,
      sessionId:         'sess-int-1',
      stopIndicatorOnce: () => { indicatorStops += 1; },
    });

    handler('ui_task_update', { task_id: 'a', label: 'first', status: 'running' });
    handler('ui_task_done',   { task_id: 'a', status: 'success' });
    handler('ui_command_result', { command: 'ls', exit_code: 0 });

    // Render side: 3 calls forwarded.
    expect(spy.calls.length).toBe(3);
    expect(spy.calls[0].name).toBe('ui_task_update');
    expect(spy.calls[2].name).toBe('ui_command_result');

    // Indicator stopped once per call.
    expect(indicatorStops).toBe(3);

    // Persistence side: 3 rich rows landed for the runId. Validate
    // category/kind/name match the eventCategories taxonomy and that
    // session_id was threaded through.
    const rows = runStore.listEventsScoped({ scope: 'current_run', runId });
    expect(rows.length).toBe(3);
    // listEventsScoped returns DESC; sort to a deterministic order.
    const byKind = rows.map((r) => ({
      category: r.category,
      kind:     r.kind,
      name:     r.name,
      sessionId:r.sessionId,
      source:   r.source,
    }));
    expect(byKind).toEqual(expect.arrayContaining([
      { category: 'task',    kind: 'task.update',       name: 'ui_task_update',    sessionId: 'sess-int-1', source: 'repl' },
      { category: 'task',    kind: 'task.done',         name: 'ui_task_done',      sessionId: 'sess-int-1', source: 'repl' },
      { category: 'command', kind: 'command.completed', name: 'ui_command_result', sessionId: 'sess-int-1', source: 'repl' },
    ]));
    // Payload round-trips as JSON.
    const updateRow = rows.find((r) => r.name === 'ui_task_update')!;
    expect(JSON.parse(updateRow.payload)).toMatchObject({ task_id: 'a', label: 'first' });
  });

  it('renders but does NOT persist when runId is null (between turns)', () => {
    const spy = spyDisplay();
    const handler = createOnUiEventHandler({
      display:           spy.display,
      runStore,
      runId:             null,    // ← no active turn
      stopIndicatorOnce: () => {},
    });

    handler('ui_toast', { kind: 'info', message: 'hi' });

    expect(spy.calls.length).toBe(1);
    // No runs row was even created; verify nothing was inserted.
    const totalEvents = db.prepare('SELECT COUNT(*) AS c FROM run_events').get() as { c: number };
    expect(totalEvents.c).toBe(0);
  });

  it('renders but does NOT persist when runStore is undefined (no daemon DB)', () => {
    const spy = spyDisplay();
    const handler = createOnUiEventHandler({
      display:           spy.display,
      runStore:          undefined,
      runId:             42,
      stopIndicatorOnce: () => {},
    });

    handler('ui_task_update', { task_id: 'b', label: 'no-store', status: 'running' });
    expect(spy.calls.length).toBe(1);
    // No DB to check — just verify nothing threw.
  });

  it('persistence fault does NOT break dispatch (try/catch contract)', () => {
    // Inject a runStore that throws on emitEventRich. Handler must
    // catch and continue rendering. This is the "DB locked mid-turn"
    // path.
    const throwingStore = {
      emitEventRich(): number { throw new Error('simulated DB lock'); },
    };
    const spy = spyDisplay();
    const handler = createOnUiEventHandler({
      display:           spy.display,
      runStore:          throwingStore,
      runId:             1,
      stopIndicatorOnce: () => {},
    });

    expect(() => handler('ui_task_update', { task_id: 'c', label: 'safe', status: 'running' })).not.toThrow();
    // Render still happened despite the persistence fault.
    expect(spy.calls.length).toBe(1);
  });

  it('listEventsScoped returns events written through the handler (end-to-end)', () => {
    // The acceptance scenario: a turn fires three ui_* events;
    // trace_query (which is backed by listEventsScoped) sees them with
    // the rich shape.
    const runId = runStore.create({
      sessionId:  'sess-e2e',
      instanceId: 'test-inst',
      status:     'running',
    });
    const spy = spyDisplay();
    const handler = createOnUiEventHandler({
      display:           spy.display,
      runStore,
      runId,
      sessionId:         'sess-e2e',
      stopIndicatorOnce: () => {},
    });

    handler('ui_task_update', { task_id: 'x', label: 'scanning', status: 'running' });
    handler('ui_artifact_created', { path: '/tmp/x.txt', kind: 'file', preview: 'hello' });
    handler('ui_task_done', { task_id: 'x', status: 'success' });

    // Query via the same helper trace_query uses (current_session scope).
    const events = runStore.listEventsScoped({
      scope:     'current_session',
      sessionId: 'sess-e2e',
    });
    expect(events.length).toBe(3);
    // Newest-first ordering: done → artifact → update.
    expect(events.map((e) => e.name)).toEqual([
      'ui_task_done',
      'ui_artifact_created',
      'ui_task_update',
    ]);
    expect(events[0].runId).toBe(runId);
    // Per-run seq monotonic + starting at 1.
    expect(events.map((e) => e.seq).sort()).toEqual([1, 2, 3]);
  });
});

// ─── Mock-blindness verification ──────────────────────────────────────

describe('chatSession onUiEvent — production routes through createOnUiEventHandler', () => {
  it('the chatSession source file calls createOnUiEventHandler at the dispatch site', async () => {
    // Source-level guard: if a future refactor reverts the dispatch
    // site to an inline closure (the v4.9.1 mock-blindness pattern),
    // this assertion fails. We can't directly test the live REPL
    // boot without spinning up the whole agent loop, so we assert on
    // the source contract: the helper IS called from chatSession.ts,
    // by name, somewhere inside a `runConversation` adjacent block.
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/chatSession.ts'),
      'utf8',
    );
    // The dispatch site MUST call createOnUiEventHandler (not inline
    // the closure). If someone re-inlines `(name, args) => { ... }`,
    // they remove the call to this helper and this assertion catches
    // it.
    expect(src).toMatch(/onUiEvent:\s*createOnUiEventHandler\(\s*\{/);
    // And the helper itself must route through the shared categoriser
    // + emitEventRich — the actual rich persistence wire.
    expect(src).toMatch(/categorizeEvent\(/);
    expect(src).toMatch(/runStore\.emitEventRich\(/);
  });

  it('daemon-side dispatch routes through eventCategories helper too', async () => {
    // Slice 10.2b source-contract guard: realAgentRunner's onUiEvent
    // wire must call categorizeEvent + emitEventRich, not the legacy
    // emitEvent. This prevents a daemon-side regression from re-
    // landing the pre-taxonomy emission shape.
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../core/v4/daemon/dispatcher/realAgentRunner.ts'),
      'utf8',
    );
    expect(src).toMatch(/categorizeEvent\(/);
    expect(src).toMatch(/emitEventRich\(/);
  });

  it('Slice 10.2d — REPL parent agent + realAgentRunner have SYMMETRIC tool_call_* emission coverage', async () => {
    // Source-contract symmetric-coverage guard. The bug this catches:
    // grep-based emit-site audits can't find sites that SHOULD emit
    // but don't. Slice 10.2b converted 7 existing emit sites to the
    // rich shape but never noticed the REPL parent agent had no
    // emit site at all — so REPL tool activity stayed invisible to
    // /trace recent until Slice 10.2d added the missing wire.
    //
    // This test enforces parity: if either the REPL path (aidenCLI.ts)
    // or the daemon path (realAgentRunner.ts) ever loses its
    // tool_call_* emission, the symmetry breaks and this test fails.
    // Recurrence-proof per audit-blindspot lesson.
    const replSrc = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/aidenCLI.ts'),
      'utf8',
    );
    const daemonSrc = await fs.readFile(
      path.resolve(__dirname, '../../../core/v4/daemon/dispatcher/realAgentRunner.ts'),
      'utf8',
    );

    // Both paths MUST categorize + emitEventRich for tool_call_started.
    expect(replSrc).toMatch(/categorizeEvent\('tool_call_started'\)/);
    expect(daemonSrc).toMatch(/categorizeEvent\('tool_call_started'\)/);
    // Both paths MUST emit tool_call_completed.
    expect(replSrc).toMatch(/categorizeEvent\('tool_call_completed'\)/);
    expect(daemonSrc).toMatch(/categorizeEvent\('tool_call_completed'\)/);
    // Both paths must call emitEventRich (not the legacy emitEvent).
    expect(replSrc).toMatch(/emitEventRich\(/);
    expect(daemonSrc).toMatch(/emitEventRich\(/);
  });

  it('Slice 10.2d — REPL tool_call_* emission shape (category=tool, source=repl, durationMs populated)', () => {
    // Integration test mirroring the production onToolCall closure in
    // aidenCLI.ts. Drives the real runStore + categorizeEvent factory
    // with a synthetic call/result the way AidenAgent.runConversation
    // would — proves the row shape lands correctly without booting
    // the whole CLI. Source-level guard above protects from regression
    // of the inline closure itself.
    const runId = runStore.create({
      sessionId:  'sess-tool-emit',
      instanceId: 'test-inst',
      status:     'running',
    });

    const startTimes = new Map<string, number>();

    // The exact emission pattern used in aidenCLI.ts:1683+ (Slice 10.2d).
    function emitToolEvent(call: { id: string; name: string }, phase: 'before' | 'after', result?: { error?: string; result?: unknown }): void {
      if (phase === 'before') {
        const startedAt = Date.now();
        startTimes.set(call.id, startedAt);
        const tags = categorizeEvent('tool_call_started');
        runStore.emitEventRich({
          runId,
          category:   tags.category,
          kind:       tags.kind,
          name:       'tool_call_started',
          sessionId:  'sess-tool-emit',
          toolCallId: call.id,
          status:     'started',
          summary:    call.name,
          payload:    { toolName: call.name, ts: startedAt },
          visibility: 'system',
          source:     'repl',
        });
      } else {
        const startedAt = startTimes.get(call.id) ?? Date.now();
        startTimes.delete(call.id);
        const durationMs = Date.now() - startedAt;
        const tags = categorizeEvent('tool_call_completed');
        runStore.emitEventRich({
          runId,
          category:   tags.category,
          kind:       tags.kind,
          name:       'tool_call_completed',
          sessionId:  'sess-tool-emit',
          toolCallId: call.id,
          status:     result?.error ? 'failed' : 'ok',
          durationMs,
          summary:    `${call.name}${result?.error ? ' (failed)' : ''}`,
          payload:    { toolName: call.name, error: result?.error ?? null, hasResult: !!result?.result, durationMs },
          visibility: 'system',
          source:     'repl',
        });
      }
    }

    // Simulate a successful `read_file` tool call + a failing `shell_exec` one.
    emitToolEvent({ id: 'tc_1', name: 'read_file' }, 'before');
    // brief busy-wait so durationMs is > 0 (Date.now resolution is ms).
    const spinUntil = Date.now() + 2;
    while (Date.now() < spinUntil) { /* burn 2ms */ }
    emitToolEvent({ id: 'tc_1', name: 'read_file' }, 'after', { result: 'ok' });

    emitToolEvent({ id: 'tc_2', name: 'shell_exec' }, 'before');
    emitToolEvent({ id: 'tc_2', name: 'shell_exec' }, 'after', { error: 'EACCES' });

    const rows = runStore.listEventsScoped({ scope: 'current_run', runId });
    expect(rows.length).toBe(4);

    // Assert on each event's rich shape via tool_call_id pairing.
    const r1Start = rows.find((r) => r.toolCallId === 'tc_1' && r.name === 'tool_call_started')!;
    const r1End   = rows.find((r) => r.toolCallId === 'tc_1' && r.name === 'tool_call_completed')!;
    expect(r1Start.category).toBe('tool');
    expect(r1Start.kind).toBe('tool.call.started');
    expect(r1Start.source).toBe('repl');
    expect(r1Start.status).toBe('started');
    expect(r1End.category).toBe('tool');
    expect(r1End.kind).toBe('tool.call.completed');
    expect(r1End.status).toBe('ok');
    expect(r1End.durationMs).toBeGreaterThan(0);

    // Failed call surfaces status='failed' + error in payload.
    const r2End = rows.find((r) => r.toolCallId === 'tc_2' && r.name === 'tool_call_completed')!;
    expect(r2End.status).toBe('failed');
    expect(JSON.parse(r2End.payload).error).toBe('EACCES');
  });

  it('Slice 10.2c — /trace recent + trace_query read chatSessionId, NOT the turn-scoped sessionId', async () => {
    // Source-level guard. The pre-10.2c bug: both read surfaces
    // consumed `replParentRunRef.sessionId` (turn-scoped, cleared
    // post-turn), so reads failed mid-conversation between turns.
    // Fix: route through the long-lived `chatSessionId` field on the
    // same ref, written once at ChatSession.run() init.
    //
    // If a future refactor reverts either read site to `.sessionId`,
    // this assertion catches it.
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/aidenCLI.ts'),
      'utf8',
    );
    // makeTraceQueryTool registration: resolveSessionId must read
    // chatSessionId.
    expect(src).toMatch(/resolveSessionId:\s*\(\)\s*=>\s*replParentRunRef\.chatSessionId/);
    // /trace recent slash handler: must read chatSessionId.
    expect(src).toMatch(/const sessionId = replParentRunRef\.chatSessionId/);
    // ChatSession.run() must publish the long-lived id.
    const sessSrc = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/chatSession.ts'),
      'utf8',
    );
    expect(sessSrc).toMatch(/replParentRunRef\.chatSessionId\s*=\s*this\.sessionId/);
  });
});
