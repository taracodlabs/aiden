/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/auditQuery.ts — v4.9.0 Slice 12b.
 *
 * Read-only helpers over `hook_executions`. The CLI's `aiden hooks
 * audit` builds query parameters from flags and forwards them here.
 * No mutation, no policy decisions — pure SELECT.
 */
import type { Db } from '../daemon/db/connection';

export interface AuditRow {
  hook_execution_id: string;
  hook_id:           string;
  hook_name:         string | null;
  subscription_id:   string | null;
  event:             string;
  status:            string;
  decision:          string | null;
  elapsed_ms:        number;
  exit_code:         number | null;
  error_kind:        string | null;
  error_message:     string | null;
  started_at:        string;
  finished_at:       string;
  run_id:            string | null;
  trace_id:          string | null;
}

export interface AuditQuery {
  hookId?:  string;
  event?:   string;
  status?:  string;
  /** ISO-8601 inclusive lower bound on `started_at`. */
  since?:   string;
  /** Default 50, hard-capped at 1000. */
  limit?:   number;
}

export function queryHookExecutions(db: Db, q: AuditQuery = {}): AuditRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.hookId) { where.push('e.hook_id = ?');  params.push(q.hookId); }
  if (q.event)  { where.push('e.event = ?');    params.push(q.event); }
  if (q.status) { where.push('e.status = ?');   params.push(q.status); }
  if (q.since)  { where.push('e.started_at >= ?'); params.push(q.since); }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
  const sql = `
    SELECT e.hook_execution_id, e.hook_id, h.name AS hook_name,
           e.subscription_id, e.event, e.status, e.decision,
           e.elapsed_ms, e.exit_code, e.error_kind, e.error_message,
           e.started_at, e.finished_at, e.run_id, e.trace_id
      FROM hook_executions e
      LEFT JOIN hooks h ON h.hook_id = e.hook_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY e.started_at DESC
     LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as AuditRow[];
}

/**
 * Per-hook failure-rate summary over the most recent `lookbackN`
 * executions. Used by `hooks doctor` to flag chronically unhealthy
 * hooks (>10% failure rate over last 100).
 */
export interface FailureRateRow {
  hook_id:     string;
  hook_name:   string | null;
  total:       number;
  failures:    number;
  failureRate: number;
}

export function failureRates(db: Db, lookbackN = 100): FailureRateRow[] {
  // Per-hook: count last N executions and how many were non-ok.
  const ids = db.prepare(`SELECT hook_id, name FROM hooks`).all() as Array<{ hook_id: string; name: string }>;
  const rows: FailureRateRow[] = [];
  for (const h of ids) {
    const recent = db.prepare(
      `SELECT status FROM hook_executions WHERE hook_id = ?
         ORDER BY started_at DESC LIMIT ?`,
    ).all(h.hook_id, lookbackN) as Array<{ status: string }>;
    if (recent.length === 0) continue;
    const failures = recent.filter((r) => r.status !== 'ok').length;
    rows.push({
      hook_id:     h.hook_id,
      hook_name:   h.name,
      total:       recent.length,
      failures,
      failureRate: failures / recent.length,
    });
  }
  return rows;
}

/** Count rows matching a status set over the recent window. */
export function countByStatus(db: Db, sinceIso: string): Record<string, number> {
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM hook_executions
       WHERE started_at >= ? GROUP BY status`,
  ).all(sinceIso) as Array<{ status: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}
