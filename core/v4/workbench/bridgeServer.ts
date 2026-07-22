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
import fs from 'node:fs';
import path from 'node:path';
import type { RunEventRich, ListEventsScopedOptions } from '../daemon/runStore';
import { WORKBENCH_DASHBOARD_HTML } from './dashboardHtml';

/**
 * Strip bracketed-paste markers at the workbench INGEST boundary. A pasted
 * message can arrive carrying ESC[200~ / ESC[201~ (or their ESC-stripped
 * `[200~` / `200~` leftovers). Stripping them HERE — the one place browser text
 * enters the daemon — keeps the stored message AND its derived session label
 * clean, and preserves multi-line content, instead of leaving every downstream
 * consumer to strip (which the raw stored message never did).
 */
export function stripPasteMarkers(s: string): string {
  return s.replace(/\x1b?\[?20[01]~/g, '');
}

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
  jobId?:          string;
  attemptId?:      string;
  runId?:          number;
}

/** Optional WRITE port — enqueues a task onto the daemon's safe job path. The
 *  bridge NEVER runs the agent itself; it only hands the task to this port,
 *  which routes it through the same approval/safe-mode-gated dispatcher a CLI
 *  turn uses. When absent, POST /api/tasks returns 503. */
export interface TaskEnqueuer {
  enqueue(task: { message: string; sessionId?: string }): EnqueueResult;
}

/** Result of a stop/cancel request against a run. */
export interface CancelResult {
  accepted:      boolean;
  runId:         number;
  /** True when the run was already in a terminal state — nothing to stop. */
  alreadyFinal?: boolean;
}

/** Optional STEER port — requests cancellation of a running job by run id. Like
 *  the enqueuer, the bridge never touches the agent; the port records the stop
 *  durably on the shared store (terminal status + a visible `task_cancelled`
 *  feed event) so the dispatcher stops dispatching the job and the dashboard
 *  shows it. When absent, POST /api/tasks/:runId/cancel returns 503. */
export interface TaskCanceller {
  cancel(runId: number): CancelResult;
}

export interface WorkbenchBridgeOptions {
  /** Read port over the shared run-event store (a RunStore satisfies this). */
  reader:      RunEventReader;
  /** Optional read port for the recent-sessions sidebar (a SELECT over the
   *  durable session store). When absent, /api/sessions returns []. */
  sessions?:   SessionLister;
  /** Optional WRITE port for the chat input. Absent → POST /api/tasks is 503. */
  enqueue?:    TaskEnqueuer;
  /** Optional STEER port for the stop button. Absent → cancel is 503. */
  cancel?:     TaskCanceller;
  /** Per-launch local write token. REQUIRED for any write to execute — POST
   *  /api/tasks must present it (x-workbench-token / Bearer). Absent → all
   *  writes are refused. Injected into the served page so only the local
   *  dashboard has it. Read-only GET endpoints ignore it. */
  token?:      string;
  /** Optional directory of a BUILT static dashboard (dashboard-next/out). When
   *  set, the bridge serves that React app at `/` (with the token injected into
   *  index.html) plus its assets, and moves the built-in page to `/plain`. When
   *  absent, `/` serves the built-in page. Same origin as /api/* — no CORS. */
  staticDir?:  string;
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

// ── static dashboard serving (the built React app) ─────────────────────────────

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
};

/** Inject the per-launch write token into a served HTML page so only the locally
 *  served dashboard can perform writes. */
