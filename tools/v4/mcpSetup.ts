/**
 * tools/v4/mcpSetup.ts — Aiden v4.0.0 (Phase 11)
 *
 * Helper that reads `mcp.servers` from `config.yaml`, connects each
 * configured server, and registers the resulting tools with the
 * `ToolRegistry`. Failed connects do NOT crash agent boot — they log
 * and continue, so a missing npx package or a wedged HTTP endpoint
 * can't take Aiden down.
 *
 * Phase 14 will wire this into the CLI lifecycle (`aiden start`,
 * `/reload-mcp`). For now the helper is plumbed but not auto-invoked
 * at agent boot — callers wire it themselves where appropriate.
 *
 * Status: PHASE 11.
 */

import {
  createMcpClient,
  type McpClient,
  type McpClientOptions,
  type McpServerConfig,
} from '../../core/v4/mcpClient';
import type { ConfigManager } from '../../core/v4/config';
import type { ToolRegistry } from '../../core/v4/toolRegistry';

interface RawConfigEntry {
  type?: 'stdio' | 'http';
  stdio?: McpServerConfig['stdio'];
  http?: McpServerConfig['http'];
  toolFilter?: McpServerConfig['toolFilter'];
  envAllowlist?: string[];
  callTimeoutMs?: number;
}

export interface SetupMcpFromConfigOptions extends McpClientOptions {
  /** Override the config key. Defaults to `'mcp'`. */
  configKey?: string;
}

export interface SetupMcpFromConfigResult {
  client: McpClient;
  /** Names of servers that connected successfully. */
  connected: string[];
  /** Map of server name → error message for connect failures. */
  failures: Record<string, string>;
}

export async function setupMcpFromConfig(
  config: ConfigManager,
  registry: ToolRegistry,
  opts: SetupMcpFromConfigOptions = {},
): Promise<SetupMcpFromConfigResult> {
  const { configKey = 'mcp', ...clientOpts } = opts;
  const client = createMcpClient(registry, clientOpts);

  const mcpConfig = config.getValue<{ servers?: Record<string, RawConfigEntry> }>(configKey);
  const serversRaw = mcpConfig?.servers ?? {};

  const connected: string[] = [];
  const failures: Record<string, string> = {};

  for (const [name, entry] of Object.entries(serversRaw)) {
    if (!entry || typeof entry !== 'object') {
      failures[name] = 'malformed config entry (expected object)';
      continue;
    }
    if (entry.type !== 'stdio' && entry.type !== 'http') {
      failures[name] = `unsupported type "${entry.type ?? '<unset>'}"`;
      continue;
    }
    const cfg: McpServerConfig = {
      name,
      type: entry.type,
      stdio: entry.stdio,
      http: entry.http,
      toolFilter: entry.toolFilter,
      envAllowlist: entry.envAllowlist,
      callTimeoutMs: entry.callTimeoutMs,
    };
    try {
      await client.connect(cfg);
      connected.push(name);
    } catch (err) {
      const message = (err as Error).message;
      failures[name] = message;
      // Use the client's logger if present, otherwise console.warn.
      (clientOpts.log ?? ((_: string, m: string) => console.warn(`[mcp] ${m}`)))(
        'warn',
        `Failed to connect MCP server "${name}": ${message}`,
      );
    }
  }

  return { client, connected, failures };
}
