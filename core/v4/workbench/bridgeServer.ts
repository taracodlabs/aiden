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
import { VERSION } from '../../version';
import type { RunEventRich, ListEventsScopedOptions } from '../daemon/runStore';
import { WORKBENCH_DASHBOARD_HTML } from './dashboardHtml';
import {
  projectWorkbenchJob,
  type WorkbenchJobProjectionReader,
} from './projection';
import { summarizeWorkbenchActiveJobs } from './activeJobs';
import type { WorkbenchPresencePort } from './presencePort';
import type { CapabilityManagementProjection } from '../capabilities/management';
import type {
  WorkbenchAttachment,
  WorkbenchArtifactContent,
} from './fileBridge';
import type { Artifact } from '../daemon/artifactStore';
import type { WorkbenchAppsPort } from './appsPort';
import type { WorkbenchCodingPort } from './codingPort';
import type { WorkbenchProviderSetupAuthority } from './providerSetupAuthority';
import type { SystemReadinessProjection } from './systemReadiness';
import type { ProductEdition } from '../commercial/edition';
import type { WorkbenchLiveExecutionPort } from './liveExecution';
import type { WorkbenchAutomationPort } from './automationPort';
import type { WorkbenchLearningPort } from './learningPort';

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
  enqueue(task: { message: string; sessionId?: string; idempotencyKey?: string }): EnqueueResult;
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

export interface TaskInputReceiver {
  receive(runId: number, content: string, idempotencyKey?: string): {
    accepted: boolean;
    runId: number;
    inputId?: string;
    duplicate?: boolean;
  };
}

export interface TaskController {
  pause(runId: number, idempotencyKey?: string): {
    accepted: boolean;
    applied: boolean;
    runId: number;
    controlId?: string;
  };
  resume(runId: number, idempotencyKey?: string): {
    accepted: boolean;
    runId: number;
    attemptId?: string;
    generation?: number;
  };
}

export interface ApprovalDecider {
  decide(approvalId: string, decision: 'approved' | 'denied' | 'cancelled'): {
    accepted: boolean;
    approvalId: string;
    state?: string;
  };
}

export interface DurableJobReader extends WorkbenchJobProjectionReader {}

export interface WorkbenchActiveJob {
  sessionId: string | null;
  jobId: string;
  attemptId: string | null;
  runId: number | null;
  status: string;
  title?: string;
  statusDetail?: string;
  updatedAt?: number;
  triggerEventId?: number | null;
  triggerStatus?: string | null;
  queue?: { pending: number; claimed: number; oldestPendingMs: number | null };
}

export interface WorkbenchAttachmentPort {
  saveAttachment(input: { name: string; mime?: string; bytes: Buffer }): WorkbenchAttachment;
  resolveAttachments(ids: readonly string[]): WorkbenchAttachment[];
}

export interface WorkbenchArtifactPort {
  listArtifacts(input: { runId?: number; sessionId?: string; limit?: number }): Artifact[];
  readArtifact(id: string): WorkbenchArtifactContent | null;
}

export interface WorkbenchCapabilitiesProjection {
  modelSwitch: { available: boolean; reason?: string };
  skills: Array<{
    name: string; description: string; version: string; category?: string;
    trustLevel?: string; readiness?: unknown;
  }>;
  plugins: Array<{
    name: string; version: string; description: string; author?: string;
    status: string; permissions: string[];
  }>;
  extensions?: {
    executionEnabled: boolean;
    sandbox: { available: boolean; mechanism: 'docker'; image: string; reason?: string };
    items: CapabilityManagementProjection[];
  };
}

export interface WorkbenchCapabilityManagementPort {
  snapshot(): WorkbenchCapabilitiesProjection['extensions'];
  install(sourcePath: string): Promise<{ capabilityId: string }>;
  activate(input: { capabilityId: string; version: string; acceptPermissions: boolean }): unknown;
  rollback(capabilityId: string): unknown;
  disable(capabilityId: string): unknown;
  test(capabilityId: string): Promise<unknown>;
  uninstall(input: { capabilityId: string; version: string }): Promise<unknown>;
}

export interface ContinuityReader {
  get(checkpointId: string): unknown | null;
  getLatest(jobId: string): unknown | null;
  listForWorkspace(workspaceId: string | null, limit?: number): unknown[];
  resolveForWorkspace?(workspaceId: string | null): unknown;
}

export interface ContinuityController {
  continue(checkpointId: string, idempotencyKey: string): unknown | Promise<unknown>;
}

export interface WorkbenchBrowserController {
  get(jobId: string): unknown | null;
  take(jobId: string): unknown | Promise<unknown>;
  return(jobId: string): unknown | Promise<unknown>;
  clear(jobId: string): unknown | Promise<unknown>;
}

export interface WorkbenchBrowserSetupPort {
  snapshot(): Promise<{ ready: boolean; detail: string; grantRequired: boolean; permissions: string[] }>;
  grant(input: { confirmed: boolean }): Promise<{ ready: boolean; detail: string; grantRequired: boolean; permissions: string[] }>;
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
  input?:      TaskInputReceiver;
  control?:    TaskController;
  approval?:   ApprovalDecider;
  attachments?: WorkbenchAttachmentPort;
  artifacts?: WorkbenchArtifactPort;
  capabilities?: () => WorkbenchCapabilitiesProjection;
  capabilityManagement?: WorkbenchCapabilityManagementPort;
  jobs?:       DurableJobReader;
  continuity?: ContinuityReader;
  continueTask?: ContinuityController;
  browser?: WorkbenchBrowserController;
  /** Safe connected-account projection and commands over the shared integration authority. */
  apps?: WorkbenchAppsPort;
  /** Durable external coding projection and explicit review decisions. */
  coding?: WorkbenchCodingPort;
  /** Safe provider/model management over runtime, config, OAuth and secret authorities. */
  providerSetup?: WorkbenchProviderSetupAuthority;
  /** Aggregate product-readiness projection; never owns execution. */
  readiness?: { snapshot(sessionId?: string): Promise<SystemReadinessProjection> };
  /** Read-only normalized projection over the exact selected durable execution. */
  liveExecution?: WorkbenchLiveExecutionPort;
  /** Exact browser-plugin grant adapter. */
  browserSetup?: WorkbenchBrowserSetupPort;
  /** Reliable automation projection and commands over canonical SQLite authority. */
  automations?: WorkbenchAutomationPort;
  /** Durable Agentic Presence projection. It cannot execute work directly. */
  presence?: WorkbenchPresencePort;
  /** Scoped privacy and review controls over the canonical Learning authority. */
  learning?: WorkbenchLearningPort;
  /** Per-launch local write token. REQUIRED for any write to execute — POST
   *  /api/tasks must present it (x-workbench-token / Bearer). Absent → all
   *  writes are refused. Injected into the served page so only the local
   *  dashboard has it. Read-only GET endpoints ignore it. */
  token?:      string;
  /** Authoritative runtime metadata for the Workbench header/settings. */
  runtime?: () => {
    provider?: string | null;
    model?: string | null;
    local?: boolean;
    connection?: 'connected' | 'unavailable' | 'reconnecting';
    edition?: ProductEdition;
  };
  /** Bounded durable snapshot used to restore active jobs without treating
   * browser state as authoritative. */
  activeJobs?: () => WorkbenchActiveJob[];
  /** Health-only projection of the existing durable dispatcher hosted by the
   * standalone Workbench entry point. */
  execution?: () => {
    available: boolean;
    runner: 'real' | 'unavailable';
    workerCount: number;
    pending: number;
    claimed: number;
    inflight: number;
    oldestPendingMs: number | null;
    processed: number;
  };
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

export interface WorkbenchAssistantOutputChunk {
  eventId: number;
  sequence: number;
  text: string;
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

function projectAssistantOutput(reader: RunEventReader, runId: number): WorkbenchAssistantOutputChunk[] {
  const seen = new Set<number>();
  return reader.listEventsScoped({
    scope: 'run_id', runId, category: 'assistant', kind: 'assistant.message', limit: 5_000,
  })
    .sort((a, b) => a.seq - b.seq || a.id - b.id)
    .flatMap((event) => {
      if (seen.has(event.id)) return [];
      seen.add(event.id);
      try {
        const payload = JSON.parse(event.payload) as { text?: unknown };
        return typeof payload.text === 'string'
          ? [{ eventId: event.id, sequence: event.seq, text: payload.text }]
          : [];
      } catch { return []; }
    });
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
    'Cache-Control':  'no-store',
  });
  res.end(s);
}

