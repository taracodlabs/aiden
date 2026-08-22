/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggerBus.ts — v4.5 Phase 1: durable trigger bus.
 *
 * The CENTRAL persistence layer for the daemon. Every accepted
 * trigger (file watcher fire, webhook delivery, email match,
 * scheduled job tick) normalizes into a `trigger_events` row
 * BEFORE returning 202 Accepted / marking the email seen /
 * enqueuing schedule. ONE durable queue, not 4 parallel half-
 * baked persistence layers.
 *
 * Concurrency semantics:
 *   - `insert()` uses INSERT OR IGNORE against the partial unique
 *     index on (source, idempotency_key). Duplicates return the
 *     existing id with `inserted: false`.
 *   - `claim()` atomically picks the oldest pending event and
 *     sets status='claimed' + claim_owner + claim_expires_at. A
 *     per-claim nonce (claimToken) is returned; subsequent
 *     release/markDone/markFailed validate it to prevent double-
 *     completion races across sibling daemons.
 *   - `reclaimExpired()` returns to 'pending' any claimed row
 *     whose lease has elapsed (called by the daemon ticker every
 *     30s + on boot).
 *   - `markFailed()` increments attempts; on attempts >=
 *     maxAttempts the row moves to 'dead_letter' instead of
 *     returning to pending.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from './db/connection';
import type {
  TriggerEventInput,
  TriggerEventRow,
  TriggerEventStatus,
  ClaimedEvent,
  TriggerSource,
} from './types';
import type { TriggerEventRowSql } from './db/schema/v1.spec';

export const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
export const DEFAULT_MAX_ATTEMPTS   = 3;

export interface TriggerBus {
  insert(ev: TriggerEventInput): { id: number; inserted: boolean };
  claim(opts?: { source?: TriggerSource; leaseMs?: number; ownerId: string }): ClaimedEvent | null;
  renewClaim(eventId: number, claimToken: string, extendMs: number): boolean;
  release(eventId: number, claimToken: string, options?: { restoreAttempt?: boolean }): void;
  markDone(eventId: number, claimToken: string, runId?: number): void;
  markFailed(eventId: number, claimToken: string, error: string, opts?: { maxAttempts?: number; cooldownMs?: number }): void;
  reclaimExpired(now?: number): { reclaimed: number };
  deadLetter(eventId: number, reason: string): void;
  stats(): {
    pending:        number;
    claimed:        number;
    running:        number;
    deadLetter:     number;
    oldestPendingMs: number | null;
  };
  /** Diagnostic — full row. */
  get(eventId: number): TriggerEventRow | null;
}

function rowToTs(r: TriggerEventRowSql): TriggerEventRow {
  return {
    id:              r.id,
    source:          r.source as TriggerSource,
    sourceKey:       r.source_key,
    idempotencyKey:  r.idempotency_key,
    payload:         safeJsonParse(r.payload_json),
    status:          r.status as TriggerEventStatus,
    attempts:        r.attempts,
    claimOwner:      r.claim_owner,
    claimExpiresAt:  r.claim_expires_at,
    lastError:       r.last_error,
    createdAt:       r.created_at,
    updatedAt:       r.updated_at,
    completedAt:     r.completed_at,
    runId:           r.run_id,
  };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; }
  catch { return {}; }
}

export interface CreateTriggerBusOptions {
  db: Db;
  /**
   * v4.9.0 Slice 5 — when set, every `insert()` with a non-null
   * `idempotencyKey` writes a `run_idempotency_keys` row in the same
   * statement sequence. The bus stays in-process with the existing DB
   * connection; no separate handle is plumbed through callers. When
   * omitted (tests, legacy callers), insertion behaviour is exactly
   * the v4.5 shape — backwards-compatible.
   */
  enableRunIdempotency?: boolean;
  /** Optional warn callback for ingress-idempotency rejections. */
  onIdempotencyConflict?: (info: { source: string; sourceKey: string; key: string }) => void;
}

