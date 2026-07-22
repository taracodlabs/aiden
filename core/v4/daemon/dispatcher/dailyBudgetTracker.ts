/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/dailyBudgetTracker.ts — v4.5 Phase 7.
 *
 * Persistent daily-token-budget counter for daemon-mode agent
 * turns. Defends against "I set up 50 triggers and the bill
 * exploded" (Q-P7-4a).
 *
 * Storage: piggyback on the existing `idempotency_keys` table
 * via `scope='daemon_budget'` rows — no schema bump. One row per
 * UTC day, `key=<yyyy-mm-dd>`, `response_json` carries the
 * running total. `status_code` unused (200). `expires_at` set 7
 * days out so the L2 sweep cleans old rows automatically.
 *
 * Threading: synchronous SQL writes serialize the counter at
 * the SQLite level. Concurrency-safe against multiple producer
 * threads in the same process. Cross-process daemons would need
 * a separate locking step (out of scope — single-daemon-per-host
 * is the v4.5 invariant).
 *
 * Cap evaluation: `addAndCheck(tokens)` returns `{allowed,
 * remaining, used}`. Allowed=false means EITHER the add would
 * exceed the budget OR the budget is already exhausted. Callers
 * (`budgetGate.ts`) handle the reject path.
 */

import type { Db } from '../db/connection';
import type { ProviderAttemptLedger } from '../../usageLedger';

const BUDGET_SCOPE = 'daemon_budget';
const ROW_TTL_DAYS = 7;

export interface DailyBudgetSnapshot {
  /** Current calendar day (UTC) — `yyyy-mm-dd`. */
  date:        string;
  /** Tokens consumed so far today. */
  used:        number;
  /** Configured budget (input echoed back; null = unlimited). */
  budget:      number | null;
  /** budget - used (or Infinity when unlimited). */
  remaining:   number;
  /** True when used >= budget AND budget is set. */
  exhausted:   boolean;
}

export interface DailyBudgetTracker {
  /**
   * Try to consume `tokens` from today's budget. Atomic. Returns
   * the post-consume snapshot. When `allowed=false`, NO tokens
   * were added — the caller can re-try with smaller `tokens` or
   * fail the turn.
   */
  addAndCheck(tokens: number, opts?: { budget?: number | null; now?: number }): {
    allowed:   boolean;
    snapshot:  DailyBudgetSnapshot;
    reason?:   string;
  };
  /** Read today's snapshot without mutating. */
  peek(opts?: { budget?: number | null; now?: number }): DailyBudgetSnapshot;
  /** Test/admin — reset today's row to zero. */
  reset(opts?: { now?: number }): void;
}

export interface CreateDailyBudgetTrackerOptions {
  db: Db;
  /** Override the configured budget — null = unlimited. */
  budget?: number | null;
}

