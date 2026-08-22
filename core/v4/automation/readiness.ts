/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type Database from 'better-sqlite3';
import type { EditionAuthority } from '../commercial/edition';

export interface AutomationReadinessSnapshot {
  ready: boolean;
  entitled: boolean;
  detail: string;
  tablesReady: boolean;
  schedulerBindings: number;
  enabledAutomations: number;
  credentialsReady: number;
  credentialsAttention: number;
  timezoneReady: boolean;
  occurrencesAttention: number;
}

export function snapshotAutomationReadiness(options: {
  db: Database.Database;
  entitled: boolean;
}): AutomationReadinessSnapshot {
  const required = ['automation_definitions', 'automation_revisions', 'automation_occurrences', 'automation_trigger_bindings'];
  const existing = options.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${required.map(() => '?').join(',')})`,
  ).all(...required) as Array<{ name: string }>;
  const tablesReady = existing.length === required.length;
  let schedulerBindings = 0;
  let enabledAutomations = 0;
  let occurrencesAttention = 0;
  const credentialRefs = new Set<string>();
  if (tablesReady) {
    schedulerBindings = (options.db.prepare(
      `SELECT COUNT(*) AS count FROM automation_trigger_bindings b
        JOIN automation_definitions d ON d.automation_id = b.automation_id
       WHERE b.enabled = 1 AND d.enabled = 1`,
    ).get() as { count: number }).count;
    const revisions = options.db.prepare(
      `SELECT r.spec_json FROM automation_definitions d
        JOIN automation_revisions r ON r.revision_id = d.current_revision_id
       WHERE d.enabled = 1`,
    ).all() as Array<{ spec_json: string }>;
    enabledAutomations = revisions.length;
    for (const row of revisions) {
      try {
        const parsed = JSON.parse(row.spec_json) as { credentialRefs?: unknown };
        if (Array.isArray(parsed.credentialRefs)) {
          for (const ref of parsed.credentialRefs) if (typeof ref === 'string') credentialRefs.add(ref);
        }
      } catch { /* immutable validation prevents this in healthy databases */ }
    }
    occurrencesAttention = (options.db.prepare(
      `SELECT COUNT(*) AS count FROM automation_occurrences
        WHERE state IN ('waiting_approval','blocked','unknown','failed')`,
    ).get() as { count: number }).count;
  }
  let credentialsReady = 0;
  let credentialsAttention = 0;
  for (const ref of credentialRefs) {
    const credential = options.db.prepare(
      `SELECT 1 AS ready FROM integration_secret_handles WHERE secret_handle = ? AND status = 'active'
       UNION ALL
       SELECT 1 AS ready FROM connected_accounts
        WHERE account_id = ? AND status = 'active' AND health = 'healthy'
       LIMIT 1`,
    ).get(ref, ref) as { ready: number } | undefined;
    if (credential) credentialsReady += 1;
    else credentialsAttention += 1;
  }
  let timezoneReady = true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
  catch { timezoneReady = false; }
  const ready = options.entitled && tablesReady && timezoneReady && credentialsAttention === 0;
  return {
    ready, entitled: options.entitled, tablesReady, schedulerBindings, enabledAutomations,
    credentialsReady, credentialsAttention, timezoneReady, occurrencesAttention,
    detail: !options.entitled ? 'Reliable Automations require Aiden Pro.'
      : !tablesReady ? 'Automation database migration is incomplete.'
      : !timezoneReady ? 'IANA timezone support is unavailable.'
      : credentialsAttention > 0 ? `${credentialsAttention} automation credential reference(s) require reconnection.`
      : `${enabledAutomations} enabled automation(s) · ${schedulerBindings} active trigger binding(s) · ${occurrencesAttention} occurrence(s) need attention.`,
  };
}

export function createAutomationReadinessAuthority(options: {
  db: Database.Database;
  edition: EditionAuthority;
}): { snapshot(): AutomationReadinessSnapshot } {
  return {
    snapshot() {
      return snapshotAutomationReadiness({
        db: options.db,
        entitled: options.edition.can('automation.create'),
      });
    },
  };
}
