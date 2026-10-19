/** Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SSRFProtection } from '../../../moat/ssrfProtection';
import { secureFetch } from '../../../moat/secureFetch';
import type { ConfigManager } from '../config';
import type { AidenPaths } from '../paths';
import type { McpClient, McpServerConfig } from '../mcpClient';
import type { OAuthUserAgent } from '../auth/oauthFlow';
import { ensureMcpOAuthConfig } from '../mcp/oauthDiscovery';
import { loopbackRedirectUris, persistMcpTokens, runLoopbackAuthFlow } from '../mcp/oauthLoginFlow';
import { runMcpDeviceFlow } from '../mcp/deviceFlow';

type Entry = Omit<McpServerConfig, 'name'>;
type Consent = { url: string; userCode?: string; expiresAt: number };
export interface McpAuthorizationSnapshot {
  id: string; name: string;
  state: 'preparing' | 'waiting' | 'saving' | 'connecting' | 'connected' | 'authorized' | 'failed' | 'cancelled';
  message: string; url?: string; userCode?: string; expiresAt?: number;
}
interface AuthorizationRun {
  name: string; entry: Entry; signal: AbortSignal;
  onAuthorization(request: Consent): Promise<void>;
  beforePersist(): void;
}
export interface WorkbenchMcpAuthorization {
  snapshot(): McpAuthorizationSnapshot | null;
  isBusy(): boolean;
  start(name: string): McpAuthorizationSnapshot;
  cancel(id: string): Promise<void>;
  close(): Promise<void>;
}

/** Runtime-token-protected presentation over the same discovery, PKCE/device
 * flow, token store and MCP client used by the CLI. No credentials enter Jobs.
 * Consent links are transient and are discarded at completion or shutdown. */
