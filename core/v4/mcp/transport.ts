/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/transport.ts — Aiden v4.0.0 (Phase 11)
 *
 * MCP transport layer: stdio (subprocess) + HTTP. Both expose the same
 * `McpTransport` interface so `McpClient` doesn't care which is which.
 *
 * Wire format: JSON-RPC 2.0, newline-delimited (stdio) or JSON body (HTTP).
 * Protocol version: 2024-11-05 (matching Aiden v3 + most server SDKs).
 *
 * v3 reference:
 *   core/mcpClient.ts::_connectStdio    — stdio newline framing
 *   core/mcpClient.ts::_rpcStdio        — RPC pending-id map
 *
 * Status: PHASE 11.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { spawnCommand, killProcessTree } from '../util/spawnCommand';

export type McpNotificationHandler = (method: string, params: unknown) => void;

export interface McpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Mutating requests set false so a lost session is never replayed blindly. */
  retryOnSessionExpiry?: boolean;
  /** Maximum buffered JSON response bytes. */
  maxResponseBytes?: number;
}

export class McpUnknownOutcomeError extends Error {
  readonly code = 'MCP_UNKNOWN_OUTCOME';
  constructor(readonly method: string, message: string) {
    super(`MCP ${method} outcome is unknown: ${message}`);
    this.name = 'McpUnknownOutcomeError';
  }
}

/**
 * Why a transport died. `error` is set when the failure is a spawn error
 * (e.g. ENOENT — bad command) → permanent; a clean exit with code/signal
 * means the process ran then died → transient (crash, candidate for retry).
 */
export interface McpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}
export type McpExitHandler = (info: McpExitInfo) => void;

export interface McpRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Common surface for stdio and HTTP transports. Implementations:
 *
 *   - {@link StdioTransport} — spawns a subprocess, frames JSON-RPC over
 *     stdin/stdout newlines, drains stderr to a buffer.
 *   - {@link HttpTransport} — POSTs each request to `/messages`; subscribes
 *     to `/sse` for server-pushed notifications.
 */
export interface McpTransport {
  /** Send a JSON-RPC request and await its matching response. */
  request(method: string, params?: unknown, opts?: McpRequestOptions): Promise<unknown>;

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void;

  /** Subscribe to server-initiated notifications. */
  onNotification(handler: McpNotificationHandler): void;

  /**
   * Subscribe to unexpected transport death (not a deliberate close()).
   * stdio fires on subprocess exit/spawn-error; HTTP stubs this for now
   * (its SSE-drop analog lands in Slice 3).
   */
  onExit(handler: McpExitHandler): void;

  /** Close the transport. Idempotent. Returns when fully closed. */
  close(): Promise<void>;

  /** Stable identifier used in errors and logs. */
  readonly label: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  maxResponseBytes: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SIGTERM_GRACE_MS = 5_000;

// ─── Stdio ──────────────────────────────────────────────────────────────

export interface StdioTransportOptions {
  command: string;
  args: string[];
  /** Filtered env (see McpCredentialFilter). Pass exactly what you want. */
  env?: Record<string, string>;
  cwd?: string;
  /** Override default 30s per-request timeout. */
  defaultTimeoutMs?: number;
  /** Hard cap for any newline-delimited server frame, including notifications. */
  maxFrameBytes?: number;
  /** Optional logger (level + msg) for stderr/diagnostic output. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Inject a child_process spawn — only used for tests. */
  spawnFn?: typeof spawn;
  /** Inject the tree-killer — only used for tests. Defaults to killProcessTree. */
  killTreeFn?: (child: ChildProcess, signal: NodeJS.Signals) => void;
}

export class StdioTransport implements McpTransport {
  readonly label: string;
  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers: McpNotificationHandler[] = [];
  private readonly defaultTimeout: number;
  private readonly maxFrameBytes: number;
  private readonly log?: StdioTransportOptions['log'];
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private exitedOnce = false;
  private rejectedFrame = false;
  private readonly exitHandlers: McpExitHandler[] = [];
  private readonly killTreeFn: (child: ChildProcess, signal: NodeJS.Signals) => void;

