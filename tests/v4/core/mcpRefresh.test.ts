/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 3b — proactive refresh + concurrent-401 dedup + reactive
 * 401→retry-once + persistent-401→needs-auth + refresh-token rotation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { loadTokens, saveTokens } from '../../../core/v4/auth/tokenStore';
import type { FetchImpl } from '../../../core/v4/auth/oauthFlow';
import { HttpTransport, type McpTransport } from '../../../core/v4/mcp/transport';
import { createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { createMcpAuthProvider } from '../../../core/v4/mcp/mcpAuth';
import { saveMcpOAuthConfig, mcpTokenId, type McpOAuthConfig } from '../../../core/v4/mcp/oauthDiscovery';

const CONFIG: McpOAuthConfig = {
  resource: 'http://srv/mcp',
  endpoints: { authorizationEndpoint: 'https://as/authorize', tokenEndpoint: 'https://as/token', registrationEndpoint: 'https://as/register' },
  clientId: 'c1',
  redirectUris: ['http://127.0.0.1:8765/callback'],
};

/** A fetch that returns a token body and counts calls to the token endpoint. */
function tokenFetch(body: Record<string, unknown>, status = 200) {
  const state = { tokenCalls: 0, bodies: [] as string[] };
  const fn: FetchImpl = async (_url, init) => {
    state.tokenCalls += 1;
    state.bodies.push(init.body ?? '');
    return { status, text: async () => JSON.stringify(body) };
  };
  return { fn, state };
}

describe('mcpAuth — proactive refresh + dedup (real tokenStore)', () => {
  let tmp: string;
  let paths: ReturnType<typeof resolveAidenPaths>;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-3b-'));
    process.env.AIDEN_TOKEN_KEY = 'k3b';
    paths = resolveAidenPaths({ rootOverride: tmp });
    await saveMcpOAuthConfig(paths, 'srv', CONFIG);
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); delete process.env.AIDEN_TOKEN_KEY; });

  const storeToken = (accessToken: string, refreshToken: string | null, expiresAtMs: number) =>
    saveTokens(paths, { provider: mcpTokenId('srv'), accessToken, refreshToken, expiresAtMs, extras: { oauth: CONFIG } });

  it('refreshes within the pre-flight window and returns the fresh token', async () => {
    await storeToken('OLD', 'R1', Date.now() + 60_000); // 1 min left → inside 5-min preflight
    const { fn, state } = tokenFetch({ access_token: 'NEW', refresh_token: 'R2', expires_in: 3600 });
    const res = await createMcpAuthProvider(paths, { fetchImpl: fn }).resolve('srv');
    expect(res.state).toBe('ready');
    if (res.state === 'ready') expect(await res.authHeader()).toEqual({ Authorization: 'Bearer NEW' });
    expect(state.tokenCalls).toBe(1);
    expect((await loadTokens(paths, mcpTokenId('srv')))?.accessToken).toBe('NEW');
  });

  it('dedup: N concurrent stale gets → exactly ONE refresh call', async () => {
    await storeToken('OLD', 'R1', Date.now() + 60_000);
    const { fn, state } = tokenFetch({ access_token: 'NEW', expires_in: 3600 });
    const res = await createMcpAuthProvider(paths, { fetchImpl: fn }).resolve('srv');
    if (res.state !== 'ready') throw new Error('expected ready');
    const headers = await Promise.all(Array.from({ length: 6 }, () => res.authHeader()));
    expect(state.tokenCalls).toBe(1); // collapsed
    for (const h of headers) expect(h).toEqual({ Authorization: 'Bearer NEW' });
  });

  it('expired-but-refreshable → resolve ready (not needs-auth)', async () => {
    await storeToken('OLD', 'R1', Date.now() - 1000); // already expired
    const { fn } = tokenFetch({ access_token: 'NEW', expires_in: 3600 });
    expect((await createMcpAuthProvider(paths, { fetchImpl: fn }).resolve('srv')).state).toBe('ready');
  });

  it('refresh fails → needs-auth', async () => {
    await storeToken('OLD', 'R1', Date.now() - 1000);
    const { fn } = tokenFetch({ error: 'invalid_grant' }, 400);
    expect((await createMcpAuthProvider(paths, { fetchImpl: fn }).resolve('srv')).state).toBe('needs-auth');
  });

  it('expired with NO refresh_token → needs-auth', async () => {
    await storeToken('OLD', null, Date.now() - 1000);
    const { fn } = tokenFetch({ access_token: 'NEW', expires_in: 3600 });
    expect((await createMcpAuthProvider(paths, { fetchImpl: fn }).resolve('srv')).state).toBe('needs-auth');
  });

  it('rotation: refresh response without refresh_token keeps the prior one', async () => {
    await storeToken('OLD', 'R1', Date.now() - 1000);
    const { fn } = tokenFetch({ access_token: 'NEW', expires_in: 3600 }); // no refresh_token
    const res = await createMcpAuthProvider(paths, { fetchImpl: fn }).resolve('srv');
    if (res.state === 'ready') await res.authHeader();
    const stored = await loadTokens(paths, mcpTokenId('srv'));
    expect(stored?.accessToken).toBe('NEW');
    expect(stored?.refreshToken).toBe('R1'); // preserved
  });
});

