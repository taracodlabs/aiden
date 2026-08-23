/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Durable Skill Intelligence authority. This module manages reviewed method
 * metadata only. It never executes draft content and never grants Capability
 * permissions; active versions are consumed by the ordinary Job runtime.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { satisfies } from 'semver';

import { parseSkillContent } from '../skillSpec';
import { SkillSecurityScanner } from '../skillSecurityScanner';
import {
  assertNoExecutableCode,
  assertNoSensitiveContent,
  digest,
  normalizedIdentifier,
  parseJson,
  stableJson,
  uniqueSorted,
} from './normalization';
import type {
  CapabilityRequirement,
  NormalizedWorkflowStep,
  ResolvedCapabilityVersion,
  ResolvedSkillVersion,
  SkillCandidate,
  SkillActivePointer,
  SkillDraft,
  SkillDraftStep,
  SkillEvaluation,
  SkillEvaluationCheck,
  SkillEvaluationFixture,
  SkillIntelligenceDoctor,
  SkillInvocation,
  SkillManagementApproval,
  SkillVersion,
  SkillVersionHealth,
  SkillVersionOutcome,
  WorkflowPattern,
  WorkflowTrace,
  WorkflowTraceClassification,
} from './types';

const EVALUATOR_VERSION = 1;
const MIN_INDEPENDENT_VERIFIED_TRACES = 3;
const MIN_REUSABLE_SUCCESS_RATIO = 0.6;
const MAX_STEPS = 64;
const MAX_COMPOSITION_DEPTH = 3;
const MAX_CHILD_SKILLS = 8;
const MAX_FALLBACKS = 4;
const MAX_TOTAL_FALLBACK_EDGES = 16;
const MIN_HEALTH_SAMPLES = 5;

type Db = Database.Database;
type IdFactory = (prefix: string) => string;

export interface SkillIntelligenceAuthorityOptions {
  db: Db;
  enabled: boolean;
  ownerId: string;
  defaultScopeId: string;
  now?: () => number;
  idFactory?: IdFactory;
}

export interface SkillOutcomeProjection {
  outcome: SkillVersionOutcome;
  invocation: SkillInvocation;
  version: SkillVersion;
}

interface TaskRow {
  id: string;
  status: string;
  workspace_id: string | null;
  automation_occurrence_id: string | null;
  terminal_at: number | null;
  terminal_outcome: string | null;
}

interface VerdictRow {
  attempt_id: string;
  generation: number;
  verdict: string;
  finalized_at: number;
}

interface TraceRow {
  workflow_trace_id: string;
  owner_id: string;
  workspace_id: string | null;
  project_id: string | null;
  job_id: string;
  attempt_id: string;
  generation: number;
  automation_occurrence_id: string | null;
  independent_key: string;
  pattern_digest: string;
  objective_class: string;
  scope_kind: string;
  normalized_steps_json: string;
  skill_invocation_ids_json: string;
  capability_invocation_ids_json: string;
  required_capabilities_json: string;
  effect_ids_json: string;
  effect_classes_json: string;
  evidence_ids_json: string;
  learning_entry_ids_json: string;
  classification: WorkflowTraceClassification;
  verdict: string;
  source_digest: string;
  observed_at: number;
}

interface PatternRow {
  workflow_pattern_id: string;
  owner_id: string;
  workspace_id: string | null;
  project_id: string | null;
  pattern_digest: string;
  objective_class: string;
  scope_kind: string;
  normalized_steps_json: string;
  required_capabilities_json: string;
  observed_count: number;
  verified_count: number;
  failure_count: number;
  unknown_count: number;
  independent_positive_count: number;
  confidence: number;
  state: WorkflowPattern['state'];
  state_version: number;
  created_at: number;
  updated_at: number;
}

interface CandidateRow {
  skill_candidate_id: string;
  owner_id: string;
  scope_id: string;
  workflow_pattern_id: string;
  candidate_digest: string;
  proposed_name: string;
  purpose: string;
  steps_json: string;
  capability_requirements_json: string;
  positive_trace_ids_json: string;
  negative_trace_ids_json: string;
  learning_entry_ids_json: string;
  state: SkillCandidate['state'];
  executable: number;
  state_version: number;
  created_at: number;
  updated_at: number;
}

interface DraftRow {
  skill_draft_id: string;
  skill_id: string;
  skill_candidate_id: string | null;
  owner_id: string;
  scope_id: string;
  name: string;
  description: string;
  steps_json: string;
  capability_requirements_json: string;
  composition_json: string;
  expected_evidence_json: string;
  canonical_spec_json: string;
  content_digest: string;
  state: SkillDraft['state'];
  executable: number;
  state_version: number;
  created_at: number;
  updated_at: number;
}

interface EvaluationRow {
  skill_evaluation_id: string;
  skill_draft_id: string;
  draft_digest: string;
  evaluation_digest: string;
  evaluator_version: number;
  capability_environment_digest: string;
  source_fixture_digest: string;
  source_fixtures_json: string;
  result_json: string;
  passed: number;
  state: SkillEvaluation['state'];
  started_at: number;
  completed_at: number | null;
}

interface ApprovalRow {
  skill_approval_id: string;
  skill_id: string;
  skill_draft_id: string;
  skill_evaluation_id: string;
  owner_id: string;
  scope_id: string;
  draft_digest: string;
  evaluation_digest: string;
  capability_requirements_digest: string;
  state: SkillManagementApproval['state'];
  requested_by: string;
  requested_at: number;
  decided_by: string | null;
  decided_at: number | null;
  state_version: number;
}

interface VersionRow {
  skill_version_id: string;
  skill_id: string;
  version_number: number;
  content_digest: string;
  canonical_spec_json: string;
  capability_requirements_json: string;
  composition_json: string;
  skill_evaluation_id: string | null;
  skill_approval_id: string | null;
  workflow_pattern_id: string | null;
  skill_candidate_id: string | null;
  source_kind: SkillVersion['sourceKind'];
  source_path: string | null;
  trust_level: string | null;
  legacy: number;
  created_at: number;
}

interface InvocationRow {
  skill_invocation_id: string;
  skill_id: string;
  skill_version_id: string;
  content_digest: string;
  scope_id: string;
  job_id: string;
  attempt_id: string;
  generation: number;
  tool_call_id: string;
  capability_versions_json: string;
  composition_path_json: string;
  fallback_from_invocation_id: string | null;
  state: SkillInvocation['state'];
  started_at: number;
  terminal_at: number | null;
}

interface OutcomeRow {
  skill_outcome_id: string;
  skill_id: string;
  skill_version_id: string;
  job_id: string;
  invocation_ids_json: string;
  attempt_ids_json: string;
  generations_json: string;
  capability_versions_json: string;
  evidence_ids_json: string;
  outcome: string;
  verdict: string;
  attributable: number;
  reason: string | null;
  learning_projected_at: number | null;
  recorded_at: number;
  updated_at: number;
}

function traceFromRow(row: TraceRow): WorkflowTrace {
  return {
    id: row.workflow_trace_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    generation: row.generation,
    automationOccurrenceId: row.automation_occurrence_id,
    independentKey: row.independent_key,
    patternDigest: row.pattern_digest,
    objectiveClass: row.objective_class,
    scopeKind: row.scope_kind,
    normalizedSteps: parseJson(row.normalized_steps_json),
    skillInvocationIds: parseJson(row.skill_invocation_ids_json),
    capabilityInvocationIds: parseJson(row.capability_invocation_ids_json),
    requiredCapabilities: parseJson(row.required_capabilities_json),
    effectIds: parseJson(row.effect_ids_json),
    effectClasses: parseJson(row.effect_classes_json),
    evidenceIds: parseJson(row.evidence_ids_json),
    learningEntryIds: parseJson(row.learning_entry_ids_json),
    classification: row.classification,
    verdict: row.verdict,
    sourceDigest: row.source_digest,
    observedAt: row.observed_at,
  };
}

