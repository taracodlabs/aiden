/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type LiveActivityStatus = 'running' | 'ok' | 'failed' | 'warn';

export interface LiveActivityItem {
  /** Stable semantic identity, normally a ToolCall or Evidence identity. */
  id: string;
  eventId: number;
  kind: 'tool' | 'verify' | 'note' | 'worker' | 'skill';
  label: string;
  detail?: string;
  status: LiveActivityStatus;
  durationMs?: number | null;
}

/** Replace one semantic activity as it settles. Distinct calls are retained even
 * when their visible text is identical. */
export function mergeLiveActivity(
  current: readonly LiveActivityItem[],
  next: LiveActivityItem,
  limit = 200,
): LiveActivityItem[] {
  const index = current.findIndex((item) => item.id === next.id);
  const merged = index >= 0
    ? current.map((item, itemIndex) => itemIndex === index
      ? { ...item, ...next, detail: next.detail ?? item.detail }
      : item)
    : [...current, next];
  return merged.slice(-Math.max(1, limit));
}

export function summarizeCompletedActivity(items: readonly LiveActivityItem[]): {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
} {
  return items.reduce((summary, item) => {
    summary.total += 1;
    if (item.status === 'running') summary.running += 1;
    else if (item.status === 'failed' || item.status === 'warn') summary.failed += 1;
    else summary.succeeded += 1;
    return summary;
  }, { total: 0, succeeded: 0, failed: 0, running: 0 });
}

/** Keep Chat focused on observable work in progress. The durable Activity view
 * remains the complete execution history. */
export function selectChatLiveActivity(
  items: readonly LiveActivityItem[],
  limit = 3,
): LiveActivityItem[] {
  const boundedLimit = Math.max(1, limit);
  let currentIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'running') {
      currentIndex = index;
      break;
    }
  }
  const end = currentIndex >= 0 ? currentIndex + 1 : items.length;
  return items.slice(Math.max(0, end - boundedLimit), end);
}

export function shouldShowChatTelemetry(input: {
  running: boolean;
  pendingApprovalCount: number;
  terminal?: boolean;
}): boolean {
  return input.pendingApprovalCount > 0 || (input.running && !input.terminal);
}

export interface WorkbenchApprovalRow {
  approval_id?: unknown;
  job_id?: unknown;
  attempt_id?: unknown;
  generation?: unknown;
  tool_call_id?: unknown;
  effect_id?: unknown;
  tool_name?: unknown;
  risk_tier?: unknown;
  normalized_execution_plan?: unknown;
  state?: unknown;
  requested_at?: unknown;
}

export interface WorkbenchApprovalCard {
  approvalId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  toolCallId: string;
  effectId: string | null;
  toolName: string;
  target: string | null;
  riskTier: string;
  state: string;
  requestedAt: number;
}

const PENDING_APPROVAL_STATES = new Set(['created', 'displayed']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function approvalTarget(value: unknown): string | null {
  let plan: unknown = value;
  if (typeof plan === 'string') {
    try { plan = JSON.parse(plan); } catch { return null; }
  }
  if (!plan || typeof plan !== 'object') return null;
  const resources = (plan as { affectedResources?: unknown }).affectedResources;
  if (!Array.isArray(resources)) return null;
  return resources.map(text).find((resource): resource is string => resource !== null) ?? null;
}

/** Translate the durable SQL projection into the narrow approval-card contract.
 * Rows lacking an exact Job/Attempt/generation/action binding are not actionable. */
export function durableApprovalCards(rows: readonly WorkbenchApprovalRow[]): WorkbenchApprovalCard[] {
  return rows.flatMap((row) => {
    const approvalId = text(row.approval_id);
    const jobId = text(row.job_id);
    const attemptId = text(row.attempt_id);
    const toolCallId = text(row.tool_call_id);
    const toolName = text(row.tool_name);
    const riskTier = text(row.risk_tier);
    const state = text(row.state);
    const generation = Number(row.generation);
    if (!approvalId || !jobId || !attemptId || !toolCallId || !toolName || !riskTier
      || !state || !Number.isSafeInteger(generation)) return [];
    return [{
      approvalId,
      jobId,
      attemptId,
      generation,
      toolCallId,
      effectId: text(row.effect_id),
      toolName,
      target: approvalTarget(row.normalized_execution_plan),
      riskTier,
      state,
      requestedAt: Number.isFinite(Number(row.requested_at)) ? Number(row.requested_at) : 0,
    }];
  }).sort((a, b) => a.requestedAt - b.requestedAt || a.approvalId.localeCompare(b.approvalId));
}

export function pendingApprovalCards(rows: readonly WorkbenchApprovalRow[]): WorkbenchApprovalCard[] {
  return durableApprovalCards(rows).filter((approval) => PENDING_APPROVAL_STATES.has(approval.state));
}
