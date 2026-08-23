/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 3a.1 — MCP OAuth discovery + DCR + metadata persistence.
 * All HTTP mocked via injected fetchFn; persistence uses the REAL tokenStore
 * (temp paths + AIDEN_TOKEN_KEY for deterministic encryption round-trip).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { saveTokens } from '../../../core/v4/auth/tokenStore';
import {
  discoverProtectedResource,
  discoverAuthServer,
  discoverMcpOAuth,
  registerClient,
  ensureMcpOAuthConfig,
  loadMcpOAuthConfig,
  hasValidToken,
  mcpTokenId,
  type FetchLike,
} from '../../../core/v4/mcp/oauthDiscovery';

function res(ok: boolean, status: number, json: unknown) {
  return { ok, status, json: async () => json, text: async () => JSON.stringify(json) };
}
interface Route { match: (url: string) => boolean; reply: () => ReturnType<typeof res>; }
function mockFetch(routes: Route[]) {
  const calls: Array<{ url: string; init?: { method?: string; body?: string; redirect?: string } }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    for (const r of routes) if (r.match(url)) return r.reply();
    return res(false, 404, { error: 'not found' });
  };
  return { fn, calls };
}
const has = (sub: string) => (u: string) => u.includes(sub);

const SRV = 'https://srv.example';
const AS = 'https://as.example';
const REDIRECTS = ['http://127.0.0.1:0/oauth/callback'];

const asMeta = {
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  scopes_supported: ['mcp', 'profile'],
  code_challenge_methods_supported: ['S256'],
};

describe('oauthDiscovery — RFC 9728 protected-resource metadata', () => {
  it('parses authorization_servers + resource', async () => {
    const { fn } = mockFetch([{ match: has('/.well-known/oauth-protected-resource'),
      reply: () => res(true, 200, { authorization_servers: [AS], resource: SRV }) }]);
    expect(await discoverProtectedResource(SRV, { fetchFn: fn })).toEqual({ authorizationServers: [AS], resource: SRV });
  });
  it('returns null when PRM is missing (404)', async () => {
    const { fn } = mockFetch([]);
    expect(await discoverProtectedResource(SRV, { fetchFn: fn })).toBeNull();
  });
  it('returns null when PRM has no authorization_servers', async () => {
    const { fn } = mockFetch([{ match: has('oauth-protected-resource'), reply: () => res(true, 200, { foo: 1 }) }]);
    expect(await discoverProtectedResource(SRV, { fetchFn: fn })).toBeNull();
  });
  it('inserts well-known BEFORE the resource path (RFC 9728 §3.1)', async () => {
    const SRVP = 'http://127.0.0.1:3000/mcp';
    const { fn, calls } = mockFetch([
      { match: (u) => u === 'http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp',
        reply: () => res(true, 200, { authorization_servers: [AS], resource: SRVP }) },
    ]);
    const prm = await discoverProtectedResource(SRVP, { fetchFn: fn });
    expect(prm?.authorizationServers).toEqual([AS]);
    expect(calls[0].url).toBe('http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp');
  });
  it('falls back to the root-form PRM when the path-inserted form 404s', async () => {
    const SRVP = 'http://127.0.0.1:3000/mcp';
    const { fn, calls } = mockFetch([
      { match: (u) => u === 'http://127.0.0.1:3000/.well-known/oauth-protected-resource',
        reply: () => res(true, 200, { authorization_servers: [AS] }) },
    ]);
    const prm = await discoverProtectedResource(SRVP, { fetchFn: fn });
    expect(prm?.authorizationServers).toEqual([AS]);
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp', // tried first
      'http://127.0.0.1:3000/.well-known/oauth-protected-resource',     // fallback
    ]);
  });

  it('uses manual redirect handling and rejects oversized metadata bodies', async () => {
    let redirect: string | undefined;
    const fn: FetchLike = async (_url, init) => {
      redirect = init?.redirect;
      return {
        ok: true,
        status: 200,
        json: async () => ({ authorization_servers: [AS], resource: SRV }),
        text: async () => JSON.stringify({ authorization_servers: [AS], padding: 'x'.repeat(1_024) }),
      };
    };
    expect(await discoverProtectedResource(SRV, { fetchFn: fn, maxMetadataBytes: 128 })).toBeNull();
    expect(redirect).toBe('manual');
  });
});