  constructor(opts: StdioTransportOptions) {
    this.label = `stdio:${opts.command}`;
    this.defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.log = opts.log;
    this.killTreeFn = opts.killTreeFn ?? ((c, s) => killProcessTree(c, s));

    // v4.9.2 — cross-platform spawn via shared helper. Windows .cmd/.bat
    // shims (npx.cmd is the canonical MCP server case) are wrapped
    // through `cmd.exe /d /s /c` with escaped args; Unix and .exe paths
    // go direct. No shell:true anywhere — argument injection against
    // user-supplied MCP server configs is prevented at the helper layer.
    const { child } = spawnCommand(opts.command, opts.args, {
      stdio:     ['pipe', 'pipe', 'pipe'],
      env:       opts.env,
      cwd:       opts.cwd,
      detached:  true,   // POSIX process group → killProcessTree reaps npx → node
      spawnImpl: opts.spawnFn ?? spawn,
    });
    this.proc = child;

    this.proc.stdout?.setEncoding('utf8');
    this.proc.stderr?.setEncoding('utf8');

    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr?.on('data', (chunk: string) => {
      this.log?.('warn', `[${this.label}] stderr: ${chunk.trimEnd()}`);
    });
    this.proc.on('exit', (code, signal) => {
      this.exitedOnce = true;
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      this.failPending(new Error(`MCP subprocess exited (${reason})`));
      this.log?.('warn', `[${this.label}] subprocess exited (${reason})`);
      // Only an UNEXPECTED death notifies subscribers — a deliberate close()
      // sets `closed` first, so reconnect isn't triggered by our own teardown.
      if (!this.closed) this.fireExit({ code: code ?? null, signal: signal ?? null });
    });
    this.proc.on('error', (err) => {
      this.log?.('error', `[${this.label}] spawn error: ${err.message}`);
      this.failPending(err);
      if (!this.closed) this.fireExit({ code: null, signal: null, error: err });
    });
  }