function draftFromRow(row: DraftRow): SkillDraft {
  return {
    id: row.skill_draft_id,
    skillId: row.skill_id,
    candidateId: row.skill_candidate_id,
    ownerId: row.owner_id,
    scopeId: row.scope_id,
    name: row.name,
    description: row.description,
    steps: parseJson(row.steps_json),
    capabilityRequirements: parseJson(row.capability_requirements_json),
    composition: parseJson(row.composition_json),
    expectedEvidence: parseJson(row.expected_evidence_json),
    canonicalSpec: parseJson(row.canonical_spec_json),
    digest: row.content_digest,
    state: row.state,
    executable: false,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function evaluationFromRow(row: EvaluationRow): SkillEvaluation {
  return {
    id: row.skill_evaluation_id,
    draftId: row.skill_draft_id,
    draftDigest: row.draft_digest,
    digest: row.evaluation_digest,
    evaluatorVersion: row.evaluator_version,
    capabilityEnvironmentDigest: row.capability_environment_digest,
    sourceFixtureDigest: row.source_fixture_digest,
    sourceFixtures: parseJson(row.source_fixtures_json),
    checks: parseJson(row.result_json),
    passed: row.passed === 1,
    state: row.state,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function approvalFromRow(row: ApprovalRow): SkillManagementApproval {
  return {
    id: row.skill_approval_id,
    skillId: row.skill_id,
    draftId: row.skill_draft_id,
    evaluationId: row.skill_evaluation_id,
    ownerId: row.owner_id,
    scopeId: row.scope_id,
    draftDigest: row.draft_digest,
    evaluationDigest: row.evaluation_digest,
    capabilityRequirementsDigest: row.capability_requirements_digest,
    state: row.state,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    stateVersion: row.state_version,
  };
}

function versionFromRow(row: VersionRow): SkillVersion {
  return {
    id: row.skill_version_id,
    skillId: row.skill_id,
    version: row.version_number,
    digest: row.content_digest,
    canonicalSpec: parseJson(row.canonical_spec_json),
    capabilityRequirements: parseJson(row.capability_requirements_json),
    composition: parseJson(row.composition_json),
    evaluationId: row.skill_evaluation_id,
    approvalId: row.skill_approval_id,
    patternId: row.workflow_pattern_id,
    candidateId: row.skill_candidate_id,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    trustLevel: row.trust_level,
    legacy: row.legacy === 1,
    createdAt: row.created_at,
  };
}

function invocationFromRow(row: InvocationRow): SkillInvocation {
  return {
    id: row.skill_invocation_id,
    skillId: row.skill_id,
    skillVersionId: row.skill_version_id,
    digest: row.content_digest,
    scopeId: row.scope_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    generation: row.generation,
    toolCallId: row.tool_call_id,
    capabilityVersions: parseJson(row.capability_versions_json),
    compositionPath: parseJson(row.composition_path_json),
    fallbackFromInvocationId: row.fallback_from_invocation_id,
    state: row.state,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
  };
}

function outcomeFromRow(row: OutcomeRow): SkillVersionOutcome {
  return {
    id: row.skill_outcome_id,
    skillId: row.skill_id,
    skillVersionId: row.skill_version_id,
    jobId: row.job_id,
    invocationIds: parseJson(row.invocation_ids_json),
    attemptIds: parseJson(row.attempt_ids_json),
    generations: parseJson(row.generations_json),
    capabilityVersions: parseJson(row.capability_versions_json),
    evidenceIds: parseJson(row.evidence_ids_json),
    outcome: row.outcome,
    verdict: row.verdict,
    attributable: row.attributable === 1,
    reason: row.reason,
    learningProjectedAt: row.learning_projected_at,
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at,
  };
}

export class SkillIntelligenceAuthority {
  private readonly now: () => number;
  private readonly idFactory: IdFactory;
  private readonly securityScanner = new SkillSecurityScanner();
  private outcomeProjector: ((projection: SkillOutcomeProjection) => void) | undefined;

  constructor(private readonly options: SkillIntelligenceAuthorityOptions) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}_${digest(`${prefix}\0${Date.now()}\0${Math.random()}`).slice(0, 24)}`);
  }

  setOutcomeProjector(projector: ((projection: SkillOutcomeProjection) => void) | undefined): void {
    this.outcomeProjector = projector;
    if (projector) this.reconcilePendingLearningProjections();
  }

  reconcilePendingLearningProjections(): { projected: number; pending: number } {
    const pendingJobs = (this.options.db.prepare(
      `SELECT DISTINCT job_id FROM skill_version_outcomes
       WHERE attributable=1 AND learning_projected_at IS NULL
         AND lower(outcome) IN ('verified_success','verified','success')
       ORDER BY job_id`,
    ).all() as Array<{ job_id: string }>);
    if (!this.outcomeProjector) return { projected: 0, pending: pendingJobs.length };
    let projected = 0;
    for (const row of pendingJobs) {
      const before = (this.options.db.prepare(
        `SELECT COUNT(*) AS value FROM skill_version_outcomes
         WHERE job_id=? AND attributable=1 AND learning_projected_at IS NULL
           AND lower(outcome) IN ('verified_success','verified','success')`,
      ).get(row.job_id) as { value: number }).value;
      try {
        this.reconcileLearningProjections(row.job_id);
      } catch {
        continue;
      }
      const after = (this.options.db.prepare(
        `SELECT COUNT(*) AS value FROM skill_version_outcomes
         WHERE job_id=? AND attributable=1 AND learning_projected_at IS NULL
           AND lower(outcome) IN ('verified_success','verified','success')`,
      ).get(row.job_id) as { value: number }).value;
      projected += Math.max(0, before - after);
    }
    const pending = (this.options.db.prepare(
      `SELECT COUNT(*) AS value FROM skill_version_outcomes
       WHERE attributable=1 AND learning_projected_at IS NULL
         AND lower(outcome) IN ('verified_success','verified','success')`,
    ).get() as { value: number }).value;
    return { projected, pending };
  }

  observeJob(jobId: string): { trace: WorkflowTrace; pattern: WorkflowPattern; candidate: SkillCandidate | null; duplicate: boolean } {
    this.requireEnabled();
    const existing = this.options.db.prepare(
      'SELECT * FROM workflow_traces WHERE owner_id=? AND job_id=?',
    ).get(this.options.ownerId, jobId) as TraceRow | undefined;
    if (existing) {
      const trace = traceFromRow(existing);
      const pattern = this.getPatternByDigest(trace.workspaceId, trace.patternDigest);
      const candidate = pattern.state === 'eligible'
        ? this.ensureCandidate(pattern)
        : this.getCandidateForPattern(pattern.id);
      return { trace, pattern: this.getPatternById(pattern.id), candidate, duplicate: true };
    }

    const job = this.options.db.prepare('SELECT * FROM tasks WHERE id=?').get(jobId) as TaskRow | undefined;
    if (!job || job.terminal_at === null) throw new Error('Only a terminal Job can become a WorkflowTrace');
    const durableVerdict = this.options.db.prepare(
      'SELECT attempt_id,generation,verdict,finalized_at FROM job_verdicts WHERE job_id=? ORDER BY generation DESC,finalized_at DESC LIMIT 1',
    ).get(jobId) as VerdictRow | undefined;
    const latestAttempt = this.options.db.prepare(
      'SELECT attempt_id,generation FROM runs WHERE task_id=? ORDER BY generation DESC,id DESC LIMIT 1',
    ).get(jobId) as { attempt_id: string; generation: number } | undefined;
    const attempt = durableVerdict ?? latestAttempt;
    if (!attempt) throw new Error('Terminal Job has no durable Attempt');
    const verdict = durableVerdict?.verdict ?? job.terminal_outcome ?? job.status;
    const finalizedAt = durableVerdict?.finalized_at ?? job.terminal_at;

    const toolRows = this.options.db.prepare(
      `SELECT tool_call_id,tool_name,mutates,state,created_at
       FROM tool_calls WHERE job_id=? AND attempt_id=? AND generation=?
       ORDER BY created_at,tool_call_id`,
    ).all(jobId, attempt.attempt_id, attempt.generation) as Array<{
      tool_call_id: string; tool_name: string; mutates: number; state: string; created_at: number;
    }>;
    const capabilityRows = this.options.db.prepare(
      `SELECT i.invocation_id,i.capability_id,i.version,i.digest,i.tool_name,i.state,i.started_at,
              v.manifest_json
       FROM capability_invocations i
       JOIN capability_versions v
         ON v.capability_id=i.capability_id AND v.version=i.version AND v.digest=i.digest
       WHERE i.job_id=? AND i.attempt_id=? AND i.generation=?
       ORDER BY i.started_at,i.invocation_id`,
    ).all(jobId, attempt.attempt_id, attempt.generation) as Array<{
      invocation_id: string;
      capability_id: string;
      version: string;
      digest: string;
      tool_name: string;
      state: string;
      started_at: number;
      manifest_json: string;
    }>;
    const skillInvocationIds = (this.options.db.prepare(
      `SELECT skill_invocation_id FROM skill_invocations
       WHERE job_id=? AND attempt_id=? AND generation=?
       ORDER BY started_at,skill_invocation_id`,
    ).all(jobId, attempt.attempt_id, attempt.generation) as Array<{ skill_invocation_id: string }>)
      .map((row) => row.skill_invocation_id);
    const effectRows = this.options.db.prepare(
      `SELECT key,effect_classification,effect_kind,tool,attempted_at
       FROM side_effect_ledger
       WHERE job_id=? AND attempt_id=? AND generation=?
       ORDER BY attempted_at,key`,
    ).all(jobId, attempt.attempt_id, attempt.generation) as Array<{
      key: string;
      effect_classification: string;
      effect_kind: string;
      tool: string;
      attempted_at: number;
    }>;
    const evidenceRows = this.options.db.prepare(
      `SELECT evidence_id,verification_result,late,coverage,integrity_sha256
       FROM job_evidence WHERE job_id=? AND attempt_id=? AND generation=?
       ORDER BY captured_at,evidence_id`,
    ).all(jobId, attempt.attempt_id, attempt.generation) as Array<{
      evidence_id: string; verification_result: string; late: number; coverage: string; integrity_sha256: string;
    }>;
    const learningRows = this.options.db.prepare(
      `SELECT DISTINCT les.entry_id,le.subject_key
       FROM learning_entry_sources les
       JOIN learning_sources ls ON ls.source_id=les.source_id
       JOIN learning_entries le ON le.entry_id=les.entry_id
       WHERE ls.owner_id=? AND ls.job_id=? AND ls.attempt_id=? AND ls.generation=?
         AND ls.verification_state='verified'
         AND les.verification_state='verified'
         AND le.eligible=1 AND le.lifecycle='ACTIVE' AND le.deleted_at IS NULL
       ORDER BY les.entry_id`,
    ).all(
      this.options.ownerId, jobId, attempt.attempt_id, attempt.generation,
    ) as Array<{ entry_id: string; subject_key: string }>;
    const learningEntryIds = uniqueSorted(learningRows.map((row) => row.entry_id));
    const orderedSteps = [
      ...toolRows.map((row) => ({
        at: row.created_at,
        identity: `tool:${row.tool_call_id}`,
        operation: normalizedIdentifier(row.tool_name, 'tool'),
        kind: 'tool' as const,
        mutates: row.mutates === 1,
      })),
      ...capabilityRows.map((row) => ({
        at: row.started_at,
        identity: `capability:${row.invocation_id}`,
        operation: normalizedIdentifier(
          `${row.capability_id}-${row.version}-${row.tool_name}`,
          'capability',
        ),
        kind: 'capability' as const,
        mutates: effectRows.some((effect) => effect.tool === row.tool_name),
      })),
    ].sort((left, right) => left.at - right.at || left.identity.localeCompare(right.identity));
    const normalizedSteps: NormalizedWorkflowStep[] = orderedSteps.map((row, index) => ({
      index,
      operation: row.operation,
      kind: row.kind,
      mutates: row.mutates,
    }));
    const requiredCapabilities = uniqueSorted(capabilityRows.map((row) => {
      const manifest = parseJson<{ permissions?: Array<{ kind?: unknown }> }>(row.manifest_json);
      const requiredPermissions = uniqueSorted((manifest.permissions ?? [])
        .map((permission) => permission.kind)
        .filter((permission): permission is string => typeof permission === 'string' && permission.length > 0));
      return stableJson({
        capabilityId: row.capability_id,
        versionRange: `=${row.version}`,
        requiredPermissions,
        required: true,
      });
    })).map((value) => parseJson<CapabilityRequirement>(value));
    const capabilityInvocationIds = capabilityRows.map((row) => row.invocation_id);
    const effectIds = effectRows.map((row) => row.key);
    const evidenceIds = evidenceRows.filter((row) => row.late === 0).map((row) => row.evidence_id);
    const evidenceVerified = evidenceRows.some((row) => row.late === 0
      && /^(?:verified|ok|passed|success)$/i.test(row.verification_result)
      && row.coverage !== 'none');
    const hasLateEvidence = evidenceRows.some((row) => row.late === 1);
    const classification: WorkflowTraceClassification = durableVerdict?.verdict === 'verified'
      && job.status === 'completed' && evidenceVerified && !hasLateEvidence
      ? 'positive'
      : /^(?:failed|verification_failed|denied|cancelled)$/i.test(verdict)
        ? 'negative'
        : 'unknown';
    const scopeKind = job.workspace_id ? 'workspace' : 'owner';
    const effectClasses = uniqueSorted(effectRows.map((row) => normalizedIdentifier(
      row.effect_classification || row.effect_kind || 'unknown-effect',
      'unknown-effect',
    )));
    // Job title/goal can contain the user's raw prompt. It is never a safe
    // pattern identity. Prefer verified Learning subject identity; otherwise
    // use only bounded structural execution semantics.
    const learningSubjects = uniqueSorted(learningRows.map((row) => normalizedIdentifier(
      row.subject_key,
      'verified-workflow',
    )));
    const structuralObjective = [
      ...normalizedSteps.map((step) => `${step.kind}-${step.operation}`),
      ...effectClasses.map((effectClass) => `effect-${effectClass}`),
    ].join('-');
    const objectiveClass = normalizedIdentifier(
      learningSubjects.length > 0 ? learningSubjects.join('-') : structuralObjective,
      'verified-workflow',
    );
    const patternDigest = digest({
      objectiveClass, scopeKind, normalizedSteps, requiredCapabilities, effectClasses,
    });
    const independentKey = job.automation_occurrence_id
      ? `automation:${job.automation_occurrence_id}`
      : `job:${job.id}`;
    const timestamp = this.now();
    const traceId = this.idFactory('trace');
    const sourceDigest = digest({
      jobId, attemptId: attempt.attempt_id, generation: attempt.generation,
      verdict,
      tools: toolRows.map((row) => [row.tool_call_id, row.tool_name, row.state]),
      capabilities: capabilityRows.map((row) => [
        row.invocation_id, row.capability_id, row.version, row.digest, row.tool_name, row.state,
      ]),
      skillInvocations: skillInvocationIds,
      effects: effectRows.map((row) => [row.key, row.effect_classification, row.effect_kind]),
      evidence: evidenceRows.map((row) => [row.evidence_id, row.integrity_sha256, row.late]),
      learningEntries: learningEntryIds,
    });

    this.options.db.transaction(() => {
      this.options.db.prepare(
        `INSERT INTO workflow_traces (
           workflow_trace_id,owner_id,workspace_id,project_id,job_id,attempt_id,generation,
           automation_occurrence_id,independent_key,pattern_digest,objective_class,scope_kind,
           normalized_steps_json,skill_invocation_ids_json,capability_invocation_ids_json,required_capabilities_json,
           effect_ids_json,effect_classes_json,evidence_ids_json,
           learning_entry_ids_json,classification,verdict,source_digest,observed_at,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        traceId, this.options.ownerId, job.workspace_id, null, jobId, attempt.attempt_id,
        attempt.generation, job.automation_occurrence_id, independentKey, patternDigest,
        objectiveClass, scopeKind, stableJson(normalizedSteps), stableJson(skillInvocationIds), stableJson(capabilityInvocationIds),
        stableJson(requiredCapabilities), stableJson(effectIds), stableJson(effectClasses),
        stableJson(evidenceIds), stableJson(learningEntryIds), classification, verdict, sourceDigest,
        finalizedAt, timestamp,
      );
      let pattern = this.options.db.prepare(
        'SELECT workflow_pattern_id FROM workflow_patterns WHERE owner_id=? AND workspace_id IS ? AND pattern_digest=?',
      ).get(this.options.ownerId, job.workspace_id, patternDigest) as { workflow_pattern_id: string } | undefined;
      if (!pattern) {
        pattern = { workflow_pattern_id: this.idFactory('pattern') };
        this.options.db.prepare(
          `INSERT INTO workflow_patterns (
             workflow_pattern_id,owner_id,workspace_id,project_id,pattern_digest,objective_class,
             scope_kind,normalized_steps_json,required_capabilities_json,state,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,'observing',?,?)`,
        ).run(
          pattern.workflow_pattern_id, this.options.ownerId, job.workspace_id, null, patternDigest,
          objectiveClass, scopeKind, stableJson(normalizedSteps), stableJson(requiredCapabilities),
          timestamp, timestamp,
        );
      }
      this.options.db.prepare(
        `INSERT INTO workflow_pattern_traces (
           workflow_pattern_id,workflow_trace_id,classification,independent_key,linked_at
         ) VALUES (?,?,?,?,?)`,
      ).run(pattern.workflow_pattern_id, traceId, classification, independentKey, timestamp);
      this.recomputePattern(pattern.workflow_pattern_id, timestamp);
    }).immediate();

    const trace = traceFromRow(this.options.db.prepare('SELECT * FROM workflow_traces WHERE workflow_trace_id=?').get(traceId) as TraceRow);
    const pattern = this.getPatternByDigest(job.workspace_id, patternDigest);
    const candidate = pattern.state === 'eligible' ? this.ensureCandidate(pattern) : null;
    return { trace, pattern: this.getPatternById(pattern.id), candidate, duplicate: false };
  }

  listPatterns(): WorkflowPattern[] {
    return (this.options.db.prepare(
      'SELECT * FROM workflow_patterns WHERE owner_id=? ORDER BY created_at,workflow_pattern_id',
    ).all(this.options.ownerId) as PatternRow[]).map((row) => this.patternFromRow(row));
  }

  listCandidates(scopeId?: string): SkillCandidate[] {
    const rows = scopeId === undefined
      ? this.options.db.prepare(
        'SELECT * FROM skill_candidates WHERE owner_id=? ORDER BY created_at,skill_candidate_id',
      ).all(this.options.ownerId)
      : this.options.db.prepare(
        'SELECT * FROM skill_candidates WHERE owner_id=? AND scope_id=? ORDER BY created_at,skill_candidate_id',
      ).all(this.options.ownerId, scopeId);
    return (rows as CandidateRow[])
      .map(this.candidateFromRow)
      .map((candidate) => this.revalidateCandidateSources(candidate));
  }

  reviewCandidate(candidateId: string): {
    candidate: SkillCandidate;
    pattern: WorkflowPattern;
    traces: WorkflowTrace[];
  } {
    const candidate = this.revalidateCandidateSources(this.getCandidate(candidateId));
    const pattern = this.getPatternById(candidate.patternId);
    const traceIds = [...candidate.positiveTraceIds, ...candidate.negativeTraceIds];
    const traces = traceIds.map((traceId) => {
      const row = this.options.db.prepare(
        'SELECT * FROM workflow_traces WHERE workflow_trace_id=? AND owner_id=?',
      ).get(traceId, this.options.ownerId) as TraceRow | undefined;
      if (!row) throw new Error('Skill candidate source trace is unavailable');
      return traceFromRow(row);
    });
    return { candidate, pattern, traces };
  }

  dismissCandidate(input: { candidateId: string; expectedVersion: number }): SkillCandidate {
    this.requireEnabled();
    const candidate = this.getCandidate(input.candidateId);
    if (candidate.state !== 'candidate' || candidate.stateVersion !== input.expectedVersion) {
      throw new Error('Skill candidate changed or is no longer dismissible');
    }
    const timestamp = this.now();
    this.options.db.transaction(() => {
      const changed = this.options.db.prepare(
        `UPDATE skill_candidates SET state='dismissed',state_version=state_version+1,updated_at=?
         WHERE skill_candidate_id=? AND state='candidate' AND state_version=?`,
      ).run(timestamp, candidate.id, input.expectedVersion);
      if (changed.changes !== 1) throw new Error('Skill candidate changed concurrently');
      this.options.db.prepare(
        `UPDATE workflow_patterns SET state='dismissed',state_version=state_version+1,updated_at=?
         WHERE workflow_pattern_id=? AND state<>'dismissed'`,
      ).run(timestamp, candidate.patternId);
    }).immediate();
    return this.getCandidate(candidate.id);
  }

  listDrafts(scopeId?: string): SkillDraft[] {
    const rows = scopeId === undefined
      ? this.options.db.prepare(
        'SELECT * FROM skill_drafts WHERE owner_id=? ORDER BY created_at,skill_draft_id',
      ).all(this.options.ownerId)
      : this.options.db.prepare(
        'SELECT * FROM skill_drafts WHERE owner_id=? AND scope_id=? ORDER BY created_at,skill_draft_id',
      ).all(this.options.ownerId, scopeId);
    return (rows as DraftRow[]).map(draftFromRow);
  }

  reviewDraft(draftId: string): SkillDraft {
    return this.getDraft(draftId);
  }

  listApprovals(scopeId?: string): SkillManagementApproval[] {
    const rows = scopeId === undefined
      ? this.options.db.prepare(
        'SELECT * FROM skill_management_approvals WHERE owner_id=? ORDER BY requested_at,skill_approval_id',
      ).all(this.options.ownerId)
      : this.options.db.prepare(
        'SELECT * FROM skill_management_approvals WHERE owner_id=? AND scope_id=? ORDER BY requested_at,skill_approval_id',
      ).all(this.options.ownerId, scopeId);
    return (rows as ApprovalRow[]).map(approvalFromRow);
  }

  /**
   * Project one already-terminal Job into learning and exact SkillVersion
   * outcomes. JobEngine remains the lifecycle authority; this method only
   * observes durable terminal truth and is safe to replay.
   */
  observeSettlement(jobId: string): {
    trace: WorkflowTrace;
    pattern: WorkflowPattern;
    candidate: SkillCandidate | null;
    duplicate: boolean;
  } | null {
    if (!this.options.enabled) return null;
    const observed = this.observeJob(jobId);
    const invocations = this.options.db.prepare(
      `SELECT * FROM skill_invocations
       WHERE job_id=? AND state IN ('admitted','running')
       ORDER BY generation,started_at,skill_invocation_id`,
    ).all(jobId) as InvocationRow[];
    const authoritativeInvocations = invocations.filter((row) => (
      row.attempt_id === observed.trace.attemptId
      && row.generation === observed.trace.generation
    ));
    const terminalJob = this.options.db.prepare(
      'SELECT status FROM tasks WHERE id=?',
    ).get(jobId) as { status: string } | undefined;
    const exactSingleSkillVerificationFailure = observed.trace.classification === 'negative'
      && terminalJob?.status === 'verification_failed'
      && authoritativeInvocations.length === 1
      && observed.trace.evidenceIds.length > 0;
    const cancelled = /cancel/i.test(observed.trace.verdict)
      || /cancel/i.test(terminalJob?.status ?? '');
    for (const row of invocations) {
      const invocation = invocationFromRow(row);
      const authoritativeAttempt = invocation.attemptId === observed.trace.attemptId
        && invocation.generation === observed.trace.generation;
      if (!authoritativeAttempt) {
        this.recordOutcome({
          invocationId: invocation.id,
          outcome: 'unknown',
          verdict: 'stale_attempt',
          evidenceIds: [],
          attributable: false,
          reason: 'Invocation belongs to a non-authoritative Job Attempt generation',
        });
        continue;
      }
      const outcome = observed.trace.classification === 'positive'
        ? 'verified_success'
        : cancelled
          ? 'cancelled'
        : exactSingleSkillVerificationFailure
          ? 'verification_failure'
        : observed.trace.classification === 'negative'
          ? 'failed'
          : 'unknown';
      this.recordOutcome({
        invocationId: invocation.id,
        outcome,
        verdict: observed.trace.verdict,
        evidenceIds: observed.trace.evidenceIds,
        // Success is attributable to the exact version that participated in
        // the verified workflow. Failures remain unattributed unless an
        // independent verifier explicitly assigns responsibility.
        attributable: observed.trace.classification === 'positive'
          || exactSingleSkillVerificationFailure,
        reason: observed.trace.classification === 'negative'
          ? cancelled
            ? 'Durable Job was cancelled; no Skill failure attribution was recorded'
            : exactSingleSkillVerificationFailure
            ? 'One exact Skill invocation participated in a durable verification failure'
            : 'No durable Skill-specific failure attribution was recorded'
          : undefined,
      });
    }
    this.reconcileLearningProjections(jobId);
    return observed;
  }

  createDraft(input: {
    candidateId: string;
    name: string;
    description: string;
    steps: SkillDraftStep[];
    capabilityRequirements?: CapabilityRequirement[];
    composition?: string[];
    expectedEvidence: string[];
  }): SkillDraft {
    this.requireEnabled();
    const candidate = this.revalidateCandidateSources(this.getCandidate(input.candidateId));
    if (candidate.state === 'stale' || candidate.state === 'dismissed') throw new Error('Skill candidate is not reviewable');
    const name = normalizedIdentifier(input.name, 'reviewed-skill');
    const requirements = this.normalizeRequirements(input.capabilityRequirements ?? []);
    const composition = uniqueSorted(input.composition ?? input.steps.flatMap((step) => step.childSkillVersionId ? [step.childSkillVersionId] : []));
    const expectedEvidence = uniqueSorted(input.expectedEvidence.map((item) => item.trim()).filter(Boolean));
    const spec = this.buildCanonicalSpec({
      name,
      description: input.description.trim(),
      steps: input.steps,
      capabilityRequirements: requirements,
      composition,
      expectedEvidence,
    });
    this.assertSafeDraft(spec);
    const contentDigest = digest(spec);
    const skillId = `skill_${digest({ ownerId: this.options.ownerId, scopeId: candidate.scopeId, name }).slice(0, 32)}`;
    const draftId = this.idFactory('draft');
    const timestamp = this.now();
    const resolvedDraftId = this.options.db.transaction(() => {
      const existing = this.options.db.prepare(
        `SELECT skill_draft_id FROM skill_drafts
         WHERE skill_candidate_id=? AND content_digest=?`,
      ).get(candidate.id, contentDigest) as { skill_draft_id: string } | undefined;
      if (existing) return existing.skill_draft_id;
      this.options.db.prepare(
        `INSERT OR IGNORE INTO skill_drafts (
           skill_draft_id,skill_id,skill_candidate_id,owner_id,scope_id,name,description,steps_json,
           capability_requirements_json,composition_json,expected_evidence_json,canonical_spec_json,
           content_digest,state,executable,state_version,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',0,1,?,?)`,
      ).run(
        draftId, skillId, candidate.id, this.options.ownerId, candidate.scopeId, name,
        input.description.trim(), stableJson(input.steps), stableJson(requirements),
        stableJson(composition), stableJson(expectedEvidence), stableJson(spec), contentDigest,
        timestamp, timestamp,
      );
      this.options.db.prepare(
        `UPDATE skill_candidates SET state='accepted',state_version=state_version+1,updated_at=?
         WHERE skill_candidate_id=? AND state='candidate'`,
      ).run(timestamp, candidate.id);
      const created = this.options.db.prepare(
        `SELECT skill_draft_id FROM skill_drafts
         WHERE skill_candidate_id=? AND content_digest=?`,
      ).get(candidate.id, contentDigest) as { skill_draft_id: string } | undefined;
      if (!created) throw new Error('Skill draft creation did not converge');
      return created.skill_draft_id;
    }).immediate();
    return this.getDraft(resolvedDraftId);
  }

  updateDraft(input: {
    draftId: string;
    expectedVersion: number;
    name?: string;
    description?: string;
    steps?: SkillDraftStep[];
    capabilityRequirements?: CapabilityRequirement[];
    composition?: string[];
    expectedEvidence?: string[];
  }): SkillDraft {
    this.requireEnabled();
    const current = this.getDraft(input.draftId);
    if (current.stateVersion !== input.expectedVersion) throw new Error('Skill draft changed concurrently');
    const name = input.name === undefined ? current.name : normalizedIdentifier(input.name, current.name);
    const description = input.description === undefined ? current.description : input.description.trim();
    const steps = input.steps ?? current.steps;
    const requirements = this.normalizeRequirements(input.capabilityRequirements ?? current.capabilityRequirements);
    const composition = uniqueSorted(input.composition ?? current.composition);
    const expectedEvidence = uniqueSorted((input.expectedEvidence ?? current.expectedEvidence).map((item) => item.trim()).filter(Boolean));
    const spec = this.buildCanonicalSpec({ name, description, steps, capabilityRequirements: requirements, composition, expectedEvidence });
    this.assertSafeDraft(spec);
    const contentDigest = digest(spec);
    const timestamp = this.now();
    const result = this.options.db.transaction(() => {
      const changed = this.options.db.prepare(
        `UPDATE skill_drafts SET name=?,description=?,steps_json=?,capability_requirements_json=?,
           composition_json=?,expected_evidence_json=?,canonical_spec_json=?,content_digest=?,
           state='draft',state_version=state_version+1,updated_at=?
         WHERE skill_draft_id=? AND state_version=?`,
      ).run(
        name, description, stableJson(steps), stableJson(requirements), stableJson(composition),
        stableJson(expectedEvidence), stableJson(spec), contentDigest, timestamp,
        current.id, input.expectedVersion,
      );
      if (changed.changes !== 1) throw new Error('Skill draft changed concurrently');
      this.options.db.prepare(
        `UPDATE skill_management_approvals SET state='stale',state_version=state_version+1
         WHERE skill_draft_id=? AND state IN ('pending','approved') AND draft_digest<>?`,
      ).run(current.id, contentDigest);
    }).immediate();
    void result;
    return this.getDraft(current.id);
  }

  evaluate(input: { draftId: string }): SkillEvaluation {
    this.requireEnabled();
    const draft = this.getDraft(input.draftId);
    let candidate: SkillCandidate | null = null;
    if (draft.candidateId) {
      candidate = this.revalidateCandidateSources(this.getCandidate(draft.candidateId));
      if (candidate.state === 'stale') throw new Error('Skill candidate sources are stale and require review');
    }
    const sourceFixtures = this.resolveEvaluationFixtures(candidate);
    const capabilities = this.resolveCapabilities(draft.capabilityRequirements, draft.scopeId);
    const capabilityEnvironmentDigest = digest(capabilities.environment);
    const prior = this.options.db.prepare(
      `SELECT * FROM skill_evaluations
       WHERE skill_draft_id=? AND draft_digest=? AND evaluator_version=?
         AND capability_environment_digest=? AND source_fixture_digest=?`,
    ).get(
      draft.id, draft.digest, EVALUATOR_VERSION,
      capabilityEnvironmentDigest, sourceFixtures.digest,
    ) as EvaluationRow | undefined;
    if (prior) return evaluationFromRow(prior);

    const checks: SkillEvaluationCheck[] = [];
    const add = (code: string, passed: boolean, detail: string) => checks.push({ code, passed, detail });
    const schema = this.evaluateDraftSchema(draft);
    add('schema', schema.passed, schema.detail);
    add('step_bounds', draft.steps.length > 0 && draft.steps.length <= MAX_STEPS, `Expanded procedure must contain 1-${MAX_STEPS} steps`);
    const duplicateStepIds = draft.steps.length !== new Set(draft.steps.map((step) => step.id)).size;
    add('step_identity', !duplicateStepIds, 'Step identities must be unique');
    add('fallback_bounds', draft.steps.every((step) => (step.fallbackStepIds?.length ?? 0) <= MAX_FALLBACKS), `Each step supports at most ${MAX_FALLBACKS} fallbacks`);
    const fallbacks = this.evaluateFallbackGraph(draft.steps);
    add('fallback_graph', fallbacks.passed, fallbacks.detail);
    const composition = this.evaluateComposition(draft);
    add('composition', composition.passed, composition.detail);
    add('capabilities', capabilities.issues.length === 0, capabilities.issues.join('; ') || 'Capability prerequisites are active, healthy, and permission-compatible');
    add('expected_evidence', draft.expectedEvidence.length > 0, 'At least one expected Evidence class is required');
    add('verified_sources', !candidate || candidate.positiveTraceIds.length >= MIN_INDEPENDENT_VERIFIED_TRACES, 'Draft must remain linked to sufficient verified source traces');
    add(
      'trace_fixtures',
      sourceFixtures.issues.length === 0,
      sourceFixtures.issues.join('; ')
        || `${sourceFixtures.fixtures.filter((fixture) => fixture.classification === 'positive').length} positive and ${sourceFixtures.fixtures.filter((fixture) => fixture.classification === 'negative').length} negative exact trace fixtures are bound`,
    );
    let securityPassed = true;
    let securityDetail = 'No executable code, credential material, or dangerous Skill content detected';
    try {
      this.assertSafeDraft(draft.canonicalSpec);
    } catch (error) {
      securityPassed = false;
      securityDetail = error instanceof Error ? error.message : String(error);
    }
    add('security', securityPassed, securityDetail);
    const passed = checks.every((check) => check.passed);
    const evaluationDigest = digest({
      evaluatorVersion: EVALUATOR_VERSION,
      draftDigest: draft.digest,
      capabilityEnvironmentDigest,
      sourceFixtureDigest: sourceFixtures.digest,
      checks,
    });
    const evaluationId = this.idFactory('evaluation');
    const timestamp = this.now();
    this.options.db.transaction(() => {
      this.options.db.prepare(
        `INSERT INTO skill_evaluations (
           skill_evaluation_id,skill_draft_id,draft_digest,evaluation_digest,evaluator_version,
           capability_environment_digest,source_fixture_digest,source_fixtures_json,
           result_json,passed,state,started_at,completed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        evaluationId, draft.id, draft.digest, evaluationDigest, EVALUATOR_VERSION,
        capabilityEnvironmentDigest, sourceFixtures.digest, stableJson(sourceFixtures.fixtures),
        stableJson(checks), passed ? 1 : 0,
        passed ? 'passed' : 'failed', timestamp, timestamp,
      );
      this.options.db.prepare(
        `UPDATE skill_management_approvals SET state='stale',state_version=state_version+1
         WHERE skill_draft_id=? AND skill_evaluation_id<>? AND state IN ('pending','approved')`,
      ).run(draft.id, evaluationId);
      this.options.db.prepare(
        `UPDATE skill_drafts SET state='evaluated',updated_at=?
         WHERE skill_draft_id=? AND content_digest=?`,
      ).run(timestamp, draft.id, draft.digest);
    }).immediate();
    return evaluationFromRow(this.options.db.prepare('SELECT * FROM skill_evaluations WHERE skill_evaluation_id=?').get(evaluationId) as EvaluationRow);
  }

  listEvaluations(scopeId?: string): SkillEvaluation[] {
    const rows = scopeId === undefined
      ? this.options.db.prepare(
        `SELECT e.* FROM skill_evaluations e JOIN skill_drafts d ON d.skill_draft_id=e.skill_draft_id
         WHERE d.owner_id=? ORDER BY e.started_at,e.skill_evaluation_id`,
      ).all(this.options.ownerId)
      : this.options.db.prepare(
        `SELECT e.* FROM skill_evaluations e JOIN skill_drafts d ON d.skill_draft_id=e.skill_draft_id
         WHERE d.owner_id=? AND d.scope_id=? ORDER BY e.started_at,e.skill_evaluation_id`,
      ).all(this.options.ownerId, scopeId);
    return (rows as EvaluationRow[]).map(evaluationFromRow);
  }

  requestApproval(input: {
    draftId: string;
    evaluationId: string;
    scopeId: string;
    requestedBy: string;
  }): SkillManagementApproval {
    this.requireEnabled();
    const draft = this.getDraft(input.draftId);
    if (draft.scopeId !== input.scopeId) {
      throw new Error('Skill approval scope must match the reviewed draft scope');
    }
    let candidate: SkillCandidate | null = null;
    if (draft.candidateId) {
      candidate = this.revalidateCandidateSources(this.getCandidate(draft.candidateId));
      if (candidate.state === 'stale') throw new Error('Skill candidate sources are stale and require review');
    }
    const evaluation = this.options.db.prepare(
      'SELECT * FROM skill_evaluations WHERE skill_evaluation_id=?',
    ).get(input.evaluationId) as EvaluationRow | undefined;
    if (!evaluation || evaluation.passed !== 1 || evaluation.state !== 'passed'
        || evaluation.skill_draft_id !== draft.id || evaluation.draft_digest !== draft.digest) {
      throw new Error('A current passed evaluation is required before approval');
    }
    const currentEvaluation = evaluationFromRow(evaluation);
    const sourceFixtures = this.resolveEvaluationFixtures(candidate);
    const capabilities = this.resolveCapabilities(draft.capabilityRequirements, input.scopeId);
    if (sourceFixtures.issues.length > 0
        || currentEvaluation.sourceFixtureDigest !== sourceFixtures.digest
        || currentEvaluation.capabilityEnvironmentDigest !== digest(capabilities.environment)) {
      throw new Error('Skill evaluation environment changed and must be evaluated again before approval');
    }
    return this.options.db.transaction(() => {
      const exact = () => this.options.db.prepare(
        `SELECT * FROM skill_management_approvals
         WHERE owner_id=? AND scope_id=? AND skill_draft_id=? AND skill_evaluation_id=?
           AND draft_digest=? AND evaluation_digest=? AND state IN ('pending','approved')
         ORDER BY requested_at,skill_approval_id LIMIT 1`,
      ).get(
        this.options.ownerId, input.scopeId, draft.id, evaluation.skill_evaluation_id,
        draft.digest, evaluation.evaluation_digest,
      ) as ApprovalRow | undefined;
      const existing = exact();
      if (existing) return approvalFromRow(existing);
      const approvalId = this.idFactory('approval');
      const timestamp = this.now();
      this.options.db.prepare(
        `INSERT OR IGNORE INTO skill_management_approvals (
           skill_approval_id,skill_id,skill_draft_id,skill_evaluation_id,owner_id,scope_id,
           draft_digest,evaluation_digest,capability_requirements_digest,state,requested_by,
           requested_at,state_version
         ) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,1)`,
      ).run(
        approvalId, draft.skillId, draft.id, evaluation.skill_evaluation_id, this.options.ownerId,
        input.scopeId, draft.digest, evaluation.evaluation_digest,
        digest(draft.capabilityRequirements), input.requestedBy, timestamp,
      );
      const created = exact();
      if (!created) throw new Error('Skill approval request did not converge');
      return approvalFromRow(created);
    }).immediate();
  }

  decideApproval(input: {
    approvalId: string;
    draftDigest: string;
    evaluationDigest: string;
    decision: 'approved' | 'denied';
    decidedBy: string;
  }): SkillManagementApproval {
    this.requireEnabled();
    const approval = this.getApproval(input.approvalId);
    if (approval.draftDigest !== input.draftDigest || approval.evaluationDigest !== input.evaluationDigest) {
      throw new Error('Approval digest does not match the exact reviewed draft and evaluation');
    }
    if (approval.state === input.decision) return approval;
    if (approval.state !== 'pending') throw new Error('Skill approval is no longer pending');
    const timestamp = this.now();
    const result = this.options.db.prepare(
      `UPDATE skill_management_approvals SET state=?,decided_by=?,decided_at=?,state_version=state_version+1
       WHERE skill_approval_id=? AND state='pending' AND state_version=?`,
    ).run(input.decision, input.decidedBy, timestamp, approval.id, approval.stateVersion);
    if (result.changes !== 1) throw new Error('Skill approval was decided concurrently');
    return this.getApproval(approval.id);
  }

  activate(input: { approvalId: string }): SkillVersion {
    this.requireEnabled();
    return this.options.db.transaction(() => {
      const approval = this.getApproval(input.approvalId);
      if (approval.state === 'stale') throw new Error('Stale approval cannot activate a changed draft');
      if (approval.state !== 'approved') throw new Error('An approved Skill management action is required');
      const draft = this.getDraft(approval.draftId);
      const evaluation = this.getEvaluation(approval.evaluationId);
      if (draft.digest !== approval.draftDigest) throw new Error('Draft changed; stale approval cannot activate it');
      if (!evaluation.passed || evaluation.digest !== approval.evaluationDigest || evaluation.draftDigest !== draft.digest) {
        throw new Error('Stale approval or evaluation cannot activate this draft');
      }
      if (approval.capabilityRequirementsDigest !== digest(draft.capabilityRequirements)) {
        throw new Error('Capability prerequisites changed after approval');
      }
      const candidate = draft.candidateId
        ? this.revalidateCandidateSources(this.getCandidate(draft.candidateId))
        : null;
      if (candidate?.state === 'stale') throw new Error('Skill candidate sources are stale and require review');
      const sourceFixtures = this.resolveEvaluationFixtures(candidate);
      const capabilities = this.resolveCapabilities(draft.capabilityRequirements, approval.scopeId);
      if (capabilities.issues.length > 0) throw new Error(`Capability permission or health revalidation failed: ${capabilities.issues.join('; ')}`);
      if (sourceFixtures.issues.length > 0
          || evaluation.sourceFixtureDigest !== sourceFixtures.digest
          || evaluation.capabilityEnvironmentDigest !== digest(capabilities.environment)) {
        throw new Error('Skill evaluation environment changed; stale evaluation cannot activate this draft');
      }
      const existing = this.options.db.prepare(
        'SELECT * FROM skill_versions WHERE skill_approval_id=?',
      ).get(approval.id) as VersionRow | undefined;
      if (existing) return versionFromRow(existing);
      const next = (this.options.db.prepare(
        'SELECT COALESCE(MAX(version_number),0)+1 AS value FROM skill_versions WHERE skill_id=?',
      ).get(draft.skillId) as { value: number }).value;
      const versionId = this.idFactory('skill_version');
      const timestamp = this.now();
      this.options.db.prepare(
        `INSERT INTO skill_versions (
           skill_version_id,skill_id,version_number,content_digest,canonical_spec_json,
           capability_requirements_json,composition_json,skill_evaluation_id,skill_approval_id,
           workflow_pattern_id,skill_candidate_id,source_kind,source_path,trust_level,legacy,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'intelligence',NULL,NULL,0,?)`,
      ).run(
        versionId, draft.skillId, next, draft.digest, stableJson(draft.canonicalSpec),
        stableJson(draft.capabilityRequirements), stableJson(draft.composition), evaluation.id,
        approval.id, candidate?.patternId ?? null, candidate?.id ?? null, timestamp,
      );
      this.switchPointer({
        skillId: draft.skillId,
        scopeId: approval.scopeId,
        versionId,
        contentDigest: draft.digest,
        requestedBy: approval.decidedBy ?? approval.requestedBy,
        action: 'activate',
        timestamp,
      });
      return versionFromRow(this.options.db.prepare('SELECT * FROM skill_versions WHERE skill_version_id=?').get(versionId) as VersionRow);
    }).immediate();
  }

  resolveActive(skillId: string, scopeId = this.options.defaultScopeId): ResolvedSkillVersion | null {
    this.reconcilePointerIntegrity(scopeId, skillId);
    const row = this.options.db.prepare(
      `SELECT p.scope_id,p.enabled,p.drift_state,p.state_version,p.activated_at,
              p.content_digest AS pointer_digest,v.*
       FROM skill_active_pointers p JOIN skill_versions v ON v.skill_version_id=p.skill_version_id
       WHERE p.skill_id=? AND p.scope_id=? AND p.skill_id=v.skill_id`,
    ).get(skillId, scopeId) as (VersionRow & {
      scope_id: string;
      enabled: number;
      drift_state: ResolvedSkillVersion['driftState'];
      state_version: number;
      activated_at: number;
      pointer_digest: string;
    }) | undefined;
    if (!row) return null;
    return {
      skillId,
      scopeId: row.scope_id,
      enabled: row.enabled === 1,
      driftState: row.drift_state,
      stateVersion: row.state_version,
      activatedAt: row.activated_at,
      version: versionFromRow(row),
    };
  }

  listActive(scopeId = this.options.defaultScopeId): ResolvedSkillVersion[] {
    this.reconcilePointerIntegrity(scopeId);
    const rows = this.options.db.prepare(
      `SELECT p.scope_id,p.enabled,p.drift_state,p.state_version,p.activated_at,v.*
       FROM skill_active_pointers p JOIN skill_versions v ON v.skill_version_id=p.skill_version_id
       WHERE p.scope_id=? AND p.enabled=1 AND p.drift_state='clean'
         AND p.skill_id=v.skill_id AND p.content_digest=v.content_digest
       ORDER BY v.skill_id`,
    ).all(scopeId) as Array<VersionRow & {
      scope_id: string;
      enabled: number;
      drift_state: ResolvedSkillVersion['driftState'];
      state_version: number;
      activated_at: number;
    }>;
    return rows.map((row) => ({
      skillId: row.skill_id,
      scopeId: row.scope_id,
      enabled: row.enabled === 1,
      driftState: row.drift_state,
      stateVersion: row.state_version,
      activatedAt: row.activated_at,
      version: versionFromRow(row),
    }));
  }

  listPointers(scopeId = this.options.defaultScopeId): SkillActivePointer[] {
    this.reconcilePointerIntegrity(scopeId);
    return this.readPointers(scopeId);
  }

  markPointerDrift(input: {
    skillId: string;
    scopeId: string;
    expectedVersion: number;
    state?: 'drifted' | 'missing' | 'unknown';
  }): SkillActivePointer {
    const pointer = this.readPointers(input.scopeId).find((item) => item.skillId === input.skillId);
    if (!pointer) throw new Error('Active Skill pointer not found');
    if (!pointer.enabled && pointer.driftState !== 'clean') return pointer;
    if (pointer.stateVersion !== input.expectedVersion) throw new Error('Active Skill pointer changed concurrently');
    const state = input.state ?? 'drifted';
    const timestamp = this.now();
    this.options.db.transaction(() => {
      const changed = this.options.db.prepare(
        `UPDATE skill_active_pointers
         SET enabled=0,drift_state=?,state_version=state_version+1
         WHERE skill_id=? AND scope_id=? AND state_version=?`,
      ).run(state, input.skillId, input.scopeId, input.expectedVersion);
      if (changed.changes !== 1) throw new Error('Active Skill pointer changed concurrently');
      this.options.db.prepare(
        `INSERT INTO skill_activation_history (
           skill_id,scope_id,skill_version_id,content_digest,action,requested_by,activated_at
         ) VALUES (?,?,?,?, 'drift','integrity-check',?)`,
      ).run(pointer.skillId, pointer.scopeId, pointer.skillVersionId, pointer.digest, timestamp);
    }).immediate();
    return this.readPointers(input.scopeId).find((item) => item.skillId === input.skillId)!;
  }

  private readPointers(scopeId = this.options.defaultScopeId): SkillActivePointer[] {
    return (this.options.db.prepare(
      `SELECT skill_id,scope_id,skill_version_id,content_digest,enabled,drift_state,state_version,activated_at
       FROM skill_active_pointers WHERE scope_id=? ORDER BY skill_id`,
    ).all(scopeId) as Array<{
      skill_id: string;
      scope_id: string;
      skill_version_id: string;
      content_digest: string;
      enabled: number;
      drift_state: SkillActivePointer['driftState'];
      state_version: number;
      activated_at: number;
    }>).map((row) => ({
      skillId: row.skill_id,
      scopeId: row.scope_id,
      skillVersionId: row.skill_version_id,
      digest: row.content_digest,
      enabled: row.enabled === 1,
      driftState: row.drift_state,
      stateVersion: row.state_version,
      activatedAt: row.activated_at,
    }));
  }

  disable(input: { skillId: string; scopeId: string; requestedBy: string }): SkillActivePointer {
    const pointer = this.listPointers(input.scopeId).find((item) => item.skillId === input.skillId);
    if (!pointer) throw new Error('Active Skill pointer not found');
    const timestamp = this.now();
    const changed = this.options.db.transaction(() => {
      const update = this.options.db.prepare(
        `UPDATE skill_active_pointers SET enabled=0,state_version=state_version+1
         WHERE skill_id=? AND scope_id=? AND state_version=?`,
      ).run(input.skillId, input.scopeId, pointer.stateVersion);
      if (update.changes !== 1) throw new Error('Active Skill pointer changed concurrently');
      this.options.db.prepare(
        `INSERT INTO skill_activation_history (
           skill_id,scope_id,skill_version_id,content_digest,action,requested_by,activated_at
         ) VALUES (?,?,?,?,?,?,?)`,
      ).run(
        pointer.skillId, pointer.scopeId, pointer.skillVersionId, pointer.digest,
        'disable', input.requestedBy, timestamp,
      );
      return update.changes;
    }).immediate();
    void changed;
    return this.listPointers(input.scopeId).find((item) => item.skillId === input.skillId)!;
  }

  resolveActiveByName(name: string, scopeId = this.options.defaultScopeId): ResolvedSkillVersion | null {
    const target = name.trim().toLowerCase();
    return this.listActive(scopeId).find((resolved) => {
      const frontmatter = resolved.version.canonicalSpec.frontmatter;
      if (!frontmatter || typeof frontmatter !== 'object') return false;
      const value = (frontmatter as Record<string, unknown>).name;
      return typeof value === 'string' && value.trim().toLowerCase() === target;
    }) ?? null;
  }

  resolveCapabilityVersions(
    skillVersionId: string,
    scopeId = this.options.defaultScopeId,
  ): ResolvedCapabilityVersion[] {
    const version = this.getVersion(skillVersionId);
    const resolved = this.resolveCapabilities(version.capabilityRequirements, scopeId);
    if (resolved.issues.length > 0) {
      throw new Error(`Skill capability permission unavailable: ${resolved.issues.join('; ')}`);
    }
    return resolved.environment.flatMap((item) => (
      item.ready === true
      && typeof item.capabilityId === 'string'
      && typeof item.version === 'string'
      && typeof item.digest === 'string'
        ? [{ capabilityId: item.capabilityId, version: item.version, digest: item.digest }]
        : []
    ));
  }

  listVersions(skillId: string, scopeId?: string): SkillVersion[] {
    const rows = scopeId === undefined
      ? this.options.db.prepare(
        'SELECT * FROM skill_versions WHERE skill_id=? ORDER BY version_number,skill_version_id',
      ).all(skillId)
      : this.options.db.prepare(
        `SELECT DISTINCT v.* FROM skill_versions v
         JOIN skill_activation_history h
           ON h.skill_id=v.skill_id AND h.skill_version_id=v.skill_version_id
         WHERE v.skill_id=? AND h.scope_id=?
         ORDER BY v.version_number,v.skill_version_id`,
      ).all(skillId, scopeId);
    return (rows as VersionRow[]).map(versionFromRow);
  }

  recordInvocation(input: {
    skillVersionId: string;
    scopeId: string;
    jobId: string;
    attemptId: string;
    generation: number;
    toolCallId: string;
    capabilityVersions: ResolvedCapabilityVersion[];
    compositionPath?: string[];
    fallbackFromInvocationId?: string | null;
  }): SkillInvocation {
    const version = this.getVersion(input.skillVersionId);
    this.reconcilePointerIntegrity(input.scopeId, version.skillId);
    const active = this.options.db.prepare(
      `SELECT scope_id FROM skill_active_pointers
       WHERE skill_id=? AND scope_id=? AND skill_version_id=? AND content_digest=?
         AND enabled=1 AND drift_state='clean' LIMIT 1`,
    ).get(version.skillId, input.scopeId, version.id, version.digest) as { scope_id: string } | undefined;
    if (!active) throw new Error('SkillVersion is not active or its bytes are drifted');
    const job = this.options.db.prepare(
      'SELECT workspace_id FROM tasks WHERE id=?',
    ).get(input.jobId) as { workspace_id: string | null } | undefined;
    if (!job) throw new Error('Managed Skill invocation requires an existing durable Job');
    const jobScope = job.workspace_id ?? this.options.defaultScopeId;
    if (jobScope !== input.scopeId) throw new Error('Managed Skill scope does not match the durable Job workspace');
    const toolCall = this.options.db.prepare(
      `SELECT tool_name FROM tool_calls
       WHERE tool_call_id=? AND job_id=? AND attempt_id=? AND generation=?`,
    ).get(input.toolCallId, input.jobId, input.attemptId, input.generation) as { tool_name: string } | undefined;
    if (!toolCall || toolCall.tool_name !== 'skill_view') {
      throw new Error('Managed Skill invocation requires the exact durable skill_view ToolCall');
    }
    const expectedCapabilities = this.resolveCapabilityVersions(version.id, input.scopeId);
    const suppliedCapabilities = this.mergeCapabilities([], input.capabilityVersions);
    if (stableJson(suppliedCapabilities) !== stableJson(expectedCapabilities)) {
      throw new Error('Managed Skill capability attribution does not match exact resolved prerequisites');
    }
    const compositionPath = input.compositionPath ?? [];
    if (compositionPath.length > MAX_COMPOSITION_DEPTH + 1
        || (compositionPath.length > 0 && compositionPath[compositionPath.length - 1] !== version.id)) {
      throw new Error('Managed Skill composition path is invalid or exceeds the supported depth');
    }
    if (input.fallbackFromInvocationId) {
      const parent = this.getInvocation(input.fallbackFromInvocationId);
      if (parent.jobId !== input.jobId || parent.attemptId !== input.attemptId
          || parent.generation !== input.generation || parent.scopeId !== input.scopeId) {
        throw new Error('Managed Skill fallback must remain within the exact Job Attempt generation and scope');
      }
      const parentPath = parent.compositionPath.length > 0
        ? parent.compositionPath
        : [parent.skillVersionId];
      if (stableJson(compositionPath) !== stableJson([...parentPath, version.id])) {
        throw new Error('Managed Skill fallback path must extend the exact parent invocation identity');
      }
    } else {
      for (let index = 0; index + 1 < compositionPath.length; index += 1) {
        const parentVersion = this.getVersion(compositionPath[index]);
        const activeParent = this.resolveActive(parentVersion.skillId, input.scopeId);
        if (!activeParent?.enabled || activeParent.driftState !== 'clean'
            || activeParent.version.id !== parentVersion.id
            || !parentVersion.composition.includes(compositionPath[index + 1])) {
          throw new Error('Managed Skill composition path is not an exact active approved child graph');
        }
      }
    }
    const prior = this.options.db.prepare(
      `SELECT * FROM skill_invocations
       WHERE job_id=? AND attempt_id=? AND generation=? AND tool_call_id=? AND skill_version_id=?`,
    ).get(input.jobId, input.attemptId, input.generation, input.toolCallId, version.id) as InvocationRow | undefined;
    if (prior) {
      const replay = invocationFromRow(prior);
      if (replay.scopeId !== input.scopeId
          || stableJson(replay.capabilityVersions) !== stableJson(suppliedCapabilities)
          || stableJson(replay.compositionPath) !== stableJson(compositionPath)
          || replay.fallbackFromInvocationId !== (input.fallbackFromInvocationId ?? null)) {
        throw new Error('Managed Skill invocation identity was replayed with different attribution');
      }
      return replay;
    }
    const id = this.idFactory('skill_invocation');
    const timestamp = this.now();
    this.options.db.prepare(
      `INSERT INTO skill_invocations (
         skill_invocation_id,skill_id,skill_version_id,content_digest,scope_id,job_id,attempt_id,generation,
         tool_call_id,capability_versions_json,composition_path_json,fallback_from_invocation_id,
         state,started_at,terminal_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'running',?,NULL)`,
    ).run(
      id, version.skillId, version.id, version.digest, input.scopeId, input.jobId, input.attemptId,
      input.generation, input.toolCallId, stableJson(suppliedCapabilities),
      stableJson(compositionPath), input.fallbackFromInvocationId ?? null, timestamp,
    );
    return invocationFromRow(this.options.db.prepare('SELECT * FROM skill_invocations WHERE skill_invocation_id=?').get(id) as InvocationRow);
  }

  recordOutcome(input: {
    invocationId: string;
    outcome: string;
    verdict: string;
    evidenceIds: string[];
    attributable: boolean;
    reason?: string;
  }): SkillVersionOutcome {
    const invocation = this.getInvocation(input.invocationId);
    const inputEvidenceIds = uniqueSorted(input.evidenceIds);
    if (inputEvidenceIds.length > 0) {
      const placeholders = inputEvidenceIds.map(() => '?').join(',');
      const validEvidence = (this.options.db.prepare(
        `SELECT evidence_id FROM job_evidence
         WHERE job_id=? AND attempt_id=? AND generation=? AND late=0
           AND evidence_id IN (${placeholders})`,
      ).all(
        invocation.jobId, invocation.attemptId, invocation.generation, ...inputEvidenceIds,
      ) as Array<{ evidence_id: string }>);
      if (validEvidence.length !== inputEvidenceIds.length) {
        throw new Error('Skill outcome Evidence must belong to the exact durable Job Attempt generation and cannot be late');
      }
    }
    const outcome = this.options.db.transaction(() => {
      const existing = this.options.db.prepare(
        'SELECT * FROM skill_version_outcomes WHERE skill_version_id=? AND job_id=?',
      ).get(invocation.skillVersionId, invocation.jobId) as OutcomeRow | undefined;
      const timestamp = this.now();
      if (existing) {
        const current = outcomeFromRow(existing);
        if (current.invocationIds.includes(invocation.id)) {
          const exactReplay = current.outcome === input.outcome
            && current.verdict === input.verdict
            && current.attributable === input.attributable
            && current.reason === (input.reason ?? null)
            && inputEvidenceIds.every((id) => current.evidenceIds.includes(id));
          if (!exactReplay) throw new Error('Terminal Skill invocation outcome cannot be rewritten');
          return current;
        }
        const invocationIds = uniqueSorted([...current.invocationIds, invocation.id]);
        const attemptIds = uniqueSorted([...current.attemptIds, invocation.attemptId]);
        const generations = uniqueSorted([...current.generations, invocation.generation]);
        const evidenceIds = uniqueSorted([...current.evidenceIds, ...inputEvidenceIds]);
        const capabilities = this.mergeCapabilities(current.capabilityVersions, invocation.capabilityVersions);
        const newestGeneration = Math.max(...current.generations);
        const staleAttempt = invocation.generation < newestGeneration;
        const nextOutcome = staleAttempt ? current.outcome : input.outcome;
        const nextVerdict = staleAttempt ? current.verdict : input.verdict;
        const nextAttributable = staleAttempt ? current.attributable : input.attributable;
        const nextReason = staleAttempt ? current.reason : (input.reason ?? null);
        this.options.db.prepare(
          `UPDATE skill_version_outcomes SET invocation_ids_json=?,attempt_ids_json=?,generations_json=?,
             capability_versions_json=?,evidence_ids_json=?,outcome=?,verdict=?,attributable=?,reason=?,updated_at=?
           WHERE skill_outcome_id=?`,
        ).run(
          stableJson(invocationIds), stableJson(attemptIds), stableJson(generations), stableJson(capabilities),
          stableJson(evidenceIds), nextOutcome, nextVerdict, nextAttributable ? 1 : 0,
          nextReason, timestamp, current.id,
        );
        this.setInvocationTerminal(invocation.id, input.outcome, timestamp);
        return outcomeFromRow(this.options.db.prepare('SELECT * FROM skill_version_outcomes WHERE skill_outcome_id=?').get(current.id) as OutcomeRow);
      }
      const id = this.idFactory('skill_outcome');
      this.options.db.prepare(
        `INSERT INTO skill_version_outcomes (
           skill_outcome_id,skill_id,skill_version_id,job_id,invocation_ids_json,attempt_ids_json,
           generations_json,capability_versions_json,evidence_ids_json,outcome,verdict,attributable,
           reason,recorded_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, invocation.skillId, invocation.skillVersionId, invocation.jobId,
        stableJson([invocation.id]), stableJson([invocation.attemptId]), stableJson([invocation.generation]),
        stableJson(invocation.capabilityVersions), stableJson(inputEvidenceIds), input.outcome,
        input.verdict, input.attributable ? 1 : 0, input.reason ?? null, timestamp, timestamp,
      );
      this.setInvocationTerminal(invocation.id, input.outcome, timestamp);
      return outcomeFromRow(this.options.db.prepare('SELECT * FROM skill_version_outcomes WHERE skill_outcome_id=?').get(id) as OutcomeRow);
    }).immediate();
    this.reconcileLearningProjections(invocation.jobId);
    return outcomeFromRow(this.options.db.prepare(
      'SELECT * FROM skill_version_outcomes WHERE skill_outcome_id=?',
    ).get(outcome.id) as OutcomeRow);
  }

  private reconcileLearningProjections(jobId: string): void {
    if (!this.outcomeProjector) return;
    const pending = this.options.db.prepare(
      `SELECT * FROM skill_version_outcomes
       WHERE job_id=? AND attributable=1 AND learning_projected_at IS NULL
         AND lower(outcome) IN ('verified_success','verified','success')
       ORDER BY recorded_at,skill_outcome_id`,
    ).all(jobId) as OutcomeRow[];
    for (const row of pending) {
      const outcome = outcomeFromRow(row);
      const invocationIds = new Set(outcome.invocationIds);
      const invocationRow = (this.options.db.prepare(
        `SELECT * FROM skill_invocations
         WHERE job_id=? AND skill_version_id=?
         ORDER BY generation DESC,started_at DESC,skill_invocation_id DESC`,
      ).all(outcome.jobId, outcome.skillVersionId) as InvocationRow[])
        .find((candidate) => invocationIds.has(candidate.skill_invocation_id));
      if (!invocationRow) {
        throw new Error('Verified Skill outcome has no exact durable invocation for Learning projection');
      }
      const invocation = invocationFromRow(invocationRow);
      this.outcomeProjector({ outcome, invocation, version: this.getVersion(outcome.skillVersionId) });
      this.options.db.prepare(
        `UPDATE skill_version_outcomes
         SET learning_projected_at=COALESCE(learning_projected_at,?)
         WHERE skill_outcome_id=?`,
      ).run(this.now(), outcome.id);
    }
  }

  listOutcomes(skillVersionId: string, scopeId?: string): SkillVersionOutcome[] {
    const rows = scopeId === undefined
      ? this.options.db.prepare(
        'SELECT * FROM skill_version_outcomes WHERE skill_version_id=? ORDER BY recorded_at,skill_outcome_id',
      ).all(skillVersionId)
      : this.options.db.prepare(
        `SELECT DISTINCT o.* FROM skill_version_outcomes o
         JOIN skill_invocations i
           ON i.job_id=o.job_id AND i.skill_version_id=o.skill_version_id
         WHERE o.skill_version_id=? AND i.scope_id=?
         ORDER BY o.recorded_at,o.skill_outcome_id`,
      ).all(skillVersionId, scopeId);
    return (rows as OutcomeRow[]).map(outcomeFromRow);
  }

  getHealth(skillVersionId: string, scopeId?: string): SkillVersionHealth {
    const outcomes = this.listOutcomes(skillVersionId, scopeId).filter((outcome) => outcome.attributable);
    const successes = outcomes.filter((outcome) => /^(?:verified_success|verified|success)$/i.test(outcome.outcome)).length;
    const failures = outcomes.filter((outcome) => /^(?:verification_failure|verified_failure|failed)$/i.test(outcome.outcome)).length;
    const unknowns = outcomes.length - successes - failures;
    const gradedSamples = successes + failures;
    const failureRate = gradedSamples > 0 ? failures / gradedSamples : null;
    const pointer = scopeId
      ? this.options.db.prepare(
          'SELECT enabled FROM skill_active_pointers WHERE skill_version_id=? AND scope_id=?',
        ).get(skillVersionId, scopeId) as { enabled: number } | undefined
      : this.options.db.prepare(
          'SELECT MAX(enabled) AS enabled FROM skill_active_pointers WHERE skill_version_id=?',
        ).get(skillVersionId) as { enabled: number | null } | undefined;
    const state: SkillVersionHealth['state'] = pointer?.enabled === 0
      ? 'disabled'
      : gradedSamples < MIN_HEALTH_SAMPLES
        ? 'insufficient_data'
        : (failureRate ?? 0) >= 0.5 ? 'degraded' : 'healthy';
    return { skillVersionId, state, attributableSamples: gradedSamples, successes, failures, unknowns, failureRate };
  }

  rollbackTarget(skillId: string, scopeId: string): SkillVersion | null {
    const active = this.resolveActive(skillId, scopeId);
    if (!active) return null;
    const row = this.options.db.prepare(
      `SELECT v.* FROM skill_versions v
       WHERE v.skill_id=? AND v.version_number<?
         AND EXISTS (
           SELECT 1 FROM skill_activation_history h
           WHERE h.skill_id=v.skill_id AND h.scope_id=? AND h.skill_version_id=v.skill_version_id
             AND h.action IN ('activate','rollback','enable')
         )
       ORDER BY v.version_number DESC LIMIT 1`,
    ).get(skillId, active.version.version, scopeId) as VersionRow | undefined;
    return row ? versionFromRow(row) : null;
  }

  rollback(input: { skillId: string; scopeId: string; targetVersionId: string; requestedBy: string }): SkillVersion {
    const target = this.getVersion(input.targetVersionId);
    if (target.skillId !== input.skillId) throw new Error('Rollback target belongs to a different Skill');
    const eligible = this.options.db.prepare(
      `SELECT 1 FROM skill_activation_history
       WHERE skill_id=? AND scope_id=? AND skill_version_id=?
         AND action IN ('activate','rollback','enable') LIMIT 1`,
    ).get(input.skillId, input.scopeId, target.id);
    if (!eligible) throw new Error('Rollback target has no activation history in this workspace scope');
    const capabilities = this.resolveCapabilities(target.capabilityRequirements, input.scopeId);
    if (capabilities.issues.length > 0) throw new Error(`Rollback target prerequisites are unavailable: ${capabilities.issues.join('; ')}`);
    const timestamp = this.now();
    this.options.db.transaction(() => this.switchPointer({
      skillId: input.skillId,
      scopeId: input.scopeId,
      versionId: target.id,
      contentDigest: target.digest,
      requestedBy: input.requestedBy,
      action: 'rollback',
      timestamp,
    })).immediate();
    return target;
  }

  importLegacy(input: {
    content: string;
    source: string;
    sourcePath: string;
    scopeId: string;
    trustLevel: string;
  }): SkillVersion {
    const parsed = parseSkillContent(input.content, input.sourcePath);
    const contentDigest = digest(input.content.replace(/\r\n?/g, '\n'));
    const skillId = `skill_${digest({ ownerId: this.options.ownerId, name: normalizedIdentifier(parsed.frontmatter.name) }).slice(0, 32)}`;
    const existing = this.options.db.prepare(
      'SELECT * FROM skill_versions WHERE skill_id=? AND content_digest=?',
    ).get(skillId, contentDigest) as VersionRow | undefined;
    if (existing) {
      const pointer = this.options.db.prepare(
        'SELECT skill_id FROM skill_active_pointers WHERE skill_id=? AND scope_id=?',
      ).get(skillId, input.scopeId) as { skill_id: string } | undefined;
      if (!pointer) {
        const timestamp = this.now();
        this.options.db.transaction(() => this.switchPointer({
          skillId,
          scopeId: input.scopeId,
          versionId: existing.skill_version_id,
          contentDigest: existing.content_digest,
          requestedBy: 'legacy-import',
          action: 'activate',
          timestamp,
        })).immediate();
      }
      return versionFromRow(existing);
    }
    const canonicalSpec = {
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      rawText: input.content,
      legacySource: input.source,
    };
    const timestamp = this.now();
    return this.options.db.transaction(() => {
      const next = (this.options.db.prepare(
        'SELECT COALESCE(MAX(version_number),0)+1 AS value FROM skill_versions WHERE skill_id=?',
      ).get(skillId) as { value: number }).value;
      const id = this.idFactory('skill_version');
      this.options.db.prepare(
        `INSERT INTO skill_versions (
           skill_version_id,skill_id,version_number,content_digest,canonical_spec_json,
           capability_requirements_json,composition_json,skill_evaluation_id,skill_approval_id,
           workflow_pattern_id,skill_candidate_id,source_kind,source_path,trust_level,legacy,created_at
         ) VALUES (?,?,?,?,?,'[]','[]',NULL,NULL,NULL,NULL,'legacy',?,?,1,?)`,
      ).run(id, skillId, next, contentDigest, stableJson(canonicalSpec), input.sourcePath, input.trustLevel, timestamp);
      this.switchPointer({
        skillId,
        scopeId: input.scopeId,
        versionId: id,
        contentDigest,
        requestedBy: 'legacy-import',
        action: 'activate',
        timestamp,
      });
      return versionFromRow(this.options.db.prepare('SELECT * FROM skill_versions WHERE skill_version_id=?').get(id) as VersionRow);
    }).immediate();
  }

  doctor(): SkillIntelligenceDoctor {
    const table = this.options.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_patterns'",
    ).get() as { name: string } | undefined;
    const count = (name: string, where = '', ...params: unknown[]) => (this.options.db.prepare(
      `SELECT COUNT(*) AS value FROM ${name}${where}`,
    ).get(...params) as { value: number }).value;
    if (!table) return { enabled: this.options.enabled, schemaReady: false, traces: 0, patterns: 0, candidates: 0, drafts: 0, active: 0, degraded: 0, drifted: 0, prerequisiteIssues: 0 };
    this.reconcilePointerIntegrity();
    const versionIds = (this.options.db.prepare('SELECT skill_version_id FROM skill_versions').all() as Array<{ skill_version_id: string }>);
    const activePointers = this.options.db.prepare(
      `SELECT p.scope_id,v.capability_requirements_json
       FROM skill_active_pointers p
       JOIN skill_versions v ON v.skill_version_id=p.skill_version_id
       WHERE p.enabled=1 AND p.drift_state='clean'
         AND p.skill_id=v.skill_id AND p.content_digest=v.content_digest`,
    ).all() as Array<{ scope_id: string; capability_requirements_json: string }>;
    const prerequisiteIssues = activePointers.filter((row) => (
      this.resolveCapabilities(
        parseJson<CapabilityRequirement[]>(row.capability_requirements_json),
        row.scope_id,
      ).issues.length > 0
    )).length;
    return {
      enabled: this.options.enabled,
      schemaReady: true,
      traces: count('workflow_traces', ' WHERE owner_id=?', this.options.ownerId),
      patterns: count('workflow_patterns', ' WHERE owner_id=?', this.options.ownerId),
      candidates: count('skill_candidates', ' WHERE owner_id=?', this.options.ownerId),
      drafts: count('skill_drafts', ' WHERE owner_id=?', this.options.ownerId),
      active: (this.options.db.prepare(
        `SELECT COUNT(*) AS value FROM skill_active_pointers p
         JOIN skill_versions v ON v.skill_version_id=p.skill_version_id
         WHERE p.enabled=1 AND p.drift_state='clean'
           AND p.skill_id=v.skill_id AND p.content_digest=v.content_digest`,
      ).get() as { value: number }).value,
      degraded: versionIds.filter((row) => this.getHealth(row.skill_version_id).state === 'degraded').length,
      drifted: count('skill_active_pointers', " WHERE drift_state<>'clean'"),
      prerequisiteIssues,
    };
  }

  private requireEnabled(): void {
    if (!this.options.enabled) throw new Error('Skill Intelligence is not enabled for this edition');
  }

  private recomputePattern(patternId: string, timestamp: number): void {
    const aggregate = this.options.db.prepare(
      `SELECT COUNT(*) AS observed,
              SUM(CASE WHEN classification='positive' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN classification='negative' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN classification='unknown' THEN 1 ELSE 0 END) AS unknown_count,
              COUNT(DISTINCT CASE WHEN classification='positive' THEN independent_key END) AS independent_positive
       FROM workflow_pattern_traces WHERE workflow_pattern_id=?`,
    ).get(patternId) as { observed: number; verified: number; failed: number; unknown_count: number; independent_positive: number };
    const denominator = aggregate.verified + aggregate.failed;
    const confidence = denominator > 0 ? aggregate.verified / denominator : 0;
    const eligible = aggregate.independent_positive >= MIN_INDEPENDENT_VERIFIED_TRACES
      && confidence >= MIN_REUSABLE_SUCCESS_RATIO;
    const current = this.options.db.prepare(
      'SELECT state FROM workflow_patterns WHERE workflow_pattern_id=?',
    ).get(patternId) as { state: WorkflowPattern['state'] } | undefined;
    const nextState = current?.state === 'dismissed' || current?.state === 'stale'
      ? current.state
      : eligible ? 'eligible' : 'observing';
    this.options.db.prepare(
      `UPDATE workflow_patterns SET observed_count=?,verified_count=?,failure_count=?,unknown_count=?,
         independent_positive_count=?,confidence=?,state=?,state_version=state_version+1,updated_at=?
       WHERE workflow_pattern_id=?`,
    ).run(
      aggregate.observed, aggregate.verified, aggregate.failed, aggregate.unknown_count,
      aggregate.independent_positive, confidence, nextState, timestamp, patternId,
    );
  }

  private patternFromRow(row: PatternRow): WorkflowPattern {
    const links = this.options.db.prepare(
      `SELECT workflow_trace_id,classification FROM workflow_pattern_traces
       WHERE workflow_pattern_id=? ORDER BY linked_at,workflow_trace_id`,
    ).all(row.workflow_pattern_id) as Array<{ workflow_trace_id: string; classification: WorkflowTraceClassification }>;
    return {
      id: row.workflow_pattern_id,
      ownerId: row.owner_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      patternDigest: row.pattern_digest,
      objectiveClass: row.objective_class,
      scopeKind: row.scope_kind,
      normalizedSteps: parseJson(row.normalized_steps_json),
      requiredCapabilities: parseJson(row.required_capabilities_json),
      positiveTraceIds: links.filter((link) => link.classification === 'positive').map((link) => link.workflow_trace_id),
      negativeTraceIds: links.filter((link) => link.classification === 'negative').map((link) => link.workflow_trace_id),
      unknownTraceIds: links.filter((link) => link.classification === 'unknown').map((link) => link.workflow_trace_id),
      observedCount: row.observed_count,
      verifiedCount: row.verified_count,
      failureCount: row.failure_count,
      unknownCount: row.unknown_count,
      independentPositiveCount: row.independent_positive_count,
      confidence: row.confidence,
      state: row.state,
      stateVersion: row.state_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private candidateFromRow = (row: CandidateRow): SkillCandidate => ({
    id: row.skill_candidate_id,
    ownerId: row.owner_id,
    scopeId: row.scope_id,
    patternId: row.workflow_pattern_id,
    digest: row.candidate_digest,
    proposedName: row.proposed_name,
    purpose: row.purpose,
    steps: parseJson(row.steps_json),
    capabilityRequirements: parseJson(row.capability_requirements_json),
    positiveTraceIds: parseJson(row.positive_trace_ids_json),
    negativeTraceIds: parseJson(row.negative_trace_ids_json),
    learningEntryIds: parseJson(row.learning_entry_ids_json),
    state: row.state,
    executable: false,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  private ensureCandidate(pattern: WorkflowPattern): SkillCandidate {
    const existing = this.getCandidateForPattern(pattern.id);
    const steps: SkillDraftStep[] = pattern.normalizedSteps.map((step) => ({
      id: `step_${step.index + 1}`,
      operation: step.operation,
      kind: 'tool',
      mutates: step.mutates,
    }));
    const traceIds = [...pattern.positiveTraceIds, ...pattern.negativeTraceIds, ...pattern.unknownTraceIds];
    const learningEntryIds = uniqueSorted(traceIds.flatMap((traceId) => {
      const row = this.options.db.prepare(
        'SELECT learning_entry_ids_json FROM workflow_traces WHERE workflow_trace_id=?',
      ).get(traceId) as { learning_entry_ids_json: string } | undefined;
      return row ? parseJson<string[]>(row.learning_entry_ids_json) : [];
    }));
    const proposedName = `${pattern.objectiveClass}-method`;
    const purpose = `Reviewed method derived from ${pattern.independentPositiveCount} independent verified workflows.`;
    const candidateDigest = digest({
      patternDigest: pattern.patternDigest,
      steps,
      capabilityRequirements: pattern.requiredCapabilities,
      positiveTraceIds: pattern.positiveTraceIds,
      negativeTraceIds: pattern.negativeTraceIds,
      learningEntryIds,
    });
    const timestamp = this.now();
    if (existing) {
      if (existing.state === 'candidate' && existing.digest !== candidateDigest) {
        const changed = this.options.db.prepare(
          `UPDATE skill_candidates SET candidate_digest=?,purpose=?,steps_json=?,
             capability_requirements_json=?,positive_trace_ids_json=?,negative_trace_ids_json=?,
             learning_entry_ids_json=?,state_version=state_version+1,updated_at=?
           WHERE skill_candidate_id=? AND state='candidate' AND state_version=?`,
        ).run(
          candidateDigest, purpose, stableJson(steps), stableJson(pattern.requiredCapabilities),
          stableJson(pattern.positiveTraceIds), stableJson(pattern.negativeTraceIds),
          stableJson(learningEntryIds), timestamp, existing.id, existing.stateVersion,
        );
        if (changed.changes !== 1) throw new Error('Skill candidate changed concurrently');
        return this.getCandidate(existing.id);
      }
      return existing;
    }
    const id = this.idFactory('candidate');
    this.options.db.prepare(
      `INSERT OR IGNORE INTO skill_candidates (
         skill_candidate_id,owner_id,scope_id,workflow_pattern_id,candidate_digest,proposed_name,purpose,
         steps_json,capability_requirements_json,positive_trace_ids_json,negative_trace_ids_json,
         learning_entry_ids_json,state,executable,state_version,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'candidate',0,1,?,?)`,
    ).run(
      id, this.options.ownerId, pattern.workspaceId ?? this.options.defaultScopeId, pattern.id,
      candidateDigest, proposedName, purpose, stableJson(steps), stableJson(pattern.requiredCapabilities),
      stableJson(pattern.positiveTraceIds), stableJson(pattern.negativeTraceIds),
      stableJson(learningEntryIds), timestamp, timestamp,
    );
    return this.getCandidateForPattern(pattern.id)!;
  }

  private revalidateCandidateSources(candidate: SkillCandidate): SkillCandidate {
    if (candidate.state === 'dismissed') return candidate;
    const pattern = this.getPatternById(candidate.patternId);
    let learningSourcesCurrent = true;
    if (candidate.learningEntryIds.length > 0) {
      const placeholders = candidate.learningEntryIds.map(() => '?').join(',');
      const current = (this.options.db.prepare(
        `SELECT entry_id FROM learning_entries
         WHERE entry_id IN (${placeholders}) AND owner_id=?
           AND lifecycle='ACTIVE' AND eligible=1 AND deleted_at IS NULL`,
      ).all(...candidate.learningEntryIds, this.options.ownerId) as Array<{ entry_id: string }>);
      learningSourcesCurrent = current.length === candidate.learningEntryIds.length;
    }
    const patternCurrent = pattern.state === 'eligible';
    if (learningSourcesCurrent && patternCurrent) return candidate;
    if (candidate.state === 'stale') return candidate;
    const timestamp = this.now();
    const candidateDigest = digest({
      patternDigest: pattern.patternDigest,
      steps: candidate.steps,
      capabilityRequirements: candidate.capabilityRequirements,
      positiveTraceIds: pattern.positiveTraceIds,
      negativeTraceIds: pattern.negativeTraceIds,
      learningEntryIds: candidate.learningEntryIds,
    });
    this.options.db.transaction(() => {
      const changed = this.options.db.prepare(
        `UPDATE skill_candidates SET state='stale',candidate_digest=?,positive_trace_ids_json=?,negative_trace_ids_json=?,
           state_version=state_version+1,updated_at=?
         WHERE skill_candidate_id=? AND state_version=? AND state<>'dismissed'`,
      ).run(
        candidateDigest, stableJson(pattern.positiveTraceIds), stableJson(pattern.negativeTraceIds),
        timestamp, candidate.id, candidate.stateVersion,
      );
      if (changed.changes !== 1) throw new Error('Skill candidate changed concurrently during source revalidation');
      if (!learningSourcesCurrent) {
        this.options.db.prepare(
          `UPDATE workflow_patterns SET state='stale',state_version=state_version+1,updated_at=?
           WHERE workflow_pattern_id=? AND state<>'dismissed'`,
        ).run(timestamp, candidate.patternId);
      }
      this.options.db.prepare(
        `UPDATE skill_drafts SET state='stale',state_version=state_version+1,updated_at=?
         WHERE skill_candidate_id=? AND state NOT IN ('stale','archived')`,
      ).run(timestamp, candidate.id);
      this.options.db.prepare(
        `UPDATE skill_management_approvals SET state='stale',state_version=state_version+1
         WHERE skill_draft_id IN (
           SELECT skill_draft_id FROM skill_drafts WHERE skill_candidate_id=?
         ) AND state IN ('pending','approved')`,
      ).run(candidate.id);
    }).immediate();
    return this.getCandidate(candidate.id);
  }

  private getPatternByDigest(workspaceId: string | null, patternDigest: string): WorkflowPattern {
    const row = this.options.db.prepare(
      'SELECT * FROM workflow_patterns WHERE owner_id=? AND workspace_id IS ? AND pattern_digest=?',
    ).get(this.options.ownerId, workspaceId, patternDigest) as PatternRow | undefined;
    if (!row) throw new Error('WorkflowPattern not found');
    return this.patternFromRow(row);
  }

  private getPatternById(id: string): WorkflowPattern {
    const row = this.options.db.prepare('SELECT * FROM workflow_patterns WHERE workflow_pattern_id=?').get(id) as PatternRow | undefined;
    if (!row) throw new Error('WorkflowPattern not found');
    return this.patternFromRow(row);
  }

  private getCandidateForPattern(patternId: string): SkillCandidate | null {
    const row = this.options.db.prepare(
      'SELECT * FROM skill_candidates WHERE owner_id=? AND workflow_pattern_id=?',
    ).get(this.options.ownerId, patternId) as CandidateRow | undefined;
    return row ? this.candidateFromRow(row) : null;
  }

  private getCandidate(id: string): SkillCandidate {
    const row = this.options.db.prepare('SELECT * FROM skill_candidates WHERE skill_candidate_id=?').get(id) as CandidateRow | undefined;
    if (!row || row.owner_id !== this.options.ownerId) throw new Error('SkillCandidate not found');
    return this.candidateFromRow(row);
  }

  private resolveEvaluationFixtures(candidate: SkillCandidate | null): {
    fixtures: SkillEvaluationFixture[];
    digest: string;
    issues: string[];
  } {
    if (!candidate) {
      const fixtures: SkillEvaluationFixture[] = [];
      return { fixtures, digest: digest({ candidateId: null, fixtures }), issues: [] };
    }
    const pattern = this.getPatternById(candidate.patternId);
    const expected = new Map<string, 'positive' | 'negative'>();
    const issues: string[] = [];
    for (const traceId of candidate.positiveTraceIds) expected.set(traceId, 'positive');
    for (const traceId of candidate.negativeTraceIds) {
      if (expected.has(traceId)) issues.push(`${traceId}: fixture cannot be both positive and negative`);
      expected.set(traceId, 'negative');
    }
    const traceIds = [...expected.keys()].sort();
    if (traceIds.length === 0) issues.push('Candidate has no exact source trace fixtures');
    const rows = traceIds.length === 0
      ? []
      : this.options.db.prepare(
        `SELECT t.*,l.classification AS linked_classification
         FROM workflow_pattern_traces l
         JOIN workflow_traces t ON t.workflow_trace_id=l.workflow_trace_id
         WHERE l.workflow_pattern_id=? AND t.owner_id=?
           AND t.workflow_trace_id IN (${traceIds.map(() => '?').join(',')})
         ORDER BY t.workflow_trace_id`,
      ).all(candidate.patternId, this.options.ownerId, ...traceIds) as Array<TraceRow & {
        linked_classification: WorkflowTraceClassification;
      }>;
    const byId = new Map(rows.map((row) => [row.workflow_trace_id, row]));
    const fixtures: SkillEvaluationFixture[] = [];
    for (const traceId of traceIds) {
      const row = byId.get(traceId);
      const expectedClassification = expected.get(traceId)!;
      if (!row) {
        issues.push(`${traceId}: source trace fixture is unavailable for the exact pattern`);
        continue;
      }
      if (row.classification !== expectedClassification || row.linked_classification !== expectedClassification) {
        issues.push(`${traceId}: source trace classification does not match the reviewed candidate`);
        continue;
      }
      if (row.pattern_digest !== pattern.patternDigest) {
        issues.push(`${traceId}: source trace pattern digest does not match`);
      }
      const evidenceIds = uniqueSorted(parseJson<string[]>(row.evidence_ids_json));
      if (expectedClassification === 'positive' && evidenceIds.length === 0) {
        issues.push(`${traceId}: positive fixture has no exact durable Evidence`);
      }
      const durableEvidence = evidenceIds.flatMap((evidenceId) => {
        const evidence = this.options.db.prepare(
          `SELECT evidence_id,job_id,attempt_id,generation,late,verification_result,coverage
           FROM job_evidence WHERE evidence_id=?`,
        ).get(evidenceId) as {
          evidence_id: string;
          job_id: string;
          attempt_id: string;
          generation: number;
          late: number;
          verification_result: string;
          coverage: string;
        } | undefined;
        if (!evidence) {
          issues.push(`${traceId}: durable Evidence ${evidenceId} is unavailable`);
          return [];
        }
        if (evidence.job_id !== row.job_id || evidence.attempt_id !== row.attempt_id
            || evidence.generation !== row.generation || evidence.late !== 0) {
          issues.push(`${traceId}: Evidence ${evidenceId} no longer matches the exact non-late Job Attempt fixture`);
        }
        return [evidence];
      });
      if (expectedClassification === 'positive'
          && !durableEvidence.some((evidence) => (
            /^(?:verified|ok|passed|success)$/i.test(evidence.verification_result)
            && evidence.coverage !== 'none'
          ))) {
        issues.push(`${traceId}: positive fixture has no current verified Evidence`);
      }
      if (!row.source_digest) issues.push(`${traceId}: source trace digest is unavailable`);
      fixtures.push({
        traceId,
        classification: expectedClassification,
        sourceDigest: row.source_digest,
        evidenceIds,
      });
    }
    const fixtureDigest = digest({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      patternId: pattern.id,
      patternDigest: pattern.patternDigest,
      fixtures,
    });
    return { fixtures, digest: fixtureDigest, issues: uniqueSorted(issues) };
  }

  private getDraft(id: string): SkillDraft {
    const row = this.options.db.prepare('SELECT * FROM skill_drafts WHERE skill_draft_id=?').get(id) as DraftRow | undefined;
    if (!row || row.owner_id !== this.options.ownerId) throw new Error('SkillDraft not found');
    return draftFromRow(row);
  }

  private getEvaluation(id: string): SkillEvaluation {
    const row = this.options.db.prepare('SELECT * FROM skill_evaluations WHERE skill_evaluation_id=?').get(id) as EvaluationRow | undefined;
    if (!row) throw new Error('SkillEvaluation not found');
    return evaluationFromRow(row);
  }

  private getApproval(id: string): SkillManagementApproval {
    const row = this.options.db.prepare('SELECT * FROM skill_management_approvals WHERE skill_approval_id=?').get(id) as ApprovalRow | undefined;
    if (!row || row.owner_id !== this.options.ownerId) throw new Error('Skill approval not found');
    return approvalFromRow(row);
  }

  private getVersion(id: string): SkillVersion {
    const row = this.options.db.prepare('SELECT * FROM skill_versions WHERE skill_version_id=?').get(id) as VersionRow | undefined;
    if (!row) throw new Error('SkillVersion not found');
    return versionFromRow(row);
  }

  private getInvocation(id: string): SkillInvocation {
    const row = this.options.db.prepare('SELECT * FROM skill_invocations WHERE skill_invocation_id=?').get(id) as InvocationRow | undefined;
    if (!row) throw new Error('Skill invocation not found');
    return invocationFromRow(row);
  }

  private normalizeRequirements(requirements: CapabilityRequirement[]): CapabilityRequirement[] {
    return requirements.map((requirement) => ({
      capabilityId: requirement.capabilityId.trim(),
      versionRange: requirement.versionRange?.trim() || undefined,
      requiredPermissions: uniqueSorted(requirement.requiredPermissions.map((item) => item.trim()).filter(Boolean)),
      required: requirement.required,
      fallbackGroup: requirement.fallbackGroup?.trim() || undefined,
    })).sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  }

  private buildCanonicalSpec(input: {
    name: string;
    description: string;
    steps: SkillDraftStep[];
    capabilityRequirements: CapabilityRequirement[];
    composition: string[];
    expectedEvidence: string[];
  }): Record<string, unknown> {
    return {
      frontmatter: {
        name: input.name,
        description: input.description,
        version: 'draft',
        metadata: { aiden: { skillIntelligence: { declarative: true } } },
      },
      procedure: {
        steps: input.steps,
        capabilityRequirements: input.capabilityRequirements,
        composition: input.composition,
        expectedEvidence: input.expectedEvidence,
      },
    };
  }

  private evaluateDraftSchema(draft: SkillDraft): { passed: boolean; detail: string } {
    const issues: string[] = [];
    if (!draft.name.trim()) issues.push('name is required');
    if (!draft.description.trim()) issues.push('description is required');
    if (!Array.isArray(draft.steps) || draft.steps.length === 0) {
      issues.push('at least one declarative step is required');
    } else {
      for (const [index, step] of draft.steps.entries()) {
        const label = `step ${index + 1}`;
        if (!step || typeof step !== 'object') {
          issues.push(`${label} must be an object`);
          continue;
        }
        if (typeof step.id !== 'string' || !step.id.trim()) issues.push(`${label} id is required`);
        if (typeof step.operation !== 'string' || !step.operation.trim()) issues.push(`${label} operation is required`);
        if (step.kind !== 'tool' && step.kind !== 'skill') issues.push(`${label} kind must be tool or skill`);
        if (typeof step.mutates !== 'boolean') issues.push(`${label} mutates must be boolean`);
        if (step.kind === 'skill' && (typeof step.childSkillVersionId !== 'string' || !step.childSkillVersionId.trim())) {
          issues.push(`${label} must bind an exact child SkillVersion`);
        }
        if (step.kind === 'tool' && step.childSkillVersionId !== undefined) {
          issues.push(`${label} cannot bind a child SkillVersion`);
        }
        if (step.fallbackStepIds !== undefined
            && (!Array.isArray(step.fallbackStepIds)
              || step.fallbackStepIds.some((id) => typeof id !== 'string' || !id.trim()))) {
          issues.push(`${label} fallback identities must be non-empty strings`);
        }
      }
    }
    for (const [index, requirement] of draft.capabilityRequirements.entries()) {
      const label = `capability requirement ${index + 1}`;
      if (!requirement.capabilityId.trim()) issues.push(`${label} identity is required`);
      if (typeof requirement.required !== 'boolean') issues.push(`${label} required must be boolean`);
      if (!Array.isArray(requirement.requiredPermissions)) issues.push(`${label} permissions must be an array`);
    }
    return issues.length === 0
      ? { passed: true, detail: 'Draft matches the declarative Skill schema' }
      : { passed: false, detail: issues.join('; ') };
  }

  private assertSafeDraft(spec: Record<string, unknown>): void {
    assertNoSensitiveContent(spec);
    assertNoExecutableCode(spec);
    const serialized = stableJson(spec);
    if (/ignore (?:all )?(?:previous|prior) instructions|system prompt|developer message/i.test(serialized)) {
      throw new Error('Skill content contains prompt-injection instructions');
    }
    const parsed = parseSkillContent(
      `---\nname: managed-review\ndescription: Deterministic managed draft.\nversion: 1\n---\n${serialized}`,
      '<managed-skill-draft>',
    );
    const dangerous = this.securityScanner.scan(parsed).filter((finding) => finding.severity === 'dangerous');
    if (dangerous.length > 0) throw new Error(`Skill security scan failed: ${dangerous.map((finding) => finding.description).join(', ')}`);
  }

  private evaluateComposition(draft: SkillDraft): { passed: boolean; detail: string } {
    if (draft.composition.length > MAX_CHILD_SKILLS) {
      return { passed: false, detail: `Composition exceeds ${MAX_CHILD_SKILLS} child Skills` };
    }
    const visited = new Set<string>();
    const active = new Set<string>();
    let expandedSteps = draft.steps.length;
    const walk = (versionId: string, depth: number): boolean => {
      if (depth > MAX_COMPOSITION_DEPTH || active.has(versionId)) return false;
      if (visited.has(versionId)) return true;
      const row = this.options.db.prepare('SELECT * FROM skill_versions WHERE skill_version_id=?').get(versionId) as VersionRow | undefined;
      if (!row) return false;
      const pointer = this.options.db.prepare(
        `SELECT enabled,drift_state,content_digest FROM skill_active_pointers
         WHERE skill_id=? AND scope_id=? AND skill_version_id=?`,
      ).get(row.skill_id, draft.scopeId, versionId) as {
        enabled: number;
        drift_state: SkillActivePointer['driftState'];
        content_digest: string;
      } | undefined;
      if (!pointer || pointer.enabled !== 1 || pointer.drift_state !== 'clean'
          || pointer.content_digest !== row.content_digest) return false;
      if (this.resolveCapabilities(parseJson(row.capability_requirements_json), draft.scopeId).issues.length > 0) return false;
      active.add(versionId);
      const spec = parseJson<Record<string, any>>(row.canonical_spec_json);
      expandedSteps += Array.isArray(spec?.procedure?.steps) ? spec.procedure.steps.length : 0;
      if (expandedSteps > MAX_STEPS) return false;
      for (const child of parseJson<string[]>(row.composition_json)) {
        if (!walk(child, depth + 1)) return false;
      }
      active.delete(versionId);
      visited.add(versionId);
      return true;
    };
    const passed = draft.composition.every((versionId) => walk(versionId, 1));
    return {
      passed,
      detail: passed
        ? `Composition is acyclic, depth <= ${MAX_COMPOSITION_DEPTH}, and expanded steps <= ${MAX_STEPS}`
        : 'Composition contains a missing SkillVersion, cycle, excessive depth, or excessive expanded steps',
    };
  }

  private evaluateFallbackGraph(steps: SkillDraftStep[]): { passed: boolean; detail: string } {
    const ids = new Set(steps.map((step) => step.id));
    let edgeCount = 0;
    const graph = new Map<string, string[]>();
    for (const step of steps) {
      const fallbacks = step.fallbackStepIds ?? [];
      edgeCount += fallbacks.length;
      if (fallbacks.length !== new Set(fallbacks).size
          || fallbacks.some((id) => id === step.id || !ids.has(id))) {
        return { passed: false, detail: 'Fallbacks must reference distinct existing steps and cannot reference themselves' };
      }
      graph.set(step.id, fallbacks);
    }
    if (edgeCount > MAX_TOTAL_FALLBACK_EDGES) {
      return { passed: false, detail: `Procedure exceeds ${MAX_TOTAL_FALLBACK_EDGES} total fallback edges` };
    }
    const visited = new Set<string>();
    const active = new Set<string>();
    const walk = (id: string): boolean => {
      if (active.has(id)) return false;
      if (visited.has(id)) return true;
      active.add(id);
      for (const child of graph.get(id) ?? []) {
        if (!walk(child)) return false;
      }
      active.delete(id);
      visited.add(id);
      return true;
    };
    if (!steps.every((step) => walk(step.id))) {
      return { passed: false, detail: 'Fallback graph must be acyclic' };
    }
    return { passed: true, detail: `Fallback graph is acyclic and bounded to ${MAX_FALLBACKS} per step` };
  }

  private resolveCapabilities(requirements: CapabilityRequirement[], scopeId: string): {
    environment: Array<Record<string, unknown>>;
    issues: string[];
  } {
    const environment: Array<Record<string, unknown>> = [];
    const issues: string[] = [];
    const fallbackGroups = new Map<string, { required: boolean; ready: boolean; details: string[] }>();
    for (const requirement of requirements) {
      const row = this.options.db.prepare(
        `SELECT a.version,a.digest,v.manifest_json,h.state AS health_state
         FROM capability_active_versions a
         JOIN capability_versions v ON v.capability_id=a.capability_id AND v.version=a.version AND v.digest=a.digest
         LEFT JOIN capability_health h ON h.capability_id=a.capability_id AND h.version=a.version AND h.digest=a.digest
         WHERE a.capability_id=? AND a.scope_id=? AND a.enabled=1 AND v.uninstalled_at IS NULL`,
      ).get(requirement.capabilityId, scopeId) as {
        version: string; digest: string; manifest_json: string; health_state: string | null;
      } | undefined;
      let compatible = false;
      let healthy = false;
      let grantedPermissions: string[] = [];
      let missingPermissions = [...requirement.requiredPermissions];
      let detail = `${requirement.capabilityId}: required capability is not active`;
      if (!row) {
        environment.push({
          capabilityId: requirement.capabilityId,
          state: 'missing',
          ready: false,
          fallbackGroup: requirement.fallbackGroup ?? null,
        });
      } else {
        compatible = true;
        if (requirement.versionRange) {
          try { compatible = satisfies(row.version, requirement.versionRange, { includePrerelease: true }); }
          catch { compatible = false; }
        }
        healthy = row.health_state === 'healthy';
        const granted = this.options.db.prepare(
          `SELECT permission FROM capability_grants
           WHERE capability_id=? AND version=? AND digest=? AND owner_id=? AND workspace_id=? AND revoked_at IS NULL`,
        ).all(
          requirement.capabilityId, row.version, row.digest, this.options.ownerId, scopeId,
        ) as Array<{ permission: string }>;
        grantedPermissions = uniqueSorted(granted.map((item) => item.permission));
        const grantedSet = new Set(grantedPermissions);
        missingPermissions = requirement.requiredPermissions.filter((permission) => !grantedSet.has(permission));
        detail = !compatible
          ? `${requirement.capabilityId}: active version ${row.version} does not satisfy ${requirement.versionRange}`
          : !healthy
            ? `${requirement.capabilityId}: capability is not healthy`
            : `${requirement.capabilityId}: permission missing (${missingPermissions.join(', ')})`;
        environment.push({
          capabilityId: requirement.capabilityId,
          version: row.version,
          digest: row.digest,
          health: row.health_state ?? 'unknown',
          permissions: grantedPermissions,
          compatible,
          ready: compatible && healthy && missingPermissions.length === 0,
          fallbackGroup: requirement.fallbackGroup ?? null,
        });
      }
      const ready = Boolean(row && compatible && healthy && missingPermissions.length === 0);
      if (requirement.fallbackGroup) {
        const group = fallbackGroups.get(requirement.fallbackGroup) ?? { required: false, ready: false, details: [] };
        group.required ||= requirement.required;
        group.ready ||= ready;
        if (!ready) group.details.push(detail);
        fallbackGroups.set(requirement.fallbackGroup, group);
      } else if (requirement.required && !ready) {
        issues.push(detail);
      }
    }
    for (const [groupId, group] of fallbackGroups) {
      if (group.required && !group.ready) {
        issues.push(`${groupId}: no fallback capability is ready (${group.details.join('; ')})`);
      }
    }
    return { environment, issues };
  }

  private switchPointer(input: {
    skillId: string;
    scopeId: string;
    versionId: string;
    contentDigest: string;
    requestedBy: string;
    action: 'activate' | 'rollback';
    timestamp: number;
  }): void {
    this.options.db.prepare(
      `INSERT INTO skill_active_pointers (
         skill_id,scope_id,skill_version_id,content_digest,enabled,drift_state,state_version,activated_at
       ) VALUES (?,?,?,?,1,'clean',1,?)
       ON CONFLICT(skill_id,scope_id) DO UPDATE SET
         skill_version_id=excluded.skill_version_id,
         content_digest=excluded.content_digest,
         enabled=1,
         drift_state='clean',
         state_version=skill_active_pointers.state_version+1,
         activated_at=excluded.activated_at`,
    ).run(input.skillId, input.scopeId, input.versionId, input.contentDigest, input.timestamp);
    this.options.db.prepare(
      `INSERT INTO skill_activation_history (
         skill_id,scope_id,skill_version_id,content_digest,action,requested_by,activated_at
       ) VALUES (?,?,?,?,?,?,?)`,
    ).run(
      input.skillId, input.scopeId, input.versionId, input.contentDigest,
      input.action, input.requestedBy, input.timestamp,
    );
  }

  private mergeCapabilities(
    left: ResolvedCapabilityVersion[],
    right: ResolvedCapabilityVersion[],
  ): ResolvedCapabilityVersion[] {
    const values = new Map<string, ResolvedCapabilityVersion>();
    for (const item of [...left, ...right]) values.set(`${item.capabilityId}\0${item.version}\0${item.digest}`, item);
    return [...values.values()].sort((a, b) => `${a.capabilityId}\0${a.version}\0${a.digest}`.localeCompare(`${b.capabilityId}\0${b.version}\0${b.digest}`));
  }

  private reconcilePointerIntegrity(scopeId?: string, skillId?: string): void {
    const clauses: string[] = [];
    const params: string[] = [];
    if (scopeId) { clauses.push('p.scope_id=?'); params.push(scopeId); }
    if (skillId) { clauses.push('p.skill_id=?'); params.push(skillId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.options.db.prepare(
      `SELECT p.skill_id,p.scope_id,p.content_digest,p.enabled,p.drift_state,p.state_version,
              v.skill_id AS version_skill_id,v.content_digest AS version_digest,
              v.source_kind,v.source_path
       FROM skill_active_pointers p
       LEFT JOIN skill_versions v ON v.skill_version_id=p.skill_version_id
       ${where}`,
    ).all(...params) as Array<{
      skill_id: string;
      scope_id: string;
      content_digest: string;
      enabled: number;
      drift_state: SkillActivePointer['driftState'];
      state_version: number;
      version_skill_id: string | null;
      version_digest: string | null;
      source_kind: SkillVersion['sourceKind'] | null;
      source_path: string | null;
    }>;
    for (const row of rows) {
      let state: 'drifted' | 'missing' | null = row.version_digest === null
        ? 'missing'
        : row.skill_id !== row.version_skill_id || row.content_digest !== row.version_digest
          ? 'drifted'
          : null;
      if (!state && row.source_kind === 'legacy' && row.source_path
          && !/^<[^>]+>$/.test(row.source_path)) {
        try {
          const current = readFileSync(row.source_path, 'utf8').replace(/\r\n?/g, '\n');
          if (digest(current) !== row.version_digest) state = 'drifted';
        } catch {
          state = 'missing';
        }
      }
      if (!state || (!row.enabled && row.drift_state === state)) continue;
      this.markPointerDrift({
        skillId: row.skill_id,
        scopeId: row.scope_id,
        expectedVersion: row.state_version,
        state,
      });
    }
  }

  private setInvocationTerminal(invocationId: string, outcome: string, timestamp: number): void {
    const state: SkillInvocation['state'] = /(?:success|verified|completed)/i.test(outcome)
      ? 'completed'
      : /cancel/i.test(outcome) ? 'cancelled' : /unknown/i.test(outcome) ? 'unknown' : 'failed';
    this.options.db.prepare(
      'UPDATE skill_invocations SET state=?,terminal_at=? WHERE skill_invocation_id=?',
    ).run(state, timestamp, invocationId);
  }
}

export function createSkillIntelligenceAuthority(
  options: SkillIntelligenceAuthorityOptions,
): SkillIntelligenceAuthority {
  return new SkillIntelligenceAuthority(options);
}