export function createDailyBudgetTracker(
  opts: CreateDailyBudgetTrackerOptions,
): DailyBudgetTracker {
  const db = opts.db;
  const configuredBudget = opts.budget ?? null;

  function readRow(date: string): number {
    const row = db.prepare(
      `SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?`,
    ).get(BUDGET_SCOPE, date) as { response_json: string } | undefined;
    if (!row) return 0;
    try {
      const parsed = JSON.parse(row.response_json) as { used?: number };
      return typeof parsed.used === 'number' ? parsed.used : 0;
    } catch {
      return 0;
    }
  }

  function writeRow(date: string, used: number, now: number): void {
    const expiresAt = now + ROW_TTL_DAYS * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT OR REPLACE INTO idempotency_keys
         (scope, key, fingerprint, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, NULL, ?, 200, ?, ?)`,
    ).run(BUDGET_SCOPE, date, JSON.stringify({ used }), now, expiresAt);
  }

  function buildSnapshot(date: string, used: number, budget: number | null): DailyBudgetSnapshot {
    return {
      date,
      used,
      budget,
      remaining: budget !== null && budget > 0 ? Math.max(0, budget - used) : Number.POSITIVE_INFINITY,
      exhausted: budget !== null && budget > 0 && used >= budget,
    };
  }

  return {
    addAndCheck(tokens, opts2 = {}) {
      const now = opts2.now ?? Date.now();
      const date = utcDateKey(now);
      const budget = opts2.budget !== undefined ? opts2.budget : configuredBudget;
      const tx = db.transaction((): { allowed: boolean; snapshot: DailyBudgetSnapshot; reason?: string } => {
        const used = readRow(date);
        // Refuse to consume when already at/over cap.
        if (budget !== null && budget > 0 && used >= budget) {
          return {
            allowed:  false,
            snapshot: buildSnapshot(date, used, budget),
            reason:   `daily_budget_exhausted: ${used}/${budget} tokens used today (${date})`,
          };
        }
        // Refuse to consume when this call would push over cap.
        const next = used + Math.max(0, tokens);
        if (budget !== null && budget > 0 && next > budget) {
          return {
            allowed:  false,
            snapshot: buildSnapshot(date, used, budget),
            reason:   `daily_budget_would_exceed: ${tokens} > remaining ${budget - used}`,
          };
        }
        writeRow(date, next, now);
        return {
          allowed:  true,
          snapshot: buildSnapshot(date, next, budget),
        };
      });
      return tx();
    },
    peek(opts2 = {}) {
      const now = opts2.now ?? Date.now();
      const date = utcDateKey(now);
      const budget = opts2.budget !== undefined ? opts2.budget : configuredBudget;
      const used = readRow(date);
      return buildSnapshot(date, used, budget);
    },
    reset(opts2 = {}) {
      const now = opts2.now ?? Date.now();
      const date = utcDateKey(now);
      writeRow(date, 0, now);
    },
  };
}

/**
 * Read-only daily-budget projection over the provider-attempt ledger. Physical
 * attempts have already been appended by the time post-turn accounting runs,
 * so addAndCheck must not duplicate them in a second counter.
 */
export function createLedgerDailyBudgetTracker(options: {
  ledger: ProviderAttemptLedger;
  budget?: number | null;
  entryPoint?: string;
}): DailyBudgetTracker {
  const configuredBudget = options.budget ?? null;
  const entryPoint = options.entryPoint ?? 'daemon';

  const snapshot = (now: number, budget: number | null): DailyBudgetSnapshot => {
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const records = options.ledger.query({ since: day.getTime(), until: now });
    const used = records
      .filter((record) => record.entryPoint === entryPoint)
      .reduce((total, record) => total
        + (record.providerInputTokens ?? record.estimatedInputTokens ?? 0)
        + (record.providerOutputTokens ?? record.estimatedOutputTokens ?? 0), 0);
    return {
      date: utcDateKey(now),
      used,
      budget,
      remaining: budget !== null && budget > 0
        ? Math.max(0, budget - used)
        : Number.POSITIVE_INFINITY,
      exhausted: budget !== null && budget > 0 && used >= budget,
    };
  };

  return {
    addAndCheck(tokens, opts = {}) {
      const budget = opts.budget !== undefined ? opts.budget : configuredBudget;
      const current = snapshot(opts.now ?? Date.now(), budget);
      if (current.exhausted) {
        return {
          allowed: false,
          snapshot: current,
          reason: `daily_budget_exhausted: ${current.used}/${budget} tokens used today (${current.date})`,
        };
      }
      if (budget !== null && budget > 0 && current.used + Math.max(0, tokens) > budget) {
        return {
          allowed: false,
          snapshot: current,
          reason: `daily_budget_would_exceed: ${tokens} > remaining ${current.remaining}`,
        };
      }
      return { allowed: true, snapshot: current };
    },
    peek(opts = {}) {
      const budget = opts.budget !== undefined ? opts.budget : configuredBudget;
      return snapshot(opts.now ?? Date.now(), budget);
    },
    reset() {
      // The immutable ledger is authoritative and cannot be reset. Test/admin
      // reset remains available only on the legacy compatibility tracker.
    },
  };
}

/** `2026-05-17` for the day midnight UTC of `nowMs`. Public for tests. */
export function utcDateKey(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