describe('oauthDiscovery — RFC 8414 AS metadata', () => {
  it('parses endpoints', async () => {
    const { fn } = mockFetch([{ match: has('oauth-authorization-server'), reply: () => res(true, 200, asMeta) }]);
    const ep = await discoverAuthServer(AS, { fetchFn: fn });
    expect(ep).toMatchObject({
      authorizationEndpoint: `${AS}/authorize`,
      tokenEndpoint: `${AS}/token`,
      registrationEndpoint: `${AS}/register`,
      scopesSupported: ['mcp', 'profile'],
      codeChallengeMethods: ['S256'],
    });
  });
  it('falls back to openid-configuration', async () => {
    const { fn } = mockFetch([{ match: has('openid-configuration'), reply: () => res(true, 200, asMeta) }]);
    const ep = await discoverAuthServer(AS, { fetchFn: fn });
    expect(ep?.tokenEndpoint).toBe(`${AS}/token`);
  });
  it('returns null when token/authorize endpoints are absent', async () => {
    const { fn } = mockFetch([{ match: has('oauth-authorization-server'), reply: () => res(true, 200, { issuer: AS }) }]);
    expect(await discoverAuthServer(AS, { fetchFn: fn })).toBeNull();
  });
  it('endpoints without registration_endpoint are allowed (DCR-unsupported)', async () => {
    const { registration_endpoint, ...noReg } = asMeta;
    const { fn } = mockFetch([{ match: has('oauth-authorization-server'), reply: () => res(true, 200, noReg) }]);
    const ep = await discoverAuthServer(AS, { fetchFn: fn });
    expect(ep?.registrationEndpoint).toBeUndefined();
  });
});

describe('oauthDiscovery — discoverMcpOAuth orchestration', () => {
  it('PRM → AS metadata chain', async () => {
    const { fn } = mockFetch([
      { match: has('oauth-protected-resource'), reply: () => res(true, 200, { authorization_servers: [AS], resource: SRV }) },
      { match: (u) => u.startsWith(AS) && u.includes('oauth-authorization-server'), reply: () => res(true, 200, asMeta) },
    ]);
    const out = await discoverMcpOAuth(SRV, { fetchFn: fn });
    expect(out?.endpoints.tokenEndpoint).toBe(`${AS}/token`);
    expect(out?.resource).toBe(SRV);
  });
  it('fallback: no PRM → AS metadata at the server base', async () => {
    const { fn } = mockFetch([
      { match: (u) => u.startsWith(SRV) && u.includes('oauth-authorization-server'), reply: () => res(true, 200, asMeta) },
    ]);
    const out = await discoverMcpOAuth(SRV, { fetchFn: fn });
    expect(out?.endpoints.authorizationEndpoint).toBe(`${AS}/authorize`);
    expect(out?.resource).toBe(SRV);
  });

  it('does not fetch an authorization server rejected by endpoint policy', async () => {
    const unsafe = 'http://127.0.0.1:9123';
    let unsafeFetches = 0;
    const fn: FetchLike = async (url) => {
      if (url.includes('oauth-protected-resource')) {
        return res(true, 200, { authorization_servers: [unsafe], resource: SRV });
      }
      if (url.startsWith(unsafe)) unsafeFetches += 1;
      return res(true, 200, {
        authorization_endpoint: `${unsafe}/authorize`, token_endpoint: `${unsafe}/token`,
      });
    };
    const out = await discoverMcpOAuth(SRV, {
      fetchFn: fn,
      endpointPolicy: {
        check: async (url) => url.startsWith(unsafe)
          ? { blocked: true, reason: 'loopback address' }
          : { blocked: false },
      },
    });
    expect(out).toBeNull();
    expect(unsafeFetches).toBe(0);
  });
});

