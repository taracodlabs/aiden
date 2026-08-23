/**
 * Product-facing projections for the Workbench. Durable runtime records remain
 * authoritative; this module only translates them into operator language.
 */

import type { ActiveJobView } from './workbenchController';
import type { LiveActivityItem, WorkbenchApprovalCard } from './workbenchUx';

export type PresentationTone = 'neutral' | 'running' | 'success' | 'attention' | 'review' | 'danger';

export interface RuntimeStatusPresentation {
  label: string;
  detail: string;
  nextAction: string | null;
  tone: PresentationTone;
}

export interface ResultPresentation {
  title: string;
  summary: string;
  proofLabel: string;
  tone: PresentationTone;
  primaryAction: string | null;
}

export interface AutomationOccurrencePresentation {
  label: string;
  tone: PresentationTone;
}

const STATUS_PRESENTATIONS: Record<string, RuntimeStatusPresentation> = {
  queued: { label: 'Queued', detail: 'Waiting to start.', nextAction: null, tone: 'neutral' },
  running: { label: 'In progress', detail: 'Aiden is working on this now.', nextAction: null, tone: 'running' },
  waiting: { label: 'Waiting', detail: 'Work is paused at a safe boundary.', nextAction: 'Check what Aiden is waiting for', tone: 'attention' },
  approval_required: { label: 'Needs approval', detail: 'A protected action is waiting for your decision.', nextAction: 'Review the requested action', tone: 'attention' },
  paused: { label: 'Paused', detail: 'Durable work is safely paused.', nextAction: 'Continue when ready', tone: 'attention' },
  cancelling: { label: 'Stopping', detail: 'Aiden is safely stopping the active work.', nextAction: null, tone: 'running' },
  recovering: { label: 'Recovering', detail: 'Aiden is restoring durable work.', nextAction: null, tone: 'running' },
  blocked: { label: 'Needs attention', detail: 'A blocker prevents this work from continuing.', nextAction: 'Review the blocker', tone: 'danger' },
  blocked_unknown: { label: 'Needs attention', detail: 'The outcome is uncertain and requires review.', nextAction: 'Review the recorded evidence', tone: 'danger' },
  stale_fence: { label: 'No longer current', detail: 'The workspace or work changed before this action ran.', nextAction: 'Review current state', tone: 'attention' },
  verification_incomplete: { label: 'Verification incomplete', detail: 'Aiden could not fully verify the result.', nextAction: 'Inspect evidence', tone: 'review' },
  reconciliation_required: { label: 'Status check needed', detail: 'Aiden needs to check what happened before trying again.', nextAction: 'Check status', tone: 'attention' },
  unknown: { label: 'Outcome unknown', detail: 'Aiden cannot confirm the final outcome. Do not retry blindly.', nextAction: 'Review current state', tone: 'danger' },
  provider_unavailable: { label: 'Provider unavailable', detail: 'The selected provider is unavailable.', nextAction: 'Manage provider', tone: 'danger' },
  unsupported_model: { label: 'Model unavailable for this work', detail: 'This model cannot perform the requested work.', nextAction: 'Choose another model', tone: 'attention' },
  target_drift: { label: 'Target changed', detail: 'The target changed before Aiden acted.', nextAction: 'Review target', tone: 'attention' },
  approval_expired: { label: 'Approval expired', detail: 'The previous approval can no longer be used.', nextAction: 'Request a new approval', tone: 'attention' },
  process_cleanup_failed: { label: 'Cleanup needs attention', detail: 'A background process may still be running.', nextAction: 'Open diagnostics', tone: 'danger' },
  artifact_missing: { label: 'Result file unavailable', detail: 'This result file is no longer available.', nextAction: 'Regenerate where safe', tone: 'attention' },
  state_unknown: { label: 'Ready for review', detail: 'Aiden cannot safely infer the final outcome.', nextAction: 'Review the available result and evidence', tone: 'review' },
  completed_unverified: { label: 'Ready for review', detail: 'The work finished, but verification is incomplete.', nextAction: 'Review the result', tone: 'review' },
  terminal: { label: 'Finished', detail: 'The work reached a final durable state. Open it to review the exact outcome.', nextAction: 'Review the result', tone: 'review' },
  completed: { label: 'Completed', detail: 'The work completed successfully.', nextAction: null, tone: 'success' },
  verified: { label: 'Verified', detail: 'The result is supported by recorded evidence.', nextAction: null, tone: 'success' },
  failed: { label: 'Failed', detail: 'The work did not complete.', nextAction: 'Review the failure', tone: 'danger' },
  denied: { label: 'Denied', detail: 'The requested action was not allowed.', nextAction: null, tone: 'danger' },
  cancelled: { label: 'Cancelled', detail: 'The work was stopped safely.', nextAction: null, tone: 'neutral' },
};

