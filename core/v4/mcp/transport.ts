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
 * Hermes references:
 *   tools/mcp_tool.py::_run_stdio       — stdio subprocess wiring
 *   tools/mcp_tool.py::_run_http        — streamablehttp transport
 *
 * v3 reference:
 *   core/mcpClient.ts::_connectStdio    — stdio newline framing
 *   core/mcpClient.ts::_rpcStdio        — RPC pending-id map
 *
 * Status: PHASE 11.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export type McpNotificationHandler = (method: string, params: unknown) => void;

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
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void;

  /** Subscribe to server-initiated notifications. */
  onNotification(handler: McpNotificationHandler): void;

  /** Close the transport. Idempotent. Returns when fully closed. */
  close(): Promise<void>;

  /** Stable identifier used in errors and logs. */
  readonly label: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
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
  /** Optional logger (level + msg) for stderr/diagnostic output. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Inject a child_process spawn — only used for tests. */
  spawnFn?: typeof spawn;
}

export class StdioTransport implements McpTransport {
  readonly label: string;
  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers: McpNotificationHandler[] = [];
  private readonly defaultTimeout: number;
  private readonly log?: StdioTransportOptions['log'];
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private exitedOnce = false;

  constructor(opts: StdioTransportOptions) {
    this.label = `stdio:${opts.command}`;
    this.defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log;

    const spawner = opts.spawnFn ?? spawn;
    // Windows .cmd/.bat shims (npx.cmd) can't be spawned with shell:false
    // (Node 18.20+ refuses with EINVAL), and shell:true mangles arguments
    // containing path separators. Callers should resolve the underlying
    // executable themselves — e.g., spawn `node <npx-cli.js>` instead of
    // `npx.cmd`. Phase 11 integration tests demonstrate this pattern in
    // tests/v4/integration/mcpClient.real.test.ts::resolveNpxLaunch.
    this.proc = spawner(opts.command, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
      cwd: opts.cwd,
      shell: false,
    });

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
    });
    this.proc.on('error', (err) => {
      this.log?.('error', `[${this.label}] spawn error: ${err.message}`);
      this.failPending(err);
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    // Newline-delimited frames. Partial lines stay in buffer for next chunk.
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
      idx = this.buffer.indexOf('\n');
    }
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
      if (msg.error) {
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

  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    if (this.closed || this.exitedOnce) {
      return Promise.reject(new Error(`MCP transport ${this.label} is closed`));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeoutMs = opts?.timeoutMs ?? this.defaultTimeout;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Already exited? Just clean up.
    if (this.exitedOnce) {
      this.failPending(new Error('MCP transport closed'));
      return;
    }

    // SIGTERM with grace period, then SIGKILL.
    try {
      this.proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.proc.kill('SIGKILL');
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
      entry.reject(err);
    }
    this.pending.clear();
  }
}

// ─── HTTP ───────────────────────────────────────────────────────────────

export interface HttpTransportOptions {
  baseUrl: string;
  headers?: Record<string, string>;
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
    this.defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log;
    this.fetchImpl = opts.fetchFn ?? fetch;
    this.eventSourceFactory = opts.eventSourceFactory;
    this.disableSse = opts.disableSse ?? false;

    if (!this.disableSse && this.eventSourceFactory) {
      this.openSse();
    }
  }

  private openSse(): void {
    if (this.closed || !this.eventSourceFactory) return;
    try {
      const src = this.eventSourceFactory(`${this.baseUrl}/sse`, this.headers);
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
      this.openSse();
    }, delay);
  }

  private onSseMessage(data: string): void {
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

  async request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    if (this.closed) throw new Error(`MCP transport ${this.label} is closed`);
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeout;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} from ${this.label}`);
      }
      const data = (await res.json()) as { result?: unknown; error?: McpRpcError };
      if (data.error) {
        throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
      }
      return data.result;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    void this.fetchImpl(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch((err) => {
      this.log?.('warn', `[${this.label}] notify ${method} failed: ${(err as Error).message}`);
    });
  }

  onNotification(handler: McpNotificationHandler): void {
    this.handlers.push(handler);
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