function sendArtifact(res: http.ServerResponse, content: WorkbenchArtifactContent): void {
  res.writeHead(200, {
    'Content-Type': content.mime,
    'Content-Length': content.bytes.length,
    'Content-Disposition': `inline; filename=${JSON.stringify(content.name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(content.mime === 'image/svg+xml'
      ? { 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" }
      : {}),
  });
  res.end(content.bytes);
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
  const writeFile = (buf: Buffer, type: string, dynamicHtml = false): void => {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      ...(dynamicHtml ? { 'Cache-Control': 'no-store' } : {}),
    });
    res.end(buf);
  };
  try {
    const buf = await fs.promises.readFile(full);
    if (ext === '.html') {
      writeFile(Buffer.from(injectToken(buf.toString('utf8'), token), 'utf8'), STATIC_MIME['.html'], true);
      return true;
    }
    writeFile(buf, STATIC_MIME[ext] ?? 'application/octet-stream');
    return true;
  } catch {
    // Not a file. Extensionless request → the SPA's index.html (client routes).
    if (!ext) {
      try {
        const idx = await fs.promises.readFile(path.join(rootAbs, 'index.html'));
        writeFile(Buffer.from(injectToken(idx.toString('utf8'), token), 'utf8'), STATIC_MIME['.html'], true);
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
    if (req.method === 'POST' && url.pathname === '/api/attachments') { handleAttachmentUpload(req, res); return; }
    const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) { handleCancelTask(req, res, cancelMatch[1]); return; }
    const inputMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/input$/);
    if (req.method === 'POST' && inputMatch) { handleTaskInput(req, res, inputMatch[1]); return; }
    const controlMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume)$/);
    if (req.method === 'POST' && controlMatch) {
      handleTaskControl(req, res, controlMatch[1], controlMatch[2] as 'pause' | 'resume');
      return;
    }
    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (req.method === 'POST' && approvalMatch) { handleApprovalDecision(req, res, approvalMatch[1]); return; }
    const continueMatch = url.pathname.match(/^\/api\/checkpoints\/([^/]+)\/continue$/);
    if (req.method === 'POST' && continueMatch) { handleContinueTask(req, res, continueMatch[1]); return; }
    const browserControlMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/browser\/(take|return|clear)$/);
    if (req.method === 'POST' && browserControlMatch) {
      handleBrowserControl(req, res, browserControlMatch[1], browserControlMatch[2] as 'take' | 'return' | 'clear');
      return;
    }
    const codingDecisionMatch = url.pathname.match(/^\/api\/coding\/promotions\/([^/]+)\/(apply|discard)$/);
    if (req.method === 'POST' && codingDecisionMatch) {
      handleCodingDecision(req, res, codingDecisionMatch[1], codingDecisionMatch[2] as 'apply' | 'discard');
      return;
    }
    const codingUnknownDiscardMatch = url.pathname.match(/^\/api\/coding\/sessions\/([^/]+)\/discard$/);
    if (req.method === 'POST' && codingUnknownDiscardMatch) {
      handleUnknownCodingDiscard(req, res, codingUnknownDiscardMatch[1]);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/apps/connect') {
      handleAppsConnect(req, res); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/coding/configure') {
      handleCodingConfigure(req, res); return;
    }
    const appProviderConfigureMatch = url.pathname.match(/^\/api\/apps\/providers\/([^/]+)\/configure$/);
    if (req.method === 'POST' && appProviderConfigureMatch) {
      handleAppsProviderConfigure(req, res, appProviderConfigureMatch[1]); return;
    }
    const appConnectionMatch = url.pathname.match(/^\/api\/apps\/connections\/([^/]+)\/complete$/);
    if (req.method === 'POST' && appConnectionMatch) {
      handleAppsComplete(req, res, appConnectionMatch[1]); return;
    }
    const appAccountMatch = url.pathname.match(/^\/api\/apps\/accounts\/([^/]+)\/(refresh|reconnect|disconnect)$/);
    if (req.method === 'POST' && appAccountMatch) {
      handleAppsAccount(req, res, appAccountMatch[1], appAccountMatch[2] as 'refresh' | 'reconnect' | 'disconnect');
      return;
    }
    const providerCommandMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/(connect|replace-credential|test|disconnect|refresh-models)$/);
    if (req.method === 'POST' && providerCommandMatch) {
      handleProviderCommand(req, res, providerCommandMatch[1], providerCommandMatch[2] as 'connect' | 'replace-credential' | 'test' | 'disconnect' | 'refresh-models');
      return;
    }
    const providerOAuthMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/oauth\/start$/);
    if (req.method === 'POST' && providerOAuthMatch) {
      handleProviderOAuth(req, res, providerOAuthMatch[1]); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/providers/model/session') {
      handleProviderModelChange(req, res, 'session'); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/providers/model/default') {
      handleProviderModelChange(req, res, 'default'); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/browser/setup/grant') {
      handleBrowserGrant(req, res); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/capabilities/install') {
      handleCapabilityInstall(req, res); return;
    }
    const capabilityActionMatch = url.pathname.match(/^\/api\/capabilities\/([^/]+)\/(activate|rollback|disable|test|uninstall)$/);
    if (req.method === 'POST' && capabilityActionMatch) {
      handleCapabilityAction(
        req,
        res,
        decodeURIComponent(capabilityActionMatch[1]),
        capabilityActionMatch[2] as 'activate' | 'rollback' | 'disable' | 'test' | 'uninstall',
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/automations') {
      handleAutomationCreate(req, res); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/automations/preview') {
      handleAutomationPreview(req, res); return;
    }
    const automationActionMatch = url.pathname.match(/^\/api\/automations\/([^/]+)\/(run|enable|disable)$/);
    if (req.method === 'POST' && automationActionMatch) {
      handleAutomationAction(req, res, automationActionMatch[1], automationActionMatch[2] as 'run' | 'enable' | 'disable'); return;
    }
    const automationReplayMatch = url.pathname.match(/^\/api\/automation-occurrences\/([^/]+)\/replay$/);
    if (req.method === 'POST' && automationReplayMatch) {
      handleAutomationReplay(req, res, automationReplayMatch[1]); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/presence/preferences') {
      if (!passesWriteGate(req, res)) return;
      if (!opts.presence) { sendJson(res, 503, { error: 'Agentic Presence is unavailable' }); return; }
      readJsonBody(req, 16 * 1024).then((body) => {
        try {
          sendJson(res, 200, opts.presence!.updatePreferences({
            ...(typeof body.timezone === 'string' ? { timezone: body.timezone.slice(0, 100) } : {}),
            ...(body.quietStart === null || typeof body.quietStart === 'string' ? { quietStart: body.quietStart as string | null } : {}),
            ...(body.quietEnd === null || typeof body.quietEnd === 'string' ? { quietEnd: body.quietEnd as string | null } : {}),
            ...(Number.isSafeInteger(body.maxInterruptions) ? { maxInterruptions: Number(body.maxInterruptions) } : {}),
            ...(Number.isSafeInteger(body.interruptionWindowMs) ? { interruptionWindowMs: Number(body.interruptionWindowMs) } : {}),
            ...(Number.isSafeInteger(body.cooldownMs) ? { cooldownMs: Number(body.cooldownMs) } : {}),
            ...(typeof body.notificationConsent === 'boolean' ? { notificationConsent: body.notificationConsent } : {}),
            ...(Array.isArray(body.allowedDeliveryClasses) ? { allowedDeliveryClasses: body.allowedDeliveryClasses.filter((value): value is string => typeof value === 'string') } : {}),
            ...(Number.isSafeInteger(body.defaultSnoozeMs) ? { defaultSnoozeMs: Number(body.defaultSnoozeMs) } : {}),
          }));
        } catch (error) { sendJson(res, 400, { error: managementError(error) }); }
      }).catch((error) => sendJson(res, 400, { error: managementError(error) }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/learning/remember') {
      if (!passesWriteGate(req, res)) return;
      if (!opts.learning) { sendJson(res, 503, { error: 'Learning is unavailable' }); return; }
      readJsonBody(req, 32 * 1024).then((body) => {
        try {
          if (typeof body.content !== 'string' || typeof body.subjectKey !== 'string'
            || typeof body.type !== 'string' || typeof body.scopeKind !== 'string'
            || typeof body.idempotencyKey !== 'string') {
            sendJson(res, 400, { error: 'content, subjectKey, type, scopeKind and idempotencyKey are required' }); return;
          }
          sendJson(res, 201, opts.learning!.remember({
            content: body.content.slice(0, 8_001),
            subjectKey: body.subjectKey.slice(0, 513),
            type: body.type as Parameters<WorkbenchLearningPort['remember']>[0]['type'],
            scopeKind: body.scopeKind as Parameters<WorkbenchLearningPort['remember']>[0]['scopeKind'],
            idempotencyKey: body.idempotencyKey.slice(0, 513),
          }));
        } catch (error) { sendJson(res, 400, { error: managementError(error) }); }
      }).catch((error) => sendJson(res, 400, { error: managementError(error) }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/learning/rebuild') {
      if (!passesWriteGate(req, res)) return;
      if (!opts.learning) { sendJson(res, 503, { error: 'Learning is unavailable' }); return; }
      try { sendJson(res, 200, opts.learning.rebuild()); }
      catch (error) { sendJson(res, 400, { error: managementError(error) }); }
      return;
    }
    const learningActionMatch = url.pathname.match(/^\/api\/learning\/([^/]+)\/(edit|rollback|demote|archive|delete)$/);
    if (req.method === 'POST' && learningActionMatch) {
      if (!passesWriteGate(req, res)) return;
      if (!opts.learning) { sendJson(res, 503, { error: 'Learning is unavailable' }); return; }
      const entryId = decodeURIComponent(learningActionMatch[1]);
      const action = learningActionMatch[2] as 'edit' | 'rollback' | 'demote' | 'archive' | 'delete';
      readJsonBody(req, 32 * 1024).then((body) => {
        try {
          if (!Number.isSafeInteger(body.expectedVersion)) {
            sendJson(res, 400, { error: 'expectedVersion is required' }); return;
          }
          const expectedVersion = Number(body.expectedVersion);
          if (action === 'edit') {
            if (typeof body.content !== 'string' || typeof body.idempotencyKey !== 'string') {
              sendJson(res, 400, { error: 'content and idempotencyKey are required' }); return;
            }
            sendJson(res, 200, opts.learning!.edit({ entryId, expectedVersion,
              content: body.content.slice(0, 8_001), idempotencyKey: body.idempotencyKey.slice(0, 513) }));
          } else if (action === 'rollback') {
            if (typeof body.versionId !== 'string' || typeof body.idempotencyKey !== 'string') {
              sendJson(res, 400, { error: 'versionId and idempotencyKey are required' }); return;
            }
            sendJson(res, 200, opts.learning!.rollback({ entryId, expectedVersion,
              versionId: body.versionId.slice(0, 513), idempotencyKey: body.idempotencyKey.slice(0, 513) }));
          } else {
            const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1_000) : 'user request';
            sendJson(res, 200, opts.learning![action]({ entryId, expectedVersion, reason }));
          }
        } catch (error) { sendJson(res, 400, { error: managementError(error) }); }
      }).catch((error) => sendJson(res, 400, { error: managementError(error) }));
      return;
    }
    const presenceActionMatch = url.pathname.match(/^\/api\/presence\/([^/]+)\/(snooze|dismiss|feedback|proposals)$/);
    if (req.method === 'POST' && presenceActionMatch) {
      handlePresenceAction(req, res, presenceActionMatch[1], presenceActionMatch[2] as 'snooze' | 'dismiss' | 'feedback' | 'proposals');
      return;
    }
    const proposalAcceptMatch = url.pathname.match(/^\/api\/presence\/proposals\/([^/]+)\/accept$/);
    if (req.method === 'POST' && proposalAcceptMatch) {
      handlePresenceProposalAccept(req, res, proposalAcceptMatch[1]); return;
    }
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
      sendJson(res, 200, { ok: true, service: 'aiden-workbench-bridge', version: VERSION, readOnly: !writeEnabled });
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

    const jobEventsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
    if (jobEventsMatch) {
      if (!opts.jobs) { sendJson(res, 503, { error: 'durable Job query unavailable' }); return; }
      const afterRaw = Number(url.searchParams.get('after') ?? 0);
      const after = Number.isFinite(afterRaw) && afterRaw >= 0 ? Math.floor(afterRaw) : 0;
      sendJson(res, 200, opts.jobs.listEvents(decodeURIComponent(jobEventsMatch[1]), after));
      return;
    }

    if (url.pathname === '/api/artifacts') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.artifacts) { sendJson(res, 503, { error: 'artifact projection unavailable' }); return; }
      const runRaw = url.searchParams.get('runId');
      const runId = runRaw === null ? undefined : Number(runRaw);
      if (runRaw !== null && !Number.isSafeInteger(runId)) { sendJson(res, 400, { error: 'runId must be an integer' }); return; }
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const artifacts = opts.artifacts.listArtifacts({ runId, sessionId, limit: 100 }).map((artifact) => ({
        id: artifact.id,
        name: path.basename(artifact.path.replace(/\\/g, '/')),
        kind: artifact.kind,
        tool: artifact.tool,
        action: artifact.action,
        runId: artifact.runId,
        taskId: artifact.taskId,
        sessionId: artifact.sessionId,
        createdAt: artifact.createdAt,
        bytes: artifact.bytes,
        preview: artifact.preview,
      }));
      sendJson(res, 200, artifacts);
      return;
    }

    if (url.pathname === '/api/apps') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.apps) { sendJson(res, 503, { error: 'Apps are unavailable' }); return; }
      void opts.apps.snapshot()
        .then((snapshot) => sendJson(res, 200, snapshot))
        .catch((error) => {
          log(`Apps snapshot failed: ${error instanceof Error ? error.message : 'request failed'}`);
          sendJson(res, 503, { error: 'Apps are temporarily unavailable' });
        });
      return;
    }
    if (url.pathname === '/api/automations') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.automations) { sendJson(res, 503, { error: 'Automations are unavailable' }); return; }
      try { sendJson(res, 200, opts.automations.snapshot()); }
      catch (error) { sendJson(res, 503, { error: managementError(error) }); }
      return;
    }
    if (url.pathname === '/api/presence') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.presence) { sendJson(res, 503, { error: 'Agentic Presence is unavailable' }); return; }
      try { sendJson(res, 200, opts.presence.snapshot()); }
      catch (error) { sendJson(res, 503, { error: managementError(error) }); }
      return;
    }
    if (url.pathname === '/api/learning') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.learning) { sendJson(res, 503, { error: 'Learning is unavailable' }); return; }
      try { sendJson(res, 200, opts.learning.snapshot()); }
      catch (error) { sendJson(res, 503, { error: managementError(error) }); }
      return;
    }
    if (url.pathname === '/api/learning/export') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.learning) { sendJson(res, 503, { error: 'Learning is unavailable' }); return; }
      try { sendJson(res, 200, opts.learning.export()); }
      catch (error) { sendJson(res, 503, { error: managementError(error) }); }
      return;
    }
    const learningReviewMatch = url.pathname.match(/^\/api\/learning\/([^/]+)$/);
    if (learningReviewMatch) {
      if (!passesTokenGate(req, res)) return;
      if (!opts.learning) { sendJson(res, 503, { error: 'Learning is unavailable' }); return; }
      try { sendJson(res, 200, opts.learning.review(decodeURIComponent(learningReviewMatch[1]))); }
      catch (error) { sendJson(res, 404, { error: managementError(error) }); }
      return;
    }
    if (url.pathname === '/api/presence/proposals') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.presence) { sendJson(res, 503, { error: 'Agentic Presence is unavailable' }); return; }
      try { sendJson(res, 200, opts.presence.proposals()); }
      catch (error) { sendJson(res, 503, { error: managementError(error) }); }
      return;
    }
    if (url.pathname === '/api/presence/preferences') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.presence) { sendJson(res, 503, { error: 'Agentic Presence is unavailable' }); return; }
      try { sendJson(res, 200, opts.presence.preferences()); }
      catch (error) { sendJson(res, 503, { error: managementError(error) }); }
      return;
    }
    if (url.pathname === '/api/presence/briefing') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.presence) { sendJson(res, 503, { error: 'Agentic Presence is unavailable' }); return; }
      const briefingId = url.searchParams.get('briefingId')?.trim() ?? '';
      if (!briefingId) { sendJson(res, 400, { error: 'briefingId is required' }); return; }
      try { sendJson(res, 200, opts.presence.briefing(briefingId.slice(0, 200))); }
      catch (error) { sendJson(res, 503, { error: managementError(error) }); }
      return;
    }
    const presenceExplainMatch = url.pathname.match(/^\/api\/presence\/([^/]+)\/explain$/);
    if (presenceExplainMatch) {
      if (!passesTokenGate(req, res)) return;
      if (!opts.presence) { sendJson(res, 503, { error: 'Agentic Presence is unavailable' }); return; }
      try { sendJson(res, 200, opts.presence.explain(decodeURIComponent(presenceExplainMatch[1]))); }
      catch (error) { sendJson(res, 404, { error: managementError(error) }); }
      return;
    }
    if (url.pathname === '/api/providers') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.providerSetup) { sendJson(res, 503, { error: 'provider setup is unavailable' }); return; }
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      void opts.providerSetup.snapshot(sessionId)
        .then((snapshot) => sendJson(res, 200, snapshot))
        .catch(() => sendJson(res, 503, { error: 'provider setup is temporarily unavailable' }));
      return;
    }
    const authSessionMatch = url.pathname.match(/^\/api\/providers\/auth-sessions\/([^/]+)$/);
    if (authSessionMatch) {
      if (!passesTokenGate(req, res)) return;
      const session = opts.providerSetup?.authSession(decodeURIComponent(authSessionMatch[1]));
      sendJson(res, session ? 200 : 404, session ?? { error: 'authentication session not found' });
      return;
    }
    if (url.pathname === '/api/workbench/readiness') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.readiness) { sendJson(res, 503, { error: 'readiness projection is unavailable' }); return; }
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      void opts.readiness.snapshot(sessionId)
        .then((snapshot) => sendJson(res, 200, snapshot))
        .catch(() => sendJson(res, 503, { error: 'readiness projection is temporarily unavailable' }));
      return;
    }
    if (url.pathname === '/api/browser/setup') {
      if (!passesTokenGate(req, res)) return;
      if (!opts.browserSetup) { sendJson(res, 503, { error: 'browser setup is unavailable' }); return; }
      void opts.browserSetup.snapshot()
        .then((snapshot) => sendJson(res, 200, snapshot))
        .catch(() => sendJson(res, 503, { error: 'browser setup is temporarily unavailable' }));
      return;
    }
    const artifactContentMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/);
    if (artifactContentMatch) {
      if (!passesTokenGate(req, res)) return;
      if (!opts.artifacts) { sendJson(res, 503, { error: 'artifact projection unavailable' }); return; }
      const content = opts.artifacts.readArtifact(decodeURIComponent(artifactContentMatch[1]));
      if (!content) { sendJson(res, 404, { error: 'artifact not found' }); return; }
      sendArtifact(res, content);
      return;
    }
    const jobProjectionMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/projection$/);
    if (jobProjectionMatch) {
      if (!opts.jobs) { sendJson(res, 503, { error: 'durable Job query unavailable' }); return; }
      const runRaw = url.searchParams.get('runId');
      const runId = runRaw === null ? undefined : Number(runRaw);
      if (runRaw !== null && !Number.isSafeInteger(runId)) {
        sendJson(res, 400, { error: 'runId must be an integer' }); return;
      }
      const attemptId = url.searchParams.get('attemptId') ?? undefined;
      const projection = projectWorkbenchJob(opts.jobs, {
        jobId: decodeURIComponent(jobProjectionMatch[1]), attemptId, runId,
      });
      sendJson(res, projection ? 200 : 404, projection
        ? { ...projection, assistantOutput: projectAssistantOutput(opts.reader, projection.identity.runId) }
        : { error: 'durable projection not found' });
      return;
    }
    const liveExecutionMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/live-execution$/);
    if (liveExecutionMatch) {
      if (!opts.liveExecution) { sendJson(res, 503, { error: 'live execution projection unavailable' }); return; }
      const jobId = decodeURIComponent(liveExecutionMatch[1]);
      const attemptId = url.searchParams.get('attemptId')?.trim() ?? '';
      const generation = Number(url.searchParams.get('generation'));
      const runId = Number(url.searchParams.get('runId'));
      if (!attemptId || !Number.isSafeInteger(generation) || generation < 1
        || !Number.isSafeInteger(runId) || runId < 0) {
        sendJson(res, 400, { error: 'exact attemptId, generation, and runId are required' }); return;
      }
      const projection = opts.liveExecution.get({ jobId, attemptId, generation, runId });
      sendJson(res, projection ? 200 : 404, projection ?? { error: 'exact live execution projection not found' });
      return;
    }
    const browserStateMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/browser$/);
    if (browserStateMatch) {
      if (!opts.browser) { sendJson(res, 503, { error: 'browser authority unavailable' }); return; }
      sendJson(res, 200, { browser: opts.browser.get(decodeURIComponent(browserStateMatch[1])) });
      return;
    }
    const codingStateMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/coding$/);
    if (codingStateMatch) {
      if (!opts.coding) { sendJson(res, 503, { error: 'coding session projection unavailable' }); return; }
      sendJson(res, 200, { sessions: opts.coding.list(decodeURIComponent(codingStateMatch[1])) });
      return;
    }
    if (url.pathname === '/api/coding/health') {
      if (!opts.coding) { sendJson(res, 503, { error: 'coding health unavailable' }); return; }
      void opts.coding.health()
        .then((health) => sendJson(res, 200, health))
        .catch((error) => sendJson(res, 503, { error: error instanceof Error ? error.message : 'coding health unavailable' }));
      return;
    }
    const codingReviewMatch = url.pathname.match(/^\/api\/coding\/promotions\/([^/]+)\/review$/);
    if (codingReviewMatch) {
      if (!passesTokenGate(req, res)) return;
      if (!opts.coding) { sendJson(res, 503, { error: 'coding review unavailable' }); return; }
      void opts.coding.review(decodeURIComponent(codingReviewMatch[1]))
        .then((review) => sendJson(res, 200, review))
        .catch((error) => sendJson(res, 404, {
          error: error instanceof Error ? error.message : String(error),
        }));
      return;
    }

    if (url.pathname === '/api/workbench/bootstrap') {
      const runtime = opts.runtime?.() ?? {};
      let activeJobs: WorkbenchActiveJob[] = [];
      try { activeJobs = opts.activeJobs?.() ?? []; } catch { /* an unavailable store is reported as an empty snapshot */ }
      const execution = opts.execution?.() ?? {
        available: false, runner: 'unavailable' as const, workerCount: 0,
        pending: 0, claimed: 0, inflight: 0, oldestPendingMs: null, processed: 0,
      };
      const activeSummary = summarizeWorkbenchActiveJobs(activeJobs.map((job) => ({
        status: job.status,
        triggerStatus: job.triggerStatus ?? null,
      })));
      sendJson(res, 200, {
        runtime: {
          version: VERSION,
          status: 'ready',
          local: runtime.local !== false,
          edition: runtime.edition ?? 'community',
        },
        provider: runtime.provider ? { id: runtime.provider, displayName: runtime.provider } : { configured: false },
        model: runtime.model ? { id: runtime.model, displayName: runtime.model } : {},
        connection: runtime.connection ?? 'unavailable',
        execution: {
          ...execution,
          pending: activeSummary.queued,
          claimed: activeSummary.claimed,
          inflight: activeSummary.running,
        },
        activeJobCount: activeSummary.total,
        activeJobs: activeJobs.slice(0, 100).map((job) => ({
          sessionId: job.sessionId,
          jobId: job.jobId,
          attemptId: job.attemptId,
          runId: job.runId,
          status: job.status,
          title: job.title,
          statusDetail: job.statusDetail,
          updatedAt: job.updatedAt ?? Date.now(),
          triggerEventId: job.triggerEventId ?? null,
          triggerStatus: job.triggerStatus ?? null,
          queue: job.queue,
        })),
        readOnly: !Boolean(opts.token && opts.enqueue),
      });
      return;
    }
    if (url.pathname === '/api/workbench/capabilities') {
      const capabilities = opts.capabilities?.() ?? {
        modelSwitch: { available: false, reason: 'Runtime capability projection unavailable.' },
        skills: [],
        plugins: [],
      };
      sendJson(res, 200, capabilities);
      return;
    }
    const jobContinuityMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/continuity$/);
    if (jobContinuityMatch) {
      if (!opts.continuity) { sendJson(res, 503, { error: 'continuity query unavailable' }); return; }
      const checkpoint = opts.continuity.getLatest(decodeURIComponent(jobContinuityMatch[1]));
      sendJson(res, checkpoint ? 200 : 404, checkpoint ?? { error: 'continuity checkpoint not found' });
      return;
    }
    const workspaceContinuityMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/continuity$/);
    if (workspaceContinuityMatch) {
      if (!opts.continuity?.resolveForWorkspace) {
        sendJson(res, 503, { error: 'continuity workspace query unavailable' }); return;
      }
      sendJson(res, 200, opts.continuity.resolveForWorkspace(decodeURIComponent(workspaceContinuityMatch[1])));
      return;
    }
    const checkpointMatch = url.pathname.match(/^\/api\/checkpoints\/([^/]+)$/);
    if (checkpointMatch) {
      if (!opts.continuity) { sendJson(res, 503, { error: 'continuity query unavailable' }); return; }
      const checkpoint = opts.continuity.get(decodeURIComponent(checkpointMatch[1]));
      sendJson(res, checkpoint ? 200 : 404, checkpoint ?? { error: 'continuity checkpoint not found' });
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch) {
      if (!opts.jobs) { sendJson(res, 503, { error: 'durable Job query unavailable' }); return; }
      const job = opts.jobs.getJob(decodeURIComponent(jobMatch[1]));
      sendJson(res, job ? 200 : 404, job ?? { error: 'job not found' });
      return;
    }
    const attemptMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)$/);
    if (attemptMatch) {
      if (!opts.jobs) { sendJson(res, 503, { error: 'durable Attempt query unavailable' }); return; }
      const attempt = opts.jobs.getAttempt(decodeURIComponent(attemptMatch[1]));
      sendJson(res, attempt ? 200 : 404, attempt ?? { error: 'attempt not found' });
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
      streamEvents(req, res, { scope: 'run_id', runId, limit: pageLimit }, url.searchParams.get('message') !== '1');
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
    endpoints: ['GET /', 'GET /plain', 'GET /api/health', 'GET /api/workbench/bootstrap', 'GET /api/workbench/capabilities', 'GET /api/workbench/readiness', 'GET /api/providers', 'GET /api/apps', 'GET /api/automations', 'GET /api/presence', 'GET /api/learning', 'GET /api/learning/export', 'GET /api/learning/:id', 'GET /api/presence/proposals', 'GET /api/presence/preferences', 'GET /api/presence/briefing', 'GET /api/presence/:id/explain', 'GET /api/browser/setup', 'GET /api/sessions', 'GET /api/events', 'GET /api/runs/:runId/events', 'GET /api/sessions/:sessionId/events', 'GET /api/jobs/:jobId/projection', 'GET /api/jobs/:jobId/live-execution', 'GET /api/jobs/:jobId/coding', 'GET /api/coding/promotions/:promotionId/review', 'GET /api/jobs/:jobId/continuity', 'GET /api/artifacts', 'GET /api/artifacts/:artifactId/content', 'GET /api/workspaces/:workspaceId/continuity', 'GET /api/checkpoints/:checkpointId', 'POST /api/tasks', 'POST /api/attachments', 'POST /api/tasks/:runId/cancel', 'POST /api/tasks/:runId/input', 'POST /api/tasks/:runId/pause', 'POST /api/tasks/:runId/resume', 'POST /api/approvals/:approvalId/decision', 'POST /api/coding/configure', 'POST /api/coding/promotions/:promotionId/apply', 'POST /api/coding/promotions/:promotionId/discard', 'POST /api/coding/sessions/:codingSessionId/discard', 'POST /api/checkpoints/:checkpointId/continue', 'POST /api/providers/:id/connect', 'POST /api/providers/:id/test', 'POST /api/providers/model/session', 'POST /api/providers/model/default', 'POST /api/apps/providers/:id/configure', 'POST /api/apps/connect', 'POST /api/automations', 'POST /api/automations/preview', 'POST /api/automations/:id/run', 'POST /api/automations/:id/enable', 'POST /api/automations/:id/disable', 'POST /api/automation-occurrences/:id/replay', 'POST /api/presence/preferences', 'POST /api/presence/:id/snooze', 'POST /api/presence/:id/dismiss', 'POST /api/presence/:id/feedback', 'POST /api/presence/:id/proposals', 'POST /api/presence/proposals/:id/accept', 'POST /api/learning/remember', 'POST /api/learning/:id/edit', 'POST /api/learning/:id/rollback', 'POST /api/learning/:id/demote', 'POST /api/learning/:id/archive', 'POST /api/learning/:id/delete', 'POST /api/learning/rebuild'],
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
    const queryLastId = Number(new URL(req.url ?? '/', `http://${host}`).searchParams.get('lastId'));
    if (Number.isFinite(queryLastId) && queryLastId > lastId) lastId = queryLastId;

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
  function passesTokenGate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
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

  function passesWriteGate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    return passesTokenGate(req, res);
  }

  function sendAppsError(res: http.ServerResponse, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Apps request failed';
    const status = /outside the current workspace|not available|not found/i.test(message) ? 404 : 400;
    sendJson(res, status, { error: message.slice(0, 500) });
  }

  function managementError(error: unknown, sensitive: readonly string[] = []): string {
    let message = error instanceof Error ? error.message : 'Request failed';
    for (const value of sensitive) {
      if (value) message = message.split(value).join('[redacted]');
    }
    return message
      .replace(/(?:sk|gsk|key|token|secret)[-_][A-Za-z0-9._-]{4,}/gi, '[redacted]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .slice(0, 500);
  }

  function handleProviderCommand(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawProviderId: string,
    command: 'connect' | 'replace-credential' | 'test' | 'disconnect' | 'refresh-models',
  ): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.providerSetup) { sendJson(res, 503, { error: 'provider setup is unavailable' }); return; }
    const providerId = decodeURIComponent(rawProviderId);
    readJsonBody(req, 300 * 1024).then(async (body) => {
      const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
      const credential = typeof body.credential === 'string' ? body.credential : undefined;
      try {
        if (command === 'disconnect') {
          sendJson(res, 200, await opts.providerSetup!.disconnect(providerId)); return;
        }
        if (command === 'refresh-models') {
          sendJson(res, 200, await opts.providerSetup!.refreshModels(providerId)); return;
        }
        if (!modelId) { sendJson(res, 400, { error: 'modelId is required' }); return; }
        if (command === 'test') {
          sendJson(res, 200, await opts.providerSetup!.test({ providerId, modelId, ...(credential ? { credential } : {}) }));
          return;
        }
        if (!credential) { sendJson(res, 400, { error: 'credential is required' }); return; }
        const result = command === 'connect'
          ? await opts.providerSetup!.connectApiKey({ providerId, modelId, credential })
          : await opts.providerSetup!.replaceCredential({ providerId, modelId, credential });
        sendJson(res, 200, result);
      } catch (error) { sendJson(res, 400, { error: managementError(error, credential ? [credential] : []) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleCodingConfigure(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.coding) { sendJson(res, 503, { error: 'External coding is unavailable' }); return; }
    readJsonBody(req, 8 * 1024).then(async (body) => {
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!model) { sendJson(res, 400, { error: 'model is required' }); return; }
      try { sendJson(res, 200, await opts.coding!.configure({ model })); }
      catch (error) { sendJson(res, 400, { error: managementError(error) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleProviderOAuth(req: http.IncomingMessage, res: http.ServerResponse, rawProviderId: string): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.providerSetup) { sendJson(res, 503, { error: 'provider setup is unavailable' }); return; }
    req.resume();
    void opts.providerSetup.startOAuth(decodeURIComponent(rawProviderId))
      .then((session) => sendJson(res, 202, session))
      .catch((error) => sendJson(res, 400, { error: managementError(error) }));
  }

  function handleProviderModelChange(req: http.IncomingMessage, res: http.ServerResponse, scope: 'session' | 'default'): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.providerSetup) { sendJson(res, 503, { error: 'provider setup is unavailable' }); return; }
    readJsonBody(req, 16 * 1024).then(async (body) => {
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
      const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      if (!providerId || !modelId || (scope === 'session' && !sessionId)) {
        sendJson(res, 400, { error: scope === 'session' ? 'sessionId, providerId and modelId are required' : 'providerId and modelId are required' });
        return;
      }
      try {
        const result = scope === 'session'
          ? await opts.providerSetup!.setSessionModel({ sessionId, providerId, modelId })
          : await opts.providerSetup!.setDefaultModel({ providerId, modelId });
        sendJson(res, 200, result);
      } catch (error) { sendJson(res, 400, { error: managementError(error) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleAppsProviderConfigure(req: http.IncomingMessage, res: http.ServerResponse, rawProviderId: string): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.apps) { sendJson(res, 503, { error: 'Apps are unavailable' }); return; }
    readJsonBody(req, 300 * 1024).then(async (body) => {
      const credential = typeof body.credential === 'string' ? body.credential : '';
      if (!credential.trim()) { sendJson(res, 400, { error: 'credential is required' }); return; }
      try {
        sendJson(res, 200, await opts.apps!.configureProvider({
          providerId: decodeURIComponent(rawProviderId), credential,
        }));
      } catch (error) { sendJson(res, 400, { error: managementError(error, [credential]) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleBrowserGrant(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.browserSetup) { sendJson(res, 503, { error: 'browser setup is unavailable' }); return; }
    readJsonBody(req, 4 * 1024).then(async (body) => {
      if (body.confirmed !== true) { sendJson(res, 400, { error: 'browser permission grant requires confirmed=true' }); return; }
      try { sendJson(res, 200, await opts.browserSetup!.grant({ confirmed: true })); }
      catch (error) { sendJson(res, 400, { error: managementError(error) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleCapabilityInstall(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.capabilityManagement) { sendJson(res, 503, { error: 'Capability management is unavailable' }); return; }
    readJsonBody(req, 8 * 1024).then(async (body) => {
      if (typeof body.path !== 'string' || body.path.trim().length === 0) {
        sendJson(res, 400, { error: 'A local capability folder is required' }); return;
      }
      try {
        const installed = await opts.capabilityManagement!.install(body.path.trim());
        sendJson(res, 201, { capabilityId: installed.capabilityId, snapshot: opts.capabilityManagement!.snapshot() });
      } catch (error) {
        sendJson(res, 400, { error: managementError(error, [body.path]) });
      }
    }).catch((error) => sendJson(res, 400, { error: managementError(error) }));
  }

  function handleCapabilityAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    capabilityId: string,
    action: 'activate' | 'rollback' | 'disable' | 'test' | 'uninstall',
  ): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.capabilityManagement) { sendJson(res, 503, { error: 'Capability management is unavailable' }); return; }
    readJsonBody(req, 8 * 1024).then(async (body) => {
      try {
        if (action === 'activate') {
          if (typeof body.version !== 'string') throw new Error('Exact version is required');
          opts.capabilityManagement!.activate({
            capabilityId,
            version: body.version,
            acceptPermissions: body.acceptPermissions === true,
          });
        } else if (action === 'uninstall') {
          if (typeof body.version !== 'string') throw new Error('Exact version is required');
          await opts.capabilityManagement!.uninstall({ capabilityId, version: body.version });
        } else if (action === 'test') {
          await opts.capabilityManagement!.test(capabilityId);
        } else {
          opts.capabilityManagement![action](capabilityId);
        }
        sendJson(res, 200, opts.capabilityManagement!.snapshot());
      } catch (error) {
        sendJson(res, 400, { error: managementError(error) });
      }
    }).catch((error) => sendJson(res, 400, { error: managementError(error) }));
  }

  function handleAutomationCreate(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.automations) { sendJson(res, 503, { error: 'Automations are unavailable' }); return; }
    readJsonBody(req, 64 * 1024).then((body) => {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || !body.action || !body.trigger || !body.policies) {
        sendJson(res, 400, { error: 'name, action, trigger and policies are required' }); return;
      }
      try {
        const result = opts.automations!.create({
          name,
          action: body.action as never,
          trigger: body.trigger as never,
          policies: body.policies as never,
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((v): v is string => typeof v === 'string') : [],
          credentialRefs: Array.isArray(body.credentialRefs) ? body.credentialRefs.filter((v): v is string => typeof v === 'string') : [],
          ...(body.budget && typeof body.budget === 'object' && !Array.isArray(body.budget)
            ? { budget: body.budget as never } : {}),
          ...(body.approval && typeof body.approval === 'object' && !Array.isArray(body.approval)
            ? { approval: body.approval as never } : {}),
          ...(body.delivery && typeof body.delivery === 'object' && !Array.isArray(body.delivery)
            ? { delivery: body.delivery as never } : {}),
          createdBy: 'workbench',
        });
        sendJson(res, 201, result);
      } catch (error) { sendJson(res, 400, { error: managementError(error) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleAutomationPreview(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.automations) { sendJson(res, 503, { error: 'Automations are unavailable' }); return; }
    readJsonBody(req, 8 * 1024).then((body) => {
      const expression = typeof body.expression === 'string' ? body.expression.trim() : '';
      const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
      if (!expression || !timezone) { sendJson(res, 400, { error: 'expression and timezone are required' }); return; }
      try { sendJson(res, 200, { instants: opts.automations!.preview({ expression, timezone, count: 5 }) }); }
      catch (error) { sendJson(res, 400, { error: managementError(error) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleAutomationAction(req: http.IncomingMessage, res: http.ServerResponse, rawId: string, action: 'run' | 'enable' | 'disable'): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.automations) { sendJson(res, 503, { error: 'Automations are unavailable' }); return; }
    req.resume();
    try {
      const automationId = decodeURIComponent(rawId);
      const result = action === 'run'
        ? opts.automations.runNow(automationId)
        : opts.automations.setEnabled(automationId, action === 'enable');
      sendJson(res, action === 'run' ? 202 : 200, result);
    } catch (error) { sendJson(res, 400, { error: managementError(error) }); }
  }

  function handleAutomationReplay(req: http.IncomingMessage, res: http.ServerResponse, rawId: string): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.automations) { sendJson(res, 503, { error: 'Automations are unavailable' }); return; }
    req.resume();
    try { sendJson(res, 202, opts.automations.replay(decodeURIComponent(rawId))); }
    catch (error) { sendJson(res, 400, { error: managementError(error) }); }
  }

  function handlePresenceAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawId: string,
    action: 'snooze' | 'dismiss' | 'feedback' | 'proposals',
  ): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.presence) { sendJson(res, 503, { error: 'Agentic Presence is unavailable' }); return; }
    readJsonBody(req, 16 * 1024).then((body) => {
      const itemId = decodeURIComponent(rawId);
      const expectedVersion = Number(body.expectedVersion);
      try {
        if (action === 'snooze') {
          const until = Number(body.until);
          if (!Number.isSafeInteger(expectedVersion) || !Number.isFinite(until)) {
            sendJson(res, 400, { error: 'expectedVersion and until are required' }); return;
          }
          sendJson(res, 200, opts.presence!.snooze({ itemId, expectedVersion, until })); return;
        }
        if (action === 'dismiss') {
          if (!Number.isSafeInteger(expectedVersion)) { sendJson(res, 400, { error: 'expectedVersion is required' }); return; }
          const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : undefined;
          sendJson(res, 200, opts.presence!.dismiss({ itemId, expectedVersion, ...(reason ? { reason } : {}) })); return;
        }
        if (action === 'feedback') {
          const kind = String(body.kind ?? '');
          if (!['helpful', 'not_helpful', 'too_frequent', 'wrong_priority'].includes(kind)) {
            sendJson(res, 400, { error: 'valid feedback kind is required' }); return;
          }
          sendJson(res, 202, opts.presence!.feedback({ itemId, kind: kind as 'helpful' | 'not_helpful' | 'too_frequent' | 'wrong_priority' })); return;
        }
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
        const expiresAt = body.expiresAt === null || body.expiresAt === undefined ? undefined : Number(body.expiresAt);
        if (!prompt || !goal || (expiresAt !== undefined && !Number.isFinite(expiresAt))) {
          sendJson(res, 400, { error: 'prompt and goal are required' }); return;
        }
        sendJson(res, 201, opts.presence!.propose({ itemId, prompt, goal, ...(expiresAt !== undefined ? { expiresAt } : {}) }));
      } catch (error) { sendJson(res, 409, { error: managementError(error) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handlePresenceProposalAccept(req: http.IncomingMessage, res: http.ServerResponse, rawId: string): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.presence) { sendJson(res, 503, { error: 'Agentic Presence is unavailable' }); return; }
    readJsonBody(req, 8 * 1024).then((body) => {
      const expectedVersion = Number(body.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion)) { sendJson(res, 400, { error: 'expectedVersion is required' }); return; }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined;
      try {
        const result = opts.presence!.acceptProposal({
          proposalId: decodeURIComponent(rawId), expectedVersion, ...(sessionId ? { sessionId } : {}),
        });
        sendJson(res, result.state === 'accepted' ? 202 : 409, result);
      } catch (error) { sendJson(res, 409, { error: managementError(error) }); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleAppsConnect(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.apps) { sendJson(res, 503, { error: 'Apps are unavailable' }); return; }
    readJsonBody(req, 16 * 1024).then(async (body) => {
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
      const toolkitId = typeof body.toolkitId === 'string' ? body.toolkitId.trim() : '';
      const label = typeof body.label === 'string' ? body.label.trim() : undefined;
      if (!providerId || !toolkitId) {
        sendJson(res, 400, { error: 'providerId and toolkitId are required' }); return;
      }
      try {
        sendJson(res, 202, await opts.apps!.connect({
          providerId,
          toolkitId,
          ...(label ? { label } : {}),
        }));
      } catch (error) { sendAppsError(res, error); }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleAppsComplete(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawConnectionId: string,
  ): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.apps) { sendJson(res, 503, { error: 'Apps are unavailable' }); return; }
    req.resume();
    void opts.apps.complete(decodeURIComponent(rawConnectionId))
      .then((account) => sendJson(res, 200, { account }))
      .catch((error) => sendAppsError(res, error));
  }

  function handleAppsAccount(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawAccountId: string,
    action: 'refresh' | 'reconnect' | 'disconnect',
  ): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.apps) { sendJson(res, 503, { error: 'Apps are unavailable' }); return; }
    const accountId = decodeURIComponent(rawAccountId);
    if (action === 'disconnect') {
      readJsonBody(req, 4 * 1024).then(async (body) => {
        if (body.confirmed !== true) {
          sendJson(res, 400, { error: 'disconnect requires confirmed=true' }); return;
        }
        try { sendJson(res, 200, { account: await opts.apps!.disconnect(accountId) }); }
        catch (error) { sendAppsError(res, error); }
      }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
      return;
    }
    req.resume();
    const operation = action === 'refresh'
      ? opts.apps.refresh(accountId).then((account) => ({ account }))
      : opts.apps.reconnect(accountId);
    void operation.then((result) => sendJson(res, action === 'reconnect' ? 202 : 200, result))
      .catch((error) => sendAppsError(res, error));
  }

  function handleAttachmentUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.attachments) { sendJson(res, 503, { error: 'attachment upload unavailable' }); return; }
    readJsonBody(req, 12 * 1024 * 1024).then((body) => {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const mime = typeof body.mime === 'string' ? body.mime.trim() : undefined;
      const base64 = typeof body.base64 === 'string' ? body.base64 : '';
      if (!name || !base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
        sendJson(res, 400, { error: 'body requires a valid file name and base64 content' });
        return;
      }
      try {
        const attachment = opts.attachments!.saveAttachment({ name, mime, bytes: Buffer.from(base64, 'base64') });
        sendJson(res, 201, {
          id: attachment.id,
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
        });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'attachment upload failed' });
      }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handlePostTask(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!passesWriteGate(req, res)) return;
    readJsonBody(req, 64 * 1024).then((body) => {
      const message = typeof body?.message === 'string' ? stripPasteMarkers(body.message).trim() : '';
      if (!message) { sendJson(res, 400, { error: 'body requires a non-empty "message"' }); return; }
      if (!opts.enqueue) { sendJson(res, 503, { error: 'task execution unavailable (daemon not wired)' }); return; }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
      try {
        const attachmentIds = Array.isArray(body.attachmentIds)
          ? body.attachmentIds.filter((id): id is string => typeof id === 'string').slice(0, 20)
          : [];
        if (attachmentIds.length > 0 && !opts.attachments) {
          sendJson(res, 400, { error: 'attachments are unavailable' }); return;
        }
        let attachments: WorkbenchAttachment[] = [];
        try {
          attachments = attachmentIds.length > 0 ? opts.attachments!.resolveAttachments(attachmentIds) : [];
        } catch {
          sendJson(res, 400, { error: 'one or more attachment identities are invalid' }); return;
        }
        const durableMessage = attachments.length > 0
          ? `${message}\n\nWorkbench attachments (runtime-mediated local references):\n${attachments.map((item) => `- ${item.name}: ${item.path}`).join('\n')}`
          : message;
        const result = opts.enqueue.enqueue({ message: durableMessage, sessionId });
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

  function handleTaskInput(req: http.IncomingMessage, res: http.ServerResponse, rawRunId: string): void {
    if (!passesWriteGate(req, res)) return;
    const runId = Number(decodeURIComponent(rawRunId));
    if (!Number.isFinite(runId)) { sendJson(res, 400, { error: 'runId must be numeric' }); return; }
    if (!opts.input) { sendJson(res, 503, { error: 'durable input unavailable' }); return; }
    readJsonBody(req, 64 * 1024).then((body) => {
      const content = typeof body.message === 'string' ? stripPasteMarkers(body.message) : '';
      if (!content.trim()) { sendJson(res, 400, { error: 'body requires a non-empty "message"' }); return; }
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
      const result = opts.input!.receive(runId, content, key);
      sendJson(res, result.accepted ? 202 : 409, {
        accepted: result.accepted,
        runId,
        input_id: result.inputId,
        duplicate: result.duplicate ?? false,
      });
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleTaskControl(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawRunId: string,
    kind: 'pause' | 'resume',
  ): void {
    if (!passesWriteGate(req, res)) return;
    const runId = Number(decodeURIComponent(rawRunId));
    if (!Number.isFinite(runId)) { sendJson(res, 400, { error: 'runId must be numeric' }); return; }
    if (!opts.control) { sendJson(res, 503, { error: `${kind} unavailable` }); return; }
    readJsonBody(req, 16 * 1024).then((body) => {
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
      const result = kind === 'pause'
        ? opts.control!.pause(runId, key)
        : opts.control!.resume(runId, key);
      sendJson(res, result.accepted ? 202 : 409, result);
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleApprovalDecision(req: http.IncomingMessage, res: http.ServerResponse, rawApprovalId: string): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.approval) { sendJson(res, 503, { error: 'approval decisions unavailable' }); return; }
    const approvalId = decodeURIComponent(rawApprovalId);
    readJsonBody(req, 16 * 1024).then((body) => {
      const decision = body.decision;
      if (decision !== 'approved' && decision !== 'denied' && decision !== 'cancelled') {
        sendJson(res, 400, { error: 'decision must be approved, denied, or cancelled' });
        return;
      }
      try {
        const result = opts.approval!.decide(approvalId, decision);
        sendJson(res, result.accepted ? 202 : 409, result);
      } catch {
        sendJson(res, 409, { accepted: false, error: 'Approval is no longer actionable' });
      }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleContinueTask(req: http.IncomingMessage, res: http.ServerResponse, rawCheckpointId: string): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.continueTask || !opts.continuity) { sendJson(res, 503, { error: 'safe continuation unavailable' }); return; }
    readJsonBody(req, 16 * 1024).then(async (body) => {
      const key = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0
        ? body.idempotencyKey : '';
      const jobId = typeof body.jobId === 'string' && body.jobId.length > 0 ? body.jobId : '';
      if (!key || !jobId) { sendJson(res, 400, { error: 'body requires jobId and idempotencyKey' }); return; }
      try {
        const checkpointId = decodeURIComponent(rawCheckpointId);
        const checkpoint = opts.continuity!.get(checkpointId) as { jobId?: unknown } | null;
        if (!checkpoint || checkpoint.jobId !== jobId) {
          sendJson(res, 409, { accepted: false, error: 'checkpoint does not belong to the requested Job' });
          return;
        }
        const result = await opts.continueTask!.continue(checkpointId, key) as { decision?: string };
        const accepted = result?.decision === 'continued' || result?.decision === 'already_applied';
        sendJson(res, accepted ? 202 : 409, { accepted, ...result });
      } catch (error) {
        log(`continue failed: ${error instanceof Error ? error.message : String(error)}`);
        sendJson(res, 409, { accepted: false, error: error instanceof Error ? error.message : String(error) });
      }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleBrowserControl(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawJobId: string,
    action: 'take' | 'return' | 'clear',
  ): void {
    if (!passesWriteGate(req, res)) return;
    req.resume();
    if (!opts.browser) { sendJson(res, 503, { error: 'browser authority unavailable' }); return; }
    const jobId = decodeURIComponent(rawJobId);
    Promise.resolve(opts.browser[action](jobId)).then((browser) => {
      sendJson(res, 202, { accepted: true, browser });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`browser ${action} failed: ${message}`);
      sendJson(res, 409, { accepted: false, error: message });
    });
  }

  function handleCodingDecision(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawPromotionId: string,
    decision: 'apply' | 'discard',
  ): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.coding) { sendJson(res, 503, { error: 'coding review unavailable' }); return; }
    readJsonBody(req, 4 * 1024).then(async (body) => {
      if (body.confirmed !== true) {
        sendJson(res, 400, { error: `${decision} requires confirmed=true` });
        return;
      }
      try {
        const promotionId = decodeURIComponent(rawPromotionId);
        const result = decision === 'apply'
          ? await opts.coding!.apply(promotionId)
          : await opts.coding!.discard(promotionId);
        sendJson(res, 202, { accepted: true, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`coding ${decision} failed: ${message}`);
        sendJson(res, 409, { accepted: false, error: message });
      }
    }).catch(() => sendJson(res, 400, { error: 'invalid JSON body' }));
  }

  function handleUnknownCodingDiscard(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawCodingSessionId: string,
  ): void {
    if (!passesWriteGate(req, res)) return;
    if (!opts.coding) { sendJson(res, 503, { error: 'coding reconciliation unavailable' }); return; }
    readJsonBody(req, 4 * 1024).then(async (body) => {
      if (body.confirmed !== true) {
        sendJson(res, 400, { error: 'discard requires confirmed=true' });
        return;
      }
      try {
        const result = await opts.coding!.discardUnknown(decodeURIComponent(rawCodingSessionId));
        sendJson(res, 202, { accepted: true, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`coding reconciliation discard failed: ${message}`);
        sendJson(res, 409, { accepted: false, error: message });
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
