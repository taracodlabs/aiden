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

/** Strip bracketed-paste markers (ESC[200~ / ESC[201~, and their ESC-stripped
 *  `[200~`/`200~` leftovers) that can leak into a pasted message. */
function stripPasteArtifacts(s: string): string {
  return s.replace(/\x1b?\[?20[01]~/g, '');
}
/** Normalize a candidate label: de-paste, collapse whitespace, trim. */
function clean(s: string): string {
  return stripPasteArtifacts(s ?? '').replace(/\s+/g, ' ').trim();
}
/** Compact UTC timestamp for the fallback label, e.g. "2026-07-08 12:10". */
function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

/** A readable one-line label for a session — never the raw id. */
function labelFor(store: SessionStore, s: SessionRecord): string {
  const title = clean(s.title ?? '');
  if (title) return title;
  // No distilled title yet — fall back to a snippet of the first user message.
  try {
    const first = store.getMessages(s.id).find((m) => m.role === 'user' && clean(m.content ?? ''));
    if (first) {
      const line = clean(first.content);
      if (line) return line.length > 72 ? line.slice(0, 72) + '…' : line;
    }
  } catch { /* fall through to the timestamp label */ }
  // Better than a generic string: name the session by when it was last active.
  const ts = s.updatedAt || s.createdAt || 0;
  return ts ? 'Session · ' + fmtTs(ts) : 'Session';
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
