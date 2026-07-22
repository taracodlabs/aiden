/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/sessionStore.ts — Aiden v4.0.0
 *
 * SQLite + FTS5 session persistence. Replaces v3.x's per-session JSONL
 * files and `workspace/semantic.json`. One sessions.db at the Aiden root
 * holds every session's metadata, every message, and an FTS5 index for
 * `session_search`.
 *
 * Design choices:
 * - WAL journal mode for one-writer / many-reader concurrency.
 * - foreign_keys=ON so deleting a session cascades to its messages.
 * - FTS5 triggers keep `messages_fts` in sync with `messages`. v4.12 CS.1:
 *   the indexed cell is `content` + serialized `tool_calls`, so a session is
 *   findable by a tool name / command / target in a tool call (intent recall),
 *   not just prose. Schema changes go through the user_version migrate() path.
 * - WAL checkpoint on close() so the file doesn't grow unbounded across
 *   short-lived CLI runs.
 *
 * Status: PHASE 6.
 *
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { Message, ToolCallRequest } from '../../providers/v4/types';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface SessionRecord {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  providerId: string | null;
  modelId: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  metadata: Record<string, unknown>;
}

export interface MessageRecord {
  id: number;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolCalls: ToolCallRequest[] | null;
  toolCallId: string | null;
  createdAt: number;
  turnNumber: number | null;
}

export interface CreateSessionOptions {
  title?: string;
  providerId?: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendMessageInput {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRequest[] | null;
  toolCallId?: string | null;
  turnNumber?: number | null;
}

export interface ListSessionsOptions {
  limit?: number;
  orderBy?: 'created' | 'updated';
}

export interface SessionSearchResult {
  sessionId: string;
  title: string | null;
  matchedContent: string;
  matchedAt: number;
  score: number;
}

export interface ActiveSessionState {
  messages: Message[];
  compressionCount: number;
  cumulativeUsage: { inputTokens: number; outputTokens: number };
  budgetState: Record<string, unknown> | null;
}

/** v4.12 CS.1 — session_search options. */
export interface SearchOptions {
  limit?: number;
  /** Include noisy `tool`-role output in results. Default false (user+assistant only). */
  includeToolOutput?: boolean;
  /** 'relevance' = BM25 (default); 'newest'/'oldest' = by message time. */
  order?: 'relevance' | 'newest' | 'oldest';
}

export interface SessionUpdate {
  title?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at INTEGER NOT NULL,
  turn_number INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS session_active_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  messages_json TEXT NOT NULL,
  compression_count INTEGER NOT NULL DEFAULT 0,
  cumulative_input_tokens INTEGER NOT NULL DEFAULT 0,
  cumulative_output_tokens INTEGER NOT NULL DEFAULT 0,
  budget_state_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  message_id UNINDEXED
);
`;

// v4.12 CS.1 — the FTS index cell is content + serialized tool_calls (so a
// session is findable by a tool name / command / target in a tool call, not
// just prose). The triggers are OWNED BY THE MIGRATION (not SCHEMA_SQL) so the
// definition can evolve via the user_version rebuild path below — CREATE TRIGGER
// IF NOT EXISTS can't update an already-created trigger on an existing DB.
const FTS_SYNC_TRIGGERS_SQL = `
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, session_id, message_id)
  VALUES (new.id, new.content || ' ' || COALESCE(new.tool_calls, ''), new.session_id, new.id);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  UPDATE messages_fts SET content = new.content || ' ' || COALESCE(new.tool_calls, '')
  WHERE rowid = old.id;
