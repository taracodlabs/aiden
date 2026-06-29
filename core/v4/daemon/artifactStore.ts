/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/artifactStore.ts — v4.11 artifact registry.
 *
 * Durable record of files Aiden produces, with provenance: each row links
 * an artifact back to the turn (run_id), task (task_id → goal), tool, and
 * action that created it. Populated automatically from the per-turn
 * `toolCallTrace` in chatSession.runAgentTurn — only successful,
 * verifier-ok file-producing tool calls (file_write/patch/move/copy +
 * skill writes) are registered. Reads/lists/deletes/shell-stdout are NOT
 * artifacts (high-signal registry, not a file-touch log).
 *
 * Factory pattern + same daemon.db handle as createTaskStore /
 * createRunStore. Migration v15 owns the table; this module owns the
 * read/write surface. Every write is best-effort at the call site
 * (observability must never break dispatch — same discipline as
 * taskStore / runStore.emitEventRich).
 */

import type { Db } from './db/connection';

/** What kind of thing the artifact is. Mirrors the ui_artifact_created enum. */
export type ArtifactKind = 'file' | 'skill' | 'directory';
/** How it came to be — drives the registry's at-a-glance verb column. */
export type ArtifactAction = 'create' | 'overwrite' | 'move' | 'copy';

export interface Artifact {
  id:         string;
  path:       string;
  kind:       ArtifactKind;
  tool:       string;
  action:     ArtifactAction;
  /** Originating turn (run_events run id). Null when unknown. */
  runId:      number | null;
  /** Originating task (→ goal). Null when no task substrate is wired. */
  taskId:     string | null;
  sessionId:  string;
  createdAt:  number;
  /** Byte size for files; null for directories / unknown. */
  bytes:      number | null;
  /** Short content/intent preview; null when none. */
  preview:    string | null;
}

/** Raw column shape from sqlite. */
interface ArtifactRowSql {
  id:          string;
  path:        string;
  kind:        string;
  tool:        string;
  action:      string;
  run_id:      number | null;
  task_id:     string | null;
  session_id:  string;
  created_at:  number;
  bytes:       number | null;
  preview:     string | null;
}

function rowToArtifact(r: ArtifactRowSql): Artifact {
  return {
    id:        r.id,
    path:      r.path,
    kind:      r.kind as ArtifactKind,
    tool:      r.tool,
    action:    r.action as ArtifactAction,
    runId:     r.run_id,
    taskId:    r.task_id,
    sessionId: r.session_id,
    createdAt: r.created_at,
    bytes:     r.bytes,
    preview:   r.preview,
  };
}

export interface CreateArtifactOptions {
  path:       string;
  kind:       ArtifactKind;
  tool:       string;
  action:     ArtifactAction;
  sessionId:  string;
  runId?:     number | null;
  taskId?:    string | null;
  bytes?:     number | null;
  preview?:   string | null;
}

export interface ListRecentArtifactsOptions {
  /** Scope to one session. Omit to list across ALL sessions (`/artifacts all`). */
  sessionId?: string;
  /** Cap at 5000 (hard) or 50 (default). */
  limit?:     number;
}

export interface ArtifactStore {
  /** Register a new artifact. Returns the generated id. */
  create(opts: CreateArtifactOptions): string;
  /** Read one artifact by id. Returns null when missing. */
  get(id: string): Artifact | null;
  /** Listing surface for /artifacts. Newest-first by created_at. */
  listRecent(opts?: ListRecentArtifactsOptions): Artifact[];
}

export interface CreateArtifactStoreOptions {
  db: Db;
}

/** Shape returned by extractFileArtifact — the registerable fields. */
export interface ExtractedArtifact {
  path:   string;
  kind:   ArtifactKind;
  action: ArtifactAction;
  bytes:  number | null;
}

/**
 * The file-producing tools whose successful results become artifacts, with
 * how to read the destination path + the action verb. Reads/lists/deletes
 * and shell stdout are deliberately absent — this is a "what Aiden made"
 * registry, not a file-touch log.
 */
