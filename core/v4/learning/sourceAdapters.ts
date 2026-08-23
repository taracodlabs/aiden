/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { LearningAuthority } from './learningAuthority';
import type { LearningScope } from './types';

interface VerifiedSourceInput {
  authority: LearningAuthority;
  scope: LearningScope;
  content: string;
  jobId: string;
  attemptId: string;
  generation: number;
  evidenceId: string;
  effectId?: string | null;
}

export function capturePresenceFeedbackLearning(input: {
  authority: LearningAuthority;
  scope: LearningScope;
  eventId: string;
  presenceId: string;
  feedback: 'helpful' | 'not_helpful' | 'too_frequent' | 'wrong_priority';
  content: string;
}) {
  return input.authority.capture({
    scope: input.scope,
    type: 'PRESENCE_FEEDBACK',
    subjectKey: `presence.${input.presenceId}.${input.feedback}`,
    content: input.content,
    source: {
      kind: 'PRESENCE_FEEDBACK',
      identity: input.eventId,
      revision: '1',
      independentKey: input.eventId,
      presenceId: input.presenceId,
      metadata: { category: input.feedback },
    },
  });
}

export function captureSkillOutcomeLearning(input: VerifiedSourceInput & {
  skillName: string;
  skillId: string;
  skillVersionId: string;
  skillVersionDigest: string;
  outcomeIdentity: string;
}) {
  return input.authority.capture({
    scope: { ...input.scope, kind: 'SKILL', key: input.skillName },
    type: 'SKILL_RELIABILITY',
    subjectKey: `skill.${input.skillName}.reliability`,
    content: input.content,
    source: {
      kind: 'SKILL_OUTCOME',
      identity: input.outcomeIdentity,
      revision: `${input.skillVersionId}:${input.skillVersionDigest}:${input.jobId}:${input.attemptId}:${input.generation}`,
      independentKey: input.jobId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      generation: input.generation,
      evidenceId: input.evidenceId,
      effectId: input.effectId,
      skillName: input.skillName,
      metadata: {
        skillId: input.skillId,
        skillVersionId: input.skillVersionId,
        skillVersionDigest: input.skillVersionDigest,
      },
    },
  });
}

export function captureRecoveryLearning(input: VerifiedSourceInput & { recoveryId: string }) {
  return input.authority.capture({
    scope: input.scope,
    type: 'RECOVERY_LESSON',
    subjectKey: `recovery.${input.recoveryId}`,
    content: input.content,
    source: {
      kind: 'RECOVERY',
      identity: input.recoveryId,
      revision: `${input.jobId}:${input.attemptId}:${input.generation}`,
      independentKey: input.jobId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      generation: input.generation,
      evidenceId: input.evidenceId,
      effectId: input.effectId,
      recoveryId: input.recoveryId,
    },
  });
}
