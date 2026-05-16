/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/email/seenUids.ts — v4.5 Phase 4a.
 *
 * In-memory bounded UID dedup set. Hot-path "have we seen this
 * UID in the current daemon session?" check.
 *
 * Bounded at MAX (default 2000) — when we cross MAX, drop the
 * lower half. IMAP UIDs are monotonic per UIDVALIDITY, so old
 * UIDs are safe to drop: the IMAP server's `\Seen` flag is the
 * cross-restart authority, and our `email_seen` SQLite table
 * is the cross-restart forensic trail. The in-memory set is
 * just a fast filter to avoid round-tripping every UID to
 * `email_seen` on every poll.
 *
 * Per-trigger instance — each email trigger has its own SeenUids.
 */

export const DEFAULT_MAX_SEEN_UIDS = 2000;

export interface SeenUids {
  has(uid: number):  boolean;
  add(uid: number):  void;
  /** Bulk seed (e.g. from UID SEARCH ALL on connect). */
  seed(uids: ReadonlyArray<number>): void;
  /** Diagnostic. */
  size(): number;
  /** Trim to bound. No-op when under cap. */
  trim(): { dropped: number };
  /** Test helper. */
  reset(): void;
}

export function createSeenUids(maxSize: number = DEFAULT_MAX_SEEN_UIDS): SeenUids {
  const set: Set<number> = new Set();

  const trim = (): { dropped: number } => {
    if (set.size <= maxSize) return { dropped: 0 };
    // Drop the LOWER half — IMAP UIDs monotonic per UIDVALIDITY.
    // Sort ascending; keep the upper half (newer UIDs).
    const sorted = [...set].sort((a, b) => a - b);
    const keep = sorted.slice(Math.floor(sorted.length / 2));
    const dropped = sorted.length - keep.length;
    set.clear();
    for (const u of keep) set.add(u);
    return { dropped };
  };

  return {
    has(uid: number): boolean { return set.has(uid); },
    add(uid: number): void {
      set.add(uid);
      if (set.size > maxSize) trim();
    },
    seed(uids: ReadonlyArray<number>): void {
      for (const u of uids) set.add(u);
      if (set.size > maxSize) trim();
    },
    size(): number { return set.size; },
    trim,
    reset(): void { set.clear(); },
  };
}
