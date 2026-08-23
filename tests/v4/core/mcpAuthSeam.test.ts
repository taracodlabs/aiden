/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 3a.3 — transport bearer seam + needs-auth status + handoff.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HttpTransport, type McpTransport } from '../../../core/v4/mcp/transport';
import { createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { createMcpAuthProvider, type McpAuthProvider } from '../../../core/v4/mcp/mcpAuth';
import { saveMcpOAuthConfig, mcpTokenId, type McpOAuthConfig } from '../../../core/v4/mcp/oauthDiscovery';
import { saveTokens } from '../../../core/v4/auth/tokenStore';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { mcp } from '../../../cli/v4/commands/mcpManage';

// ── Transport bearer seam ────────────────────────────────────────────────────

function fakeFetch(record: Array<{ url: string; headers: Record<string, string>; method?: string }>) {
  return (async (url: string, init: { headers: Record<string, string>; method?: string }) => {
    record.push({ url, headers: init.headers, method: init.method });
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }) };
  }) as unknown as typeof fetch;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('HttpTransport — per-request auth header seam', () => {
  it('merges a FRESH bearer into each request (over static headers)', async () => {
    const rec: Array<{ headers: Record<string, string> }> = [];
    let n = 0;
    const t = new HttpTransport({ baseUrl: 'http://x', fetchFn: fakeFetch(rec as never[]), disableSse: true,
      authHeader: async () => ({ Authorization: `Bearer T${++n}` }) });
    await t.request('m');
    await t.request('m');
    expect(rec[0].headers.Authorization).toBe('Bearer T1');
    expect(rec[1].headers.Authorization).toBe('Bearer T2'); // fresh per call
    expect(rec[0].headers['Content-Type']).toBe('application/json'); // static preserved
    await t.close();
  });

  it('merges the bearer into notify', async () => {
    const rec: Array<{ headers: Record<string, string> }> = [];
    const t = new HttpTransport({ baseUrl: 'http://x', fetchFn: fakeFetch(rec as never[]), disableSse: true,
      authHeader: async () => ({ Authorization: 'Bearer NT' }) });
    t.notify('m');
    await tick();
    expect(rec[0].headers.Authorization).toBe('Bearer NT');
    await t.close();
  });

  it('passes the bearer to the SSE source at open', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const esf = (url: string, headers: Record<string, string>) => { calls.push({ url, headers }); return { onmessage: null, onerror: null, close() {} }; };
    const t = new HttpTransport({ baseUrl: 'http://x', fetchFn: fakeFetch([]), disableSse: false,
      eventSourceFactory: esf, authHeader: async () => ({ Authorization: 'Bearer SSE' }) });
    await tick();
    expect(calls[0].url).toBe('http://x/sse');
    expect(calls[0].headers.Authorization).toBe('Bearer SSE');
    await t.close();
  });

  it('no hook → no Authorization, behaviour unchanged', async () => {
    const rec: Array<{ headers: Record<string, string> }> = [];
    const t = new HttpTransport({ baseUrl: 'http://x', fetchFn: fakeFetch(rec as never[]), disableSse: true });
    await t.request('m');
    expect(rec[0].headers.Authorization).toBeUndefined();
    expect(rec[0].headers['Content-Type']).toBe('application/json');
    await t.close();
  });
});

// ── mcpAuth.resolve ──────────────────────────────────────────────────────────

const CONFIG: McpOAuthConfig = {
  resource: 'http://srv/mcp',
  endpoints: { authorizationEndpoint: 'https://as/authorize', tokenEndpoint: 'https://as/token', registrationEndpoint: 'https://as/register' },
  clientId: 'c1',
  redirectUris: ['http://127.0.0.1:8765/callback'],
};

describe('createMcpAuthProvider.resolve (real tokenStore)', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-3a3-')); process.env.AIDEN_TOKEN_KEY = 'k3a3'; });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); delete process.env.AIDEN_TOKEN_KEY; });

  it("'none' when no OAuth config", async () => {
    const p = createMcpAuthProvider(resolveAidenPaths({ rootOverride: tmp }));
    expect(await p.resolve('srv')).toEqual({ state: 'none' });
  });

  it("'needs-auth' when config exists but no valid token", async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await saveMcpOAuthConfig(paths, 'srv', CONFIG); // metadata-only (empty token)
    expect(await createMcpAuthProvider(paths).resolve('srv')).toEqual({ state: 'needs-auth' });
  });

  it("'ready' + a bearer hook when a valid token is stored", async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await saveMcpOAuthConfig(paths, 'srv', CONFIG);
    await saveTokens(paths, {
      provider: mcpTokenId('srv'), accessToken: 'LIVE', refreshToken: 'r', expiresAtMs: Date.now() + 3_600_000,
      extras: { oauth: CONFIG, mcpBinding: { server: 'srv', serverUrl: CONFIG.resource!, resource: CONFIG.resource!, clientId: CONFIG.clientId, scopes: [] } },
    });
    const res = await createMcpAuthProvider(paths).resolve('srv');
    expect(res.state).toBe('ready');
    if (res.state === 'ready') expect(await res.authHeader()).toEqual({ Authorization: 'Bearer LIVE' });
  });
});

