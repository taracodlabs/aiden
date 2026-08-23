/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type WorkflowTraceClassification = 'positive' | 'negative' | 'unknown';
export type WorkflowPatternState = 'observing' | 'eligible' | 'stale' | 'dismissed';

export interface NormalizedWorkflowStep {
  index: number;
  operation: string;
  kind: 'tool' | 'capability' | 'effect';
  mutates: boolean;
}

export interface CapabilityRequirement {
  capabilityId: string;
  versionRange?: string;
  requiredPermissions: string[];
  required: boolean;
  fallbackGroup?: string;
}

export interface SkillDraftStep {
  id: string;
  operation: string;
  kind: 'tool' | 'skill';
  mutates: boolean;
  childSkillVersionId?: string;
  fallbackStepIds?: string[];
}

export interface WorkflowTrace {
  id: string;
  ownerId: string;
  workspaceId: string | null;
  projectId: string | null;
  jobId: string;
  attemptId: string;
  generation: number;
  automationOccurrenceId: string | null;
  independentKey: string;
  patternDigest: string;
  objectiveClass: string;
  scopeKind: string;
  normalizedSteps: NormalizedWorkflowStep[];
  skillInvocationIds: string[];
  capabilityInvocationIds: string[];
  requiredCapabilities: CapabilityRequirement[];
  effectIds: string[];
  effectClasses: string[];
  evidenceIds: string[];
  learningEntryIds: string[];
  classification: WorkflowTraceClassification;
  verdict: string;
  sourceDigest: string;
  observedAt: number;
}

export interface WorkflowPattern {
  id: string;
  ownerId: string;
  workspaceId: string | null;
  projectId: string | null;
  patternDigest: string;
  objectiveClass: string;
  scopeKind: string;
  normalizedSteps: NormalizedWorkflowStep[];
  requiredCapabilities: CapabilityRequirement[];
  positiveTraceIds: string[];
  negativeTraceIds: string[];
  unknownTraceIds: string[];
  observedCount: number;
  verifiedCount: number;
  failureCount: number;
  unknownCount: number;
  independentPositiveCount: number;
  confidence: number;
  state: WorkflowPatternState;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillCandidate {
  id: string;
  ownerId: string;
  scopeId: string;
  patternId: string;
  digest: string;
  proposedName: string;
  purpose: string;
  steps: SkillDraftStep[];
  capabilityRequirements: CapabilityRequirement[];
  positiveTraceIds: string[];
  negativeTraceIds: string[];
  learningEntryIds: string[];
  state: 'candidate' | 'accepted' | 'dismissed' | 'stale';
  executable: false;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillDraft {
  id: string;
  skillId: string;
  candidateId: string | null;
  ownerId: string;
  scopeId: string;
  name: string;
  description: string;
  steps: SkillDraftStep[];
  capabilityRequirements: CapabilityRequirement[];
  composition: string[];
  expectedEvidence: string[];
  canonicalSpec: Record<string, unknown>;
  digest: string;
  state: 'draft' | 'evaluating' | 'evaluated' | 'stale' | 'archived';
  executable: false;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillEvaluationCheck {
  code: string;
  passed: boolean;
  detail: string;
}

export interface SkillEvaluationFixture {
  traceId: string;
  classification: 'positive' | 'negative';
  sourceDigest: string;
  evidenceIds: string[];
}

export interface SkillEvaluation {
  id: string;
  draftId: string;
  draftDigest: string;
  digest: string;
  evaluatorVersion: number;
  capabilityEnvironmentDigest: string;
  sourceFixtureDigest: string;
  sourceFixtures: SkillEvaluationFixture[];
  checks: SkillEvaluationCheck[];
  passed: boolean;
  state: 'running' | 'passed' | 'failed' | 'interrupted';
  startedAt: number;
  completedAt: number | null;
}

export interface SkillManagementApproval {
  id: string;
  skillId: string;
  draftId: string;
  evaluationId: string;
  ownerId: string;
  scopeId: string;
  draftDigest: string;
  evaluationDigest: string;
  capabilityRequirementsDigest: string;
  state: 'pending' | 'approved' | 'denied' | 'stale';
  requestedBy: string;
  requestedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  stateVersion: number;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: number;
  digest: string;
  canonicalSpec: Record<string, unknown>;
  capabilityRequirements: CapabilityRequirement[];
  composition: string[];
  evaluationId: string | null;
  approvalId: string | null;
  patternId: string | null;
  candidateId: string | null;
  sourceKind: 'intelligence' | 'legacy';
  sourcePath: string | null;
  trustLevel: string | null;
  legacy: boolean;
  createdAt: number;
}

export interface ResolvedSkillVersion {
  skillId: string;
  scopeId: string;
  enabled: boolean;
  driftState: 'clean' | 'drifted' | 'missing' | 'unknown';
  stateVersion: number;
  activatedAt: number;
  version: SkillVersion;
}

export interface SkillActivePointer {
  skillId: string;
  scopeId: string;
  skillVersionId: string;
  digest: string;
  enabled: boolean;
  driftState: 'clean' | 'drifted' | 'missing' | 'unknown';
  stateVersion: number;
  activatedAt: number;
}

export interface ResolvedCapabilityVersion {
  capabilityId: string;
  version: string;
  digest: string;
}

export interface SkillInvocation {
  id: string;
  skillId: string;
  skillVersionId: string;
  digest: string;
  scopeId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  toolCallId: string;
  capabilityVersions: ResolvedCapabilityVersion[];
  compositionPath: string[];
  fallbackFromInvocationId: string | null;
  state: 'admitted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  startedAt: number;
  terminalAt: number | null;
}

export interface SkillVersionOutcome {
  id: string;
  skillId: string;
  skillVersionId: string;
  jobId: string;
  invocationIds: string[];
  attemptIds: string[];
  generations: number[];
  capabilityVersions: ResolvedCapabilityVersion[];
  evidenceIds: string[];
  outcome: string;
  verdict: string;
  attributable: boolean;
  reason: string | null;
  learningProjectedAt: number | null;
  recordedAt: number;
  updatedAt: number;
}

export interface SkillVersionHealth {
  skillVersionId: string;
  state: 'insufficient_data' | 'healthy' | 'degraded' | 'disabled';
  attributableSamples: number;
  successes: number;
  failures: number;
  unknowns: number;
  failureRate: number | null;
}

export interface SkillIntelligenceDoctor {
  enabled: boolean;
  schemaReady: boolean;
  traces: number;
  patterns: number;
  candidates: number;
  drafts: number;
  active: number;
  degraded: number;
  drifted: number;
  prerequisiteIssues: number;
}
