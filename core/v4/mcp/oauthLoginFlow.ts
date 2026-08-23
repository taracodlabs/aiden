/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/oauthLoginFlow.ts — v4.12 Slice 3a.2
 *
 * The interactive authorization-code + PKCE flow for hosted MCP servers,
 * driven through an RFC 8252 loopback redirect (CLI has no public redirect URL):
 *
 *   generatePkce → build a standard authorize URL → start a loopback HTTP
 *   server on 127.0.0.1 → open the browser → capture the `?code` on the
 *   callback → verify `state` → exchange code+verifier at the token endpoint.
 *
 * Reuses `oauthFlow.ts` primitives (generatePkce, tryTokenExchange, the
 * OAuthFlowResult/OAuthUserAgent contracts) and `oauthDiscovery.ts`'s persisted
 * config (endpoints + DCR client). Discovery/DCR is 3a.1; the transport bearer
 * seam + `needs-auth` status are 3a.3.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AidenPaths } from '../paths';
import { loadTokens, saveTokens } from '../auth/tokenStore';
import {
  generatePkce,
  tryTokenExchange,
  CONTENT_TYPE_FORM,
  type FetchImpl,
  type OAuthFlowResult,
  type OAuthUserAgent,
} from '../auth/oauthFlow';
import {
  canonicalMcpResource,
  loadMcpOAuthConfig,
  mcpTokenId,
  normalizeMcpScopes,
  readMcpCredentialBinding,
  type McpCredentialBinding,
  type McpOAuthConfig,
} from './oauthDiscovery';

/**
 * Fixed loopback ports (RFC 8252). The whole range is registered as
 * `redirect_uris` at DCR time so whichever port we actually bind is always a
 * registered redirect (registered ⊇ {bound}) — keeping registered == bound ==
 * redirected, which strict authorization servers require.
 */
export const LOOPBACK_PORTS = [8765, 8766, 8767, 8768, 8769, 8770, 8771, 8772] as const;
const CALLBACK_PATH = '/callback';
const DEFAULT_CALLBACK_TIMEOUT_MS = 120_000;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 15_000;

/** The exact redirect URIs to register via DCR (one per loopback port). */
export function loopbackRedirectUris(): string[] {
  return LOOPBACK_PORTS.map((p) => `http://127.0.0.1:${p}${CALLBACK_PATH}`);
}

// ── Loopback callback server ─────────────────────────────────────────────────

export interface LoopbackCapture {
  code: string;
  state: string;
}

export interface LoopbackServer {
  port: number;
  redirectUri: string;
  /** Resolve with the first /callback's params; reject on error param or timeout. */
  waitForCallback(timeoutMs?: number): Promise<LoopbackCapture>;
  close(): Promise<void>;
}

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>Aiden — authorized</title>' +
  '<body style="font-family:system-ui;text-align:center;padding:3rem">' +
  '<h1>✅ Authentication complete</h1><p>You can close this tab and return to Aiden.</p></body>';

function errorHtml(message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c));
  return (
    '<!doctype html><meta charset="utf-8"><title>Aiden — authorization failed</title>' +
    '<body style="font-family:system-ui;text-align:center;padding:3rem">' +
    `<h1>❌ Authorization failed</h1><p>${safe}</p></body>`
  );
}

function listenFirstFree(server: Server, ports: number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= ports.length) {
        reject(new Error(`Could not bind a loopback port (tried ${ports.join(', ')}) — all in use.`));
        return;
      }
      const p = ports[i];
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          i += 1;
          tryNext();
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(p);
      });
    };
    tryNext();
  });
}

export async function startLoopbackServer(
  opts: { ports?: number[]; createServerFn?: typeof createServer } = {},
): Promise<LoopbackServer> {
  const ports = opts.ports ?? [...LOOPBACK_PORTS];
  const create = opts.createServerFn ?? createServer;

  let settled = false;
  let resolveCb!: (v: LoopbackCapture) => void;
  let rejectCb!: (e: Error) => void;
  const captured = new Promise<LoopbackCapture>((res, rej) => {
    resolveCb = res;
    rejectCb = rej;
  });

  const server = create((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(errorHtml(`Authorization server returned: ${error}`));
      if (!settled) { settled = true; rejectCb(new Error(`Authorization denied: ${error}`)); }
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(errorHtml('Callback was missing the authorization code.'));
      if (!settled) { settled = true; rejectCb(new Error('OAuth callback missing authorization code')); }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(SUCCESS_HTML);
    if (!settled) { settled = true; resolveCb({ code, state }); }
  });

  const port = await listenFirstFree(server, ports);

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    async waitForCallback(timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS) {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectCb(new Error(`OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s`));
        }
      }, timeoutMs);
      try {
        return await captured;
      } finally {
        clearTimeout(timer);
      }
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── Authorize URL (standard OAuth 2.1 auth-code + PKCE) ──────────────────────

