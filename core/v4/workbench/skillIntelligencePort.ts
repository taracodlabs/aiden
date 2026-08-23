/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { EditionAuthority } from '../commercial/edition';
import type { PresenceObservation } from '../presence/types';
import type { SkillIntelligenceAuthority } from '../skillIntelligence/authority';
import { projectSkillIntelligenceObservations } from '../skillIntelligence/presenceProjection';
import type {
  CapabilityRequirement,
  SkillDraftStep,
  SkillVersion,
} from '../skillIntelligence/types';

export interface WorkbenchSkillIntelligenceSnapshot {
  enabled: boolean;
  doctor: ReturnType<SkillIntelligenceAuthority['doctor']>;
  candidates: ReturnType<SkillIntelligenceAuthority['listCandidates']>;
  drafts: ReturnType<SkillIntelligenceAuthority['listDrafts']>;
  evaluations: ReturnType<SkillIntelligenceAuthority['listEvaluations']>;
  approvals: ReturnType<SkillIntelligenceAuthority['listApprovals']>;
  active: Array<{
    pointer: ReturnType<SkillIntelligenceAuthority['listPointers']>[number];
    version: SkillVersion;
    versions: SkillVersion[];
    health: ReturnType<SkillIntelligenceAuthority['getHealth']>;
    outcomes: ReturnType<SkillIntelligenceAuthority['listOutcomes']>;
    rollbackTarget: SkillVersion | null;
  }>;
}

export interface WorkbenchSkillIntelligencePort {
  snapshot(): WorkbenchSkillIntelligenceSnapshot;
  reviewCandidate(candidateId: string): ReturnType<SkillIntelligenceAuthority['reviewCandidate']>;
  dismissCandidate(input: { candidateId: string; expectedVersion: number }): WorkbenchSkillIntelligenceSnapshot;
  createDraft(input: {
    candidateId: string;
    name: string;
    description: string;
    steps: SkillDraftStep[];
    capabilityRequirements?: CapabilityRequirement[];
    composition?: string[];
    expectedEvidence: string[];
  }): WorkbenchSkillIntelligenceSnapshot;
  updateDraft(input: {
    draftId: string;
    expectedVersion: number;
    name?: string;
    description?: string;
    steps?: SkillDraftStep[];
    capabilityRequirements?: CapabilityRequirement[];
    composition?: string[];
    expectedEvidence?: string[];
  }): WorkbenchSkillIntelligenceSnapshot;
  evaluate(draftId: string): WorkbenchSkillIntelligenceSnapshot;
  requestApproval(input: { draftId: string; evaluationId: string }): WorkbenchSkillIntelligenceSnapshot;
  decideApproval(input: {
    approvalId: string;
    draftDigest: string;
    evaluationDigest: string;
    decision: 'approved' | 'denied';
  }): WorkbenchSkillIntelligenceSnapshot;
  activate(approvalId: string): WorkbenchSkillIntelligenceSnapshot;
  disable(skillId: string): WorkbenchSkillIntelligenceSnapshot;
  rollback(input: { skillId: string; targetVersionId: string }): WorkbenchSkillIntelligenceSnapshot;
}

export function createWorkbenchSkillIntelligencePort(options: {
  authority: SkillIntelligenceAuthority;
  edition: EditionAuthority;
  scopeId: string;
  ownerId: string;
  onPresence?: (observation: PresenceObservation) => void;
}): WorkbenchSkillIntelligencePort {
  const requireEnabled = (): void => {
    if (!options.edition.can('skill.intelligence')) {
      throw new Error('Skill Intelligence creation and activation requires Aiden Pro');
    }
  };
  const syncPresence = (): void => {
    if (!options.onPresence || !options.edition.can('presence.active')) return;
    for (const observation of projectSkillIntelligenceObservations({
      authority: options.authority,
      scopeId: options.scopeId,
      ownerId: options.ownerId,
    })) options.onPresence(observation);
  };
  const requireCandidateScope = (candidateId: string) => {
    const review = options.authority.reviewCandidate(candidateId);
    if (review.candidate.scopeId !== options.scopeId) {
      throw new Error('Skill candidate belongs to a different workspace scope');
    }
    return review;
  };
  const requireDraftScope = (draftId: string) => {
    const draft = options.authority.reviewDraft(draftId);
    if (draft.scopeId !== options.scopeId) {
      throw new Error('Skill draft belongs to a different workspace scope');
    }
    return draft;
  };
  const requireApprovalScope = (approvalId: string) => {
    const approval = options.authority.listApprovals(options.scopeId)
      .find((item) => item.id === approvalId);
    if (!approval) throw new Error('Skill approval is unavailable in this workspace scope');
    return approval;
  };
  const requirePointerScope = (skillId: string): void => {
    if (!options.authority.listPointers(options.scopeId).some((item) => item.skillId === skillId)) {
      throw new Error('Managed Skill is unavailable in this workspace scope');
    }
  };
  const snapshot = (): WorkbenchSkillIntelligenceSnapshot => {
    syncPresence();
    return {
      enabled: options.edition.can('skill.intelligence'),
      doctor: options.authority.doctor(),
      candidates: options.authority.listCandidates(options.scopeId),
      drafts: options.authority.listDrafts(options.scopeId),
      evaluations: options.authority.listEvaluations(options.scopeId),
      approvals: options.authority.listApprovals(options.scopeId),
      active: options.authority.listPointers(options.scopeId).flatMap((pointer) => {
        const versions = options.authority.listVersions(pointer.skillId, pointer.scopeId);
        const version = versions.find((item) => item.id === pointer.skillVersionId);
        return version ? [{
          pointer,
          version,
          versions,
          health: options.authority.getHealth(version.id, pointer.scopeId),
          outcomes: options.authority.listOutcomes(version.id, pointer.scopeId),
          rollbackTarget: options.authority.rollbackTarget(pointer.skillId, pointer.scopeId),
        }] : [];
      }),
    };
  };
  const complete = (): WorkbenchSkillIntelligenceSnapshot => snapshot();
  return {
    snapshot,
    reviewCandidate: requireCandidateScope,
    dismissCandidate(input) {
      requireEnabled();
      requireCandidateScope(input.candidateId);
      options.authority.dismissCandidate(input);
      return complete();
    },
    createDraft(input) {
      requireEnabled();
      requireCandidateScope(input.candidateId);
      options.authority.createDraft(input);
      return complete();
    },
    updateDraft(input) {
      requireEnabled();
      requireDraftScope(input.draftId);
      options.authority.updateDraft(input);
      return complete();
    },
    evaluate(draftId) {
      requireEnabled();
      requireDraftScope(draftId);
      options.authority.evaluate({ draftId });
      return complete();
    },
    requestApproval(input) {
      requireEnabled();
      requireDraftScope(input.draftId);
      options.authority.requestApproval({
        ...input,
        scopeId: options.scopeId,
        requestedBy: options.ownerId,
      });
      return complete();
    },
    decideApproval(input) {
      requireEnabled();
      requireApprovalScope(input.approvalId);
      options.authority.decideApproval({ ...input, decidedBy: options.ownerId });
      return complete();
    },
    activate(approvalId) {
      requireEnabled();
      requireApprovalScope(approvalId);
      options.authority.activate({ approvalId });
      return complete();
    },
    disable(skillId) {
      requirePointerScope(skillId);
      options.authority.disable({ skillId, scopeId: options.scopeId, requestedBy: options.ownerId });
      return complete();
    },
    rollback(input) {
      requirePointerScope(input.skillId);
      options.authority.rollback({ ...input, scopeId: options.scopeId, requestedBy: options.ownerId });
      return complete();
    },
  };
}