export function presentRuntimeStatus(status: string | null | undefined): RuntimeStatusPresentation {
  const key = (status || '').trim().toLowerCase();
  return STATUS_PRESENTATIONS[key] ?? {
    label: 'Status unavailable',
    detail: 'Aiden has not received enough durable information to describe this state.',
    nextAction: 'Open details',
    tone: 'review',
  };
}

export function presentRuntimeDetail(detail: string | null | undefined, status?: string | null): string {
  const value = detail?.trim() || '';
  if (/ProviderError|Network failure calling|fetch failed/i.test(value)) {
    return 'The selected provider could not be reached.';
  }
  const translated = STATUS_PRESENTATIONS[value.toLowerCase()];
  return translated?.detail ?? (value || presentRuntimeStatus(status).detail);
}

export function presentAssistantContent(content: string): string {
  if (/ProviderError|Network failure calling|fetch failed/i.test(content)) {
    return 'Aiden could not reach the selected provider. Check the connection or provider in Settings, then try again.';
  }
  return content;
}

export function presentResult(input: {
  status: string;
  summary?: string | null;
  verdict?: string | null;
  evidenceCount?: number;
  kind?: 'coding' | 'browser' | 'apps' | 'artifact' | 'failure' | 'recovery';
}): ResultPresentation {
  const state = presentRuntimeStatus(input.verdict || input.status);
  const evidenceCount = Math.max(0, input.evidenceCount ?? 0);
  const rawSummary = input.summary?.trim() || '';
  const summary = /ProviderError|Network failure calling|fetch failed/i.test(rawSummary)
    ? 'The selected provider could not be reached. No result was produced.'
    : rawSummary
      ? presentRuntimeDetail(rawSummary, input.status)
      : state.detail;
  const domain = input.kind ? {
    coding: ['Repository change ready', 'Review changes'],
    browser: ['Research complete', 'Read brief'],
    apps: ['Connected app updated', 'Open app'],
    artifact: ['Result ready', 'Preview'],
    failure: ['Could not complete this work', 'View reason'],
    recovery: ['Recovered safely', 'View recovery'],
  }[input.kind] : null;
  return {
    title: domain?.[0] ?? state.label,
    summary,
    proofLabel: evidenceCount > 0
      ? `${evidenceCount} ${evidenceCount === 1 ? 'piece' : 'pieces'} of evidence`
      : 'Evidence details unavailable',
    tone: state.tone,
    primaryAction: domain?.[1] ?? null,
  };
}

export function presentAutomationOccurrence(input: {
  state: string;
  delivery?: { state: 'completed' | 'failed' | 'unknown' } | null;
}): AutomationOccurrencePresentation {
  if (input.delivery) {
    if (input.delivery.state === 'completed') return { label: 'Result delivered', tone: 'success' };
    if (input.delivery.state === 'failed') return { label: 'Delivery failed', tone: 'danger' };
    return { label: 'Delivery outcome unknown', tone: 'danger' };
  }
  switch (input.state) {
    case 'completed': return { label: 'Task completed', tone: 'success' };
    case 'failed': return { label: 'Task failed', tone: 'danger' };
    case 'blocked': return { label: 'Task needs attention', tone: 'attention' };
    case 'unknown': return { label: 'Task outcome unknown', tone: 'danger' };
    case 'skipped_overlap': return { label: 'Task skipped', tone: 'neutral' };
    default: return { label: 'Task in progress', tone: 'running' };
  }
}

export interface ActiveWorkGroups {
  needsYou: ActiveJobView[];
  running: ActiveJobView[];
  readyForReview: ActiveJobView[];
  recentlyCompleted: ActiveJobView[];
}

export function groupActiveWork(jobs: readonly ActiveJobView[]): ActiveWorkGroups {
  const groups: ActiveWorkGroups = { needsYou: [], running: [], readyForReview: [], recentlyCompleted: [] };
  for (const job of jobs) {
    if (job.status === 'approval_required' || job.status === 'blocked' || job.status === 'paused') groups.needsYou.push(job);
    else if (['queued', 'running', 'waiting', 'cancelling', 'recovering'].includes(job.status)) groups.running.push(job);
    else if (job.status === 'terminal') groups.recentlyCompleted.push(job);
    else groups.readyForReview.push(job);
  }
  return groups;
}

export function projectTerminalActiveJob(projection: {
  identity: {
    sessionId?: string | null;
    jobId: string;
    attemptId: string;
    runId: number;
  };
  job?: { goal?: string };
  receipt: { status: string; summary?: string | null };
}): ActiveJobView {
  return {
    sessionId: projection.identity.sessionId ?? null,
    jobId: projection.identity.jobId,
    attemptId: projection.identity.attemptId,
    runId: projection.identity.runId,
    status: 'terminal',
    updatedAt: 0,
    title: projection.job?.goal?.trim() || projection.receipt.summary?.trim() || 'Completed work',
    statusDetail: presentRuntimeStatus(projection.receipt.status).detail,
  };
}

