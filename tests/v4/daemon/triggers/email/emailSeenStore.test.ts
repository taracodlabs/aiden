/**
 * v4.5 Phase 4a — emailSeenStore tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../../core/v4/daemon/db/migrations';
import { createEmailSeenStore } from '../../../../../core/v4/daemon/triggers/email/emailSeenStore';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
     VALUES ('e1', 'email', 'e', '{}', 1, ?, ?)`,
  ).run(Date.now(), Date.now());
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('emailSeenStore', () => {
  it('record inserts a new row and returns id', () => {
    const store = createEmailSeenStore({ db });
    const id = store.record({
      routeId: 'e1', mailbox: 'INBOX', uidValidity: 100, uid: 42,
      messageId: '<msg-1@example.com>', fromAddress: 'alice@example.com',
      subject: 'hi', receivedAt: Date.now(),
      triggerEventId: null, status: 'processed',
    });
    expect(id).toBeGreaterThan(0);
  });

  it('UNIQUE on (route_id, uid_validity, uid) — second insert returns same row', () => {
    const store = createEmailSeenStore({ db });
    const a = store.record({
      routeId: 'e1', mailbox: 'INBOX', uidValidity: 100, uid: 7,
      messageId: null, fromAddress: null, subject: null,
      receivedAt: Date.now(), triggerEventId: null, status: 'processed',
    });
    const b = store.record({
      routeId: 'e1', mailbox: 'INBOX', uidValidity: 100, uid: 7,
      messageId: null, fromAddress: null, subject: null,
      receivedAt: Date.now(), triggerEventId: null, status: 'failed',
    });
    expect(a).toBe(b);
  });

  it('UIDVALIDITY change → distinct row', () => {
    const store = createEmailSeenStore({ db });
    const a = store.record({
      routeId: 'e1', mailbox: 'INBOX', uidValidity: 100, uid: 1,
      messageId: null, fromAddress: null, subject: null,
      receivedAt: Date.now(), triggerEventId: null, status: 'processed',
    });
    const b = store.record({
      routeId: 'e1', mailbox: 'INBOX', uidValidity: 101, uid: 1,    // UIDVALIDITY changed
      messageId: null, fromAddress: null, subject: null,
      receivedAt: Date.now(), triggerEventId: null, status: 'processed',
    });
    expect(a).not.toBe(b);
  });

  it('FK cascade — deleting trigger removes email_seen rows', () => {
    const store = createEmailSeenStore({ db });
    store.record({
      routeId: 'e1', mailbox: 'INBOX', uidValidity: 1, uid: 1,
      messageId: null, fromAddress: null, subject: null,
      receivedAt: Date.now(), triggerEventId: null, status: 'processed',
    });
    db.prepare('DELETE FROM triggers WHERE id = ?').run('e1');
    expect(store.countForRoute('e1')).toBe(0);
  });

  it('isMessageIdSeen returns true after record', () => {
    const store = createEmailSeenStore({ db });
    store.record({
      routeId: 'e1', mailbox: 'INBOX', uidValidity: 1, uid: 1,
      messageId: '<unique@example.com>', fromAddress: null, subject: null,
      receivedAt: Date.now(), triggerEventId: null, status: 'processed',
    });
    expect(store.isMessageIdSeen('<unique@example.com>')).toBe(true);
    expect(store.isMessageIdSeen('<other@example.com>')).toBe(false);
  });

  it('sweep deletes rows older than retention', () => {
    const store = createEmailSeenStore({ db });
    const oldTs = Date.now() - 31 * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO email_seen (route_id, mailbox, uid_validity, uid, received_at, status)
       VALUES ('e1','INBOX',1,99,?,'processed')`,
    ).run(oldTs);
    store.record({
      routeId: 'e1', mailbox: 'INBOX', uidValidity: 1, uid: 100,
      messageId: null, fromAddress: null, subject: null,
      receivedAt: Date.now(), triggerEventId: null, status: 'processed',
    });
    expect(store.countForRoute('e1')).toBe(2);
    const r = store.sweep(30);
    expect(r.deleted).toBe(1);
    expect(store.countForRoute('e1')).toBe(1);
  });
});
