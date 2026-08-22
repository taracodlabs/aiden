/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { PRESENCE_CATEGORY_PRIORITY } from './attentionPolicy';
import type { PresenceObservation } from './types';

const TEXT_LIMIT = 500;
const PAYLOAD_LIMIT = 2_000;
const SECRET_KEY = /(?:authorization|api[-_]?key|token|secret|password|cookie)/i;
const SECRET_VALUE = /\b(?:bearer\s+\S+|(?:token|secret|password|api[-_]?key)\s*[=:]\s*\S+)/gi;

function bounded(value: unknown, limit = TEXT_LIMIT): string {
  const text = String(value ?? '').replace(SECRET_VALUE, '[redacted]').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[bounded]';
  if (typeof value === 'string') return bounded(value, PAYLOAD_LIMIT);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitize(entry, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      result[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitize(entry, depth + 1);
    }
    return result;
  }
  return value;
}

function boundedPayload(value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 16_000) return value;
  return {
    truncated: true,
    integritySha256: createHash('sha256').update(serialized).digest('hex'),
  };
}

export function normalizePresenceObservation(input: PresenceObservation): PresenceObservation {
  const payload = boundedPayload(sanitize(input.payload ?? {}) as Record<string, unknown>);
  const normalized: PresenceObservation = {
    ...input,
    sourceIdentity: bounded(input.sourceIdentity, 240),
    sourceRevision: bounded(input.sourceRevision, 240),
    title: bounded(input.title, 160),
    summary: bounded(input.summary),
    reasonCode: bounded(input.reasonCode, 100),
    reason: bounded(input.reason),
    recommendedAction: input.recommendedAction ? bounded(input.recommendedAction, 160) : null,
    priority: PRESENCE_CATEGORY_PRIORITY[input.category],
    payload,
    untrustedExternal: input.untrustedExternal === true || input.initiator === 'EXTERNAL_EVENT',
  };
  if (normalized.untrustedExternal) {
    const serialized = JSON.stringify(normalized);
    normalized.payload = sanitize(JSON.parse(serialized).payload) as Record<string, unknown>;
  }
  return normalized;
}

export function digestPresenceObservation(input: PresenceObservation): string {
  const normalized = normalizePresenceObservation(input);
  return createHash('sha256').update(JSON.stringify({
    sourceKind: normalized.sourceKind, sourceIdentity: normalized.sourceIdentity,
    sourceRevision: normalized.sourceRevision, category: normalized.category,
    title: normalized.title, summary: normalized.summary, reasonCode: normalized.reasonCode,
    active: normalized.active, payload: normalized.payload,
  })).digest('hex');
}

export function projectApprovalObservation(input: {
  approvalId: string; jobId: string; attemptId: string; generation: number; state: string;
  toolName: string; target?: string | null; requestedAt: number; workspaceId?: string | null;
}): PresenceObservation {
  const active = input.state === 'created' || input.state === 'displayed';
  return normalizePresenceObservation({
    sourceKind: 'approval', sourceIdentity: input.approvalId,
    sourceRevision: `${input.state}:${input.generation}`, initiator: 'USER',
    workspaceId: input.workspaceId, jobId: input.jobId, category: 'approval_required', priority: 100,
    title: active ? 'Approval needed' : 'Approval resolved',
    summary: input.target ? `${input.toolName} · ${input.target}` : input.toolName,
    reasonCode: active ? 'approval_waiting' : 'approval_resolved',
    reason: active ? 'A protected action is waiting for your decision.' : 'The approval no longer requires action.',
    recommendedAction: active ? 'Review approval' : null, active, observedAt: input.requestedAt,
    payload: { approvalId: input.approvalId, attemptId: input.attemptId, generation: input.generation, toolName: input.toolName, target: input.target ?? null },
  });
}

export function projectEffectObservation(input: {
  effectId: string; jobId: string; state: string; updatedAt: number; target?: string | null; workspaceId?: string | null;
}): PresenceObservation {
  const active = ['unknown', 'partial', 'attempting', 'started', 'reconciliation_required'].includes(input.state);
  return normalizePresenceObservation({
    sourceKind: 'effect', sourceIdentity: input.effectId, sourceRevision: input.state, initiator: 'SYSTEM',
    workspaceId: input.workspaceId, jobId: input.jobId, category: 'unknown_effect', priority: 95,
    title: active ? 'Outcome unknown' : 'Effect reconciled',
    summary: input.target ? `Check the effect on ${input.target}.` : 'Check the recorded real-world effect.',
    reasonCode: active ? 'effect_unknown' : 'effect_reconciled',
    reason: active ? 'Aiden cannot safely infer whether the effect completed.' : 'The effect has a terminal reconciled outcome.',
    recommendedAction: active ? 'Review effect evidence' : null, active, observedAt: input.updatedAt,
    payload: { effectId: input.effectId, state: input.state, target: input.target ?? null },
  });
}

