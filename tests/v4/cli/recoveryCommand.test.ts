/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/recoveryCommand.test.ts — v4.6 Phase 3b.
 *
 * Tests the /recovery slash command surface against a real in-memory
 * RecoveryStore. Verifies list / show / clear sub-actions + empty-
 * state messaging.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  initRecoveryStore,
  _resetRecoveryStoreForTests,
} from '../../../core/v4/selfimprovement/recoveryStore';
import { recovery } from '../../../cli/v4/commands/recovery';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  _resetRecoveryStoreForTests();
  initRecoveryStore({ db });
});
afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  _resetRecoveryStoreForTests();
});

/** Minimal SlashCommandContext stub — captures every display write. */
function mkCtx(args: string[]) {
  const out: string[] = [];
  const errs: string[] = [];
  const display = {
    write:      vi.fn((s: string) => { out.push(s); }),
    dim:        vi.fn((s: string) => { out.push('[dim]' + s); }),
    printError: vi.fn((m: string, ...rest: string[]) => { errs.push([m, ...rest].join(' ')); }),
  };
  return {
    args,
    display: display as never,
    config:  undefined as never,
    out,
    errs,
  };
}

describe('/recovery command — v4.6 Phase 3b', () => {
  it('list: empty state prints helpful message', async () => {
    const ctx = mkCtx(['list']);
    await recovery.handler(ctx as never);
    expect(ctx.out.join('')).toMatch(/No recurring failures recorded yet/);
  });

  it('list: returns rows sorted by occurrences DESC', async () => {
    // Seed three signatures with varying occurrence counts.
    const { RecoveryStore } = await import('../../../core/v4/selfimprovement/recoveryStore');
    const store = new RecoveryStore(db);
    for (let i = 0; i < 5; i++) {
      store.recordFailureOccurrence({ signature: 'low:network', toolName: 'low', category: 'network' });
    }
    for (let i = 0; i < 12; i++) {
      store.recordFailureOccurrence({ signature: 'high:timeout', toolName: 'high', category: 'timeout' });
    }
    for (let i = 0; i < 3; i++) {
      store.recordFailureOccurrence({ signature: 'mid:auth', toolName: 'mid', category: 'auth' });
    }
    const ctx = mkCtx(['list']);
    await recovery.handler(ctx as never);
    const text = ctx.out.join('');
    // Header + 3 rows + footer.
    expect(text).toMatch(/signature\s+occur\s+recov\s+last_strategy/);
    expect(text).toMatch(/high:timeout/);
    expect(text).toMatch(/low:network/);
    expect(text).toMatch(/mid:auth/);
    // Order: high (12) before low (5) before mid (3) by occurrences DESC.
    const hi = text.indexOf('high:timeout');
    const mi = text.indexOf('mid:auth');
    const lo = text.indexOf('low:network');
    expect(hi).toBeLessThan(lo);
    expect(lo).toBeLessThan(mi);
    expect(text).toMatch(/3 signatures shown/);
  });

  it('list with limit caps output', async () => {
    const { RecoveryStore } = await import('../../../core/v4/selfimprovement/recoveryStore');
    const store = new RecoveryStore(db);
    for (let i = 0; i < 5; i++) {
      store.recordFailureOccurrence({
        signature: `t${i}:timeout`, toolName: `t${i}`, category: 'timeout',
      });
    }
    const ctx = mkCtx(['list', '2']);
    await recovery.handler(ctx as never);
    expect(ctx.out.join('')).toMatch(/2 signatures shown/);
  });

  it('show: prints signature details + recovery reports', async () => {
    const { RecoveryStore } = await import('../../../core/v4/selfimprovement/recoveryStore');
    const store = new RecoveryStore(db);
    const sigId = store.recordFailureOccurrence({
      signature: 'detail:permission', toolName: 'detail', category: 'permission',
    });
    store.recordRecovery({
      signatureId: sigId, failedAttempts: 2,
      successfulStrategy: 'after_chmod', notes: 'operator unblocked the path',
    });
    const ctx = mkCtx(['show', 'detail:permission']);
    await recovery.handler(ctx as never);
    const text = ctx.out.join('');
    expect(text).toMatch(/signature:\s+detail:permission/);
    expect(text).toMatch(/tool_name:\s+detail/);
    expect(text).toMatch(/failure_category:\s+permission/);
    expect(text).toMatch(/recovered_count:\s+1/);
    expect(text).toMatch(/strategy=after_chmod/);
    expect(text).toMatch(/operator unblocked the path/);
  });

  it('show: unknown signature prints error', async () => {
    const ctx = mkCtx(['show', 'never:exists']);
    await recovery.handler(ctx as never);
    expect(ctx.errs.join(' ')).toMatch(/signature not found/);
  });

  it('show: missing signature arg prints usage', async () => {
    const ctx = mkCtx(['show']);
    await recovery.handler(ctx as never);
    expect(ctx.errs.join(' ')).toMatch(/Usage: \/recovery show/);
  });

  it('clear: removes a signature', async () => {
    const { RecoveryStore } = await import('../../../core/v4/selfimprovement/recoveryStore');
    const store = new RecoveryStore(db);
    store.recordFailureOccurrence({
      signature: 'doomed:other', toolName: 'doomed', category: 'other',
    });
    const ctx = mkCtx(['clear', 'doomed:other']);
    await recovery.handler(ctx as never);
    expect(ctx.out.join('')).toMatch(/cleared signature doomed:other/);
    expect(store.getBySignature('doomed:other')).toBeNull();
  });

  it('clear: unknown signature prints error', async () => {
    const ctx = mkCtx(['clear', 'gone:already']);
    await recovery.handler(ctx as never);
    expect(ctx.errs.join(' ')).toMatch(/signature not found/);
  });

  it('unknown sub-action prints usage', async () => {
    const ctx = mkCtx(['junk']);
    await recovery.handler(ctx as never);
    expect(ctx.errs.join(' ')).toMatch(/Usage: \/recovery/);
  });

  it('store-not-initialised: prints error and exits cleanly', async () => {
    _resetRecoveryStoreForTests();  // drop singleton
    const ctx = mkCtx(['list']);
    await recovery.handler(ctx as never);
    expect(ctx.errs.join(' ')).toMatch(/not initialised/);
  });
});
