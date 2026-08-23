/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type PresenceInitiator = 'USER' | 'AUTOMATION' | 'SYSTEM' | 'EXTERNAL_EVENT' | 'PROPOSED';
export type PresenceSourceKind =
  | 'approval' | 'effect' | 'job' | 'browser' | 'connected_account'
  | 'automation' | 'continuity' | 'delivery' | 'budget' | 'external_event'
  | 'skill_intelligence';
export type PresenceState = 'active' | 'snoozed' | 'dismissed' | 'resolved' | 'expired' | 'suppressed';
export type PresenceCategory =
  | 'approval_required' | 'unknown_effect' | 'browser_takeover' | 'verification_failure'
  | 'cleanup_uncertainty' | 'connection_blocker' | 'target_drift' | 'clarification'
  | 'automation_failure' | 'unresolved_gate' | 'ready_review' | 'delivery_failure'
  | 'budget_attention' | 'next_action' | 'information';

export interface PresenceObservation {
  sourceKind: PresenceSourceKind;
  sourceIdentity: string;
  sourceRevision: string;
  initiator: PresenceInitiator;
  workspaceId?: string | null;
  ownerId?: string | null;
  jobId?: string | null;
  automationId?: string | null;
  category: PresenceCategory;
  priority: number;
  title: string;
  summary: string;
  reasonCode: string;
  reason: string;
  recommendedAction?: string | null;
  active: boolean;
  observedAt: number;
  expiresAt?: number | null;
  payload?: Record<string, unknown>;
  untrustedExternal?: boolean;
}

export interface PresenceItem {
  id: string;
  sourceKind: PresenceSourceKind;
  sourceIdentity: string;
  sourceRevision: string;
  sourceDigest: string;
  initiator: PresenceInitiator;
  workspaceId: string | null;
  ownerId: string | null;
  jobId: string | null;
  automationId: string | null;
  category: PresenceCategory;
  priority: number;
  state: PresenceState;
  title: string;
  summary: string;
  reasonCode: string;
  reason: string;
  recommendedAction: string | null;
  payload: Record<string, unknown>;
  untrustedExternal: boolean;
  occurrenceCount: number;
  version: number;
  firstObservedAt: number;
  lastObservedAt: number;
  snoozedUntil: number | null;
  expiresAt: number | null;
  dismissedAt: number | null;
  resolvedAt: number | null;
  terminalAt: number | null;
}

export interface AttentionPreferences {
  workspaceId: string | null;
  ownerId: string | null;
  timezone: string;
  quietStart: string | null;
  quietEnd: string | null;
  maxInterruptions: number;
  interruptionWindowMs: number;
  cooldownMs: number;
  notificationConsent: boolean;
  allowedDeliveryClasses: string[];
  defaultSnoozeMs: number;
  version: number;
}

export interface PresenceSnapshot {
  enabled: boolean;
  quietHours: boolean;
  interruptions: PresenceItem[];
  needsYou: PresenceItem[];
  reviewWhenReady: PresenceItem[];
  recentlyResolved: PresenceItem[];
}

export interface PresenceBriefing {
  briefingId: string;
  duplicate: boolean;
  items: PresenceItem[];
  groups: {
    changed: PresenceItem[];
    resolved: PresenceItem[];
    blocked: PresenceItem[];
    ready: PresenceItem[];
    next: PresenceItem[];
  };
}

export type ProposedJobState = 'proposed' | 'accepting' | 'accepted' | 'dismissed' | 'expired' | 'invalidated';

export interface ProposedJob {
  id: string;
  itemId: string;
  sourceDigest: string;
  workspaceId: string | null;
  ownerId: string | null;
  prompt: string;
  goal: string;
  state: ProposedJobState;
  version: number;
  invalidationReason: string | null;
  jobId: string | null;
  attemptId: string | null;
  runId: number | null;
  triggerEventId: number | null;
  createdAt: number;
  updatedAt: number;
  acceptedAt: number | null;
  expiresAt: number | null;
}

export interface PresenceEnqueueResult {
  accepted: boolean;
  triggerEventId?: number;
  duplicate?: boolean;
  jobId?: string;
  attemptId?: string;
  runId?: number;
}
