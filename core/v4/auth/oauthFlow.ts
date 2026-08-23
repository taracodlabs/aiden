/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * core/v4/auth/oauthFlow.ts
 *
 * Provider-agnostic OAuth primitives. Aiden ships two flow shapes:
 *
 *   1. **Out-of-band copy-paste** (Claude Pro / Max).
 *      We build a PKCE-protected authorize URL, open the user's browser,
 *      they sign in on the provider's domain, copy a `<code>#<state>`
 *      string off the redirect page, paste it back into the terminal,
 *      and we exchange it for tokens. No callback server, no port to
 *      open.
 *
 *   2. **Device code** (ChatGPT Plus / OpenAI Codex).
 *      We POST for a usercode + device_auth_id, show the user a URL +
 *      short code to enter on a phone or other browser, then poll the
 *      provider until they approve. The poll yields an authorization
 *      code + verifier we exchange for tokens.
 *
 * Plus refresh: feed a refresh token back to the provider's token
 * endpoint and get a new access token + (usually) a rotated refresh
 * token. Each provider picks form-encoded vs JSON via `RefreshConfig`.
 *
 * `FetchImpl` is a tight subset of the global fetch API so tests can
 * inject a deterministic stub without touching `vi.stubGlobal`.
 *
 * `OAuthUserAgent` is the small UI surface the flow drives — log lines
 * to stdout, open the browser, prompt for input, sleep between polls.
 * The chat REPL injects a readline-backed implementation; tests inject
 * a `vi.fn()` stub. `loadProvider.ts::openOAuthBrowserUrl` carries the
 * cross-platform browser-launch logic; this module never touches OS
 * spawn primitives directly.
 */

import { createHash, randomBytes } from 'node:crypto';

// ── Public types ──────────────────────────────────────────────────────

export interface PkceMaterial {
  /** 32 random bytes, urlsafe-base64, no padding (RFC 7636). */
  verifier:  string;
  /** SHA-256(verifier), urlsafe-base64, no padding — 43 chars. */
  challenge: string;
}

/** Result of a successful flow. Caller persists via `tokenStore`. */
export interface OAuthFlowResult {
  accessToken:       string;
  refreshToken:      string | null;
  expiresInSeconds:  number;
  /** Provider-specific extras (account, email, scope, token_type). */
  extras?:           Record<string, unknown>;
}

