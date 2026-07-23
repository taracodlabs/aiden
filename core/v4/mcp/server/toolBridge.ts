/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/server/toolBridge.ts — Phase v4.1-mcp
 *
 * Bridge between Aiden's `ToolRegistry` and the MCP wire format. The
 * registry already stores schemas in the exact shape MCP wants
 * (`{ name, description, inputSchema: { type: 'object', properties, required? } }`),
 * so this layer is a thin pass-through plus three filters:
 *
 *   1. `mutates` filter — read-only tools by default. Set
 *      `AIDEN_MCP_ALLOW_DESTRUCTIVE=1` to expose write/execute tools too.
 *      Phase-9 approval engine still gates them at execution time
 *      (defense in depth).
 *   2. Allowlist filter — `AIDEN_MCP_TOOL_ALLOWLIST=tool_a,tool_b`
 *      restricts the surface to a CSV-named subset. Applied AFTER the
 *      mutates filter, so a user cannot allowlist `shell_exec` past the
 *      destructive gate without also setting `ALLOW_DESTRUCTIVE=1`.
 *   3. The handler wrapper coerces every dispatch outcome into MCP's
 *      `CallToolResult` shape `{ content, isError }`. The agent loop's
 *      executor returns `ToolCallResult` whose `.error` field is set when
 *      the underlying handler threw or the moat layers refused the call;
 *      that becomes `isError: true` here. We NEVER throw out of the
 *      handler — protocol-level errors bypass the model's recovery path.
 *
 * The bridge is dependency-injected with the ToolRegistry + ToolContext
 * the runtime already built. It does not own a logger; the stdio server
 * passes one through for the env-config diagnostic line.
 */

import type {
  ToolRegistry,
  ToolContext,
  ToolHandler,
} from '../../toolRegistry';
import type {
  ToolCallRequest,
  ToolCallResult,
  ToolSchema,
} from '../../../../providers/v4/types';
import type { Logger } from '../../logger/logger';
import { noopLogger } from '../../logger/factory';
import { randomUUID } from 'node:crypto';
import type { JobEngine } from '../../daemon/jobEngine';
import { executeDurableJob } from '../../daemon/jobLifecycle';
import { ApprovalEngine } from '../../../../moat/approvalEngine';

/** MCP wire shape for a tool. Same JSON-Schema as ToolSchema.inputSchema. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP wire shape for a tools/call response. */
export interface McpToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Per-process env snapshot. Read at server start, NOT per-call, because
 *  Claude Desktop spawns one stdio process and never restarts it within a
 *  session — env stays stable for the life of the connection. */
export interface ToolBridgeEnv {
  /** When true, mutating tools (write/execute) are exposed. */
  allowDestructive: boolean;
  /** When non-empty, only tool names in this set are exposed. */
  allowlist: ReadonlySet<string> | null;
}

export function readToolBridgeEnv(env: NodeJS.ProcessEnv = process.env): ToolBridgeEnv {
  const allowDestructive =
    env.AIDEN_MCP_ALLOW_DESTRUCTIVE === '1' ||
    env.AIDEN_MCP_ALLOW_DESTRUCTIVE === 'true';
  const raw = (env.AIDEN_MCP_TOOL_ALLOWLIST ?? '').trim();
  const allowlist = raw
    ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  return { allowDestructive, allowlist };
}

/**
 * Compute the set of tool names exposed under the current env. Pure
 * function over the registry snapshot; safe to call on every
 * `tools/list` request (the registry is built once at boot).
 */
export function exposedToolNames(
  registry: ToolRegistry,
  env: ToolBridgeEnv,
): string[] {
  const out: string[] = [];
  for (const name of registry.list()) {
    const handler = registry.get(name);
    if (!handler) continue;
    if (handler.mutates && !env.allowDestructive) continue;
    if (env.allowlist && !env.allowlist.has(name)) continue;
    out.push(name);
  }
  return out;
}

/** Pass-through schema convert. The shapes are already aligned. */
export function aidenToolToMCP(handler: ToolHandler): McpTool {
  const s: ToolSchema = handler.schema;
  return {
    name: s.name,
    description: s.description,
    inputSchema: {
      type: 'object',
      properties: s.inputSchema.properties,
      required: s.inputSchema.required,
    },
  };
}

