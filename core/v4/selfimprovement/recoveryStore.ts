/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/selfimprovement/recoveryStore.ts — v4.6 Phase 3b.
 *
 * Durable cross-session failure ledger + recovery report writer.
 * Backed by the v7 schema's `failure_signatures` + `recovery_reports`
 * tables. The store is the single write path for both halves of the
 * self-improvement loop:
 *
 *   1. `recordFailureOccurrence(...)` — called on every classified
 *      failure (TCE write-through at the aidenAgent classify site).
 *      Upserts the signature row, increments `occurrences`, updates
 *      `last_seen_at`.
 *
 *   2. `recordRecovery(...)` — called when a previously-failed
 *      signature is observed succeeding (or when the agent's TCE
 *      surfaces a structured recovery report at turn end).
 *      Inserts a `recovery_reports` row + bumps the signature's
 *      `recovered_count` + sets `last_recovery_report_id`.
 *
 * Reads:
 *
 *   * `listTopFailures(limit)` — operator dashboard query.
 *   * `getBySignature(signature)` — `/recovery show` detail surface.
 *   * `listForSession(sessionId)` — used by future plugin hooks that
 *     want per-session summaries (currently unused; the operator
 *     command path goes via `listTopFailures` + `getBySignature`).
 *   * `listReportsForSignature(signatureId, limit)` — the recovery
 *     history for one signature.
 *
 * Singleton pattern mirrors `spawnPause` (Phase 3a): `initRecoveryStore({db})`
 * at boot; `getRecoveryStore()` thereafter. Production wiring opens the
 * daemon DB once at REPL/daemon/MCP boot and re-uses the singleton
 * across REPL turns and daemon-fired turns. Tests reset via
 * `_resetRecoveryStoreForTests()`.
 *
 * Failure mode: NEVER throws. A persistence failure (locked DB,
 * schema drift, etc.) returns 0 / null and logs a warning. The
 * TCE write-through path treats the store as best-effort — losing
 * a signature increment does not break a turn.
 */

import type Database from 'better-sqlite3';

import type { FailureCategory } from '../failureClassifier';

// ── Public types ─────────────────────────────────────────────────────────

export interface FailureSignatureRow {
  id:                    number;
  signature:             string;
  toolName:              string;
  failureCategory:       FailureCategory;
  argsHash:              string | null;
  firstSeenAt:           number;
  lastSeenAt:            number;
  occurrences:           number;
  recoveredCount:        number;
  lastRecoveryReportId:  number | null;
}

export interface RecoveryReportRow {
  id:                 number;
  signatureId:        number;
  runId:              number | null;
  sessionId:          string | null;
  failedAttempts:     number;
  successfulStrategy: string;
  changedParameters:  string | null;
  verification:       string | null;
  createdAt:          number;
  notes:              string | null;
}

export interface TopFailureRow {
  signature:               string;
  toolName:                string;
  failureCategory:         FailureCategory;
  occurrences:             number;
  recoveredCount:          number;
  lastSeenAt:              number;
  lastRecoveryStrategy:    string | null;
}

export interface RecordFailureOpts {
  signature: string;
  toolName:  string;
  category:  FailureCategory;
  argsHash?: string;
  /** Override wall clock — tests inject deterministic timestamps. */
  now?:      () => number;
}

export interface RecordRecoveryOpts {
  signatureId:         number;
  runId?:              number;
  sessionId?:          string;
  failedAttempts:      number;
  successfulStrategy:  string;
  changedParameters?:  Record<string, unknown>;
  verification?:       string;
  notes?:              string;
  now?:                () => number;
}

// ── Implementation ───────────────────────────────────────────────────────

/**
 * SQLite-backed store. Constructed with a `better-sqlite3` Database
 * handle that already has the v7 migration applied. The store does
 * NOT run migrations itself — that's the caller's job (typically
 * `openDaemonDb` + `runMigrations`).
 */
