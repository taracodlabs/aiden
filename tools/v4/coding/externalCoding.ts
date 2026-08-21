/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import path from 'node:path';

import type { ActionAuthority } from '../../../core/v4/actionAuthority';
import { externalCodingIdentity } from '../../../core/v4/coding/identities';
import type { ExternalCodingInteractionPort } from '../../../core/v4/coding/runtime';
import type { ExternalCodingProviderRegistry } from '../../../core/v4/coding/providerRegistry';
import type { ExternalCodingValidationExecutor } from '../../../core/v4/coding/verification';
import { createExternalCodingVerifier } from '../../../core/v4/coding/verification';
import { runExternalCodingWorker } from '../../../core/v4/coding/workerBridge';
import type { ExternalCodingTaskEnvelope } from '../../../core/v4/coding/types';
import {
  currentJobExecutionContext,
  currentPreparedDurableToolCall,
  ensureRepositoryExecutionBinding,
} from '../../../core/v4/daemon/jobExecutionContext';
import type { JobEngine } from '../../../core/v4/daemon/jobEngine';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { ToolSchema } from '../../../providers/v4/types';

const FORBIDDEN_OPERATIONS = [
  'git.commit', 'git.push', 'git.tag', 'git.merge', 'git.reset', 'git.clean',
  'git.remote', 'package.publish', 'agent.recursive', 'outside_workspace.write',
] as const;

export const EXTERNAL_CODING_SCHEMA: ToolSchema = {
  name: 'external_coding',
  description:
    'Delegate a bounded repository implementation task to one isolated durable coding Worker. ' +
    'The Worker edits an Aiden-owned Git worktree; Aiden independently inspects and validates the candidate. ' +
    'Changes remain review-only until the user explicitly applies them.',
  inputSchema: {
    type: 'object',
    required: ['goal', 'allowed_scope', 'acceptance_criteria', 'validation_commands'],
    properties: {
      goal: { type: 'string', description: 'One concrete implementation outcome.' },
      allowed_scope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repository-relative paths the candidate may change.',
      },
      protected_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional repository-relative paths the Worker must never change.',
      },
      acceptance_criteria: {
        type: 'array',
        items: {
          type: 'object',
          required: ['statement'],
          properties: {
            statement: { type: 'string' },
            required: { type: 'boolean' },
          },
        },
        description: 'Observable claims Aiden must independently verify.',
      },
      validation_commands: {
        type: 'array',
        items: { type: 'string' },
        description: 'Direct test or build commands for Aiden to run independently in its validation sandbox.',
      },
      runtime_ms: {
        type: 'integer',
        description: 'Bounded runtime in milliseconds (1000-900000; default 600000).',
      },
    },
  },
};

export interface ExternalCodingToolOptions {
  readonly engine: JobEngine;
  readonly actions: ActionAuthority;
  readonly providers: ExternalCodingProviderRegistry;
  readonly providerId: string;
  readonly modelId: string | (() => string);
  readonly instanceId: string;
  readonly worktreeParent: string;
  readonly sessionHomeParent: string;
  readonly validationExecutor: ExternalCodingValidationExecutor;
  readonly sandboxAvailable: () => boolean;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly approvedEnvironment?: Readonly<Record<string, string>>;
  readonly approvedEnvironmentKeys?: readonly string[];
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim()).filter(Boolean))];
}

function safeRelative(value: string): boolean {
  const normalized = value.replace(/\\/gu, '/');
  return normalized.length <= 512 && !path.isAbsolute(value) && !normalized.startsWith('/')
    && !normalized.split('/').includes('..') && !/[\0\r\n]/u.test(normalized);
}

function buildTask(args: Readonly<Record<string, unknown>>, authorityKey: string): ExternalCodingTaskEnvelope {
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  const allowedScope = strings(args.allowed_scope);
  const protectedPaths = strings(args.protected_paths);
  const criteriaInput = Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria : [];
  const acceptanceCriteria = criteriaInput.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const statement = typeof record.statement === 'string' ? record.statement.trim() : '';
    if (!statement) return [];
    return [{
      claimId: externalCodingIdentity('coding_claim', { authorityKey, statement, index }),
      statement,
      required: record.required !== false,
    }];
  });
  const validationCommands = strings(args.validation_commands);
  const requestedRuntime = typeof args.runtime_ms === 'number' && Number.isFinite(args.runtime_ms)
    ? Math.floor(args.runtime_ms) : 600_000;
  return {
    goal,
    allowedScope,
    protectedPaths,
    forbiddenOperations: [...FORBIDDEN_OPERATIONS],
    acceptanceCriteria,
    validationCommands,
    networkPolicy: 'disabled',
    packagePolicy: 'deny',
    budgets: {
      runtimeMs: Math.max(1_000, Math.min(900_000, requestedRuntime)),
      outputBytes: 1024 * 1024,
      commandCount: 128,
      eventCount: 2_000,
      inputCount: 32,
    },
    promotionPolicy: 'human_approval_required',
  };
}

function validateTask(task: ExternalCodingTaskEnvelope): string | null {
  if (!task.goal || task.goal.length > 16_384) return 'goal must contain 1-16384 characters';
  if (task.allowedScope.length === 0 || task.allowedScope.length > 128) return 'allowed_scope must contain 1-128 paths';
  if ([...task.allowedScope, ...task.protectedPaths].some((item) => !safeRelative(item))) {
    return 'scope and protected paths must be safe repository-relative paths';
  }
  if (task.acceptanceCriteria.length === 0 || task.acceptanceCriteria.length > 64) {
    return 'acceptance_criteria must contain 1-64 observable claims';
  }
  if (task.validationCommands.length === 0 || task.validationCommands.length > 16) {
    return 'validation_commands must contain 1-16 direct commands';
  }
  if (task.validationCommands.some((command) => command.length > 2_048)) {
    return 'validation command is too long';
  }
  return null;
}

