import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SessionStore } from '../../core/v4/sessionStore';
import { SessionManager } from '../../core/v4/sessionManager';
import type { Message } from '../../providers/v4/types';

let tmpDir: string;
let store: SessionStore;
let mgr: SessionManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-smgr-'));
  store = new SessionStore(path.join(tmpDir, 'sessions.db'));
  mgr = new SessionManager(store);
});

afterEach(async () => {
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('1. startSession creates a new session when title is unique', () => {
    const s = mgr.startSession({
      title: 'first',
      providerId: 'groq',
      modelId: 'llama-3.3',
    });
    expect(s.title).toBe('first');
    expect(s.providerId).toBe('groq');
    expect(store.listSessions().length).toBe(1);
  });

  it('2. startSession resumes by exact title and updates provider/model', async () => {
    const a = mgr.startSession({
      title: 'work',
      providerId: 'groq',
      modelId: 'llama-3.3',
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = mgr.startSession({
      title: 'work',
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
    expect(b.id).toBe(a.id);
    expect(b.providerId).toBe('anthropic');
    expect(b.modelId).toBe('claude-opus-4-7');
    expect(store.listSessions().length).toBe(1);
  });

  it('3. resumeLatest returns the most recently updated session', async () => {
    const a = mgr.startSession({ providerId: 'p', modelId: 'm' });
    await new Promise((r) => setTimeout(r, 5));
    const b = mgr.startSession({ providerId: 'p', modelId: 'm' });
    await new Promise((r) => setTimeout(r, 5));
    mgr.recordTurn(a.id, [{ role: 'user', content: 'touch a' }], {
      inputTokens: 0,
      outputTokens: 0,
    });
    const latest = mgr.resumeLatest();
    expect(latest!.id).toBe(a.id);
    expect(b.id).not.toBe(latest!.id);
  });

  it('4. resumeLatest returns null when no sessions exist', () => {
    expect(mgr.resumeLatest()).toBeNull();
  });

  it('5. resumeById finds a session by exact UUID', () => {
    const s = mgr.startSession({ providerId: 'p', modelId: 'm' });
    const found = mgr.resumeById(s.id);
    expect(found!.id).toBe(s.id);
  });

  it('6. resumeById finds a session by partial (case-insensitive) title', () => {
    const s = mgr.startSession({
      title: 'My Cool Project',
      providerId: 'p',
      modelId: 'm',
    });
    const found = mgr.resumeById('cool');
    expect(found!.id).toBe(s.id);
  });

  it('7. resumeById returns null when no session matches', () => {
    mgr.startSession({ title: 'one', providerId: 'p', modelId: 'm' });
    expect(mgr.resumeById('nonexistent-zzz')).toBeNull();
    expect(mgr.resumeById('')).toBeNull();
    expect(mgr.resumeById('   ')).toBeNull();
  });

  it('8. recordTurn persists messages and accumulates tokens', () => {
    const s = mgr.startSession({ providerId: 'p', modelId: 'm' });
    const turn1: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    mgr.recordTurn(s.id, turn1, { inputTokens: 10, outputTokens: 5 }, 1);
    const turn2: Message[] = [
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'sure' },
    ];
    mgr.recordTurn(s.id, turn2, { inputTokens: 20, outputTokens: 8 }, 2);
    const fresh = store.getSession(s.id);
    expect(fresh!.totalInputTokens).toBe(30);
    expect(fresh!.totalOutputTokens).toBe(13);
    const msgs = store.getMessages(s.id);
    expect(msgs.length).toBe(4);
    expect(msgs[0].turnNumber).toBe(1);
    expect(msgs[3].turnNumber).toBe(2);
  });

  it('9. search delegates to store FTS5 across multiple sessions', () => {
    const a = mgr.startSession({
      title: 'docker chat',
      providerId: 'p',
      modelId: 'm',
    });
    const b = mgr.startSession({
      title: 'k8s chat',
      providerId: 'p',
      modelId: 'm',
    });
    mgr.recordTurn(
      a.id,
      [{ role: 'user', content: 'how do I deploy via docker compose?' }],
      { inputTokens: 0, outputTokens: 0 },
    );
    mgr.recordTurn(
      b.id,
      [{ role: 'user', content: 'kubernetes pod scheduling' }],
      { inputTokens: 0, outputTokens: 0 },
    );
    const hits = mgr.search('docker');
    expect(hits.length).toBe(1);
    expect(hits[0].sessionId).toBe(a.id);
  });

  it('10. tool messages round-trip through recordTurn with toolCallId', () => {
    const s = mgr.startSession({ providerId: 'p', modelId: 'm' });
    const turn: Message[] = [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'shell_exec', arguments: { cmd: 'ls' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'a.txt b.txt' },
      { role: 'assistant', content: 'two files' },
    ];
    mgr.recordTurn(s.id, turn, { inputTokens: 12, outputTokens: 6 });
    const msgs = store.getMessages(s.id);
    expect(msgs.length).toBe(4);
    expect(msgs[1].toolCalls?.[0].name).toBe('shell_exec');
    expect(msgs[2].toolCallId).toBe('c1');
  });

  it('11. lifecycle end-to-end: start → record → resume → search', () => {
    const s = mgr.startSession({
      title: 'integration',
      providerId: 'p',
      modelId: 'm',
    });
    mgr.recordTurn(
      s.id,
      [
        { role: 'user', content: 'remember this pineapple' },
        { role: 'assistant', content: 'noted' },
      ],
      { inputTokens: 5, outputTokens: 3 },
    );
    const resumed = mgr.resumeLatest();
    expect(resumed!.id).toBe(s.id);
    const hits = mgr.search('pineapple');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].sessionId).toBe(s.id);
  });

  it('persists active compressed history and cumulative state across restart', () => {
    const s = mgr.startSession({ providerId: 'p', modelId: 'm' });
    const rawTurn: Message[] = [
      { role: 'user', content: 'latest instruction' },
      { role: 'assistant', content: 'done' },
    ];
    const active: Message[] = [
      { role: 'system', content: 'active safety rules' },
      { role: 'assistant', content: 'Summary of older history' },
      ...rawTurn,
    ];
    mgr.recordTurn(s.id, rawTurn, { inputTokens: 21, outputTokens: 8 }, 3, {
      messages: active,
      compressionCount: 2,
      cumulativeUsage: { inputTokens: 121, outputTokens: 48 },
      budgetState: { state: 'running_yellow', tokenBudget: 200 },
    });

    store.close();
    store = new SessionStore(path.join(tmpDir, 'sessions.db'));
    mgr = new SessionManager(store);
    expect(mgr.resumeActiveState(s.id)).toEqual({
      messages: active,
      compressionCount: 2,
      cumulativeUsage: { inputTokens: 121, outputTokens: 48 },
      budgetState: { state: 'running_yellow', tokenBudget: 200 },
    });
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual([
      'latest instruction',
      'done',
    ]);
  });
});
