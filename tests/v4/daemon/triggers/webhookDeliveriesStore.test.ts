/**
 * v4.5 Phase 3 — webhookDeliveriesStore tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createWebhookDeliveriesStore } from '../../../../core/v4/daemon/triggers/webhookDeliveriesStore';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
     VALUES ('wh1', 'webhook', 'wh', '{}', 1, ?, ?)`,
  ).run(Date.now(), Date.now());
});

afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('webhookDeliveriesStore', () => {
  it('records + lists deliveries', () => {
    const store = createWebhookDeliveriesStore({ db });
    store.record({
      routeId:           'wh1',
      deliveryId:        'd1',
      signatureVerified: true,
      statusCode:        202,
      responseBody:      '{}',
      clientIp:          '127.0.0.1',
      headers:           { 'content-type': 'application/json' },
      bodyHash:          'abc',
      triggerEventId:    null,
    });
    const list = store.list('wh1');
    expect(list).toHaveLength(1);
    expect(list[0].statusCode).toBe(202);
    expect(list[0].signatureVerified).toBe(true);
  });

  it('selective whitelist: redacts known-sensitive forensic headers, drops unlisted headers entirely', () => {
    const store = createWebhookDeliveriesStore({ db });
    store.record({
      routeId: 'wh1', deliveryId: 'd2', signatureVerified: true,
      statusCode: 202, responseBody: null, clientIp: null,
      headers: {
        'x-hub-signature-256': 'sha256=secret',         // on whitelist + redact list
        'x-gitlab-token':      'gitlab-secret',         // on whitelist + redact list
        'authorization':       'Bearer SUPER',          // NOT on whitelist → dropped
        'content-type':        'application/json',      // on whitelist, NOT sensitive
        'x-github-event':      'push',                  // on whitelist, NOT sensitive
      },
      bodyHash: 'h', triggerEventId: null,
    });
    const row = store.list('wh1')[0];
    const headers = JSON.parse(row.headersJson!);
    // x-gitlab-token IS on the forensic whitelist; value redacted so
    // we know the header was present but can't see the secret.
    expect(headers['x-gitlab-token']).toBe('<redacted>');
    expect(headers['x-hub-signature-256']).toBe('<redacted>');
    // Headers NOT on the whitelist are dropped entirely — including
    // authorization (which we deliberately don't record for forensics).
    expect(headers['authorization']).toBeUndefined();
    // Innocuous whitelisted headers pass through unmodified.
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-github-event']).toBe('push');
  });

  it('truncates response_body > 1KB', () => {
    const store = createWebhookDeliveriesStore({ db });
    store.record({
      routeId: 'wh1', deliveryId: 'd3', signatureVerified: true,
      statusCode: 202, responseBody: 'x'.repeat(2000), clientIp: null,
      headers: {}, bodyHash: 'h', triggerEventId: null,
    });
    const row = store.list('wh1')[0];
    expect(row.responseBody!.length).toBeLessThanOrEqual(1100);
    expect(row.responseBody).toMatch(/…$/);
  });

  it('sweep deletes deliveries older than retention', () => {
    const store = createWebhookDeliveriesStore({ db });
    // Manually insert old + new rows for deterministic comparison.
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO webhook_deliveries
         (route_id, signature_verified, status_code, body_hash, received_at)
       VALUES (?, 1, 202, ?, ?)`,
    ).run('wh1', 'h-old', oldTs);
    store.record({
      routeId: 'wh1', deliveryId: null, signatureVerified: true,
      statusCode: 202, responseBody: null, clientIp: null,
      headers: {}, bodyHash: 'h-new', triggerEventId: null,
    });
    expect(store.list('wh1')).toHaveLength(2);
    const r = store.sweep(7);
    expect(r.deleted).toBe(1);
    expect(store.list('wh1')).toHaveLength(1);
  });

  it('FK cascade — deleting the trigger drops deliveries', () => {
    const store = createWebhookDeliveriesStore({ db });
    store.record({
      routeId: 'wh1', deliveryId: 'd', signatureVerified: true,
      statusCode: 202, responseBody: null, clientIp: null,
      headers: {}, bodyHash: 'h', triggerEventId: null,
    });
    db.prepare('DELETE FROM triggers WHERE id = ?').run('wh1');
    expect(store.list('wh1')).toHaveLength(0);
  });

  it('countForRoute reports total', () => {
    const store = createWebhookDeliveriesStore({ db });
    for (let i = 0; i < 3; i++) {
      store.record({
        routeId: 'wh1', deliveryId: `d${i}`, signatureVerified: true,
        statusCode: 202, responseBody: null, clientIp: null,
        headers: {}, bodyHash: `h${i}`, triggerEventId: null,
      });
    }
    expect(store.countForRoute('wh1')).toBe(3);
  });
});
