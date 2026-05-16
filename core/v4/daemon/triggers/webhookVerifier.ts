/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/webhookVerifier.ts — v4.5 Phase 3.
 *
 * Per-format HMAC verification. Constant-time comparison via
 * `crypto.timingSafeEqual` to defeat timing attacks.
 *
 * Three formats supported in Phase 3:
 *   github   — X-Hub-Signature-256: sha256=<hex>
 *              HMAC-SHA256(secret, body) == hex
 *
 *   gitlab   — X-Gitlab-Token: <plain>
 *              Plain shared-secret comparison. No HMAC; the token
 *              header IS the secret. Constant-time compared.
 *
 *   generic  — X-Webhook-Signature: <hex>
 *              HMAC-SHA256(secret, body) == hex
 *
 * Phase 3.x extensibility: add new entries to `VERIFIERS` map.
 * Stripe (timestamped) and Slack (timestamped) would each get a
 * function that pulls timestamp + signature from headers and
 * verifies HMAC-SHA256(secret, `${ts}.${body}`).
 */

import crypto from 'node:crypto';
import { INSECURE_NO_AUTH } from './webhookSpec';
import type { WebhookHmacFormat } from './webhookSpec';

export interface VerifyOptions {
  format:  WebhookHmacFormat;
  secret:  string;
  body:    Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export function verifyWebhookSignature(opts: VerifyOptions): boolean {
  // Loopback-only insecure mode — the SAFETY of this depends on
  // the daemon being bound to 127.0.0.1, enforced by bootstrap.
  if (opts.secret === INSECURE_NO_AUTH) return true;

  const fn = VERIFIERS[opts.format];
  if (!fn) return false;
  try { return fn(opts); }
  catch { return false; }
}

const VERIFIERS: Record<WebhookHmacFormat, (o: VerifyOptions) => boolean> = {
  github(o) {
    const raw = pickHeader(o.headers, 'x-hub-signature-256');
    if (!raw) return false;
    // GitHub header is `sha256=<hex>`. Strip the prefix.
    const m = raw.match(/^sha256=([0-9a-fA-F]+)$/);
    if (!m) return false;
    const expected = hmacHex(o.secret, o.body);
    return safeEqualHex(expected, m[1]);
  },
  gitlab(o) {
    const received = pickHeader(o.headers, 'x-gitlab-token');
    if (!received) return false;
    // Plain shared-secret. Compare as bytes; constant-time.
    return safeEqualString(o.secret, received);
  },
  generic(o) {
    const raw = pickHeader(o.headers, 'x-webhook-signature');
    if (!raw) return false;
    const expected = hmacHex(o.secret, o.body);
    return safeEqualHex(expected, raw.trim());
  },
};

function hmacHex(secret: string, body: Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  // Both must be same hex length to call timingSafeEqual without
  // throwing.
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch { return false; }
}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); }
  catch { return false; }
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name:    string,
): string | null {
  // Express lowercases header names. Be defensive in case caller
  // passes uppercase.
  const k = name.toLowerCase();
  const v = headers[k] ?? headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  if (typeof v === 'string') return v;
  return null;
}

/**
 * Map an event name out of the request headers, per format. Used
 * for the optional spec.allowedEvents filter.
 */
export function deriveEventName(
  format:  WebhookHmacFormat,
  headers: Record<string, string | string[] | undefined>,
): string {
  if (format === 'github') return pickHeader(headers, 'x-github-event') ?? '';
  if (format === 'gitlab') return pickHeader(headers, 'x-gitlab-event') ?? '';
  return pickHeader(headers, 'x-webhook-event') ?? '';
}
