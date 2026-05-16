/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/email/emailSeenStore.ts — v4.5 Phase 4a.
 *
 * Writer + reader for the `email_seen` table. Cross-restart authority
 * for "have we processed this UID before?" + forensic audit trail.
 *
 * UNIQUE(route_id, uid_validity, uid) at the schema layer dedups
 * concurrent or repeated writes for the same UID. The status field
 * records WHY a UID was seen even when no trigger_event was emitted
 * (skipped due to automated sender, allowlist, subject filter, etc.).
 *
 * Retention: AIDEN_DAEMON_EMAIL_RETENTION_DAYS env (default 30).
 * Sweep runs on boot + daily.
 */

import type { Db } from '../../db/connection';

export type EmailSeenStatus =
  | 'processed'
  | 'skipped_automated'
  | 'skipped_unauth'
  | 'skipped_subject'
  | 'failed';

export interface EmailSeen {
  id:               number;
  routeId:          string;
  mailbox:          string;
  uidValidity:      number;
  uid:              number;
  messageId:        string | null;
  fromAddress:      string | null;
  subject:          string | null;
  receivedAt:       number;
  processedAt:      number | null;
  triggerEventId:   number | null;
  status:           EmailSeenStatus;
}

export interface RecordEmailSeenInput {
  routeId:        string;
  mailbox:        string;
  uidValidity:    number;
  uid:            number;
  messageId:      string | null;
  fromAddress:    string | null;
  subject:        string | null;
  receivedAt:     number;
  triggerEventId: number | null;
  status:         EmailSeenStatus;
}

export interface EmailSeenStore {
  /**
   * Insert (or no-op on UNIQUE conflict). Returns the row id when
   * inserted, OR the existing row id when the UID was already seen.
   */
  record(input: RecordEmailSeenInput): number;
  /** Single lookup. */
  get(routeId: string, uidValidity: number, uid: number): EmailSeen | null;
  /** Top-N most recent for a route. */
  list(routeId: string, limit?: number): EmailSeen[];
  /** Retention sweep — DELETE rows older than `retentionDays`. */
  sweep(retentionDays: number, now?: number): { deleted: number };
  /** Diagnostic count. */
  countForRoute(routeId: string): number;
  /** Has this Message-ID been processed by ANY route? (cross-restart "seen.") */
  isMessageIdSeen(messageId: string): boolean;
}

interface EmailSeenRowSql {
  id:                  number;
  route_id:            string;
  mailbox:             string;
  uid_validity:        number;
  uid:                 number;
  message_id:          string | null;
  from_address:        string | null;
  subject:             string | null;
  received_at:         number;
  processed_at:        number | null;
  trigger_event_id:    number | null;
  status:              string;
}

function rowToTs(r: EmailSeenRowSql): EmailSeen {
  return {
    id:              r.id,
    routeId:         r.route_id,
    mailbox:         r.mailbox,
    uidValidity:     r.uid_validity,
    uid:             r.uid,
    messageId:       r.message_id,
    fromAddress:     r.from_address,
    subject:         r.subject,
    receivedAt:      r.received_at,
    processedAt:     r.processed_at,
    triggerEventId:  r.trigger_event_id,
    status:          r.status as EmailSeenStatus,
  };
}

export function createEmailSeenStore(opts: { db: Db }): EmailSeenStore {
  const db = opts.db;

  return {
    record(input: RecordEmailSeenInput): number {
      const now = Date.now();
      // INSERT OR IGNORE returns 0 rows changed on conflict; in that
      // case we look up the existing row id.
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO email_seen
             (route_id, mailbox, uid_validity, uid, message_id,
              from_address, subject, received_at, processed_at,
              trigger_event_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.routeId,
          input.mailbox,
          input.uidValidity,
          input.uid,
          input.messageId,
          input.fromAddress,
          input.subject,
          input.receivedAt,
          now,
          input.triggerEventId,
          input.status,
        );
      if (r.changes > 0) return Number(r.lastInsertRowid);
      const existing = db
        .prepare(
          `SELECT id FROM email_seen WHERE route_id = ? AND uid_validity = ? AND uid = ?`,
        )
        .get(input.routeId, input.uidValidity, input.uid) as { id: number } | undefined;
      if (!existing) {
        throw new Error('emailSeenStore.record: INSERT OR IGNORE skipped + no existing row found');
      }
      return existing.id;
    },
    get(routeId, uidValidity, uid) {
      const r = db
        .prepare(
          `SELECT * FROM email_seen WHERE route_id = ? AND uid_validity = ? AND uid = ?`,
        )
        .get(routeId, uidValidity, uid) as EmailSeenRowSql | undefined;
      return r ? rowToTs(r) : null;
    },
    list(routeId, limit = 100) {
      const rows = db
        .prepare(
          `SELECT * FROM email_seen WHERE route_id = ?
            ORDER BY received_at DESC LIMIT ?`,
        )
        .all(routeId, limit) as EmailSeenRowSql[];
      return rows.map(rowToTs);
    },
    sweep(retentionDays, now) {
      const cutoff = (now ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1000;
      const r = db
        .prepare(`DELETE FROM email_seen WHERE received_at < ?`)
        .run(cutoff);
      return { deleted: r.changes };
    },
    countForRoute(routeId) {
      const r = db
        .prepare(`SELECT COUNT(*) AS c FROM email_seen WHERE route_id = ?`)
        .get(routeId) as { c: number };
      return r.c;
    },
    isMessageIdSeen(messageId) {
      if (!messageId) return false;
      const r = db
        .prepare(`SELECT 1 FROM email_seen WHERE message_id = ? LIMIT 1`)
        .get(messageId) as { 1: number } | undefined;
      return r !== undefined;
    },
  };
}
