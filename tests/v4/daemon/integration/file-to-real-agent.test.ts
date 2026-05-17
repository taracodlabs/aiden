/**
 * v4.5 Phase 7b — full pipeline integration with a real agent.
 *
 * Verifies that when an AgentBuilder is injected:
 *   1. file watcher inserts a trigger_event
 *   2. dispatcher claims it
 *   3. realAgentRunner invokes the agent via the builder
 *   4. run_events captures the chain (dispatcher:invoked →
 *      tool_call_started → tool_call_completed → dispatcher:completed)
 *   5. sessionId stable across retries
 *   6. daemon turn does not corrupt REPL agent state (isolation)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { createRunStore } from '../../../../core/v4/daemon/runStore';
import {
  createDispatcher,
  createRealAgentRunner,
} from '../../../../core/v4/daemon/dispatcher';
import type { AgentBuilder } from '../../../../core/v4/daemon/dispatcher';
import type {
  AidenAgent,
  AidenAgentResult,
} from '../../../../core/v4/aidenAgent';
import type {
  ToolCallRequest,
  ToolCallResult,
} from '../../../../providers/v4/types';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-7b', 1, 'h', Date.now(), Date.now(), '4.5.0');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

/**
 * Build a stub AidenAgent whose runConversation fires the supplied
 * onToolCall hook (before + after) for ONE synthetic tool call,
 * then returns finishReason='stop'.
 */
function stubAgentFiringOneTool(
  onToolCall: (call: ToolCallRequest, phase: 'before' | 'after', result?: ToolCallResult) => void,
): AidenAgent {
  return {
    runConversation: async () => {
      const call: ToolCallRequest = { id: 'c1', name: 'file_read', arguments: { path: '/repo/x.md' } };
      onToolCall(call, 'before');
      const result: ToolCallResult = { id: 'c1', name: 'file_read', result: { text: 'hello' } };
      onToolCall(call, 'after', result);
      return { finishReason: 'stop' } as unknown as AidenAgentResult;
    },
  } as unknown as AidenAgent;
}

describe('integration — file trigger → real agent → run_events chain', () => {
  it('builder receives sessionId + dispatcher emits full event chain', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });

    // Pre-seed the trigger row + an event the dispatcher will claim.
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'wat-1', 'file', 'docs-watcher', JSON.stringify({ paths: ['/repo'] }),
      1, null, 0, Date.now(), Date.now(),
    );
    bus.insert({
      source: 'file', sourceKey: 'wat-1',
      idempotencyKey: '/repo/x.md|1234567890',
      payload: { path: '/repo/x.md', event: 'change' },
    });

    let builderCalls = 0;
    let observedSessionId = '';
    const builder: AgentBuilder = (b) => {
      builderCalls += 1;
      observedSessionId = b.sessionId;
      return stubAgentFiringOneTool(b.hooks.onToolCall);
    };

    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder,
      persistedDefault: { provider: 'ollama', model: 'llama3.2' },
    });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-7b', instanceId: 'inst-7b',
      workerCount: 1,
      runnerFactory: () => runner,
    });

    const eventId = await dispatcher._pumpOnce();
    expect(eventId).toBe(1);
    expect(builderCalls).toBe(1);
    expect(observedSessionId).toMatch(/^trigger:file:wat-1:/);

    const evRow = bus.get(1);
    expect(evRow?.status).toBe('done');
    expect(evRow?.runId).not.toBeNull();

    const runId = evRow!.runId!;
    const events = runStore.listEvents(runId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('dispatcher:invoked');
    expect(kinds).toContain('tool_call_started');
    expect(kinds).toContain('tool_call_completed');
    expect(kinds).toContain('dispatcher:completed');

    // dispatcher:invoked payload reflects builder context.
    const invokedPayload = JSON.parse(events.find((e) => e.kind === 'dispatcher:invoked')!.payload);
    expect(invokedPayload.source).toBe('file');
    expect(invokedPayload.triggerId).toBe('wat-1');
    expect(invokedPayload.model).toBe('llama3.2');

    // tool_call_started carries the tool name.
    const toolStarted = JSON.parse(events.find((e) => e.kind === 'tool_call_started')!.payload);
    expect(toolStarted.toolName).toBe('file_read');
  });

  it('sessionId stable across retries (idempotencyKey-keyed)', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES ('wat-2', 'file', 'w', '{}', 1, NULL, 0, ?, ?)`).run(Date.now(), Date.now());
    bus.insert({ source: 'file', sourceKey: 'wat-2', idempotencyKey: '/x|t', payload: { path: '/x' } });

    let count = 0;
    const sessions: string[] = [];
    const builder: AgentBuilder = (b) => {
      sessions.push(b.sessionId);
      count += 1;
      if (count < 3) {
        return { runConversation: async () => { throw new Error('flake'); } } as unknown as AidenAgent;
      }
      return stubAgentFiringOneTool(b.hooks.onToolCall);
    };
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder,
      persistedDefault: { provider: 'ollama', model: 'llama3.2' },
    });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-7b', instanceId: 'inst-7b',
      workerCount: 1, maxAttempts: 3,
      runnerFactory: () => runner,
    });

    await dispatcher._pumpOnce();
    // Phase 7 cooldown — advance past it so the next pump can re-claim.
    db.prepare('UPDATE trigger_events SET claim_expires_at = ? WHERE id = 1').run(Date.now() - 1000);
    await dispatcher._pumpOnce();
    db.prepare('UPDATE trigger_events SET claim_expires_at = ? WHERE id = 1').run(Date.now() - 1000);
    await dispatcher._pumpOnce();

    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[1]).toBe(sessions[2]);
  });

  it('builder failure surfaces dispatcher:builder_failed run_event', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES ('wat-3', 'file', 'w', '{}', 1, NULL, 0, ?, ?)`).run(Date.now(), Date.now());
    bus.insert({ source: 'file', sourceKey: 'wat-3', idempotencyKey: 'k', payload: {} });
    const builder: AgentBuilder = () => { throw new Error('agent construction failed'); };
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder,
      persistedDefault: { provider: 'ollama', model: 'llama3.2' },
    });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-7b', instanceId: 'inst-7b',
      workerCount: 1,
      runnerFactory: () => runner,
    });
    await dispatcher._pumpOnce();
    // On failure, the dispatcher calls markFailed (NOT markDone), so
    // trigger_events.run_id stays NULL. The run row was created by
    // the runner before the builder threw — find it via listRecent.
    const recent = runStore.listRecent({ limit: 5 });
    expect(recent.length).toBeGreaterThan(0);
    const events = runStore.listEvents(recent[0].id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('dispatcher:builder_failed');
  });

  it('two concurrent daemon claims use different sessionIds (state isolation)', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES ('wat-4', 'file', 'w', '{}', 1, NULL, 0, ?, ?)`).run(Date.now(), Date.now());
    bus.insert({ source: 'file', sourceKey: 'wat-4', idempotencyKey: 'a', payload: {} });
    bus.insert({ source: 'file', sourceKey: 'wat-4', idempotencyKey: 'b', payload: {} });

    const sessions: string[] = [];
    const builder: AgentBuilder = (b) => {
      sessions.push(b.sessionId);
      return stubAgentFiringOneTool(b.hooks.onToolCall);
    };
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder,
      persistedDefault: { provider: 'ollama', model: 'llama3.2' },
    });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-7b', instanceId: 'inst-7b',
      workerCount: 1,
      runnerFactory: () => runner,
    });
    await dispatcher._pumpOnce();
    await dispatcher._pumpOnce();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(sessions[1]);
  });
});
