/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Pure, serializable presentation mapping for a finalized task outcome.
 *
 * This module does not collect evidence, decide approval, execute tools, write
 * to a terminal, or persist state. It translates already-structured runtime
 * facts into one stable user-facing outcome.
 */

import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';
import { deriveCommandAxes } from './executionContract';
import type { VerificationOutcome } from './taskVerification';

export type TaskOutcomeKind =
  | 'verified'
  | 'completed'
  | 'completed_limited'
  | 'partial'
  | 'unverified_required'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'timed_out';

export type TaskOutcomeSeverity = 'success' | 'info' | 'warning' | 'error';

export interface TaskOutcomePresentation {
  kind: TaskOutcomeKind;
  severity: TaskOutcomeSeverity;
  label: string;
  summary?: string;
  taskId?: string;
  evidenceCount: number;
  hasRequiredEvidenceGap: boolean;
  executionStarted: boolean;
  inspectable: boolean;
  prominent: boolean;
  requiredCompletedCount: number;
  requiredDeniedCount: number;
  requiredFailedCount: number;
  requiredSkippedCount: number;
  requiredUnresolvedCount: number;
  optionalDeniedCount: number;
}

export interface TaskOutcomePresentationInput {
  status: 'completed' | 'completed_unverified' | 'verification_failed' | 'failed';
  outcome: VerificationOutcome;
  finishReason: string;
  taskId?: string;
  evidenceCount?: number;
  toolCallCount?: number;
  executionStarted?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  denied?: boolean;
  executionFailed?: boolean;
  partial?: boolean;
  requiredEvidenceGap?: boolean;
  meaningfulEvidenceRequirement?: boolean;
  completionOnlyNoOutput?: boolean;
  requiredCompletedCount?: number;
  requiredDeniedCount?: number;
  requiredFailedCount?: number;
  requiredSkippedCount?: number;
  requiredUnresolvedCount?: number;
  optionalDeniedCount?: number;
}

export interface TaskFinalizationForPresentation {
  status: TaskOutcomePresentationInput['status'];
  outcome: VerificationOutcome;
  evidence: {
    handles?: readonly unknown[];
    failures?: readonly unknown[];
    declined?: readonly unknown[];
    skipped?: readonly unknown[];
  };
}

function evidenceCount(input: TaskOutcomePresentationInput): number {
  if (input.evidenceCount !== undefined) return input.evidenceCount;
  return input.outcome.kind === 'verified' ? input.outcome.handles.length : 0;
}

