/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — RFC 8628 device-flow coverage. Generic (provider-agnostic): the
 * request/parse, the §3.5 poll state machine (pending / slow_down / denied /
 * expired / success), the GitHub 200-with-error quirk, and the end-to-end
 * orchestration — all against a scripted fetch, no network.
 */
import { describe, it, expect } from 'vitest';

import {
  requestDeviceAuthorization,
  pollDeviceTokenOnce,
  runMcpDeviceFlow,
  type DeviceFlowConfig,
} from '../../../core/v4/mcp/deviceFlow';
import type { FetchImpl, OAuthUserAgent } from '../../../core/v4/auth/oauthFlow';

const DEVICE_EP = 'https://prov.example/device/code';
const TOKEN_EP = 'https://prov.example/token';
const CFG: DeviceFlowConfig = { deviceAuthorizationEndpoint: DEVICE_EP, tokenEndpoint: TOKEN_EP, clientId: 'cid', scope: 'repo' };

type Resp = { status: number; body: unknown };
const reply = (r: Resp) => ({ status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) });

/** Fetch stub: device endpoint returns `device`; token endpoint walks `tokens`. */
function mkFetch(device: Resp, tokens: Resp[] = []): FetchImpl & { deviceCalls: number; tokenCalls: number } {
  let ti = 0;
  const fn = (async (url: string) => {
    if (url === DEVICE_EP) { fn.deviceCalls++; return reply(device); }
    fn.tokenCalls++;
    return reply(tokens[Math.min(ti++, tokens.length - 1)]);
  }) as FetchImpl & { deviceCalls: number; tokenCalls: number };
  fn.deviceCalls = 0; fn.tokenCalls = 0;
  return fn;
}

function mkUa(): { logs: string[]; opened: string[]; sleeps: number; ua: OAuthUserAgent } {
  const logs: string[] = []; const opened: string[] = []; let sleeps = 0;
  const ua: OAuthUserAgent = {
    log: (l) => logs.push(l),
    openBrowser: async (u) => { opened.push(u); },
    prompt: async () => { throw new Error('device flow needs no prompt'); },
    sleep: async () => { sleeps++; },
  };
  return { logs, opened, get sleeps() { return sleeps; }, ua };
}

const DEVICE_OK: Resp = { status: 200, body: {
  device_code: 'DC', user_code: 'WXYZ-1234', verification_uri: 'https://prov.example/activate',
  verification_uri_complete: 'https://prov.example/activate?code=WXYZ-1234', expires_in: 900, interval: 5,
} };
const TOKEN_OK: Resp = { status: 200, body: { access_token: 'at-123', refresh_token: 'rt-456', token_type: 'bearer', scope: 'repo', expires_in: 3600 } };

// ── request device authorization ─────────────────────────────────────────────
describe('requestDeviceAuthorization', () => {
  it('parses device_code / user_code / verification_uri (+ complete, interval, expires)', async () => {
    const auth = await requestDeviceAuthorization(CFG, mkFetch(DEVICE_OK));
    expect(auth.deviceCode).toBe('DC');
    expect(auth.userCode).toBe('WXYZ-1234');
    expect(auth.verificationUri).toBe('https://prov.example/activate');
    expect(auth.verificationUriComplete).toContain('code=WXYZ-1234');
    expect(auth.intervalSeconds).toBe(5);
    expect(auth.expiresInSeconds).toBe(900);
  });

  it('throws on a non-200 device-authorization response', async () => {
    await expect(requestDeviceAuthorization(CFG, mkFetch({ status: 400, body: { error: 'invalid_client' } })))
      .rejects.toThrow(/Device authorization request failed: HTTP 400/);
  });

  it('throws when required fields are missing', async () => {
    await expect(requestDeviceAuthorization(CFG, mkFetch({ status: 200, body: { user_code: 'X' } })))
      .rejects.toThrow(/missing device_code/);
  });
});