export function createTriggerBus(opts: CreateTriggerBusOptions): TriggerBus {
  const db = opts.db;

  return {
    insert(ev: TriggerEventInput): { id: number; inserted: boolean } {
      const now = Date.now();
      const payloadJson = JSON.stringify(ev.payload ?? {});
      // v4.9.0 Slice 5 — wrap insert + idempotency write in a single
      // transaction so a crash between them can't leave a stranded
      // trigger_events row without an idempotency anchor.
      let outcome: { id: number; inserted: boolean } | null = null;
      const tx = db.transaction((): void => {
        const result = db
          .prepare(
            `INSERT OR IGNORE INTO trigger_events
               (source, source_key, idempotency_key, payload_json,
                status, attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
          )
          .run(
            ev.source,
            ev.sourceKey,
            ev.idempotencyKey ?? null,
            payloadJson,
            now,
            now,
          );
        if (result.changes > 0) {
          const newId = Number(result.lastInsertRowid);
          // Slice 5 — anchor the run-idempotency row keyed on
          // (`trigger:<source>`, `<sourceKey>::<idempotencyKey>`). We
          // skip if idempotencyKey is null (nothing to dedupe against).
          if (opts.enableRunIdempotency && ev.idempotencyKey) {
            const ns  = `trigger:${ev.source}`;
            const key = `${ev.sourceKey}::${ev.idempotencyKey}`;
            const fp  = ev.idempotencyKey;
            db.prepare(
              `INSERT OR IGNORE INTO run_idempotency_keys
                 (namespace, key, fingerprint, trigger_event_id,
                  status, created_at)
               VALUES (?, ?, ?, ?, 'accepted', ?)`,
            ).run(ns, key, fp, newId, new Date(now).toISOString());
          }
          outcome = { id: newId, inserted: true };
          return;
        }
        // Dedup hit — return the existing id.
        const existing = db
          .prepare(
            'SELECT id FROM trigger_events WHERE source = ? AND idempotency_key = ?',
          )
          .get(ev.source, ev.idempotencyKey ?? null) as { id: number } | undefined;
        if (!existing) {
          throw new Error('triggerBus.insert: INSERT OR IGNORE produced no row but no existing match found');
        }
        if (opts.enableRunIdempotency && ev.idempotencyKey && opts.onIdempotencyConflict) {
          // Slice 5 — surface the dedup-as-duplicate event for visibility.
          try {
            opts.onIdempotencyConflict({
              source:    ev.source,
              sourceKey: ev.sourceKey,
              key:       `${ev.sourceKey}::${ev.idempotencyKey}`,
            });
          } catch { /* notification must never throw */ }
        }
        outcome = { id: existing.id, inserted: false };
      });
      tx();
      return outcome!;
    },

    claim(opts2: { source?: TriggerSource; leaseMs?: number; ownerId: string } = { ownerId: '' }): ClaimedEvent | null {
      const leaseMs = opts2.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
      const now     = Date.now();
      const expires = now + leaseMs;
      const claimToken = randomUUID();

      const tx = db.transaction((): TriggerEventRow | null => {
        // Pick the oldest pending event matching the optional source filter.
        // v4.5 Phase 7 — honour cooldown: skip pending rows whose
        // claim_expires_at is still in the future (re-set by
        // markFailed with cooldownMs to delay re-claim).
        const sql = opts2.source
          ? `SELECT id FROM trigger_events
              WHERE status = 'pending' AND source = ?
                AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
              ORDER BY created_at LIMIT 1`
          : `SELECT id FROM trigger_events
              WHERE status = 'pending'
                AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
              ORDER BY created_at LIMIT 1`;
        const candidate = (opts2.source
          ? db.prepare(sql).get(opts2.source, now)
          : db.prepare(sql).get(now)) as { id: number } | undefined;
        if (!candidate) return null;

        const upd = db
          .prepare(
            `UPDATE trigger_events
                SET status           = 'claimed',
                    claim_owner      = ?,
                    claim_token      = ?,
                    claim_expires_at = ?,
                    updated_at       = ?,
                    attempts         = attempts + 1
              WHERE id = ? AND status = 'pending'`,
          )
          .run(opts2.ownerId, claimToken, expires, now, candidate.id);
        if (upd.changes === 0) return null;     // race lost
        const row = db
          .prepare('SELECT * FROM trigger_events WHERE id = ?')
          .get(candidate.id) as TriggerEventRowSql;
        return rowToTs(row);
      });
      const row = tx();
      if (!row) return null;
      return { ...row, claimToken };
    },

    renewClaim(eventId: number, claimToken: string, extendMs: number): boolean {
      const now = Date.now();
      const upd = db
        .prepare(
          `UPDATE trigger_events
              SET claim_expires_at = ?,
                  updated_at       = ?
            WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
        )
        .run(now + extendMs, now, eventId, claimToken);
      return upd.changes > 0;
    },

    release(eventId: number, claimToken: string, releaseOptions = {}): void {
      const now = Date.now();
      db.prepare(
        `UPDATE trigger_events
            SET status           = 'pending',
                claim_owner      = NULL,
                claim_token      = NULL,
                claim_expires_at = NULL,
                updated_at       = ?,
                attempts         = CASE WHEN ? = 1 THEN MAX(0, attempts - 1) ELSE attempts END
          WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      ).run(now, releaseOptions.restoreAttempt ? 1 : 0, eventId, claimToken);
    },

    markDone(eventId: number, claimToken: string, runId?: number): void {
      const now = Date.now();
      db.prepare(
        `UPDATE trigger_events
            SET status           = 'done',
                claim_owner      = NULL,
                claim_token      = NULL,
                claim_expires_at = NULL,
                updated_at       = ?,
                completed_at     = ?,
                run_id           = COALESCE(?, run_id)
          WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      ).run(now, now, runId ?? null, eventId, claimToken);
    },

    markFailed(
      eventId:    number,
      claimToken: string,
      error:      string,
      opts2: { maxAttempts?: number; cooldownMs?: number } = {},
    ): void {
      const max = opts2.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      const now = Date.now();
      const truncated = error.length > 1024 ? error.slice(0, 1024) + '…' : error;
      // v4.5 Phase 7 — optional cooldown delays re-claim. When set,
      // we stash `now + cooldownMs` in `claim_expires_at` while
      // status='pending'. The claim picker filters out pending rows
      // whose claim_expires_at is in the future (added below). Bus
      // poll loop will pick the row up naturally once cooldown
      // elapses — no explicit sleep needed.
      const cooldownUntil = opts2.cooldownMs && opts2.cooldownMs > 0
        ? now + opts2.cooldownMs
        : null;
      const tx = db.transaction((): void => {
        const row = db
          .prepare("SELECT attempts FROM trigger_events WHERE id = ? AND status = 'claimed' AND claim_token = ?")
          .get(eventId, claimToken) as { attempts: number } | undefined;
        if (!row) return;
        // attempts was already incremented at claim time. Move to
        // dead_letter when the count hits max, else return to pending.
        if (row.attempts >= max) {
          db.prepare(
            `UPDATE trigger_events
                SET status           = 'dead_letter',
                    claim_owner      = NULL,
                    claim_token      = NULL,
                    claim_expires_at = NULL,
                    last_error       = ?,
                    updated_at       = ?,
                    completed_at     = ?
              WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
          ).run(truncated, now, now, eventId, claimToken);
        } else {
          db.prepare(
            `UPDATE trigger_events
                SET status           = 'pending',
                    claim_owner      = NULL,
                    claim_token      = NULL,
                    claim_expires_at = ?,
                    last_error       = ?,
                    updated_at       = ?
              WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
          ).run(cooldownUntil, truncated, now, eventId, claimToken);
        }
      });
      tx();
    },

    reclaimExpired(now?: number): { reclaimed: number } {
      const cutoff = now ?? Date.now();
      const upd = db
        .prepare(
          `UPDATE trigger_events
              SET status           = 'pending',
                  claim_owner      = NULL,
                  claim_token      = NULL,
                  claim_expires_at = NULL,
                  last_error       = COALESCE(last_error, 'claim lease expired'),
                  updated_at       = ?
            WHERE status = 'claimed'
              AND claim_expires_at IS NOT NULL
              AND claim_expires_at < ?`,
        )
        .run(cutoff, cutoff);
      return { reclaimed: upd.changes };
    },

    deadLetter(eventId: number, reason: string): void {
      const now = Date.now();
      db.prepare(
        `UPDATE trigger_events
            SET status           = 'dead_letter',
                claim_owner      = NULL,
                claim_token      = NULL,
                claim_expires_at = NULL,
                last_error       = ?,
                updated_at       = ?,
                completed_at     = ?
          WHERE id = ?`,
      ).run(reason.length > 1024 ? reason.slice(0, 1024) + '…' : reason, now, now, eventId);
    },

    stats(): {
      pending: number; claimed: number; running: number;
      deadLetter: number; oldestPendingMs: number | null;
    } {
      const counts = db
        .prepare(
          `SELECT status, COUNT(*) AS c FROM trigger_events GROUP BY status`,
        )
        .all() as Array<{ status: string; c: number }>;
      const m: Record<string, number> = {};
      for (const r of counts) m[r.status] = r.c;
      const oldest = db
        .prepare(
          `SELECT MIN(created_at) AS t FROM trigger_events WHERE status = 'pending'`,
        )
        .get() as { t: number | null };
      const oldestPendingMs = oldest.t != null ? Date.now() - oldest.t : null;
      return {
        pending:    m.pending    ?? 0,
        claimed:    m.claimed    ?? 0,
        running:    m.running    ?? 0,
        deadLetter: m.dead_letter ?? 0,
        oldestPendingMs,
      };
    },

    get(eventId: number): TriggerEventRow | null {
      const r = db
        .prepare('SELECT * FROM trigger_events WHERE id = ?')
        .get(eventId) as TriggerEventRowSql | undefined;
      return r ? rowToTs(r) : null;
    },
  };
}