export function buildAuthorizeUrl(
  cfg: { authorizationEndpoint: string; clientId: string; redirectUri: string; scope?: string; resource?: string },
  challenge: string,
  state: string,
): string {
  const u = new URL(cfg.authorizationEndpoint);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  if (cfg.scope) u.searchParams.set('scope', cfg.scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (cfg.resource) u.searchParams.set('resource', cfg.resource); // RFC 8707
  return u.toString();
}

// ── End-to-end flow ──────────────────────────────────────────────────────────

export async function runLoopbackAuthFlow(deps: {
  config: McpOAuthConfig;
  server: string;
  ua: OAuthUserAgent;
  fetchImpl?: FetchImpl;
  /** DI seams for tests. */
  startServer?: typeof startLoopbackServer;
  makeState?: () => string;
}): Promise<OAuthFlowResult> {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchImpl);
  const pkce = generatePkce();
  const state = (deps.makeState ?? (() => generatePkce().verifier))();

  const loop = await (deps.startServer ?? startLoopbackServer)();
  try {
    const authUrl = buildAuthorizeUrl(
      {
        authorizationEndpoint: deps.config.endpoints.authorizationEndpoint,
        clientId: deps.config.clientId,
        redirectUri: loop.redirectUri,
        scope: normalizeMcpScopes(deps.config.scopes).join(' ') || undefined,
        resource: deps.config.resource,
      },
      pkce.challenge,
      state,
    );

    deps.ua.log('');
    deps.ua.log(`Authorize Aiden to access the "${deps.server}" MCP server.`);
    deps.ua.log('Opening your browser — if it does not open, paste this URL:');
    deps.ua.log(`  ${authUrl}`);
    await deps.ua.openBrowser(authUrl).catch(() => undefined);

    const cb = await loop.waitForCallback();
    if (cb.state !== state) {
      throw new Error('OAuth state mismatch — possible CSRF; aborting.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: cb.code,
      redirect_uri: loop.redirectUri,
      client_id: deps.config.clientId,
      code_verifier: pkce.verifier,
    });
    if (deps.config.resource) body.set('resource', deps.config.resource);

    return await tryTokenExchange(
      [deps.config.endpoints.tokenEndpoint],
      body.toString(),
      CONTENT_TYPE_FORM,
      { Accept: 'application/json' },
      fetchImpl,
      DEFAULT_EXCHANGE_TIMEOUT_MS,
    );
  } finally {
    await loop.close();
  }
}

/**
 * Persist a completed flow's tokens into tokenStore (id `mcp_<server>`),
 * converting the relative `expiresInSeconds` to an ABSOLUTE `expiresAtMs` and
 * read-merging so the discovery config (`extras.oauth` from 3a.1) is preserved.
 */
export async function persistMcpTokens(
  paths: AidenPaths,
  server: string,
  result: OAuthFlowResult,
  suppliedConfig?: McpOAuthConfig,
): Promise<void> {
  const id = mcpTokenId(server);
  const existing = await loadTokens(paths, id);
  const config = suppliedConfig ?? await loadMcpOAuthConfig(paths, server);
  if (!config) throw new Error(`Cannot persist MCP credential for "${server}" without an OAuth configuration`);
  const serverUrl = canonicalMcpResource(config.serverUrl ?? config.resource ?? '');
  const resource = canonicalMcpResource(config.resource ?? serverUrl);
  if (serverUrl !== resource) throw new Error('MCP OAuth credential resource does not match the configured server endpoint');
  const requestedScopes = normalizeMcpScopes(config.scopes);
  const reportedScopes = typeof result.extras?.scope === 'string'
    ? normalizeMcpScopes(result.extras.scope.split(/\s+/u).filter(Boolean))
    : [];
  const priorBinding = readMcpCredentialBinding(existing?.extras?.mcpBinding);
  const allowedScopes = priorBinding?.scopes.length ? priorBinding.scopes : requestedScopes;
  if (allowedScopes.length > 0 && reportedScopes.some((scope) => !allowedScopes.includes(scope))) {
    throw new Error('MCP OAuth token response expanded the authorized scope set');
  }
  const binding: McpCredentialBinding = {
    server,
    serverUrl,
    resource,
    clientId: config.clientId,
    scopes: reportedScopes.length > 0 ? reportedScopes : allowedScopes,
  };
  await saveTokens(paths, {
    provider: id,
    accessToken: result.accessToken,
    // Refresh-token rotation: many servers return only a new access_token on
    // refresh (no refresh_token) — keep the prior one so the next refresh works.
    refreshToken: result.refreshToken ?? existing?.refreshToken ?? null,
    expiresAtMs: Date.now() + result.expiresInSeconds * 1000,
    account: existing?.account,
    models: existing?.models,
    extras: { ...(existing?.extras ?? {}), ...(result.extras ?? {}), oauth: config, mcpBinding: binding },
  });
}
