/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/webhook.ts — v4.5 Phase 3.
 *
 * Mounts POST /api/triggers/webhook/:id onto the daemon's Express
 * app. Single dispatch endpoint handles every registered webhook
 * trigger — route looked up by :id at request time.
 *
 * Ordering invariant (every request, every route):
 *
 *   1. Route lookup    → 404 if unknown, 503 if disabled
 *   2. Content-Length  → 413 if > spec.maxBodyBytes
 *      (express.raw enforces a global cap via `limit`)
 *   3. Body read
 *   4. HMAC verify     → 401 if bad
 *   5. Event filter    → 204 No Content if event-name excluded
 *   6. Rate limit      → 429 if over cap (POST-auth so attackers
 *                        can't burn quota)
 *   7. Idempotency     → 200 with cached body if duplicate
 *   8. trigger_events insert → 202 Accepted
 *   9. webhook_deliveries row logged
 *  10. Idempotency cache populated with cached response
 *
 * Per-route stats are recorded in-memory and surfaced via
 * GET /api/triggers/webhook/:id/stats (Phase 3 ships this minimal
 * diagnostic; Phase 6 adds richer surface).
 */

import express from 'express';
import type { Express, Request, Response } from 'express';
import crypto from 'node:crypto';

import type { Db } from '../db/connection';
import type { TriggerBus } from '../triggerBus';
import type { IdempotencyStore } from '../idempotencyStore';
import type { ResourceRegistry } from '../resourceRegistry';
import {
  parseWebhookSpec,
  INSECURE_NO_AUTH,
} from './webhookSpec';
import type { WebhookSpec } from './webhookSpec';
import {
  verifyWebhookSignature,
  deriveEventName,
} from './webhookVerifier';
import { createRateLimiter } from './webhookRateLimit';
import type { RateLimiter } from './webhookRateLimit';
import { deriveIdempotencyKey } from './webhookIdempotency';
import { createWebhookDeliveriesStore } from './webhookDeliveriesStore';
import type { WebhookDeliveriesStore } from './webhookDeliveriesStore';

export interface WebhookRouteStats {
  totalRequests:        number;
  accepted:             number;
  rejectedAuth:         number;
  rejectedRate:         number;
  rejectedSize:         number;
  rejectedFilter:       number;
  duplicates:           number;
  triggerEventsEmitted: number;
  lastError:            string | null;
}

const initialStats: () => WebhookRouteStats = () => ({
  totalRequests:         0,
  accepted:              0,
  rejectedAuth:          0,
  rejectedRate:          0,
  rejectedSize:          0,
  rejectedFilter:        0,
  duplicates:            0,
  triggerEventsEmitted:  0,
  lastError:             null,
});

export interface MountedWebhookRoutes {
  /** Read-only view of per-route stats. */
  getStats(routeId: string): WebhookRouteStats | null;
  /** All known routes. */
  listRoutes(): string[];
  /** Stop accepting new requests (drain). */
  shutdown(): Promise<void>;
  /** Per-route delivery sweep (called by retention timer). */
  sweepDeliveries(retentionDays: number): { deleted: number };
}

export interface MountWebhookRoutesOptions {
  app:               Express;
  db:                Db;
  triggerBus:        TriggerBus;
  idempotencyStore:  IdempotencyStore;
  resourceRegistry:  ResourceRegistry;
  log?:              (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Maximum body across ALL routes — the per-route cap is a tighter check. */
  globalMaxBodyBytes?: number;
}

const noopLog = (_l: 'info' | 'warn' | 'error', _m: string): void => undefined;

export function mountWebhookRoutes(
  opts: MountWebhookRoutesOptions,
): MountedWebhookRoutes {
  const log = opts.log ?? noopLog;
  const rateLimiter: RateLimiter = createRateLimiter();
  const deliveries: WebhookDeliveriesStore = createWebhookDeliveriesStore({ db: opts.db });

  const statsByRoute: Map<string, WebhookRouteStats> = new Map();
  let shuttingDown = false;

  // Register as a global resource so shutdown drain can reach us.
  const resourceId = opts.resourceRegistry.register({
    kind:  'webhook_server',
    owner: 'global',
    close: async () => { shuttingDown = true; },
  });
  void resourceId;

  // express.raw — give us the raw bytes so we can compute the HMAC.
  // `limit` is the global guard; per-route maxBodyBytes is the
  // primary check (we check after parsing the route).
  const globalLimit = opts.globalMaxBodyBytes ?? 1_048_576;
  const rawParser = express.raw({ type: '*/*', limit: globalLimit });

  opts.app.post('/api/triggers/webhook/:id', rawParser, (req: Request, res: Response) => {
    void handleWebhookRequest({
      req, res, opts, log, rateLimiter, deliveries,
      statsByRoute, shuttingDown,
    });
  });

  // GET /stats — per-route diagnostic.
  opts.app.get('/api/triggers/webhook/:id/stats', (req: Request, res: Response) => {
    const routeId = String(req.params.id);
    const s = statsByRoute.get(routeId);
    if (!s) {
      res.status(404).json({ error: 'unknown route or no traffic yet' });
      return;
    }
    res.status(200).json(s);
  });

  return {
    getStats(routeId: string) {
      return statsByRoute.get(routeId) ?? null;
    },
    listRoutes(): string[] {
      return [...statsByRoute.keys()];
    },
    shutdown(): Promise<void> {
      shuttingDown = true;
      return Promise.resolve();
    },
    sweepDeliveries(retentionDays: number) {
      return deliveries.sweep(retentionDays);
    },
  };
}

// ── per-request handler ─────────────────────────────────────────────────────

interface HandlerCtx {
  req:              Request;
  res:              Response;
  opts:             MountWebhookRoutesOptions;
  log:              (level: 'info' | 'warn' | 'error', msg: string) => void;
  rateLimiter:      RateLimiter;
  deliveries:       WebhookDeliveriesStore;
  statsByRoute:     Map<string, WebhookRouteStats>;
  shuttingDown:     boolean;
}

async function handleWebhookRequest(ctx: HandlerCtx): Promise<void> {
  const { req, res, opts, log, rateLimiter, deliveries, statsByRoute, shuttingDown } = ctx;
  const routeId = String(req.params.id);
  const stats = (() => {
    let s = statsByRoute.get(routeId);
    if (!s) { s = initialStats(); statsByRoute.set(routeId, s); }
    return s;
  })();
  stats.totalRequests += 1;

  if (shuttingDown) {
    res.status(503).json({ error: 'daemon shutting down' });
    return;
  }

  // Step 1: load spec from DB.
  const spec = loadSpec(opts.db, routeId);
  if (!spec) {
    res.status(404).json({ error: 'unknown route' });
    return;
  }
  if (!spec.enabled) {
    res.status(503).json({ error: 'route disabled' });
    return;
  }

  const clientIp: string | null = typeof req.ip === 'string'
    ? req.ip
    : (typeof req.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : null);
  const bodyBuf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const bodyHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');

  // Step 2: per-route size cap.
  if (bodyBuf.length > spec.spec.maxBodyBytes) {
    stats.rejectedSize += 1;
    const responseBody = JSON.stringify({ error: 'payload too large' });
    res.status(413).type('application/json').send(responseBody);
    deliveries.record({
      routeId, deliveryId: null, signatureVerified: false,
      statusCode: 413, responseBody, clientIp,
      headers: req.headers as Record<string, string | string[] | undefined>,
      bodyHash, triggerEventId: null,
    });
    return;
  }

  // Step 3: HMAC verify.
  const verified = verifyWebhookSignature({
    format:  spec.spec.hmacFormat,
    secret:  spec.spec.secret,
    body:    bodyBuf,
    headers: req.headers as Record<string, string | string[] | undefined>,
  });
  if (!verified) {
    stats.rejectedAuth += 1;
    const responseBody = JSON.stringify({ error: 'invalid signature' });
    res.status(401).type('application/json').send(responseBody);
    deliveries.record({
      routeId, deliveryId: null, signatureVerified: false,
      statusCode: 401, responseBody, clientIp,
      headers: req.headers as Record<string, string | string[] | undefined>,
      bodyHash, triggerEventId: null,
    });
    return;
  }

  // Step 4: event filter.
  if (spec.spec.allowedEvents && spec.spec.allowedEvents.length > 0) {
    const ev = deriveEventName(spec.spec.hmacFormat, req.headers as Record<string, string | string[] | undefined>);
    if (!spec.spec.allowedEvents.includes(ev)) {
      stats.rejectedFilter += 1;
      res.status(204).end();
      return;
    }
  }

  // Step 5: rate limit (POST-auth).
  if (!rateLimiter.allow(routeId, spec.spec.rateLimit.perMinute)) {
    stats.rejectedRate += 1;
    const responseBody = JSON.stringify({ error: 'rate limit exceeded' });
    res.status(429).type('application/json').send(responseBody);
    deliveries.record({
      routeId, deliveryId: null, signatureVerified: true,
      statusCode: 429, responseBody, clientIp,
      headers: req.headers as Record<string, string | string[] | undefined>,
      bodyHash, triggerEventId: null,
    });
    return;
  }

  // Step 6: idempotency check.
  const idemKey = deriveIdempotencyKey(
    routeId,
    spec.spec.hmacFormat,
    bodyBuf,
    req.headers as Record<string, string | string[] | undefined>,
  );
  const cached = opts.idempotencyStore.get('webhook', idemKey);
  if (cached) {
    stats.duplicates += 1;
    res.status(cached.statusCode).type('application/json').send(cached.responseJson);
    return;
  }

  // Step 7: insert trigger_event + record delivery.
  try {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(bodyBuf.toString('utf-8')) as Record<string, unknown>; }
    catch { payload = { _raw: bodyBuf.toString('base64'), _format: 'base64' }; }

    const event = deriveEventName(spec.spec.hmacFormat, req.headers as Record<string, string | string[] | undefined>);
    const deliveryMode = spec.spec.deliverOnly ? 'deliver_only' : 'agent';

    const inserted = opts.triggerBus.insert({
      source:         'webhook',
      sourceKey:      routeId,
      idempotencyKey: idemKey,
      payload:        {
        headers:      selectHeadersForPayload(req.headers as Record<string, string | string[] | undefined>),
        event,
        body:         payload,
        deliveryMode,
      },
    });
    stats.triggerEventsEmitted += 1;
    stats.accepted += 1;

    const responseBody = JSON.stringify({
      status:       'accepted',
      event_id:     inserted.id,
      deduplicated: !inserted.inserted,
      deliveryMode,
    });
    res.status(202).type('application/json').send(responseBody);

    // Cache the response for retries within the idempotency TTL.
    opts.idempotencyStore.set(
      'webhook',
      idemKey,
      null,
      { responseJson: responseBody, statusCode: 202 },
      spec.spec.idempotencyTtlMs,
    );

    deliveries.record({
      routeId,
      deliveryId:        spec.spec.hmacFormat === 'github'
        ? (pickHeaderStr(req.headers as Record<string, string | string[] | undefined>, 'x-github-delivery') ?? null)
        : null,
      signatureVerified: true,
      statusCode:        202,
      responseBody,
      clientIp,
      headers:           req.headers as Record<string, string | string[] | undefined>,
      bodyHash,
      triggerEventId:    inserted.id,
    });

    if (spec.spec.deliverOnly) {
      log('info', `[webhook] deliver_only stub for ${routeId} — Phase 5 will dispatch via channel target`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stats.lastError = msg;
    log('error', `[webhook] handler error for ${routeId}: ${msg}`);
    const responseBody = JSON.stringify({ error: 'internal error' });
    res.status(500).type('application/json').send(responseBody);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface LoadedRoute {
  enabled: boolean;
  spec:    WebhookSpec;
}

function loadSpec(db: Db, routeId: string): LoadedRoute | null {
  const row = db
    .prepare(`SELECT enabled, spec_json FROM triggers WHERE id = ? AND source = 'webhook'`)
    .get(routeId) as { enabled: number; spec_json: string } | undefined;
  if (!row) return null;
  try {
    const spec = parseWebhookSpec(row.spec_json);
    return { enabled: row.enabled === 1, spec };
  } catch {
    return null;
  }
}

function selectHeadersForPayload(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  // Same selective subset as the deliveries store, plus event names
  // so the agent payload includes what triggered it.
  const out: Record<string, string> = {};
  const want = new Set([
    'content-type', 'user-agent',
    'x-github-event', 'x-github-delivery',
    'x-gitlab-event',
    'x-webhook-event',
    'x-request-id',
    'x-forwarded-for',
  ]);
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (!want.has(lk)) continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === 'string') out[lk] = value;
  }
  return out;
}

function pickHeaderStr(
  headers: Record<string, string | string[] | undefined>,
  name:    string,
): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  if (typeof v === 'string') return v;
  return null;
}

/**
 * Public-bind guard — refuses to start a daemon bound to a non-
 * loopback address when (a) any registered webhook route uses the
 * INSECURE_NO_AUTH sentinel OR (b) AIDEN_API_KEY is unset.
 *
 * Called from bootstrap BEFORE the HTTP listener binds.
 */
export function assertSafeBind(opts: {
  bindHost:        string;
  apiKeyConfigured: boolean;
  db:              Db;
  log:             (level: 'info' | 'warn' | 'error', msg: string) => void;
}): void {
  if (opts.bindHost === '127.0.0.1' || opts.bindHost === 'localhost' || opts.bindHost === '::1') {
    return;
  }
  if (!opts.apiKeyConfigured) {
    const msg =
      `[daemon] AIDEN_DAEMON_BIND=${opts.bindHost} requires AIDEN_API_KEY to be set. ` +
      `Refusing to start — public bind without a bearer token would expose ` +
      `/api/chat, /v1/*, and /api/scheduler/* unauthenticated. ` +
      `Set AIDEN_API_KEY or revert to AIDEN_DAEMON_BIND=127.0.0.1.`;
    opts.log('error', msg);
    throw new Error(msg);
  }
  // Look up any INSECURE_NO_AUTH webhook routes — REFUSE.
  const rows = opts.db
    .prepare(`SELECT id, name, spec_json FROM triggers WHERE source = 'webhook' AND enabled = 1`)
    .all() as Array<{ id: string; name: string; spec_json: string }>;
  for (const r of rows) {
    try {
      const spec = parseWebhookSpec(r.spec_json);
      if (spec.secret === INSECURE_NO_AUTH) {
        const msg =
          `[daemon] webhook route '${r.name}' (${r.id}) uses the INSECURE_NO_AUTH ` +
          `sentinel which is only valid on loopback. Daemon is bound to ` +
          `${opts.bindHost}; refusing to start. Disable the route or set a real secret.`;
        opts.log('error', msg);
        throw new Error(msg);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('INSECURE_NO_AUTH')) throw e;
      // Bad spec — let the request-time loadSpec handle it.
    }
  }
}
