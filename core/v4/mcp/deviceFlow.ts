/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/deviceFlow.ts — v4.14: OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * The secret-free login path for STATIC-CLIENT MCP providers — servers whose
 * authorization server publishes no `registration_endpoint` (no RFC 7591
 * Dynamic Client Registration), so Aiden can't self-register a client. GitHub
 * is the first such provider, but NOTHING here is GitHub-specific: it's plain
 * RFC 8628 driven by a `{ deviceAuthorizationEndpoint, tokenEndpoint, clientId,
 * scope }` config that any provider can fill.
 *
 * Why device flow (not a client_secret): no shared secret baked into an open-
 * source local tool, and no loopback redirect/port juggling — the user just
 * opens a URL and types a short code. It's how the `gh` CLI authenticates.
 *
 * This is a SIBLING to the loopback flow (oauthLoginFlow.ts), not a rewrite:
 * both produce an `OAuthFlowResult` that the SAME encrypted 0600 token store
 * and the SAME `refreshTokens` path consume — nothing downstream cares HOW the
 * token was obtained. Reuses the shared primitives from `../auth/oauthFlow`.
 *
 *   1. POST the device-authorization endpoint (client_id [+ scope]) →
 *      { device_code, user_code, verification_uri, interval, expires_in }.
 *   2. Show the user the URL + code (and best-effort open the browser).
 *   3. Poll the token endpoint with the device_code grant, honouring the
 *      RFC 8628 §3.5 poll responses: authorization_pending (keep polling),
 *      slow_down (back off +5s), access_denied / expired_token (clean stop),
 *      success (return the token).
 */

import type { FetchImpl, OAuthFlowResult, OAuthUserAgent } from '../auth/oauthFlow';
import { CONTENT_TYPE_FORM } from '../auth/oauthFlow';

/** RFC 8628 §3.4 — the device-code token grant type. */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** RFC 8628 §3.5 — bump the poll interval by this much on a `slow_down`. */
const SLOW_DOWN_BUMP_SEC = 5;
const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_EXPIRES_SEC = 900;
const CONTENT_TYPE_JSON = 'application/json';

export interface DeviceFlowConfig {
  /** RFC 8628 §3.1 device-authorization endpoint (carried per-provider — many,
   *  like GitHub, do NOT publish it in AS metadata). */
  deviceAuthorizationEndpoint: string;
  /** The AS token endpoint (usually discovered from AS metadata). */
  tokenEndpoint: string;
  /** The pre-registered PUBLIC client id (device flow uses no secret). */
  clientId: string;
  /** Space-delimited scopes to request, or undefined for the provider default. */
  scope?: string;
}

/** RFC 8628 §3.2 device-authorization response (the fields we consume). */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** RFC 8628 §3.3.1 — URL with the code pre-filled (optional). */
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

/** The outcome of a single token poll — the RFC 8628 §3.5 state machine. */
export type DevicePollOutcome =
  | { kind: 'success'; result: OAuthFlowResult }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

function asObj(text: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
function num(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Build an OAuthFlowResult from a token-endpoint success body. */
function toResult(j: Record<string, unknown>): OAuthFlowResult {
  const extras: Record<string, unknown> = {};
  for (const k of ['token_type', 'scope', 'account', 'email']) {
    if (j[k] !== undefined) extras[k] = j[k];
  }
  return {
    accessToken: str(j.access_token),
    // Classic OAuth Apps (e.g. GitHub) often return no refresh_token — that's
    // fine; persistMcpTokens keeps any prior one and the access token is used
    // directly. Providers that DO rotate refresh tokens refresh identically.
    refreshToken: j.refresh_token ? String(j.refresh_token) : null,
    expiresInSeconds: Number(j.expires_in ?? 3600),
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  };
}

/** RFC 8628 §3.1/§3.2 — request the device + user codes. */
export async function requestDeviceAuthorization(
  cfg: DeviceFlowConfig,
  fetchImpl: FetchImpl,
): Promise<DeviceAuthorization> {
  const body = new URLSearchParams({ client_id: cfg.clientId });
  if (cfg.scope) body.set('scope', cfg.scope);
  const res = await fetchImpl(cfg.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': CONTENT_TYPE_FORM, Accept: CONTENT_TYPE_JSON },
    body: body.toString(),
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`Device authorization request failed: HTTP ${res.status} at ${cfg.deviceAuthorizationEndpoint}: ${text.slice(0, 200)}`);
  }
  const j = asObj(text);
  if (!j) throw new Error(`Device authorization response is not JSON: ${text.slice(0, 200)}`);
  const deviceCode = str(j.device_code);
  const userCode = str(j.user_code);
  const verificationUri = str(j.verification_uri) || str(j.verification_url); // some servers use *_url
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error('Device authorization response missing device_code / user_code / verification_uri.');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(j.verification_uri_complete) || undefined,
    expiresInSeconds: num(j.expires_in, DEFAULT_EXPIRES_SEC),
    intervalSeconds: Math.max(1, num(j.interval, DEFAULT_INTERVAL_SEC)),
  };
}

