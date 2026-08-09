/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

/** A run event exactly as the Workbench bridge streams it. */
export interface V4Event {
  id: number;
  runId: number;
  sessionId: string | null;
  ts: number;
  category: string;
  kind: string;
  name: string | null;
  status: string | null;
  durationMs: number | null;
  summary: string | null;
  payload: any;
}

export interface SessionSummary {
  id: string;
  label: string;
  lastActive: number;
  provider?: string | null;
  model?: string | null;
}

export interface ActivityItem {
  kind: 'tool' | 'verify' | 'note';
  label: string;
  detail?: string;
  status: 'running' | 'ok' | 'failed' | 'warn';
}

export type WorkbenchConnectionState =
  | 'connected' | 'reconnecting' | 'stalled' | 'uncertain' | 'terminal';

export interface TurnHandlers {
  onAdmission?: (admission: TaskAdmission) => void;
  onRunId?: (runId: number) => void;
  onReply?: (chunk: string) => void;
  onThinking?: (stage: string, message: string) => void;
  onActivity?: (item: ActivityItem) => void;
  onTokens?: (total: number) => void;
  onDone?: (info: { stopped?: boolean; summary?: string; status?: string }) => void;
  onError?: (message: string) => void;
  onConnectionState?: (state: WorkbenchConnectionState) => void;
}

/** Exact durable identity returned by task admission. Event order is never an
 * identity source. */
export interface TaskAdmission {
  accepted: true;
  jobId: string;
  attemptId: string;
  runId: number;
  triggerEventId?: number;
  duplicate: boolean;
}

/** Reload-safe client handle. Presentation is rebuilt from durable records. */
export interface WorkbenchRunHandle {
  admission: TaskAdmission;
  lastEventId: number;
}

const ACTIVE_RUN_STORAGE_KEY = 'aiden.workbench.active-run.v1';

function admissionFromSearch(search: string): TaskAdmission | null {
  const query = new URLSearchParams(search);
  const jobId = requiredString(query.get('job'));
  const attemptId = requiredString(query.get('attempt'));
  const runRaw = query.get('run');
  const runId = runRaw === null ? Number.NaN : Number(runRaw);
  if (!jobId || !attemptId || !Number.isSafeInteger(runId) || runId < 0) return null;
  return { accepted: true, jobId, attemptId, runId, duplicate: false };
}

export function persistRunHandle(handle: WorkbenchRunHandle): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(handle));
  if (window.location && window.history?.replaceState) {
    const next = new URL(window.location.href);
    next.searchParams.set('job', handle.admission.jobId);
    next.searchParams.set('attempt', handle.admission.attemptId);
    next.searchParams.set('run', String(handle.admission.runId));
    window.history.replaceState(window.history.state, '', next);
  }
}

export function clearRunHandle(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
  if (window.location && window.history?.replaceState) {
    const next = new URL(window.location.href);
    next.searchParams.delete('job');
    next.searchParams.delete('attempt');
    next.searchParams.delete('run');
    window.history.replaceState(window.history.state, '', next);
  }
}

export function restoreRunHandle(): WorkbenchRunHandle | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  const linked = window.location ? admissionFromSearch(window.location.search) : null;
  const raw = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
  if (!raw) return linked ? { admission: linked, lastEventId: 0 } : null;
  try {
    const value = JSON.parse(raw) as { admission?: unknown; lastEventId?: unknown };
    const stored = value.admission && typeof value.admission === 'object'
      ? value.admission as Record<string, unknown> : {};
    const admission = parseTaskAdmission({
      accepted: stored.accepted,
      job_id: stored.jobId,
      attempt_id: stored.attemptId,
      run_id: stored.runId,
      triggerEventId: stored.triggerEventId,
      duplicate: stored.duplicate,
    });
    const lastEventId = typeof value.lastEventId === 'number'
      && Number.isSafeInteger(value.lastEventId) && value.lastEventId >= 0
      ? value.lastEventId : 0;
    if (linked && (
      linked.jobId !== admission.jobId
      || linked.attemptId !== admission.attemptId
      || linked.runId !== admission.runId
    )) return { admission: linked, lastEventId: 0 };
    return { admission: linked ?? admission, lastEventId };
  } catch {
    window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
    return linked ? { admission: linked, lastEventId: 0 } : null;
  }
}

export interface WorkbenchResultReceipt {
  terminal: boolean;
  status: string;
  summary?: string | null;
  stopped?: boolean;
  verdict?: { verdict: string } | null;
}

export interface WorkbenchRunProjection {
  identity: { jobId: string; attemptId: string; runId: number; generation?: number };
  receipt: WorkbenchResultReceipt;
  attempts?: Array<{ id: string; generation: number; status: string }>;
  timeline?: Array<{ eventId: number; jobSequence: number; type: string; createdAt: number }>;
  workers?: unknown[];
  approvals?: unknown[];
  evidence?: unknown[];
  verification?: unknown;
}

