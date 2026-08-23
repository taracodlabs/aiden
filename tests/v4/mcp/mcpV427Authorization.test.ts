/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FetchImpl, OAuthUserAgent } from '../../../core/v4/auth/oauthFlow';
import { loadTokens, saveTokens } from '../../../core/v4/auth/tokenStore';
import { createMcpAuthProvider } from '../../../core/v4/mcp/mcpAuth';
import { pollDeviceTokenOnce, requestDeviceAuthorization } from '../../../core/v4/mcp/deviceFlow';
import {
  ensureMcpOAuthConfig,
  mcpTokenId,
  saveMcpOAuthConfig,
  type McpOAuthConfig,
} from '../../../core/v4/mcp/oauthDiscovery';
import { persistMcpTokens, runLoopbackAuthFlow } from '../../../core/v4/mcp/oauthLoginFlow';
import { resolveAidenPaths } from '../../../core/v4/paths';

const RESOURCE = 'https://mcp.example.test/service';
const CONFIG: McpOAuthConfig = {
  resource: RESOURCE,
  serverUrl: RESOURCE,
  scopes: ['repo.read'],
  endpoints: {
    authorizationEndpoint: 'https://auth.example.test/authorize',
    tokenEndpoint: 'https://auth.example.test/token',
    registrationEndpoint: 'https://auth.example.test/register',
    scopesSupported: ['repo.read', 'repo.write', 'admin'],
  },
  clientId: 'client-1',
  redirectUris: ['http://127.0.0.1:8765/callback'],
};

const UA: OAuthUserAgent = {
  log: () => undefined,
  openBrowser: async () => undefined,
  prompt: async () => '',
  sleep: async () => undefined,
};

describe('MCP OAuth server/resource/scope binding', () => {
  let root: string;
  let paths: ReturnType<typeof resolveAidenPaths>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-v427-auth-'));
    process.env.AIDEN_TOKEN_KEY = 'mcp-v427-authorization-test';
    paths = resolveAidenPaths({ rootOverride: root });
    await saveMcpOAuthConfig(paths, 'repo', CONFIG);
  });

  afterEach(async () => {
    delete process.env.AIDEN_TOKEN_KEY;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('requests only configured scopes and binds the authorization-code exchange to the resource', async () => {
    let authorizeUrl = '';
    let exchangeBody = '';
    const fetchImpl: FetchImpl = async (_url, init) => {
      exchangeBody = init.body ?? '';
      return {
        status: 200,
        text: async () => JSON.stringify({ access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600, scope: 'repo.read' }),
      };
    };

    const result = await runLoopbackAuthFlow({
      config: CONFIG,
      server: 'repo',
      ua: { ...UA, openBrowser: async (url) => { authorizeUrl = url; } },
      fetchImpl,
      makeState: () => 'STATE',
      startServer: async () => ({
        redirectUri: 'http://127.0.0.1:8765/callback',
        waitForCallback: async () => ({ code: 'CODE', state: 'STATE' }),
        close: async () => undefined,
      }),
    });

    expect(new URL(authorizeUrl).searchParams.get('scope')).toBe('repo.read');
    expect(new URL(authorizeUrl).searchParams.get('scope')).not.toContain('repo.write');
    expect(new URL(authorizeUrl).searchParams.get('scope')).not.toContain('admin');
    expect(new URLSearchParams(exchangeBody).get('resource')).toBe(RESOURCE);

    await persistMcpTokens(paths, 'repo', result, CONFIG);
    const stored = await loadTokens(paths, mcpTokenId('repo'));
    expect(stored?.extras?.mcpBinding).toEqual({
      server: 'repo',
      serverUrl: RESOURCE,
      resource: RESOURCE,
      clientId: 'client-1',
      scopes: ['repo.read'],
    });
  });

  it('refuses a credential when the configured server endpoint no longer matches its issuance binding', async () => {
    await persistMcpTokens(paths, 'repo', {
      accessToken: 'ACCESS', refreshToken: 'REFRESH', expiresInSeconds: 3600, extras: { scope: 'repo.read' },
    }, CONFIG);

    const provider = createMcpAuthProvider(paths);
    expect((await provider.resolve('repo', { serverUrl: RESOURCE })).state).toBe('ready');
    expect((await provider.resolve('repo', { serverUrl: 'https://other.example.test/service' })).state).toBe('needs-auth');
  });

  it('refuses an unbound legacy token instead of sending it to a configured server', async () => {
    await saveTokens(paths, {
      provider: mcpTokenId('repo'),
      accessToken: 'LEGACY',
      refreshToken: 'REFRESH',
      expiresAtMs: Date.now() + 60_000,
      extras: { oauth: CONFIG },
    });
    expect((await createMcpAuthProvider(paths).resolve('repo', { serverUrl: RESOURCE })).state).toBe('needs-auth');
  });

  it('sends the exact resource and scope on refresh and preserves the original binding', async () => {
    await persistMcpTokens(paths, 'repo', {
      accessToken: 'OLD', refreshToken: 'REFRESH', expiresInSeconds: -1, extras: { scope: 'repo.read' },
    }, CONFIG);
    let refreshBody = '';
    const fetchImpl: FetchImpl = async (_url, init) => {
      refreshBody = init.body ?? '';
      return { status: 200, text: async () => JSON.stringify({ access_token: 'NEW', expires_in: 3600, scope: 'repo.read' }) };
    };

    const resolved = await createMcpAuthProvider(paths, { fetchImpl }).resolve('repo', { serverUrl: RESOURCE });
    expect(resolved.state).toBe('ready');
    const fields = new URLSearchParams(refreshBody);
    expect(fields.get('resource')).toBe(RESOURCE);
    expect(fields.get('scope')).toBe('repo.read');
    expect((await loadTokens(paths, mcpTokenId('repo')))?.extras?.mcpBinding).toMatchObject({ resource: RESOURCE });
  });

  it('does not reuse persisted discovery metadata for a different server URL', async () => {
    await expect(ensureMcpOAuthConfig(paths, 'repo', 'https://other.example.test/service', {
      fetchFn: async () => { throw new Error('must not rediscover over a stale credential'); },
      redirectUris: CONFIG.redirectUris,
      requestedScopes: ['repo.read'],
    })).rejects.toThrow(/server endpoint changed/i);
  });

  it('binds both device authorization and device token polling to the exact resource', async () => {
    const bodies: string[] = [];
    const fetchImpl: FetchImpl = async (_url, init) => {
      bodies.push(init.body ?? '');
      return bodies.length === 1
        ? { status: 200, text: async () => JSON.stringify({ device_code: 'D', user_code: 'U', verification_uri: 'https://auth.example.test/device' }) }
        : { status: 200, text: async () => JSON.stringify({ error: 'authorization_pending' }) };
    };
    const deviceConfig = {
      deviceAuthorizationEndpoint: 'https://auth.example.test/device',
      tokenEndpoint: 'https://auth.example.test/token',
      clientId: 'client-1',
      scope: 'repo.read',
      resource: RESOURCE,
    };
    await requestDeviceAuthorization(deviceConfig, fetchImpl);
    await pollDeviceTokenOnce(deviceConfig, 'D', fetchImpl);
    expect(new URLSearchParams(bodies[0]).get('resource')).toBe(RESOURCE);
    expect(new URLSearchParams(bodies[1]).get('resource')).toBe(RESOURCE);
  });
});
