import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SessionStore } from '../../core/v4/sessionStore';

let tmpDir: string;
let dbPath: string;
let store: SessionStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-sstore-'));
  dbPath = path.join(tmpDir, 'sessions.db');
  store = new SessionStore(dbPath);
});

afterEach(async () => {
  try {
    store.close();
  } catch {
    // already closed
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('1. createSession returns a populated record with timestamps and id', () => {
    const before = Date.now();
    const s = store.createSession({
      title: 'first',
      providerId: 'groq',
      modelId: 'llama-3.3-70b',
    });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.title).toBe('first');
    expect(s.providerId).toBe('groq');
    expect(s.modelId).toBe('llama-3.3-70b');
    expect(s.totalInputTokens).toBe(0);
    expect(s.totalOutputTokens).toBe(0);
    expect(s.createdAt).toBeGreaterThanOrEqual(before);
    expect(s.updatedAt).toBe(s.createdAt);
  });

  it('2. appendMessage persists messages and getMessages returns them in order', () => {
    const s = store.createSession({ title: 'order' });
    store.appendMessage(s.id, { role: 'system', content: 'You are Aiden' });
    store.appendMessage(s.id, { role: 'user', content: 'hello' });
    store.appendMessage(s.id, { role: 'assistant', content: 'hi there' });
    const msgs = store.getMessages(s.id);
    expect(msgs.length).toBe(3);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(msgs.map((m) => m.content)).toEqual(['You are Aiden', 'hello', 'hi there']);
    expect(msgs[0].id < msgs[1].id).toBe(true);
    expect(msgs[1].id < msgs[2].id).toBe(true);
  });

  it('2b. ensureSession preserves browser-owned ids and is idempotent', () => {
    const first = store.ensureSession('session_workbench_exact', { title: 'Workbench task' });
    const second = store.ensureSession('session_workbench_exact', { title: 'changed title' });
    expect(first.id).toBe('session_workbench_exact');
    expect(second).toEqual(first);
    expect(store.listSessions().filter((session) => session.id === first.id)).toHaveLength(1);
  });

  it('3. appendMessage round-trips toolCalls JSON', () => {
    const s = store.createSession();
    store.appendMessage(s.id, {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'shell_exec', arguments: { cmd: 'ls' } },
      ],
    });
    store.appendMessage(s.id, {
      role: 'tool',
      content: 'file1\nfile2',
      toolCallId: 'call_1',
    });
    const msgs = store.getMessages(s.id);
    expect(msgs[0].toolCalls).not.toBeNull();
    expect(msgs[0].toolCalls![0].name).toBe('shell_exec');
    expect(msgs[0].toolCalls![0].arguments).toEqual({ cmd: 'ls' });
    expect(msgs[1].toolCallId).toBe('call_1');
  });

  it('4. search finds keyword matches in message content', () => {
    const s = store.createSession({ title: 'docker chat' });
    store.appendMessage(s.id, { role: 'user', content: 'How do I deploy via docker?' });
    store.appendMessage(s.id, { role: 'assistant', content: 'Use docker compose up.' });
    store.appendMessage(s.id, { role: 'user', content: 'thanks' });
    const results = store.search('docker');
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].sessionId).toBe(s.id);
    expect(results[0].matchedContent).toMatch(/>>>.*docker.*<<</i);
    expect(results[0].title).toBe('docker chat');
  });

  it('5. search returns [] for queries with no matches', () => {
    const s = store.createSession();
    store.appendMessage(s.id, { role: 'user', content: 'hello world' });
    expect(store.search('nonexistentterm')).toEqual([]);
    expect(store.search('   ')).toEqual([]);
    expect(store.search('')).toEqual([]);
  });

  it('6. updateSession persists title and provider/model swaps', () => {
    const s = store.createSession({ title: 'old' });
    store.updateSession(s.id, {
      title: 'renamed',
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
    const fresh = store.getSession(s.id);
    expect(fresh!.title).toBe('renamed');
    expect(fresh!.providerId).toBe('anthropic');
    expect(fresh!.modelId).toBe('claude-opus-4-7');
    expect(fresh!.updatedAt).toBeGreaterThanOrEqual(s.updatedAt);
  });

  it('7. deleteSession cascades to messages via FK', () => {
    const s = store.createSession();
    store.appendMessage(s.id, { role: 'user', content: 'a' });
    store.appendMessage(s.id, { role: 'user', content: 'b' });
    expect(store.getMessages(s.id).length).toBe(2);
    store.deleteSession(s.id);
    expect(store.getSession(s.id)).toBeNull();
    expect(store.getMessages(s.id)).toEqual([]);
  });

  it('8. listSessions sorts by updated_at desc by default', async () => {
    const a = store.createSession({ title: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.createSession({ title: 'b' });
    await new Promise((r) => setTimeout(r, 5));
    store.appendMessage(a.id, { role: 'user', content: 'touch a' });
    const list = store.listSessions();
    expect(list[0].id).toBe(a.id);
    expect(list[1].id).toBe(b.id);
  });

  it('9. listSessions(orderBy=created) sorts by creation order', async () => {
    const a = store.createSession({ title: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.createSession({ title: 'b' });
    store.appendMessage(a.id, { role: 'user', content: 'touch a' });
    const list = store.listSessions({ orderBy: 'created' });
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it('10. multi-session isolation: search and getMessages do not bleed across sessions', () => {
    const a = store.createSession({ title: 'session-A' });
    const b = store.createSession({ title: 'session-B' });
    store.appendMessage(a.id, { role: 'user', content: 'apple banana' });
    store.appendMessage(b.id, { role: 'user', content: 'cherry date' });
    expect(store.getMessages(a.id).length).toBe(1);
    expect(store.getMessages(b.id).length).toBe(1);
    const results = store.search('banana');
    expect(results.every((r) => r.sessionId === a.id)).toBe(true);
  });

  it('11. addTokenUsage accumulates across calls', () => {
    const s = store.createSession();
    store.addTokenUsage(s.id, 100, 50);
    store.addTokenUsage(s.id, 30, 20);
    const fresh = store.getSession(s.id);
    expect(fresh!.totalInputTokens).toBe(130);
    expect(fresh!.totalOutputTokens).toBe(70);
  });

  it('12. DB persists across close/reopen', () => {
    const s = store.createSession({ title: 'persisted' });
    store.appendMessage(s.id, { role: 'user', content: 'durable content' });
    store.close();

    const reopened = new SessionStore(dbPath);
    try {
      const fresh = reopened.getSession(s.id);
      expect(fresh).not.toBeNull();
      expect(fresh!.title).toBe('persisted');
      const msgs = reopened.getMessages(s.id);
      expect(msgs.length).toBe(1);
      expect(msgs[0].content).toBe('durable content');
      expect(reopened.search('durable').length).toBeGreaterThanOrEqual(1);
    } finally {
      reopened.close();
    }
  });

  it('13. search sanitises FTS5 special characters without throwing', () => {
    const s = store.createSession();
    store.appendMessage(s.id, { role: 'user', content: 'parens (in) text' });
    expect(() => store.search('(((')).not.toThrow();
    expect(() => store.search('AND')).not.toThrow();
    expect(() => store.search('"unbalanced')).not.toThrow();
  });
});
