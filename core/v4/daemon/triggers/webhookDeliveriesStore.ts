/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/webhookDeliveriesStore.ts — v4.5 Phase 3.
 *
 * Writer for the `webhook_deliveries` table. Every POST gets a row
 * (verified or not) so operators have a forensic trail.
 *
 * Retention: AIDEN_DAEMON_WEBHOOK_RETENTION_DAYS env var (default 7).
 * Sweep runs on boot + every 24h.
 */

import type { Db } from '../db/connection';

export interface WebhookDelivery {
  id:                 number;
  routeId:            string;
  deliveryId:         string | null;
  signatureVerified:  boolean;
  statusCode:         number;
  responseBody:       string | null;
  clientIp:           string | null;
  headersJson:        string | null;
  bodyHash:           string;
  receivedAt:         number;
  processedAt:        number | null;
  triggerEventId:     number | null;
}

export interface RecordDeliveryInput {
  routeId:           string;
  deliveryId:        string | null;
  signatureVerified: boolean;
  statusCode:        number;
  responseBody:      string | null;
  clientIp:          string | null;
  headers:           Record<string, string | string[] | undefined>;
  bodyHash:          string;
  triggerEventId:    number | null;
}

export interface WebhookDeliveriesStore {
  record(input: RecordDeliveryInput): number;
  list(routeId: string, limit?: number): WebhookDelivery[];
  /** Delete deliveries older than the cutoff. */
  sweep(retentionDays: number, now?: number): { deleted: number };
  /** Diagnostic per-route count. */
  countForRoute(routeId: string): number;
}

interface DeliveryRowSql {
  id:                  number;
  route_id:            string;
  delivery_id:         string | null;
  signature_verified:  number;
  status_code:         number;
  response_body:       string | null;
  client_ip:           string | null;
  headers_json:        string | null;
  body_hash:           string;
  received_at:         number;
  processed_at:        number | null;
  trigger_event_id:    number | null;
}

function rowToTs(r: DeliveryRowSql): WebhookDelivery {
  return {
    id:                r.id,
    routeId:           r.route_id,
    deliveryId:        r.delivery_id,
    signatureVerified: r.signature_verified === 1,
    statusCode:        r.status_code,
    responseBody:      r.response_body,
    clientIp:          r.client_ip,
    headersJson:       r.headers_json,
    bodyHash:          r.body_hash,
    receivedAt:        r.received_at,
    processedAt:       r.processed_at,
    triggerEventId:    r.trigger_event_id,
  };
}

const FORENSIC_HEADER_NAMES: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'x-github-event',
  'x-github-delivery',
  'x-gitlab-event',
  'x-gitlab-token',           // present-flag only — VALUE redacted below
  'x-hub-signature-256',      // present-flag only — VALUE redacted below
  'x-webhook-signature',      // present-flag only — VALUE redacted below
  'x-webhook-event',
  'x-request-id',
  'x-forwarded-for',
]);

const REDACT_HEADERS: ReadonlySet<string> = new Set([
  'x-gitlab-token',
  'x-hub-signature-256',
  'x-webhook-signature',
  'authorization',
  'cookie',
]);

function selectHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (!FORENSIC_HEADER_NAMES.has(lk)) continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value !== 'string') continue;
    out[lk] = REDACT_HEADERS.has(lk) ? '<redacted>' : value;
  }
  return out;
}

export function createWebhookDeliveriesStore(opts: { db: Db }): WebhookDeliveriesStore {
  const db = opts.db;

  return {
    record(input: RecordDeliveryInput): number {
      const now = Date.now();
      const headersJson = JSON.stringify(selectHeaders(input.headers));
      // Truncate response body for forensic storage (1 KB cap).
      const responseBody = input.responseBody != null
        ? input.responseBody.length > 1024 ? input.responseBody.slice(0, 1024) + '…' : input.responseBody
        : null;
      const r = db
        .prepare(
          `INSERT INTO webhook_deliveries
             (route_id, delivery_id, signature_verified, status_code,
              response_body, client_ip, headers_json, body_hash,
              received_at, processed_at, trigger_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.routeId,
          input.deliveryId,
          input.signatureVerified ? 1 : 0,
          input.statusCode,
          responseBody,
          input.clientIp,
          headersJson,
          input.bodyHash,
          now,
          now,
          input.triggerEventId,
        );
      return Number(r.lastInsertRowid);
    },
    list(routeId: string, limit = 100): WebhookDelivery[] {
      const rows = db
        .prepare(
          `SELECT * FROM webhook_deliveries WHERE route_id = ?
            ORDER BY received_at DESC LIMIT ?`,
        )
        .all(routeId, limit) as DeliveryRowSql[];
      return rows.map(rowToTs);
    },
    sweep(retentionDays: number, now?: number): { deleted: number } {
      const cutoff = (now ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1000;
      const r = db
        .prepare(`DELETE FROM webhook_deliveries WHERE received_at < ?`)
        .run(cutoff);
      return { deleted: r.changes };
    },
    countForRoute(routeId: string): number {
      const r = db
        .prepare(`SELECT COUNT(*) AS c FROM webhook_deliveries WHERE route_id = ?`)
        .get(routeId) as { c: number };
      return r.c;
    },
  };
}
