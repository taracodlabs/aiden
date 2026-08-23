/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createSkillIntelligenceAuthority } from '../../../core/v4/skillIntelligence';
import { digest, stableJson } from '../../../core/v4/skillIntelligence/normalization';

const TRACE_COUNT = 10_000;
const PATTERN_COUNT = 1_000;
const ACTIVE_SKILL_COUNT = 1_000;
const OUTCOME_COUNT = 10_000;
const MAX_OPERATION_MS = 2_500;

function fixedDigest(value: number): string {
  return value.toString(16).padStart(64, '0');
}

describe('Skill Intelligence bounded synthetic scale', () => {
  let db: Database.Database;
  let authority: ReturnType<typeof createSkillIntelligenceAuthority>;
  let fixtureHeapBytes = 0;
  const now = Date.parse('2026-08-23T12:00:00.000Z');
  const steps = [{ index: 0, operation: 'file-read', kind: 'tool', mutates: false }] as const;
  const firstPatternDigest = digest({
    objectiveClass: 'tool-file-read',
    scopeKind: 'workspace',
    normalizedSteps: steps,
    requiredCapabilities: [],
    effectClasses: [],
  });

  beforeAll(() => {
    const heapBefore = process.memoryUsage().heapUsed;
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const insertPattern = db.prepare(
      `INSERT INTO workflow_patterns (
         workflow_pattern_id,owner_id,workspace_id,project_id,pattern_digest,objective_class,
         scope_kind,normalized_steps_json,required_capabilities_json,observed_count,verified_count,
         failure_count,unknown_count,independent_positive_count,confidence,state,state_version,
         created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertTrace = db.prepare(
      `INSERT INTO workflow_traces (
         workflow_trace_id,owner_id,workspace_id,project_id,job_id,attempt_id,generation,
         automation_occurrence_id,independent_key,pattern_digest,objective_class,scope_kind,
         normalized_steps_json,skill_invocation_ids_json,capability_invocation_ids_json,
         required_capabilities_json,effect_ids_json,effect_classes_json,evidence_ids_json,
         learning_entry_ids_json,classification,verdict,source_digest,observed_at,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertPatternTrace = db.prepare(
      `INSERT INTO workflow_pattern_traces (
         workflow_pattern_id,workflow_trace_id,classification,independent_key,linked_at
       ) VALUES (?,?,?,?,?)`,
    );
    const insertCandidate = db.prepare(
      `INSERT INTO skill_candidates (
         skill_candidate_id,owner_id,scope_id,workflow_pattern_id,candidate_digest,proposed_name,
         purpose,steps_json,capability_requirements_json,positive_trace_ids_json,
         negative_trace_ids_json,learning_entry_ids_json,state,executable,state_version,
         created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'candidate',0,1,?,?)`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO skill_versions (
         skill_version_id,skill_id,version_number,content_digest,canonical_spec_json,
         capability_requirements_json,composition_json,skill_evaluation_id,skill_approval_id,
         workflow_pattern_id,skill_candidate_id,source_kind,source_path,trust_level,legacy,created_at
       ) VALUES (?,?,?,?,?,'[]','[]',NULL,NULL,NULL,NULL,'intelligence',NULL,NULL,0,?)`,
    );
    const insertPointer = db.prepare(
      `INSERT INTO skill_active_pointers (
         skill_id,scope_id,skill_version_id,content_digest,enabled,drift_state,state_version,activated_at
       ) VALUES (?,?,?,?,1,'clean',1,?)`,
    );
    const insertOutcome = db.prepare(
      `INSERT INTO skill_version_outcomes (
         skill_outcome_id,skill_id,skill_version_id,job_id,invocation_ids_json,attempt_ids_json,
         generations_json,capability_versions_json,evidence_ids_json,outcome,verdict,attributable,
         reason,recorded_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    db.transaction(() => {
      for (let patternIndex = 0; patternIndex < PATTERN_COUNT; patternIndex += 1) {
        const patternId = `pattern_scale_${patternIndex}`;
        const patternDigest = patternIndex === 0 ? firstPatternDigest : fixedDigest(patternIndex + 1);
        const positiveIds: string[] = [];
        const negativeIds: string[] = [];
        insertPattern.run(
          patternId, 'owner_scale', 'workspace_scale', null, patternDigest,
          patternIndex === 0 ? 'tool-file-read' : `repository-pattern-${patternIndex}`,
          'workspace', stableJson(steps), '[]',
          10, 7, 2, 1, 7, 7 / 9, 'eligible', 1, now + patternIndex, now + patternIndex,
        );
        for (let traceOffset = 0; traceOffset < TRACE_COUNT / PATTERN_COUNT; traceOffset += 1) {
          const traceIndex = patternIndex * (TRACE_COUNT / PATTERN_COUNT) + traceOffset;
          const traceId = `trace_scale_${traceIndex}`;
          const classification = traceOffset < 7 ? 'positive' : traceOffset < 9 ? 'negative' : 'unknown';
          if (classification === 'positive') positiveIds.push(traceId);
          if (classification === 'negative') negativeIds.push(traceId);
          insertTrace.run(
            traceId, 'owner_scale', 'workspace_scale', null, `job_scale_${traceIndex}`,
            `attempt_scale_${traceIndex}`, 1, null, `job:job_scale_${traceIndex}`, patternDigest,
            `repository-pattern-${patternIndex}`, 'workspace', stableJson(steps), '[]', '[]',
            '[]', '[]', '[]', stableJson([`evidence_scale_${traceIndex}`]), '[]', classification,
            classification === 'positive' ? 'verified' : classification === 'negative' ? 'failed' : 'unknown',
            fixedDigest(TRACE_COUNT + traceIndex), now + traceIndex, now + traceIndex,
          );
          insertPatternTrace.run(
            patternId, traceId, classification, `job:job_scale_${traceIndex}`, now + traceIndex,
          );
        }
        insertCandidate.run(
          `candidate_scale_${patternIndex}`, 'owner_scale', 'workspace_scale', patternId,
          fixedDigest(30_000 + patternIndex), `repository-pattern-${patternIndex}-method`,
          'Reviewed deterministic scale fixture.',
          stableJson([{ id: 'step_1', operation: 'file-read', kind: 'tool', mutates: false }]),
          '[]', stableJson(positiveIds), stableJson(negativeIds), '[]', now + patternIndex, now + patternIndex,
        );
      }

      for (let skillIndex = 0; skillIndex < ACTIVE_SKILL_COUNT; skillIndex += 1) {
        const skillId = `skill_scale_${skillIndex}`;
        const versionId = `skill_version_scale_${skillIndex}`;
        const contentDigest = fixedDigest(50_000 + skillIndex);
        insertVersion.run(
          versionId, skillId, 1, contentDigest,
          stableJson({
            frontmatter: {
              name: `managed-skill-${skillIndex}`,
              description: 'Synthetic reviewed Skill.',
              version: '1',
            },
            procedure: { steps: [] },
          }),
          now + skillIndex,
        );
        insertPointer.run(skillId, 'workspace_scale', versionId, contentDigest, now + skillIndex);
      }

      for (let outcomeIndex = 0; outcomeIndex < OUTCOME_COUNT; outcomeIndex += 1) {
        const success = outcomeIndex < 8_000;
        insertOutcome.run(
          `skill_outcome_scale_${outcomeIndex}`, 'skill_scale_0', 'skill_version_scale_0',
          `outcome_job_scale_${outcomeIndex}`, stableJson([`invocation_scale_${outcomeIndex}`]),
          stableJson([`attempt_outcome_scale_${outcomeIndex}`]), '[1]', '[]',
          stableJson([`evidence_outcome_scale_${outcomeIndex}`]),
          success ? 'verified_success' : 'verification_failure',
          success ? 'verified' : 'failed', 1, null, now + outcomeIndex, now + outcomeIndex,
        );
      }
    }).immediate();

    authority = createSkillIntelligenceAuthority({
      db,
      enabled: true,
      ownerId: 'owner_scale',
      defaultScopeId: 'workspace_scale',
      now: () => now + TRACE_COUNT + 1,
      idFactory: (prefix) => `${prefix}_incremental`,
    });
    fixtureHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  }, 30_000);

  afterAll(() => db.close());

  it('updates one indexed pattern without scanning unrelated Job history', () => {
    const jobId = 'job_scale_incremental';
    db.prepare(
      `INSERT INTO tasks (
         id,title,goal,status,created_at,updated_at,session_id,state_version,root_job_id,
         entry_point,source,workspace_id,terminal_at,terminal_outcome,finish_reason
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      jobId, 'Repository pattern 0', 'Bounded scale fixture', 'completed', now, now,
      'session_scale', 1, jobId, 'test', 'test', 'workspace_scale', now, 'verified', 'verified',
    );
    db.prepare(
      `INSERT INTO tool_calls (
         tool_call_id,job_id,attempt_id,generation,tool_name,normalized_args_digest,
         risk_tier,mutates,state,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'tool_scale_incremental', jobId, 'attempt_scale_incremental', 1, 'file_read',
      fixedDigest(90_001), 'safe', 0, 'completed', now, now,
    );
    db.prepare(
      `INSERT INTO job_evidence (
         evidence_id,job_id,attempt_id,generation,source,producer,captured_at,observed_at,
         integrity_sha256,coverage,verification_result,payload_json,late
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    ).run(
      'evidence_scale_incremental', jobId, 'attempt_scale_incremental', 1, 'test', 'fixture',
      now, now, fixedDigest(90_002), 'complete', 'verified', '{}',
    );
    db.prepare(
      `INSERT INTO job_verdicts (job_id,attempt_id,generation,verdict,summary_json,finalized_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(jobId, 'attempt_scale_incremental', 1, 'verified', '{}', now);

    const started = performance.now();
    const observed = authority.observeJob(jobId);
    const elapsedMs = performance.now() - started;

    expect(observed.pattern.id).toBe('pattern_scale_0');
    expect(observed.pattern.observedCount).toBe(11);
    expect(observed.pattern.verifiedCount).toBe(8);
    expect(observed.candidate?.positiveTraceIds).toContain('trace_incremental');
    expect(elapsedMs).toBeLessThan(MAX_OPERATION_MS);
  });

  it('looks up one candidate through exact identity at 1k-candidate scale', () => {
    const started = performance.now();
    const review = authority.reviewCandidate('candidate_scale_500');
    const elapsedMs = performance.now() - started;

    expect(review.candidate.id).toBe('candidate_scale_500');
    expect(review.pattern.id).toBe('pattern_scale_500');
    expect(review.traces).toHaveLength(9);
    expect(elapsedMs).toBeLessThan(MAX_OPERATION_MS);
  });

  it('selects one exact active Skill from 1k immutable versions', () => {
    const started = performance.now();
    const selected = authority.resolveActiveByName('managed-skill-999', 'workspace_scale');
    const elapsedMs = performance.now() - started;

    expect(selected?.skillId).toBe('skill_scale_999');
    expect(selected?.version.id).toBe('skill_version_scale_999');
    expect(elapsedMs).toBeLessThan(MAX_OPERATION_MS);
  });

  it('aggregates 10k exact version outcomes with bounded memory and time', () => {
    const started = performance.now();
    const health = authority.getHealth('skill_version_scale_0');
    const elapsedMs = performance.now() - started;

    expect(health).toMatchObject({
      state: 'healthy',
      attributableSamples: OUTCOME_COUNT,
      successes: 8_000,
      failures: 2_000,
      unknowns: 0,
      failureRate: 0.2,
    });
    expect(elapsedMs).toBeLessThan(MAX_OPERATION_MS);
    expect(fixtureHeapBytes).toBeLessThan(256 * 1024 * 1024);
  });
});
