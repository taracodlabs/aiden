/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/workbench/bridgeServer.ts — Aiden Workbench Phase 1: the event-stream
 * web bridge (read-only).
 *
 * A minimal loopback web server that replays a run's / session's `run_events`
 * (ordered) and then tails new rows live over SSE, so a browser can follow a
 * running CLI or daemon turn WITHOUT touching the agent.
 *
 * Deliberately standalone. It depends ONLY on:
 *   - node:http (no express),
 *   - a narrow read port over the run store (`listEventsScoped`).
 * It never imports the v3 api/server monolith, the agent loop, or any provider
 * stack. Read-only, local-only, one endpoint family — nothing here can mutate a
 * run or drive the agent.
 *
 * Ordering: the store returns rows newest-first; the bridge always re-emits
 * oldest-first by the global autoincrement row `id`, so replay + live tail form
 * one monotonic stream a browser can trust. The row `id` doubles as the SSE
 * `id:` field, so a dropped connection resumes via `Last-Event-ID` with no gaps.
 */

import http from 'node:http';
import type { RunEventRich, ListEventsScopedOptions } from '../daemon/runStore';
import { WORKBENCH_DASHBOARD_HTML } from './dashboardHtml';

/** The one capability the bridge needs — a narrow read port over the run store. */
export interface RunEventReader {
  listEventsScoped(opts: ListEventsScopedOptions): RunEventRich[];
}

/** One recent session for the sidebar — a readable label, never a raw id. */
export interface SessionSummary {
  id:         string;
  label:      string;
  lastActive: number;
  provider?:  string | null;
  model?:     string | null;
}

/** Optional read port for the sidebar's recent-sessions list. Read-only. */
export interface SessionLister {
  listSessions(): SessionSummary[];
}

/** Result of enqueueing a browser-submitted task onto the safe job path. */
export interface EnqueueResult {
  accepted:        boolean;
  triggerEventId?: number;
  duplicate?:      boolean;
}

/** Optional WRITE port — enqueues a task onto the daemon's safe job path. The
 *  bridge NEVER runs the agent itself; it only hands the task to this port,
 *  which routes it through the same approval/safe-mode-gated dispatcher a CLI
 *  turn uses. When absent, POST /api/tasks returns 503. */
export interface TaskEnqueuer {
  enqueue(task: { message: string; sessionId?: string }): EnqueueResult;
}

export interface WorkbenchBridgeOptions {
  /** Read port over the shared run-event store (a RunStore satisfies this). */
  reader:      RunEventReader;
  /** Optional read port for the recent-sessions sidebar (a SELECT over the
   *  durable session store). When absent, /api/sessions returns []. */
  sessions?:   SessionLister;
  /** Optional WRITE port for the chat input. Absent → POST /api/tasks is 503. */
  enqueue?:    TaskEnqueuer;
  /** Per-launch local write token. REQUIRED for any write to execute — POST
   *  /api/tasks must present it (x-workbench-token / Bearer). Absent → all
   *  writes are refused. Injected into the served page so only the local
   *  dashboard has it. Read-only GET endpoints ignore it. */
  token?:      string;
  /** Loopback port. Default 4280. Pass 0 for an ephemeral port (tests). */
  port?:       number;
  /** Bind host. Default 127.0.0.1 — this phase never binds off-box. */
  host?:       string;
  /** Tail poll interval in ms (SQLite has no push). Default 250, floor 50. */
  pollMs?:     number;
  /** Rows pulled per query (the store itself caps at 5000). Default 5000. */
  pageLimit?:  number;
  /** Optional diagnostics sink (never writes to stdout on its own). */
  log?:        (msg: string) => void;
}