export function projectBrowserObservation(input: {
  browserSessionId: string; jobId: string; state: string; updatedAt: number; workspaceId?: string | null;
}): PresenceObservation {
  const active = input.state === 'user_control_required' || input.state === 'lost';
  return normalizePresenceObservation({
    sourceKind: 'browser', sourceIdentity: input.browserSessionId, sourceRevision: input.state, initiator: 'SYSTEM',
    workspaceId: input.workspaceId, jobId: input.jobId, category: 'browser_takeover', priority: 90,
    title: active ? 'Browser needs you' : 'Browser handoff resolved',
    summary: active ? 'A browser session requires user control.' : 'The browser session no longer needs attention.',
    reasonCode: active ? 'browser_user_control' : 'browser_settled',
    reason: active ? 'The browser authority reached a safe user-control boundary.' : 'The browser authority reports a settled state.',
    recommendedAction: active ? 'Open browser session' : null, active, observedAt: input.updatedAt,
    payload: { browserSessionId: input.browserSessionId, state: input.state },
  });
}

export function projectJobObservation(input: {
  jobId: string; status: string; updatedAt: number; goal?: string | null; workspaceId?: string | null;
}): PresenceObservation {
  const verificationFailure = ['verification_failed', 'completed_unverified', 'blocked_unknown', 'state_unknown'].includes(input.status);
  const active = verificationFailure || ['blocked', 'paused'].includes(input.status);
  return normalizePresenceObservation({
    sourceKind: 'job', sourceIdentity: input.jobId, sourceRevision: input.status, initiator: 'SYSTEM',
    workspaceId: input.workspaceId, jobId: input.jobId,
    category: input.status === 'completed_unverified' || input.status === 'state_unknown' ? 'ready_review'
      : ['blocked', 'paused'].includes(input.status) ? 'unresolved_gate' : 'verification_failure',
    priority: input.status === 'blocked_unknown' ? 88 : 60,
    title: active ? 'Work needs review' : 'Work settled', summary: input.goal || `Job ${input.jobId}`,
    reasonCode: active ? `job_${input.status}` : 'job_settled',
    reason: active ? 'Durable Job truth requires review before completion can be trusted.' : 'The Job reached a resolved durable state.',
    recommendedAction: active ? 'Review evidence and Proof' : null, active, observedAt: input.updatedAt,
    payload: { status: input.status },
  });
}

export function projectConnectedAccountObservation(input: {
  accountId: string; providerId: string; toolkitId: string; label: string; status: string; health: string;
  updatedAt: number; workspaceId?: string | null; ownerId?: string | null;
}): PresenceObservation {
  const active = input.status !== 'active' || input.health !== 'healthy';
  return normalizePresenceObservation({
    sourceKind: 'connected_account', sourceIdentity: input.accountId,
    sourceRevision: `${input.status}:${input.health}`, initiator: 'SYSTEM',
    workspaceId: input.workspaceId, ownerId: input.ownerId, category: 'connection_blocker', priority: 75,
    title: active ? `${input.label} needs reconnection` : `${input.label} is connected`,
    summary: `${input.providerId} · ${input.toolkitId}`,
    reasonCode: active ? 'connected_account_unhealthy' : 'connected_account_recovered',
    reason: active ? 'The durable connected-account health is not ready.' : 'The durable connected-account health is ready.',
    recommendedAction: active ? 'Reconnect account' : null, active, observedAt: input.updatedAt,
    payload: { accountId: input.accountId, status: input.status, health: input.health },
  });
}

export function projectAutomationFailureObservation(input: {
  automationId: string; name: string; consecutiveFailures: number; lastOccurrenceId: string;
  updatedAt: number; workspaceId?: string | null; ownerId?: string | null;
}): PresenceObservation {
  const active = input.consecutiveFailures >= 2;
  return normalizePresenceObservation({
    sourceKind: 'automation', sourceIdentity: input.automationId,
    sourceRevision: `${input.lastOccurrenceId}:${input.consecutiveFailures}`, initiator: 'AUTOMATION',
    workspaceId: input.workspaceId, ownerId: input.ownerId, automationId: input.automationId,
    category: 'automation_failure', priority: 70,
    title: active ? `${input.name} keeps failing` : `${input.name} recovered`,
    summary: active ? `${input.consecutiveFailures} consecutive failures need review.` : 'The automation recovered.',
    reasonCode: active ? 'automation_repeated_failure' : 'automation_recovered',
    reason: active ? 'Multiple durable occurrences ended in failure.' : 'A later durable occurrence succeeded.',
    recommendedAction: active ? 'Review automation history' : null, active, observedAt: input.updatedAt,
    payload: { automationId: input.automationId, occurrenceId: input.lastOccurrenceId, consecutiveFailures: input.consecutiveFailures },
  });
}