function make(
  input: TaskOutcomePresentationInput,
  kind: TaskOutcomeKind,
  severity: TaskOutcomeSeverity,
  label: string,
  summary?: string,
): TaskOutcomePresentation {
  const count = evidenceCount(input);
  return {
    kind,
    severity,
    label,
    ...(summary ? { summary } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    evidenceCount: count,
    hasRequiredEvidenceGap: input.requiredEvidenceGap === true,
    executionStarted: input.executionStarted === true,
    inspectable: input.taskId !== undefined || count > 0,
    prominent: kind === 'timed_out' || kind === 'failed' || kind === 'partial' || kind === 'unverified_required',
    requiredCompletedCount: input.requiredCompletedCount ?? 0,
    requiredDeniedCount: input.requiredDeniedCount ?? 0,
    requiredFailedCount: input.requiredFailedCount ?? 0,
    requiredSkippedCount: input.requiredSkippedCount ?? 0,
    requiredUnresolvedCount: input.requiredUnresolvedCount ?? 0,
    optionalDeniedCount: input.optionalDeniedCount ?? 0,
  };
}

/** Deterministic precedence derived from meaningful required work, not generic turn noise. */
export function mapTaskOutcomePresentation(input: TaskOutcomePresentationInput): TaskOutcomePresentation {
  const completed = input.requiredCompletedCount ?? 0;
  const remainingRequiredProblems =
    (input.requiredDeniedCount ?? 0)
    + (input.requiredFailedCount ?? 0)
    + (input.requiredSkippedCount ?? 0)
    + (input.requiredUnresolvedCount ?? 0);
  const structuredPartial = completed > 0
    && (remainingRequiredProblems > 0 || input.timedOut === true || input.cancelled === true);

  // A whole-task terminal state wins only when no meaningful required subset
  // landed. Once required work landed, structured per-operation facts outrank
  // a turn-wide legacy failure/cancellation flag.
  if (input.timedOut && completed === 0) return make(input, 'timed_out', 'error', 'Timed out');
  if (input.cancelled && completed === 0) return make(input, 'cancelled', 'info', 'Cancelled');
  if (input.denied && completed === 0) return make(input, 'denied', 'info', 'Denied');
  if (structuredPartial) return make(input, 'partial', 'warning', 'Partially completed');
  if (input.executionFailed || input.status === 'failed') return make(input, 'failed', 'error', 'Failed');
  if (input.partial) return make(input, 'partial', 'warning', 'Partially completed');
  if (input.requiredEvidenceGap || input.status === 'verification_failed') {
    return make(input, 'unverified_required', 'error', 'Could not verify required outcome');
  }
  if (input.outcome.kind === 'verified' && evidenceCount(input) > 0) {
    return make(input, 'verified', 'success', 'Verified');
  }
  if (input.completionOnlyNoOutput && !input.meaningfulEvidenceRequirement) {
    return make(input, 'completed', 'info', 'Completed');
  }
  if (input.status === 'completed_unverified' || input.meaningfulEvidenceRequirement) {
    return make(input, 'completed_limited', 'warning', 'Completed · limited evidence');
  }
  return make(input, 'completed', 'info', 'Completed');
}

function resultStatus(entry: HonestyTraceEntry): string | undefined {
  const result = entry.result;
  if (!result || typeof result !== 'object') return undefined;
  const status = (result as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
}

function isCompletionOnlyNoOutput(entry: HonestyTraceEntry): boolean {
  return entry.name === 'shell_exec'
    && !entry.error
    && entry.verification?.ok === true
    && entry.verification.code === 'low_signal'
    && /empty stdout|no stdout/i.test(entry.verification.reason ?? '');
}

function planDeclines(
  trace: readonly HonestyTraceEntry[],
  persisted: readonly unknown[] = [],
): { required: number; optional: number } {
  let required = 0;
  let optional = 0;
  for (const entry of trace) {
    if (entry.name !== 'plan_approval' || !entry.result || typeof entry.result !== 'object') continue;
    const declined = (entry.result as Record<string, unknown>).declined;
    if (!Array.isArray(declined)) continue;
    for (const operation of declined) {
      if (operation && typeof operation === 'object' && (operation as Record<string, unknown>).required === false) optional += 1;
      else required += 1;
    }
  }
  // Older traces did not echo requirement metadata. The finalized evidence
  // envelope still preserves the decisions; absent an explicit optional flag,
  // a planned operation is task-gating by default.
  if (required === 0 && optional === 0) required = persisted.length;
  return { required, optional };
}

/**
 * Project current authoritative finalization plus independent execution axes
 * into mapper inputs. The claim verifier is intentionally not consulted.
 */
export function taskOutcomeInputFromFinalization(args: {
  finalization: TaskFinalizationForPresentation;
  trace?: readonly HonestyTraceEntry[];
  finishReason: string;
  taskId?: string;
}): TaskOutcomePresentationInput {
  const trace = [...(args.trace ?? [])];
  const axes = trace.map((entry, index) => deriveCommandAxes({
    providerCallId: `trace:${index}`,
    tool: entry.name,
    args: {},
    mutates: entry.handlerMutates === true,
    result: entry.result,
    error: entry.error,
    verification: entry.verification as never,
    aborted: args.finishReason === 'interrupted',
    approvalDecision: entry.approvalDecision,
  }));

  const timedOut = trace.some((entry) => entry.classification?.category === 'timeout');
  const cancelledInteraction = trace.some((entry) => {
    const status = resultStatus(entry);
    return (entry.name === 'clarify' || entry.name === 'plan_approval')
      && (status === 'cancelled' || status === 'invalid');
  });
  const interruptedApproval = axes.some((record) => record.approval.state === 'interrupted');
  const blockedApproval = axes.some((record) => record.approval.state === 'blocked');
  const cancellationRequested = args.finishReason === 'interrupted'
    || cancelledInteraction
    || interruptedApproval;
  const denialRecorded = axes.some((record) => record.approval.state === 'denied');
  const hasExecutionFailure = blockedApproval || axes.some((record) =>
    record.execution.state === 'errored' || record.execution.state === 'nonzero_exit');
  const mutatingEntries = trace.filter((entry) => entry.handlerMutates === true);
  const mutatingAxes = axes.filter((_, index) => trace[index]?.handlerMutates === true);
  const executionStarted = mutatingAxes.some((record) => record.execution.state !== 'not_started');
  const successfulMutations = mutatingAxes.filter((record) =>
    record.execution.state === 'succeeded' && record.verification.state !== 'failed').length;
  const plan = planDeclines(trace, args.finalization.evidence.declined);
  const directRequiredDenials = mutatingAxes.filter((record) => record.approval.state === 'denied').length;
  const requiredDeniedCount = plan.required + directRequiredDenials;
  const requiredFailedCount = mutatingAxes.filter((record) =>
    record.approval.state === 'blocked'
    || record.execution.state === 'errored'
    || record.execution.state === 'nonzero_exit'
    || record.execution.state === 'interrupted'
    || (record.execution.state !== 'not_started' && record.verification.state === 'failed')).length;
  const requiredCompletedCount = successfulMutations;
  const requiredSkippedCount = args.finalization.evidence.skipped?.length ?? 0;
  // The current trace/finalization contract has no independent unresolved-op
  // ledger. Keep this explicit rather than inferring from read-only failures or
  // weak evidence, either of which would manufacture required work.
  const requiredUnresolvedCount = 0;
  const partial = requiredCompletedCount > 0
    && (requiredDeniedCount + requiredFailedCount + requiredSkippedCount + requiredUnresolvedCount) > 0;
  const executionFailed = hasExecutionFailure && !partial;
  const cancelled = !timedOut && !partial && cancellationRequested;
  const denied = !timedOut
    && !cancelled
    && !partial
    && requiredCompletedCount === 0
    && requiredFailedCount === 0
    && (requiredDeniedCount > 0 || denialRecorded);
  const completionOnlyNoOutput = mutatingEntries.length > 0 && mutatingEntries.every(isCompletionOnlyNoOutput);
  const requiredEvidenceGap = args.finalization.status === 'verification_failed' && !executionFailed;
  const meaningfulEvidenceRequirement = mutatingAxes.length > 0 && !completionOnlyNoOutput;

  return {
    status: args.finalization.status,
    outcome: args.finalization.outcome,
    finishReason: args.finishReason,
    ...(args.taskId ? { taskId: args.taskId } : {}),
    evidenceCount: args.finalization.evidence.handles?.length ?? 0,
    toolCallCount: trace.length,
    executionStarted,
    timedOut,
    cancelled,
    denied,
    executionFailed,
    partial,
    requiredEvidenceGap,
    meaningfulEvidenceRequirement,
    completionOnlyNoOutput,
    requiredCompletedCount,
    requiredDeniedCount,
    requiredFailedCount,
    requiredSkippedCount,
    requiredUnresolvedCount,
    optionalDeniedCount: plan.optional,
  };
}
