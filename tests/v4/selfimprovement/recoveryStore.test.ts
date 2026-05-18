/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/selfimprovement/recoveryStore.test.ts — v4.6 Phase 3b.
 *
 * Tests against an in-memory SQLite with v7 applied. Covers:
 *   1. recordFailureOccurrence creates a row for a new signature
 *   2. Same signature again → increments occurrences, updates last_seen_at
 *   3. recordRecovery inserts a report + bumps recovered_count + sets last_recovery_report_id
 *   4. listTopFailures returns rows sorted by occurrences DESC
 *   5. listTopFailures honours limit
 *   6. getBySignature returns full row or null
 *   7. listReportsForSignature returns reports newest-first
 *   8. listForSession filters by session_id
 *   9. clearSignature removes signature + cascades to reports
 *   10. Singleton init/get/reset
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  RecoveryStore,
  initRecoveryStore,
  getRecoveryStore,
  _resetRecoveryStoreForTests,
} from '../../../core/v4/selfimprovement/recoveryStore';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  _resetRecoveryStoreForTests();
});
afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  _resetRecoveryStoreForTests();
});

describe('RecoveryStore — v4.6 Phase 3b', () => {
  it('1. recordFailureOccurrence creates a row for a new signature', () => {
    const store = new RecoveryStore(db);
    const id = store.recordFailureOccurrence({
      signature: 'file_read:not_found:abc123',
      toolName:  'file_read',
      category:  'not_found',
      argsHash:  'abc123',
    });
    expect(id).toBeGreaterThan(0);
    const row = store.getBySignature('file_read:not_found:abc123');
    expect(row).not.toBeNull();
    expect(row?.occurrences).toBe(1);
    expect(row?.recoveredCount).toBe(0);
    expect(row?.argsHash).toBe('abc123');
  });

  it('2. same signature again → increments occurrences', () => {
    const store = new RecoveryStore(db);
    let clock = 1_000;
    const id1 = store.recordFailureOccurrence({
      signature: 'web_search:timeout', toolName: 'web_search', category: 'timeout',
      now: () => clock,
    });
    clock = 2_000;
    const id2 = store.recordFailureOccurrence({
      signature: 'web_search:timeout', toolName: 'web_search', category: 'timeout',
      now: () => clock,
    });
    clock = 3_000;
    store.recordFailureOccurrence({
      signature: 'web_search:timeout', toolName: 'web_search', category: 'timeout',
      now: () => clock,
    });
    expect(id1).toBe(id2);  // same row
    const row = store.getBySignature('web_search:timeout');
    expect(row?.occurrences).toBe(3);
    expect(row?.firstSeenAt).toBe(1_000);
    expect(row?.lastSeenAt).toBe(3_000);
  });

  it('3. recordRecovery inserts a report + bumps recovered_count', () => {
    const store = new RecoveryStore(db);
    const sigId = store.recordFailureOccurrence({
      signature: 's:network', toolName: 's', category: 'network',
    });
    const reportId = store.recordRecovery({
      signatureId:        sigId,
      sessionId:          'sess-test',
      failedAttempts:     2,
      successfulStrategy: 'retry_with_backoff',
      changedParameters:  { backoffMs: 500 },
      notes:              'second retry worked',
    });
    expect(reportId).toBeGreaterThan(0);
    const row = store.getBySignature('s:network');
    expect(row?.recoveredCount).toBe(1);
    expect(row?.lastRecoveryReportId).toBe(reportId);
    const reports = store.listReportsForSignature(sigId);
    expect(reports).toHaveLength(1);
    expect(reports[0].successfulStrategy).toBe('retry_with_backoff');
    expect(reports[0].changedParameters).toBe(JSON.stringify({ backoffMs: 500 }));
    expect(reports[0].notes).toBe('second retry worked');
  });

  it('4. listTopFailures returns rows sorted by occurrences DESC', () => {
    const store = new RecoveryStore(db);
    for (let i = 0; i < 5; i++) {
      store.recordFailureOccurrence({ signature: 'a:network', toolName: 'a', category: 'network' });
    }
    for (let i = 0; i < 2; i++) {
      store.recordFailureOccurrence({ signature: 'b:timeout', toolName: 'b', category: 'timeout' });
    }
    for (let i = 0; i < 10; i++) {
      store.recordFailureOccurrence({ signature: 'c:auth', toolName: 'c', category: 'auth' });
    }
    const rows = store.listTopFailures(10);
    expect(rows.map((r) => r.signature)).toEqual(['c:auth', 'a:network', 'b:timeout']);
    expect(rows[0].occurrences).toBe(10);
  });

  it('5. listTopFailures honours limit', () => {
    const store = new RecoveryStore(db);
    for (let i = 0; i < 5; i++) {
      store.recordFailureOccurrence({
        signature: `t${i}:timeout`, toolName: `t${i}`, category: 'timeout',
      });
    }
    const rows = store.listTopFailures(2);
    expect(rows).toHaveLength(2);
  });

  it('6. getBySignature returns null for unknown signature', () => {
    const store = new RecoveryStore(db);
    expect(store.getBySignature('nope:never:zzz')).toBeNull();
  });

  it('7. listReportsForSignature returns reports newest-first', () => {
    const store = new RecoveryStore(db);
    const sigId = store.recordFailureOccurrence({
      signature: 'a:b', toolName: 'a', category: 'network',
    });
    let clock = 1_000;
    store.recordRecovery({
      signatureId: sigId, failedAttempts: 1, successfulStrategy: 'first', now: () => clock,
    });
    clock = 2_000;
    store.recordRecovery({
      signatureId: sigId, failedAttempts: 1, successfulStrategy: 'second', now: () => clock,
    });
    clock = 3_000;
    store.recordRecovery({
      signatureId: sigId, failedAttempts: 1, successfulStrategy: 'third', now: () => clock,
    });
    const reports = store.listReportsForSignature(sigId);
    expect(reports.map((r) => r.successfulStrategy)).toEqual(['third', 'second', 'first']);
  });

  it('8. listForSession filters by session_id', () => {
    const store = new RecoveryStore(db);
    const sigId = store.recordFailureOccurrence({
      signature: 'a:b', toolName: 'a', category: 'network',
    });
    store.recordRecovery({
      signatureId: sigId, sessionId: 'sess-A', failedAttempts: 1, successfulStrategy: 's1',
    });
    store.recordRecovery({
      signatureId: sigId, sessionId: 'sess-B', failedAttempts: 1, successfulStrategy: 's2',
    });
    store.recordRecovery({
      signatureId: sigId, sessionId: 'sess-A', failedAttempts: 1, successfulStrategy: 's3',
    });
    const sessA = store.listForSession('sess-A');
    expect(sessA).toHaveLength(2);
    for (const r of sessA) expect(r.sessionId).toBe('sess-A');
    expect(store.listForSession('sess-Z')).toEqual([]);
  });

  it('9. clearSignature removes signature + cascades to reports', () => {
    const store = new RecoveryStore(db);
    const sigId = store.recordFailureOccurrence({
      signature: 'gone:other', toolName: 'gone', category: 'other',
    });
    store.recordRecovery({
      signatureId: sigId, failedAttempts: 1, successfulStrategy: 's',
    });
    expect(store.getBySignature('gone:other')).not.toBeNull();
    const ok = store.clearSignature('gone:other');
    expect(ok).toBe(true);
    expect(store.getBySignature('gone:other')).toBeNull();
    expect(store.listReportsForSignature(sigId)).toEqual([]);
  });

  it('10. clearSignature returns false for unknown signature', () => {
    const store = new RecoveryStore(db);
    expect(store.clearSignature('never:exists')).toBe(false);
  });

  it('11. singleton init/get/reset', () => {
    expect(getRecoveryStore()).toBeNull();
    const a = initRecoveryStore({ db });
    expect(getRecoveryStore()).toBe(a);
    _resetRecoveryStoreForTests();
    expect(getRecoveryStore()).toBeNull();
  });

  it('12. listTopFailures joins last recovery strategy from report', () => {
    const store = new RecoveryStore(db);
    const sigId = store.recordFailureOccurrence({
      signature: 'with:recovery', toolName: 'with', category: 'network',
    });
    store.recordRecovery({
      signatureId: sigId, failedAttempts: 3, successfulStrategy: 'rotated_provider',
    });
    const rows = store.listTopFailures(10);
    const r = rows.find((x) => x.signature === 'with:recovery');
    expect(r?.lastRecoveryStrategy).toBe('rotated_provider');
    expect(r?.recoveredCount).toBe(1);
  });
});
