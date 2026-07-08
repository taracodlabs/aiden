/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * lib/aidenClient.ts — the ONE backend client for the dashboard.
 *
 * The dashboard used to talk to the old v3 server (http://localhost:4200 with a
 * bespoke /api/chat token stream). This module repoints everything at the v4
 * Workbench bridge, served same-origin, and is the ONLY place that knows the v4
 * wire shapes:
 *   - GET  /api/sessions               — the recent-session list (sidebar)
 *   - GET  /api/events                 — the live SSE stream of run_events
 *   - POST /api/tasks                  — token-gated: enqueue a task (safe path)
 *   - POST /api/tasks/:runId/cancel    — token-gated: stop a running job
 *
 * v4 has no synchronous "chat" response: a task is ENQUEUED onto the daemon's
 * safe job path, the daemon runs it, and its progress arrives as run_events on
 * the separate event stream. `runTask` bridges that gap — it sends the task,
 * locks onto the run the daemon creates for it (its first `dispatcher.invoked`
 * event), and translates that run's events into the handlers the chat + activity
 * views consume. Written replies come from the agent's `ui_task_update`/`_done`
 * text; tool calls + verified/unverified verdicts go to the Activity view.
 */

/** A run_event exactly as the bridge streams it (payload parsed to an object). */
export interface V4Event {
  id:        number;
  runId:     number;
  sessionId: string | null;
  ts:        number;
  category:  string;
  kind:      string;
  name:      string | null;
  status:    string | null;
  durationMs: number | null;
  summary:   string | null;
  payload:   any;
}

/** One recent session for the sidebar. */
export interface SessionSummary {
  id:         string;
  label:      string;
  lastActive: number;
  provider?:  string | null;
  model?:     string | null;
}

/** A single Activity-view item — a tool call or a verify verdict. */
export interface ActivityItem {
  kind:    'tool' | 'verify' | 'note';
  label:   string;
  detail?: string;
  status:  'running' | 'ok' | 'failed' | 'warn';
}

/** Handlers the chat page wires to React state. The adapter calls these; it never
 *  touches the DOM or React itself. */
export interface TurnHandlers {
  onRunId?:    (runId: number) => void;
  onReply?:    (chunk: string) => void;
  onThinking?: (stage: string, message: string) => void;
  onActivity?: (item: ActivityItem) => void;
  onTokens?:   (total: number) => void;
  onDone?:     (info: { stopped?: boolean; summary?: string }) => void;
  onError?:    (message: string) => void;
}

/** The per-launch write token the bridge injected into the served page. */
function token(): string {
  if (typeof window === 'undefined') return '';
  return (window as any).__WB_TOKEN__ || '';
}

/** True when this page can perform writes (the bridge served a token). */
export function hasWriteToken(): boolean {
  return token().length > 0;
}

