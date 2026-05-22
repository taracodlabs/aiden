/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/lifecycle.ts — v4.9.0 Slice 12b.
 *
 * Helpers that fire `session.start`, `session.end`, `approval.requested`,
 * and `approval.responded` hooks. All are observe-only — even if a hook
 * returns `decision: 'block'`, these helpers ignore the decision (the
 * blocking event is `tool.call.pre`, not lifecycle signals).
 *
 * Each helper is fail-open: any dispatch error is swallowed so a
 * misbehaving hook can't crash the host (session start) or hide an
 * approval prompt.
 *
 * Wiring: callers that have a `db` handle from `getCurrentDaemonDb()`
 * invoke these directly. With `db: null` (no daemon) they no-op.
 */
import type { Db } from '../daemon/db/connection';
import { dispatchHook, type DispatchContext } from './dispatcher';

async function safeFire(
  db:      Db | null,
  event:   'session.start' | 'session.end' | 'approval.requested' | 'approval.responded',
  payload: Record<string, unknown>,
  ctx:     DispatchContext,
): Promise<void> {
  if (!db) return;
  try { await dispatchHook(db, event, payload, ctx); }
  catch { /* fail-open — lifecycle hooks never throw out */ }
}

export async function fireSessionStart(db: Db | null, payload: {
  session_id: string; source: string; started_at: string;
}, ctx: DispatchContext = {}): Promise<void> {
  return safeFire(db, 'session.start', payload, ctx);
}

export async function fireSessionEnd(db: Db | null, payload: {
  session_id: string; ended_at: string; turn_count?: number; duration_ms?: number;
}, ctx: DispatchContext = {}): Promise<void> {
  return safeFire(db, 'session.end', payload, ctx);
}

export async function fireApprovalRequested(db: Db | null, payload: {
  tool_name: string; tool_args_redacted: Record<string, unknown>; reason?: string;
}, ctx: DispatchContext = {}): Promise<void> {
  return safeFire(db, 'approval.requested', payload, ctx);
}

export async function fireApprovalResponded(db: Db | null, payload: {
  tool_name: string; decision: string; responded_at: string;
}, ctx: DispatchContext = {}): Promise<void> {
  return safeFire(db, 'approval.responded', payload, ctx);
}
