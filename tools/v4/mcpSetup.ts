/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/mcpSetup.ts — Aiden v4.0.0 (Phase 11)
 *
 * Helper that reads `mcp.servers` from `config.yaml`, connects each
 * configured server, and registers the resulting tools with the
 * `ToolRegistry`. Failed connects do NOT crash agent boot — they log
 * and continue, so a missing npx package or a wedged HTTP endpoint
 * can't take Aiden down.
 *
 * Wired into the CLI lifecycle: aidenCLI invokes `setupMcpFromConfig` at
 * boot and `/reload-mcp` re-runs it. The helper stays side-effect-free so
 * callers control exactly when it runs.
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
import type { AidenPaths } from '../../core/v4/paths';
import { createMcpAuthProvider } from '../../core/v4/mcp/mcpAuth';

interface RawConfigEntry {
  type?: 'stdio' | 'http';
  stdio?: McpServerConfig['stdio'];
  http?: McpServerConfig['http'];
  toolFilter?: McpServerConfig['toolFilter'];
  envAllowlist?: string[];
  callTimeoutMs?: number;
}

/**
 * Shape of the `mcp` config block (servers + tunable knobs). `breaker` and
 * `reconnect` are read loosely and validated — jitter/now are code-only seams,
 * not config-exposable.
 */
interface RawMcpTuning {
  servers?: Record<string, RawConfigEntry>;
  breaker?: unknown;
  reconnect?: unknown;
}

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}
function intAtLeast(v: unknown, min: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : undefined;
}

function pickBreaker(raw: unknown): NonNullable<McpClientOptions['breaker']> {
  const out: NonNullable<McpClientOptions['breaker']> = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const threshold = intAtLeast(r.threshold, 1); // positive integer
  const cooldownMs = positive(r.cooldownMs);     // positive ms
  if (threshold !== undefined) out.threshold = threshold;
  if (cooldownMs !== undefined) out.cooldownMs = cooldownMs;
  return out;
}

function pickReconnect(raw: unknown): NonNullable<McpClientOptions['reconnect']> {
  const out: NonNullable<McpClientOptions['reconnect']> = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const maxPostReadyAttempts = intAtLeast(r.maxPostReadyAttempts, 0); // 0 = no retry
  const maxStartupAttempts = intAtLeast(r.maxStartupAttempts, 0);
  const baseDelayMs = positive(r.baseDelayMs);
  const maxDelayMs = positive(r.maxDelayMs);
  if (maxPostReadyAttempts !== undefined) out.maxPostReadyAttempts = maxPostReadyAttempts;
  if (maxStartupAttempts !== undefined) out.maxStartupAttempts = maxStartupAttempts;
  if (baseDelayMs !== undefined) out.baseDelayMs = baseDelayMs;
  if (maxDelayMs !== undefined) out.maxDelayMs = maxDelayMs;
  return out;
}

/**
 * Merge config-file MCP tuning (`mcp.breaker` / `mcp.reconnect`) into the
 * client options. Explicit `clientOpts` win over config (code/tests override);
 * invalid config values (non-positive, wrong type) are dropped and fall back to
 * the client's code defaults (threshold 3, cooldown 60s, etc.).
 */
export function resolveMcpClientOptions(
  mcpConfig: { breaker?: unknown; reconnect?: unknown } | undefined,
  clientOpts: McpClientOptions,
): McpClientOptions {
  return {
    ...clientOpts,
    breaker: { ...pickBreaker(mcpConfig?.breaker), ...clientOpts.breaker },
    reconnect: { ...pickReconnect(mcpConfig?.reconnect), ...clientOpts.reconnect },
  };
}

export interface SetupMcpFromConfigOptions extends McpClientOptions {
  /** Override the config key. Defaults to `'mcp'`. */
  configKey?: string;
  /** v4.12 Slice 3a.3 — when set, build the default tokenStore-backed MCP auth
   *  provider (bearer hooks + needs-auth) unless an explicit `authProvider` is given. */
  paths?: AidenPaths;
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
  const { configKey = 'mcp', paths, ...clientOpts } = opts;
  const mcpConfig = config.getValue<RawMcpTuning>(configKey);
  // v4.12 3a.3 — default MCP auth provider from paths (explicit authProvider wins).
  const withAuth: McpClientOptions = {
    ...clientOpts,
    authProvider: clientOpts.authProvider ?? (paths ? createMcpAuthProvider(paths) : undefined),
  };
  // Merge user breaker/reconnect tuning from config.yaml (explicit opts win).
  const client = createMcpClient(registry, resolveMcpClientOptions(mcpConfig, withAuth));

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
