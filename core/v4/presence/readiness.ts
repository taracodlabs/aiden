/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type Database from 'better-sqlite3';
import type { EditionAuthority } from '../commercial/edition';

export interface PresenceReadinessSnapshot {
  ready: boolean;
  entitled: boolean;
  tablesReady: boolean;
  activeItems: number;
  detail: string;
}

export function snapshotPresenceReadiness(input: {
  db: Database.Database;
  entitled: boolean;
}): PresenceReadinessSnapshot {
  const required = ['presence_items', 'presence_item_events', 'attention_preferences', 'presence_proposed_jobs'];
  const tables = input.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => '?').join(',')})`,
  ).all(...required) as Array<{ name: string }>;
  const tablesReady = tables.length === required.length;
  const activeItems = tablesReady
    ? (input.db.prepare(`SELECT COUNT(*) AS count FROM presence_items WHERE state IN ('active','snoozed')`).get() as { count: number }).count
    : 0;
  const ready = input.entitled && tablesReady;
  return {
    ready, entitled: input.entitled, tablesReady, activeItems,
    detail: !input.entitled ? 'Agentic Presence requires Aiden Pro.'
      : !tablesReady ? 'Agentic Presence database migration is incomplete.'
      : `${activeItems} durable attention item(s) are currently active.`,
  };
}

export function createPresenceReadinessAuthority(input: {
  db: Database.Database;
  edition: EditionAuthority;
}): { snapshot(): PresenceReadinessSnapshot } {
  return {
    snapshot: () => snapshotPresenceReadiness({ db: input.db, entitled: input.edition.can('presence.active') }),
  };
}