  private onStdout(chunk: string): void {
    if (this.rejectedFrame) return;
    this.buffer += chunk;
    // Newline-delimited frames. Partial lines stay in buffer for next chunk.
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
          this.rejectOversizedFrame();
          return;
        }
        this.handleLine(line);
      }
      idx = this.buffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes) this.rejectOversizedFrame();
  }

  private rejectOversizedFrame(): void {
    if (this.rejectedFrame) return;
    this.rejectedFrame = true;
    this.buffer = '';
    const error = new Error(`MCP stdio frame exceeds ${this.maxFrameBytes} bytes`);
    this.failPending(error);
    this.log?.('error', `[${this.label}] ${error.message}`);
    try { this.killTreeFn(this.proc, 'SIGTERM'); } catch { /* best effort */ }
  }

  private handleLine(line: string): void {
    let msg: { id?: number; method?: string; result?: unknown; error?: McpRpcError; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      this.log?.('warn', `[${this.label}] invalid JSON frame: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      if (Buffer.byteLength(line, 'utf8') > entry.maxResponseBytes) {
        entry.reject(new Error(`MCP response exceeds ${entry.maxResponseBytes} bytes`));
      } else if (msg.error) {
        entry.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    // Notification (no id) — fan out to handlers.
    if (typeof msg.method === 'string') {
      for (const h of this.handlers) {
        try {
          h(msg.method, msg.params);
        } catch (err) {
          this.log?.('error', `[${this.label}] notification handler threw: ${(err as Error).message}`);
        }
      }
    }
  }

  request(method: string, params?: unknown, opts?: McpRequestOptions): Promise<unknown> {
    if (this.closed || this.exitedOnce) {
      return Promise.reject(new Error(`MCP transport ${this.label} is closed`));
    }
    if (opts?.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeoutMs = opts?.timeoutMs ?? this.defaultTimeout;
      const timer = setTimeout(() => {
        const current = this.pending.get(id);
        this.pending.delete(id);
        if (current?.signal && current.onAbort) current.signal.removeEventListener('abort', current.onAbort);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      const onAbort = opts?.signal ? () => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        clearTimeout(current.timer);
        opts.signal?.removeEventListener('abort', onAbort);
        reject(new DOMException('aborted', 'AbortError'));
      } : undefined;
      if (opts?.signal && onAbort) opts.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve, reject, timer, signal: opts?.signal, onAbort,
        maxResponseBytes: opts?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        this.proc.stdin?.write(payload);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || this.exitedOnce) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try {
      this.proc.stdin?.write(payload);
    } catch (err) {
      this.log?.('warn', `[${this.label}] notify ${method} failed: ${(err as Error).message}`);
    }
  }

  onNotification(handler: McpNotificationHandler): void {
    this.handlers.push(handler);
  }

  onExit(handler: McpExitHandler): void {
    this.exitHandlers.push(handler);
  }

  private fireExit(info: McpExitInfo): void {
    for (const h of this.exitHandlers) {
      try {
        h(info);
      } catch (err) {
        this.log?.('error', `[${this.label}] exit handler threw: ${(err as Error).message}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Already exited? Just clean up.
    if (this.exitedOnce) {
      this.failPending(new Error('MCP transport closed'));
      return;
    }

    // Tree-kill (npx → node) with a grace period, then force-kill the tree.
    // child.kill() would signal only the direct child and orphan grandchildren.
    try {
      this.killTreeFn(this.proc, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.killTreeFn(this.proc, 'SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, SIGTERM_GRACE_MS);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.failPending(new Error('MCP transport closed'));
  }

  private failPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

// ─── HTTP shared helpers ────────────────────────────────────────────────

/** Fetch's resolved Response type (so helpers work with injected `fetchFn`). */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

async function parseBoundedJson(
  res: FetchResponse,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const declared = Number(res.headers?.get?.('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`MCP response exceeds ${maxBytes} bytes`);
  }
  if (typeof (res as FetchResponse & { text?: () => Promise<string> }).text === 'function') {
    const text = await (res as FetchResponse & { text: () => Promise<string> }).text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`MCP response exceeds ${maxBytes} bytes`);
    return JSON.parse(text);
  }
  const value = await res.json();
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
    throw new Error(`MCP response exceeds ${maxBytes} bytes`);
  }
  return value;
}

/**
 * v4.12 Slice 3b/3c — shared reactive-401 retry. Send once; on a 401 with an
 * `onAuthError` hook, force a refresh and (if it succeeded) send exactly once
 * more. Returns the final Response; the caller decides how to surface a
 * persistent failure. Used by both HttpTransport and StreamableHttpTransport.
 */
async function sendWithAuthRetry(
  send: () => Promise<FetchResponse>,
  onAuthError?: () => Promise<boolean>,
): Promise<FetchResponse> {
  let res = await send();
  if (res.status === 401 && onAuthError) {
    if (await onAuthError()) res = await send();
  }
  return res;
}

/**
 * v4.12 Slice 3c.1 — parse an SSE stream off a `fetch` Response body, yielding
 * each event's `data` payload (multi-line `data:` joined with `\n`). Minimal by
 * design: ignores `event:`/`id:`/comments — MCP frames carry JSON-RPC in `data`.
 * (The `eventsource` package can't be used here: it's GET-only and can't read a
 * POST response body stream.)
 */
async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
  maxEventBytes = DEFAULT_MAX_RESPONSE_BYTES,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let dataLines: string[] = [];
  let dataBytes = 0;
  const flush = (): string | null => {
    if (dataLines.length === 0) return null;
    const out = dataLines.join('\n');
    dataLines = [];
    dataBytes = 0;
    return out;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (Buffer.byteLength(line, 'utf8') > maxEventBytes) {
          throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
        }
        if (line === '') {
          const frame = flush(); // blank line = end of event
          if (frame !== null) yield frame;
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).replace(/^ /, '');
          dataBytes += Buffer.byteLength(data, 'utf8') + (dataLines.length > 0 ? 1 : 0);
          if (dataBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
          dataLines.push(data);
        }
        // event:/id:/retry:/comments ignored
      }
      if (Buffer.byteLength(buf, 'utf8') > maxEventBytes) {
        throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
      }
    }
    const last = flush();
    if (last !== null) yield last;
  } finally {
    reader.releaseLock();
  }
}

// ─── HTTP ───────────────────────────────────────────────────────────────

export interface HttpTransportOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /**
   * v4.12 Slice 3a.3 — per-request auth hook. When set, its result is merged
   * over the static headers on every request/notify and each SSE (re)open, so
   * a fresh `Authorization: Bearer <token>` is sent each call. Transport stays
   * auth-agnostic — it just asks for the header. No hook → unchanged behaviour.
   */
  authHeader?: () => Promise<Record<string, string>>;
  /**
   * v4.12 Slice 3b — reactive 401 hook. On an HTTP 401, the transport calls
   * this (force a token refresh) and, if it returns true, retries the request
   * ONCE with a fresh bearer. A second 401 surfaces as an auth-distinct error.
   */
  onAuthError?: () => Promise<boolean>;
  defaultTimeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Inject fetch — only used for tests. */
  fetchFn?: typeof fetch;
  /** Inject EventSource implementation — only used for tests. */
  eventSourceFactory?: (url: string, headers: Record<string, string>) => HttpSseSource;
  /** Disable SSE subscription (tests, or servers that don't support it). */
  disableSse?: boolean;
}