/** Tight subset of the global fetch API — easy to stub in tests. */
export type FetchImpl = (
  input: string,
  init:  { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

/** UI surface the flow uses to talk to the user. */
export interface OAuthUserAgent {
  log(line: string):                    void;
  openBrowser(url: string):             Promise<void>;
  prompt(question: string):             Promise<string>;
  sleep(ms: number):                    Promise<void>;
}

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS              = 15_000;
const DEFAULT_DEVICE_MAX_WAIT_SECONDS = 900;   // 15 min — matches OpenAI's window
const DEFAULT_DEVICE_POLL_FLOOR_SEC   = 3;     // OpenAI's documented minimum

/** Codex device-code endpoints relative to `${issuer}`. Overridable per call. */
const DEVICE_USERCODE_PATH       = '/api/accounts/deviceauth/usercode';
const DEVICE_POLL_PATH           = '/api/accounts/deviceauth/token';
const DEVICE_TOKEN_EXCHANGE_PATH = '/oauth/token';
const DEVICE_VERIFY_PATH         = '/codex/device';
const DEVICE_REDIRECT_PATH       = '/deviceauth/callback';

const CONTENT_TYPE_JSON = 'application/json';
/** Exported for reuse by the MCP loopback flow (core/v4/mcp/oauthLoginFlow.ts). */
export const CONTENT_TYPE_FORM = 'application/x-www-form-urlencoded';

// ── PKCE ──────────────────────────────────────────────────────────────

/**
 * Mint a fresh PKCE pair. RFC 7636 §4.1: verifier = 43–128 unreserved
 * chars; we emit 43 (32 bytes base64url, padding stripped). RFC 7636
 * §4.2: challenge = base64url(sha256(verifier)), padding stripped.
 */
export function generatePkce(): PkceMaterial {
  const verifier  = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── Copy-paste flow (Claude Pro / Max shape) ──────────────────────────

export interface CopyPasteFlowConfig {
  authUrl:             string;
  tokenUrl:            string;
  fallbackTokenUrls?:  string[];
  clientId:            string;
  redirectUri:         string;
  scope:               string;
  /** Merged into the token-exchange request headers. */
  extraHeaders?:       Record<string, string>;
  /**
   * Override the authorize-URL builder. Defaults to a vanilla
   * `URLSearchParams` join; provided as an escape hatch in case a
   * provider needs an unusual param ordering or a non-standard separator.
   */
  buildAuthUrl?:       (base: string, params: Record<string, string>) => string;
  timeoutMs?:          number;
}

/**
 * Drive the copy-paste flow end-to-end. Caller provides the PKCE-relevant
 * config; we mint the verifier, walk the user through the URL, await the
 * paste, and return parsed tokens.
 *
 * Throws (with descriptive messages) on:
 *   - empty / cancelled paste
 *   - all token endpoints failing
 *   - response missing `access_token`
 *   - response not parseable as JSON
 */
export async function runCopyPasteFlow(
  cfg:        CopyPasteFlowConfig,
  ua:         OAuthUserAgent,
  fetchImpl:  FetchImpl = fetch as unknown as FetchImpl,
): Promise<OAuthFlowResult> {
  const pkce      = generatePkce();
  const authUrl   = composeAuthorizeUrl(cfg, pkce);

  // Phase 25.1.5 diagnostic — gated by env so it never leaks in production.
  if (process.env.AIDEN_DEBUG_OAUTH === '1') {
    // eslint-disable-next-line no-console
    console.error(`[oauth-debug] auth url: ${authUrl}`);
  }

  ua.log('');
  ua.log('Authorise Aiden with your Claude Pro/Max subscription.');
  ua.log('');
  ua.log('Open this URL in your browser:');
  ua.log(`  ${authUrl}`);
  ua.log('');
  // Best-effort browser open. Headless / sandboxed environments swallow
  // the failure silently — the user can still copy the printed URL.
  await ua.openBrowser(authUrl).catch(() => undefined);

  ua.log('After authorising, you will see a code on the page.');
  const pasted = (await ua.prompt('Paste the code (and any "#state" suffix) here: ')).trim();
  if (!pasted) {
    throw new Error('No authorisation code entered — cancelled');
  }

  const [code, state = ''] = pasted.split('#', 2);

  // Login uses JSON body (six required fields).
  const exchangeBody = JSON.stringify({
    grant_type:     'authorization_code',
    client_id:      cfg.clientId,
    code,
    state,
    redirect_uri:   cfg.redirectUri,
    code_verifier:  pkce.verifier,
  });

  const endpoints = [cfg.tokenUrl, ...(cfg.fallbackTokenUrls ?? [])];
  return tryTokenExchange(
    endpoints,
    exchangeBody,
    CONTENT_TYPE_JSON,
    cfg.extraHeaders ?? {},
    fetchImpl,
    cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

function composeAuthorizeUrl(
  cfg:   CopyPasteFlowConfig,
  pkce:  PkceMaterial,
): string {
  // Eight params on /oauth/authorize. `code=true` is the Claude-Code
  // "give me the code on the redirect page" flag; the rest is standard
  // PKCE auth-code. The provider round-trips `state` back to the user
  // on the redirect page, so using the verifier doubles as a sanity
  // check the user pasted the right session — though tests pin state
  // round-trip via the pasted-code split, not the URL contents.
  const params: Record<string, string> = {
    code:                    'true',
    client_id:               cfg.clientId,
    response_type:           'code',
    redirect_uri:            cfg.redirectUri,
    scope:                   cfg.scope,
    code_challenge:          pkce.challenge,
    code_challenge_method:   'S256',
    state:                   pkce.verifier,
  };
  const builder = cfg.buildAuthUrl ?? defaultBuildAuthUrl;
  return builder(cfg.authUrl, params);
}

function defaultBuildAuthUrl(base: string, params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.append(k, v);
  return `${base}?${sp.toString()}`;
}

// ── Device-code flow (ChatGPT Plus / Codex shape) ─────────────────────

export interface DeviceCodeFlowConfig {
  /** Issuer base URL, e.g. `https://auth.openai.com`. */
  issuer:               string;
  clientId:             string;
  userCodeEndpoint?:    string;
  pollEndpoint?:        string;
  tokenEndpoint?:       string;
  redirectUri?:         string;
  userVerificationUrl?: string;
  /** Hard cap on poll wait. Default 900 (15 min). */
  maxWaitSeconds?:      number;
  /** Floor on the poll-interval the provider reports. Default 3. */
  minPollSeconds?:      number;
  extraHeaders?:        Record<string, string>;
  timeoutMs?:           number;
}

interface UsercodeReply  { user_code?: string; device_auth_id?: string; interval?: number | string }
interface PollReply      { authorization_code?: string; code_verifier?: string }

/**
 * Drive the device-code flow. Returns parsed tokens or throws with a
 * descriptive error.
 */
export async function runDeviceCodeFlow(
  cfg:        DeviceCodeFlowConfig,
  ua:         OAuthUserAgent,
  fetchImpl:  FetchImpl = fetch as unknown as FetchImpl,
): Promise<OAuthFlowResult> {
  const usercodeEndpoint = cfg.userCodeEndpoint    ?? `${cfg.issuer}${DEVICE_USERCODE_PATH}`;
  const pollEndpoint     = cfg.pollEndpoint        ?? `${cfg.issuer}${DEVICE_POLL_PATH}`;
  const tokenEndpoint    = cfg.tokenEndpoint       ?? `${cfg.issuer}${DEVICE_TOKEN_EXCHANGE_PATH}`;
  const redirectUri      = cfg.redirectUri         ?? `${cfg.issuer}${DEVICE_REDIRECT_PATH}`;
  const verifyUrl        = cfg.userVerificationUrl ?? `${cfg.issuer}${DEVICE_VERIFY_PATH}`;
  const maxWaitSec       = cfg.maxWaitSeconds      ?? DEFAULT_DEVICE_MAX_WAIT_SECONDS;
  const pollFloorSec     = cfg.minPollSeconds      ?? DEFAULT_DEVICE_POLL_FLOOR_SEC;
  const timeoutMs        = cfg.timeoutMs           ?? DEFAULT_TIMEOUT_MS;

  // `Accept: application/json` is required on every device-code POST so
  // the provider doesn't downgrade to HTML on errors. extraHeaders win
  // last — caller can override Accept if they really mean to.
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPE_JSON,
    'Accept':       CONTENT_TYPE_JSON,
    ...(cfg.extraHeaders ?? {}),
  };

  // ── Step 1: request the usercode ────────────────────────────────────
  const usercodeBody = JSON.stringify({ client_id: cfg.clientId });
  const usercode = await postWithTimeout(
    usercodeEndpoint, usercodeBody, headers, fetchImpl, timeoutMs,
  );
  if (usercode.status !== 200) {
    throw new Error(
      `Device-code request failed: HTTP ${usercode.status} from ${usercodeEndpoint}: ${usercode.text.slice(0, 200)}`,
    );
  }
  const usercodeReply: UsercodeReply = parseJsonOrThrow(usercode.text, 'device-code');
  const userCode      = usercodeReply.user_code      ?? '';
  const deviceAuthId  = usercodeReply.device_auth_id ?? '';
  const reportedPoll  = Number(usercodeReply.interval ?? pollFloorSec);
  const pollSec       = Math.max(pollFloorSec, Number.isFinite(reportedPoll) ? reportedPoll : pollFloorSec);
  if (!userCode || !deviceAuthId) {
    throw new Error('Device-code response missing user_code or device_auth_id');
  }

  // ── Step 2: brief the user ──────────────────────────────────────────
  ua.log('');
  ua.log('To continue, follow these steps:');
  ua.log('');
  ua.log('  1. Open this URL in your browser:');
  ua.log(`     ${verifyUrl}`);
  ua.log('');
  ua.log('  2. Enter this code:');
  ua.log(`     ${userCode}`);
  ua.log('');
  await ua.openBrowser(verifyUrl);
  ua.log('Waiting for sign-in...');
  // First sleep is documentation-fairness — give the user a moment to
  // open the page before we start polling. Tests pin this `sleep` count.
  await ua.sleep(pollSec * 1000);

  // ── Step 3: poll until success / fail / timeout ─────────────────────
  const pollBody = JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode });
  const startMs  = Date.now();
  const deadline = startMs + maxWaitSec * 1000;

  let pollResult: PollReply | null = null;
  // Strict-less-than: with `maxWaitSeconds: 0` the deadline is the start
  // instant, so we exit immediately without polling. Test 14 pins this.
  while (Date.now() < deadline) {
    const r = await postWithTimeout(pollEndpoint, pollBody, headers, fetchImpl, timeoutMs);
    if (r.status === 200) {
      pollResult = parseJsonOrThrow(r.text, 'device-code poll');
      if (pollResult.authorization_code) break;
      // Got 200 but no auth code — provider's still waiting; back off.
      pollResult = null;
    } else if (r.status === 403 || r.status === 410 || r.status === 425 || r.status === 429) {
      // Standard "still pending" / "slow down" responses. Keep polling.
    } else {
      throw new Error(
        `Device-code poll failed: HTTP ${r.status} from ${pollEndpoint}: ${r.text.slice(0, 200)}`,
      );
    }
    await ua.sleep(pollSec * 1000);
  }

  if (!pollResult || !pollResult.authorization_code) {
    throw new Error(`Device-code login timed out after ${maxWaitSec} seconds`);
  }

  // ── Step 4: exchange the auth code for tokens (form-encoded) ───────
  const exchangeBody = urlencode({
    grant_type:     'authorization_code',
    client_id:      cfg.clientId,
    code:           pollResult.authorization_code,
    code_verifier:  pollResult.code_verifier ?? '',
    redirect_uri:   redirectUri,
  });
  const exchangeHeaders = { ...headers, 'Content-Type': CONTENT_TYPE_FORM };
  return tryTokenExchange(
    [tokenEndpoint],
    exchangeBody,
    CONTENT_TYPE_FORM,
    // Re-merge so Accept survives the Content-Type override above.
    { Accept: CONTENT_TYPE_JSON, ...(cfg.extraHeaders ?? {}) },
    fetchImpl,
    timeoutMs,
  );
}

// ── Refresh ───────────────────────────────────────────────────────────

export interface RefreshConfig {
  tokenUrl:            string;
  fallbackTokenUrls?:  string[];
  clientId:            string;
  /**
   * `true` (default) → form-encoded body + `Content-Type: x-www-form-urlencoded`.
   * `false`          → JSON body + `Content-Type: application/json`.
   */
  formEncoded?:        boolean;
  extraHeaders?:       Record<string, string>;
  /** RFC 8707 protected-resource binding retained across refresh. */
  resource?:           string;
  /** Exact previously granted/requested scope set; refresh may only narrow it. */
  scope?:              string;
  timeoutMs?:          number;
}

/**
 * Exchange a refresh token for a new access token. Tries each endpoint
 * in order; throws when all fail or any returns a body without an
 * access_token.
 */
export async function refreshTokens(
  refreshToken:  string,
  cfg:           RefreshConfig,
  fetchImpl:     FetchImpl = fetch as unknown as FetchImpl,
): Promise<OAuthFlowResult> {
  if (!refreshToken) {
    throw new Error('refresh token is required');
  }

  const useForm        = cfg.formEncoded !== false;   // default form-encoded
  const fields         = {
    grant_type:     'refresh_token',
    refresh_token:  refreshToken,
    client_id:      cfg.clientId,
    ...(cfg.resource ? { resource: cfg.resource } : {}),
    ...(cfg.scope ? { scope: cfg.scope } : {}),
  };
  const body           = useForm ? urlencode(fields)       : JSON.stringify(fields);
  const contentType    = useForm ? CONTENT_TYPE_FORM       : CONTENT_TYPE_JSON;

  const endpoints = [cfg.tokenUrl, ...(cfg.fallbackTokenUrls ?? [])];
  return tryTokenExchange(
    endpoints,
    body,
    contentType,
    cfg.extraHeaders ?? {},
    fetchImpl,
    cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * POST `body` to each URL until one returns 200 with a valid token
 * payload. On all-failed, throws an error whose message embeds the last
 * status + body excerpt so the user can diagnose without diff-hunting.
 *
 * Exported for reuse by the MCP loopback flow (core/v4/mcp/oauthLoginFlow.ts).
 */
export async function tryTokenExchange(
  endpoints:    string[],
  body:         string,
  contentType:  string,
  extraHeaders: Record<string, string>,
  fetchImpl:    FetchImpl,
  timeoutMs:    number,
): Promise<OAuthFlowResult> {
  const headers = { 'Content-Type': contentType, ...extraHeaders };
  let lastDescription = '';
  for (const url of endpoints) {
    const reply = await postWithTimeout(url, body, headers, fetchImpl, timeoutMs);
    if (reply.status === 200) {
      return parseTokens(reply.text);
    }
    lastDescription = `${url} → HTTP ${reply.status}: ${reply.text.slice(0, 200)}`;
  }
  throw new Error(`Token exchange failed: ${lastDescription || 'no endpoints attempted'}`);
}

/**
 * POST with abort-on-timeout. Returns the response status and a
 * pre-buffered text body so callers don't have to manage stream lifetimes.
 */
async function postWithTimeout(
  url:        string,
  body:       string,
  headers:    Record<string, string>,
  fetchImpl:  FetchImpl,
  timeoutMs:  number,
): Promise<{ status: number; text: string }> {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { method: 'POST', headers, body });
    return { status: resp.status, text: await resp.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Form-encode a flat record of strings. */
function urlencode(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.append(k, v);
  return sp.toString();
}

function parseJsonOrThrow<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} response is not JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Parse an OAuth token-endpoint body. Strict on `access_token` (the one
 * field we cannot proceed without); permissive about everything else so
 * a provider that returns extras-we-don't-know-about doesn't break us.
 */
function parseTokens(text: string): OAuthFlowResult {
  const parsed = parseJsonOrThrow<Record<string, unknown>>(text, 'Token');
  const access = String(parsed.access_token ?? '').trim();
  if (!access) {
    throw new Error(`Token response missing access_token: ${text.slice(0, 200)}`);
  }
  const refresh  = parsed.refresh_token ? String(parsed.refresh_token) : null;
  const expires  = Number(parsed.expires_in ?? 3600);
  const extras: Record<string, unknown> = {};
  for (const k of ['account', 'email', 'token_type', 'scope']) {
    if (parsed[k] !== undefined) extras[k] = parsed[k];
  }
  return {
    accessToken:       access,
    refreshToken:      refresh,
    expiresInSeconds:  expires,
    extras:            Object.keys(extras).length > 0 ? extras : undefined,
  };
}
