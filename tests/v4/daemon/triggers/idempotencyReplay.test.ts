/**
 * v4.5 Phase 6 — webhook idempotency replay cosmetic fix.
 *
 * The bug: cached body was stamped `deduplicated: false` on the
 * first accept and re-served verbatim on retries — every replay
 * looked like a fresh accept to operators. Fixed by injecting
 * `deduplicated: true` dynamically at retrieval time.
 *
 * Coverage:
 *   1. First POST → accepted with deduplicated:false
 *   2. Replay POST → 202 with deduplicated:true
 *   3. webhook_deliveries logs the replay row
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'node:crypto';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { createIdempotencyStore } from '../../../../core/v4/daemon/idempotencyStore';
import { getResourceRegistry } from '../../../../core/v4/daemon/resourceRegistry';
import { mountWebhookRoutes } from '../../../../core/v4/daemon/triggers/webhook';
import { parseWebhookSpec, DEFAULT_WEBHOOK_SPEC } from '../../../../core/v4/daemon/triggers/webhookSpec';
import type http from 'node:http';

let db: Database.Database;
let server: http.Server;
let port: number;
let triggerId: string;
let secret: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const bus = createIdempotencyStore({ db, sweepIntervalMs: 0 });
  const triggerBus = createTriggerBus({ db });
  const registry = getResourceRegistry();
  triggerId = 'replay-route-1';
  secret = crypto.randomBytes(32).toString('base64url');
  const spec = parseWebhookSpec({
    name: 'replay-test', secret,
    hmacFormat: 'generic',
    rateLimit:    { perMinute: 1000 },
    maxBodyBytes: DEFAULT_WEBHOOK_SPEC.maxBodyBytes,
    idempotencyTtlMs: 60_000,
  });
  db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
              VALUES (?, 'webhook', ?, ?, 1, NULL, 0, ?, ?)`)
    .run(triggerId, spec.name, JSON.stringify(spec), Date.now(), Date.now());
  const app = express();
  mountWebhookRoutes({ app, db, triggerBus, idempotencyStore: bus, resourceRegistry: registry });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  try { db.close(); } catch { /* noop */ }
});

function hmacSign(body: Buffer): string {
  // Generic mode expects bare <hex>; github mode is 'sha256=<hex>'.
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function post(body: Buffer, deliveryId: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/triggers/webhook/${triggerId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': hmacSign(body),
      // Generic webhook idempotency is keyed by X-Request-Id. Using the
      // fallback time bucket here made a replay that crossed a 5s boundary
      // look like a fresh delivery under a loaded aggregate test run.
      'x-request-id':        deliveryId,
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

describe('webhook idempotency replay — deduplicated flag', () => {
  it('first POST → 202 with deduplicated:false', async () => {
    const body = Buffer.from(JSON.stringify({ event: 'first', n: 1 }));
    const r = await post(body, 'delivery-A');
    expect(r.status).toBe(202);
    const parsed = JSON.parse(r.body);
    expect(parsed.status).toBe('accepted');
    expect(parsed.deduplicated).toBe(false);
  });

  it('replay → 202 with deduplicated:true (dynamic injection at retrieval)', async () => {
    const body = Buffer.from(JSON.stringify({ event: 'first', n: 1 }));
    await post(body, 'delivery-B');
    const replay = await post(body, 'delivery-B');
    expect(replay.status).toBe(202);
    const parsed = JSON.parse(replay.body);
    expect(parsed.deduplicated).toBe(true);
  });

  it('webhook_deliveries logs the replay with the corrected body', async () => {
    const body = Buffer.from(JSON.stringify({ event: 'logged', n: 2 }));
    await post(body, 'delivery-C');
    await post(body, 'delivery-C');
    const rows = db.prepare(
      `SELECT response_body, trigger_event_id FROM webhook_deliveries WHERE route_id = ? ORDER BY received_at ASC`,
    ).all(triggerId) as Array<{ response_body: string; trigger_event_id: number | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // First row: trigger_event_id set, deduplicated:false in body.
    expect(rows[0].trigger_event_id).not.toBeNull();
    expect(JSON.parse(rows[0].response_body).deduplicated).toBe(false);
    // Replay row: trigger_event_id null (no new event), deduplicated:true.
    const replayRow = rows[rows.length - 1];
    expect(replayRow.trigger_event_id).toBeNull();
    expect(JSON.parse(replayRow.response_body).deduplicated).toBe(true);
  });
});