describe('oauthDiscovery — RFC 7591 DCR', () => {
  it('registers with loopback redirect_uris + PKCE public-client body, parses client_id', async () => {
    const { fn, calls } = mockFetch([{ match: has('/register'), reply: () => res(true, 201, { client_id: 'dyn-123', client_secret: 's' }) }]);
    const client = await registerClient(`${AS}/register`, { fetchFn: fn, redirectUris: REDIRECTS });
    expect(client).toEqual({ clientId: 'dyn-123', clientSecret: 's', redirectUris: REDIRECTS });
    const body = JSON.parse(calls.at(-1)!.init!.body!);
    expect(body.redirect_uris).toEqual(REDIRECTS);
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.response_types).toEqual(['code']);
    expect(body.token_endpoint_auth_method).toBe('none');
  });
  it('throws when client_id missing', async () => {
    const { fn } = mockFetch([{ match: has('/register'), reply: () => res(true, 201, { nope: true }) }]);
    await expect(registerClient(`${AS}/register`, { fetchFn: fn, redirectUris: REDIRECTS })).rejects.toThrow(/missing client_id/);
  });
  it('throws on non-ok registration response', async () => {
    const { fn } = mockFetch([{ match: has('/register'), reply: () => res(false, 400, { error: 'bad' }) }]);
    await expect(registerClient(`${AS}/register`, { fetchFn: fn, redirectUris: REDIRECTS })).rejects.toThrow(/DCR failed: HTTP 400/);
  });
});

describe('oauthDiscovery — persistence into tokenStore.extras (real store)', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-oauth-')); process.env.AIDEN_TOKEN_KEY = 'test-key-3a1'; });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); delete process.env.AIDEN_TOKEN_KEY; });

  const fullMock = () => mockFetch([
    { match: has('oauth-protected-resource'), reply: () => res(true, 200, { authorization_servers: [AS], resource: SRV }) },
    { match: has('oauth-authorization-server'), reply: () => res(true, 200, asMeta) },
    { match: has('/register'), reply: () => res(true, 201, { client_id: 'dyn-123' }) },
  ]);

  it('ensure → discover + DCR + persist; loadMcpOAuthConfig round-trips from extras', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    const { fn } = fullMock();
    const cfg = await ensureMcpOAuthConfig(paths, 'fs', SRV, { fetchFn: fn, redirectUris: REDIRECTS });
    expect(cfg.clientId).toBe('dyn-123');
    expect(cfg.endpoints.tokenEndpoint).toBe(`${AS}/token`);

    const loaded = await loadMcpOAuthConfig(paths, 'fs');
    expect(loaded?.clientId).toBe('dyn-123');
    expect(loaded?.endpoints.registrationEndpoint).toBe(`${AS}/register`);
    expect(loaded?.resource).toBe(SRV);
  });

  it('idempotent: a second ensure reuses the persisted client and does NOT re-call registration', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await ensureMcpOAuthConfig(paths, 'fs', SRV, { fetchFn: fullMock().fn, redirectUris: REDIRECTS });

    const second = mockFetch([]); // any fetch would 404 — but none should happen
    const cfg = await ensureMcpOAuthConfig(paths, 'fs', SRV, { fetchFn: second.fn, redirectUris: REDIRECTS });
    expect(cfg.clientId).toBe('dyn-123');
    expect(second.calls).toEqual([]); // no discovery, no DCR on the second call
  });

  it('hasValidToken: false for metadata-only record, true once a live token is stored', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await ensureMcpOAuthConfig(paths, 'fs', SRV, { fetchFn: fullMock().fn, redirectUris: REDIRECTS });
    expect(await hasValidToken(paths, 'fs')).toBe(false); // accessToken '' until the flow

    // Simulate 3a.2 having completed the flow (preserve extras via load not needed for this check).
    await saveTokens(paths, {
      provider: mcpTokenId('fs'),
      accessToken: 'live-token',
      refreshToken: 'r',
      expiresAtMs: Date.now() + 3_600_000,
    });
    expect(await hasValidToken(paths, 'fs')).toBe(true);
  });

  it('no .well-known anywhere → clear error', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await expect(
      ensureMcpOAuthConfig(paths, 'fs', SRV, { fetchFn: mockFetch([]).fn, redirectUris: REDIRECTS }),
    ).rejects.toThrow(/No OAuth metadata/);
  });

  it('AS without registration_endpoint → clear DCR-unsupported error', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    const { registration_endpoint, ...noReg } = asMeta;
    const { fn } = mockFetch([
      { match: has('oauth-protected-resource'), reply: () => res(true, 200, { authorization_servers: [AS], resource: SRV }) },
      { match: has('oauth-authorization-server'), reply: () => res(true, 200, noReg) },
    ]);
    await expect(
      ensureMcpOAuthConfig(paths, 'fs', SRV, { fetchFn: fn, redirectUris: REDIRECTS }),
    ).rejects.toThrow(/Dynamic Client Registration|registration_endpoint/);
  });
});
