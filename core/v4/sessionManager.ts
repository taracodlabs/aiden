/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/sessionManager.ts — Aiden v4.0.0
 *
 * Higher-level session lifecycle layer over `SessionStore`. Handles:
 *
 * - `startSession()` — create or resume by exact title
 * - `resumeLatest()` — `aiden -c` / `aiden --continue`
 * - `resumeById()`   — UUID prefix or fuzzy title match (CLI `aiden resume <q>`)
 * - `recordTurn()`   — persist messages + accumulate token usage after each
 *                      AidenAgent turn
 * - `search()`       — pass-through to SessionStore for the session_search tool
 *
 * The manager owns no DB connections — it delegates everything to a single
 * `SessionStore` instance. Callers are responsible for closing the store.
 *
 * Status: PHASE 6.
 *
 * Hermes reference: gateway/session.py::SessionStore (the application-side
 * session manager, not the SQLite layer).
 */

import type {
  SessionRecord,
  SessionSearchResult,
  SessionStore,
  AppendMessageInput,
} from './sessionStore';
import type { Message } from '../../providers/v4/types';

export interface StartSessionOptions {
  /**
   * Session title. When provided and an existing session has the EXACT same
   * title, that session is reused instead of creating a duplicate.
   */
  title?: string;
  providerId: string;
  modelId: string;
}

export interface RecordTurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export class SessionManager {
  constructor(private readonly store: SessionStore) {}

  /**
   * Start (or resume) a session. When `title` matches an existing record
   * exactly, that session is returned and its provider/model fields are
   * updated to the requested values — useful for `aiden chat "title"` where
   * the user expects to land on the named session.
   */
  startSession(opts: StartSessionOptions): SessionRecord {
    if (opts.title) {
      const existing = this.findByExactTitle(opts.title);
      if (existing) {
        if (
          existing.providerId !== opts.providerId ||
          existing.modelId !== opts.modelId
        ) {
          this.store.updateSession(existing.id, {
            providerId: opts.providerId,
            modelId: opts.modelId,
          });
          const refreshed = this.store.getSession(existing.id);
          if (refreshed) return refreshed;
        }
        return existing;
      }
    }
    return this.store.createSession({
      title: opts.title,
      providerId: opts.providerId,
      modelId: opts.modelId,
    });
  }

  /** Most recently updated session, or null when the DB is empty. */
  resumeLatest(): SessionRecord | null {
    const list = this.store.listSessions({ limit: 1, orderBy: 'updated' });
    return list[0] ?? null;
  }

  /**
   * Resolve a query to a session. Matching strategy:
   * 1. Exact id match (UUID).
   * 2. Id prefix match — only if it's unambiguous.
   * 3. Case-insensitive substring match on title — newest wins on ties,
   *    null when the substring matches multiple distinct sessions
   *    ambiguously (caller should re-prompt).
   *
   * Returns null when no session matches at all.
   */
  resumeById(idOrTitle: string): SessionRecord | null {
    if (!idOrTitle || !idOrTitle.trim()) return null;
    const q = idOrTitle.trim();

    // 1. Exact id.
    const exact = this.store.getSession(q);
    if (exact) return exact;

    // Pull a recent slice to scan — covers the common case without a full
    // table scan for users with thousands of sessions.
    const candidates = this.store.listSessions({
      limit: 500,
      orderBy: 'updated',
    });

    // 2. Id prefix.
    const idPrefixHits = candidates.filter((s) => s.id.startsWith(q));
    if (idPrefixHits.length === 1) return idPrefixHits[0];
    if (idPrefixHits.length > 1) return null;

    // 3. Title substring (case-insensitive). Newest already first because
    //    listSessions ordered by updated_at DESC.
    const lower = q.toLowerCase();
    const titleHits = candidates.filter(
      (s) => s.title && s.title.toLowerCase().includes(lower),
    );
    if (titleHits.length === 0) return null;
    if (titleHits.length === 1) return titleHits[0];

    // Multiple title hits — only return the newest if its title equals the
    // query exactly, otherwise null (ambiguous).
    const exactTitleHits = titleHits.filter(
      (s) => s.title && s.title.toLowerCase() === lower,
    );
    if (exactTitleHits.length >= 1) return exactTitleHits[0];
    return null;
  }

  /**
   * Persist a finished AidenAgent turn. `messages` is the slice of new
   * messages emitted *this turn* — typically the user message that kicked
   * the turn off, plus the assistant + tool messages produced during the
   * inner provider loop. Tokens are accumulated atomically on the session
   * record.
   */
  recordTurn(
    sessionId: string,
    messages: Message[],
    usage: RecordTurnUsage,
    turnNumber?: number,
  ): void {
    for (const m of messages) {
      this.store.appendMessage(sessionId, messageToInput(m, turnNumber));
    }
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      this.store.addTokenUsage(sessionId, usage.inputTokens, usage.outputTokens);
    }
  }

  search(query: string, limit?: number): SessionSearchResult[] {
    return this.store.search(query, limit);
  }

  /**
   * Update the title of an existing session. Used by the CLI `/save` and
   * `/title` slash commands (Phase 14b). Returns true on success, false
   * when the id was not found.
   */
  setSessionTitle(sessionId: string, title: string): boolean {
    const existing = this.store.getSession(sessionId);
    if (!existing) return false;
    this.store.updateSession(sessionId, { title });
    return true;
  }

  /**
   * List recently-touched sessions, newest first. Pass-through to the
   * underlying store; defaults match the store's defaults. Used by the
   * `session_list` tool (Phase 7+) and by CLI `aiden sessions`.
   */
  listSessions(opts: { limit?: number; orderBy?: 'created' | 'updated' } = {}): SessionRecord[] {
    return this.store.listSessions(opts);
  }

  // ── Internals ────────────────────────────────────────────────────────

  private findByExactTitle(title: string): SessionRecord | null {
    const candidates = this.store.listSessions({ limit: 500, orderBy: 'updated' });
    return candidates.find((s) => s.title === title) ?? null;
  }
}

function messageToInput(m: Message, turnNumber?: number): AppendMessageInput {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content, turnNumber: turnNumber ?? null };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        toolCalls: m.toolCalls ?? null,
        turnNumber: turnNumber ?? null,
      };
    case 'tool':
      return {
        role: 'tool',
        content: m.content,
        toolCallId: m.toolCallId,
        turnNumber: turnNumber ?? null,
      };
  }
}
