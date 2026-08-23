/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/oauthDiscovery.ts — v4.12 Slice 3a.1
 *
 * Foundational OAuth protocol layer for hosted (HTTP) MCP servers:
 *   - Protected Resource Metadata discovery     (RFC 9728)
 *   - Authorization Server Metadata discovery   (RFC 8414, + OIDC fallback)
 *   - Dynamic Client Registration               (RFC 7591)
 *   - Persist discovered endpoints + the DCR client into tokenStore.extras
 *     (id `mcp_<server>`), reusing the existing encrypted / 0600 /
 *     absolute-expiry token store.
 *
 * Scope: protocol + persistence ONLY. No browser flow, no loopback callback,
 * no transport/command wiring (that's 3a.2 / 3a.3). All HTTP goes through an
 * injected `fetchFn` — this module never touches the real network.
 */
import type { AidenPaths } from '../paths';
import { loadTokens, saveTokens, isExpired, type OAuthTokens } from '../auth/tokenStore';
import { SSRFProtection } from '../../../moat/ssrfProtection';

/** Minimal fetch surface — the global `fetch` satisfies it; tests inject a mock. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: 'manual' },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface OAuthDiscoveryDeps {
  fetchFn: FetchLike;
  endpointPolicy?: Pick<SSRFProtection, 'check'>;
  /** Controlled local fixtures only. */
  allowLoopbackHttp?: boolean;
  maxMetadataBytes?: number;
}

export interface DiscoveredOAuth {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /**
   * v4.14 — RFC 8628 device-authorization endpoint. Rarely published in AS
   * metadata (GitHub, for one, does not), so it's usually supplied by the
   * static per-provider config rather than discovered.
   */
  deviceAuthorizationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethods?: string[];
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

/** Persisted under tokenStore.extras.oauth for id `mcp_<server>`. */
export interface McpOAuthConfig {
  /** Exact configured MCP endpoint this OAuth client and credential belong to. */
  serverUrl?: string;
  /** The MCP server URL (the OAuth `resource` indicator for token requests). */
  resource?: string;
  endpoints: DiscoveredOAuth;
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  /**
   * v4.14 — requested scopes (space-joined by the flow). Carried for the
   * device-flow path, which asks for scopes at device-authorization time.
   */
  scopes?: string[];
}

export interface McpCredentialBinding {
  server: string;
  serverUrl: string;
  resource: string;
  clientId: string;
  scopes: string[];
}

const MAX_MCP_SCOPES = 64;
const MAX_MCP_SCOPE_LENGTH = 256;

export function canonicalMcpResource(raw: string): string {
  const parsed = new URL(raw);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('MCP OAuth resource must use HTTP or HTTPS');
  if (parsed.username || parsed.password) throw new Error('MCP OAuth resource must not contain credentials');
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }
  const serialized = parsed.toString();
  const suffix = `${parsed.search}${parsed.hash}`;
  if (parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
    return `${serialized.slice(0, serialized.length - suffix.length - 1)}${suffix}`;
  }
  return serialized.endsWith('/') ? serialized.slice(0, -1) : serialized;
}

