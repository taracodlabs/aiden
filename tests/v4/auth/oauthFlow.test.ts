import { describe, it, expect, vi } from 'vitest';

import {
  generatePkce,
  runCopyPasteFlow,
  runDeviceCodeFlow,
  refreshTokens,
  type FetchImpl,
  type OAuthFlowResult,
} from '../../../core/v4/auth/oauthFlow';
import type { OAuthUserAgent } from '../../../core/v4/auth/providerAuth';

// ── Test helpers ─────────────────────────────────────────────────────

function fakeUa(overrides: Partial<OAuthUserAgent> = {}): OAuthUserAgent & {
  log: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  openBrowser: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn(),
    openBrowser: vi.fn(async () => {}),
    prompt: vi.fn(async () => 'CODE#STATE'),
    sleep: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

function makeFetch(
  responses: Array<{ status: number; body: string }>,
  capture: { url: string; body: string }[] = [],
): FetchImpl {
  let i = 0;
  return (async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    capture.push({ url, body: init.body ?? '' });
    const r = responses[i++] ?? { status: 500, body: 'no response queued' };
    return {
      status: r.status,
      text: async () => r.body,
    };
  }) as FetchImpl;
}

// ── PKCE ─────────────────────────────────────────────────────────────

describe('generatePkce', () => {
  it('7. emits a fresh urlsafe verifier + S256 challenge each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
    // urlsafe-base64, no padding
    expect(a.verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    // SHA-256 base64url is 43 chars (32 bytes → 43 chars no padding)
    expect(a.challenge.length).toBe(43);
  });
});

// ── Copy-paste flow (Claude Pro shape) ───────────────────────────────