// ── the §3.5 poll state machine ──────────────────────────────────────────────
describe('pollDeviceTokenOnce — RFC 8628 §3.5 states', () => {
  const poll = (t: Resp) => pollDeviceTokenOnce(CFG, 'DC', mkFetch(DEVICE_OK, [t]));

  it('success → returns the parsed token', async () => {
    const o = await poll(TOKEN_OK);
    expect(o.kind).toBe('success');
    if (o.kind === 'success') { expect(o.result.accessToken).toBe('at-123'); expect(o.result.refreshToken).toBe('rt-456'); }
  });
  it('authorization_pending → pending (400 body)', async () => {
    expect((await poll({ status: 400, body: { error: 'authorization_pending' } })).kind).toBe('pending');
  });
  it('GitHub quirk: HTTP 200 with error=authorization_pending → pending', async () => {
    expect((await poll({ status: 200, body: { error: 'authorization_pending' } })).kind).toBe('pending');
  });
  it('slow_down → slow_down', async () => {
    expect((await poll({ status: 400, body: { error: 'slow_down' } })).kind).toBe('slow_down');
  });
  it('access_denied → denied', async () => {
    expect((await poll({ status: 400, body: { error: 'access_denied' } })).kind).toBe('denied');
  });
  it('expired_token → expired', async () => {
    expect((await poll({ status: 400, body: { error: 'expired_token' } })).kind).toBe('expired');
  });
  it('unknown error → error with message', async () => {
    const o = await poll({ status: 400, body: { error: 'nope', error_description: 'bad' } });
    expect(o.kind).toBe('error');
    if (o.kind === 'error') expect(o.message).toMatch(/nope.*bad/);
  });
});

// ── end-to-end orchestration ─────────────────────────────────────────────────
describe('runMcpDeviceFlow', () => {
  it('happy path: shows code, polls through pending, stores the token', async () => {
    const fetchImpl = mkFetch(DEVICE_OK, [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
      TOKEN_OK,
    ]);
    const u = mkUa();
    const result = await runMcpDeviceFlow({ config: CFG, server: 'github', ua: u.ua, fetchImpl, now: () => 0 });
    expect(result.accessToken).toBe('at-123');
    expect(u.logs.join('\n')).toMatch(/Enter the code:\s+WXYZ-1234/);
    expect(u.opened[0]).toContain('code=WXYZ-1234'); // opened the pre-filled URL
    expect(fetchImpl.tokenCalls).toBe(3);            // pending, pending, success
  });

  it('slow_down keeps polling then succeeds (backs off, does not error)', async () => {
    const fetchImpl = mkFetch(DEVICE_OK, [{ status: 400, body: { error: 'slow_down' } }, TOKEN_OK]);
    const result = await runMcpDeviceFlow({ config: CFG, server: 's', ua: mkUa().ua, fetchImpl, now: () => 0 });
    expect(result.accessToken).toBe('at-123');
  });

  it('access_denied → clean throw', async () => {
    const fetchImpl = mkFetch(DEVICE_OK, [{ status: 400, body: { error: 'access_denied' } }]);
    await expect(runMcpDeviceFlow({ config: CFG, server: 's', ua: mkUa().ua, fetchImpl, now: () => 0 }))
      .rejects.toThrow(/denied/i);
  });

  it('expired_token → clean throw with retry hint', async () => {
    const fetchImpl = mkFetch(DEVICE_OK, [{ status: 400, body: { error: 'expired_token' } }]);
    await expect(runMcpDeviceFlow({ config: CFG, server: 's', ua: mkUa().ua, fetchImpl, now: () => 0 }))
      .rejects.toThrow(/expired.*again/i);
  });

  it('shows the URL, code, expiry and cancel instruction (headless-safe UX)', async () => {
    const u = mkUa();
    await runMcpDeviceFlow({ config: CFG, server: 'gh', ua: u.ua, fetchImpl: mkFetch(DEVICE_OK, [TOKEN_OK]), now: () => 0 });
    const out = u.logs.join('\n');
    expect(out).toContain('https://prov.example/activate'); // URL ALWAYS printed (SSH/WSL safe)
    expect(out).toContain('WXYZ-1234');                     // code
    expect(out).toMatch(/expires in ~\d+ min/);             // expiry
    expect(out).toMatch(/Ctrl\+C to cancel/);               // cancel instruction
  });

  it('an aborted signal cancels the poller cleanly (no hang, clear error)', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = mkFetch(DEVICE_OK, [{ status: 400, body: { error: 'authorization_pending' } }]);
    await expect(runMcpDeviceFlow({ config: CFG, server: 'gh', ua: mkUa().ua, fetchImpl, now: () => 0, signal: controller.signal }))
      .rejects.toThrow(/Cancelled/);
  });

  it('deadline exceeded → times out (never polls forever)', async () => {
    // Clock advances: 1st read sets the deadline (t=0 → deadline=900s), the next
    // read is already past it → the while-loop is skipped → clean timeout.
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 10_000_000);
    const fetchImpl = mkFetch(DEVICE_OK, [{ status: 400, body: { error: 'authorization_pending' } }]);
    await expect(runMcpDeviceFlow({ config: CFG, server: 's', ua: mkUa().ua, fetchImpl, now }))
      .rejects.toThrow(/code expired/);
  });
});
