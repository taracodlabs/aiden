/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/license/licenseClient.ts — Aiden v4.0.0 (Phase 20)
 *
 * Thin HTTP client for the existing Cloudflare worker at
 * `https://api.taracod.com`. v4 reuses v3 endpoints exactly — no schema
 * change. The worker source lives at `cloudflare-worker/license-server.ts`
 * (deployed independently of this repo).
 *
 * Endpoints:
 *   POST /license/activate    { key, machineId, machineName }
 *                            → { activated, plan, expiresAt, features, error? }
 *   POST /license/verify      { key, machineId }
 *                            → { valid, plan, expiresAt, features, error? }
 *   POST /license/deactivate  { key, machineId }
 *                            → { deactivated, error? }
 *
 * All calls have an 8 s timeout and surface network failures as a typed
 * result rather than throwing — callers (slash commands, feature gates)
 * decide how to degrade. The 7-day offline grace period from v3 is kept:
 * `verifyLicense()` returns the cached license if the network is down and
 * the key has not yet expired by its `expiresAt`.
 *
 * Hermes reference: none. Hermes has no license server. The v3 client
 * (`core/licenseManager.ts`) is the authoritative reference; v4 trims it
 * to async/await + a clean Result type and drops the legacy `/validate`,
 * `/verify-install`, `/register` endpoints (those were the email-gated
 * early-access flow, retired in v3.18).
 */

import { request as httpsRequest } from 'node:https';

import {
  getMachineFingerprint,
  getMachineDisplayName,
} from './machineFingerprint';
import {
  loadLicense,
  saveLicense,
  clearLicense,
  type LicenseCache,
} from './licenseStore';
import type { AidenPaths } from '../paths';

/** Default license server. Override via `AIDEN_LICENSE_SERVER` for staging. */
const DEFAULT_SERVER = 'https://api.taracod.com';

const DEFAULT_TIMEOUT_MS = 8_000;

/** 24 h server cache window. After this we re-verify. */
const VERIFY_CACHE_MS = 24 * 60 * 60 * 1000;

/** 7-day offline grace period — kept from v3. */
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Pro key shape: `AIDEN-PRO-XXXXX-XXXXX-XXXXX` (3 segments after prefix). */
const PRO_KEY_RE = /^AIDEN-PRO-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/;

export type LicenseServerResponse = {
  activated?: boolean;
  deactivated?: boolean;
  valid?: boolean;
  plan?: string;
  expiresAt?: string;
  features?: Record<string, boolean | number>;
  error?: string;
};

/** Injectable transport for tests — same shape as a minimal `fetch`. */
export type LicenseFetch = (
  urlPath: string,
  body: object,
  timeoutMs: number,
) => Promise<LicenseServerResponse>;

export interface LicenseClientOptions {
  paths: AidenPaths;
  /** Override the server URL. Defaults to env var or `api.taracod.com`. */
  server?: string;
  /** Override the transport. Used by tests to inject a mock. */
  fetchImpl?: LicenseFetch;
  /** Override env (for the machine-fingerprint override). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Default HTTPS POST. Uses Node's `https` module (not built-in `fetch`)
 * because v3 saw spurious `CERT_NOT_YET_VALID` from Undici on Cloudflare
 * certs — same workaround pattern, kept for parity.
 */
function makeDefaultFetch(server: string): LicenseFetch {
  return (urlPath, body, timeoutMs) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const url = new URL(server);
      const req = httpsRequest(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: urlPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'User-Agent': 'aiden-runtime/4.0',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk: Buffer) => {
            raw += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(raw) as LicenseServerResponse);
            } catch {
              reject(new Error('license server returned non-JSON'));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('license server request timed out'));
      });
      req.write(data);
      req.end();
    });
}

/** Type guard for the worker's success response on /license/activate. */
function isActivated(r: LicenseServerResponse): r is LicenseServerResponse & { activated: true } {
  return r.activated === true;
}

/** Strict key-format validator — pre-flight check so we don't waste a worker call. */
export function isWellFormedKey(key: string): boolean {
  return PRO_KEY_RE.test(key.trim().toUpperCase());
}

/** High-level client API. One instance per Aiden process is fine. */
export class LicenseClient {
  private readonly paths: AidenPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: LicenseFetch;

  constructor(opts: LicenseClientOptions) {
    this.paths = opts.paths;
    this.env = opts.env ?? process.env;
    const server =
      opts.server ?? this.env.AIDEN_LICENSE_SERVER ?? DEFAULT_SERVER;
    this.fetchImpl = opts.fetchImpl ?? makeDefaultFetch(server);
  }