export function normalizeMcpScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes) return [];
  if (scopes.length > MAX_MCP_SCOPES) throw new Error('MCP OAuth scope set is too large');
  const out: string[] = [];
  for (const raw of scopes) {
    const scope = raw.trim();
    if (!scope || scope.length > MAX_MCP_SCOPE_LENGTH || /[\s\x00-\x1f\x7f]/u.test(scope)) {
      throw new Error(`Invalid MCP OAuth scope: ${JSON.stringify(raw)}`);
    }
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

export function readMcpCredentialBinding(value: unknown): McpCredentialBinding | null {
  if (!value || typeof value !== 'object') return null;
  const binding = value as Record<string, unknown>;
  if (typeof binding.server !== 'string'
    || typeof binding.serverUrl !== 'string'
    || typeof binding.resource !== 'string'
    || typeof binding.clientId !== 'string'
    || !Array.isArray(binding.scopes)
    || !binding.scopes.every((scope) => typeof scope === 'string')) return null;
  try {
    return {
      server: binding.server,
      serverUrl: canonicalMcpResource(binding.serverUrl),
      resource: canonicalMcpResource(binding.resource),
      clientId: binding.clientId,
      scopes: normalizeMcpScopes(binding.scopes as string[]),
    };
  } catch { return null; }
}

function normalizedConfig(config: McpOAuthConfig): McpOAuthConfig {
  const resource = canonicalMcpResource(config.resource ?? config.serverUrl ?? '');
  const serverUrl = canonicalMcpResource(config.serverUrl ?? resource);
  if (resource !== serverUrl) throw new Error('MCP OAuth protected resource does not match the configured server endpoint');
  const scopes = normalizeMcpScopes(config.scopes);
  const supported = new Set(normalizeMcpScopes(config.endpoints.scopesSupported));
  if (supported.size > 0) {
    const unsupported = scopes.find((scope) => !supported.has(scope));
    if (unsupported) throw new Error(`MCP OAuth scope is not advertised by the authorization server: ${unsupported}`);
  }
  return { ...config, serverUrl, resource, scopes };
}

/**
 * v4.14 — a pre-registered (static) client config for providers with NO
 * Dynamic Client Registration. When present + the AS has no
 * `registration_endpoint`, Aiden uses the RFC 8628 device flow (secret-free)
 * instead of throwing. Provider-agnostic: GitHub is just the first to fill it.
 */
export interface StaticOAuthClient {
  clientId: string;
  deviceAuthorizationEndpoint: string;
  scopes?: string[];
}

/** tokenStore id for an MCP server's OAuth record. Isolated from provider ids. */
export function mcpTokenId(server: string): string {
  return `mcp_${server}`;
}

// ── Discovery ───────────────────────────────────────────────────────────────

function wellKnown(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/.well-known/${suffix}`;
}

function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
}

async function endpointAllowed(url: string, deps: Pick<OAuthDiscoveryDeps, 'endpointPolicy' | 'allowLoopbackHttp'>): Promise<boolean> {
  if (url.length > 2_048) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopbackFixture = deps.allowLoopbackHttp === true
    && parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(hostname);
  if (loopbackFixture) return true;
  if (deps.endpointPolicy && parsed.protocol !== 'https:') return false;
  if (!deps.endpointPolicy) return true;
  return !(await deps.endpointPolicy.check(parsed.toString())).blocked;
}

async function fetchJson(deps: OAuthDiscoveryDeps, url: string): Promise<Record<string, unknown> | null> {
  try {
    if (!(await endpointAllowed(url, deps))) return null;
    const res = await deps.fetchFn(url, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual',
    });
    if (!res.ok) return null;
    const text = await res.text();
    const maxBytes = deps.maxMetadataBytes ?? 512 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || Buffer.byteLength(text, 'utf8') > maxBytes) return null;
    const j: unknown = JSON.parse(text);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * RFC 9728 §3.1 — the protected-resource metadata URL inserts the well-known
 * segment BETWEEN the origin and the resource path, e.g.
 *   http://host:3000/mcp → http://host:3000/.well-known/oauth-protected-resource/mcp
 * (NOT appended after the path). For a path-less resource this collapses to the
 * root form. We try the path-inserted form first, then fall back to the root
 * form (some servers publish there regardless of resource path).
 */
function protectedResourceMetadataUrls(serverUrl: string): string[] {
  try {
    const u = new URL(serverUrl);
    const path = u.pathname.replace(/\/+$/, ''); // '' for a path-less resource
    const insertForm = `${u.origin}/.well-known/oauth-protected-resource${path}`;
    const rootForm = `${u.origin}/.well-known/oauth-protected-resource`;
    return insertForm === rootForm ? [insertForm] : [insertForm, rootForm];
  } catch {
    return [wellKnown(serverUrl, 'oauth-protected-resource')]; // unparseable — best effort
  }
}

/** RFC 9728 — the MCP server's protected-resource metadata (which AS protects it). */
export async function discoverProtectedResource(
  serverUrl: string,
  deps: OAuthDiscoveryDeps,
): Promise<{ authorizationServers: string[]; resource?: string } | null> {
  for (const url of protectedResourceMetadataUrls(serverUrl)) {
    const j = await fetchJson(deps, url);
    if (!j) continue;
    const authorizationServers = strArr(j.authorization_servers) ?? [];
    if (authorizationServers.length === 0) continue;
    return { authorizationServers, resource: typeof j.resource === 'string' ? j.resource : undefined };
  }
  return null;
}

/** RFC 8414 (with OIDC discovery fallback) — the authorization server's metadata. */
export async function discoverAuthServer(
  asUrl: string,
  deps: OAuthDiscoveryDeps,
): Promise<DiscoveredOAuth | null> {
  const j =
    (await fetchJson(deps, wellKnown(asUrl, 'oauth-authorization-server'))) ??
    (await fetchJson(deps, wellKnown(asUrl, 'openid-configuration')));
  if (!j) return null;

  const authorizationEndpoint = typeof j.authorization_endpoint === 'string' ? j.authorization_endpoint : undefined;
  const tokenEndpoint = typeof j.token_endpoint === 'string' ? j.token_endpoint : undefined;
  if (!authorizationEndpoint || !tokenEndpoint) return null; // both are required

  return {
    issuer: typeof j.issuer === 'string' ? j.issuer : undefined,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: typeof j.registration_endpoint === 'string' ? j.registration_endpoint : undefined,
    scopesSupported: strArr(j.scopes_supported),
    codeChallengeMethods: strArr(j.code_challenge_methods_supported),
  };
}

/**
 * Orchestrate PRM → AS metadata. Per the MCP spec, prefer protected-resource
 * metadata; if a server has none, fall back to treating the server URL itself
 * as the authorization server (some servers serve AS metadata at the base).
 */
export async function discoverMcpOAuth(
  serverUrl: string,
  deps: OAuthDiscoveryDeps,
): Promise<{ endpoints: DiscoveredOAuth; resource?: string } | null> {
  if (!(await endpointAllowed(serverUrl, deps))) return null;
  const prm = await discoverProtectedResource(serverUrl, deps);
  if (prm) {
    for (const as of prm.authorizationServers) {
      if (!(await endpointAllowed(as, deps))) continue;
      const ep = await discoverAuthServer(as, deps);
      if (ep && await endpointsAllowed(ep, deps)) return { endpoints: ep, resource: prm.resource ?? serverUrl };
    }
    return null; // PRM advertised AS(es) but none had usable metadata
  }
  const ep = await discoverAuthServer(serverUrl, deps); // fallback: AS metadata at the base
  return ep && await endpointsAllowed(ep, deps) ? { endpoints: ep, resource: serverUrl } : null;
}

async function endpointsAllowed(endpoints: DiscoveredOAuth, deps: OAuthDiscoveryDeps): Promise<boolean> {
  const urls = [
    endpoints.issuer,
    endpoints.authorizationEndpoint,
    endpoints.tokenEndpoint,
    endpoints.registrationEndpoint,
    endpoints.deviceAuthorizationEndpoint,
  ].filter((value): value is string => typeof value === 'string');
  for (const url of urls) if (!(await endpointAllowed(url, deps))) return false;
  return true;
}

// ── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

export interface RegisterClientOptions {
  fetchFn: FetchLike;
  /** Loopback redirect URI(s) per RFC 8252 — supplied by the caller (3a.2 serves them). */
  redirectUris: string[];
  clientName?: string;
  grantTypes?: string[];
  endpointPolicy?: Pick<SSRFProtection, 'check'>;
  allowLoopbackHttp?: boolean;
  maxMetadataBytes?: number;
}

export async function registerClient(
  registrationEndpoint: string,
  opts: RegisterClientOptions,
): Promise<RegisteredClient> {
  if (!(await endpointAllowed(registrationEndpoint, opts))) {
    throw new Error('MCP DCR endpoint is blocked by network policy');
  }
  const body = {
    client_name: opts.clientName ?? 'Aiden',
    redirect_uris: opts.redirectUris,
    grant_types: opts.grantTypes ?? ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client — PKCE, no secret
  };
  const res = await opts.fetchFn(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`MCP DCR failed: HTTP ${res.status} at ${registrationEndpoint}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const responseText = await res.text();
  const maxBytes = opts.maxMetadataBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || Buffer.byteLength(responseText, 'utf8') > maxBytes) {
    throw new Error('MCP DCR response exceeds the bounded metadata limit');
  }
  const parsed: unknown = JSON.parse(responseText);
  const j = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const clientId = typeof j.client_id === 'string' ? j.client_id : undefined;
  if (!clientId) throw new Error('MCP DCR response missing client_id');
  return {
    clientId,
    clientSecret: typeof j.client_secret === 'string' ? j.client_secret : undefined,
    redirectUris: opts.redirectUris,
  };
}