export interface AttentionItem {
  id: string;
  jobId: string;
  label: string;
  detail: string;
  tone: 'attention' | 'danger';
}

export function projectAttentionItems(input: {
  jobs: readonly ActiveJobView[];
  approvals: readonly WorkbenchApprovalCard[];
}): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  for (const approval of input.approvals) {
    const id = `approval:${approval.approvalId}`;
    if (!items.has(id)) items.set(id, {
      id,
      jobId: approval.jobId,
      label: 'Approval needed',
      detail: approval.target ? `${approval.toolName} · ${approval.target}` : approval.toolName,
      tone: 'attention',
    });
  }
  const jobsWithApproval = new Set(input.approvals.map((approval) => approval.jobId));
  for (const job of input.jobs) {
    if (job.status === 'approval_required' && jobsWithApproval.has(job.jobId)) continue;
    if (!['approval_required', 'blocked', 'paused', 'state_unknown'].includes(job.status)) continue;
    const state = presentRuntimeStatus(job.status);
    items.set(`job:${job.jobId}:${job.status}`, {
      id: `job:${job.jobId}:${job.status}`,
      jobId: job.jobId,
      label: state.label,
      detail: job.statusDetail || job.title || state.detail,
      tone: state.tone === 'danger' ? 'danger' : 'attention',
    });
  }
  return Array.from(items.values());
}

export interface ApprovalPresentation {
  what: string;
  where: string;
  why: string;
  impact: string;
  risk: string;
  afterApproval: string;
  actionable: boolean;
}

function actionName(toolName: string): string {
  const key = toolName.toLowerCase();
  if (key.includes('file_write') || key.includes('write_file')) return 'Write a file';
  if (key.includes('delete')) return 'Delete content';
  if (key.includes('shell') || key.includes('terminal') || key.includes('command')) return 'Run a command';
  if (key.includes('browser')) return 'Use the browser';
  if (key.includes('external_coding')) return 'Start an isolated coding session';
  return 'Perform a protected action';
}

export function presentApproval(approval: WorkbenchApprovalCard): ApprovalPresentation {
  const actionable = approval.state === 'created' || approval.state === 'displayed';
  const risk = approval.riskTier.trim().toLowerCase();
  return {
    what: actionName(approval.toolName),
    where: approval.target || approval.externalCoding?.repository || 'The selected work',
    why: 'This action can change your computer or connected service, so Aiden needs your decision.',
    impact: approval.effectId ? 'The exact effect will be recorded and verified.' : 'The exact requested action will be recorded.',
    risk: `${risk ? risk[0]!.toUpperCase() + risk.slice(1) : 'Unknown'} risk`,
    afterApproval: 'Aiden will perform this exact action, then verify the result.',
    actionable,
  };
}

export type SemanticProgressStatus = 'pending' | 'running' | 'complete' | 'attention' | 'failed';

export interface SemanticProgressPhase {
  id: string;
  label: string;
  detail?: string;
  status: SemanticProgressStatus;
  sourceIds: string[];
}

function phaseFor(item: LiveActivityItem): { id: string; label: string } {
  const text = `${item.label} ${item.detail ?? ''}`.toLowerCase();
  if (item.kind === 'verify' || /verif|evidence|proof/.test(text)) return { id: 'verify', label: 'Verifying result' };
  if (item.kind === 'worker') return { id: 'delegate', label: 'Coordinating work' };
  if (item.kind === 'skill' || /understand|plan/.test(text)) return { id: 'understand', label: 'Understanding request' };
  if (/write|edit|create|apply|delete/.test(text)) return { id: 'change', label: 'Making changes' };
  if (/test|build|check|validate/.test(text)) return { id: 'validate', label: 'Checking the result' };
  if (/browser|navigate|click|web/.test(text)) return { id: 'browser', label: 'Working in the browser' };
  if (/read|search|inspect|repository|file/.test(text) || item.kind === 'tool') return { id: 'inspect', label: 'Inspecting work' };
  return { id: 'prepare', label: 'Preparing response' };
}

function progressStatus(status: LiveActivityItem['status']): SemanticProgressStatus {
  if (status === 'ok') return 'complete';
  if (status === 'failed') return 'failed';
  if (status === 'warn') return 'attention';
  return 'running';
}

export function projectSemanticProgress(items: readonly LiveActivityItem[]): SemanticProgressPhase[] {
  const phases = new Map<string, SemanticProgressPhase>();
  for (const item of items) {
    const phase = phaseFor(item);
    const existing = phases.get(phase.id);
    const sourceIds = Array.from(new Set([...(existing?.sourceIds ?? []), item.id]));
    phases.set(phase.id, {
      id: phase.id,
      label: phase.label,
      detail: item.detail || item.label,
      status: progressStatus(item.status),
      sourceIds,
    });
  }
  return Array.from(phases.values()).slice(-7);
}
