/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS_FOR_TESTS,
  runMigrations,
} from '../../../core/v4/daemon/db/migrations';

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe('Skill Intelligence migration v53', () => {
  it('upgrades v52 additively with immutable versions and one scoped active pointer', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS_FOR_TESTS.filter((entry) => entry.version <= 52)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db!);
        else db!.exec(migration.sql ?? '');
        db!.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)')
          .run(migration.version, 1);
      }).immediate();
    }

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_traces'").get())
      .toBeUndefined();
    expect(runMigrations(db)).toEqual({ from: 52, to: 53 });
    expect(LATEST_SCHEMA_VERSION).toBe(53);

    const expected = [
      'workflow_traces', 'workflow_patterns', 'workflow_pattern_traces',
      'skill_candidates', 'skill_drafts', 'skill_evaluations',
      'skill_management_approvals', 'skill_versions', 'skill_active_pointers',
      'skill_activation_history', 'skill_invocations', 'skill_version_outcomes',
    ];
    for (const table of expected) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
        .toEqual({ name: table });
    }
    const traceColumns = (db.prepare('PRAGMA table_info(workflow_traces)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(traceColumns).toEqual(expect.arrayContaining([
      'skill_invocation_ids_json', 'capability_invocation_ids_json', 'effect_ids_json',
    ]));
    const invocationColumns = (db.prepare('PRAGMA table_info(skill_invocations)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(invocationColumns).toContain('scope_id');
    const outcomeColumns = (db.prepare('PRAGMA table_info(skill_version_outcomes)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(outcomeColumns).toContain('learning_projected_at');
    const evaluationColumns = (db.prepare('PRAGMA table_info(skill_evaluations)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(evaluationColumns).toEqual(expect.arrayContaining([
      'source_fixture_digest', 'source_fixtures_json',
    ]));

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_skill_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_skill_candidates_state',
      'idx_skill_drafts_candidate',
      'idx_skill_approvals_exact_open',
      'idx_skill_invocations_job',
      'idx_skill_invocations_version_scope',
      'idx_skill_outcomes_version',
      'idx_skill_pointers_version_scope',
      'idx_skill_versions_identity',
    ]));

    expect(runMigrations(db)).toEqual({ from: 53, to: 53 });
  });
});
