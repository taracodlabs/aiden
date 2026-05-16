/**
 * v4.5 Phase 3 — webhook HTTP integration tests.
 *
 * Uses supertest against a fresh Express app to exercise the full
 * request lifecycle (Content-Length → body → HMAC → rate-limit →
 * idempotency → trigger_event → delivery log).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { createIdempotencyStore } from '../../../../core/v4/daemon/idempotencyStore';
import {
  createResourceRegistry,
  _resetResourceRegistryForTests,
} from '../../../../core/v4/daemon/resourceRegistry';
import {
  mountWebhookRoutes,
  assertSafeBind,
} from '../../../../core/v4/daemon/triggers/webhook';
import {
  INSECURE_NO_AUTH,
  parseWebhookSpec,
} from '../../../../core/v4/daemon/triggers/webhookSpec';

const SECRET = 'top-secret-shh';

function hmacHex(secret: string, body: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

let db: Database.Database;
let app: Express;
let triggerBus: ReturnType<typeof createTriggerBus>;
let idemStore: ReturnType<typeof createIdempotencyStore>;
let registry: ReturnType<typeof createResourceRegistry>;

function insertWebhookTrigger(opts: {
  id:       string;
  spec:     Parameters<typeof parseWebhookSpec>[0];
  enabled?: boolean;
}): void {
  const now = Date.now();
  const spec = parseWebhookSpec(opts.spec);
  db.prepare(
    `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
     VALUES (?, 'webhook', ?, ?, ?, ?, ?)`,
  ).run(opts.id, spec.name, JSON.stringify(spec), opts.enabled === false ? 0 : 1, now, now);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  _resetResourceRegistryForTests();
  app = express();
  triggerBus = createTriggerBus({ db });
  idemStore = createIdempotencyStore({ db, sweepIntervalMs: 0 });
  registry = createResourceRegistry();
  mountWebhookRoutes({
    app, db, triggerBus, idempotencyStore: idemStore, resourceRegistry: registry,
  });
});

afterEach(() => {
  idemStore.close();
  try { db.close(); } catch { /* noop */ }
});

describe('POST /api/triggers/webhook/:id — unknown route', () => {
  it('returns 404 when no triggers row matches', async () => {
    const res = await request(app).post('/api/triggers/webhook/nope').send({});
    expect(res.status).toBe(404);
  });
});

describe('POST /api/triggers/webhook/:id — disabled', () => {
  it('returns 503 when enabled=0', async () => {
    insertWebhookTrigger({ id: 'w1', spec: { name: 'w', secret: SECRET }, enabled: false });
    const res = await request(app).post('/api/triggers/webhook/w1').send({});
    expect(res.status).toBe(503);
  });
});

describe('POST /api/triggers/webhook/:id — generic HMAC', () => {
  beforeEach(() => {
    insertWebhookTrigger({
      id: 'w1',
      spec: { name: 'w', secret: SECRET, hmacFormat: 'generic' },
    });
  });

  it('202 on valid signature + dedups on retry', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const sig = hmacHex(SECRET, body);
    const r1 = await request(app)
      .post('/api/triggers/webhook/w1')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sig)
      .set('X-Request-Id', 'req-1')
      .send(body);
    expect(r1.status).toBe(202);
    expect(r1.body.status).toBe('accepted');
    expect(typeof r1.body.event_id).toBe('number');
    // Retry — idempotency hit returns the cached body.
    const r2 = await request(app)
      .post('/api/triggers/webhook/w1')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sig)
      .set('X-Request-Id', 'req-1')
      .send(body);
    expect(r2.status).toBe(202);
    expect(r2.body.event_id).toBe(r1.body.event_id);
  });

  it('401 on bad signature', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const res = await request(app)
      .post('/api/triggers/webhook/w1')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', '0'.repeat(64))
      .send(body);
    expect(res.status).toBe(401);
  });

  it('401 when no signature header sent', async () => {
    const res = await request(app)
      .post('/api/triggers/webhook/w1')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/triggers/webhook/:id — github HMAC', () => {
  it('202 on valid X-Hub-Signature-256', async () => {
    insertWebhookTrigger({
      id: 'gh',
      spec: { name: 'gh', secret: SECRET, hmacFormat: 'github' },
    });
    const body = JSON.stringify({ pull_request: { number: 1 } });
    const sig = `sha256=${hmacHex(SECRET, body)}`;
    const res = await request(app)
      .post('/api/triggers/webhook/gh')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sig)
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'gh-delivery-1')
      .send(body);
    expect(res.status).toBe(202);
  });
});

describe('POST /api/triggers/webhook/:id — gitlab', () => {
  it('202 on matching X-Gitlab-Token', async () => {
    insertWebhookTrigger({
      id: 'gl',
      spec: { name: 'gl', secret: SECRET, hmacFormat: 'gitlab' },
    });
    const res = await request(app)
      .post('/api/triggers/webhook/gl')
      .set('Content-Type', 'application/json')
      .set('X-Gitlab-Token', SECRET)
      .set('X-Gitlab-Event', 'Push Hook')
      .set('X-Request-Id', 'gl-req-1')
      .send(JSON.stringify({ ref: 'main' }));
    expect(res.status).toBe(202);
  });
});