/**
 * One token poll (RFC 8628 §3.4/§3.5). Classifies the response into the poll
 * state machine. Tolerates the GitHub quirk of returning HTTP 200 with an
 * `error` field for pending/slow_down by keying off the body, not the status.
 */
export async function pollDeviceTokenOnce(
  cfg: DeviceFlowConfig,
  deviceCode: string,
  fetchImpl: FetchImpl,
): Promise<DevicePollOutcome> {
  const body = new URLSearchParams({
    grant_type: DEVICE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: cfg.clientId,
  });
  const res = await fetchImpl(cfg.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': CONTENT_TYPE_FORM, Accept: CONTENT_TYPE_JSON },
    body: body.toString(),
  });
  const text = await res.text();
  const j = asObj(text);
  if (j && str(j.access_token)) return { kind: 'success', result: toResult(j) };

  const err = j ? str(j.error) : '';
  switch (err) {
    case 'authorization_pending': return { kind: 'pending' };
    case 'slow_down':             return { kind: 'slow_down' };
    case 'access_denied':         return { kind: 'denied' };
    case 'expired_token':         return { kind: 'expired' };
    case '':                      return { kind: 'error', message: `Unexpected device-token response: HTTP ${res.status}: ${text.slice(0, 200)}` };
    default:                      return { kind: 'error', message: `Device authorization failed: ${err}${j && str(j.error_description) ? ` — ${str(j.error_description)}` : ''}` };
  }
}

export interface RunDeviceFlowDeps {
  config: DeviceFlowConfig;
  server: string;
  ua: OAuthUserAgent;
  fetchImpl?: FetchImpl;
  /** Injected clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Cancel the poller cleanly (Ctrl+C). Checked at each poll boundary; when
   * aborted the flow throws a clear "cancelled" error instead of polling on.
   */
  signal?: AbortSignal;
}

/**
 * Drive the whole RFC 8628 flow: request codes → brief the user → poll until
 * success / denial / expiry / timeout. Returns the token (caller persists it
 * via the same `persistMcpTokens` the loopback flow uses).
 */
export async function runMcpDeviceFlow(deps: RunDeviceFlowDeps): Promise<OAuthFlowResult> {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchImpl);
  const now = deps.now ?? Date.now;

  const auth = await requestDeviceAuthorization(deps.config, fetchImpl);
  const aborted = (): boolean => deps.signal?.aborted === true;
  const cancel = (): Error => new Error(`Cancelled device authorization for "${deps.server}".`);

  // Clear terminal UX: ALWAYS print the URL + code (SSH/WSL/headless-safe), the
  // expiry, the waiting state, and the cancel instruction — then best-effort
  // open the browser (never rely on it).
  const expiresMin = Math.max(1, Math.round(auth.expiresInSeconds / 60));
  deps.ua.log('');
  deps.ua.log(`To connect "${deps.server}", authorize in your browser:`);
  deps.ua.log(`  1. Open this URL:  ${auth.verificationUri}`);
  deps.ua.log(`  2. Enter the code: ${auth.userCode}`);
  deps.ua.log('');
  deps.ua.log(`This code expires in ~${expiresMin} min. Waiting for approval…  (press Ctrl+C to cancel)`);
  await deps.ua.openBrowser(auth.verificationUriComplete ?? auth.verificationUri).catch(() => undefined);

  let intervalSec = auth.intervalSeconds;
  const deadline = now() + auth.expiresInSeconds * 1000;

  // Give the user a moment before the first poll.
  if (aborted()) throw cancel();
  await deps.ua.sleep(intervalSec * 1000);

  while (now() < deadline) {
    if (aborted()) throw cancel();
    const outcome = await pollDeviceTokenOnce(deps.config, auth.deviceCode, fetchImpl);
    switch (outcome.kind) {
      case 'success':
        return outcome.result;
      case 'denied':
        throw new Error(`Authorization denied — you declined the "${deps.server}" connection.`);
      case 'expired':
        throw new Error(`The device code expired before authorization completed. Run \`/mcp auth ${deps.server}\` again.`);
      case 'error':
        throw new Error(outcome.message);
      case 'slow_down':
        intervalSec += SLOW_DOWN_BUMP_SEC; // RFC 8628 §3.5 — then keep polling
        break;
      case 'pending':
        break; // keep polling
    }
    await deps.ua.sleep(intervalSec * 1000);
  }
  throw new Error(`The code expired before "${deps.server}" was authorized. Run \`/mcp auth ${deps.server}\` to try again.`);
}
