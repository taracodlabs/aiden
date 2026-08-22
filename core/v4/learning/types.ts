/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type LearningScopeKind =
  | 'USER_GLOBAL'
  | 'WORKSPACE'
  | 'PROJECT'
  | 'REPOSITORY'
  | 'AUTOMATION'
  | 'SKILL';

export type LearningType =
  | 'USER_PREFERENCE'
  | 'USER_CORRECTION'
  | 'WORKSPACE_CONVENTION'
  | 'VERIFIED_PROCEDURE_LESSON'
  | 'TOOL_RELIABILITY_LESSON'
  | 'SKILL_RELIABILITY'
  | 'PRESENCE_FEEDBACK'
  | 'RECOVERY_LESSON';

export type LearningConfidence = 'CANDIDATE' | 'OBSERVED' | 'CORROBORATED' | 'TRUSTED';
export type LearningLifecycle = 'ACTIVE' | 'CONFLICTED' | 'STALE' | 'DEMOTED' | 'ARCHIVED' | 'DELETED';
export type LearningSourceKind =
  | 'USER_EXPLICIT'
  | 'USER_CORRECTION'
  | 'EVIDENCE'
  | 'SKILL_OUTCOME'
  | 'PRESENCE_FEEDBACK'
  | 'RECOVERY'
  | 'LEGACY_MEMORY'
  | 'MODEL_PROSE'
  | 'SYSTEM_POLICY';
export type LearningSourceVerification =
  | 'explicit_user'
  | 'verified'
  | 'unverified'
  | 'late'
  | 'unknown_effect'
  | 'invalid';

export interface LearningScope {
  kind: LearningScopeKind;
  key: string;
  ownerId: string;
  workspaceId: string | null;
}

export interface LearningSourceInput {
  kind: LearningSourceKind;
  identity: string;
  revision: string;
  independentKey: string;
  jobId?: string | null;
  attemptId?: string | null;
  generation?: number | null;
  evidenceId?: string | null;
  effectId?: string | null;
  presenceId?: string | null;
  automationId?: string | null;
  skillName?: string | null;
  recoveryId?: string | null;
  occurredAt?: number;
  metadata?: Record<string, unknown>;
}

export interface LearningCaptureInput {
  scope: LearningScope;
  type: LearningType;
  subjectKey: string;
  content: string;
  source: LearningSourceInput;
  expiresAt?: number | null;
}

export interface LearningEntry {
  id: string;
  scope: LearningScope;
  type: LearningType;
  subjectKey: string;
  confidence: LearningConfidence;
  lifecycle: LearningLifecycle;
  content: string | null;
  contentDigest: string | null;
  eligible: boolean;
  sourceCount: number;
  version: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type LearningEventType =
  | 'CAPTURED'
  | 'SOURCE_LINKED'
  | 'PROMOTED'
  | 'CORRECTED'
  | 'ROLLED_BACK'
  | 'CONFLICTED'
  | 'REVALIDATED'
  | 'STALE'
  | 'DEMOTED'
  | 'ARCHIVED'
  | 'DELETED';

export interface LearningEvent {
  sequence: number;
  id: string;
  entryId: string;
  type: LearningEventType;
  sourceId: string;
  versionId: string | null;
  entryVersion: number;
  confidence: LearningConfidence;
  lifecycle: LearningLifecycle;
  eligible: boolean;
  sourceCount: number;
  expiresAt: number | null;
  contentDigest: string | null;
  relatedEntryId: string | null;
  reasonCode: string | null;
  createdAt: number;
}

export interface LearningContentVersion {
  id: string;
  entryId: string;
  content: string;
  contentDigest: string;
  createdAt: number;
}

export interface LearningConflict {
  id: string;
  leftEntryId: string;
  rightEntryId: string;
  state: 'OPEN' | 'RESOLVED';
  reasonCode: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface LearningRetrievalItem extends LearningEntry {
  score: number;
  reasons: string[];
}

export interface LearningRetrievalResult {
  items: LearningRetrievalItem[];
  context: string;
}

export interface LearningExport {
  exportedAt: number;
  entries: LearningEntry[];
  events: LearningEvent[];
  versions: LearningContentVersion[];
  sources: Array<{
    id: string;
    entryId: string;
    kind: LearningSourceKind;
    identity: string;
    revision: string;
    verification: LearningSourceVerification;
    jobId: string | null;
    attemptId: string | null;
    generation: number | null;
    evidenceId: string | null;
    effectId: string | null;
    presenceId: string | null;
    automationId: string | null;
    skillName: string | null;
    recoveryId: string | null;
    occurredAt: number;
  }>;
  conflicts: LearningConflict[];
}
