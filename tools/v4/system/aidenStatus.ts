/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { LearningAuthority } from '../../../core/v4/learning/learningAuthority';
import type { LearningScope } from '../../../core/v4/learning/types';
import type { WorkbenchPresencePort } from '../../../core/v4/workbench/presencePort';
import type { WorkbenchSkillIntelligencePort } from '../../../core/v4/workbench/skillIntelligencePort';
import type { SystemReadinessProjection } from '../../../core/v4/workbench/systemReadiness';

export type AidenRuntimeStatusTopic = 'readiness' | 'learning' | 'presence' | 'skills';

function bounded(value: string | null | undefined, limit = 512): string | null {
  if (!value) return null;
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Model-facing projection over existing durable authorities. It deliberately
 * returns only bounded product facts; raw payloads, paths, digests, and private
 * source metadata remain on their authoritative detail surfaces.
 */
export function createAidenRuntimeStatus(input: {
  readiness(): Promise<SystemReadinessProjection>;
  learning: Pick<LearningAuthority, 'list' | 'retrieve'>;
  learningScopes: LearningScope[];
  presence: Pick<WorkbenchPresencePort, 'snapshot' | 'proposals'>;
  skills: Pick<WorkbenchSkillIntelligencePort, 'snapshot'>;
}): (topic: AidenRuntimeStatusTopic, query?: string) => Promise<unknown> {
  return async (topic, query) => {
    if (topic === 'readiness') {
      const snapshot = await input.readiness();
      return {
        topic,
        overall: snapshot.overall,
        checkedAt: snapshot.checkedAt,
        items: snapshot.items.slice(0, 32).map((item) => ({
          id: item.id,
          category: item.category,
          state: item.state,
          title: item.title,
          configured: item.configured,
          supported: item.supported,
          authenticated: item.authenticated,
          runtimeAvailable: item.runtimeAvailable,
          permissionAvailable: item.permissionAvailable,
          validationAvailable: item.validationAvailable,
          ready: item.ready,
          blocking: item.blocking,
          reason: bounded(item.reason),
          recommendedAction: bounded(item.recommendedAction),
        })),
      };
    }
    if (topic === 'learning') {
      const entries = query
        ? input.learning.retrieve({ query, scopes: input.learningScopes, limit: 20, maxChars: 4_000 }).items
        : input.learning.list({ scopes: input.learningScopes }).filter((entry) => entry.lifecycle !== 'DELETED').slice(0, 20);
      return {
        topic,
        entries: entries.map((entry) => ({
          id: entry.id,
          scope: entry.scope.kind,
          type: entry.type,
          confidence: entry.confidence,
          lifecycle: entry.lifecycle,
          eligible: entry.eligible,
          content: bounded(entry.content, 1_000),
          updatedAt: entry.updatedAt,
        })),
      };
    }
    if (topic === 'presence') {
      const snapshot = input.presence.snapshot();
      const project = (items: ReturnType<WorkbenchPresencePort['snapshot']>['needsYou']) => items.slice(0, 25).map((item) => ({
        id: item.id,
        state: item.state,
        category: item.category,
        title: bounded(item.title, 200),
        summary: bounded(item.summary, 500),
        reason: bounded(item.reason, 500),
        recommendedAction: bounded(item.recommendedAction, 200),
        lastObservedAt: item.lastObservedAt,
      }));
      return {
        topic,
        enabled: snapshot.enabled,
        quietHours: snapshot.quietHours,
        needsYou: project(snapshot.needsYou),
        interruptions: project(snapshot.interruptions),
        reviewWhenReady: project(snapshot.reviewWhenReady),
        recentlyResolved: project(snapshot.recentlyResolved),
        proposals: input.presence.proposals().slice(0, 25).map((proposal) => ({
          id: proposal.id,
          state: proposal.state,
          goal: bounded(proposal.goal, 300),
          invalidationReason: bounded(proposal.invalidationReason, 300),
          updatedAt: proposal.updatedAt,
        })),
      };
    }
    const snapshot = input.skills.snapshot();
    return {
      topic: 'skills',
      enabled: snapshot.enabled,
      doctor: snapshot.doctor,
      candidates: snapshot.candidates.slice(0, 25).map((candidate) => ({
        id: candidate.id,
        name: bounded(candidate.proposedName, 160),
        purpose: bounded(candidate.purpose, 500),
        state: candidate.state,
        updatedAt: candidate.updatedAt,
      })),
      active: snapshot.active.slice(0, 50).map((active) => ({
        skillId: active.pointer.skillId,
        version: active.version.version,
        enabled: active.pointer.enabled,
        drift: active.pointer.driftState,
        health: active.health?.state ?? 'insufficient_data',
        rollbackAvailable: active.rollbackTarget !== null,
      })),
    };
  };
}

export const aidenStatusTool: ToolHandler = {
  schema: {
    name: 'aiden_status',
    description:
      'Query Aiden\'s canonical durable runtime projections. Use for questions about current readiness, learned preferences, Presence attention, or managed Skill Intelligence. Never infer these states from files or general knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['readiness', 'learning', 'presence', 'skills'],
          description: 'Which canonical runtime projection to read.',
        },
        query: {
          type: 'string',
          description: 'Optional bounded search or question used by the authority projection.',
        },
      },
      required: ['topic'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'status',
  riskTier: 'safe',
  async execute(args, ctx) {
    if (!ctx.runtimeStatus) {
      return { available: false, reason: 'Canonical runtime status is unavailable in this execution context.' };
    }
    const topic = String(args.topic ?? '') as AidenRuntimeStatusTopic;
    if (!['readiness', 'learning', 'presence', 'skills'].includes(topic)) {
      return { available: false, reason: 'Unknown runtime status topic.' };
    }
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 512) : undefined;
    return ctx.runtimeStatus(topic, query || undefined);
  },
};
