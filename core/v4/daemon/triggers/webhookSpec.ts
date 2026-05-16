/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/webhookSpec.ts — v4.5 Phase 3.
 *
 * Typed spec stored in triggers.spec_json for source='webhook'.
 *
 * Secret handling (corrected design):
 *   HMAC verification REQUIRES the raw secret at request time, so
 *   we store it RAW. Daemon.db sits under user-private
 *   %LOCALAPPDATA%/aiden/daemon/ on Windows and is chmod 600 on POSIX
 *   (see db/connection.ts). The raw secret is surfaced to the user
 *   ONLY on creation by `aiden trigger add webhook` with an explicit
 *   "save this now" warning.
 *
 * INSECURE_NO_AUTH sentinel: literal string the user can place in
 * spec.secret to disable HMAC verification entirely. Only usable
 * when the daemon is bound to loopback (127.0.0.1). Phase 3
 * refuses to start a public-bound daemon with any INSECURE_NO_AUTH
 * route configured.
 */

export const INSECURE_NO_AUTH = '__INSECURE_NO_AUTH__';

export type WebhookHmacFormat = 'github' | 'gitlab' | 'generic';

export interface WebhookSpec {
  name:              string;
  /** Raw secret. Required (use INSECURE_NO_AUTH sentinel for loopback-only testing). */
  secret:            string;
  hmacFormat:        WebhookHmacFormat;
  /** Per-format event filter (X-GitHub-Event / X-Gitlab-Event). */
  allowedEvents?:    string[];
  rateLimit:         { perMinute: number };
  maxBodyBytes:      number;
  idempotencyTtlMs:  number;
  /** Phase 3 ships as STUB — accepts + inserts trigger_event with deliveryMode='deliver_only', no agent dispatch. */
  deliverOnly:       boolean;
  /** Phase 5 wire — template rendered with payload for the deliver_only path. */
  promptTemplate?:   string;
  /** Metadata only — actual bind decision is the AIDEN_DAEMON_BIND env var. */
  publicBound:       boolean;
}

export const DEFAULT_WEBHOOK_SPEC: Omit<WebhookSpec, 'name' | 'secret'> = {
  hmacFormat:        'generic',
  rateLimit:         { perMinute: 30 },
  maxBodyBytes:      1_048_576,            // 1 MiB
  idempotencyTtlMs:  60 * 60 * 1000,       // 1 hour
  deliverOnly:       false,
  publicBound:       false,
};

export function parseWebhookSpec(raw: string | Record<string, unknown>): WebhookSpec {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('WebhookSpec: input must be an object');
  }
  const o = obj as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : '';
  if (!name) throw new Error('WebhookSpec: name required');
  const secret = typeof o.secret === 'string' ? o.secret : '';
  if (!secret) throw new Error('WebhookSpec: secret required (use INSECURE_NO_AUTH sentinel for loopback testing)');
  const hmacFormat = sanitizeHmacFormat(o.hmacFormat);
  const rateLimitObj = (o.rateLimit && typeof o.rateLimit === 'object') ? o.rateLimit as Record<string, unknown> : {};
  const perMinute = sanitizeNum(rateLimitObj.perMinute, DEFAULT_WEBHOOK_SPEC.rateLimit.perMinute, 1);
  return {
    name,
    secret,
    hmacFormat,
    allowedEvents:     Array.isArray(o.allowedEvents) ? (o.allowedEvents as string[]).filter((s) => typeof s === 'string') : undefined,
    rateLimit:         { perMinute },
    maxBodyBytes:      sanitizeNum(o.maxBodyBytes, DEFAULT_WEBHOOK_SPEC.maxBodyBytes, 1),
    idempotencyTtlMs:  sanitizeNum(o.idempotencyTtlMs, DEFAULT_WEBHOOK_SPEC.idempotencyTtlMs, 1),
    deliverOnly:       typeof o.deliverOnly === 'boolean' ? o.deliverOnly : DEFAULT_WEBHOOK_SPEC.deliverOnly,
    promptTemplate:    typeof o.promptTemplate === 'string' ? o.promptTemplate : undefined,
    publicBound:       typeof o.publicBound === 'boolean' ? o.publicBound : DEFAULT_WEBHOOK_SPEC.publicBound,
  };
}

function sanitizeHmacFormat(v: unknown): WebhookHmacFormat {
  if (v === 'github' || v === 'gitlab' || v === 'generic') return v;
  return DEFAULT_WEBHOOK_SPEC.hmacFormat;
}

function sanitizeNum(v: unknown, fallback: number, min: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) return fallback;
  return v;
}
