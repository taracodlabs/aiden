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

export interface WorkbenchBridgeOptions {
  /** Read port over the shared run-event store (a RunStore satisfies this). */
  reader:      RunEventReader;
  /** Optional read port for the recent-sessions sidebar (a SELECT over the
   *  durable session store). When absent, /api/sessions returns []. */
  sessions?:   SessionLister;
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
    // Read-only bridge: only GET is ever allowed.
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed — read-only bridge' }); return; }

    const url = new URL(req.url ?? '/', `http://${host}`);

    // The dashboard page — a single self-contained dark view of the live feed.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const body = Buffer.from(WORKBENCH_DASHBOARD_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'aiden-workbench-bridge', readOnly: true });
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