export class RecoveryStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Upsert a failure signature + bump occurrences. Returns the
   * signature row id, or 0 on persistence failure (logged). The
   * caller (TCE write-through path) treats the return as best-effort.
   */
  recordFailureOccurrence(opts: RecordFailureOpts): number {
    const now = opts.now ?? Date.now;
    const ts  = now();
    try {
      // SQLite-native UPSERT — single round trip per failure. The
      // `excluded.x` syntax references the row we tried to insert.
      const r = this.db.prepare(`
        INSERT INTO failure_signatures
          (signature, tool_name, failure_category, args_hash,
           first_seen_at, last_seen_at, occurrences, recovered_count)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0)
        ON CONFLICT(signature) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          occurrences  = failure_signatures.occurrences + 1
        RETURNING id
      `).get(
        opts.signature,
        opts.toolName,
        opts.category,
        opts.argsHash ?? null,
        ts,
        ts,
      ) as { id: number } | undefined;
      return r?.id ?? 0;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recoveryStore] recordFailureOccurrence failed:',
        err instanceof Error ? err.message : String(err));
      return 0;
    }
  }

  /**
   * Record a successful recovery. Inserts a `recovery_reports`
   * row + atomically bumps the signature's `recovered_count` and
   * `last_recovery_report_id`. Returns the new report id, or 0 on
   * failure.
   */
  recordRecovery(opts: RecordRecoveryOpts): number {
    const now = opts.now ?? Date.now;
    const ts  = now();
    try {
      // Two-statement transaction — insert then update — keeps the
      // signature's `last_recovery_report_id` consistent with the
      // newly-inserted report row.
      const txn = this.db.transaction(() => {
        const ins = this.db.prepare(`
          INSERT INTO recovery_reports
            (signature_id, run_id, session_id, failed_attempts,
             successful_strategy, changed_parameters, verification,
             created_at, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          opts.signatureId,
          opts.runId ?? null,
          opts.sessionId ?? null,
          opts.failedAttempts,
          opts.successfulStrategy,
          opts.changedParameters ? JSON.stringify(opts.changedParameters) : null,
          opts.verification ?? null,
          ts,
          opts.notes ?? null,
        );
        const reportId = Number(ins.lastInsertRowid);
        this.db.prepare(`
          UPDATE failure_signatures
             SET recovered_count = recovered_count + 1,
                 last_recovery_report_id = ?
           WHERE id = ?
        `).run(reportId, opts.signatureId);
        return reportId;
      });
      return txn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recoveryStore] recordRecovery failed:',
        err instanceof Error ? err.message : String(err));
      return 0;
    }
  }

  /**
   * Top N recurring failure signatures, sorted by occurrence count
   * descending. Backs `/recovery list`. Joins the most recent
   * recovery_report so the operator sees what worked last.
   */
  listTopFailures(limit = 10): TopFailureRow[] {
    const cap = Math.max(1, Math.min(limit, 500));
    try {
      const rows = this.db.prepare(`
        SELECT
          s.signature                   AS signature,
          s.tool_name                   AS toolName,
          s.failure_category            AS failureCategory,
          s.occurrences                 AS occurrences,
          s.recovered_count             AS recoveredCount,
          s.last_seen_at                AS lastSeenAt,
          r.successful_strategy         AS lastRecoveryStrategy
        FROM failure_signatures s
        LEFT JOIN recovery_reports r
          ON r.id = s.last_recovery_report_id
        ORDER BY s.occurrences DESC, s.last_seen_at DESC
        LIMIT ?
      `).all(cap) as TopFailureRow[];
      return rows;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recoveryStore] listTopFailures failed:',
        err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Lookup one signature by its canonical string. Backs `/recovery
   * show`. Returns null when no signature row exists yet.
   */
  getBySignature(signature: string): FailureSignatureRow | null {
    try {
      const row = this.db.prepare(`
        SELECT
          id                      AS id,
          signature               AS signature,
          tool_name               AS toolName,
          failure_category        AS failureCategory,
          args_hash               AS argsHash,
          first_seen_at           AS firstSeenAt,
          last_seen_at            AS lastSeenAt,
          occurrences             AS occurrences,
          recovered_count         AS recoveredCount,
          last_recovery_report_id AS lastRecoveryReportId
        FROM failure_signatures WHERE signature = ?
      `).get(signature) as FailureSignatureRow | undefined;
      return row ?? null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recoveryStore] getBySignature failed:',
        err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Recovery reports linked to one signature, most recent first.
   * Used by `/recovery show` to render the recovery history below
   * the signature header.
   */
  listReportsForSignature(signatureId: number, limit = 50): RecoveryReportRow[] {
    const cap = Math.max(1, Math.min(limit, 500));
    try {
      const rows = this.db.prepare(`
        SELECT
          id                    AS id,
          signature_id          AS signatureId,
          run_id                AS runId,
          session_id            AS sessionId,
          failed_attempts       AS failedAttempts,
          successful_strategy   AS successfulStrategy,
          changed_parameters    AS changedParameters,
          verification          AS verification,
          created_at            AS createdAt,
          notes                 AS notes
        FROM recovery_reports
         WHERE signature_id = ?
         ORDER BY created_at DESC
         LIMIT ?
      `).all(signatureId, cap) as RecoveryReportRow[];
      return rows;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recoveryStore] listReportsForSignature failed:',
        err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Recovery reports written during one session, used by future
   * plugin hooks + the `/recovery` command's per-session view.
   * Wraps a single SELECT — no aggregation. Empty array when no
   * recoveries happened.
   */
  listForSession(sessionId: string): RecoveryReportRow[] {
    try {
      const rows = this.db.prepare(`
        SELECT
          id                    AS id,
          signature_id          AS signatureId,
          run_id                AS runId,
          session_id            AS sessionId,
          failed_attempts       AS failedAttempts,
          successful_strategy   AS successfulStrategy,
          changed_parameters    AS changedParameters,
          verification          AS verification,
          created_at            AS createdAt,
          notes                 AS notes
        FROM recovery_reports
         WHERE session_id = ?
         ORDER BY created_at DESC
      `).all(sessionId) as RecoveryReportRow[];
      return rows;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recoveryStore] listForSession failed:',
        err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Operator escape hatch — `/recovery clear <signature>` lets the
   * operator say "this is fixed, stop counting it." Cascades to
   * the linked recovery_reports rows so the signature genuinely
   * disappears. Returns true when a row was deleted.
   */
  clearSignature(signature: string): boolean {
    try {
      const sig = this.getBySignature(signature);
      if (!sig) return false;
      const txn = this.db.transaction(() => {
        this.db.prepare(`DELETE FROM recovery_reports WHERE signature_id = ?`).run(sig.id);
        this.db.prepare(`DELETE FROM failure_signatures WHERE id = ?`).run(sig.id);
      });
      txn();
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recoveryStore] clearSignature failed:',
        err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}

// ── Module-level singleton ───────────────────────────────────────────────

let _singleton: RecoveryStore | null = null;

export interface InitRecoveryStoreOptions {
  db: Database.Database;
}

/**
 * Initialise the process-wide store. Called once at REPL / daemon /
 * MCP boot, after `runMigrations` has applied v7. Re-init replaces
 * the singleton so tests can swap DBs cleanly.
 */
export function initRecoveryStore(opts: InitRecoveryStoreOptions): RecoveryStore {
  _singleton = new RecoveryStore(opts.db);
  return _singleton;
}

/**
 * Read the current singleton. Returns null when not initialised so
 * callers on the hot path (TCE write-through) can no-op silently
 * instead of throwing. The slash command path (`/recovery list`)
 * does its own "not initialised" error reporting.
 */
export function getRecoveryStore(): RecoveryStore | null {
  return _singleton;
}

/**
 * Test-only — drop the singleton so the next `initRecoveryStore`
 * call wires a fresh state.
 */
export function _resetRecoveryStoreForTests(): void {
  _singleton = null;
}
