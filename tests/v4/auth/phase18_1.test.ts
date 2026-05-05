/**
 * Phase 18.1 regression tests — four OAuth fixes per diagnostic 292c7cd.
 *
 *   1. runCopyPasteFlow login body is JSON (Hermes verbatim).
 *   2. runCopyPasteFlow login Content-Type is application/json.
 *   3. refreshTokens stays form-encoded.
 *   4. Claude Pro plugin login token URL ordering: console first.
 *   5. runDeviceCodeFlow includes Accept: application/json on every POST.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  runCopyPasteFlow,
  runDeviceCodeFlow,
  refreshTokens,
  type FetchImpl,
} from '../../../core/v4/auth/oauthFlow';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const claudePro = require('../../../plugins/aiden-plugin-claude-pro/index.js');

// ── Test helpers ────────────────────────────────────────────────────

interface Capture {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function makeFetch(
  responses: Array<{ status: number; body: string }>,
  capture: Capture[] = [],
): FetchImpl {
  let i = 0;
  return (async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    capture.push({ url, body: init.body ?? '', headers: init.headers });
    const r = responses[i++] ?? { status: 500, body: 'no response queued' };
    return {
      status: r.status,
      text: async () => r.body,
    };
  }) as FetchImpl;
}

const fakeUa = () => ({
  log: vi.fn(),
  openBrowser: vi.fn(async () => {}),
  prompt: vi.fn(async () => 'AUTHCODE#STATE_VAL'),
  sleep: vi.fn(async () => {}),
});

// ── 1+2. JSON body + Content-Type on login ──────────────────────────

describe('Phase 18.1: runCopyPasteFlow login posts JSON body', () => {
  const cfg = {
    authUrl: 'https://provider.test/oauth/authorize',
    tokenUrl: 'https://provider.test/oauth/token',
    clientId: 'TEST_CLIENT',
    redirectUri: 'https://provider.test/callback',
    scope: 'read',
  };

  it('69. login posts a JSON body (parseable, with all six required fields)', async () => {
    const captures: Capture[] = [];
    const fetchImpl = makeFetch(
      [{ status: 200, body: JSON.stringify({ access_token: 'A', expires_in: 3600 }) }],
      captures,
    );
    await runCopyPasteFlow(cfg, fakeUa() as any, fetchImpl);
    const parsed = JSON.parse(captures[0].body);
    expect(parsed.grant_type).toBe('authorization_code');
    expect(parsed.client_id).toBe('TEST_CLIENT');
    expect(parsed.code).toBe('AUTHCODE');
    expect(parsed.state).toBe('STATE_VAL');
    expect(parsed.redirect_uri).toBe('https://provider.test/callback');
    expect(parsed.code_verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('70. login Content-Type header is application/json (not form-urlencoded)', async () => {
    const captures: Capture[] = [];
    const fetchImpl = makeFetch(
      [{ status: 200, body: JSON.stringify({ access_token: 'A', expires_in: 3600 }) }],
      captures,
    );
    await runCopyPasteFlow(cfg, fakeUa() as any, fetchImpl);
    expect(captures[0].headers['Content-Type']).toBe('application/json');
    expect(captures[0].headers['Content-Type']).not.toBe(
      'application/x-www-form-urlencoded',
    );
  });
});

// ── 3. Refresh stays form-encoded ──────────────────────────────────

describe('Phase 18.1: refreshTokens stays form-encoded', () => {
  it('71. refresh body is form-encoded (matches Hermes refresh path)', async () => {
    const captures: Capture[] = [];
    const fetchImpl = makeFetch(
      [{ status: 200, body: JSON.stringify({ access_token: 'A2', expires_in: 3600 }) }],
      captures,
    );
    await refreshTokens(
      'OLD-RT',
      { tokenUrl: 'https://provider.test/oauth/token', clientId: 'CID' },
      fetchImpl,
    );
    expect(captures[0].headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    // Form body, not JSON: parses as URL-encoded.
    expect(captures[0].body).toContain('grant_type=refresh_token');
    expect(captures[0].body).toContain('refresh_token=OLD-RT');
  });
});

// ── 4. Claude Pro login URL ordering ───────────────────────────────

describe('Phase 18.1: Claude Pro login token URL — console first', () => {
  it('72. plugin constants split into login vs refresh URL pairs', () => {
    expect(claudePro.CLAUDE_PRO.loginTokenUrl).toBe(
      'https://console.anthropic.com/v1/oauth/token',
    );
    expect(claudePro.CLAUDE_PRO.loginFallbackTokenUrls).toContain(
      'https://platform.claude.com/v1/oauth/token',
    );
    expect(claudePro.CLAUDE_PRO.refreshTokenUrl).toBe(
      'https://platform.claude.com/v1/oauth/token',
    );
    expect(claudePro.CLAUDE_PRO.refreshFallbackTokenUrls).toContain(
      'https://console.anthropic.com/v1/oauth/token',
    );
  });

  it('73. provider.login passes the login pair to runCopyPasteFlow', async () => {
    const auth = {
      runCopyPasteFlow: vi.fn(async () => ({
        accessToken: 'A',
        refreshToken: 'R',
        expiresInSeconds: 3600,
        extras: {},
      })),
      runDeviceCodeFlow: vi.fn(),
      refreshTokens: vi.fn(),
      generatePkce: vi.fn(),
    };
    const provider = claudePro.buildProvider(auth);
    await provider.login(fakeUa() as any);
    const cfg = auth.runCopyPasteFlow.mock.calls[0][0];
    expect(cfg.tokenUrl).toBe(
      'https://console.anthropic.com/v1/oauth/token',
    );
    expect(cfg.fallbackTokenUrls).toContain(
      'https://platform.claude.com/v1/oauth/token',
    );
  });
});

// ── 5. runDeviceCodeFlow Accept header ─────────────────────────────

describe('Phase 18.1: runDeviceCodeFlow sets Accept: application/json', () => {
  it('74. all three POSTs (usercode, poll, exchange) carry Accept: application/json', async () => {
    const captures: Capture[] = [];
    const fetchImpl = makeFetch(
      [
        { status: 200, body: JSON.stringify({ user_code: 'UC', device_auth_id: 'DA', interval: 0 }) },
        { status: 200, body: JSON.stringify({ authorization_code: 'AC', code_verifier: 'V' }) },
        { status: 200, body: JSON.stringify({ access_token: 'A', expires_in: 3600 }) },
      ],
      captures,
    );
    await runDeviceCodeFlow(
      { issuer: 'https://issuer.test', clientId: 'C', minPollSeconds: 0 },
      fakeUa() as any,
      fetchImpl,
    );
    expect(captures).toHaveLength(3);
    for (const c of captures) {
      expect(c.headers.Accept).toBe('application/json');
    }
  });

  it('75. Accept header is preserved alongside user-supplied extraHeaders', async () => {
    const captures: Capture[] = [];
    const fetchImpl = makeFetch(
      [
        { status: 200, body: JSON.stringify({ user_code: 'UC', device_auth_id: 'DA', interval: 0 }) },
        { status: 200, body: JSON.stringify({ authorization_code: 'AC', code_verifier: 'V' }) },
        { status: 200, body: JSON.stringify({ access_token: 'A', expires_in: 3600 }) },
      ],
      captures,
    );
    await runDeviceCodeFlow(
      {
        issuer: 'https://issuer.test',
        clientId: 'C',
        minPollSeconds: 0,
        extraHeaders: { 'User-Agent': 'aiden-cli/4.0.0 (external, cli)' },
      },
      fakeUa() as any,
      fetchImpl,
    );
    for (const c of captures) {
      expect(c.headers.Accept).toBe('application/json');
      expect(c.headers['User-Agent']).toMatch(/aiden-cli/);
    }
  });
});
