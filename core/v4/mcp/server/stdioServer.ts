/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/server/stdioServer.ts — Phase v4.1-mcp
 *
 * Stand up a Model Context Protocol server over stdio. Three protocol
 * surfaces are wired:
 *
 *   - tools/list      → toolBridge.buildToolsList()
 *   - tools/call      → toolBridge.buildToolCallHandler()
 *   - resources/list  → skillBridge.buildResourcesList()
 *   - resources/read  → skillBridge.readSkillResource()
 *
 * stdio invariants:
 *   - stdout is the JSON-RPC channel — NEVER write to it from this
 *     process outside the SDK transport. The logger is built in
 *     `'mcp-stdio'` mode (file + stderr only) and tools should only
 *     emit through that logger.
 *   - the launch banner goes to stderr on purpose; spawning clients
 *     (Claude Desktop, Cursor) capture stderr in their MCP log so the
 *     user can grep the build fingerprint to verify what's running.
 *
 * The server function is a long-running call: it returns a `stop()`
 * handle but ordinarily blocks until the parent closes the stdio pair.
 * The CLI's `serve` action awaits a never-resolving promise so the
 * Node process stays alive.
 */

// SDK 1.29 ships its public surface via the package `exports` map.
// Use the SDK's documented import paths verbatim — the wildcard
// `paths` mapping in tsconfig.json lets the legacy
// `moduleResolution: "node"` resolver find the type declarations,
// while at runtime Node's exports-map resolver picks the same files.
// (An earlier shape — `.../sdk/server/index` — typechecked but failed
// at runtime: Node's wildcard fallback yielded a path missing the
// `.js` extension. Phase v4.1-mcp.1 fix.)
import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { ToolRegistry, ToolContext } from '../../toolRegistry';
import type { SkillLoader } from '../../skillLoader';
import type { Logger } from '../../logger/logger';
import { noopLogger } from '../../logger/factory';

import {
  buildToolsList,
  buildToolCallHandler,
  readToolBridgeEnv,
  type ToolBridgeEnv,
} from './toolBridge';
import {
  buildResourcesList,
  readSkillResource,
} from './skillBridge';
import { AIDEN_MCP_BUILD, collectMcpDiagnostics } from './diagnostics';
import type { JobEngine } from '../../daemon/jobEngine';

export { AIDEN_MCP_BUILD } from './diagnostics';

export interface StdioServerOptions {
  /** Tool registry — already populated by the caller via `registerAllTools()`. */
  registry: ToolRegistry;
  /** Skill loader — already cache-warmed via `loader.loadAll()`. */
  skillLoader: SkillLoader;
  /** Tool context for the executor closure. Must include `paths` and any
   *  subsystems the exposed tools rely on (sessions, memory, processes,
   *  skillLoader). The bridge intentionally does NOT thread an approval
   *  engine — env-level opt-in (`AIDEN_MCP_ALLOW_DESTRUCTIVE=1`) is the
   *  consent layer when the spawning MCP client has no human in the loop.
   */
  toolContext: ToolContext;
  /** Logger built in `'mcp-stdio'` mode. */
  logger?: Logger;
  /** Override env reads — tests inject fake env without mutating process.env. */
  env?: ToolBridgeEnv;
  jobAuthority?: { engine: JobEngine; instanceId: string };
}

export interface StdioServerHandle {
  /** Kept for symmetry; once stdio is closed the SDK tears down. */
  stop: () => Promise<void>;
  /** The underlying SDK Server (exposed for tests; do not mutate at runtime). */
  server: Server;
}

/**
 * Wire the MCP server up over stdio. Returns once the transport is
 * connected; the caller is responsible for keeping the process alive
 * (the `aiden mcp serve` CLI does this with a never-resolving promise).
 */
export async function startStdioMcpServer(
  opts: StdioServerOptions,
): Promise<StdioServerHandle> {
  const logger = opts.logger ?? noopLogger();
  const env = opts.env ?? readToolBridgeEnv();

  const server = new Server(
    { name: 'aiden', version: AIDEN_MCP_BUILD },
    { capabilities: { tools: {}, resources: {} } },
  );

  const callTool = buildToolCallHandler(
    opts.registry,
    opts.toolContext,
    env,
    logger,
    opts.jobAuthority,
  );

  // ── tools/list ──────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolsList(opts.registry, env),
  }));

  // ── tools/call ──────────────────────────────────────────────
  // SDK 1.29 typed the response as a discriminated union including a
  // task-style alternative. Aiden returns the non-task `CallToolResult`
  // shape; the cast widens the return type to the union.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(name, args);
    return result as unknown as never;
  });

  // ── resources/list ──────────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await buildResourcesList(opts.skillLoader),
  }));

  // ── resources/read ──────────────────────────────────────────
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    try {
      const content = await readSkillResource(opts.skillLoader, uri);
      return { contents: [content] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('mcp resources/read failed', { scope: 'mcp', uri, error: message });
      throw err;
    }
  });

  // ── connect transport ──────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Diagnostics — emitted to stderr (logger in mcp-stdio mode), grep-able
  // from the spawning client's MCP log. Build fingerprint included so the
  // user can verify the running version matches the phase they expected.
  const diag = await collectMcpDiagnostics(opts.registry, opts.skillLoader, env);
  logger.warn(`mcp launched build=${diag.build}`, {
    scope: 'mcp',
    build: diag.build,
    toolsTotal: diag.toolsTotal,
    toolsExposed: diag.toolsExposed,
    skillsTotal: diag.skillsTotal,
    allowDestructive: diag.env.allowDestructive,
    allowlist: diag.env.allowlist,
  });

  return {
    server,
    stop: async () => {
      try { await server.close(); } catch { /* already closed */ }
    },
  };
}
