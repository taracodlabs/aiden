/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type Database from 'better-sqlite3';

const REQUIRED_TABLES = [
  'learning_sources',
  'learning_content_versions',
  'learning_events',
  'learning_entries',
  'learning_entry_sources',
  'learning_conflicts',
  'learning_fts',
] as const;

export interface LearningReadinessSnapshot {
  ready: boolean;
  entitled: boolean;
  tablesReady: boolean;
  ftsReady: boolean;
  projectionConsistent: boolean;
  privacyHealthy: boolean;
  retrievalHealthy: boolean;
  repairable: boolean;
  entries: number;
  eligibleEntries: number;
  indexedEntries: number;
  detail: string;
}

/** Read-only by construction: this function never runs migrations or repairs. */
export function snapshotLearningReadiness(input: {
  db: Database.Database;
  entitled: boolean;
  now?: () => number;
}): LearningReadinessSnapshot {
  const at = (input.now ?? Date.now)();
  const found = input.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
      AND name IN (${REQUIRED_TABLES.map(() => '?').join(',')})`,
  ).all(...REQUIRED_TABLES) as Array<{ name: string }>;
  const tablesReady = found.length === REQUIRED_TABLES.length;
  if (!tablesReady) {
    return {
      ready: false,
      entitled: input.entitled,
      tablesReady: false,
      ftsReady: false,
      projectionConsistent: false,
      privacyHealthy: false,
      retrievalHealthy: false,
      repairable: false,
      entries: 0,
      eligibleEntries: 0,
      indexedEntries: 0,
      detail: 'Learning database migration is incomplete.',
    };
  }

  let ftsReady = true;
  try {
    input.db.prepare("SELECT COUNT(*) AS count FROM learning_fts WHERE learning_fts MATCH 'readiness'").get();
  } catch {
    ftsReady = false;
  }
  const entries = (input.db.prepare('SELECT COUNT(*) AS count FROM learning_entries').get() as { count: number }).count;
  const eligibleEntries = (input.db.prepare(
    `SELECT COUNT(*) AS count FROM learning_entries
      WHERE eligible=1 AND lifecycle='ACTIVE' AND confidence<>'CANDIDATE' AND content IS NOT NULL
        AND (expires_at IS NULL OR expires_at>?)`,
  ).get(at) as { count: number }).count;
  const indexedEntries = ftsReady
    ? (input.db.prepare(
      `SELECT COUNT(DISTINCT f.entry_id) AS count FROM learning_fts f
        JOIN learning_entries e ON e.entry_id=f.entry_id
       WHERE e.eligible=1 AND e.lifecycle='ACTIVE' AND e.confidence<>'CANDIDATE'
         AND e.content IS NOT NULL AND (e.expires_at IS NULL OR e.expires_at>?)`,
    ).get(at) as { count: number }).count
    : 0;
  const staleIndexEntries = ftsReady
    ? (input.db.prepare(
      `SELECT COUNT(DISTINCT f.entry_id) AS count FROM learning_fts f
        LEFT JOIN learning_entries e ON e.entry_id=f.entry_id
       WHERE e.entry_id IS NULL OR e.eligible<>1 OR e.lifecycle<>'ACTIVE' OR e.confidence='CANDIDATE'
          OR e.content IS NULL OR (e.expires_at IS NOT NULL AND e.expires_at<=?)`,
    ).get(at) as { count: number }).count
    : 0;
  const projectionDrift = (input.db.prepare(
    `SELECT COUNT(*) AS count FROM learning_entries e
       LEFT JOIN (
         SELECT ev.* FROM learning_events ev
          JOIN (SELECT entry_id,MAX(event_sequence) AS seq FROM learning_events GROUP BY entry_id) latest
            ON latest.entry_id=ev.entry_id AND latest.seq=ev.event_sequence
       ) le ON le.entry_id=e.entry_id
      WHERE le.entry_id IS NULL
         OR e.state_version<>le.entry_version
         OR e.confidence<>le.confidence
         OR e.lifecycle<>le.lifecycle
         OR e.current_version_id IS NOT le.version_id
         OR e.expires_at IS NOT le.expires_at
         OR e.content_digest IS NOT le.content_digest`,
  ).get() as { count: number }).count;
  const privacyLeaks = (input.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM learning_entries WHERE lifecycle='DELETED' AND content IS NOT NULL)
       + (SELECT COUNT(*) FROM learning_content_versions cv
            JOIN learning_entries e ON e.entry_id=cv.entry_id WHERE e.lifecycle='DELETED')
       + (SELECT COUNT(*) FROM learning_fts f
            JOIN learning_entries e ON e.entry_id=f.entry_id WHERE e.lifecycle='DELETED') AS count`,
  ).get() as { count: number }).count;
  const projectionConsistent = projectionDrift === 0;
  const privacyHealthy = privacyLeaks === 0;
  const retrievalHealthy = ftsReady && indexedEntries === eligibleEntries && staleIndexEntries === 0;
  const ready = input.entitled && tablesReady && ftsReady && projectionConsistent && privacyHealthy && retrievalHealthy;
  const detail = !input.entitled
    ? 'Learning capture and retrieval are unavailable; existing data remains available to inspect, export, archive, and delete.'
    : !privacyHealthy
      ? 'Learning privacy projection needs repair.'
      : !projectionConsistent || !retrievalHealthy
        ? 'Learning projection needs repair.'
        : `${entries} learned item(s); ${eligibleEntries} available for bounded context retrieval.`;
  return {
    ready,
    entitled: input.entitled,
    tablesReady,
    ftsReady,
    projectionConsistent,
    privacyHealthy,
    retrievalHealthy,
    repairable: tablesReady && ftsReady && (!projectionConsistent || !privacyHealthy || !retrievalHealthy),
    entries,
    eligibleEntries,
    indexedEntries,
    detail,
  };
}
