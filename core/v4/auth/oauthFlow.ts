/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * Portions adapted from NousResearch/hermes-agent (MIT).
 * Original copyright (c) NousResearch.
 */
/**
 * core/v4/auth/oauthFlow.ts — Aiden v4.0.0 (Phase 18)
 *
 * Provider-agnostic OAuth flow primitives. Two shapes are supported, both
 * direct ports of Hermes (audit § Claude Pro / ChatGPT Plus):
 *
 *   1. Out-of-band PKCE auth-code flow
 *      ---------------------------------
 *      The provider hosts the redirect URI; we open the browser, the user
 *      authorises, the provider's callback shows a `<code>#<state>` string
 *      that the user pastes back into the terminal. Used by Claude Pro.
 *      Hermes ref: agent/anthropic_adapter.py:1011-1142.
 *
 *   2. Device-code flow
 *      ----------------
 *      We POST for a usercode + device_auth_id, show the user a URL +
 *      short code, and poll until the provider returns 200 with an
 *      `authorization_code` + `code_verifier`. We then exchange those
 *      for tokens. Used by ChatGPT Plus / Codex.
 *      Hermes ref: hermes_cli/auth.py:3994-4136.
 *
 * Both flows return the same `OAuthFlowResult` shape so the slash command
 * and setup wizard treat them uniformly. No callback server (audit §
 * "callback server (Aiden DEFERS — not applicable)").
 *
 * Network is done via the global `fetch` API (Node 18+); tests inject a
 * fake fetch via the `fetchImpl` option. No live network in unit tests.
 */

import {
  createHash,
  randomBytes,
} from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────

export interface PkceMaterial {
  /** Random secret retained client-side; sent in the token-exchange body. */
  verifier: string;
  /** SHA-256(verifier), base64url, no padding — sent in the auth URL. */
  challenge: string;
}

/** Result of a successful flow. Caller persists via tokenStore. */
export interface OAuthFlowResult {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  /** Free-form provider-specific extras (account email, base URL override, ...). */
  extras?: Record<string, unknown>;
}

export type FetchImpl = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

/**
 * UI surface the flow uses to talk to the user. Tests inject a stub;
 * the chat REPL passes a readline-backed prompt.
 */
export interface OAuthUserAgent {
  /** Print a line of guidance (URL, code, prompts). */
  log(line: string): void;
  /** Open the URL in the user's browser. May no-op in headless envs. */
  openBrowser(url: string): Promise<void>;
  /** Prompt the user to paste the auth code. Returns the trimmed string. */
  prompt(question: string): Promise<string>;
  /** Sleep for ms — abstracted so tests can advance time without setTimeout. */
  sleep(ms: number): Promise<void>;
}

// ─── PKCE ─────────────────────────────────────────────────────────────

/**
 * Generate a fresh PKCE verifier + S256 challenge. Verifier is 32 random
 * bytes urlsafe-base64-encoded; challenge is SHA-256(verifier) urlsafe-
 * base64-encoded. Padding stripped from both (RFC 7636).
 *
 * Direct port of Hermes `_generate_pkce` (anthropic_adapter.py:1022).
 */