export function createWorkbenchMcpAuthorization(input: {
  paths: AidenPaths;
  config: Pick<ConfigManager, 'getValue'>;
  client: Pick<McpClient, 'get' | 'connect' | 'authorizeAndConnect'>;
  enabled(): boolean;
  isIdle(): boolean;
  /** Protocol seam for deterministic tests; omitted by the installed runtime. */
  run?(request: AuthorizationRun): Promise<void>;
}): WorkbenchMcpAuthorization {
  let closed = false;
  let current: McpAuthorizationSnapshot | null = null;
  let active: { controller: AbortController; promise: Promise<void> } | null = null;
  const configured = (name: string) => input.config.getValue<Record<string, Entry>>('mcp.servers')?.[name];
  const terminal = (state: McpAuthorizationSnapshot['state'], message: string) => {
    if (current) current = { id: current.id, name: current.name, state, message };
  };
  const run = input.run ?? (async (request: AuthorizationRun) => {
    const policy = new SSRFProtection();
    const safeUrl = async (raw: string) => {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || (await policy.check(url.toString())).blocked) throw new Error('Authorization endpoint is blocked');
    };
    const fetchFn: typeof fetch = async (resource, init) => {
      const url = String(resource); await safeUrl(url);
      return secureFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
    };
    const oauth = request.entry.http?.oauth;
    const clientId = (oauth?.clientId || process.env[`AIDEN_MCP_${request.name.toUpperCase()}_CLIENT_ID`] || '').trim();
    if (oauth?.deviceAuthorizationEndpoint && !clientId) throw new Error('Registered public OAuth client ID is required');
    const config = await ensureMcpOAuthConfig(input.paths, request.name, request.entry.http!.baseUrl, {
      fetchFn, endpointPolicy: policy, redirectUris: loopbackRedirectUris(), requestedScopes: oauth?.scopes,
      staticClient: oauth?.deviceAuthorizationEndpoint ? { clientId, deviceAuthorizationEndpoint: oauth.deviceAuthorizationEndpoint, scopes: oauth.scopes } : undefined,
    });
    request.signal.throwIfAborted();
    const ua: OAuthUserAgent = {
      log() { /* Authorization URLs and codes belong only in the protected UI. */ },
      async openBrowser() { /* The user opens the explicit consent link in Web. */ },
      async prompt() { throw new Error('Manual credential entry is not supported'); },
      async sleep(ms) { await delay(ms, undefined, { signal: request.signal }); },
      async onAuthorization(value) { await safeUrl(value.url); await request.onAuthorization(value); },
    };
    const result = config.endpoints.deviceAuthorizationEndpoint
      ? await runMcpDeviceFlow({ config: { deviceAuthorizationEndpoint: config.endpoints.deviceAuthorizationEndpoint, tokenEndpoint: config.endpoints.tokenEndpoint, clientId: config.clientId, scope: config.scopes?.join(' '), resource: config.resource }, server: request.name, ua, fetchImpl: fetchFn, signal: request.signal })
      : await runLoopbackAuthFlow({ config, server: request.name, ua, fetchImpl: fetchFn, signal: request.signal });
    request.beforePersist();
    await persistMcpTokens(input.paths, request.name, result, config);
  });
  const port: WorkbenchMcpAuthorization = {
    snapshot: () => current ? { ...current } : null,
    isBusy: () => active !== null,
    start(name) {
      if (closed) throw new Error('MCP authorization is closed');
      if (active) throw new Error('MCP authorization is already in progress');
      if (!input.enabled() || !input.isIdle()) throw new Error('MCP authorization requires an available idle runtime');
      const entry = configured(name);
      if (!/^[a-zA-Z0-9_]{1,128}$/.test(name) || !entry || entry.type !== 'http' || !entry.http?.baseUrl) throw new Error('Choose a configured HTTPS MCP server');
      const url = new URL(entry.http.baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Web authorization requires an HTTPS server without inline credentials');
      const original = JSON.stringify(entry);
      const controller = new AbortController();
      const checkCurrent = () => {
        controller.signal.throwIfAborted();
        if (closed || !input.enabled() || JSON.stringify(configured(name)) !== original) throw new Error('Authorization configuration changed');
      };
      current = { id: randomUUID(), name, state: 'preparing', message: 'Preparing provider authorization. No access has been granted.' };
      const deadline = setTimeout(() => controller.abort(), 120000); deadline.unref();
      const owned = { controller, promise: Promise.resolve() }; active = owned;
      owned.promise = (async () => {
        let persisted = false;
        try {
          await run({ name, entry: structuredClone(entry), signal: controller.signal,
            async onAuthorization(value) {
              checkCurrent(); const link = new URL(value.url);
              if (link.protocol !== 'https:' || link.username || link.password || value.url.length > 8192 || !Number.isFinite(value.expiresAt) || (value.userCode !== undefined && (typeof value.userCode !== 'string' || value.userCode.length > 256))) throw new Error('Invalid authorization response');
              current = { ...current!, state: 'waiting', message: 'Review permissions on the provider website. Aiden is waiting for its verified response.', url: link.toString(), userCode: value.userCode, expiresAt: Math.min(value.expiresAt, Date.now() + 120000) };
            },
            beforePersist() { checkCurrent(); clearTimeout(deadline); terminal('saving', 'Saving the verified authorization in protected storage.'); },
          });
          persisted = current?.state === 'saving';
          checkCurrent();
          if (!persisted) throw new Error('Authorization did not confirm protected persistence');
          if (!input.isIdle()) { terminal('authorized', 'Authorization saved. Reconnect after active work finishes.'); return; }
          terminal('connecting', 'Authorization saved. Checking the server connection.');
          try {
            const connection = input.client.get(name) ? await input.client.authorizeAndConnect(name) : await input.client.connect({ ...entry, name });
            if (connection.status !== 'ready') throw new Error('Server has not reached ready state');
            terminal('connected', 'Provider authorization and server connection completed. Tool review and execution permissions remain separate.');
          } catch { terminal('authorized', 'Authorization saved, but the server connection failed. Review status before reconnecting.'); }
        } catch {
          if (persisted) terminal('authorized', 'Authorization was saved, but connection was not started. Review current configuration and reconnect when ready.');
          else terminal(controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? 'Authorization cancelled or expired. No connection was started.' : 'Authorization did not complete. Check the server OAuth configuration or registered public client ID, then try again.');
        } finally { clearTimeout(deadline); if (active === owned) active = null; }
      })();
      return { ...current };
    },
    async cancel(id) {
      if (!active || current?.id !== id) throw new Error('Authorization request is no longer active');
      if (current.state === 'saving' || current.state === 'connecting') throw new Error('Verified authorization is being saved; wait for its result before changing the connection');
      const owned = active; owned.controller.abort(); await owned.promise;
    },
    async close() {
      closed = true;
      if (active) { const owned = active; owned.controller.abort(); await owned.promise; }
      if (current) { delete current.url; delete current.userCode; }
    },
  };
  return port;
}
