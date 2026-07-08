/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/workbench/sessionList.ts — the sidebar's recent-sessions source.
 *
 * A read-only SessionLister over the durable session store (sessions.db). Each
 * row gets a READABLE label — the distilled title, else a snippet of the first
 * user message, else a neutral fallback — never a raw session id. Session ids
 * align with run_events, so a sidebar selection drives /api/sessions/<id>/events.
 */
import type { SessionStore, SessionRecord } from '../sessionStore';
import type { SessionLister, SessionSummary } from './bridgeServer';

/** A readable one-line label for a session — never the raw id. */
function labelFor(store: SessionStore, s: SessionRecord): string {
  const title = (s.title ?? '').trim();
  if (title) return title;
  // No distilled title yet — fall back to a snippet of the first user message.
  try {
    const first = store.getMessages(s.id).find((m) => m.role === 'user' && (m.content ?? '').trim());
    if (first) {
      const oneLine = first.content.replace(/\s+/g, ' ').trim();
      return oneLine.length > 72 ? oneLine.slice(0, 72) + '…' : oneLine;
    }
  } catch { /* fall through to the neutral label */ }
  return '(untitled session)';
}

/**
 * Build a read-only lister that returns recent sessions (newest-active first)
 * with readable labels. `limit` caps the list (default 40).
 */
export function createSessionLister(store: SessionStore, limit = 40): SessionLister {
  return {
    listSessions(): SessionSummary[] {
      const rows = store.listSessions({ orderBy: 'updated', limit });
      return rows.map((s) => ({
        id:         s.id,
        label:      labelFor(store, s),
        lastActive: s.updatedAt || s.createdAt || 0,
        provider:   s.providerId,
        model:      s.modelId,
      }));
    },
  };
}