export interface WorkbenchRuntimeInfo {
  service: 'aiden-workbench-bridge';
  version: string;
  readOnly: boolean;
}

export interface ContinuityCheckpointView {
  checkpointId: string;
  jobId: string;
  attemptId: string;
  attemptGeneration: number;
  reason: string;
  validity: string;
  blockers: string[];
  proposedNext: string[];
}

function token(): string {
  if (typeof window === 'undefined') return '';
  return (window as any).__WB_TOKEN__ || '';
}

export function hasWriteToken(): boolean { return token().length > 0; }

export async function listSessions(): Promise<SessionSummary[]> {
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) return [];
    const value = await response.json();
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export async function cancelTask(target: number | WorkbenchRunHandle | null): Promise<boolean> {
  const runId = typeof target === 'number' ? target : target?.admission.runId ?? null;
  if (runId == null) return false;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(String(runId))}/cancel`, {
      method: 'POST', headers: { 'x-workbench-token': token() },
    });
    if (!response.ok) return false;
    const body = await response.json() as { accepted?: unknown; runId?: unknown };
    return body.accepted === true && Number(body.runId) === runId;
  } catch { return false; }
}

const TOOL_VERB: Record<string, string> = {
  file_read: 'Read', file_list: 'List', fetch_url: 'Fetch', fetch_page: 'Fetch', open_url: 'Open',
  web_search: 'Search', deep_research: 'Research', execute_code: 'Run code', read_pdf: 'Read PDF',
  browser_screenshot: 'Screenshot', browser_click: 'Click', browser_type: 'Type', browser_extract: 'Extract',
  screenshot: 'Screenshot',
};
function verb(name: string): string {
  if (TOOL_VERB[name]) return TOOL_VERB[name];
  const value = String(name || 'tool').replace(/_/g, ' ');
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface TurnState { gotReply: boolean }
type RoutedTerminal =
  | { kind: 'candidate' }
  | { kind: 'cancelled' }
  | { kind: 'rejected'; message: string };

function routeEvent(ev: V4Event, handlers: TurnHandlers, state: TurnState): RoutedTerminal | null {
  const name = ev.name || ev.kind || '';
  const payload = ev.payload || {};
  switch (name) {
    case 'assistant_message':
      state.gotReply = true;
      handlers.onReply?.(String(payload.text ?? ''));
      return null;
    case 'tool_call_started':
      handlers.onActivity?.({ kind: 'tool', label: verb(payload.toolName || 'tool'), status: 'running' });
      return null;
    case 'tool_call_completed':
      handlers.onActivity?.({
        kind: 'tool', label: verb(payload.toolName || 'tool'),
        detail: ev.durationMs != null ? `${ev.durationMs} ms` : undefined,
        status: ev.status === 'failed' ? 'failed' : 'ok',
      });
      return null;
    case 'artifact_verified': {
      const presentation = payload.presentation && typeof payload.presentation === 'object'
        ? payload.presentation as Record<string, unknown> : undefined;
      const kind: string =
        (payload.outcome && typeof payload.outcome === 'object' && payload.outcome.kind)
        || (payload.verified ? 'verified' : 'unverifiable');
      const ok = kind === 'verified';
      const label = typeof presentation?.label === 'string' ? presentation.label
        : kind === 'verified' ? 'Verified'
          : kind === 'no_evidence' ? 'No evidence'
            : kind === 'failed' ? 'Failed' : 'Unverified';
      const severity = presentation?.severity;
      handlers.onActivity?.({
        kind: 'verify', label, detail: payload.verdict,
        status: severity === 'error' || severity === 'warning' ? 'warn' : ok ? 'ok' : 'warn',
      });
      return null;
    }
    case 'cost_updated':
      if (payload.totalTokens != null) handlers.onTokens?.(payload.totalTokens);
      return null;
    case 'ui_task_update':
      handlers.onThinking?.(
        String(payload.stage || 'working'),
        String(payload.text || payload.message || `step ${payload.step ?? ''}`),
      );
      return null;
    case 'ui_task_done':
      if (!state.gotReply && payload.summary) {
        state.gotReply = true;
        handlers.onReply?.(String(payload.summary));
      }
      return { kind: 'candidate' };
    case 'task_cancelled':
      return { kind: 'cancelled' };
    default:
      break;
  }
  if (ev.kind === 'dispatcher.completed') return { kind: 'candidate' };
  if (ev.kind === 'dispatcher.rejected' || ev.kind === 'dispatcher.builder_failed') {
    return { kind: 'rejected', message: ev.summary || 'the run could not start' };
  }
  return null;
}

const IDLE_MS = 25_000;

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function parseTaskAdmission(value: unknown): TaskAdmission {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const jobId = requiredString(body.job_id);
  const attemptId = requiredString(body.attempt_id);
  const runId = typeof body.run_id === 'number' && Number.isSafeInteger(body.run_id) && body.run_id >= 0
    ? body.run_id : null;
  if (body.accepted !== true || !jobId || !attemptId || runId === null) {
    throw new Error('task admission did not return one exact Job, Attempt, and run identity');
  }
  const triggerEventId = typeof body.triggerEventId === 'number' && Number.isSafeInteger(body.triggerEventId)
    ? body.triggerEventId : undefined;
  return { accepted: true, jobId, attemptId, runId, triggerEventId, duplicate: body.duplicate === true };
}

export async function admitTask(message: string, sessionId?: string): Promise<WorkbenchRunHandle> {
  let response: Response;
  try {
    response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
      body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }),
    });
  } catch { throw new Error('could not reach Aiden (is `aiden web` running?)'); }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* classified below */ }
  if (!response.ok) {
    const detail = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? String((body as { error: string }).error) : `send failed (HTTP ${response.status})`;
    if (response.status === 401 || response.status === 503) {
      throw new Error('writes are disabled — open the dashboard via `aiden web` (it carries the local token)');
    }
    throw new Error(detail);
  }
  const handle = { admission: parseTaskAdmission(body), lastEventId: 0 };
  persistRunHandle(handle);
  return handle;
}

export async function loadRunProjection(jobId: string, attemptId?: string, runId?: number): Promise<WorkbenchRunProjection | null> {
  const query = new URLSearchParams();
  if (attemptId) query.set('attemptId', attemptId);
  if (runId !== undefined) query.set('runId', String(runId));
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/projection?${query.toString()}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`durable run projection unavailable (HTTP ${response.status})`);
  return response.json() as Promise<WorkbenchRunProjection>;
}

export async function loadRuntimeInfo(): Promise<WorkbenchRuntimeInfo> {
  const response = await fetch('/api/health');
  if (!response.ok) throw new Error(`Workbench runtime metadata unavailable (HTTP ${response.status})`);
  const body = await response.json() as Partial<WorkbenchRuntimeInfo>;
  if (body.service !== 'aiden-workbench-bridge' || typeof body.version !== 'string' || !body.version.trim()) {
    throw new Error('Workbench runtime metadata is invalid');
  }
  return { service: body.service, version: body.version, readOnly: body.readOnly === true };
}

export async function loadContinuity(jobId: string): Promise<ContinuityCheckpointView | null> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/continuity`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`continuity unavailable (HTTP ${response.status})`);
  return response.json() as Promise<ContinuityCheckpointView>;
}

