/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createSkillIntelligenceAuthority } from '../../../core/v4/skillIntelligence';
import { projectSkillIntelligenceObservations } from '../../../core/v4/skillIntelligence/presenceProjection';
import { skillIntelligenceDoctorResults } from '../../../cli/v4/doctor';
import { createWorkbenchSkillIntelligencePort } from '../../../core/v4/workbench/skillIntelligencePort';

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function fixture(enabled = true) {
  db = new Database(':memory:');
  runMigrations(db);
  const authority = createSkillIntelligenceAuthority({
    db,
    enabled,
    ownerId: 'owner_1',
    defaultScopeId: 'workspace_1',
    now: () => 100,
    idFactory: (() => {
      let value = 0;
      return (prefix: string) => `${prefix}_${++value}`;
    })(),
  });
  return { authority };
}

describe('Skill Intelligence product surfaces', () => {
  it('uses one centralized Pro entitlement without granting Capability permissions', () => {
    expect(buildEditionAuthority('community').can('skill.intelligence')).toBe(false);
    expect(buildEditionAuthority('pro').can('skill.intelligence')).toBe(true);
  });

  it('keeps management and Doctor inspection available when intelligence is disabled', () => {
    const { authority } = fixture(false);
    const port = createWorkbenchSkillIntelligencePort({
      authority,
      edition: buildEditionAuthority('community'),
      scopeId: 'workspace_1',
      ownerId: 'owner_1',
    });
    expect(port.snapshot()).toMatchObject({
      enabled: false,
      candidates: [],
      drafts: [],
      active: [],
      doctor: { schemaReady: true },
    });
    expect(() => port.createDraft({
      candidateId: 'candidate_missing', name: 'blocked', description: 'blocked',
      steps: [{ id: 'one', operation: 'read' }], expectedEvidence: ['readback'],
    })).toThrow(/Pro|enabled/i);
    const checks = skillIntelligenceDoctorResults(authority.doctor());
    expect(checks.map((check) => check.name)).toEqual([
      'skill intelligence schema',
      'workflow patterns',
      'skill candidates',
      'active skill pointers',
      'skill prerequisites and drift',
    ]);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it('projects typed, deduplicable Presence observations only for meaningful attention', () => {
    const { authority } = fixture(true);
    const observations = projectSkillIntelligenceObservations({
      authority,
      scopeId: 'workspace_1',
      ownerId: 'owner_1',
    });
    expect(observations).toEqual([]);
  });

  it('keeps Workbench review and management records inside the exact workspace scope', () => {
    const { authority } = fixture(true);
    db!.prepare(
      `INSERT INTO workflow_patterns (
         workflow_pattern_id,owner_id,workspace_id,project_id,pattern_digest,objective_class,
         scope_kind,normalized_steps_json,required_capabilities_json,observed_count,verified_count,
         failure_count,unknown_count,independent_positive_count,confidence,state,state_version,
         created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'pattern_workspace_2', 'owner_1', 'workspace_2', null, 'workspace-2-digest',
      'foreign-workflow', 'workspace', '[{"index":0,"operation":"read","kind":"tool","mutates":false}]',
      '[]', 3, 3, 0, 0, 3, 1, 'eligible', 1, 100, 100,
    );
    db!.prepare(
      `INSERT INTO skill_candidates (
         skill_candidate_id,owner_id,scope_id,workflow_pattern_id,candidate_digest,proposed_name,
         purpose,steps_json,capability_requirements_json,positive_trace_ids_json,
         negative_trace_ids_json,learning_entry_ids_json,state,executable,state_version,
         created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'candidate',0,1,?,?)`,
    ).run(
      'candidate_workspace_2', 'owner_1', 'workspace_2', 'pattern_workspace_2',
      'candidate-workspace-2-digest', 'foreign-method', 'Foreign workspace method.',
      '[{"id":"step_1","operation":"read","kind":"tool","mutates":false}]',
      '[]', '[]', '[]', '[]', 100, 100,
    );
    expect(projectSkillIntelligenceObservations({
      authority,
      scopeId: 'workspace_1',
      ownerId: 'owner_1',
    }).some((observation) => observation.sourceIdentity === 'candidate:candidate_workspace_2')).toBe(false);
    const port = createWorkbenchSkillIntelligencePort({
      authority,
      edition: buildEditionAuthority('pro'),
      scopeId: 'workspace_1',
      ownerId: 'owner_1',
    });

    expect(port.snapshot().candidates).toEqual([]);
    expect(() => port.reviewCandidate('candidate_workspace_2')).toThrow(/scope|workspace/i);
    expect(() => port.dismissCandidate({ candidateId: 'candidate_workspace_2', expectedVersion: 1 }))
      .toThrow(/scope|workspace/i);
    expect(() => port.createDraft({
      candidateId: 'candidate_workspace_2',
      name: 'foreign-method',
      description: 'Must not cross scope.',
      steps: [{ id: 'step_1', operation: 'read', kind: 'tool', mutates: false }],
      expectedEvidence: ['readback'],
    })).toThrow(/scope|workspace/i);
  });

  it('projects stable candidate, degradation, rollback and drift attention from exact durable identity', () => {
    const { authority } = fixture(true);
    db!.prepare(
      `INSERT INTO workflow_patterns (
         workflow_pattern_id,owner_id,workspace_id,project_id,pattern_digest,objective_class,
         scope_kind,normalized_steps_json,required_capabilities_json,observed_count,verified_count,
         failure_count,unknown_count,independent_positive_count,confidence,state,state_version,
         created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'pattern_presence', 'owner_1', 'workspace_1', null, 'pattern-digest',
      'repository-inspection', 'workspace', '[]', '[]', 3, 3, 0, 0, 3, 1,
      'eligible', 1, 100, 100,
    );
    db!.prepare(
      `INSERT INTO skill_candidates (
         skill_candidate_id,owner_id,scope_id,workflow_pattern_id,candidate_digest,proposed_name,
         purpose,steps_json,capability_requirements_json,positive_trace_ids_json,
         negative_trace_ids_json,learning_entry_ids_json,state,executable,state_version,
         created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'candidate',0,1,?,?)`,
    ).run(
      'candidate_presence', 'owner_1', 'workspace_1', 'pattern_presence', 'candidate-digest',
      'repository-inspection-method', 'Reviewed method.', '[]', '[]',
      '["trace_1","trace_2","trace_3"]', '[]', '[]', 100, 100,
    );

    const v1 = authority.importLegacy({
      content: '---\nname: presence-method\ndescription: First reviewed method.\nversion: 1\n---\n\n# First\n',
      source: 'reviewed-local', sourcePath: '<durable-v1>', scopeId: 'workspace_1', trustLevel: 'builtin',
    });
    const v2 = authority.importLegacy({
      content: '---\nname: presence-method\ndescription: Second reviewed method.\nversion: 2\n---\n\n# Second\n',
      source: 'reviewed-local', sourcePath: '<durable-v2>', scopeId: 'workspace_1', trustLevel: 'builtin',
    });
    for (let index = 0; index < 5; index += 1) {
      db!.prepare(
        `INSERT INTO skill_invocations (
           skill_invocation_id,skill_id,skill_version_id,content_digest,scope_id,job_id,
           attempt_id,generation,tool_call_id,capability_versions_json,composition_path_json,
           fallback_from_invocation_id,state,started_at,terminal_at
         ) VALUES (?,?,?,?,?,?,?,?,?,'[]','[]',NULL,'failed',?,?)`,
      ).run(
        `invocation_presence_${index}`, v2.skillId, v2.id, v2.digest, 'workspace_1',
        `job_presence_${index}`, `attempt_presence_${index}`, 1, `tool_presence_${index}`,
        100 + index, 100 + index,
      );
      db!.prepare(
        `INSERT INTO skill_version_outcomes (
           skill_outcome_id,skill_id,skill_version_id,job_id,invocation_ids_json,attempt_ids_json,
           generations_json,capability_versions_json,evidence_ids_json,outcome,verdict,attributable,
           reason,recorded_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,'verification_failure','failed',1,'verified mismatch',?,?)`,
      ).run(
        `outcome_presence_${index}`, v2.skillId, v2.id, `job_presence_${index}`,
        `["invocation_presence_${index}"]`, `["attempt_presence_${index}"]`, '[1]', '[]',
        `["evidence_presence_${index}"]`, 100 + index, 100 + index,
      );
    }

    const first = projectSkillIntelligenceObservations({
      authority, scopeId: 'workspace_1', ownerId: 'owner_1', now: 500,
    });
    const repeated = projectSkillIntelligenceObservations({
      authority, scopeId: 'workspace_1', ownerId: 'owner_1', now: 600,
    });
    const active = first.filter((observation) => observation.active);
    expect(active).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceIdentity: 'candidate:candidate_presence',
        reasonCode: 'skill_candidate_ready',
      }),
      expect.objectContaining({
        sourceIdentity: `health:${v2.id}`,
        reasonCode: 'skill_version_degraded',
        recommendedAction: 'Review outcomes and rollback target',
      }),
    ]));
    expect(new Set(first.map((observation) => observation.sourceIdentity)).size).toBe(first.length);
    expect(repeated.map(({ sourceIdentity, sourceRevision, active: isActive }) => ({
      sourceIdentity, sourceRevision, active: isActive,
    }))).toEqual(first.map(({ sourceIdentity, sourceRevision, active: isActive }) => ({
      sourceIdentity, sourceRevision, active: isActive,
    })));
    expect(authority.rollbackTarget(v2.skillId, 'workspace_1')?.id).toBe(v1.id);
    expect(authority.doctor()).toMatchObject({ degraded: 1, drifted: 0 });

    const pointer = authority.listPointers('workspace_1')[0]!;
    authority.markPointerDrift({
      skillId: pointer.skillId,
      scopeId: pointer.scopeId,
      expectedVersion: pointer.stateVersion,
    });
    const drifted = projectSkillIntelligenceObservations({
      authority, scopeId: 'workspace_1', ownerId: 'owner_1', now: 700,
    });
    expect(drifted).toContainEqual(expect.objectContaining({
      sourceIdentity: `drift:${v2.skillId}:workspace_1`,
      reasonCode: 'skill_version_drift',
      active: true,
    }));
    expect(authority.doctor()).toMatchObject({ degraded: 0, drifted: 1 });
  });
});