// ── McpClient connect: needs-auth vs ready + handoff ─────────────────────────

class StubTransport implements McpTransport {
  readonly label = 'stub';
  request(method: string): Promise<unknown> {
    if (method === 'initialize') return Promise.resolve({ protocolVersion: '2025-11-25', capabilities: {} });
    if (method === 'tools/list') return Promise.resolve({ tools: [{ name: 't' }] });
    return Promise.resolve({});
  }
  notify(): void {}
  onNotification(): void {}
  onExit(): void {}
  close(): Promise<void> { return Promise.resolve(); }
}

function authProviderOf(getState: () => 'none' | 'needs-auth' | 'ready'): McpAuthProvider {
  return {
    resolve: async () => {
      const s = getState();
      return s === 'ready' ? { state: 'ready', authHeader: async () => ({ Authorization: 'Bearer LIVE' }) } : { state: s };
    },
  };
}
const HTTP_CFG = { name: 'gm', type: 'http' as const, http: { baseUrl: 'http://x' } };

describe('McpClient — connect with auth state', () => {
  it('needs-auth: visible, no handshake (httpFactory not called), no tools', async () => {
    let factoryCalls = 0;
    const client = createMcpClient(new ToolRegistry(), {
      log: () => {},
      authProvider: authProviderOf(() => 'needs-auth'),
      streamableFactory: (() => { factoryCalls++; return new StubTransport(); }) as never,
    });
    const server = await client.connect(HTTP_CFG);
    expect(server.status).toBe('needs-auth');
    expect(server.tools).toEqual([]);
    expect(factoryCalls).toBe(0); // never handshaken
    expect(client.get('gm')?.status).toBe('needs-auth'); // visible in /mcp
  });

  it('ready: establishes with the bearer hook passed to the transport', async () => {
    let passedHook: (() => Promise<Record<string, string>>) | undefined;
    const registry = new ToolRegistry();
    const client = createMcpClient(registry, {
      log: () => {},
      authProvider: authProviderOf(() => 'ready'),
      streamableFactory: ((_cfg: unknown, _label: string, authHeader?: () => Promise<Record<string, string>>) => { passedHook = authHeader; return new StubTransport(); }) as never,
    });
    const server = await client.connect(HTTP_CFG);
    expect(server.status).toBe('ready');
    expect(server.tools.length).toBe(1);
    expect(registry.get('mcp_gm_t')).toBeDefined();
    expect(passedHook).toBeTypeOf('function');
    expect(await passedHook!()).toEqual({ Authorization: 'Bearer LIVE' }); // hook reached the transport
  });

  it('handoff: needs-auth → authorizeAndConnect → ready + tools register', async () => {
    let state: 'needs-auth' | 'ready' = 'needs-auth';
    const registry = new ToolRegistry();
    const client = createMcpClient(registry, {
      log: () => {},
      authProvider: authProviderOf(() => state),
      streamableFactory: (() => new StubTransport()) as never,
    });
    const locked = await client.connect(HTTP_CFG);
    expect(locked.status).toBe('needs-auth');
    expect(registry.get('mcp_gm_t')).toBeUndefined();

    state = 'ready'; // a token appeared (e.g. /mcp auth persisted one)
    const server = await client.authorizeAndConnect('gm');
    expect(server.status).toBe('ready');
    expect(server.tools.length).toBe(1);
    expect(registry.get('mcp_gm_t')).toBeDefined();
  });
});

// ── /mcp glyph + hint ────────────────────────────────────────────────────────

describe('/mcp — needs-auth glyph + hint', () => {
  it('renders 🔑 and the run /mcp auth hint', async () => {
    const out: string[] = [];
    const display = { info: (s: string) => out.push(s), dim: (s: string) => out.push(s), warn: (s: string) => out.push(s), write: (s: string) => out.push(s), printError: (s: string) => out.push(s) };
    const server = { config: { name: 'gmail', type: 'http' }, status: 'needs-auth', tools: [], breaker: { state: 'closed', failures: 0, openedAt: 0, cooldownMs: 0 }, reconnectAttempts: 0, capabilities: {}, transport: {} };
    const ctx = { args: [], display, mcpClient: { list: () => [server], get: () => server } };
    await mcp.handler(ctx as never);
    const text = out.join('\n');
    expect(text).toContain('🔑');
    expect(text).toContain('run /mcp auth gmail');
  });
});
