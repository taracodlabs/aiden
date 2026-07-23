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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    const outcome = { kind: 'verified', handles: [{ tool: 'file_write', kind: 'path', value: '/x', verified: true }] };
    const idV = emit('artifact_verified', 'artifact.verified', { verdict: 'completed', outcome, handles: 2 });
    const ev = await c.waitFor((f) => Number(f.id) === idV);
    expect(ev.event).toBe('artifact_verified');             // SSE event name = emission name
    expect(ev.data.kind).toBe('artifact.verified');
    expect(ev.data.payload).toEqual({ verdict: 'completed', outcome, handles: 2 });
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
    expect(body).toContain('class="sidebar"');              // the single-column shell
    expect(body).toContain('id="sessions"');                // recent-sessions list
    expect(body).toContain("fetch('/api/sessions')");       // sidebar data source
    expect(body).toContain("connect('/api/events'");        // live feed wired
    expect(body).not.toContain('"ok":true');                // it's the page, not the health JSON
  });

  it('★ GET /api/events streams recent events as UNNAMED message frames (name is in data)', async () => {
    const c = sseClient(bridge.port, '/api/events');
    const idV = emit('artifact_verified', 'artifact.verified', { verdict: 'completed', outcome: { kind: 'verified', handles: [{ tool: 'file_write', kind: 'path', value: '/x', verified: true }] }, handles: 1 });
    const f = await c.waitFor((x) => Number(x.id) === idV);
    expect(f.event).toBeUndefined();                        // no SSE event name → one onmessage handles all
    expect(f.data.name).toBe('artifact_verified');
    expect(f.data.payload.outcome.kind).toBe('verified');
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

  it('★ strips bracketed-paste markers at the ingest boundary; multi-line preserved (B4)', async () => {
    const sent: Array<{ message: string; sessionId?: string }> = []; const b = await withWrite(sent);
    // A pasted, MULTI-LINE message carrying ESC[200~ / ESC[201~ plus an
    // ESC-stripped `[200~` leftover — the exact shape that leaked into stored
    // session labels.
    const pasted = '\x1b[200~line one\nline two\x1b[201~[200~ tail';
    const r = await httpPost(b.port, '/api/tasks', { message: pasted }, { 'x-workbench-token': TOKEN });
    expect(r.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe('line one\nline two tail');   // markers gone, BOTH lines kept
    expect(sent[0].message).not.toMatch(/20[01]~/);
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

// ── The steer path — token-gated POST /api/tasks/:runId/cancel ────────────────

describe('Workbench steer — token-gated POST /api/tasks/:runId/cancel', () => {
  const TOKEN = 'secret-token-abc123';
  const enq = { enqueue: () => ({ accepted: true, triggerEventId: 1 }) };
  function withCancel(calls: number[]) {
    const cancel = { cancel: (id: number) => { calls.push(id); return { accepted: true, runId: id }; } };
    return startWorkbenchBridge({ reader: runStore, enqueue: enq, cancel, token: TOKEN, port: 0, pollMs: 30 });
  }

  it('★ rejects a stop with NO token (401); canceller NOT called', async () => {
    const calls: number[] = []; const b = await withCancel(calls);
    const r = await httpPost(b.port, `/api/tasks/${runId}/cancel`, {});
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
    await b.close();
  });

  it('★ WITH the token, stops the run (202) and calls the canceller with the runId', async () => {
    const calls: number[] = []; const b = await withCancel(calls);
    const r = await httpPost(b.port, `/api/tasks/${runId}/cancel`, {}, { 'x-workbench-token': TOKEN });
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body)).toMatchObject({ accepted: true, runId });
    expect(calls).toEqual([runId]);
    await b.close();
  });

  it('rejects a cross-origin stop even WITH the token (403)', async () => {
    const calls: number[] = []; const b = await withCancel(calls);
    const r = await httpPost(b.port, `/api/tasks/${runId}/cancel`, {}, { 'x-workbench-token': TOKEN, Origin: 'http://evil.example.com' });
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
    await b.close();
  });

  it('stop is DISABLED when no canceller is wired (503)', async () => {
    const b = await startWorkbenchBridge({ reader: runStore, enqueue: enq, token: TOKEN, port: 0 });
    const r = await httpPost(b.port, `/api/tasks/${runId}/cancel`, {}, { 'x-workbench-token': TOKEN });
    expect(r.status).toBe(503);
    await b.close();
  });

  it('★ a real runStore-backed stop marks the run cancelled + surfaces task_cancelled in the feed', async () => {
    // The exact port `aiden web` wires: setStatus('cancelled') + a feed event.
    const canceller = {
      cancel: (id: number) => {
        runStore.setStatus(id, 'cancelled', { finishReason: 'stopped from workbench web' });
        runStore.emitEvent(id, 'task_cancelled', { source: 'workbench-web', reason: 'stopped from dashboard' });
        return { accepted: true, runId: id };
      },
    };
    const b = await startWorkbenchBridge({ reader: runStore, enqueue: enq, cancel: canceller, token: TOKEN, port: 0 });
    const r = await httpPost(b.port, `/api/tasks/${runId}/cancel`, {}, { 'x-workbench-token': TOKEN });
    expect(r.status).toBe(202);
    expect(runStore.get(runId)?.status).toBe('cancelled');   // durably stopped
    const evs = runStore.listEventsScoped({ scope: 'run_id', runId, limit: 100 });
    expect(evs.some((e) => e.kind === 'task_cancelled')).toBe(true);   // shown in the live feed
    await b.close();
  });

  it('the page has a Stop control that posts to /cancel', async () => {
    const { body } = await httpGet(bridge.port, '/');
    expect(body).toContain('id="composer-stop"');
    expect(body).toContain("'/api/tasks/' + encodeURIComponent(id) + '/cancel'");
    expect(body).toContain('task_cancelled');                // the feed renders the stop
  });
});

describe('Workbench durable input, pause, resume, and approval commands', () => {
  const TOKEN = 'durable-command-token';

  it('routes every command through its injected durable authority port', async () => {
    const calls: string[] = [];
    const b = await startWorkbenchBridge({
      reader: runStore,
      token: TOKEN,
      input: {
        receive: (id, content, key) => {
          calls.push(`input:${id}:${content}:${key}`);
          return { accepted: true, runId: id, inputId: 'input_exact' };
        },
      },
      control: {
        pause: (id, key) => {
          calls.push(`pause:${id}:${key}`);
          return { accepted: true, applied: false, runId: id, controlId: 'pause_exact' };
        },
        resume: (id, key) => {
          calls.push(`resume:${id}:${key}`);
          return { accepted: true, runId: id, attemptId: 'attempt_new', generation: 2 };
        },
      },
      approval: {
        decide: (id, decision) => {
          calls.push(`approval:${id}:${decision}`);
          return { accepted: true, approvalId: id, state: decision };
        },
      },
      port: 0,
    });
    const headers = { 'x-workbench-token': TOKEN };

    expect((await httpPost(b.port, `/api/tasks/${runId}/input`, {
      message: 'next exact input', idempotencyKey: 'input-key',
    }, headers)).status).toBe(202);
    expect((await httpPost(b.port, `/api/tasks/${runId}/pause`, {
      idempotencyKey: 'pause-key',
    }, headers)).status).toBe(202);
    expect((await httpPost(b.port, `/api/tasks/${runId}/resume`, {
      idempotencyKey: 'resume-key',
    }, headers)).status).toBe(202);
    expect((await httpPost(b.port, '/api/approvals/approval_exact/decision', {
      decision: 'approved',
    }, headers)).status).toBe(202);

    expect(calls).toEqual([
      `input:${runId}:next exact input:input-key`,
      `pause:${runId}:pause-key`,
      `resume:${runId}:resume-key`,
      'approval:approval_exact:approved',
    ]);
    await b.close();
  });

  it('does not treat ordinary input as an approval decision', async () => {
    const approvals: string[] = [];
    const b = await startWorkbenchBridge({
      reader: runStore,
      token: TOKEN,
      input: { receive: (id) => ({ accepted: true, runId: id, inputId: 'input_yes' }) },
      approval: {
        decide: (id, decision) => {
          approvals.push(`${id}:${decision}`);
          return { accepted: true, approvalId: id, state: decision };
        },
      },
      port: 0,
    });
    const response = await httpPost(b.port, `/api/tasks/${runId}/input`, { message: 'yes' }, {
      'x-workbench-token': TOKEN,
    });
    expect(response.status).toBe(202);
    expect(approvals).toEqual([]);
    await b.close();
  });
});

describe('Workbench durable Job projections', () => {
  it('queries Job and Attempt identity and replays events from a Job sequence cursor', async () => {
    const jobs = {
      getJob: (id: string) => id === 'job_exact' ? { id, status: 'waiting', activeAttemptId: 'attempt_exact' } : null,
      getAttempt: (id: string) => id === 'attempt_exact' ? { id, jobId: 'job_exact', generation: 3 } : null,
      listEvents: (id: string, after: number) => id === 'job_exact'
        ? [{ jobId: id, jobSequence: after + 1, type: 'approval.created' }]
        : [],
    };
    const b = await startWorkbenchBridge({ reader: runStore, jobs, port: 0 });
    const job = await httpGet(b.port, '/api/jobs/job_exact');
    const attempt = await httpGet(b.port, '/api/attempts/attempt_exact');
    const events = await httpGet(b.port, '/api/jobs/job_exact/events?after=7');
    expect(JSON.parse(job.body)).toMatchObject({ id: 'job_exact', status: 'waiting' });
    expect(JSON.parse(attempt.body)).toMatchObject({ id: 'attempt_exact', generation: 3 });
    expect(JSON.parse(events.body)).toEqual([{ jobId: 'job_exact', jobSequence: 8, type: 'approval.created' }]);
    await b.close();
  });
});

// ── Serving the built React dashboard (dashboard-next/out) ────────────────────

describe('Workbench bridge — static React dashboard', () => {
  const TOKEN = 'static-token-xyz';
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'),
      '<!doctype html><html><head><title>React</title></head><body>Aiden React Dashboard</body></html>');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("aiden")');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('★ serves the built index.html at / with the write token injected', async () => {
    const b = await startWorkbenchBridge({ reader: runStore, token: TOKEN, staticDir: dir, port: 0 });
    const { status, contentType, body } = await httpGet(b.port, '/');
    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/html/);
    expect(body).toContain('Aiden React Dashboard');
    expect(body).toContain('window.__WB_TOKEN__="' + TOKEN + '"');   // only the served page holds the token
    await b.close();
  });

  it('serves static assets with the right content-type', async () => {
    const b = await startWorkbenchBridge({ reader: runStore, token: TOKEN, staticDir: dir, port: 0 });
    const { status, contentType, body } = await httpGet(b.port, '/app.js');
    expect(status).toBe(200);
    expect(contentType).toMatch(/javascript/);
    expect(body).toContain('console.log');
    await b.close();
  });

  it('★ falls back to index.html for client-side routes (SPA)', async () => {
    const b = await startWorkbenchBridge({ reader: runStore, token: TOKEN, staticDir: dir, port: 0 });
    const { status, body } = await httpGet(b.port, '/some/client/route');
    expect(status).toBe(200);
    expect(body).toContain('Aiden React Dashboard');
    await b.close();
  });

  it('refuses encoded path traversal out of the static dir (403)', async () => {
    const b = await startWorkbenchBridge({ reader: runStore, token: TOKEN, staticDir: dir, port: 0 });
    const { status } = await httpGet(b.port, '/..%2f..%2fpackage.json');
    expect(status).toBe(403);
    await b.close();
  });

  it('keeps the built-in page reachable at /plain', async () => {
    const b = await startWorkbenchBridge({ reader: runStore, token: TOKEN, staticDir: dir, port: 0 });
    const { status, body } = await httpGet(b.port, '/plain');
    expect(status).toBe(200);
    expect(body).toContain('class="sidebar"');             // the built-in page, not React
    expect(body).not.toContain('Aiden React Dashboard');
    await b.close();
  });

  it('without a staticDir, / still serves the built-in page (unchanged)', async () => {
    const { status, body } = await httpGet(bridge.port, '/');   // beforeEach bridge has no staticDir
    expect(status).toBe(200);
    expect(body).toContain('class="sidebar"');
    expect(body).not.toContain('Aiden React Dashboard');
  });
});
