/**
 * v4.5 Phase 1 — triggerBus tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import type { TriggerBus } from '../../../core/v4/daemon/triggerBus';

let db: Database.Database;
let bus: TriggerBus;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  bus = createTriggerBus({ db });
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('triggerBus.insert', () => {
  it('inserts a new event and returns inserted:true', () => {
    const r = bus.insert({
      source: 'webhook',
      sourceKey: 'wh1',
      idempotencyKey: 'delivery-1',
      payload: { ok: true },
    });
    expect(r.inserted).toBe(true);
    expect(r.id).toBeGreaterThan(0);
  });

  it('deduplicates on (source, idempotencyKey) — second insert returns the same id with inserted:false', () => {
    const r1 = bus.insert({ source: 'webhook', sourceKey: 'wh1', idempotencyKey: 'k', payload: { v: 1 } });
    const r2 = bus.insert({ source: 'webhook', sourceKey: 'wh1', idempotencyKey: 'k', payload: { v: 2 } });
    expect(r1.id).toBe(r2.id);
    expect(r2.inserted).toBe(false);
  });

  it('different (source, idempotencyKey) → distinct rows', () => {
    const r1 = bus.insert({ source: 'webhook', sourceKey: 'wh1', idempotencyKey: 'k', payload: {} });
    const r2 = bus.insert({ source: 'file',    sourceKey: 'f1',  idempotencyKey: 'k', payload: {} });
    expect(r1.id).not.toBe(r2.id);
  });

  it('null idempotencyKey: never dedups', () => {
    const r1 = bus.insert({ source: 'manual', sourceKey: 'm', payload: { i: 1 } });
    const r2 = bus.insert({ source: 'manual', sourceKey: 'm', payload: { i: 2 } });
    expect(r1.id).not.toBe(r2.id);
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
  });
});

describe('triggerBus.claim', () => {
  it('returns null when queue empty', () => {
    expect(bus.claim({ ownerId: 'inst-1' })).toBeNull();
  });

  it('picks the oldest pending event', () => {
    const a = bus.insert({ source: 'manual', sourceKey: 'a', payload: { n: 1 } });
    const b = bus.insert({ source: 'manual', sourceKey: 'b', payload: { n: 2 } });
    void b;
    const claimed = bus.claim({ ownerId: 'inst-1' });
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claimToken).toBeTruthy();
    expect(claimed?.attempts).toBe(1);
  });

  it('respects source filter', () => {
    bus.insert({ source: 'webhook',  sourceKey: 'wh',  payload: {} });
    const f = bus.insert({ source: 'file',     sourceKey: 'f1',  payload: {} });
    const claimed = bus.claim({ ownerId: 'inst-1', source: 'file' });
    expect(claimed?.id).toBe(f.id);
  });

  it('does not return already-claimed events', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    expect(bus.claim({ ownerId: 'inst-1' })).not.toBeNull();
    expect(bus.claim({ ownerId: 'inst-1' })).toBeNull();
  });
});

describe('triggerBus.markDone', () => {
  it('moves event to done with valid claimToken', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    const c = bus.claim({ ownerId: 'inst-1' })!;
    bus.markDone(c.id, c.claimToken);
    const row = bus.get(c.id)!;
    expect(row.status).toBe('done');
    expect(row.completedAt).toBeGreaterThan(0);
  });

  it('ignores invalid claimToken (double-completion guard)', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    const c = bus.claim({ ownerId: 'inst-1' })!;
    bus.markDone(c.id, 'wrong-token');
    expect(bus.get(c.id)!.status).toBe('claimed');
  });
});

describe('triggerBus.markFailed', () => {
  it('returns event to pending below maxAttempts', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    const c = bus.claim({ ownerId: 'inst-1' })!;
    bus.markFailed(c.id, c.claimToken, 'oops', { maxAttempts: 3 });
    expect(bus.get(c.id)!.status).toBe('pending');
    expect(bus.get(c.id)!.lastError).toMatch(/oops/);
  });

  it('moves to dead_letter at maxAttempts', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    // attempt 1
    let c = bus.claim({ ownerId: 'inst-1' })!;
    bus.markFailed(c.id, c.claimToken, 'e1', { maxAttempts: 2 });
    // attempt 2 (hits maxAttempts)
    c = bus.claim({ ownerId: 'inst-1' })!;
    bus.markFailed(c.id, c.claimToken, 'e2', { maxAttempts: 2 });
    expect(bus.get(c.id)!.status).toBe('dead_letter');
  });

  it('truncates very long error messages', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    const c = bus.claim({ ownerId: 'inst-1' })!;
    bus.markFailed(c.id, c.claimToken, 'x'.repeat(2000));
    const row = bus.get(c.id)!;
    expect(row.lastError!.length).toBeLessThanOrEqual(2000);
    expect(row.lastError).toMatch(/x{1024}…?/);
  });
});

describe('triggerBus.release', () => {
  it('returns claimed event to pending', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    const c = bus.claim({ ownerId: 'inst-1' })!;
    bus.release(c.id, c.claimToken);
    expect(bus.get(c.id)!.status).toBe('pending');
    // Next claim picks it up again.
    const c2 = bus.claim({ ownerId: 'inst-2' })!;
    expect(c2.id).toBe(c.id);
  });
});

describe('triggerBus.reclaimExpired', () => {
  it('returns claimed events whose lease elapsed back to pending', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    bus.claim({ ownerId: 'inst-1', leaseMs: 1 })!;
    // Advance "now" past the lease.
    const future = Date.now() + 60_000;
    const r = bus.reclaimExpired(future);
    expect(r.reclaimed).toBe(1);
  });

  it('leaves unexpired claims alone', () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    bus.claim({ ownerId: 'inst-1', leaseMs: 60_000 })!;
    expect(bus.reclaimExpired(Date.now()).reclaimed).toBe(0);
  });

  it.each(['markDone', 'markFailed', 'release', 'renewClaim'] as const)(
    'fences a stale claimant from %s after another bus reclaims the lease',
    (operation) => {
      const busA = createTriggerBus({ db });
      const busB = createTriggerBus({ db });
      const inserted = busA.insert({ source: 'manual', sourceKey: operation, payload: {} });
      const claimA = busA.claim({ ownerId: 'instance-a', leaseMs: 1 })!;

      expect(busB.reclaimExpired(Date.now() + 60_000)).toEqual({ reclaimed: 1 });
      const claimB = busB.claim({ ownerId: 'instance-b', leaseMs: 60_000 })!;
      expect(claimB.id).toBe(inserted.id);
      expect(claimB.claimToken).not.toBe(claimA.claimToken);

      if (operation === 'markDone') busA.markDone(claimA.id, claimA.claimToken);
      if (operation === 'markFailed') busA.markFailed(claimA.id, claimA.claimToken, 'stale failure');
      if (operation === 'release') busA.release(claimA.id, claimA.claimToken);
      if (operation === 'renewClaim') {
        expect(busA.renewClaim(claimA.id, claimA.claimToken, 60_000)).toBe(false);
      }

      expect(busB.get(claimB.id)).toMatchObject({
        status: 'claimed',
        claimOwner: 'instance-b',
        attempts: 2,
      });
      busB.markDone(claimB.id, claimB.claimToken);
      expect(busB.get(claimB.id)?.status).toBe('done');
      busB.markDone(claimB.id, claimB.claimToken);
      expect(busB.get(claimB.id)?.status).toBe('done');
    },
  );

  it('persists the claim fence across independent SQLite connections', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aiden-trigger-fence-'));
    const databasePath = path.join(root, 'daemon.db');
    const dbA = new Database(databasePath);
    const dbB = new Database(databasePath);
    try {
      runMigrations(dbA);
      const busA = createTriggerBus({ db: dbA });
      const busB = createTriggerBus({ db: dbB });
      busA.insert({ source: 'manual', sourceKey: 'cross-connection', payload: {} });
      const claimA = busA.claim({ ownerId: 'process-a', leaseMs: 1 })!;
      expect(busB.reclaimExpired(Date.now() + 60_000)).toEqual({ reclaimed: 1 });
      const claimB = busB.claim({ ownerId: 'process-b', leaseMs: 60_000 })!;

      busA.markDone(claimA.id, claimA.claimToken);
      expect(busB.get(claimB.id)).toMatchObject({
        status: 'claimed',
        claimOwner: 'process-b',
      });
      busB.markDone(claimB.id, claimB.claimToken);
      expect(busB.get(claimB.id)?.status).toBe('done');
    } finally {
      dbB.close();
      dbA.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('triggerBus.deadLetter', () => {
  it('moves event to dead_letter directly', () => {
    const r = bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    bus.deadLetter(r.id, 'over quota');
    expect(bus.get(r.id)!.status).toBe('dead_letter');
    expect(bus.get(r.id)!.lastError).toMatch(/over quota/);
  });
});

describe('triggerBus.stats', () => {
  it('reports counts per status + oldest pending age', async () => {
    bus.insert({ source: 'manual', sourceKey: 'a', payload: {} });
    bus.insert({ source: 'manual', sourceKey: 'b', payload: {} });
    const c = bus.claim({ ownerId: 'inst' })!;
    bus.markDone(c.id, c.claimToken);
    const s = bus.stats();
    expect(s.pending).toBe(1);
    expect(s.claimed).toBe(0);
    expect(s.oldestPendingMs).not.toBeNull();
  });
});
