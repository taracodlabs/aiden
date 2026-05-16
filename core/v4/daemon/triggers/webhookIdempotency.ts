/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/webhookIdempotency.ts — v4.5 Phase 3.
 *
 * Key derivation for the L1/L2 idempotency cache. Phase 1's
 * `idempotencyStore` does the actual caching; this module just
 * computes the key per format.
 *
 * Priority order:
 *   github  → X-GitHub-Delivery header
 *   gitlab  → X-Gitlab-Event + X-Request-Id (or X-Gitlab-Event alone)
 *   any     → X-Request-Id
 *   fallback→ sha256(routeId + body + 5_000ms_bucket) — defeats burst
 *             retries while still letting deliberate re-posts through
 *             a few seconds apart
 */

import crypto from 'node:crypto';
import type { WebhookHmacFormat } from './webhookSpec';

export function deriveIdempotencyKey(
  routeId: string,
  format:  WebhookHmacFormat,
  body:    Buffer,
  headers: Record<string, string | string[] | undefined>,
  now?:    number,
): string {
  if (format === 'github') {
    const id = pickHeader(headers, 'x-github-delivery');
    if (id) return `gh:${id}`;
  }
  if (format === 'gitlab') {
    const event = pickHeader(headers, 'x-gitlab-event');
    const reqId = pickHeader(headers, 'x-request-id');
    if (event && reqId) return `gl:${event}:${reqId}`;
    if (event) return `gl:${event}:${shortHash(routeId, body, now)}`;
  }
  const reqId = pickHeader(headers, 'x-request-id');
  if (reqId) return `gen:${reqId}`;
  return `sha:${shortHash(routeId, body, now)}`;
}

function shortHash(routeId: string, body: Buffer, now?: number): string {
  const bucket = Math.floor((now ?? Date.now()) / 5000);
  const h = crypto.createHash('sha256');
  h.update(routeId);
  h.update('|');
  h.update(body);
  h.update('|');
  h.update(String(bucket));
  return h.digest('hex').slice(0, 32);
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name:    string,
): string | null {
  const k = name.toLowerCase();
  // Express middleware lowercases header keys, but unit tests + ad-hoc
  // callers may pass mixed-case. Scan with a lowercase compare.
  for (const [hk, v] of Object.entries(headers)) {
    if (hk.toLowerCase() !== k) continue;
    if (Array.isArray(v)) return v[0] ?? null;
    if (typeof v === 'string') return v;
    return null;
  }
  return null;
}