function injectToken(html: string, token: string): string {
  const tag = `<script>window.__WB_TOKEN__=${JSON.stringify(token)}</script>`;
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`;
}

/**
 * Serve a file from the built static dashboard. Confines every path to
 * `staticDir` (no traversal), injects the token into HTML, and falls back to
 * index.html for extensionless routes (SPA). Returns true when it wrote a
 * response; false when nothing matched (caller falls through to 404 / plain).
 */
async function serveStatic(res: http.ServerResponse, staticDir: string, urlPath: string, token: string): Promise<boolean> {
  const rootAbs = path.resolve(staticDir);
  let rel = urlPath.split('?')[0];
  try { rel = decodeURIComponent(rel); } catch { /* keep raw */ }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(rootAbs, '.' + rel);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) { sendJson(res, 403, { error: 'forbidden' }); return true; }

  const ext = path.extname(full).toLowerCase();
  const writeFile = (buf: Buffer, type: string): void => {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
    res.end(buf);
  };
  try {
    const buf = await fs.promises.readFile(full);
    if (ext === '.html') { writeFile(Buffer.from(injectToken(buf.toString('utf8'), token), 'utf8'), STATIC_MIME['.html']); return true; }
    writeFile(buf, STATIC_MIME[ext] ?? 'application/octet-stream');
    return true;
  } catch {
    // Not a file. Extensionless request → the SPA's index.html (client routes).
    if (!ext) {
      try {
        const idx = await fs.promises.readFile(path.join(rootAbs, 'index.html'));
        writeFile(Buffer.from(injectToken(idx.toString('utf8'), token), 'utf8'), STATIC_MIME['.html']);
        return true;
      } catch { return false; }
    }
    return false;
  }
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

    // The write endpoints — both token-gated (see passesWriteGate). Every other
    // non-GET is rejected.
    if (req.method === 'POST' && url.pathname === '/api/tasks') { handlePostTask(req, res); return; }
    const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) { handleCancelTask(req, res, cancelMatch[1]); return; }
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }

    // The built-in self-contained dark page. The per-launch write token is
    // injected so only the locally-served page holds it. Always reachable at
    // /plain (the fallback for the primary React dashboard).
    const servePlainPage = (): void => {
      const page = WORKBENCH_DASHBOARD_HTML.replace('__WORKBENCH_TOKEN__', () => opts.token ?? '');
      const body = Buffer.from(page, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
      res.end(body);
    };
    if (url.pathname === '/plain' || url.pathname === '/plain.html') { servePlainPage(); return; }

    // `/` — the primary dashboard. With a built static app wired, `/` and its
    // assets are served by the static catch-all below; otherwise the built-in page.
    if ((url.pathname === '/' || url.pathname === '/index.html') && !opts.staticDir) {
      servePlainPage();
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

    // Anything else that isn't an /api path → the built static dashboard (its
    // `/`, assets, and client routes). Missing files fall back to the built-in page.
    if (opts.staticDir && !url.pathname.startsWith('/api/')) {
      void serveStatic(res, opts.staticDir, url.pathname, opts.token ?? '')
        .then((served) => { if (!served) servePlainPage(); })
        .catch((e) => { log(`static serve failed: ${(e as Error).message}`); servePlainPage(); });
      return;
    }

    sendJson(res, 404, {
      error: 'not found',
      endpoints: ['GET /', 'GET /plain', 'GET /api/health', 'GET /api/sessions', 'GET /api/events', 'GET /api/runs/:runId/events', 'GET /api/sessions/:sessionId/events', 'POST /api/tasks', 'POST /api/tasks/:runId/cancel'],
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

  // ── the write path: shared token/CSRF gate + the two write endpoints ───────
  //
  // Security posture (defense in depth), applied identically to every write:
  //   1. A per-launch token MUST match — no token, no write (closes the "any
  //      local process / any website can command Aiden" hole).
  //   2. The Origin (when the browser sends one) must be this dashboard's own —
  //      a cross-site page can't forge a same-origin write.
  //   3. Writes never run the agent: `POST /api/tasks` only ENQUEUES onto the
  //      daemon's safe job path, and the stop endpoint only records a durable
  //      cancel — approvals/safe-mode stay enforced downstream.
  //
  // Returns true when the request cleared the gate; otherwise it has already
  // written the rejection and the caller must return.
  function passesWriteGate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!opts.token) { sendJson(res, 503, { error: 'write path not enabled' }); return false; }
    const raw = req.headers['x-workbench-token'];
    const hdr = Array.isArray(raw) ? raw[0] : raw;
    const bearer = /^Bearer\s+(\S+)/i.exec(String(req.headers['authorization'] ?? ''));
    const provided = hdr ?? (bearer ? bearer[1] : '');
    if (provided !== opts.token) { sendJson(res, 401, { error: 'unauthorized — missing or bad workbench token' }); return false; }

    const origin = String(req.headers['origin'] ?? '');
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
      sendJson(res, 403, { error: 'cross-origin write refused' }); return false;
    }
    const hostHdr = String(req.headers['host'] ?? '');
    if (hostHdr && !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(hostHdr)) {
      sendJson(res, 403, { error: 'non-loopback host refused' }); return false;
    }
    return true;
  }

  function handlePostTask(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    readJsonBody(req, 64 * 1024).then((body) => {
      const message = typeof body?.message === 'string' ? stripPasteMarkers(body.message).trim() : '';
      if (!message) { sendJson(res, 400, { error: 'body requires a non-empty "message"' }); return; }
      if (!opts.enqueue) { sendJson(res, 503, { error: 'task execution unavailable (daemon not wired)' }); return; }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
      try {
        const result = opts.enqueue.enqueue({ message, sessionId });
        sendJson(res, 202, {
          accepted: result.accepted,
          triggerEventId: result.triggerEventId,
          duplicate: result.duplicate ?? false,
          job_id: result.jobId,
          attempt_id: result.attemptId,
          run_id: result.runId,
        });
      } catch (e) {
        log(`enqueue failed: ${(e as Error).message}`);
        sendJson(res, 500, { error: 'enqueue failed' });
      }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  // Stop/steer: request cancellation of a running job by run id. The bridge
  // hands the run id to the injected canceller (which marks it cancelled on the
  // shared store + surfaces a `task_cancelled` feed event); it never aborts the
  // agent in-process. Idempotent — cancelling an already-finished run is a no-op.
  function handleCancelTask(req: http.IncomingMessage, res: http.ServerResponse, rawRunId: string): void {
    if (!passesWriteGate(req, res)) return;
    req.resume();   // drain any body (browsers send Content-Length: 0)
    const runId = Number(decodeURIComponent(rawRunId));
    if (!Number.isFinite(runId)) { sendJson(res, 400, { error: 'runId must be numeric' }); return; }
    if (!opts.cancel) { sendJson(res, 503, { error: 'stop unavailable (daemon not wired)' }); return; }
    try {
      const result = opts.cancel.cancel(runId);
      sendJson(res, 202, { accepted: result.accepted, runId: result.runId, alreadyFinal: result.alreadyFinal ?? false });
    } catch (e) {
      log(`cancel failed: ${(e as Error).message}`);
      sendJson(res, 500, { error: 'cancel failed' });
    }
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