describe('runCopyPasteFlow', () => {
  const cfg = {
    authUrl: 'https://provider.test/oauth/authorize',
    tokenUrl: 'https://provider.test/oauth/token',
    clientId: 'TEST_CLIENT',
    redirectUri: 'https://provider.test/callback',
    scope: 'read write',
  };

  it('8. happy path: pasted code is split on # and exchanged for tokens', async () => {
    const ua = fakeUa({ prompt: vi.fn(async () => 'AUTHCODE#STATE_VAL') as any });
    const captures: { url: string; body: string }[] = [];
    const fetchImpl = makeFetch(
      [
        {
          status: 200,
          body: JSON.stringify({
            access_token: 'A',
            refresh_token: 'R',
            expires_in: 3600,
          }),
        },
      ],
      captures,
    );
    const r = await runCopyPasteFlow(cfg, ua, fetchImpl);
    expect(r.accessToken).toBe('A');
    expect(r.refreshToken).toBe('R');
    expect(r.expiresInSeconds).toBe(3600);
    expect(captures[0].url).toBe(cfg.tokenUrl);
    // Phase 18.1: login body is JSON ( anthropic_adapter.py:1092).
    const parsed = JSON.parse(captures[0].body);
    expect(parsed.grant_type).toBe('authorization_code');
    expect(parsed.code).toBe('AUTHCODE');
    expect(parsed.state).toBe('STATE_VAL');
    expect(parsed.client_id).toBe('TEST_CLIENT');
    expect(parsed.code_verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('9. empty paste throws cancelled error', async () => {
    const ua = fakeUa({ prompt: vi.fn(async () => '   ') as any });
    const fetchImpl = makeFetch([]);
    await expect(runCopyPasteFlow(cfg, ua, fetchImpl)).rejects.toThrow(
      /cancelled/i,
    );
  });

  it('10. token endpoint 4xx falls through to fallbackTokenUrls in order', async () => {
    const ua = fakeUa();
    const captures: { url: string; body: string }[] = [];
    const fetchImpl = makeFetch(
      [
        { status: 503, body: 'primary down' },
        {
          status: 200,
          body: JSON.stringify({ access_token: 'A', expires_in: 100 }),
        },
      ],
      captures,
    );
    const r = await runCopyPasteFlow(
      { ...cfg, fallbackTokenUrls: ['https://fallback.test/token'] },
      ua,
      fetchImpl,
    );
    expect(r.accessToken).toBe('A');
    expect(captures.map((c) => c.url)).toEqual([
      'https://provider.test/oauth/token',
      'https://fallback.test/token',
    ]);
  });

  it('11. response missing access_token surfaces a descriptive error', async () => {
    const ua = fakeUa();
    const fetchImpl = makeFetch([
      { status: 200, body: JSON.stringify({ error: 'invalid_grant' }) },
    ]);
    await expect(runCopyPasteFlow(cfg, ua, fetchImpl)).rejects.toThrow(
      /missing access_token/i,
    );
  });
});

// ── Device-code flow (ChatGPT Plus shape) ────────────────────────────

describe('runDeviceCodeFlow', () => {
  const cfg = {
    issuer: 'https://issuer.test',
    clientId: 'CHATGPT_TEST',
    minPollSeconds: 0,
  };

  it('12. happy path: usercode → poll-403 → poll-200 → exchange', async () => {
    const ua = fakeUa();
    const captures: { url: string; body: string }[] = [];
    const fetchImpl = makeFetch(
      [
        {
          status: 200,
          body: JSON.stringify({
            user_code: 'CODE',
            device_auth_id: 'DAID',
            interval: 0,
          }),
        },
        { status: 403, body: '{}' },
        {
          status: 200,
          body: JSON.stringify({
            authorization_code: 'AC',
            code_verifier: 'V',
          }),
        },
        {
          status: 200,
          body: JSON.stringify({
            access_token: 'A',
            refresh_token: 'R',
            expires_in: 7200,
          }),
        },
      ],
      captures,
    );
    const r = await runDeviceCodeFlow(cfg, ua, fetchImpl);
    expect(r.accessToken).toBe('A');
    expect(r.expiresInSeconds).toBe(7200);
    expect(ua.log).toHaveBeenCalled();
    expect(ua.openBrowser).toHaveBeenCalledOnce();
    expect(ua.openBrowser).toHaveBeenCalledWith('https://issuer.test/codex/device');
    // Poll loop slept once between the 403 and 200.
    expect(ua.sleep).toHaveBeenCalledTimes(2);
    // Final exchange was form-encoded.
    expect(captures.at(-1)?.body).toContain('grant_type=authorization_code');
    expect(captures.at(-1)?.body).toContain('code=AC');
    expect(captures.at(-1)?.body).toContain('code_verifier=V');
  });

  it('13. usercode endpoint 4xx surfaces a descriptive error', async () => {
    const ua = fakeUa();
    const fetchImpl = makeFetch([
      { status: 401, body: 'unauthorized' },
    ]);
    await expect(runDeviceCodeFlow(cfg, ua, fetchImpl)).rejects.toThrow(
      /Device-code request failed: HTTP 401/,
    );
  });

  it('14. timeout surfaces "login timed out"', async () => {
    // Fake clock-style: ua.sleep is mocked to actually advance the loop.
    // The deadline is `now + maxWaitSeconds*1000`; setting maxWaitSeconds=0
    // makes the deadline already past on entry to the poll loop.
    const ua = fakeUa();
    const fetchImpl = makeFetch([
      {
        status: 200,
        body: JSON.stringify({
          user_code: 'CODE',
          device_auth_id: 'DAID',
          interval: 0,
        }),
      },
      // No subsequent responses needed — maxWaitSeconds=0 means we never poll.
    ]);
    await expect(
      runDeviceCodeFlow({ ...cfg, maxWaitSeconds: 0 }, ua, fetchImpl),
    ).rejects.toThrow(/timed out/);
  });
});

// ── Refresh ──────────────────────────────────────────────────────────

describe('refreshTokens', () => {
  it('15. POSTs grant_type=refresh_token form-encoded by default', async () => {
    const captures: { url: string; body: string }[] = [];
    const fetchImpl = makeFetch(
      [
        {
          status: 200,
          body: JSON.stringify({ access_token: 'A2', expires_in: 3600 }),
        },
      ],
      captures,
    );
    const r = await refreshTokens(
      'OLD-RT',
      {
        tokenUrl: 'https://provider.test/oauth/token',
        clientId: 'CID',
      },
      fetchImpl,
    );
    expect(r.accessToken).toBe('A2');
    expect(captures[0].body).toContain('grant_type=refresh_token');
    expect(captures[0].body).toContain('refresh_token=OLD-RT');
    expect(captures[0].body).toContain('client_id=CID');
  });

  it('16. empty refresh token throws', async () => {
    await expect(
      refreshTokens(
        '',
        { tokenUrl: 'https://provider.test/oauth/token', clientId: 'CID' },
        makeFetch([]),
      ),
    ).rejects.toThrow(/refresh token is required/);
  });

  it('17. all endpoints failing surfaces lastErr in thrown message', async () => {
    const fetchImpl = makeFetch([
      { status: 500, body: 'oops' },
      { status: 503, body: 'still oops' },
    ]);
    await expect(
      refreshTokens(
        'RT',
        {
          tokenUrl: 'https://primary.test/token',
          fallbackTokenUrls: ['https://fallback.test/token'],
          clientId: 'CID',
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/HTTP 503/);
  });
});