// ── Persistence (tokenStore.extras, id mcp_<server>) ─────────────────────────

function isMcpOAuthConfig(v: unknown): v is McpOAuthConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.clientId === 'string' && !!c.endpoints && typeof c.endpoints === 'object';
}

/** Read the persisted OAuth config (endpoints + DCR client) for a server, if any. */
export async function loadMcpOAuthConfig(paths: AidenPaths, server: string): Promise<McpOAuthConfig | null> {
  const tokens = await loadTokens(paths, mcpTokenId(server));
  const cfg = tokens?.extras?.oauth;
  return isMcpOAuthConfig(cfg) ? cfg : null;
}

/**
 * Persist the OAuth config into tokenStore.extras (id `mcp_<server>`),
 * preserving any existing access/refresh token (so 3a.2's flow can later fill
 * the token without losing the metadata, and re-discovery doesn't wipe a token).
 * Until the flow runs, the record is metadata-only (empty accessToken).
 */
export async function saveMcpOAuthConfig(paths: AidenPaths, server: string, config: McpOAuthConfig): Promise<void> {
  const bounded = normalizedConfig(config);
  const id = mcpTokenId(server);
  const existing = await loadTokens(paths, id);
  const tokens: OAuthTokens = {
    provider: id,
    accessToken: existing?.accessToken ?? '',
    refreshToken: existing?.refreshToken ?? null,
    expiresAtMs: existing?.expiresAtMs ?? 0,
    account: existing?.account,
    models: existing?.models,
    extras: { ...(existing?.extras ?? {}), oauth: bounded },
  };
  await saveTokens(paths, tokens);
}