/** Build the tools array advertised on `tools/list`. */
export function buildToolsList(
  registry: ToolRegistry,
  env: ToolBridgeEnv,
): McpTool[] {
  const out: McpTool[] = [];
  for (const name of exposedToolNames(registry, env)) {
    const handler = registry.get(name);
    if (handler) out.push(aidenToolToMCP(handler));
  }
  return out;
}

/**
 * Build a `tools/call` handler closed over the registry's executor and
 * the per-process env. Each call:
 *
 *   1. Re-checks exposure (env may have shifted is irrelevant — we read
 *      it at server start — but this guards against allowlist drift if
 *      a future caller passes a fresh env snapshot).
 *   2. Synthesises a `ToolCallRequest` for the executor; uses a stable
 *      id so logs cross-correlate.
 *   3. Maps the executor's `ToolCallResult` to MCP's `{content,isError}`.
 *
 * Failures the executor reports via `result.error` become `isError: true`
 * with the error message in the text payload — the model on the client
 * side reads it and recovers. We never throw protocol-level.
 */
export function buildToolCallHandler(
  registry: ToolRegistry,
  context: ToolContext,
  env: ToolBridgeEnv,
  logger: Logger = noopLogger(),
  jobAuthority?: { engine: JobEngine; instanceId: string },
): (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult> {
  const exposed = new Set(exposedToolNames(registry, env));
  // Direct MCP calls have no interactive approval channel. Preserve an
  // explicitly supplied authority, but otherwise install the existing manual
  // engine without a prompter so mutating tools fail closed after durable Job
  // admission. Exposure is capability discovery, not execution approval.
  const executionContext: ToolContext = context.approvalEngine
    ? context
    : { ...context, approvalEngine: new ApprovalEngine('manual') };
  const execute = registry.buildExecutor(executionContext);

  return async (name, args) => {
    if (!exposed.has(name)) {
      logger.warn('mcp tools/call refused — tool not exposed', {
        scope: 'mcp',
        tool: name,
        allowDestructive: env.allowDestructive,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Tool "${name}" is not exposed via MCP.`,
            hint: env.allowDestructive
              ? 'Tool may not be in AIDEN_MCP_TOOL_ALLOWLIST.'
              : 'Set AIDEN_MCP_ALLOW_DESTRUCTIVE=1 to include mutating tools.',
          }),
        }],
        isError: true,
      };
    }

    const id = `mcp-${name}-${randomUUID()}`;
    const call: ToolCallRequest = { id, name, arguments: args ?? {} };
    let result: ToolCallResult;
    try {
      const executeCall = () => execute(call);
      result = jobAuthority
        ? (await executeDurableJob({
            engine: jobAuthority.engine,
            ownerId: jobAuthority.instanceId,
            admission: {
              entryPoint: 'mcp',
              source: 'mcp-stdio',
              sessionId: `mcp:${jobAuthority.instanceId}`,
              instanceId: jobAuthority.instanceId,
              idempotencyNamespace: `mcp:${jobAuthority.instanceId}`,
              idempotencyKey: id,
              goal: `Execute ${name}`,
              title: name,
            },
            execute: (handle) => execute(call, handle.signal),
            finalize: (value) => ({
              status: value.error ? 'failed' : 'completed',
              outcome: value.error ? 'failed' : 'completed',
              finishReason: value.error ? 'tool_error' : 'stop',
              evidence: { toolCallId: id, toolName: name, succeeded: !value.error },
            }),
          })).value
        : await executeCall();
    } catch (err) {
      // The executor itself swallows handler exceptions, but a bug in
      // the executor (or a moat layer hard-throw) would land here.
      const message = err instanceof Error ? err.message : String(err);
      logger.error('mcp tools/call executor crashed', {
        scope: 'mcp',
        tool: name,
        error: message,
      });
      return {
        content: [{ type: 'text', text: `Internal error: ${message}` }],
        isError: true,
      };
    }

    if (result.error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: result.error }, null, 2),
        }],
        isError: true,
      };
    }

    const text =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result ?? null, null, 2);
    return {
      content: [{ type: 'text', text }],
      isError: false,
    };
  };
}
