/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcpClient.ts — Aiden v4.0.0
 *
 * MCP client. Connects to external MCP servers (stdio + HTTP), discovers
 * their tools, registers each as `mcp_<server>_<tool>` in the v4
 * `ToolRegistry`, and dispatches calls back through the transport.
 *
 * Phase 11 scope:
 *   - stdio + HTTP transports
 *   - initialize → tools/list discovery
 *   - tool prefix `mcp_<server>_<tool>` (replaces v3's `<server>:<tool>`)
 *   - dynamic re-discovery on `notifications/tools/list_changed`
 *   - per-server include/exclude filtering
 *   - credential-filtered stdio env
 *   - error redaction
 *   - sampling/createMessage refused (lands in v4.1)
 *
 * Deferred:
 *   - Sampling support (v4.1, needs loop control changes)
 *   - resources / prompts capabilities (v4.1, most servers don't use)
 *   - Per-server health UI / `aiden mcp status` (Phase 14 CLI)
 *
 * Replaces the Phase 1 stub. v3's `core/mcpClient.ts` stays untouched —
 * it's still wired into v3 paths and we don't reuse it from v4.
 *
 * Status: PHASE 11.
 */

import type {
  ToolSchema,
  ToolCallRequest,
  ToolCallResult,
} from '../../providers/v4/types';
import type {
  ToolHandler,
  ToolRegistry,
  ToolContext,
} from './toolRegistry';
import {
  HttpTransport,
  StdioTransport,
  type HttpSseSource,
  type McpTransport,
} from './mcp/transport';
import { McpToolFilter, type ToolFilterConfig } from './mcp/filters';
import { McpCredentialFilter } from './mcp/credentialFilter';

// ─── Types ──────────────────────────────────────────────────────────────

export interface McpStdioConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig {
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface McpServerConfig {
  /** Stable name — used as tool prefix. Slug-friendly: alnum + `_`. */
  name: string;
  type: 'stdio' | 'http';
  stdio?: McpStdioConfig;
  http?: McpHttpConfig;
  toolFilter?: ToolFilterConfig;
  /** Extra env names to allow into stdio subprocess. */
  envAllowlist?: string[];
  /** Override the default 30s tool-call timeout. */
  callTimeoutMs?: number;
}

export interface McpCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  sampling?: object;
}

export interface McpTool {
  serverName: string;
  /** `mcp_<server>_<rawName>` — the registered name in ToolRegistry. */
  prefixedName: string;
  /** Original tool name reported by the server. */
  rawName: string;
  description: string;
  inputSchema: ToolSchema['inputSchema'];
}

export type McpServerStatus = 'initializing' | 'ready' | 'error' | 'closed';

export interface McpServer {
  config: McpServerConfig;
  transport: McpTransport;
  capabilities: McpCapabilities;
  tools: McpTool[];
  status: McpServerStatus;
  lastError?: string;
}

export interface McpClientOptions {
  /** Optional logger; defaults to console.warn for warnings. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seam: builds a stdio transport. */
  stdioFactory?: (cfg: McpStdioConfig, env: Record<string, string>, label: string) => McpTransport;
  /** Test seam: builds an HTTP transport. */
  httpFactory?: (cfg: McpHttpConfig, label: string) => McpTransport;
  /** Test seam: SSE event source factory threaded into HTTP transport. */
  eventSourceFactory?: (url: string, headers: Record<string, string>) => HttpSseSource;
  /** Default tool-call timeout when server config does not specify one. */
  defaultCallTimeoutMs?: number;
}

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'aiden', version: '4.0.0' };
const DEFAULT_CALL_TIMEOUT = 30_000;

// ─── Helpers ────────────────────────────────────────────────────────────

/** Sanitise a server name into something safe to use in a tool prefix. */
function safeServerSlug(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'server';
}

function buildPrefixedName(serverName: string, rawToolName: string): string {
  return `mcp_${safeServerSlug(serverName)}_${rawToolName}`;
}

// ─── McpClient ──────────────────────────────────────────────────────────

export class McpClient {
  private readonly servers = new Map<string, McpServer>();
  private readonly filter = new McpToolFilter();
  private readonly log: NonNullable<McpClientOptions['log']>;
  private readonly stdioFactory: NonNullable<McpClientOptions['stdioFactory']>;
  private readonly httpFactory: NonNullable<McpClientOptions['httpFactory']>;
  private readonly defaultCallTimeoutMs: number;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly credentialFilter: McpCredentialFilter,
    opts: McpClientOptions = {},
  ) {
    this.log = opts.log ?? ((lvl, msg) => {
      if (lvl === 'error' || lvl === 'warn') console.warn(`[mcp] ${msg}`);
    });
    this.defaultCallTimeoutMs = opts.defaultCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT;
    const eventSourceFactory = opts.eventSourceFactory;
    this.stdioFactory = opts.stdioFactory ?? ((cfg, env, label) => new StdioTransport({
      command: cfg.command,
      args: cfg.args,
      env,
      cwd: cfg.cwd,
      log: (lvl, m) => this.log(lvl, `[${label}] ${this.credentialFilter.redact(m)}`),
    }));
    this.httpFactory = opts.httpFactory ?? ((cfg, label) => new HttpTransport({
      baseUrl: cfg.baseUrl,
      headers: cfg.headers,
      log: (lvl, m) => this.log(lvl, `[${label}] ${this.credentialFilter.redact(m)}`),
      eventSourceFactory,
      disableSse: !eventSourceFactory,
    }));
  }

  list(): McpServer[] {
    return [...this.servers.values()];
  }

  get(name: string): McpServer | undefined {
    return this.servers.get(name);
  }

  /**
   * Connect to a server, run the initialize handshake, discover tools,
   * register them with the ToolRegistry, and subscribe to changes.
   *
   * Throws when the handshake or initial tools/list fails. Caller is
   * responsible for catch + warn (callers like `setupMcpFromConfig` do).
   */
  async connect(config: McpServerConfig): Promise<McpServer> {
    if (this.servers.has(config.name)) {
      throw new Error(`MCP server "${config.name}" is already connected`);
    }

    const transport = this.buildTransport(config);
    const server: McpServer = {
      config,
      transport,
      capabilities: {},
      tools: [],
      status: 'initializing',
    };
    this.servers.set(config.name, server);

    transport.onNotification((method, params) => this.onNotification(server, method, params));

    try {
      const initResult = (await transport.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      })) as { capabilities?: McpCapabilities } | undefined;
      server.capabilities = initResult?.capabilities ?? {};
      transport.notify('notifications/initialized');

      await this.discoverAndRegister(server);
      server.status = 'ready';
      return server;
    } catch (err) {
      server.status = 'error';
      server.lastError = this.credentialFilter.redact((err as Error).message);
      // Tear down the partial transport so we don't leak subprocesses.
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      this.servers.delete(config.name);
      throw new Error(`MCP connect failed for "${config.name}": ${server.lastError}`);
    }
  }

  /** Disconnect a server, unregister its tools, close the transport. */
  async disconnect(serverName: string): Promise<void> {
    const server = this.servers.get(serverName);
    if (!server) return;
    for (const tool of server.tools) {
      this.registry.unregister(tool.prefixedName);
    }
    server.status = 'closed';
    server.tools = [];
    try {
      await server.transport.close();
    } catch {
      /* ignore */
    }
    this.servers.delete(serverName);
  }

  /** Re-discover tools on every connected server. Used by `/reload-mcp`. */
  async reload(): Promise<void> {
    const servers = [...this.servers.values()];
    for (const s of servers) {
      try {
        await this.discoverAndRegister(s);
      } catch (err) {
        s.status = 'error';
        s.lastError = this.credentialFilter.redact((err as Error).message);
      }
    }
  }

  /**
   * Invoke a server tool. Used by the per-tool `execute` closure that
   * `discoverAndRegister` registers into the ToolRegistry.
   */
  async callTool(
    serverName: string,
    rawName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }
    const timeoutMs = server.config.callTimeoutMs ?? this.defaultCallTimeoutMs;
    let result: unknown;
    try {
      result = await server.transport.request(
        'tools/call',
        { name: rawName, arguments: args },
        { timeoutMs },
      );
    } catch (err) {
      throw new Error(
        `MCP call ${serverName}.${rawName} failed: ${this.credentialFilter.redact((err as Error).message)}`,
      );
    }
    return this.unwrapToolResult(result, serverName, rawName);
  }

  async closeAll(): Promise<void> {
    const names = [...this.servers.keys()];
    for (const n of names) await this.disconnect(n);
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private buildTransport(config: McpServerConfig): McpTransport {
    if (config.type === 'stdio') {
      if (!config.stdio) throw new Error(`MCP server "${config.name}" missing stdio config`);
      const env = this.credentialFilter.buildEnv({
        explicit: config.stdio.env,
        allowlist: config.envAllowlist,
      });
      return this.stdioFactory(config.stdio, env, config.name);
    }
    if (config.type === 'http') {
      if (!config.http) throw new Error(`MCP server "${config.name}" missing http config`);
      return this.httpFactory(config.http, config.name);
    }
    throw new Error(`MCP server "${config.name}" has unsupported type "${(config as McpServerConfig).type}"`);
  }

  private async discoverAndRegister(server: McpServer): Promise<void> {
    const result = (await server.transport.request('tools/list')) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: ToolSchema['inputSchema'] }>;
    } | undefined;
    const rawTools = result?.tools ?? [];

    const candidates: McpTool[] = rawTools.map((t) => ({
      serverName: server.config.name,
      rawName: t.name,
      prefixedName: buildPrefixedName(server.config.name, t.name),
      description: t.description ?? t.name,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
    const allowed = this.filter.filter(candidates, server.config.toolFilter);

    // Unregister any previously registered tools for this server, then
    // re-register the current set. Keeps tools/list_changed updates tidy.
    for (const t of server.tools) this.registry.unregister(t.prefixedName);
    server.tools = allowed;

    for (const tool of allowed) {
      const handler: ToolHandler = {
        schema: {
          name: tool.prefixedName,
          description: tool.description,
          inputSchema: this.normalizeSchema(tool.inputSchema),
        },
        // MCP tools can do anything — treat as `execute` with mutates=true
        // so the Phase 9 approval engine gates them.
        category: 'execute',
        mutates: true,
        toolset: 'mcp',
        execute: async (args: Record<string, unknown>, _ctx: ToolContext) => {
          return this.callTool(server.config.name, tool.rawName, args);
        },
      };
      this.registry.register(handler);
    }

    this.log('info', `[${server.config.name}] discovered ${allowed.length} tool(s)` +
      (rawTools.length !== allowed.length ? ` (${rawTools.length - allowed.length} filtered)` : ''));
  }

  /** Ensure schema has a valid object shape — some servers report partial. */
  private normalizeSchema(schema: ToolSchema['inputSchema']): ToolSchema['inputSchema'] {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {} };
    }
    const s = schema as Record<string, unknown>;
    return {
      type: 'object',
      properties: (s.properties as Record<string, unknown>) ?? {},
      required: Array.isArray(s.required) ? (s.required as string[]) : undefined,
    };
  }

  private onNotification(server: McpServer, method: string, params: unknown): void {
    if (method === 'notifications/tools/list_changed') {
      this.discoverAndRegister(server).catch((err) => {
        this.log('warn', `[${server.config.name}] re-discovery failed: ${this.credentialFilter.redact((err as Error).message)}`);
      });
      return;
    }
    if (method === 'sampling/createMessage') {
      // Phase 11 minimum: refuse cleanly. v4.1 will wire this back to the
      // running provider so MCP servers can ask Aiden's LLM for inference.
      server.transport.notify('sampling/error', {
        code: -32601,
        message: 'Sampling not yet supported in Aiden v4.0.0 (lands v4.1)',
      });
      this.log('info', `[${server.config.name}] refused sampling/createMessage (Phase 11 stub)`);
      return;
    }
    void params;
  }

  /**
   * MCP responses for `tools/call` use a content-block array. Phase 11
   * stringifies text blocks and ignores other types — vision/audio land
   * in Phase 13.
   */
  private unwrapToolResult(raw: unknown, serverName: string, rawName: string): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const r = raw as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    if (r.isError) {
      const txt = (r.content ?? [])
        .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
        .join('\n');
      throw new Error(
        `MCP tool ${serverName}.${rawName} reported error: ${this.credentialFilter.redact(txt || 'unknown')}`,
      );
    }
    const content = r.content ?? [];
    if (content.length === 0) return '';
    const text = content
      .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
      .join('\n');
    return text;
  }
}

/** Convenience: builds a credential filter then constructs a client. */
export function createMcpClient(
  registry: ToolRegistry,
  opts: McpClientOptions = {},
): McpClient {
  return new McpClient(registry, new McpCredentialFilter(), opts);
}

// Backward-compat: keep the Phase 1 module marker so old imports don't break
// while we phase callers over.
export { McpCredentialFilter };
