/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Workbench Phase 1 — the read-only event-stream bridge.
 *
 * Proves a browser (here, a raw SSE client) receives (a) the ordered REPLAY of a
 * session's run_events, then (b) NEW events live as they are written — including
 * the artifact_verified verdict — all from the shared run store the CLI writes
 * to. No agent, no UI: just events flowing to a client.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';

// ── A tiny SSE client: connects, parses frames, lets tests await events ───────
interface SseFrame { id?: string; event?: string; data: any }

function sseClient(port: number, path: string): {
  frames: SseFrame[];
  waitFor: (pred: (f: SseFrame) => boolean, ms?: number) => Promise<SseFrame>;
  close: () => void;
} {
  const frames: SseFrame[] = [];
  const waiters: Array<{ pred: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }> = [];
  let buf = '';
  const req = http.get(
    { host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream' } },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (raw.startsWith(':')) continue;                 // keepalive comment
          const f: SseFrame = { data: undefined };
          for (const line of raw.split('\n')) {
            if (line.startsWith('id:')) f.id = line.slice(3).trim();
            else if (line.startsWith('event:')) f.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              const d = line.slice(5).trim();
              try { f.data = JSON.parse(d); } catch { f.data = d; }
            }
          }
          if (f.data !== undefined) {
            frames.push(f);
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
            }
          }
        }
      });
    },
  );
  req.on('error', () => { /* closed by test */ });
  return {
    frames,
    waitFor: (pred, ms = 3000) => new Promise<SseFrame>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) { resolve(hit); return; }
      const t = setTimeout(() => reject(new Error('SSE waitFor timeout')), ms);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
    }),
    close: () => req.destroy(),
  };
}

let db: Database.Database;
let runStore: ReturnType<typeof createRunStore>;
let runId: number;
let bridge: WorkbenchBridge;
const SESSION = 'sess-workbench';

function emit(name: string, kind: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): number {
  return runStore.emitEventRich({ runId, sessionId: SESSION, category: 'test', kind, name, payload, ...extra });
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('inst-1', 1, 'h', Date.now(), Date.now(), '4.14.5');
  runStore = createRunStore({ db });
  runId = runStore.create({ sessionId: SESSION, instanceId: 'inst-1', status: 'running' });
  bridge = await startWorkbenchBridge({ reader: runStore, port: 0, pollMs: 30 });
});

afterEach(async () => {
  await bridge.close();
  try { db.close(); } catch { /* noop */ }
});

describe('Workbench bridge — health + shape', () => {
  it('binds loopback and answers /api/health', async () => {
    const body = await new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port: bridge.port, path: '/api/health' }, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b));
      });
    });
    expect(bridge.host).toBe('127.0.0.1');
    expect(JSON.parse(body)).toMatchObject({ ok: true, service: 'aiden-workbench-bridge', readOnly: true });
  });

  it('rejects non-GET (read-only)', async () => {
    const code = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/api/health', method: 'POST' }, (res) => {
        res.resume(); resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(code).toBe(405);
  });
});

