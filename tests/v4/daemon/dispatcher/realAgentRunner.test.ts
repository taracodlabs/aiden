/**
 * v4.5 Phase 7 — realAgentRunner integration tests.
 *
 * Uses a STUB AidenAgent (just enough to satisfy the AgentBuilder
 * contract). Verifies that the runner:
 *   1. Builds the agent via the injected builder with correct context
 *   2. Emits dispatcher:invoked + dispatcher:completed run_events
 *   3. Captures finishReason from the agent's result
 *   4. Rejects pre-turn when daily budget exhausted (trigger_quota)
 *   5. Surfaces tool_call_started + tool_call_completed via the hooks
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createRunStore } from '../../../../core/v4/daemon/runStore';
import {
  createRealAgentRunner,
} from '../../../../core/v4/daemon/dispatcher/realAgentRunner';
import type {
  AgentBuilder,
} from '../../../../core/v4/daemon/dispatcher/realAgentRunner';
import type {
  DaemonAgentInput,
} from '../../../../core/v4/daemon/dispatcher/agentRunner';
import type { AidenAgent, AidenAgentResult } from '../../../../core/v4/aidenAgent';

let db: Database.Database;
let runStore: ReturnType<typeof createRunStore>;
const PERSISTED = { provider: 'ollama', model: 'llama3.2' };

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-1', 1, 'h', Date.now(), Date.now(), '4.5.0');
  runStore = createRunStore({ db });
  delete process.env.AIDEN_DAEMON_DAILY_BUDGET;
  delete process.env.AIDEN_DAEMON_MODEL;
});
afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  delete process.env.AIDEN_DAEMON_DAILY_BUDGET;
  delete process.env.AIDEN_DAEMON_MODEL;
});

function mkInput(over: Partial<DaemonAgentInput> = {}): DaemonAgentInput {
  return {
    sessionId:      'trigger:file:t1:abc',
    instanceId:     'inst-1',
    triggerEventId: 1,
    triggerContext: {
      triggerId:      't1',
      source:         'file',
      sourceKey:      't1',
      fireReason:     'fs.modified',
      eventId:        1,
      attempt:        1,
      maxAttempts:    3,
      promptTemplate: null,
    },
    initialMessage: 'Hello',
    deliverOnly:    false,
    ...over,
  };
}

function stubAgent(result: AidenAgentResult | Error): AidenAgent {
  return {
    runConversation: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as AidenAgent;
}

function mkResult(over: Partial<{ finishReason: string; usage: { totalTokens: number } }> = {}): AidenAgentResult {
  return {
    finishReason: 'stop',
    ...over,
  } as unknown as AidenAgentResult;
}

describe('createRealAgentRunner — builder invocation', () => {
  it('calls builder with sessionId + resolvedModel + approvalPolicy', async () => {
    const seen: { sessionId?: string; provider?: string; model?: string; policy?: string } = {};
    const builder: AgentBuilder = (b) => {
      seen.sessionId = b.sessionId;
      seen.provider  = b.resolvedModel.provider;
      seen.model     = b.resolvedModel.model;
      seen.policy    = b.approvalPolicy;
      return stubAgent(mkResult({ finishReason: 'stop' }));
    };
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
    });
    const result = await runner.invoke(mkInput());
    expect(seen.sessionId).toBe('trigger:file:t1:abc');
    expect(seen.provider).toBe('ollama');
    expect(seen.model).toBe('llama3.2');
    expect(seen.policy).toBe('safe-only');     // default
    expect(result.finishReason).toBe('stop');
  });

  it('reads trigger spec for model + approval override', async () => {
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      't1', 'file', 'mytrig',
      JSON.stringify({ provider: 'groq', model: 'llama-3.1-70b', daemonApproval: 'caution-ok' }),
      1, null, 0, Date.now(), Date.now(),
    );
    const seen: { provider?: string; model?: string; policy?: string } = {};
    const builder: AgentBuilder = (b) => {
      seen.provider = b.resolvedModel.provider;
      seen.model    = b.resolvedModel.model;
      seen.policy   = b.approvalPolicy;
      return stubAgent(mkResult());
    };
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
    });
    await runner.invoke(mkInput());
    expect(seen.provider).toBe('groq');
    expect(seen.model).toBe('llama-3.1-70b');
    expect(seen.policy).toBe('caution-ok');
  });
});

describe('createRealAgentRunner — event emission', () => {
  it('emits dispatcher:invoked + dispatcher:completed', async () => {
    const builder: AgentBuilder = () => stubAgent(mkResult({ finishReason: 'stop' }));
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
    });
    const result = await runner.invoke(mkInput());
    // v4.10 Slice 10.2b — assert on `name` (the original emission
    // identifier, preserved unchanged) rather than `kind` (now the
    // dotted taxonomy form, e.g. 'dispatcher.invoked').
    const events = runStore.listEvents(result.runId);
    const names = events.map((e) => e.name);
    expect(names).toContain('dispatcher:invoked');
    expect(names).toContain('dispatcher:completed');
    const invoked = JSON.parse(events.find((e) => e.name === 'dispatcher:invoked')!.payload);
    expect(invoked.model).toBe('llama3.2');
    expect(invoked.modelSource).toBe('persisted');
    expect(invoked.approvalPolicy).toBe('safe-only');
    expect(invoked.source).toBe('file');
    const completed = JSON.parse(events.find((e) => e.name === 'dispatcher:completed')!.payload);
    expect(completed.finishReason).toBe('stop');
  });

  it('forwards onToolCall hook to tool_call_started/completed events', async () => {
    let hooks: Parameters<AgentBuilder>[0]['hooks'] | null = null;
    const builder: AgentBuilder = (b) => {
      hooks = b.hooks;
      return stubAgent(mkResult());
    };
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
    });
    const result = await runner.invoke(mkInput());
    expect(hooks).not.toBeNull();
    // Fire the hooks the way AidenAgent does.
    hooks!.onToolCall(
      { id: 't', name: 'file_read', arguments: { path: '/x' } },
      'before',
    );
    hooks!.onToolCall(
      { id: 't', name: 'file_read', arguments: { path: '/x' } },
      'after',
      { id: 't', name: 'file_read', result: { ok: true } },
    );
    // v4.10 Slice 10.2b — assert on `name` (stable emitter id).
    const events = runStore.listEvents(result.runId);
    const names = events.map((e) => e.name);
    expect(names).toContain('tool_call_started');
    expect(names).toContain('tool_call_completed');
  });

  it('emits assistant_message carrying the agent\'s finalContent (the chat reply)', async () => {
    const builder: AgentBuilder = () =>
      stubAgent({ finishReason: 'stop', finalContent: 'Hello! How can I help?' } as unknown as AidenAgentResult);
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
    });
    const result = await runner.invoke(mkInput());
    const events = runStore.listEvents(result.runId);
    const reply = events.find((e) => e.name === 'assistant_message');
    expect(reply).toBeTruthy();
    expect(JSON.parse(reply!.payload).text).toBe('Hello! How can I help?');
  });

  it('emits NO assistant_message when the agent produced no written text', async () => {
    const builder: AgentBuilder = () => stubAgent(mkResult({ finishReason: 'stop' }));
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
    });
    const result = await runner.invoke(mkInput());
    const events = runStore.listEvents(result.runId);
    expect(events.some((e) => e.name === 'assistant_message')).toBe(false);
  });
});

describe('createRealAgentRunner — failure paths', () => {
  it('rejects pre-turn when daily budget exhausted', async () => {
    // Pre-seed budget exhaustion via direct row insert.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO idempotency_keys
      (scope, key, fingerprint, response_json, status_code, created_at, expires_at)
      VALUES (?, ?, NULL, ?, 200, ?, ?)`).run(
      'daemon_budget', today, JSON.stringify({ used: 100 }), Date.now(), Date.now() + 86_400_000,
    );
    let builderCalled = false;
    const builder: AgentBuilder = () => { builderCalled = true; return stubAgent(mkResult()); };
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
      dailyBudget: 100,
    });
    const result = await runner.invoke(mkInput());
    expect(builderCalled).toBe(false);   // pre-turn gate rejected
    expect(result.finishReason).toBe('error');
    expect(result.error).toMatch(/trigger_quota/);
    const events = runStore.listEvents(result.runId);
    expect(events.some((e) => e.name === 'dispatcher:rejected')).toBe(true);
  });

  it('captures invocation error → finishReason: error', async () => {
    const builder: AgentBuilder = () => stubAgent(new Error('boom'));
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
    });
    const result = await runner.invoke(mkInput());
    expect(result.finishReason).toBe('error');
    expect(result.error).toMatch(/boom/);
    const events = runStore.listEvents(result.runId);
    const completed = events.find((e) => e.name === 'dispatcher:completed');
    expect(completed).toBeTruthy();
    const c = JSON.parse(completed!.payload);
    expect(c.finishReason).toBe('error');
    expect(c.invocationError).toMatch(/boom/);
  });

  it('builder throws → dispatcher:builder_failed run_event', async () => {
    const builder: AgentBuilder = () => { throw new Error('cannot construct agent'); };
    const runner = createRealAgentRunner({
      db, runStore, agentBuilder: builder, persistedDefault: PERSISTED,
    });
    const result = await runner.invoke(mkInput());
    expect(result.finishReason).toBe('error');
    expect(result.error).toMatch(/cannot construct agent/);
    const events = runStore.listEvents(result.runId);
    expect(events.some((e) => e.name === 'dispatcher:builder_failed')).toBe(true);
  });
});