export function generatePkce(): PkceMaterial {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ─── Out-of-band copy-paste flow (Claude Pro shape) ───────────────────

export interface CopyPasteFlowConfig {
  /** Provider's authorise endpoint, e.g. https://claude.ai/oauth/authorize. */
  authUrl: string;
  /** Provider's token endpoint, e.g. https://console.anthropic.com/v1/oauth/token. */
  tokenUrl: string;
  /** Optional fallback token URLs tried in order on the first one's failure. */
  fallbackTokenUrls?: string[];
  /** OAuth client id registered with the provider. */
  clientId: string;
  /** Whitelisted by the provider — must match what was registered. */
  redirectUri: string;
  /** Space-separated scope list. */
  scope: string;
  /** Headers added to the token-exchange request (User-Agent etc.). */
  extraHeaders?: Record<string, string>;
  /** Build the full authorise URL. Defaults to standard query encoding;
   *  Claude wants `code=true` extra param so callers can override. */
  buildAuthUrl?: (base: string, params: Record<string, string>) => string;
  /** Timeout (ms) for the token exchange POST. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

function urlencode(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.append(k, v);
  return sp.toString();
}

function defaultBuildAuthUrl(base: string, params: Record<string, string>): string {
  return `${base}?${urlencode(params)}`;
}

async function postForTokens(
  url: string,
  body: string,
  contentType: string,
  extraHeaders: Record<string, string>,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...extraHeaders,
      },
      body,
    });
    return { status: resp.status, text: await resp.text() };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Run the out-of-band PKCE flow. Returns the parsed token bundle.
 * Throws with a descriptive message on the user cancelling, the token
 * exchange failing, or the response missing an access_token.
 */
export async function runCopyPasteFlow(
  cfg: CopyPasteFlowConfig,
  ua: OAuthUserAgent,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<OAuthFlowResult> {
  const { verifier, challenge } = generatePkce();

  const params: Record<string, string> = {
    code: 'true',
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  };
  const buildUrl = cfg.buildAuthUrl ?? defaultBuildAuthUrl;
  const authUrl = buildUrl(cfg.authUrl, params);

  ua.log('');
  ua.log('Authorise Aiden with your Claude Pro/Max subscription.');
  ua.log('');
  ua.log('Open this URL in your browser:');
  ua.log(`  ${authUrl}`);
  ua.log('');

  await ua.openBrowser(authUrl).catch(() => undefined);

  ua.log('After authorising, you will see a code on the page.');
  const pasted = (
    await ua.prompt('Paste the code (and any "#state" suffix) here: ')
  ).trim();
  if (!pasted) {
    throw new Error('No authorisation code entered — cancelled');
  }
  const [code, pastedState] = pasted.split('#', 2);
  const state = pastedState ?? '';

  // Phase 18.1: per Hermes verbatim (anthropic_adapter.py:1092-1109), the
  // LOGIN token exchange is JSON-only — the Phase 18 audit incorrectly
  // recorded "form-encoded works; JSON also accepted." Refresh stays
  // form-encoded (refreshTokens helper below; matches Hermes refresh path
  // anthropic_adapter.py:760-821).
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    state,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });

  const urls = [cfg.tokenUrl, ...(cfg.fallbackTokenUrls ?? [])];
  let lastErr = '';
  for (const url of urls) {
    const { status, text } = await postForTokens(
      url,
      body,
      'application/json',
      cfg.extraHeaders ?? {},
      fetchImpl,
      cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (status === 200) {
      return parseTokenResponse(text);
    }
    lastErr = `${url} → HTTP ${status}: ${text.slice(0, 200)}`;
  }
  throw new Error(`Token exchange failed: ${lastErr}`);
}

// ─── Device-code flow (ChatGPT Plus / Codex shape) ────────────────────

export interface DeviceCodeFlowConfig {
  issuer: string; // https://auth.openai.com
  clientId: string;
  /** Endpoint to request the user code. Defaults to `${issuer}/api/accounts/deviceauth/usercode`. */
  userCodeEndpoint?: string;
  /** Endpoint to poll for completion. Defaults to `${issuer}/api/accounts/deviceauth/token`. */
  pollEndpoint?: string;
  /** Token-exchange endpoint. Defaults to `${issuer}/oauth/token`. */
  tokenEndpoint?: string;
  /** Redirect URI fed into the final token exchange. Defaults to `${issuer}/deviceauth/callback`. */
  redirectUri?: string;
  /** URL the user opens to enter the code. Defaults to `${issuer}/codex/device`. */
  userVerificationUrl?: string;
  /** Maximum seconds to poll. Default 900 (15 min) per Hermes audit. */
  maxWaitSeconds?: number;
  /** Floor on the poll interval. Default 3s. */
  minPollSeconds?: number;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

interface DeviceCodeResponse {
  user_code?: string;
  device_auth_id?: string;
  interval?: number | string;
}

interface DeviceCodePollResponse {
  authorization_code?: string;
  code_verifier?: string;
}

export async function runDeviceCodeFlow(
  cfg: DeviceCodeFlowConfig,
  ua: OAuthUserAgent,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<OAuthFlowResult> {
  const userCodeEndpoint =
    cfg.userCodeEndpoint ?? `${cfg.issuer}/api/accounts/deviceauth/usercode`;
  const pollEndpoint =
    cfg.pollEndpoint ?? `${cfg.issuer}/api/accounts/deviceauth/token`;
  const tokenEndpoint = cfg.tokenEndpoint ?? `${cfg.issuer}/oauth/token`;
  const redirectUri = cfg.redirectUri ?? `${cfg.issuer}/deviceauth/callback`;
  const userVerificationUrl =
    cfg.userVerificationUrl ?? `${cfg.issuer}/codex/device`;
  const maxWaitSec = cfg.maxWaitSeconds ?? 900;
  const minPollSec = cfg.minPollSeconds ?? 3;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Phase 18.1: Accept: application/json on every device-code request,
  // matching Hermes (hermes_cli/auth.py:2264 `httpx.Client(headers={"Accept":
  // "application/json"})`). Most servers default to JSON anyway, but the
  // explicit header is the parity gap we close.
  const dcHeaders = {
    Accept: 'application/json',
    ...(cfg.extraHeaders ?? {}),
  };

  // Step 1: usercode
  const codeReq = await postForTokens(
    userCodeEndpoint,
    JSON.stringify({ client_id: cfg.clientId }),
    'application/json',
    dcHeaders,
    fetchImpl,
    timeoutMs,
  );
  if (codeReq.status !== 200) {
    throw new Error(
      `Device-code request failed: HTTP ${codeReq.status}: ${codeReq.text.slice(0, 200)}`,
    );
  }
  const codeResp = JSON.parse(codeReq.text) as DeviceCodeResponse;
  const userCode = codeResp.user_code ?? '';
  const deviceAuthId = codeResp.device_auth_id ?? '';
  const intervalSec = Math.max(
    minPollSec,
    Number(codeResp.interval ?? minPollSec),
  );
  if (!userCode || !deviceAuthId) {
    throw new Error('Device-code response missing user_code or device_auth_id');
  }

  ua.log('');
  ua.log('To continue:');
  ua.log(`  1. Open: ${userVerificationUrl}`);
  ua.log(`  2. Enter the code: ${userCode}`);
  ua.log('');
  ua.log('Waiting for sign-in… (Ctrl+C to cancel)');
  await ua.openBrowser(userVerificationUrl).catch(() => undefined);

  // Step 2: poll
  const deadline = Date.now() + maxWaitSec * 1000;
  let pollResp: DeviceCodePollResponse | null = null;
  while (Date.now() < deadline) {
    await ua.sleep(intervalSec * 1000);
    const r = await postForTokens(
      pollEndpoint,
      JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      'application/json',
      dcHeaders,
      fetchImpl,
      timeoutMs,
    );
    if (r.status === 200) {
      pollResp = JSON.parse(r.text) as DeviceCodePollResponse;
      break;
    }
    if (r.status === 403 || r.status === 404) {
      // user hasn't completed login yet — keep polling
      continue;
    }
    throw new Error(
      `Device-code poll failed: HTTP ${r.status}: ${r.text.slice(0, 200)}`,
    );
  }
  if (!pollResp) {
    throw new Error('Device-code login timed out (15 minutes)');
  }
  const authorizationCode = pollResp.authorization_code ?? '';
  const codeVerifier = pollResp.code_verifier ?? '';
  if (!authorizationCode || !codeVerifier) {
    throw new Error(
      'Device-code response missing authorization_code or code_verifier',
    );
  }

  // Step 3: exchange
  const exchange = await postForTokens(
    tokenEndpoint,
    urlencode({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: codeVerifier,
    }),
    'application/x-www-form-urlencoded',
    dcHeaders,
    fetchImpl,
    timeoutMs,
  );
  if (exchange.status !== 200) {
    throw new Error(
      `Token exchange failed: HTTP ${exchange.status}: ${exchange.text.slice(0, 200)}`,
    );
  }
  return parseTokenResponse(exchange.text);
}

// ─── Refresh ──────────────────────────────────────────────────────────

export interface RefreshConfig {
  tokenUrl: string;
  fallbackTokenUrls?: string[];
  clientId: string;
  /** True for OpenAI-style refresh (form-encoded). False for JSON. */
  formEncoded?: boolean;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export async function refreshTokens(
  refreshToken: string,
  cfg: RefreshConfig,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<OAuthFlowResult> {
  if (!refreshToken) throw new Error('refresh token is required');

  const formBody = urlencode({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  const jsonBody = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });

  const urls = [cfg.tokenUrl, ...(cfg.fallbackTokenUrls ?? [])];
  let lastErr = '';
  for (const url of urls) {
    const { status, text } = await postForTokens(
      url,
      cfg.formEncoded === false ? jsonBody : formBody,
      cfg.formEncoded === false
        ? 'application/json'
        : 'application/x-www-form-urlencoded',
      cfg.extraHeaders ?? {},
      fetchImpl,
      cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (status === 200) return parseTokenResponse(text);
    lastErr = `${url} → HTTP ${status}: ${text.slice(0, 200)}`;
  }
  throw new Error(`Token refresh failed: ${lastErr}`);
}

// ─── Shared parsing ───────────────────────────────────────────────────

function parseTokenResponse(text: string): OAuthFlowResult {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Token response is not JSON: ${text.slice(0, 200)}`);
  }
  const access = String(parsed.access_token ?? '').trim();
  if (!access) {
    throw new Error(
      `Token response missing access_token: ${text.slice(0, 200)}`,
    );
  }
  const refresh = parsed.refresh_token ? String(parsed.refresh_token) : null;
  const expires = Number(parsed.expires_in ?? 3600);
  const extras: Record<string, unknown> = {};
  for (const k of ['account', 'email', 'token_type', 'scope']) {
    if (parsed[k] !== undefined) extras[k] = parsed[k];
  }
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresInSeconds: expires,
    extras: Object.keys(extras).length ? extras : undefined,
  };
}