export async function continueTask(checkpointId: string, jobId: string, idempotencyKey: string): Promise<{
  accepted: boolean; decision?: string; reason?: string; attemptId?: string; generation?: number; runId?: number;
}> {
  const response = await fetch(`/api/checkpoints/${encodeURIComponent(checkpointId)}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
    body: JSON.stringify({ jobId, idempotencyKey }),
  });
  const body = await response.json() as {
    accepted?: unknown; decision?: string; reason?: string; attemptId?: string; generation?: number; runId?: number;
  };
  return {
    accepted: response.ok && body.accepted === true,
    decision: body.decision,
    reason: body.reason,
    ...(typeof body.attemptId === 'string' ? { attemptId: body.attemptId } : {}),
    ...(typeof body.generation === 'number' ? { generation: body.generation } : {}),
    ...(typeof body.runId === 'number' ? { runId: body.runId } : {}),
  };
}

function projectionMatches(handle: WorkbenchRunHandle, projection: WorkbenchRunProjection): boolean {
  const identity = projection?.identity;
  return identity?.jobId === handle.admission.jobId
    && identity?.attemptId === handle.admission.attemptId
    && identity?.runId === handle.admission.runId;
}

export type RestoredRunResolution =
  | { kind: 'missing' }
  | { kind: 'terminal'; projection: WorkbenchRunProjection }
  | { kind: 'active'; projection: WorkbenchRunProjection };

/** Resolve persisted browser state against exact durable identity before SSE.
 * A stored handle is only a reconnect hint; the durable projection owns truth. */
export async function reconcileRestoredRunHandle(handle: WorkbenchRunHandle): Promise<RestoredRunResolution> {
  const projection = await loadRunProjection(
    handle.admission.jobId,
    handle.admission.attemptId,
    handle.admission.runId,
  );
  if (!projection || !projectionMatches(handle, projection)) return { kind: 'missing' };
  return projection.receipt.terminal
    ? { kind: 'terminal', projection }
    : { kind: 'active', projection };
}

async function readProjection(handle: WorkbenchRunHandle): Promise<WorkbenchRunProjection> {
  const response = await fetch(
    `/api/jobs/${encodeURIComponent(handle.admission.jobId)}/projection`
    + `?attemptId=${encodeURIComponent(handle.admission.attemptId)}&runId=${handle.admission.runId}`,
  );
  if (!response.ok) throw new Error(`durable run projection unavailable (HTTP ${response.status})`);
  const projection = await response.json() as WorkbenchRunProjection;
  if (!projectionMatches(handle, projection)) throw new Error('durable run projection identity mismatch');
  return projection;
}

export interface FollowRunOptions {
  stallMs?: number;
  signal?: AbortSignal;
  /** Optional restored-run safety bound. Normal admitted runs leave this unset. */
  maxUncertainMs?: number;
}

export function followRun(
  handle: WorkbenchRunHandle,
  handlers: TurnHandlers,
  options: FollowRunOptions = {},
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let terminalCheck = false;
    let uncertainSince: number | null = null;
    let stall: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    const state: TurnState = { gotReply: false };
    const stallMs = Math.max(1, options.stallMs ?? IDLE_MS);
    const maxUncertainMs = options.maxUncertainMs === undefined
      ? null : Math.max(1, options.maxUncertainMs);

    const cleanup = (): void => {
      if (stall) clearTimeout(stall);
      options.signal?.removeEventListener('abort', abort);
      try { es?.close(); } catch { /* noop */ }
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const finish = (info: { stopped?: boolean; summary?: string; status?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      handlers.onConnectionState?.('terminal');
      if (info.error) handlers.onError?.(info.error);
      else handlers.onDone?.({ stopped: info.stopped, summary: info.summary, status: info.status });
      resolve();
    };
    const armStall = (): void => {
      if (settled) return;
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => {
        if (uncertainSince === null) uncertainSince = Date.now();
        handlers.onConnectionState?.('stalled');
        void reconcile(false);
      }, stallMs);
    };
    const uncertaintyExpired = (): boolean => maxUncertainMs !== null
      && uncertainSince !== null
      && Date.now() - uncertainSince >= maxUncertainMs;
    const reconcile = async (terminalCandidate: boolean): Promise<void> => {
      if (settled || terminalCheck) return;
      terminalCheck = true;
      try {
        const projection = await readProjection(handle);
        if (projection.receipt.terminal) {
          if (['failed', 'blocked', 'unknown'].includes(projection.receipt.status)) {
            finish({ error: projection.receipt.summary || `durable run ended ${projection.receipt.status}` });
          } else {
            finish({
              stopped: projection.receipt.stopped || projection.receipt.status === 'cancelled',
              summary: projection.receipt.summary ?? undefined,
              status: projection.receipt.status,
            });
          }
        } else {
          if (uncertaintyExpired()) {
            finish({ error: 'durable activity could not be confirmed after reconnecting' });
            return;
          }
          handlers.onConnectionState?.(terminalCandidate ? 'uncertain' : 'stalled');
          armStall();
        }
      } catch (error) {
        if (terminalCandidate) finish({ error: error instanceof Error ? error.message : String(error) });
        else if (uncertaintyExpired()) finish({ error: 'durable activity could not be confirmed after reconnecting' });
        else { handlers.onConnectionState?.('uncertain'); armStall(); }
      } finally { terminalCheck = false; }
    };

    const query = handle.lastEventId > 0 ? `?message=1&lastId=${handle.lastEventId}` : '?message=1';
    try { es = new EventSource(`/api/runs/${handle.admission.runId}/events${query}`); }
    catch { finish({ error: 'could not open the event stream' }); return; }
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    handlers.onConnectionState?.('connected');
    es.onmessage = (message: MessageEvent): void => {
      let ev: V4Event;
      try { ev = JSON.parse(message.data); } catch { return; }
      if (ev.runId !== handle.admission.runId || !Number.isSafeInteger(ev.id) || ev.id <= handle.lastEventId) return;
      handle.lastEventId = ev.id;
      uncertainSince = null;
      persistRunHandle(handle);
      const terminal = routeEvent(ev, handlers, state);
      if (terminal) { void reconcile(true); return; }
      armStall();
    };
    es.onerror = (): void => {
      if (settled) return;
      if (uncertainSince === null) uncertainSince = Date.now();
      handlers.onConnectionState?.('reconnecting');
      void reconcile(false);
    };
    armStall();
  });
}

export function runTask(message: string, handlers: TurnHandlers, options: FollowRunOptions = {}): Promise<void> {
  return admitTask(message)
    .then((handle) => {
      handlers.onAdmission?.(handle.admission);
      handlers.onRunId?.(handle.admission.runId);
      return followRun(handle, handlers, options);
    })
    .catch((error) => { handlers.onError?.(error instanceof Error ? error.message : String(error)); });
}