// ── Transport reactive 401 → retry-once ──────────────────────────────────────

function seqFetch(statuses: number[]) {
  let i = 0;
  const state = { calls: 0 };
  const fn = (async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1; state.calls += 1;
    return { ok: status < 400, status, statusText: status === 401 ? 'Unauthorized' : 'OK', json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }) };
  }) as unknown as typeof fetch;
  return { fn, state };
}

describe('HttpTransport — reactive 401 → refresh + retry once', () => {
  it('401 then 200: calls onAuthError once, retries, succeeds', async () => {
    const { fn, state } = seqFetch([401, 200]);
    let authCalls = 0;
    const t = new HttpTransport({ baseUrl: 'http://x', fetchFn: fn, disableSse: true,
      authHeader: async () => ({ Authorization: 'Bearer T' }), onAuthError: async () => { authCalls++; return true; } });
    expect(await t.request('m')).toEqual({ ok: true });
    expect(state.calls).toBe(2);
    expect(authCalls).toBe(1);
    await t.close();
  });

  it('persistent 401: refresh succeeds but server still 401s → auth-distinct error, no third try', async () => {
    const { fn, state } = seqFetch([401, 401]);
    const t = new HttpTransport({ baseUrl: 'http://x', fetchFn: fn, disableSse: true, onAuthError: async () => true });
    await expect(t.request('m')).rejects.toThrow(/401|token rejected/);
    expect(state.calls).toBe(2); // one + one retry, then throw
    await t.close();
  });

  it('onAuthError returns false (refresh failed) → no retry', async () => {
    const { fn, state } = seqFetch([401, 200]);
    const t = new HttpTransport({ baseUrl: 'http://x', fetchFn: fn, disableSse: true, onAuthError: async () => false });
    await expect(t.request('m')).rejects.toThrow(/401|token rejected/);
    expect(state.calls).toBe(1); // not retried
    await t.close();
  });
});

// ── callTool: persistent auth error → needs-auth ─────────────────────────────

class AuthFailTransport implements McpTransport {
  readonly label = 'authfail';
  request(method: string): Promise<unknown> {
    if (method === 'initialize') return Promise.resolve({ capabilities: {} });
    if (method === 'tools/list') return Promise.resolve({ tools: [{ name: 't' }] });
    return Promise.reject(new Error('HTTP 401 Unauthorized from http:x — token rejected (auth failed)'));
  }
  notify(): void {}
  onNotification(): void {}
  onExit(): void {}
  close(): Promise<void> { return Promise.resolve(); }
}

describe('McpClient.callTool — persistent auth error → typed auth_required (v4.14)', () => {
  it('returns a TYPED auth_required result (not a raw throw), locks the server needs-auth', async () => {
    const registry = new ToolRegistry();
    const client = createMcpClient(registry, {
      log: () => {},
      authProvider: { resolve: async () => ({ state: 'ready', authHeader: async () => ({}), onAuthError: async () => false }) },
      streamableFactory: (() => new AuthFailTransport()) as never,
    });
    const server = await client.connect({ name: 'gm', type: 'http', http: { baseUrl: 'http://x' } });
    expect(server.status).toBe('ready');
    expect(registry.get('mcp_gm_t')).toBeDefined();

    // v4.14 anti-fake-success — the auth failure comes back as a first-class
    // typed result the runtime understands, never a raw exception the model
    // could misread as transient.
    const result = await client.callTool('gm', 't', {}) as {
      success: boolean; error: string;
      auth_required?: { provider: string; retryable: boolean; reauth_hint: string };
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^auth_required:/);
    expect(result.auth_required?.provider).toBe('gm');
    expect(result.auth_required?.retryable).toBe(false);
    expect(result.auth_required?.reauth_hint).toMatch(/\/mcp auth gm/);

    expect(client.get('gm')?.status).toBe('needs-auth');
    expect(client.get('gm')?.tools).toEqual([]);
    expect(registry.get('mcp_gm_t')).toBeUndefined();
  });
});
