/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { JobExecutionContext } from '../daemon/jobExecutionContext';
import type { CodingPlanReference, CodingPlanStepDefinition } from '../daemon/executionGraph';
import type { ChangeIntentRecord, ChangeRecord } from './safeChangeAuthority';
import type { StructuredValidationRun } from './structuredValidationAuthority';

const PLAN_PREFIX = 'runtime-codebase-plan:';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function authority(context: JobExecutionContext) {
  return {
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    producer: context.producer,
  };
}

function planDigest(context: JobExecutionContext): string {
  return `${PLAN_PREFIX}${digest(context.jobId)}`;
}

function requireTransition(operation: string, result: { applied: boolean; duplicate?: boolean; conflict?: string }): void {
  if (!result.applied && !result.duplicate) {
    throw new Error(`Coding plan ${operation} was rejected: ${result.conflict ?? 'unknown conflict'}`);
  }
}

function completeStep(input: {
  context: JobExecutionContext;
  step: CodingPlanStepDefinition;
  references: readonly CodingPlanReference[];
  outputRef: string;
  verificationRef?: string | null;
}): void {
  const { context, step } = input;
  const existing = context.engine.graph.getCodingPlan(context.jobId);
  if (!existing) {
    context.engine.graph.createCodingPlan({
      jobId: context.jobId,
      planDigest: planDigest(context),
      steps: [step],
      producer: context.producer,
      idempotencyKey: `runtime-codebase-plan:${context.jobId}`,
    });
  } else {
    if (existing.planDigest !== planDigest(context)) return;
    const prior = existing.steps.find((candidate) => candidate.stepId === step.stepId);
    if (prior?.state === 'completed') return;
    if (!prior) {
      context.engine.graph.edit({
        jobId: context.jobId,
        expectedVersion: existing.version,
        nodes: [{
          nodeId: step.stepId,
          kind: 'coding_step',
          label: step.label,
          inputRef: `repository_snapshot:${step.repositorySnapshotId}`,
          dependsOn: step.dependsOn,
          requiresVerification: step.requiresVerification,
        }],
        producer: context.producer,
        idempotencyKey: `runtime-codebase-step:${step.stepId}`,
      });
    }
  }

  const binding = authority(context);
  context.engine.graph.schedule({
    ...binding,
    idempotencyKey: `runtime-codebase-schedule:${step.stepId}`,
  });
  requireTransition('claim', context.engine.graph.claim({
    ...binding,
    nodeId: step.stepId,
    idempotencyKey: `runtime-codebase-claim:${step.stepId}`,
  }));
  if (input.references.length > 0) {
    requireTransition('reference update', context.engine.graph.addNodeReferences({
      ...binding,
      nodeId: step.stepId,
      references: input.references,
      idempotencyKey: `runtime-codebase-references:${step.stepId}`,
    }));
  }
  requireTransition('completion', context.engine.graph.complete({
    ...binding,
    nodeId: step.stepId,
    state: 'succeeded',
    outputRef: input.outputRef,
    verificationRef: input.verificationRef,
    idempotencyKey: `runtime-codebase-complete:${step.stepId}`,
  }));
}

/** Project a verified source-fenced change into the existing durable execution graph. */
export function projectCommittedRepositoryChange(input: {
  context: JobExecutionContext;
  intent: ChangeIntentRecord;
  record: ChangeRecord;
}): void {
  if (input.record.state !== 'committed' || !input.record.descendantSnapshotId) return;
  const existing = input.context.engine.graph.getCodingPlan(input.context.jobId);
  if (existing && existing.planDigest !== planDigest(input.context)) return;

  if (!existing) {
    const inspectedPath = input.intent.expectedScope[0];
    completeStep({
      context: input.context,
      step: {
        stepId: 'inspect-source',
        label: 'Capture source state',
        repositorySnapshotId: input.intent.baseSnapshotId,
      },
      references: inspectedPath ? [{
        kind: 'inspected_file',
        snapshotId: input.intent.baseSnapshotId,
        path: inspectedPath,
      }] : [],
      outputRef: `repository_snapshot:${input.intent.baseSnapshotId}`,
    });
  }

  const plan = input.context.engine.graph.getCodingPlan(input.context.jobId)!;
  const previous = plan.steps[plan.steps.length - 1]?.stepId;
  const stepId = `change-${input.intent.intentId}`;
  completeStep({
    context: input.context,
    step: {
      stepId,
      label: `Apply ${input.intent.operation}`,
      repositorySnapshotId: input.record.descendantSnapshotId,
      dependsOn: previous ? [previous] : undefined,
    },
    references: [{
      kind: 'change_record',
      id: input.record.changeId,
      snapshotId: input.record.descendantSnapshotId,
    }],
    outputRef: `change:${input.record.changeId}`,
    verificationRef: input.record.diffEvidenceId,
  });
}

/** Project a completed structured validation run into the active runtime coding plan. */
export function projectCompletedRepositoryValidation(input: {
  context: JobExecutionContext;
  run: StructuredValidationRun;
}): void {
  if (input.run.state !== 'succeeded' || !input.run.rawLogEvidenceId) return;
  const existing = input.context.engine.graph.getCodingPlan(input.context.jobId);
  if (existing && existing.planDigest !== planDigest(input.context)) return;
  const previous = existing?.steps[(existing?.steps.length ?? 0) - 1]?.stepId;
  const stepId = `validate-${input.run.runId}`;
  completeStep({
    context: input.context,
    step: {
      stepId,
      label: input.run.kind === 'test' ? 'Run tests' : 'Run build',
      repositorySnapshotId: input.run.repositorySnapshotId,
      dependsOn: previous ? [previous] : undefined,
      requiresVerification: true,
    },
    references: [{
      kind: input.run.kind === 'test' ? 'test_run' : 'build_run',
      id: input.run.runId,
      snapshotId: input.run.repositorySnapshotId,
    }],
    outputRef: `${input.run.kind}:${input.run.runId}`,
    verificationRef: input.run.rawLogEvidenceId,
  });
}
