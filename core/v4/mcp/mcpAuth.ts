/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/mcpAuth.ts — v4.12 Slice 3a.3 + 3b
 *
 * The auth-state resolver injected into McpClient so it can decide, per hosted
 * (http) server, whether to connect plainly, connect with a bearer, or surface
 * `needs-auth`. Keeps McpClient decoupled from tokenStore/discovery/oauthFlow.
 *
 * 3b — the token getter now refreshes: within the pre-flight window (or expired)
 * with a refresh_token it refreshes via the persisted token endpoint + client_id
 * (extras.oauth), persists, and returns the fresh token. A per-server in-flight
 * promise collapses concurrent stale gets / a 401 burst into ONE refresh. The
 * `ready` resolution also exposes `onAuthError` (force-refresh) for the
 * transport's reactive 401→retry path. All transport-agnostic.
 */
import type { AidenPaths } from '../paths';
import { loadTokens, isExpired, PREFLIGHT_REFRESH_WINDOW_MS } from '../auth/tokenStore';
import { refreshTokens, type RefreshConfig, type FetchImpl } from '../auth/oauthFlow';
import {
  canonicalMcpResource,
  loadMcpOAuthConfig,
  mcpTokenId,
  readMcpCredentialBinding,
  type McpOAuthConfig,
} from './oauthDiscovery';
import { persistMcpTokens } from './oauthLoginFlow';

export type McpAuthResolution =
  | { state: 'none' }
  | { state: 'needs-auth' }
  | {
      state: 'ready';
      /** Fresh `Authorization` header (refreshes inside the pre-flight window). */
      authHeader: () => Promise<Record<string, string>>;
      /** Reactive 401 hook: force a refresh; returns true if a token is now available. */
      onAuthError: () => Promise<boolean>;
    };

export interface McpAuthProvider {
  /** Resolve the OAuth state for a server name. */
  resolve(server: string, expected?: { serverUrl: string }): Promise<McpAuthResolution>;
}

/** Build the default tokenStore-backed auth provider for MCP servers. */
export function createMcpAuthProvider(
  paths: AidenPaths,
  opts: { fetchImpl?: FetchImpl } = {},
): McpAuthProvider {
  // 3b — per-server in-flight refresh, so a burst of stale gets / 401s → ONE refresh.
  const inflight = new Map<string, Promise<string | null>>();

  function refreshConfigFor(config: McpOAuthConfig): RefreshConfig {
    const cfg: RefreshConfig = {
      tokenUrl: config.endpoints.tokenEndpoint,
      clientId: config.clientId,
      formEncoded: true,
      resource: config.resource,
      scope: config.scopes?.join(' ') || undefined,
    };
    // Confidential client (DCR returned a secret) → client_secret_basic.
    if (config.clientSecret) {
      const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
      cfg.extraHeaders = { Authorization: `Basic ${basic}` };
    }
    return cfg;
  }

  async function doRefresh(server: string, config: McpOAuthConfig, refreshToken: string): Promise<string | null> {
    try {
      const result = await refreshTokens(refreshToken, refreshConfigFor(config), opts.fetchImpl);
      await persistMcpTokens(paths, server, result, config); // absolute expiry + exact server/resource/scope binding
      return result.accessToken;
    } catch {
      return null; // network / revoked → caller falls back to needs-auth
    }
  }

  function refreshDeduped(server: string, config: McpOAuthConfig, refreshToken: string): Promise<string | null> {
    const existing = inflight.get(server);
    if (existing) return existing;
    const p = doRefresh(server, config, refreshToken).finally(() => inflight.delete(server));
    inflight.set(server, p);
    return p;
  }

  /**
   * Current access token, refreshing when stale (pre-flight window or expired)
   * and a refresh_token exists. `force` always refreshes (the reactive 401 path).
   */
  async function getAccessToken(server: string, expected: { serverUrl?: string } = {}, opts: { force?: boolean } = {}): Promise<string | null> {
    const config = await loadMcpOAuthConfig(paths, server);
    if (!config) return null;
    const tokens = await loadTokens(paths, mcpTokenId(server));
    if (!tokens || !tokens.accessToken) return null;
    const binding = readMcpCredentialBinding(tokens.extras?.mcpBinding);
    if (!binding) return null;
    const configuredServerUrl = canonicalMcpResource(config.serverUrl ?? config.resource ?? '');
    const configuredResource = canonicalMcpResource(config.resource ?? configuredServerUrl);
    const expectedServerUrl = canonicalMcpResource(expected.serverUrl ?? configuredServerUrl);
    if (binding.server !== server
      || binding.serverUrl !== configuredServerUrl
      || binding.resource !== configuredResource
      || binding.clientId !== config.clientId
      || expectedServerUrl !== configuredServerUrl) return null;

    const expired = isExpired(tokens);
    const inPreflight = Date.now() + PREFLIGHT_REFRESH_WINDOW_MS >= tokens.expiresAtMs;
    if (!opts.force && !expired && !inPreflight) return tokens.accessToken;

    // Fall back to the current token only when it's still valid (near-expiry
    // pre-flight) and we're not force-refreshing; an expired token is dead.
    const fallback = expired || opts.force ? null : tokens.accessToken;

    if (!tokens.refreshToken) return fallback;
    return (await refreshDeduped(server, config, tokens.refreshToken)) ?? fallback;
  }

  return {
    async resolve(server: string, expected?: { serverUrl: string }): Promise<McpAuthResolution> {
      const config = await loadMcpOAuthConfig(paths, server);
      if (!config) return { state: 'none' }; // no OAuth configured for this server

      // Ready if a valid token exists OR an expired one can be refreshed now.
      const current = await getAccessToken(server, expected);
      if (!current) {
        const refreshed = await getAccessToken(server, expected, { force: true });
        if (!refreshed) return { state: 'needs-auth' }; // never authed, or expired w/o usable refresh
      }

      return {
        state: 'ready',
        authHeader: async () => {
          const token = await getAccessToken(server, expected);
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
        onAuthError: async () => !!(await getAccessToken(server, expected, { force: true })),
      };
    },
  };
}