describe('Workbench bridge — ordered replay + live tail', () => {
  it('★ replays existing session events oldest-first by row id', async () => {
    const id1 = emit('ui_task_update', 'task.update', { step: 1 });
    const id2 = emit('tool_call_started', 'tool.call.started', { toolName: 'file_read' });
    const id3 = emit('tool_call_completed', 'tool.call.completed', { toolName: 'file_read', hasResult: true });

    const c = sseClient(bridge.port, `/api/sessions/${SESSION}/events`);
    await c.waitFor((f) => Number(f.id) === id3);
    expect(c.frames.map((f) => Number(f.id))).toEqual([id1, id2, id3]);   // ascending, no gaps
    c.close();
  });

  it('★ streams NEW events live after the replay', async () => {
    const id1 = emit('ui_task_update', 'task.update', { step: 1 });
    const c = sseClient(bridge.port, `/api/sessions/${SESSION}/events`);
    await c.waitFor((f) => Number(f.id) === id1);           // replay drained

    const idLive = emit('ui_task_done', 'task.done', { status: 'completed' });
    const live = await c.waitFor((f) => Number(f.id) === idLive);
    expect(live.data.name).toBe('ui_task_done');
    expect(live.data.payload).toEqual({ status: 'completed' });
    c.close();
  });

  it('★ carries the artifact_verified verdict (verified/unverified proof) to the client', async () => {
    const c = sseClient(bridge.port, `/api/sessions/${SESSION}/events`);
    const idV = emit('artifact_verified', 'artifact.verified', { verdict: 'completed', verified: true, handles: 2 });
    const ev = await c.waitFor((f) => Number(f.id) === idV);
    expect(ev.event).toBe('artifact_verified');             // SSE event name = emission name
    expect(ev.data.kind).toBe('artifact.verified');
    expect(ev.data.payload).toEqual({ verdict: 'completed', verified: true, handles: 2 });
    c.close();
  });

  it('run-scoped endpoint streams the same rows for that run', async () => {
    const id1 = emit('cost_updated', 'status.cost', { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    const c = sseClient(bridge.port, `/api/runs/${runId}/events`);
    const ev = await c.waitFor((f) => Number(f.id) === id1);
    expect(ev.data.runId).toBe(runId);
    expect(ev.data.payload.totalTokens).toBe(15);
    c.close();
  });

  it('Last-Event-ID resume skips already-seen rows', async () => {
    const id1 = emit('ui_task_update', 'task.update', { step: 1 });
    const id2 = emit('ui_task_update', 'task.update', { step: 2 });
    const resumed = await new Promise<SseFrame>((resolve, reject) => {
      let buf = '';
      const req = http.get(
        { host: '127.0.0.1', port: bridge.port, path: `/api/sessions/${SESSION}/events`,
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(id1) } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buf += chunk;
            const idx = buf.indexOf('\n\n');
            if (idx >= 0) {
              const raw = buf.slice(0, idx);
              const f: SseFrame = { data: undefined };
              for (const line of raw.split('\n')) {
                if (line.startsWith('id:')) f.id = line.slice(3).trim();
                else if (line.startsWith('data:')) { try { f.data = JSON.parse(line.slice(5).trim()); } catch { /* */ } }
              }
              req.destroy(); resolve(f);
            }
          });
        },
      );
      req.on('error', reject);
      setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 3000);
    });
    expect(Number(resumed.id)).toBe(id2);                   // id1 skipped, first frame is id2
  });
});

// ── The dashboard page + the browser feed ────────────────────────────────────

function httpGet(port: number, path: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: b }));
    });
  });
}

describe('Workbench dashboard shell + feed', () => {
  it('GET / serves the dark dashboard SHELL (sidebar + feed, not JSON)', async () => {
    const { status, contentType, body } = await httpGet(bridge.port, '/');
    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/html/);
    expect(body).toContain('<title>Aiden Workbench');
    expect(body).toContain('#FF6B35');                      // the orange identity
    expect(body).toContain('class="sidebar"');              // the Claude-style shell
    expect(body).toContain('id="sessions"');                // recent-sessions list
    expect(body).toContain("fetch('/api/sessions')");       // sidebar data source
    expect(body).toContain("connect('/api/events'");        // live feed wired
    expect(body).not.toContain('"ok":true');                // it's the page, not the health JSON
  });

  it('★ GET /api/events streams recent events as UNNAMED message frames (name is in data)', async () => {
    const c = sseClient(bridge.port, '/api/events');
    const idV = emit('artifact_verified', 'artifact.verified', { verdict: 'completed', verified: true, handles: 1 });
    const f = await c.waitFor((x) => Number(x.id) === idV);
    expect(f.event).toBeUndefined();                        // no SSE event name → one onmessage handles all
    expect(f.data.name).toBe('artifact_verified');
    expect(f.data.payload.verified).toBe(true);
    c.close();
  });

  it('GET /api/sessions returns the readable session list when a lister is wired', async () => {
    const stub = { listSessions: () => [{ id: 'sess-A', label: 'fix the parser', lastActive: 123, provider: 'anthropic', model: 'x' }] };
    const b2 = await startWorkbenchBridge({ reader: runStore, sessions: stub, port: 0, pollMs: 30 });
    const { status, body } = await httpGet(b2.port, '/api/sessions');
    expect(status).toBe(200);
    const list = JSON.parse(body);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'sess-A', label: 'fix the parser' });   // label, never the raw id
    await b2.close();
  });

  it('GET /api/sessions returns [] when no lister is wired', async () => {
    const { status, body } = await httpGet(bridge.port, '/api/sessions');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual([]);
  });
});

