/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { normalizePresenceObservation } from '../presence/observationProjector';
import type { PresenceObservation } from '../presence/types';
import type { SkillIntelligenceAuthority } from './authority';

export function projectSkillIntelligenceObservations(input: {
  authority: SkillIntelligenceAuthority;
  scopeId: string;
  ownerId: string;
  now?: number;
}): PresenceObservation[] {
  const observedAt = input.now ?? Date.now();
  const observations: PresenceObservation[] = [];
  for (const candidate of input.authority.listCandidates(input.scopeId)) {
    const active = candidate.state === 'candidate';
    observations.push(normalizePresenceObservation({
      sourceKind: 'skill_intelligence',
      sourceIdentity: `candidate:${candidate.id}`,
      sourceRevision: `${candidate.state}:${candidate.stateVersion}`,
      initiator: 'SYSTEM',
      workspaceId: candidate.scopeId,
      ownerId: candidate.ownerId,
      category: 'ready_review',
      priority: 60,
      title: active ? 'Reusable workflow ready for review' : 'Skill candidate reviewed',
      summary: `${candidate.proposedName} · ${candidate.positiveTraceIds.length} verified trace${candidate.positiveTraceIds.length === 1 ? '' : 's'}`,
      reasonCode: active ? 'skill_candidate_ready' : 'skill_candidate_resolved',
      reason: active
        ? 'A repeated independently verified workflow crossed the deterministic candidate threshold.'
        : 'The Skill candidate no longer requires review.',
      recommendedAction: active ? 'Review Skill candidate' : null,
      active,
      observedAt,
      payload: {
        candidateId: candidate.id,
        patternId: candidate.patternId,
        positiveTraceCount: candidate.positiveTraceIds.length,
        negativeTraceCount: candidate.negativeTraceIds.length,
      },
    }));
  }
  for (const pointer of input.authority.listPointers(input.scopeId)) {
    const version = input.authority.listVersions(pointer.skillId)
      .find((item) => item.id === pointer.skillVersionId);
    if (!version) continue;
    const drifted = pointer.driftState !== 'clean';
    observations.push(normalizePresenceObservation({
      sourceKind: 'skill_intelligence',
      sourceIdentity: `drift:${pointer.skillId}:${pointer.scopeId}`,
      sourceRevision: `${pointer.skillVersionId}:${pointer.digest}:${pointer.driftState}:${pointer.stateVersion}`,
      initiator: 'SYSTEM',
      workspaceId: pointer.scopeId,
      ownerId: input.ownerId,
      category: 'target_drift',
      priority: 84,
      title: drifted ? 'Skill changed outside review' : 'Skill integrity restored',
      summary: `Skill v${version.version} · ${pointer.digest}`,
      reasonCode: drifted ? 'skill_version_drift' : 'skill_version_clean',
      reason: drifted
        ? 'The active pointer no longer matches immutable reviewed Skill content.'
        : 'The active Skill pointer matches the immutable reviewed version.',
      recommendedAction: drifted ? 'Review Skill changes' : null,
      active: drifted,
      observedAt,
      payload: { skillId: pointer.skillId, skillVersionId: pointer.skillVersionId, driftState: pointer.driftState },
    }));
    const health = input.authority.getHealth(version.id, pointer.scopeId);
    const degraded = health.state === 'degraded';
    observations.push(normalizePresenceObservation({
      sourceKind: 'skill_intelligence',
      sourceIdentity: `health:${version.id}`,
      sourceRevision: `${health.state}:${health.attributableSamples}:${health.failures}`,
      initiator: 'SYSTEM',
      workspaceId: pointer.scopeId,
      ownerId: input.ownerId,
      category: 'unresolved_gate',
      priority: 80,
      title: degraded ? 'Skill needs review' : 'Skill health is acceptable',
      summary: `${health.failures} of ${health.attributableSamples} attributable outcomes failed`,
      reasonCode: degraded ? 'skill_version_degraded' : 'skill_version_healthy',
      reason: degraded
        ? 'The immutable SkillVersion crossed the deterministic degradation threshold.'
        : 'The SkillVersion has not crossed the degradation threshold.',
      recommendedAction: degraded
        ? (input.authority.rollbackTarget(pointer.skillId, pointer.scopeId) ? 'Review outcomes and rollback target' : 'Review outcomes')
        : null,
      active: degraded,
      observedAt,
      payload: { skillId: pointer.skillId, skillVersionId: version.id, health },
    }));
    let prerequisiteIssue: string | null = null;
    try { input.authority.resolveCapabilityVersions(version.id, pointer.scopeId); }
    catch (error) { prerequisiteIssue = error instanceof Error ? error.message : 'Capability prerequisite unavailable'; }
    observations.push(normalizePresenceObservation({
      sourceKind: 'skill_intelligence',
      sourceIdentity: `prerequisite:${version.id}:${pointer.scopeId}`,
      sourceRevision: prerequisiteIssue ? `blocked:${version.digest}` : `ready:${version.digest}`,
      initiator: 'SYSTEM',
      workspaceId: pointer.scopeId,
      ownerId: input.ownerId,
      category: 'connection_blocker',
      priority: 75,
      title: prerequisiteIssue ? 'Skill capability prerequisite is unavailable' : 'Skill prerequisites are ready',
      summary: prerequisiteIssue ?? `Skill v${version.version} prerequisites are available.`,
      reasonCode: prerequisiteIssue ? 'skill_capability_broken' : 'skill_capability_ready',
      reason: prerequisiteIssue
        ? 'The Skill remains unable to grant or bypass missing Capability authority.'
        : 'Required Capability versions, health, and permissions are currently valid.',
      recommendedAction: prerequisiteIssue ? 'Review Capability prerequisites' : null,
      active: prerequisiteIssue !== null,
      observedAt,
      payload: { skillId: pointer.skillId, skillVersionId: version.id },
    }));
  }
  return observations;
}