export function makeExternalCodingStub(): ToolHandler {
  return {
    schema: EXTERNAL_CODING_SCHEMA,
    category: 'execute',
    mutates: true,
    toolset: 'subagent',
    riskTier: 'dangerous',
    contexts: ['repl', 'daemon'],
    buildPreview: (args) => ({
      tool: 'external_coding', args, riskTier: 'dangerous',
      sideEffects: [{ type: 'process_spawn', command: 'isolated external coding runtime' }],
      detectedRisks: ['external process', 'isolated repository mutation'],
      summary: 'Would admit one durable coding Worker in an isolated Git worktree; promotion remains separately approved.',
    }),
    async execute() {
      return { success: false, error: 'External coding capability is not wired in this runtime.' };
    },
  };
}

export function makeExternalCodingTool(options: ExternalCodingToolOptions): ToolHandler {
  return {
    ...makeExternalCodingStub(),
    validateArguments(args) {
      const prepared = currentPreparedDurableToolCall();
      const task = buildTask(args, prepared?.toolCallId ?? 'preflight');
      return validateTask(task);
    },
    async execute(args, context) {
      const durable = currentJobExecutionContext();
      if (!durable || durable.engine !== options.engine || !durable.signal) {
        throw new Error('External coding requires an active durable Job Attempt');
      }
      const repository = await ensureRepositoryExecutionBinding(durable);
      if (!repository) throw new Error('External coding requires a Git repository-bound Job');
      const snapshot = options.engine.repository.getSnapshot(repository.inspection.snapshotId);
      if (!snapshot?.repositoryRoot || snapshot.vcsKind !== 'git' || snapshot.incomplete) {
        throw new Error('External coding requires a complete Git repository snapshot');
      }
      const modelId = typeof options.modelId === 'function' ? options.modelId() : options.modelId;
      if (!modelId.trim()) {
        throw new Error('External coding model is not configured; set coding.external_model or AIDEN_CODING_MODEL');
      }
      if (!options.sandboxAvailable()) {
        throw new Error('External coding is unavailable because independent Docker validation is not available');
      }
      const durableToolCall = currentPreparedDurableToolCall();
      if (!durableToolCall) throw new Error('External coding requires an exact durable ToolCall identity');
      const task = buildTask(args, durableToolCall.toolCallId);
      const validationError = validateTask(task);
      if (validationError) throw new Error(validationError);

      const interaction: ExternalCodingInteractionPort = {
        async requestClarification(request) {
          if (!context.clarify) throw new Error('External coding clarification requires an interactive parent channel');
          const response = await context.clarify(request.question);
          if (response === null) throw new Error('External coding clarification was cancelled');
          return { content: response, respondedBy: 'workbench-user', responseChannel: 'parent-interaction' };
        },
        async requestApproval() {
          return { decision: 'denied', decidedBy: 'external-coding-policy', decisionChannel: 'policy' };
        },
      };

      const result = await runExternalCodingWorker({
        engine: options.engine,
        parent: {
          jobId: durable.jobId,
          attemptId: durable.attemptId,
          generation: durable.generation,
          fenceToken: durable.fenceToken,
        },
        idempotencyKey: durableToolCall.toolCallId,
        repositorySnapshotId: snapshot.id,
        sourcePath: snapshot.repositoryRoot,
        instanceId: options.instanceId,
        providers: options.providers,
        providerId: options.providerId,
        modelId,
        task,
        boundedParentNote: 'Aiden retains lifecycle, approval, verification, and promotion authority.',
        credentialReference: options.approvedEnvironment?.OPENAI_API_KEY
          ? 'credential:codex_responses:api_key' : null,
        ownerId: `external-coding:${options.instanceId}`,
        worktreeParent: options.worktreeParent,
        sessionHomeParent: options.sessionHomeParent,
        sourceEnvironment: options.sourceEnvironment,
        approvedEnvironment: options.approvedEnvironment,
        approvedEnvironmentKeys: options.approvedEnvironmentKeys,
        sandboxAvailable: true,
        approvalAuthority: options.actions,
        interaction,
        verify: createExternalCodingVerifier({ executor: options.validationExecutor }),
      });
      const value = result.execution.value;
      return {
        success: value.proof.verdict === 'verified',
        status: value.finalization.status,
        parentJobId: durable.jobId,
        childJobId: result.admission.child.jobId,
        childAttemptId: result.execution.attemptId,
        generation: result.execution.generation,
        codingSessionId: value.codingSessionId,
        changedPaths: value.mutation.changedPaths,
        validationRefs: value.promotion?.validationRefs
          ?? options.engine.coding.get(value.codingSessionId)?.validationRefs
          ?? [],
        proof: value.proof.verdict,
        promotion: value.promotion ? {
          promotionId: value.promotion.promotionId,
          state: value.promotion.state,
        } : null,
        message: value.promotion
          ? 'Isolated candidate is ready for human review. No changes were applied to the source workspace.'
          : 'Coding session did not produce an independently verified candidate for promotion.',
      };
    },
  };
}