// ── The write path — token-gated POST /api/tasks ─────────────────────────────

function httpPost(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); },
    );
    req.write(data); req.end();
  });
}

describe('Workbench write path — token-gated POST /api/tasks', () => {
  const TOKEN = 'secret-token-abc123';
  function withWrite(sent: Array<{ message: string; sessionId?: string }>) {
    const enqueue = { enqueue: (t: { message: string; sessionId?: string }) => { sent.push(t); return { accepted: true, triggerEventId: 7 }; } };
    return startWorkbenchBridge({ reader: runStore, enqueue, token: TOKEN, port: 0, pollMs: 30 });
  }

  it('★ rejects a write with NO token (401); enqueue NOT called', async () => {
    const sent: Array<{ message: string }> = []; const b = await withWrite(sent);
    const r = await httpPost(b.port, '/api/tasks', { message: 'do a thing' });
    expect(r.status).toBe(401);
    expect(sent).toHaveLength(0);
    await b.close();
  });

  it('rejects a write with a WRONG token (401)', async () => {
    const sent: Array<{ message: string }> = []; const b = await withWrite(sent);
    const r = await httpPost(b.port, '/api/tasks', { message: 'x' }, { 'x-workbench-token': 'nope' });
    expect(r.status).toBe(401);
    expect(sent).toHaveLength(0);
    await b.close();
  });

  it('★ WITH the token, enqueues the task onto the job path (202)', async () => {
    const sent: Array<{ message: string; sessionId?: string }> = []; const b = await withWrite(sent);
    const r = await httpPost(b.port, '/api/tasks', { message: 'read the readme' }, { 'x-workbench-token': TOKEN });
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body)).toMatchObject({ accepted: true, triggerEventId: 7 });
    expect(sent).toEqual([{ message: 'read the readme', sessionId: undefined }]);
    await b.close();
  });

  it('rejects a cross-origin write even WITH the token (403)', async () => {
    const sent: Array<{ message: string }> = []; const b = await withWrite(sent);
    const r = await httpPost(b.port, '/api/tasks', { message: 'x' }, { 'x-workbench-token': TOKEN, Origin: 'http://evil.example.com' });
    expect(r.status).toBe(403);
    expect(sent).toHaveLength(0);
    await b.close();
  });

  it('write is DISABLED when no token is configured (503)', async () => {
    const r = await httpPost(bridge.port, '/api/tasks', { message: 'x' }, { 'x-workbench-token': 'anything' });
    expect(r.status).toBe(503);                              // beforeEach bridge has no token
  });

  it('the token is injected into the served page (placeholder replaced)', async () => {
    const b = await startWorkbenchBridge({ reader: runStore, token: TOKEN, port: 0 });
    const { body } = await httpGet(b.port, '/');
    expect(body).toContain("window.__WB_TOKEN__ = '" + TOKEN + "'");
    expect(body).not.toContain('__WORKBENCH_TOKEN__');       // placeholder gone
    await b.close();
  });

  it('the page has the chat composer, posts to /api/tasks, and surfaces auto-denial', async () => {
    const { body } = await httpGet(bridge.port, '/');
    expect(body).toContain('id="composer"');
    expect(body).toContain("fetch('/api/tasks'");
    expect(body).toContain('x-workbench-token');
    expect(body).toContain('auto-denied');                   // clear "needs approval — auto-denied" surfacing
  });
});