export interface WorkbenchBridge {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

/** A stream-ready event: the rich row with its payload parsed back to an object. */
interface WireEvent {
  id:            number;
  runId:         number;
  sessionId:     string | null;
  turnId:        string | null;
  seq:           number;
  ts:            number;
  category:      string;
  kind:          string;
  name:          string | null;
  toolCallId:    string | null;
  parentEventId: number | null;
  status:        string | null;
  durationMs:    number | null;
  summary:       string | null;
  payload:       unknown;
}

function toWire(r: RunEventRich): WireEvent {
  let payload: unknown = null;
  try { payload = r.payload ? JSON.parse(r.payload) : null; } catch { payload = r.payload; }
  return {
    id: r.id, runId: r.runId, sessionId: r.sessionId, turnId: r.turnId,
    seq: r.seq, ts: r.ts, category: r.category, kind: r.kind, name: r.name,
    toolCallId: r.toolCallId, parentEventId: r.parentEventId, status: r.status,
    durationMs: r.durationMs, summary: r.summary, payload,
  };
}

/** SSE `event:` names must be single-line — collapse any newlines/CRs. */
function sseEventName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').slice(0, 128);
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
}

/** Read + parse a bounded JSON request body. Rejects on oversize or bad JSON. */
function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8').trim();
        const parsed = s ? JSON.parse(s) : {};
        resolve(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * Start the bridge. Resolves once it is listening; the returned handle exposes
 * the bound port and a `close()` for graceful shutdown.
 */
export function startWorkbenchBridge(opts: WorkbenchBridgeOptions): Promise<WorkbenchBridge> {
  const host      = opts.host ?? '127.0.0.1';
  const wantPort  = opts.port ?? 4280;
  const pollMs    = Math.max(50, opts.pollMs ?? 250);
  const pageLimit = Math.min(Math.max(1, opts.pageLimit ?? 5000), 5000);
  const log       = opts.log ?? ((): void => {});

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);

    // The ONE write endpoint — token-gated (see handlePostTask). Every other
    // non-GET is rejected.
    if (req.method === 'POST' && url.pathname === '/api/tasks') { handlePostTask(req, res); return; }
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }

    // The dashboard page — a single self-contained dark view. The per-launch
    // write token is injected here so only the locally-served page holds it.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const page = WORKBENCH_DASHBOARD_HTML.replace('__WORKBENCH_TOKEN__', () => opts.token ?? '');
      const body = Buffer.from(page, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/health') {
      // readOnly unless BOTH a write token and an enqueuer are wired.
      const writeEnabled = Boolean(opts.token && opts.enqueue);
      sendJson(res, 200, { ok: true, service: 'aiden-workbench-bridge', readOnly: !writeEnabled });
      return;
    }

    // The sidebar's recent-sessions list — readable labels, read-only.
    if (url.pathname === '/api/sessions') {
      let list: SessionSummary[] = [];
      try { list = opts.sessions ? opts.sessions.listSessions() : []; }
      catch (e) { log(`session list failed: ${(e as Error).message}`); }
      sendJson(res, 200, list);
      return;
    }

    // The dashboard's live feed: ALL recent events across sessions/runs, streamed
    // as plain SSE `message` frames (name is in the data) so one EventSource with
    // a single onmessage handler renders everything.
    if (url.pathname === '/api/events') {
      streamEvents(req, res, { scope: 'all', limit: pageLimit }, false);
      return;
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    const sesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (runMatch) {
      const runId = Number(decodeURIComponent(runMatch[1]));
      if (!Number.isFinite(runId)) { sendJson(res, 400, { error: 'runId must be numeric' }); return; }
      streamEvents(req, res, { scope: 'run_id', runId, limit: pageLimit });
      return;
    }
    if (sesMatch) {
      streamEvents(req, res, { scope: 'session_id', sessionId: decodeURIComponent(sesMatch[1]), limit: pageLimit });
      return;
    }

    sendJson(res, 404, {
      error: 'not found',
      endpoints: ['GET /', 'GET /api/health', 'GET /api/sessions', 'GET /api/events', 'GET /api/runs/:runId/events', 'GET /api/sessions/:sessionId/events'],
    });
  });

  function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, scope: ListEventsScopedOptions, named = true): void {
    res.writeHead(200, {
      'Content-Type':      'text/event-stream; charset=utf-8',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',   // defeat reverse-proxy buffering
    });

    // Resume support: Last-Event-ID (or ?lastId=) skips rows already seen.
    let lastId = 0;
    const hdr = req.headers['last-event-id'];
    const hdrVal = Array.isArray(hdr) ? hdr[0] : hdr;
    if (hdrVal && Number.isFinite(Number(hdrVal))) lastId = Number(hdrVal);

    const flush = (): void => {
      let rows: RunEventRich[];
      try { rows = opts.reader.listEventsScoped(scope); }
      catch (e) { log(`query failed: ${(e as Error).message}`); return; }
      // Store returns newest-first; re-emit oldest-first by global row id.
      const ordered = [...rows].sort((a, b) => a.id - b.id);
      for (const r of ordered) {
        if (r.id <= lastId) continue;
        lastId = r.id;
        const wire = toWire(r);
        // Named endpoints tag each frame with its emission name (programmatic
        // clients dispatch per type); the browser feed omits it so a single
        // onmessage handler receives everything (the name is in the data).
        const frame = named
          ? `id: ${wire.id}\nevent: ${sseEventName(wire.name ?? wire.kind)}\ndata: ${JSON.stringify(wire)}\n\n`
          : `id: ${wire.id}\ndata: ${JSON.stringify(wire)}\n\n`;
        try {
          res.write(frame);
        } catch { /* client gone — the close handler cleans up */ }
      }
    };

    flush();                                    // 1) replay up to now
    const tick = setInterval(flush, pollMs);    // 2) tail new rows
    const ka   = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 15000);
    tick.unref?.(); ka.unref?.();

    const stop = (): void => { clearInterval(tick); clearInterval(ka); };
    req.on('close', stop);
    req.on('error', stop);
    res.on('error', stop);
  }

  // ── the one write path: POST /api/tasks (token-gated) ──────────────────────
  //
  // Security posture (defense in depth):
  //   1. A per-launch token MUST match — no token, no write (closes the "any
  //      local process / any website can command Aiden" hole).
  //   2. The Origin (when the browser sends one) must be this dashboard's own —
  //      a cross-site page can't forge a same-origin write.
  //   3. The task is only ENQUEUED onto the daemon's safe job path; the bridge
  //      never runs the agent, so approvals/safe-mode are enforced downstream.
  function handlePostTask(req: http.IncomingMessage, res: http.ServerResponse): void {
    // (1) token gate.
    if (!opts.token) { sendJson(res, 503, { error: 'write path not enabled' }); return; }
    const raw = req.headers['x-workbench-token'];
    const hdr = Array.isArray(raw) ? raw[0] : raw;
    const bearer = /^Bearer\s+(\S+)/i.exec(String(req.headers['authorization'] ?? ''));
    const provided = hdr ?? (bearer ? bearer[1] : '');
    if (provided !== opts.token) { sendJson(res, 401, { error: 'unauthorized — missing or bad workbench token' }); return; }

    // (2) reject cross-origin / non-loopback (CSRF defense).
    const origin = String(req.headers['origin'] ?? '');
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
      sendJson(res, 403, { error: 'cross-origin write refused' }); return;
    }
    const hostHdr = String(req.headers['host'] ?? '');
    if (hostHdr && !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(hostHdr)) {
      sendJson(res, 403, { error: 'non-loopback host refused' }); return;
    }

    readJsonBody(req, 64 * 1024).then((body) => {
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!message) { sendJson(res, 400, { error: 'body requires a non-empty "message"' }); return; }
      if (!opts.enqueue) { sendJson(res, 503, { error: 'task execution unavailable (daemon not wired)' }); return; }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
      try {
        const result = opts.enqueue.enqueue({ message, sessionId });
        sendJson(res, 202, { accepted: result.accepted, triggerEventId: result.triggerEventId, duplicate: result.duplicate ?? false });
      } catch (e) {
        log(`enqueue failed: ${(e as Error).message}`);
        sendJson(res, 500, { error: 'enqueue failed' });
      }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  return new Promise<WorkbenchBridge>((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(wantPort, host, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : wantPort;
      log(`listening on http://${host}:${boundPort}`);
      resolve({
        port: boundPort,
        host,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