describe('POST /api/triggers/webhook/:id — event filter', () => {
  it('204 when event not in allowedEvents', async () => {
    insertWebhookTrigger({
      id: 'gh',
      spec: { name: 'gh', secret: SECRET, hmacFormat: 'github', allowedEvents: ['push'] },
    });
    const body = JSON.stringify({});
    const sig = `sha256=${hmacHex(SECRET, body)}`;
    const res = await request(app)
      .post('/api/triggers/webhook/gh')
      .set('X-Hub-Signature-256', sig)
      .set('X-GitHub-Event', 'pull_request')
      .send(body);
    expect(res.status).toBe(204);
  });

  it('202 when event in allowedEvents', async () => {
    insertWebhookTrigger({
      id: 'gh',
      spec: { name: 'gh', secret: SECRET, hmacFormat: 'github', allowedEvents: ['push'] },
    });
    const body = JSON.stringify({});
    const sig = `sha256=${hmacHex(SECRET, body)}`;
    const res = await request(app)
      .post('/api/triggers/webhook/gh')
      .set('X-Hub-Signature-256', sig)
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'd-allowed')
      .send(body);
    expect(res.status).toBe(202);
  });
});

describe('POST /api/triggers/webhook/:id — rate limit (post-auth)', () => {
  it('429 after exceeding perMinute, but only counts authed requests', async () => {
    insertWebhookTrigger({
      id: 'rl',
      spec: { name: 'rl', secret: SECRET, hmacFormat: 'generic', rateLimit: { perMinute: 2 } },
    });
    // 3 unauth requests — should NOT burn quota (all 401).
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post('/api/triggers/webhook/rl')
        .set('X-Webhook-Signature', '0'.repeat(64))
        .send('{}');
      expect(r.status).toBe(401);
    }
    // Now send 3 valid — first 2 accepted, 3rd hits 429.
    for (let i = 0; i < 3; i++) {
      const body = JSON.stringify({ i });
      const sig = hmacHex(SECRET, body);
      const r = await request(app)
        .post('/api/triggers/webhook/rl')
        .set('Content-Type', 'application/json')
        .set('X-Webhook-Signature', sig)
        .set('X-Request-Id', `req-${i}`)
        .send(body);
      if (i < 2) expect(r.status).toBe(202);
      else       expect(r.status).toBe(429);
    }
  });
});

describe('POST /api/triggers/webhook/:id — payload too large', () => {
  it('413 when body exceeds spec.maxBodyBytes', async () => {
    insertWebhookTrigger({
      id: 'big',
      spec: { name: 'big', secret: SECRET, hmacFormat: 'generic', maxBodyBytes: 32 },
    });
    const body = 'x'.repeat(100);
    const sig = hmacHex(SECRET, body);
    const r = await request(app)
      .post('/api/triggers/webhook/big')
      .set('Content-Type', 'text/plain')
      .set('X-Webhook-Signature', sig)
      .send(body);
    expect(r.status).toBe(413);
  });
});

describe('POST /api/triggers/webhook/:id — INSECURE_NO_AUTH', () => {
  it('accepts without signature when secret is the sentinel', async () => {
    insertWebhookTrigger({
      id: 'open',
      spec: { name: 'open', secret: INSECURE_NO_AUTH, hmacFormat: 'generic' },
    });
    const res = await request(app)
      .post('/api/triggers/webhook/open')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'no-auth-1')
      .send('{}');
    expect(res.status).toBe(202);
  });
});

describe('deliver_only stub', () => {
  it('returns 202 with deliveryMode=deliver_only; trigger_event still inserted', async () => {
    insertWebhookTrigger({
      id: 'do',
      spec: { name: 'do', secret: SECRET, hmacFormat: 'generic', deliverOnly: true },
    });
    const body = JSON.stringify({ x: 1 });
    const sig = hmacHex(SECRET, body);
    const res = await request(app)
      .post('/api/triggers/webhook/do')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sig)
      .set('X-Request-Id', 'do-1')
      .send(body);
    expect(res.status).toBe(202);
    expect(res.body.deliveryMode).toBe('deliver_only');
    expect(triggerBus.stats().pending).toBe(1);
  });
});

describe('GET /api/triggers/webhook/:id/stats', () => {
  it('reports per-route stats after traffic', async () => {
    insertWebhookTrigger({ id: 's', spec: { name: 's', secret: SECRET, hmacFormat: 'generic' } });
    const body = JSON.stringify({});
    await request(app)
      .post('/api/triggers/webhook/s')
      .set('X-Webhook-Signature', hmacHex(SECRET, body))
      .set('X-Request-Id', 'stat-1')
      .send(body);
    const res = await request(app).get('/api/triggers/webhook/s/stats');
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.triggerEventsEmitted).toBe(1);
  });
});

describe('assertSafeBind', () => {
  it('no-op on 127.0.0.1', () => {
    expect(() => assertSafeBind({
      bindHost: '127.0.0.1', apiKeyConfigured: false, db, log: () => undefined,
    })).not.toThrow();
  });

  it('refuses public bind without AIDEN_API_KEY', () => {
    expect(() => assertSafeBind({
      bindHost: '0.0.0.0', apiKeyConfigured: false, db, log: () => undefined,
    })).toThrow(/AIDEN_API_KEY/);
  });

  it('refuses public bind when an INSECURE_NO_AUTH webhook is registered', () => {
    insertWebhookTrigger({ id: 'open', spec: { name: 'open', secret: INSECURE_NO_AUTH } });
    expect(() => assertSafeBind({
      bindHost: '0.0.0.0', apiKeyConfigured: true, db, log: () => undefined,
    })).toThrow(/INSECURE_NO_AUTH/);
  });

  it('allows public bind when API key set and no insecure routes', () => {
    insertWebhookTrigger({ id: 'safe', spec: { name: 'safe', secret: SECRET } });
    expect(() => assertSafeBind({
      bindHost: '0.0.0.0', apiKeyConfigured: true, db, log: () => undefined,
    })).not.toThrow();
  });
});
