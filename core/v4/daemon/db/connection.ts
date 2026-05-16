/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/db/connection.ts — v4.5 Phase 1: SQLite handle.
 *
 * Single better-sqlite3 connection per process keyed by db path.
 * Synchronous — better-sqlite3 is sync by design. Wraps the
 * connection with the daemon's standard pragma set:
 *
 *   journal_mode = WAL      — durable + concurrent reads with one writer
 *   synchronous  = NORMAL   — fsync at WAL checkpoint, not per commit
 *                             (durable across process crash, may lose
 *                             last commits on OS crash — acceptable)
 *   foreign_keys = ON       — enforce FK constraints
 *   busy_timeout = 5000     — auto-retry on SQLITE_BUSY for 5s
 *
 * On test isolation: use `:memory:` to get a per-test database.
 *
 * The connection is registered with the resource registry (Phase 1)
 * so shutdown drain closes it via the standard reap path.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { runMigrations } from './migrations';

export type Db = Database.Database;

const _open: Map<string, Db> = new Map();

/**
 * Open (or return cached) database at `dbPath`. Creates parent dirs
 * if missing. Runs migrations to latest version. Idempotent for a
 * given path.
 *
 * Pass ':memory:' for tests.
 */
export function openDaemonDb(dbPath: string): Db {
  const cached = _open.get(dbPath);
  if (cached && cached.open) return cached;
  if (dbPath !== ':memory:') {
    try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); }
    catch { /* tolerate — open will surface a clearer error */ }
  }
  const db: Db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  _open.set(dbPath, db);
  // v4.5 Phase 3 — daemon.db stores webhook secrets (raw, required
  // for HMAC computation). Lock the file mode to user-only on POSIX
  // so a co-tenant on the same machine can't read the secrets out.
  // On Windows the file already lives in user-private
  // %LOCALAPPDATA%; chmod is a no-op there (Node ignores Unix bits).
  // Idempotent — safe to call on every boot.
  if (dbPath !== ':memory:' && process.platform !== 'win32') {
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
    // WAL/SHM siblings receive identical protection.
    for (const ext of ['-wal', '-shm']) {
      try { fs.chmodSync(dbPath + ext, 0o600); } catch { /* may not exist yet */ }
    }
  }
  return db;
}

/** Close the cached connection at `dbPath`. Idempotent. */
export function closeDaemonDb(dbPath: string): void {
  const db = _open.get(dbPath);
  if (!db) return;
  try { if (db.open) db.close(); } catch { /* best-effort */ }
  _open.delete(dbPath);
}

/** Test-only — close every open handle. */
export function _closeAllDaemonDbsForTests(): void {
  for (const [p, db] of _open) {
    try { if (db.open) db.close(); } catch { /* noop */ }
    _open.delete(p);
  }
}