  /**
   * Activate a Pro license key on this machine.
   *
   * On success: persists `LicenseCache` to disk and returns `{ ok: true,
   * cache }`. On any failure (bad format, network, server rejection):
   * returns `{ ok: false, error }` — never throws.
   */
  async activate(
    rawKey: string,
  ): Promise<{ ok: true; cache: LicenseCache } | { ok: false; error: string }> {
    const key = rawKey.trim().toUpperCase();
    if (!isWellFormedKey(key)) {
      return {
        ok: false,
        error: 'Invalid key format. Expected AIDEN-PRO-XXXXX-XXXXX-XXXXX.',
      };
    }
    const machineId = getMachineFingerprint(this.env);
    const machineName = getMachineDisplayName();

    let resp: LicenseServerResponse;
    try {
      resp = await this.fetchImpl(
        '/license/activate',
        { key, machineId, machineName },
        DEFAULT_TIMEOUT_MS,
      );
    } catch (err) {
      return {
        ok: false,
        error: `Network error contacting license server: ${(err as Error).message}`,
      };
    }
    if (!isActivated(resp)) {
      return {
        ok: false,
        error:
          resp.error ||
          'License server rejected the activation. The key may be invalid, revoked, or already in use on the maximum number of machines.',
      };
    }
    const cache: LicenseCache = {
      key,
      valid: true,
      plan: resp.plan ?? 'pro_monthly',
      expiresAt: resp.expiresAt ?? '',
      features: resp.features ?? {},
      lastVerified: Date.now(),
    };
    await saveLicense(this.paths, cache, this.env);
    return { ok: true, cache };
  }

  /**
   * Verify the cached license against the server.
   *
   * Cache rules:
   *   - No cache → `{ tier: 'free' }` (nothing to verify).
   *   - Cache fresh (<24 h) → return cached as Pro without a network call.
   *   - Cache stale → POST /license/verify; on success update + return; on
   *     network failure trust the cache up to its `expiresAt` (offline
   *     grace, max 7 days from `lastVerified`).
   *   - Server says invalid → mark cache invalid, return `{ tier: 'free' }`.
   */
  async verify(): Promise<
    | { tier: 'free' }
    | { tier: 'pro'; cache: LicenseCache; cached: boolean; offline?: boolean }
  > {
    const cache = await loadLicense(this.paths, { env: this.env });
    if (!cache?.key) return { tier: 'free' };
    if (
      cache.valid &&
      Date.now() - cache.lastVerified < VERIFY_CACHE_MS &&
      !this.isPastExpiry(cache)
    ) {
      return { tier: 'pro', cache, cached: true };
    }

    const machineId = getMachineFingerprint(this.env);
    let resp: LicenseServerResponse;
    try {
      resp = await this.fetchImpl(
        '/license/verify',
        { key: cache.key, machineId },
        DEFAULT_TIMEOUT_MS,
      );
    } catch {
      // Offline. Trust the cache while inside the grace window AND not past expiry.
      const ageMs = Date.now() - cache.lastVerified;
      if (cache.valid && ageMs < OFFLINE_GRACE_MS && !this.isPastExpiry(cache)) {
        return { tier: 'pro', cache, cached: true, offline: true };
      }
      return { tier: 'free' };
    }
    if (resp.valid !== true) {
      const next: LicenseCache = { ...cache, valid: false, lastVerified: Date.now() };
      await saveLicense(this.paths, next, this.env);
      return { tier: 'free' };
    }
    const next: LicenseCache = {
      ...cache,
      valid: true,
      plan: resp.plan ?? cache.plan,
      expiresAt: resp.expiresAt ?? cache.expiresAt,
      features: resp.features ?? cache.features,
      lastVerified: Date.now(),
    };
    await saveLicense(this.paths, next, this.env);
    return { tier: 'pro', cache: next, cached: false };
  }

  /**
   * Deactivate this machine's license seat. Best-effort: even if the worker
   * is unreachable we still clear the local cache so the user can move to a
   * new machine. The seat will get reclaimed on the next server-side audit.
   */
  async deactivate(): Promise<{ ok: boolean; error?: string }> {
    const cache = await loadLicense(this.paths, { env: this.env });
    if (!cache?.key) return { ok: true };

    const machineId = getMachineFingerprint(this.env);
    let serverErr: string | undefined;
    try {
      const resp = await this.fetchImpl(
        '/license/deactivate',
        { key: cache.key, machineId },
        DEFAULT_TIMEOUT_MS,
      );
      if (!resp.deactivated) {
        serverErr = resp.error || 'Server did not confirm deactivation.';
      }
    } catch (err) {
      serverErr = (err as Error).message;
    }
    await clearLicense(this.paths, this.env);
    return { ok: true, error: serverErr };
  }

  /**
   * Synchronous-from-cache status check. NEVER hits the network. Used by
   * the boot card and feature gates on the hot path. The `verify()` call
   * is the source of truth; this is the cached snapshot.
   */
  async statusFromCache(): Promise<
    | { tier: 'free' }
    | { tier: 'pro'; cache: LicenseCache }
  > {
    const cache = await loadLicense(this.paths, { env: this.env });
    if (!cache?.valid || !cache.key) return { tier: 'free' };
    if (this.isPastExpiry(cache)) return { tier: 'free' };
    if (Date.now() - cache.lastVerified > OFFLINE_GRACE_MS) {
      return { tier: 'free' };
    }
    return { tier: 'pro', cache };
  }

  private isPastExpiry(cache: LicenseCache): boolean {
    if (!cache.expiresAt) return false; // lifetime
    const t = Date.parse(cache.expiresAt);
    if (Number.isNaN(t)) return false;
    return Date.now() > t;
  }
}
