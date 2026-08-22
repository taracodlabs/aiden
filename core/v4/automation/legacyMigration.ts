/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import { createAutomationAuthority } from './automationAuthority';
import type { AutomationRevisionSpec } from './types';

type LegacyRow = {
  id: string; name: string; schedule_expression: string; timezone: string;
  enabled: number; payload_json: string; misfire_policy: string;
  catch_up_limit: number | null; grace_ms: number | null; created_at: number;
  next_fire_at: number | null;
};

export interface LegacyAutomationMigrationResult {
  imported: number;
  updated: number;
  existing: number;
  skipped: number;
  errors: readonly string[];
}

function projectLegacySpec(row: LegacyRow): AutomationRevisionSpec {
  const payload = JSON.parse(row.payload_json) as { action?: unknown; description?: unknown };
  const actionText = typeof payload.action === 'string' ? payload.action : '';
  if (!actionText.trim()) throw new Error(`Legacy schedule ${row.id} has no action`);
  const misfire = row.misfire_policy === 'catch_up_with_limit'
    ? { kind: 'catch_up' as const, maxOccurrences: Math.max(1, Math.min(row.catch_up_limit ?? 10, 100)), maxAgeMs: row.grace_ms ?? undefined }
    : row.misfire_policy === 'run_once_if_late'
      ? { kind: 'run_once' as const, maxAgeMs: row.grace_ms ?? undefined }
      : { kind: 'skip' as const };
  return {
    action: { kind: 'prompt', prompt: actionText },
    trigger: { kind: 'schedule', expression: row.schedule_expression, timezone: row.timezone || 'UTC' },
    policies: { misfire, overlap: 'queue', retry: { maxAttempts: 3 } },
    capabilities: [], credentialRefs: [],
  };
}

export function importLegacyScheduledWorkflows(options: {
  db: Database.Database;
  createdBy?: string;
  now?: number;
}): LegacyAutomationMigrationResult {
  const { db } = options;
  const authority = createAutomationAuthority({ db });
  const rows = db.prepare('SELECT * FROM scheduled_workflows ORDER BY created_at,id').all() as LegacyRow[];
  let imported = 0;
  let updated = 0;
  let existing = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const row of rows) {
    const sourceDigest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    const prior = db.prepare(
      `SELECT source_digest,automation_id,revision_id FROM automation_migration_receipts
        WHERE source_kind = 'scheduled_workflow' AND source_identity = ?`,
    ).get(row.id) as { source_digest: string; automation_id: string; revision_id: string } | undefined;
    if (prior?.source_digest === sourceDigest) {
      existing += 1;
      continue;
    }
    try {
      const spec = projectLegacySpec(row);
      const projectedAt = options.now ?? Date.now();
      db.transaction(() => {
        const projection = prior
          ? authority.revise(prior.automation_id, spec, {
              createdBy: options.createdBy ?? 'legacy-schedule-import', now: projectedAt,
            })
          : authority.create({
              name: row.name, ...spec,
              createdBy: options.createdBy ?? 'legacy-schedule-import',
              now: row.created_at || options.now,
            });
        authority.setEnabled(projection.definition.id, row.enabled === 1, projectedAt);
        if (row.next_fire_at !== null) {
          db.prepare('UPDATE automation_trigger_bindings SET next_fire_at = ?,updated_at = ? WHERE revision_id = ?')
            .run(new Date(row.next_fire_at).toISOString(), projectedAt, projection.revision.id);
        }
        if (prior) {
          db.prepare(
            `UPDATE automation_migration_receipts
                SET source_digest = ?,revision_id = ?,imported_at = ?
              WHERE source_kind = 'scheduled_workflow' AND source_identity = ?`,
          ).run(sourceDigest, projection.revision.id, projectedAt, row.id);
        } else {
          db.prepare(
            `INSERT INTO automation_migration_receipts
               (source_kind,source_identity,source_digest,automation_id,revision_id,imported_at)
             VALUES ('scheduled_workflow',?,?,?,?,?)`,
          ).run(row.id, sourceDigest, projection.definition.id, projection.revision.id, projectedAt);
        }
      }).immediate();
      if (prior) updated += 1;
      else imported += 1;
    } catch (error) {
      skipped += 1;
      errors.push(`Legacy schedule ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imported, updated, existing, skipped, errors };
}