/**
 * Idempotent discovery + DCR. If a config with a `clientId` is already
 * persisted, returns it WITHOUT re-registering (re-running `/mcp auth` must not
 * re-DCR). Otherwise discovers endpoints, registers a client, persists, returns.
 *
 * DELIBERATE: `/mcp` logout (clearTokens) wipes this whole record — including
 * the DCR client_id — so the next auth re-registers from a clean slate. That's
 * the intended "logout = clean slate" behaviour. Some authorization servers
 * rate-limit DCR; handle per-server only if it ever bites.
 */
export async function ensureMcpOAuthConfig(
  paths: AidenPaths,
  server: string,
  serverUrl: string,
  deps: {
    fetchFn: FetchLike;
    redirectUris: string[];
    clientName?: string;
    staticClient?: StaticOAuthClient;
    requestedScopes?: string[];
    endpointPolicy?: Pick<SSRFProtection, 'check'>;
    allowLoopbackHttp?: boolean;
    maxMetadataBytes?: number;
  },
): Promise<McpOAuthConfig> {
  const existing = await loadMcpOAuthConfig(paths, server);
  const requestedServerUrl = canonicalMcpResource(serverUrl);
  if (existing?.clientId) {
    const existingServerUrl = canonicalMcpResource(existing.serverUrl ?? existing.resource ?? '');
    if (existingServerUrl !== requestedServerUrl) {
      throw new Error(`MCP server endpoint changed for "${server}"; disconnect and authorize the new endpoint explicitly`);
    }
    const requestedScopes = normalizeMcpScopes(deps.requestedScopes ?? deps.staticClient?.scopes);
    if (requestedScopes.length > 0 && JSON.stringify(normalizeMcpScopes(existing.scopes)) !== JSON.stringify(requestedScopes)) {
      throw new Error(`MCP OAuth scopes changed for "${server}"; disconnect and authorize the new scope set explicitly`);
    }
    return normalizedConfig(existing); // idempotent — reuse only the exact registered client binding
  }

  const endpointPolicy = deps.endpointPolicy ?? (deps.fetchFn === fetch ? new SSRFProtection() : undefined);
  const discoveryDeps: OAuthDiscoveryDeps = {
    fetchFn: deps.fetchFn,
    endpointPolicy,
    allowLoopbackHttp: deps.allowLoopbackHttp,
    maxMetadataBytes: deps.maxMetadataBytes,
  };
  const discovered = await discoverMcpOAuth(serverUrl, discoveryDeps);
  if (!discovered) {
    throw new Error(`No OAuth metadata found for MCP server "${server}" (${serverUrl}) — it may not require OAuth.`);
  }
  const discoveredResource = canonicalMcpResource(discovered.resource ?? serverUrl);
  if (discoveredResource !== requestedServerUrl) {
    throw new Error(`MCP protected-resource metadata does not match the configured server endpoint for "${server}"`);
  }
  const requestedScopes = normalizeMcpScopes(deps.requestedScopes ?? deps.staticClient?.scopes);
  if (!discovered.endpoints.registrationEndpoint) {
    // v4.14 — no Dynamic Client Registration. If a static device-flow client is
    // configured (RFC 8628), use it (secret-free) instead of failing. Otherwise
    // keep the honest throw — we can't self-register and have nothing to fall
    // back to.
    const sc = deps.staticClient;
    if (sc?.clientId && sc.deviceAuthorizationEndpoint) {
      if (!(await endpointAllowed(sc.deviceAuthorizationEndpoint, discoveryDeps))) {
        throw new Error(`MCP device authorization endpoint is blocked by network policy for "${server}"`);
      }
      const deviceConfig: McpOAuthConfig = {
        serverUrl: requestedServerUrl,
        resource: discoveredResource,
        endpoints: { ...discovered.endpoints, deviceAuthorizationEndpoint: sc.deviceAuthorizationEndpoint },
        clientId: sc.clientId,
        redirectUris: [], // device flow has no redirect
        scopes: requestedScopes,
      };
      await saveMcpOAuthConfig(paths, server, deviceConfig);
      return deviceConfig;
    }
    throw new Error(
      `MCP server "${server}" authorization server has no registration_endpoint ` +
        '(no Dynamic Client Registration), and no device-flow client is configured — ' +
        'this connector needs a pre-registered client id to authorize.',
    );
  }
  const client = await registerClient(discovered.endpoints.registrationEndpoint, {
    fetchFn: deps.fetchFn,
    redirectUris: deps.redirectUris,
    clientName: deps.clientName,
    endpointPolicy,
    allowLoopbackHttp: deps.allowLoopbackHttp,
    maxMetadataBytes: deps.maxMetadataBytes,
  });
  const config: McpOAuthConfig = {
    serverUrl: requestedServerUrl,
    resource: discoveredResource,
    endpoints: discovered.endpoints,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUris: client.redirectUris,
    scopes: requestedScopes,
  };
  await saveMcpOAuthConfig(paths, server, config);
  return config;
}

/** Has a usable (non-empty, non-expired) access token been stored for this server? */
export async function hasValidToken(paths: AidenPaths, server: string): Promise<boolean> {
  const tokens = await loadTokens(paths, mcpTokenId(server));
  return !!tokens && tokens.accessToken.length > 0 && !isExpired(tokens);
}