/** The recent-session list for the sidebar. Read-only; never throws. */
export async function listSessions(): Promise<SessionSummary[]> {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** Stop a running job by run id (token-gated). Returns whether the bridge accepted it. */
export async function cancelTask(runId: number | null): Promise<boolean> {
  if (runId == null) return false;
  try {
    const r = await fetch('/api/tasks/' + encodeURIComponent(String(runId)) + '/cancel', {
      method: 'POST',
      headers: { 'x-workbench-token': token() },
    });
    return r.ok;
  } catch {
    return false;
  }
}

const TOOL_VERB: Record<string, string> = {
  file_read: 'Read', file_list: 'List', fetch_url: 'Fetch', fetch_page: 'Fetch', open_url: 'Open',
  web_search: 'Search', deep_research: 'Research', execute_code: 'Run code', read_pdf: 'Read PDF',
  browser_screenshot: 'Screenshot', browser_click: 'Click', browser_type: 'Type', browser_extract: 'Extract',
  screenshot: 'Screenshot',
};
function verb(name: string): string {
  if (TOOL_VERB[name]) return TOOL_VERB[name];
  const s = String(name || 'tool').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Per-turn mutable state the router threads across events. */
interface TurnState { gotReply: boolean }

/** Translate ONE v4 run_event into handler calls. Returns true when the event is
 *  terminal for the run (so the caller can finish the turn). */
function routeEvent(ev: V4Event, h: TurnHandlers, state: TurnState): boolean {
  const n = ev.name || ev.kind || '';
  const p = ev.payload || {};
  switch (n) {
    case 'assistant_message':
      // The agent's final WRITTEN reply — the conversational text for the bubble.
      state.gotReply = true;
      h.onReply?.(String(p.text ?? ''));
      return false;
    case 'tool_call_started':
      h.onActivity?.({ kind: 'tool', label: verb(p.toolName || 'tool'), status: 'running' });
      return false;
    case 'tool_call_completed':
      h.onActivity?.({
        kind: 'tool', label: verb(p.toolName || 'tool'),
        detail: ev.durationMs != null ? ev.durationMs + ' ms' : undefined,
        status: ev.status === 'failed' ? 'failed' : 'ok',
      });
      return false;
    case 'artifact_verified': {
      const ok = !!p.verified;
      h.onActivity?.({ kind: 'verify', label: ok ? 'Verified' : 'Unverified', detail: p.verdict, status: ok ? 'ok' : 'warn' });
      return false;
    }
    case 'cost_updated':
      if (p.totalTokens != null) h.onTokens?.(p.totalTokens);
      return false;
    case 'ui_task_update':
      // Progress narration → the thinking strip, not the reply bubble.
      h.onThinking?.(String(p.stage || 'working'), String(p.text || p.message || ('step ' + (p.step ?? ''))));
      return false;
    case 'ui_task_done':
      // Only a fallback reply — if the agent emitted no assistant_message text.
      if (!state.gotReply && p.summary) { state.gotReply = true; h.onReply?.(String(p.summary)); }
      h.onDone?.({ summary: p.summary ? String(p.summary) : '' });
      return true;
    case 'task_cancelled':
      h.onDone?.({ stopped: true });
      return true;
    default:
      break;
  }
  // Terminal by kind: the dispatcher wraps every run; `completed` ends it even
  // when the agent narrated nothing.
  if (ev.kind === 'dispatcher.completed') { h.onDone?.({ summary: ev.summary || '' }); return true; }
  if (ev.kind === 'dispatcher.rejected' || ev.kind === 'dispatcher.builder_failed') {
    h.onError?.(ev.summary || 'the run could not start');
    return true;
  }
  return false;
}

const IDLE_MS = 25_000;

/**
 * Send a task and stream its reply. Resolves when the run ends (or times out).
 *
 * Flow: open the event stream, POST the task, then lock onto the run the daemon
 * creates for it — the first `dispatcher.invoked` seen AFTER we send is ours (a
 * pre-existing run already fired its `invoked` during the replay). From then on
 * every event for that run is routed through `routeEvent`.
 */
export function runTask(message: string, handlers: TurnHandlers): Promise<void> {
  return new Promise<void>((resolve) => {
    let ours: number | null = null;
    let sent = false;
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    const state: TurnState = { gotReply: false };

    const finish = (info: { stopped?: boolean; summary?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      try { es?.close(); } catch { /* noop */ }
      if (info.error) handlers.onError?.(info.error);
      else handlers.onDone?.({ stopped: info.stopped, summary: info.summary });
      resolve();
    };
    const bumpIdle = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => finish({ summary: '' }), IDLE_MS);
    };

    try {
      es = new EventSource('/api/events');
    } catch {
      finish({ error: 'could not open the event stream' });
      return;
    }
    es.onmessage = (e: MessageEvent): void => {
      let ev: V4Event;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.runId == null) return;
      if (ours == null) {
        // Ignore the replay + any in-flight run until we've sent, then adopt the
        // first freshly-invoked run as ours.
        if (!sent) return;
        if (ev.kind === 'dispatcher.invoked') {
          ours = ev.runId;
          handlers.onRunId?.(ours);
          bumpIdle();
        }
        return;
      }
      if (ev.runId !== ours) return;
      const done = routeEvent(ev, handlers, state);
      if (done) { finish({}); return; }
      bumpIdle();
    };
    es.onerror = (): void => { /* transient reconnects are fine; the idle timer guards us */ };

    bumpIdle();

    // Send AFTER the stream is open so we never miss our run's first event.
    void (async (): Promise<void> => {
      let res: Response;
      try {
        res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
          body: JSON.stringify({ message }),
        });
      } catch {
        finish({ error: 'could not reach Aiden (is `aiden web` running?)' });
        return;
      }
      sent = true;
      if (!res.ok) {
        let err = 'send failed (HTTP ' + res.status + ')';
        try { const j = await res.json(); if (j && j.error) err = j.error; } catch { /* noop */ }
        if (res.status === 401 || res.status === 503) err = 'writes are disabled — open the dashboard via `aiden web` (it carries the local token)';
        finish({ error: err });
      }
      // success → wait for the run's events; the stream drives the rest.
    })();
  });
}