END;
`;

/** Bump when the FTS index definition or schema changes; drives migrate(). */
const SCHEMA_VERSION = 1;

interface SessionRow {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  provider_id: string | null;
  model_id: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  metadata: string;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: number;
  turn_number: number | null;
}

interface SearchRow {
  session_id: string;
  title: string | null;
  snippet: string;
  matched_at: number;
  score: number;
}

/**
 * Sanitise user-supplied search input so unbalanced FTS5 syntax can't
 * raise a `SQLITE_ERROR`. Phase 6 only needs keyword search — no
 * trigram or boolean-operator handling.
 */
function sanitizeFtsQuery(input: string): string {
  let s = input;
  // Strip FTS5 special chars that would otherwise need quoting.
  s = s.replace(/[+{}()"^]/g, ' ');
  // Collapse repeated stars and drop leading stars (illegal as prefix-only).
  s = s.replace(/\*+/g, '*').replace(/(^|\s)\*/g, '$1');
  // Remove dangling boolean operators that desyntax FTS5.
  s = s.replace(/^(AND|OR|NOT)\s+/i, '');
  s = s.replace(/\s+(AND|OR|NOT)$/i, '');
  return s.trim();
}

export class SessionStore {
  private readonly db: DatabaseType;

  // Prepared statements — cached for hot-path inserts.
  private readonly insertSessionStmt: Statement;
  private readonly insertMessageStmt: Statement;
  private readonly getSessionStmt: Statement;
  private readonly deleteSessionStmt: Statement;
  private readonly listMessagesStmt: Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    this.migrate(); // installs FTS triggers + reindexes when the schema version lags

    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (
        id, title, created_at, updated_at,
        provider_id, model_id,
        total_input_tokens, total_output_tokens,
        metadata
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
    `);
    this.insertMessageStmt = this.db.prepare(`
      INSERT INTO messages (
        session_id, role, content, tool_calls, tool_call_id,
        created_at, turn_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.getSessionStmt = this.db.prepare(
      `SELECT * FROM sessions WHERE id = ?`,
    );
    this.deleteSessionStmt = this.db.prepare(
      `DELETE FROM sessions WHERE id = ?`,
    );
    this.listMessagesStmt = this.db.prepare(
      `SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC`,
    );
  }

  // ── Migrations ───────────────────────────────────────────────────────

  /**
   * v4.12 CS.1 — user_version-driven migration. Idempotent: guarded by
   * PRAGMA user_version, so re-running on an up-to-date DB is a no-op (no
   * double-indexing). v1 installs the content+tool_calls FTS triggers AND
   * rebuilds messages_fts from the existing corpus, so already-stored sessions
   * become findable by their tool_calls — not just newly-appended messages.
   */
  private migrate(): void {
    const current = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (current >= SCHEMA_VERSION) return;
    this.db.transaction(() => {
      if (current < 1) {
        this.db.exec(FTS_SYNC_TRIGGERS_SQL);
        // Full reindex: drop the (content-only) FTS rows and rebuild every row
        // as content + tool_calls so pre-existing history is reindexed too.
        this.db.exec('DELETE FROM messages_fts;');
        this.db.exec(
          `INSERT INTO messages_fts(rowid, content, session_id, message_id)
           SELECT id, content || ' ' || COALESCE(tool_calls, ''), session_id, id FROM messages;`,
        );
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  // ── Session lifecycle ────────────────────────────────────────────────

  createSession(opts: CreateSessionOptions = {}): SessionRecord {
    const now = Date.now();
    const id = randomUUID();
    this.insertSessionStmt.run(
      id,
      opts.title ?? null,
      now,
      now,
      opts.providerId ?? null,
      opts.modelId ?? null,
      JSON.stringify(opts.metadata ?? {}),
    );
    return {
      id,
      title: opts.title ?? null,
      createdAt: now,
      updatedAt: now,
      providerId: opts.providerId ?? null,
      modelId: opts.modelId ?? null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      metadata: opts.metadata ?? {},
    };
  }

  getSession(id: string): SessionRecord | null {
    const row = this.getSessionStmt.get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  updateSession(id: string, updates: SessionUpdate): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];

    if ('title' in updates) {
      sets.push('title = ?');
      params.push(updates.title ?? null);
    }
    if ('providerId' in updates) {
      sets.push('provider_id = ?');
      params.push(updates.providerId ?? null);
    }
    if ('modelId' in updates) {
      sets.push('model_id = ?');
      params.push(updates.modelId ?? null);
    }
    if (typeof updates.totalInputTokens === 'number') {
      sets.push('total_input_tokens = ?');
      params.push(updates.totalInputTokens);
    }
    if (typeof updates.totalOutputTokens === 'number') {
      sets.push('total_output_tokens = ?');
      params.push(updates.totalOutputTokens);
    }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
    }

    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * Atomically add to running token totals. Used by SessionManager.recordTurn
   * so concurrent writers don't clobber each other's counts.
   */
  addTokenUsage(id: string, inputDelta: number, outputDelta: number): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET total_input_tokens = total_input_tokens + ?,
             total_output_tokens = total_output_tokens + ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(inputDelta, outputDelta, Date.now(), id);
  }

  deleteSession(id: string): void {
    this.deleteSessionStmt.run(id);
  }

  listSessions(opts: ListSessionsOptions = {}): SessionRecord[] {
    const orderCol = opts.orderBy === 'created' ? 'created_at' : 'updated_at';
    const limit = opts.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY ${orderCol} DESC LIMIT ?`)
      .all(limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  // ── Messages ─────────────────────────────────────────────────────────

  appendMessage(sessionId: string, msg: AppendMessageInput): MessageRecord {
    const now = Date.now();
    const toolCallsJson = msg.toolCalls && msg.toolCalls.length > 0
      ? JSON.stringify(msg.toolCalls)
      : null;
    const info = this.insertMessageStmt.run(
      sessionId,
      msg.role,
      msg.content,
      toolCallsJson,
      msg.toolCallId ?? null,
      now,
      msg.turnNumber ?? null,
    );
    // Bump the parent session's updated_at so listSessions sorts correctly.
    this.db
      .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
      .run(now, sessionId);
    return {
      id: Number(info.lastInsertRowid),
      sessionId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls && msg.toolCalls.length > 0 ? msg.toolCalls : null,
      toolCallId: msg.toolCallId ?? null,
      createdAt: now,
      turnNumber: msg.turnNumber ?? null,
    };
  }

  getMessages(sessionId: string): MessageRecord[] {
    const rows = this.listMessagesStmt.all(sessionId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  setActiveState(sessionId: string, state: ActiveSessionState): void {
    this.db.prepare(
      `INSERT INTO session_active_state (
         session_id, messages_json, compression_count,
         cumulative_input_tokens, cumulative_output_tokens,
         budget_state_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         messages_json = excluded.messages_json,
         compression_count = excluded.compression_count,
         cumulative_input_tokens = excluded.cumulative_input_tokens,
         cumulative_output_tokens = excluded.cumulative_output_tokens,
         budget_state_json = excluded.budget_state_json,
         updated_at = excluded.updated_at`,
    ).run(
      sessionId,
      JSON.stringify(state.messages),
      Math.max(0, Math.floor(state.compressionCount)),
      Math.max(0, Math.floor(state.cumulativeUsage.inputTokens)),
      Math.max(0, Math.floor(state.cumulativeUsage.outputTokens)),
      state.budgetState ? JSON.stringify(state.budgetState) : null,
      Date.now(),
    );
  }

  getActiveState(sessionId: string): ActiveSessionState | null {
    const row = this.db.prepare(
      `SELECT messages_json, compression_count, cumulative_input_tokens,
              cumulative_output_tokens, budget_state_json
       FROM session_active_state WHERE session_id = ?`,
    ).get(sessionId) as {
      messages_json: string;
      compression_count: number;
      cumulative_input_tokens: number;
      cumulative_output_tokens: number;
      budget_state_json: string | null;
    } | undefined;
    if (!row) return null;
    try {
      return {
        messages: JSON.parse(row.messages_json) as Message[],
        compressionCount: row.compression_count,
        cumulativeUsage: {
          inputTokens: row.cumulative_input_tokens,
          outputTokens: row.cumulative_output_tokens,
        },
        budgetState: row.budget_state_json
          ? JSON.parse(row.budget_state_json) as Record<string, unknown>
          : null,
      };
    } catch {
      return null;
    }
  }

  recordTurnWithActiveState(
    sessionId: string,
    messages: AppendMessageInput[],
    usage: { inputTokens: number; outputTokens: number },
    activeState: ActiveSessionState,
  ): void {
    this.db.transaction(() => {
      for (const message of messages) this.appendMessage(sessionId, message);
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        this.addTokenUsage(sessionId, usage.inputTokens, usage.outputTokens);
      }
      this.setActiveState(sessionId, activeState);
    })();
  }

  // ── Search ───────────────────────────────────────────────────────────

  search(query: string, opts: SearchOptions | number = {}): SessionSearchResult[] {
    // Back-compat: search(query, 20) still works (legacy numeric limit).
    const o: SearchOptions = typeof opts === 'number' ? { limit: opts } : opts;
    const limit = o.limit ?? 20;
    if (!query || !query.trim()) return [];
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    // Role filter: default user+assistant; tool output is noisy → opt-in only.
    const roles = o.includeToolOutput ? ['user', 'assistant', 'tool'] : ['user', 'assistant'];
    const rolePlaceholders = roles.map(() => '?').join(',');
    // Ordering: BM25 relevance (default), or by message time.
    const orderBy = o.order === 'newest' ? 'm.created_at DESC'
      : o.order === 'oldest' ? 'm.created_at ASC'
      : 'rank';

    const sql = `
      SELECT
        m.session_id           AS session_id,
        s.title                AS title,
        snippet(messages_fts, 0, '>>>', '<<<', '...', 16) AS snippet,
        m.created_at           AS matched_at,
        bm25(messages_fts)     AS score
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ? AND m.role IN (${rolePlaceholders})
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    let rows: SearchRow[];
    try {
      rows = this.db.prepare(sql).all(sanitized, ...roles, limit) as SearchRow[];
    } catch {
      // Malformed query that survived sanitization — return empty rather
      // than surfacing the SQLITE_ERROR. Tests cover the edge case.
      return [];
    }
    return rows.map((r) => ({
      sessionId: r.session_id,
      title: r.title,
      matchedContent: r.snippet,
      matchedAt: r.matched_at,
      score: r.score,
    }));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  close(): void {
    try {
      this.db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // best-effort
    }
    this.db.close();
  }
}

function rowToSession(row: SessionRow): SessionRecord {
  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt metadata — surface as empty object rather than throwing
      // mid-list. The original blob can be inspected via raw SQL.
    }
  }
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providerId: row.provider_id,
    modelId: row.model_id,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    metadata,
  };
}

function rowToMessage(row: MessageRow): MessageRecord {
  let toolCalls: ToolCallRequest[] | null = null;
  if (row.tool_calls) {
    try {
      const parsed = JSON.parse(row.tool_calls) as unknown;
      if (Array.isArray(parsed)) toolCalls = parsed as ToolCallRequest[];
    } catch {
      toolCalls = null;
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    toolCalls,
    toolCallId: row.tool_call_id,
    createdAt: row.created_at,
    turnNumber: row.turn_number,
  };
}