const FILE_TOOLS: Readonly<Record<string, { kind: ArtifactKind; action: ArtifactAction; pathField: 'path' | 'to' }>> =
  Object.freeze({
    file_write:   { kind: 'file',  action: 'create',    pathField: 'path' },
    file_patch:   { kind: 'file',  action: 'overwrite', pathField: 'path' },
    file_move:    { kind: 'file',  action: 'move',      pathField: 'to'   },
    file_copy:    { kind: 'file',  action: 'copy',      pathField: 'to'   },
    skill_manage: { kind: 'skill', action: 'create',    pathField: 'path' },
  });

/**
 * Pure extraction: given a tool name + its result, return the registerable
 * artifact fields, or null when the tool isn't a file producer or the
 * result isn't a confirmed success. Gates on the tool's OWN `success:true`
 * — the caller additionally gates on the verifier verdict (don't register
 * a write the verifier flagged as failed). Extracted for unit testing.
 */
export function extractFileArtifact(toolName: string, result: unknown): ExtractedArtifact | null {
  const spec = FILE_TOOLS[toolName];
  if (!spec) return null;
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.success !== true) return null;
  const p = r[spec.pathField];
  if (typeof p !== 'string' || p.trim().length === 0) return null;
  const bytes = typeof r.bytes === 'number' ? r.bytes : null;
  return { path: p, kind: spec.kind, action: spec.action, bytes };
}

/** Minimal per-turn trace-entry shape the capture gate inspects. */
export interface TraceEntryLike {
  name:          string;
  result:        unknown;
  verification?: { ok: boolean } | undefined;
}

/**
 * The full capture decision for one toolCallTrace entry: register an
 * artifact only when the tool is a file producer that reported success
 * AND the verifier did not flag it failed. Returns the registerable
 * fields, or null to skip. Pure — the single source of truth the
 * chatSession capture loop and the unit tests both exercise.
 */
export function captureArtifactFromTrace(entry: TraceEntryLike): ExtractedArtifact | null {
  // Don't register a write the verifier flagged as failed.
  if (entry.verification && entry.verification.ok === false) return null;
  return extractFileArtifact(entry.name, entry.result);
}

/**
 * Generate an artifact id with the `art_` prefix for grep-ability +
 * crypto-strong randomness, matching the `task_<hex>` scheme.
 */
function newArtifactId(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('node:crypto');
  return `art_${(randomBytes(8) as Buffer).toString('hex')}`;
}

/** Preview cap — keep rows small under repeat writes. */
const PREVIEW_CAP = 200;

export function createArtifactStore(opts: CreateArtifactStoreOptions): ArtifactStore {
  const db = opts.db;
  return {
    create({ path, kind, tool, action, sessionId, runId, taskId, bytes, preview }) {
      const now = Date.now();
      const id = newArtifactId();
      db.prepare(
        `INSERT INTO artifacts (
           id, path, kind, tool, action,
           run_id, task_id, session_id, created_at, bytes, preview
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        path,
        kind,
        tool,
        action,
        runId   ?? null,
        taskId  ?? null,
        sessionId,
        now,
        typeof bytes === 'number' ? bytes : null,
        preview ? preview.slice(0, PREVIEW_CAP) : null,
      );
      return id;
    },
    get(id) {
      const r = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRowSql | undefined;
      return r ? rowToArtifact(r) : null;
    },
    listRecent(qOpts = {}) {
      const limit = Math.max(1, Math.min(qOpts.limit ?? 50, 5000));
      const where: string[]                = [];
      const params: Array<string | number> = [];
      if (qOpts.sessionId) {
        where.push('session_id = ?');
        params.push(qOpts.sessionId);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);
      const rows = db.prepare(
        `SELECT * FROM artifacts ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params) as ArtifactRowSql[];
      return rows.map(rowToArtifact);
    },
  };
}