/**
 * Minimal SSE source contract — `EventSource` from `eventsource` package
 * matches it. Tests inject a stub.
 */
export interface HttpSseSource {
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  close(): void;
}

export class HttpTransport implements McpTransport {
  readonly label: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly authHeader?: () => Promise<Record<string, string>>;
  private readonly onAuthError?: () => Promise<boolean>;
  private readonly defaultTimeout: number;
  private readonly handlers: McpNotificationHandler[] = [];
  private readonly log?: HttpTransportOptions['log'];
  private readonly fetchImpl: typeof fetch;
  private readonly eventSourceFactory?: HttpTransportOptions['eventSourceFactory'];
  private readonly disableSse: boolean;
  private nextId = 1;
  private sse: HttpSseSource | null = null;
  private closed = false;
  private sseRetryAttempt = 0;
  private sseRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: HttpTransportOptions) {
    this.label = `http:${opts.baseUrl}`;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
    this.authHeader = opts.authHeader;
    this.onAuthError = opts.onAuthError;
    this.defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log;
    this.fetchImpl = opts.fetchFn ?? fetch;
    this.eventSourceFactory = opts.eventSourceFactory;
    this.disableSse = opts.disableSse ?? false;

    if (!this.disableSse && this.eventSourceFactory) {
      void this.openSse();
    }
  }

  /** Static headers with a fresh auth header (if a hook is set) merged over them. */
  private async mergedHeaders(): Promise<Record<string, string>> {
    return this.authHeader ? { ...this.headers, ...(await this.authHeader()) } : this.headers;
  }

  private async openSse(): Promise<void> {
    if (this.closed || !this.eventSourceFactory) return;
    try {
      // Await only when a hook is set — keeps the no-hook open synchronous.
      const headers = this.authHeader ? { ...this.headers, ...(await this.authHeader()) } : this.headers;
      const src = this.eventSourceFactory(`${this.baseUrl}/sse`, headers);
      this.sse = src;
      src.onmessage = (ev) => this.onSseMessage(ev.data);
      src.onerror = () => this.scheduleSseReconnect();
      this.sseRetryAttempt = 0;
    } catch (err) {
      this.log?.('warn', `[${this.label}] SSE open failed: ${(err as Error).message}`);
      this.scheduleSseReconnect();
    }
  }

  private scheduleSseReconnect(): void {
    if (this.closed) return;
    if (this.sseRetryTimer) return;
    const delay = Math.min(1000 * 2 ** this.sseRetryAttempt, 30_000);
    this.sseRetryAttempt++;
    this.sseRetryTimer = setTimeout(() => {
      this.sseRetryTimer = null;
      try {
        this.sse?.close();
      } catch {
        /* ignore */
      }
      this.sse = null;
      void this.openSse();
    }, delay);
  }

  private onSseMessage(data: string): void {
    if (Buffer.byteLength(data, 'utf8') > DEFAULT_MAX_RESPONSE_BYTES) {
      this.log?.('warn', `[${this.label}] ignored oversized SSE notification`);
      return;
    }
    let msg: { method?: string; params?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.method !== 'string') return;
    for (const h of this.handlers) {
      try {
        h(msg.method, msg.params);
      } catch (err) {
        this.log?.('error', `[${this.label}] handler threw: ${(err as Error).message}`);
      }
    }
  }

  /** One POST attempt to `/messages`. Returns the raw Response; maps abort → timeout. */
  private async sendOnce(
    id: number,
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: await this.mergedHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async request(method: string, params?: unknown, opts?: McpRequestOptions): Promise<unknown> {
    if (this.closed) throw new Error(`MCP transport ${this.label} is closed`);
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeout;

    // 3b — reactive 401: force a refresh and retry ONCE with a fresh bearer.
    const res = await sendWithAuthRetry(() => this.sendOnce(id, method, params, timeoutMs, opts?.signal), this.onAuthError);
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error(`HTTP 401 Unauthorized from ${this.label} — token rejected (auth failed)`);
      }
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${this.label}`);
    }
    const data = (await parseBoundedJson(res, opts?.maxResponseBytes)) as { result?: unknown; error?: McpRpcError };
    if (data.error) {
      throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
    }
    return data.result;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    void (async () => {
      try {
        await this.fetchImpl(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: await this.mergedHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        });
      } catch (err) {
        this.log?.('warn', `[${this.label}] notify ${method} failed: ${(err as Error).message}`);
      }
    })();
  }

  onNotification(handler: McpNotificationHandler): void {
    this.handlers.push(handler);
  }

  // HTTP has no subprocess; its SSE-drop → reconnect analog lands in Slice 3.
  // Stub keeps the McpTransport contract satisfied for now.
  onExit(_handler: McpExitHandler): void {
    /* no-op for HTTP in Slice 2 */
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sseRetryTimer) {
      clearTimeout(this.sseRetryTimer);
      this.sseRetryTimer = null;
    }
    if (this.sse) {
      try {
        this.sse.close();
      } catch {
        /* ignore */
      }
      this.sse = null;
    }
  }
}

// ─── Streamable HTTP (MCP 2025-03-26) ─────────────────────────────────────

/** Thrown when the server reports the session is gone (404) → re-initialize. */
class SessionExpiredError extends Error {}

interface JsonRpcMsg {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: McpRpcError;
}

export interface StreamableHttpTransportOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /** v4.12 Slice 3a.3 — fresh bearer per request (3b refreshes inside). */
  authHeader?: () => Promise<Record<string, string>>;
  /** v4.12 Slice 3b — reactive 401 → force-refresh, retry once. */
  onAuthError?: () => Promise<boolean>;
  defaultTimeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Inject fetch — only used for tests. */
  fetchFn?: typeof fetch;
  /** Inject the backoff sleep — only used for tests (deterministic reconnect). */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Outcome of one server-push GET attempt (drives the reconnect posture). */
type PushOutcome = 'drop' | 'unauthorized' | 'expired' | 'unsupported';

/**
 * Streamable HTTP transport (MCP spec 2025-03-26) — the shape modern hosted
 * servers speak. ONE endpoint: `POST {baseUrl}` carries each JSON-RPC message;
 * the response is either a single `application/json` reply or a `text/event-stream`
 * whose frames carry the reply (+ interleaved notifications). An `Mcp-Session-Id`
 * issued on `initialize` is echoed on every later message; a 404 means the
 * session expired → we re-initialize and retry once (this is the HTTP
 * "reconnect"). Auth (authHeader/onAuthError) is identical to HttpTransport.
 *
 * 3c.1 = request/response core. The standalone server-push `GET {baseUrl}` SSE
 * and hardened reconnect land in 3c.2.
 */
export class StreamableHttpTransport implements McpTransport {
  readonly label: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly authHeader?: () => Promise<Record<string, string>>;
  private readonly onAuthError?: () => Promise<boolean>;
  private readonly defaultTimeout: number;
  private readonly log?: StreamableHttpTransportOptions['log'];
  private readonly fetchImpl: typeof fetch;
  private readonly handlers: McpNotificationHandler[] = [];
  private nextId = 1;
  private sessionId?: string;
  private initParams: unknown;
  private everInitialized = false;
  private protocolVersion?: string;
  private closed = false;
  // 3c.2 — server-push GET stream + session-reinit dedup.
  private readonly sleep: (ms: number) => Promise<void>;
  private pushStarted = false;
  private pushAbort?: AbortController;
  private pushAttempt = 0;
  private reinitInFlight?: Promise<void>;
  private resolveClosed!: () => void;
  private readonly whenClosed: Promise<void>;

  constructor(opts: StreamableHttpTransportOptions) {
    this.label = `streamable:${opts.baseUrl}`;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.headers = { ...(opts.headers ?? {}) };
    this.authHeader = opts.authHeader;
    this.onAuthError = opts.onAuthError;
    this.defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log;
    this.fetchImpl = opts.fetchFn ?? fetch;
    // Default backoff sleep; unref so a pending reconnect never holds the process.
    this.sleep = opts.sleepFn ?? ((ms) => new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      (t as { unref?: () => void }).unref?.();
    }));
    this.whenClosed = new Promise<void>((r) => { this.resolveClosed = r; });
  }

  private async doPost(body: string, timeoutMs: number): Promise<FetchResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...this.headers,
        ...(this.authHeader ? await this.authHeader() : {}),
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
      return await this.fetchImpl(this.baseUrl, { method: 'POST', headers, body, signal: ctrl.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error(`MCP request timed out after ${timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pick up the session id the server assigns (initialize) or rotates. */
  private captureSession(res: FetchResponse): void {
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
  }

  private fanout(method: string, params: unknown): void {
    for (const h of this.handlers) {
      try { h(method, params); } catch (err) {
        this.log?.('error', `[${this.label}] notification handler threw: ${(err as Error).message}`);
      }
    }
  }

  private unwrapReply(msg: JsonRpcMsg): unknown {
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  /** Read the POST's SSE body until the frame answering `id` arrives. */
  private async readSseReply(body: ReadableStream<Uint8Array>, id: number, maxResponseBytes: number): Promise<unknown> {
    for await (const frame of parseSseFrames(body, maxResponseBytes)) {
      let msg: JsonRpcMsg;
      try { msg = JSON.parse(frame) as JsonRpcMsg; } catch { continue; }
      if (msg.id === id) return this.unwrapReply(msg);
      if (typeof msg.method === 'string') this.fanout(msg.method, msg.params); // interleaved notification
    }
    throw new Error(`${this.label}: event stream ended before a reply to request ${id}`);
  }

  private async postAndParse(
    id: number,
    method: string,
    params: unknown,
    timeoutMs: number,
    maxResponseBytes?: number,
  ): Promise<unknown> {
    const res = await sendWithAuthRetry(
      () => this.doPost(JSON.stringify({ jsonrpc: '2.0', id, method, params }), timeoutMs),
      this.onAuthError,
    );
    this.captureSession(res);
    if (res.status === 404) throw new SessionExpiredError(`session expired (404) from ${this.label}`);
    if (!res.ok) {
      if (res.status === 401) throw new Error(`HTTP 401 Unauthorized from ${this.label} — token rejected (auth failed)`);
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${this.label}`);
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      if (!res.body) throw new Error(`${this.label}: event-stream response had no body`);
      return await this.readSseReply(res.body, id, maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    }
    return this.unwrapReply((await parseBoundedJson(res, maxResponseBytes)) as JsonRpcMsg);
  }

  /** Replay initialize on a fresh session after a 404. */
  private async reinitialize(timeoutMs: number): Promise<void> {
    this.sessionId = undefined;
    await this.postAndParse(this.nextId++, 'initialize', this.initParams, timeoutMs);
    this.notify('notifications/initialized');
  }

  /**
   * 3c.2 — deduped re-initialize: concurrent 404s (requests + the push loop)
   * share ONE in-flight reinitialize instead of stampeding the server.
   */
  private ensureReinit(timeoutMs: number): Promise<void> {
    if (!this.reinitInFlight) {
      this.reinitInFlight = this.reinitialize(timeoutMs).finally(() => { this.reinitInFlight = undefined; });
    }
    return this.reinitInFlight;
  }

  async request(method: string, params?: unknown, opts?: McpRequestOptions): Promise<unknown> {
    if (this.closed) throw new Error(`MCP transport ${this.label} is closed`);
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeout;
    if (method === 'initialize') this.initParams = params;
    try {
      const out = await this.postAndParse(this.nextId++, method, params, timeoutMs, opts?.maxResponseBytes);
      if (method === 'initialize') {
        const requested = params && typeof params === 'object'
          ? (params as { protocolVersion?: unknown }).protocolVersion
          : undefined;
        if (typeof requested === 'string') this.protocolVersion = requested;
        this.everInitialized = true;
        this.startPushLoop(); // lazy, once — needs the session id from initialize
      }
      return out;
    } catch (err) {
      if (err instanceof SessionExpiredError && method !== 'initialize' && this.everInitialized) {
        if (opts?.retryOnSessionExpiry === false) {
          throw new McpUnknownOutcomeError(method, 'the server session expired after request transmission');
        }
        this.log?.('info', `[${this.label}] session expired — re-initializing`);
        await this.ensureReinit(timeoutMs);
        return await this.postAndParse(this.nextId++, method, params, timeoutMs, opts?.maxResponseBytes); // retry once
      }
      throw err;
    }
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    void (async () => {
      try {
        await sendWithAuthRetry(
          () => this.doPost(JSON.stringify({ jsonrpc: '2.0', method, params }), this.defaultTimeout),
          this.onAuthError,
        );
      } catch (err) {
        this.log?.('warn', `[${this.label}] notify ${method} failed: ${(err as Error).message}`);
      }
    })();
  }

  onNotification(handler: McpNotificationHandler): void {
    this.handlers.push(handler);
  }

  // ── Server-push GET stream (3c.2) ──────────────────────────────────────────

  /** Start the long-lived server→client SSE loop once, after initialize. */
  private startPushLoop(): void {
    if (this.pushStarted || this.closed) return;
    this.pushStarted = true;
    void this.runPushLoop();
  }

  /**
   * One GET attempt: open the standalone stream, fan out id-less notifications.
   * Returns how it ended so the loop can pick the right reconnect posture.
   */
  private async readPushStream(): Promise<PushOutcome> {
    this.pushAbort = new AbortController();
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...this.headers,
      ...(this.authHeader ? await this.authHeader() : {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;

    const res = await this.fetchImpl(this.baseUrl, { method: 'GET', headers, signal: this.pushAbort.signal });
    this.captureSession(res);
    if (res.status === 401) return 'unauthorized';
    if (res.status === 404) return this.everInitialized ? 'expired' : 'unsupported';
    if (res.status >= 400 && res.status < 500) return 'unsupported'; // 405 etc. — POST-only server
    if (!res.ok || !res.body) return 'drop';

    this.pushAttempt = 0; // connected — reset backoff
    for await (const frame of parseSseFrames(res.body, DEFAULT_MAX_RESPONSE_BYTES)) {
      if (this.closed) break;
      let msg: JsonRpcMsg;
      try { msg = JSON.parse(frame) as JsonRpcMsg; } catch { continue; }
      // Only id-less notifications are consumed on the GET; server→client
      // requests (method + id) are ignored in 3c.2.
      if (typeof msg.method === 'string' && msg.id === undefined) this.fanout(msg.method, msg.params);
    }
    return 'drop'; // stream ended → reconnect
  }

  private async runPushLoop(): Promise<void> {
    while (!this.closed) {
      let outcome: PushOutcome;
      try { outcome = await this.readPushStream(); } catch { outcome = 'drop'; }
      if (this.closed) return;

      if (outcome === 'unsupported') {
        this.log?.('info', `[${this.label}] server-push stream unavailable — disabled (request/response unaffected)`);
        return; // POST-only server: stop, don't hammer
      }
      if (outcome === 'unauthorized') {
        if (this.onAuthError) await this.onAuthError().catch(() => false);
        this.pushAttempt = 0;
        continue; // reconnect with the refreshed bearer
      }
      if (outcome === 'expired') {
        try { await this.ensureReinit(this.defaultTimeout); this.pushAttempt = 0; continue; }
        catch { /* reinit failed → fall through to backoff */ }
      }
      // drop (or reinit-failed) → backoff reconnect, interruptible by close().
      this.pushAttempt += 1;
      await Promise.race([this.sleep(Math.min(1000 * 2 ** (this.pushAttempt - 1), 30_000)), this.whenClosed]);
    }
  }

  // onExit stays no-op for HTTP: the push loop self-heals (backoff / reinit) or
  // disables itself; a hard session death surfaces via request() throwing.
  onExit(_handler: McpExitHandler): void {
    /* no-op for HTTP */
  }

  async close(): Promise<void> {
    this.closed = true;
    this.resolveClosed();      // wake any backoff sleep
    this.pushAbort?.abort();   // cancel an in-flight GET
  }
}
