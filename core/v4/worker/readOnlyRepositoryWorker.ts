/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { AidenAgent } from '../aidenAgent';
import type { DurableJobDisposition, DurableJobHandle } from '../daemon/jobLifecycle';
import type { JobEngine, AdmissionResult } from '../daemon/jobEngine';
import { currentJobExecutionContext } from '../daemon/jobExecutionContext';
import type { TriggerBus } from '../daemon/triggerBus';
import type { AidenPaths } from '../paths';
import { ToolRegistry, type ToolHandler } from '../toolRegistry';
import {
  currentProviderAttemptLedger,
  runWithProviderUsageContext,
} from '../../../providers/v4/providerAttemptAccounting';
import type { ProviderAdapter, ToolCallRequest, ToolCallResult } from '../../../providers/v4/types';
import {
  computeWorkerDigest,
  computeWorkerResultHash,
  type WorkerAssignmentRecord,
  type WorkerContextEnvelopeRecord,
  type WorkerDefinitionV1,
  type WorkerProviderBindingRecord,
  type WorkerResultPayloadV1,
  type WorkerResultRecord,
  type WorkerResultSourceReference,
  type WorkerRunRecord,
} from './types';

export const READ_ONLY_REPOSITORY_WORKER_TOOLS = Object.freeze([
  'repository_snapshot_search',
  'repository_snapshot_read',
  'repository_instruction_read',
] as const);

export const READ_ONLY_REPOSITORY_WORKER: WorkerDefinitionV1 = Object.freeze({
  schemaVersion: 1,
  workerDefinitionId: 'repository-read-worker',
  workerDefinitionVersion: 1,
  expectedResultSchemaId: 'repository-read-worker-result-v1',
  expectedEvidenceSchemaId: 'repository-read-worker-evidence-v1',
  requiredCapabilities: READ_ONLY_REPOSITORY_WORKER_TOOLS,
});

export interface ReadOnlyWorkerParentAuthority {
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
}

export interface ReadOnlyWorkerProviderSelection {
  providerId: string;
  modelId: string;
  providerRuntimeIdentity: string;
  credentialReference: string | null;
  endpointReference: string | null;
  supportsToolCalling: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  selectionReason: string;
}

export interface AdmitReadOnlyRepositoryWorkerInput {
  engine: JobEngine;
  triggerBus: TriggerBus;
  parent: ReadOnlyWorkerParentAuthority;
  idempotencyKey: string;
  goal: string;
  repositorySnapshotId: string;
  planStepIds?: readonly string[];
  claimIds?: readonly string[];
  sourceReferenceIds?: readonly string[];
  instructionReferenceIds?: readonly string[];
  boundedParentNote?: string | null;
  provider: ReadOnlyWorkerProviderSelection;
  producer?: string;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxRuntimeMs?: number;
}

export interface ReadOnlyRepositoryWorkerAdmission {
  child: AdmissionResult;
  assignment: WorkerAssignmentRecord;
  providerBinding: WorkerProviderBindingRecord;
  contextEnvelope: WorkerContextEnvelopeRecord;
  triggerEvent: { id: number; inserted: boolean };
}

export interface ReadOnlyRepositoryWorkerToolRegistryInput {
  engine: JobEngine;
  assignmentId: string;
  workerRunId: string;
}

export interface ResolvedReadOnlyWorkerProvider {
  adapter: ProviderAdapter;
  paths: AidenPaths;
}

export type ReadOnlyWorkerProviderResolver = (
  binding: WorkerProviderBindingRecord,
) => Promise<ResolvedReadOnlyWorkerProvider>;

export interface ExecuteReadOnlyRepositoryWorkerInput {
  engine: JobEngine;
  handle: DurableJobHandle;
  assignmentId: string;
  resolveProvider: ReadOnlyWorkerProviderResolver;
}

export interface ReadOnlyRepositoryWorkerExecution {
  workerRun: WorkerRunRecord;
  workerResult: WorkerResultRecord;
  finalization: DurableJobDisposition;
  totalTokens: number;
}

export interface VerifyReadOnlyRepositoryWorkerResultInput {
  engine: JobEngine;
  parent: ReadOnlyWorkerParentAuthority;
  workerResultId: string;
  producer?: string;
  idempotencyKey: string;
}

const TERMINAL_JOB = new Set(['cancelled', 'completed', 'failed', 'blocked', 'unknown', 'crashed', 'dead_letter']);

function identity(prefix: string, value: unknown): string {
  return `${prefix}_${computeWorkerDigest(value).slice(0, 32)}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

export function admitReadOnlyRepositoryWorker(
  input: AdmitReadOnlyRepositoryWorkerInput,
): ReadOnlyRepositoryWorkerAdmission {
  const producer = input.producer ?? 'repository-worker-admission';
  const maxModelCalls = input.maxModelCalls ?? 4;
  const maxToolCalls = input.maxToolCalls ?? 12;
  const maxRuntimeMs = input.maxRuntimeMs ?? 120_000;
  assertPositiveInteger(maxModelCalls, 'Worker model-call budget');
  assertPositiveInteger(maxToolCalls, 'Worker tool-call budget');
  assertPositiveInteger(maxRuntimeMs, 'Worker runtime budget');
  if (!input.provider.supportsToolCalling) {
    throw new Error('Read-only repository Worker requires a tool-capable provider model');
  }
  assertPositiveInteger(input.provider.contextWindow, 'Provider context window');
  assertPositiveInteger(input.provider.maxOutputTokens, 'Provider output limit');
  const estimatedInputTokens = Math.ceil((input.goal.length + (input.boundedParentNote?.length ?? 0)) / 4) + 512;
  if (input.provider.maxOutputTokens >= input.provider.contextWindow
    || estimatedInputTokens + input.provider.maxOutputTokens > input.provider.contextWindow) {
    throw new Error('Read-only repository Worker context exceeds the pinned provider window');
  }

  const parent = input.engine.getJob(input.parent.jobId);
  const parentAttempt = input.engine.getAttempt(input.parent.attemptId);
  if (!parent || parent.activeAttemptId !== input.parent.attemptId
    || parentAttempt?.generation !== input.parent.generation
    || parentAttempt.fenceToken !== input.parent.fenceToken
    || TERMINAL_JOB.has(parent.status)) {
    throw new Error('Parent Attempt authority is no longer active');
  }
  const snapshot = input.engine.repository.getSnapshot(input.repositorySnapshotId);
  if (!snapshot || snapshot.jobId !== input.parent.jobId
    || snapshot.attemptId !== input.parent.attemptId
    || snapshot.generation !== input.parent.generation) {
    throw new Error('Assigned repository snapshot does not belong to the active parent Attempt');
  }
  const workspace = input.engine.repository.getWorkspace(snapshot.workspaceId);
  if (!workspace) throw new Error('Assigned repository workspace is unavailable');
  const repositoryRoot = snapshot.repositoryRoot ?? workspace.canonicalPath;

  const requestIdentity = {
    parentJobId: input.parent.jobId,
    parentAttemptId: input.parent.attemptId,
    parentGeneration: input.parent.generation,
    idempotencyKey: input.idempotencyKey,
  };
  const assignmentId = identity('worker_assignment', requestIdentity);
  const childKey = identity('worker_child', requestIdentity);
  const existingAssignment = input.engine.worker.getWorkerAssignment(assignmentId);
  const activeOther = input.engine.worker.listWorkerAssignmentsForParent(input.parent.jobId)
    .find((candidate) => candidate.assignmentId !== assignmentId
      && candidate.parentAttemptId === input.parent.attemptId
      && candidate.parentGeneration === input.parent.generation
      && !TERMINAL_JOB.has(input.engine.getJob(candidate.childJobId)?.status ?? 'unknown'));
  if (activeOther) throw new Error('Only one active read-only repository Worker is permitted for a parent Attempt');

  const providerBindingId = identity('worker_provider', requestIdentity);
  const contextEnvelopeId = identity('worker_context', requestIdentity);
  const capabilitySnapshotHash = computeWorkerDigest({
    providerId: input.provider.providerId,
    modelId: input.provider.modelId,
    supportsToolCalling: true,
    tools: READ_ONLY_REPOSITORY_WORKER_TOOLS,
    contextWindow: input.provider.contextWindow,
    maxOutputTokens: input.provider.maxOutputTokens,
  });
  const toolSchemaDigest = computeWorkerDigest({
    workerDefinitionId: READ_ONLY_REPOSITORY_WORKER.workerDefinitionId,
    workerDefinitionVersion: READ_ONLY_REPOSITORY_WORKER.workerDefinitionVersion,
    tools: READ_ONLY_REPOSITORY_WORKER_TOOLS,
  });

  const authority = {
    parentJobId: input.parent.jobId,
    parentAttemptId: input.parent.attemptId,
    parentGeneration: input.parent.generation,
    parentFenceToken: input.parent.fenceToken,
    producer,
  };
  input.engine.appendJobEvent({
    jobId: input.parent.jobId,
    attemptId: input.parent.attemptId,
    generation: input.parent.generation,
    type: 'worker.admission_started',
    payload: { assignmentId, repositorySnapshotId: input.repositorySnapshotId },
    producer,
    idempotencyKey: `worker-admission-started:${assignmentId}`,
  });
  const providerBinding = input.engine.worker.createWorkerProviderBinding({
    ...authority,
    providerBindingId,
    schemaVersion: 1,
    providerId: input.provider.providerId,
    modelId: input.provider.modelId,
    providerRuntimeIdentity: input.provider.providerRuntimeIdentity,
    credentialReference: input.provider.credentialReference,
    endpointReference: input.provider.endpointReference,
    capabilitySnapshotHash,
    selectionReason: input.provider.selectionReason,
    fallbackPolicyId: null,
    contextWindow: input.provider.contextWindow,
    maxOutputTokens: input.provider.maxOutputTokens,
    idempotencyKey: `${input.idempotencyKey}:provider`,
  });
  const contextEnvelope = input.engine.worker.createWorkerContextEnvelope({
    ...authority,
    contextEnvelopeId,
    schemaVersion: 1,
    assignmentId,
    repositorySnapshotId: input.repositorySnapshotId,
    planStepIds: [...(input.planStepIds ?? [])],
    claimIds: [...(input.claimIds ?? [])],
    sourceReferenceIds: [...(input.sourceReferenceIds ?? [])],
    instructionReferenceIds: [...(input.instructionReferenceIds ?? [])],
    boundedParentNote: input.boundedParentNote ?? null,
    toolSchemaDigest,
    tokenEstimate: estimatedInputTokens,
    idempotencyKey: `${input.idempotencyKey}:context`,
  });

  const child = input.engine.submitJob({
    entryPoint: 'worker',
    source: producer,
    sessionId: parent.sessionId,
    workspaceId: parent.workspaceId ?? null,
    instanceId: parentAttempt.leaseOwner ?? 'repository-worker',
    idempotencyNamespace: `worker:${input.parent.jobId}:${input.parent.attemptId}:${input.parent.generation}`,
    idempotencyKey: childKey,
    requestFingerprint: computeWorkerDigest({ requestIdentity, goal: input.goal, snapshotId: input.repositorySnapshotId }),
    goal: input.goal,
    title: input.goal,
    parentJobId: input.parent.jobId,
    rootJobId: parent.rootJobId,
    childContract: {
      required: true,
      workerId: READ_ONLY_REPOSITORY_WORKER.workerDefinitionId,
      capabilities: READ_ONLY_REPOSITORY_WORKER_TOOLS,
      allowedResources: { repositorySnapshotId: input.repositorySnapshotId },
      budget: { modelCalls: maxModelCalls, toolCalls: maxToolCalls, runtimeMs: maxRuntimeMs },
    },
    resourcePolicy: {
      budgets: {
        model_calls: maxModelCalls,
        tool_calls: maxToolCalls,
        runtime_ms: maxRuntimeMs,
        input_tokens: input.provider.contextWindow * maxModelCalls,
        output_tokens: input.provider.maxOutputTokens * maxModelCalls,
        output_bytes: 512 * 1024,
        effects: 0,
        workers: 0,
      },
      capabilities: {
        tools: READ_ONLY_REPOSITORY_WORKER_TOOLS,
        paths: [repositoryRoot], hosts: [], applications: [], connections: [], accounts: [], workers: [], effectKinds: [],
      },
    },
  });
  const assignment = existingAssignment ?? input.engine.worker.createWorkerAssignment({
    ...authority,
    assignmentId,
    schemaVersion: 1,
    workerDefinitionId: READ_ONLY_REPOSITORY_WORKER.workerDefinitionId,
    workerDefinitionVersion: READ_ONLY_REPOSITORY_WORKER.workerDefinitionVersion,
    childContractId: child.jobId,
    childJobId: child.jobId,
    repositorySnapshotId: input.repositorySnapshotId,
    contextEnvelopeId: contextEnvelope.contextEnvelopeId,
    providerBindingId: providerBinding.providerBindingId,
    capabilitySetId: child.jobId,
    goal: input.goal,
    expectedResultSchemaId: READ_ONLY_REPOSITORY_WORKER.expectedResultSchemaId,
    expectedEvidenceSchemaId: READ_ONLY_REPOSITORY_WORKER.expectedEvidenceSchemaId,
    idempotencyKey: input.idempotencyKey,
  });
  const triggerEvent = input.triggerBus.insert({
    source: 'manual',
    sourceKey: `worker:${assignment.assignmentId}`,
    idempotencyKey: `worker-dispatch:${assignment.assignmentId}`,
    payload: {
      fireReason: 'worker_assignment',
      worker_assignment_id: assignment.assignmentId,
      durable_job: {
        job_id: child.jobId,
        attempt_id: child.attemptId,
        run_id: child.runId,
      },
    },
  });
  input.engine.appendJobEvent({
    jobId: input.parent.jobId,
    attemptId: input.parent.attemptId,
    generation: input.parent.generation,
    type: 'worker.admitted',
    payload: { assignmentId: assignment.assignmentId, childJobId: child.jobId },
    producer,
    idempotencyKey: `worker-admitted:${assignment.assignmentId}`,
  });
  input.engine.appendJobEvent({
    jobId: input.parent.jobId,
    attemptId: input.parent.attemptId,
    generation: input.parent.generation,
    type: 'worker.dispatch_enqueued',
    payload: { assignmentId: assignment.assignmentId, childJobId: child.jobId, triggerEventId: triggerEvent.id },
    producer,
    idempotencyKey: `worker-dispatch-enqueued:${assignment.assignmentId}`,
  });
  return { child, assignment, providerBinding, contextEnvelope, triggerEvent };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Worker tool range must be a non-negative integer');
  return Math.min(Number(value), maximum);
}

export function createReadOnlyRepositoryWorkerToolRegistry(
  input: ReadOnlyRepositoryWorkerToolRegistryInput,
): ToolRegistry {
  const assignment = input.engine.worker.getWorkerAssignment(input.assignmentId);
  const run = input.engine.worker.getWorkerRun(input.workerRunId);
  if (!assignment || !run || run.assignmentId !== assignment.assignmentId
    || !assignment.repositorySnapshotId || run.childJobId !== assignment.childJobId) {
    throw new Error('Read-only repository Worker authority is incomplete');
  }
  if (assignment.capabilitySetId !== assignment.childJobId
    || !READ_ONLY_REPOSITORY_WORKER_TOOLS.every((tool) => input.engine.resources.authorize({
      jobId: assignment.childJobId, kind: 'tool', value: tool,
    }))) {
    throw new Error('Read-only repository Worker capability set is missing or incomplete');
  }
  const snapshotId = assignment.repositorySnapshotId;
  const snapshot = input.engine.repository.getSnapshot(snapshotId);
  if (!snapshot || snapshot.jobId !== assignment.parentJobId) {
    throw new Error('Assigned repository snapshot is unavailable');
  }

  const assertChildAuthority = (): void => {
    const current = currentJobExecutionContext();
    if (!current || current.engine !== input.engine || current.jobId !== run.childJobId
      || current.attemptId !== run.childAttemptId || current.generation !== run.childGeneration) {
      throw new Error('Worker tool call is outside the assigned child Attempt authority');
    }
    const attempt = input.engine.getAttempt(current.attemptId);
    if (attempt?.fenceToken !== current.fenceToken) {
      throw new Error('Worker tool call has stale child Attempt authority');
    }
  };
  const readSnapshot = async (relativePath: string, offset = 0, limit = 64 * 1024): Promise<Record<string, unknown>> => {
    assertChildAuthority();
    const entry = input.engine.repository.getEntry(snapshotId, relativePath);
    if (!entry || entry.captureStatus !== 'captured' || !entry.contentHash) {
      throw new Error('Path is not readable from the assigned repository snapshot');
    }
    const result = await input.engine.repository.readFile(snapshotId, relativePath, { offset, limit });
    if (result.stale === true || result.fullContentHash !== entry.contentHash
      || result.canonicalIdentity !== entry.canonicalIdentity) {
      throw new Error('Assigned repository snapshot is stale');
    }
    return {
      snapshotId,
      snapshotEntryId: entry.canonicalIdentity,
      path: entry.path,
      contentHash: entry.contentHash,
      offset: result.offset,
      content: result.content,
      truncated: result.truncated,
      stale: false,
    };
  };

  const handlers: ToolHandler[] = [
    {
      schema: {
        name: 'repository_snapshot_search',
        description: 'Search text only within the assigned immutable repository snapshot.',
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['query'],
          properties: {
            query: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      },
      category: 'read', mutates: false, toolset: 'repository-worker', contexts: ['daemon'], riskTier: 'safe',
      async execute(args) {
        assertChildAuthority();
        const query = requireString(args.query, 'Search query');
        const limit = Math.max(1, boundedInteger(args.limit, 20, 50));
        const result = await input.engine.repository.search(snapshotId, query, { limit });
        if (result.stale) throw new Error('Assigned repository snapshot is stale');
        return {
          snapshotId,
          stateDigest: result.stateDigest,
          matches: result.matches.map((match) => {
            const entry = input.engine.repository.getEntry(snapshotId, match.path);
            if (!entry?.contentHash) throw new Error('Search result is not captured by the assigned snapshot');
            return {
              ...match,
              snapshotEntryId: entry.canonicalIdentity,
              contentHash: entry.contentHash,
            };
          }),
          truncated: result.truncated,
          stale: false,
        };
      },
    },
    {
      schema: {
        name: 'repository_snapshot_read',
        description: 'Read bounded content from one captured file in the assigned repository snapshot.',
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['path'],
          properties: {
            path: { type: 'string', minLength: 1 },
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 65_536 },
          },
        },
      },
      category: 'read', mutates: false, toolset: 'repository-worker', contexts: ['daemon'], riskTier: 'safe',
      async execute(args) {
        const relativePath = requireString(args.path, 'Snapshot path');
        return readSnapshot(
          relativePath,
          boundedInteger(args.offset, 0, Number.MAX_SAFE_INTEGER),
          Math.max(1, boundedInteger(args.limit, 64 * 1024, 64 * 1024)),
        );
      },
    },
    {
      schema: {
        name: 'repository_instruction_read',
        description: 'List or read captured repository instruction files from the assigned snapshot.',
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 32_768 },
          },
        },
      },
      category: 'read', mutates: false, toolset: 'repository-worker', contexts: ['daemon'], riskTier: 'safe',
      async execute(args) {
        assertChildAuthority();
        const instructions = input.engine.repository.discoverInstructions(snapshotId);
        if (args.path === undefined) return { snapshotId, instructions, stale: false };
        const relativePath = requireString(args.path, 'Instruction path');
        if (!instructions.some((item) => item.path === relativePath)) {
          throw new Error('Path is not an instruction file in the assigned repository snapshot');
        }
        return readSnapshot(relativePath, 0, Math.max(1, boundedInteger(args.limit, 32 * 1024, 32 * 1024)));
      },
    },
  ];
  const registry = new ToolRegistry();
  for (const handler of handlers) registry.register(handler);
  return registry;
}

type ModelFinding = {
  findingId: string;
  statement: string;
  sourceReferences: WorkerResultSourceReference[];
  uncertainty: 'low' | 'medium' | 'high';
};

type ModelResult = {
  schemaVersion: 1;
  status: 'completed' | 'partial' | 'failed' | 'blocked';
  summary: string;
  findings: ModelFinding[];
  unresolvedQuestions: string[];
  uncertainty: { level: 'low' | 'medium' | 'high'; reasons: string[] };
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length && keys.every((key, index) => key === [...allowed].sort()[index]);
}

function stringList(value: unknown, maximum = 128): value is string[] {
  return Array.isArray(value) && value.length <= maximum
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 8_192);
}

function sourceReference(value: unknown): WorkerResultSourceReference | null {
  const item = record(value);
  if (!item || !exactKeys(item, ['snapshotId', 'snapshotEntryId', 'path', 'startLine', 'endLine', 'contentHash'])) return null;
  if (typeof item.snapshotId !== 'string' || typeof item.snapshotEntryId !== 'string'
    || typeof item.path !== 'string' || typeof item.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(item.contentHash)
    || !Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine)
    || Number(item.startLine) < 1 || Number(item.endLine) < Number(item.startLine)) return null;
  return {
    snapshotId: item.snapshotId,
    snapshotEntryId: item.snapshotEntryId,
    path: item.path,
    startLine: Number(item.startLine),
    endLine: Number(item.endLine),
    contentHash: item.contentHash,
  };
}

function parseModelResult(content: string): ModelResult {
  const trimmed = content.trim();
  const json = /^```json\s*([\s\S]*?)\s*```$/u.exec(trimmed)?.[1] ?? trimmed;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error('Worker result is not valid JSON'); }
  const item = record(parsed);
  if (!item || !exactKeys(item, ['schemaVersion', 'status', 'summary', 'findings', 'unresolvedQuestions', 'uncertainty'])
    || item.schemaVersion !== 1
    || !['completed', 'partial', 'failed', 'blocked'].includes(String(item.status))
    || typeof item.summary !== 'string' || item.summary.length === 0 || item.summary.length > 65_536
    || !Array.isArray(item.findings) || item.findings.length > 128
    || !stringList(item.unresolvedQuestions)) {
    throw new Error('Worker result does not match the repository Worker schema');
  }
  const uncertainty = record(item.uncertainty);
  if (!uncertainty || !exactKeys(uncertainty, ['level', 'reasons'])
    || !['low', 'medium', 'high'].includes(String(uncertainty.level))
    || !stringList(uncertainty.reasons)) {
    throw new Error('Worker result uncertainty is invalid');
  }
  const findings: ModelFinding[] = item.findings.map((value) => {
    const finding = record(value);
    if (!finding || !exactKeys(finding, ['findingId', 'statement', 'sourceReferences', 'uncertainty'])
      || typeof finding.findingId !== 'string' || finding.findingId.length === 0 || finding.findingId.length > 512
      || typeof finding.statement !== 'string' || finding.statement.length === 0 || finding.statement.length > 65_536
      || !['low', 'medium', 'high'].includes(String(finding.uncertainty))
      || !Array.isArray(finding.sourceReferences) || finding.sourceReferences.length > 128) {
      throw new Error('Worker finding does not match the repository Worker schema');
    }
    const references = finding.sourceReferences.map(sourceReference);
    if (references.some((reference) => reference === null)) {
      throw new Error('Worker source reference does not match the repository Worker schema');
    }
    return {
      findingId: finding.findingId,
      statement: finding.statement,
      sourceReferences: references as WorkerResultSourceReference[],
      uncertainty: finding.uncertainty as ModelFinding['uncertainty'],
    };
  });
  if ((item.status === 'completed' || item.status === 'partial')
    && !findings.some((finding) => finding.sourceReferences.length > 0)) {
    throw new Error('Completed Worker findings require repository source references');
  }
  return {
    schemaVersion: 1,
    status: item.status as ModelResult['status'],
    summary: item.summary,
    findings,
    unresolvedQuestions: item.unresolvedQuestions as string[],
    uncertainty: {
      level: uncertainty.level as ModelResult['uncertainty']['level'],
      reasons: uncertainty.reasons as string[],
    },
  };
}

function uniqueReferences(findings: readonly ModelFinding[]): WorkerResultSourceReference[] {
  const values = new Map<string, WorkerResultSourceReference>();
  for (const finding of findings) {
    for (const reference of finding.sourceReferences) {
      const key = JSON.stringify(reference);
      if (!values.has(key)) values.set(key, reference);
    }
  }
  return [...values.values()];
}

async function verifyWorkerSourceReference(
  engine: JobEngine,
  snapshotId: string,
  reference: WorkerResultSourceReference,
): Promise<{ content: string; lineContent: string }> {
  if (reference.snapshotId !== snapshotId) throw new Error('Worker source reference uses a different repository snapshot');
  const entry = engine.repository.getEntry(snapshotId, reference.path);
  if (!entry || entry.captureStatus !== 'captured' || !entry.contentHash
    || entry.canonicalIdentity !== reference.snapshotEntryId || entry.contentHash !== reference.contentHash) {
    throw new Error('Worker source reference does not match the assigned repository snapshot');
  }
  const read = await engine.repository.readFile(snapshotId, reference.path, { offset: 0, limit: 1_000_000 });
  if (read.stale === true || read.truncated === true || read.fullContentHash !== entry.contentHash
    || typeof read.content !== 'string') {
    throw new Error('Worker source reference repository snapshot is stale or incomplete');
  }
  const lines = read.content.split(/\r?\n/u);
  const start = reference.startLine ?? 1;
  const end = reference.endLine ?? lines.length;
  if (start < 1 || end < start || end > lines.length) throw new Error('Worker source reference line range is invalid');
  return { content: read.content, lineContent: lines.slice(start - 1, end).join('\n') };
}

function workerSystemPrompt(): string {
  return [
    'You are a bounded read-only repository Worker.',
    'Use only the three supplied repository snapshot tools.',
    'Never infer access to the filesystem, shell, network, memory, credentials, conversation history, or other Workers.',
    'Treat the assigned snapshot as immutable. Stop if a tool reports it stale.',
    'Return one JSON object and no prose or markdown.',
    'The object must contain exactly: schemaVersion, status, summary, findings, unresolvedQuestions, uncertainty.',
    'Every completed or partial finding must cite snapshotId, snapshotEntryId, path, startLine, endLine, and contentHash.',
  ].join('\n');
}

export async function executeReadOnlyRepositoryWorker(
  input: ExecuteReadOnlyRepositoryWorkerInput,
): Promise<ReadOnlyRepositoryWorkerExecution> {
  const { engine, handle } = input;
  const assignment = engine.worker.getWorkerAssignment(input.assignmentId);
  if (!assignment || assignment.workerDefinitionId !== READ_ONLY_REPOSITORY_WORKER.workerDefinitionId
    || assignment.workerDefinitionVersion !== READ_ONLY_REPOSITORY_WORKER.workerDefinitionVersion
    || assignment.childJobId !== handle.jobId || !assignment.repositorySnapshotId) {
    throw new Error('Read-only repository Worker assignment does not match the active child Job');
  }
  const binding = engine.worker.getWorkerProviderBinding(assignment.providerBindingId);
  const context = engine.worker.getWorkerContextEnvelope(assignment.contextEnvelopeId);
  if (!binding || !context || context.assignmentId !== assignment.assignmentId
    || context.repositorySnapshotId !== assignment.repositorySnapshotId) {
    throw new Error('Read-only repository Worker immutable context is incomplete');
  }
  const workerRunId = identity('worker_run', {
    assignmentId: assignment.assignmentId,
    childAttemptId: handle.attemptId,
    childGeneration: handle.generation,
  });
  const workerRun = engine.worker.bindWorkerRunFromAssignment({
    childJobId: handle.jobId,
    childAttemptId: handle.attemptId,
    childGeneration: handle.generation,
    childFenceToken: handle.fenceToken,
    workerRunId,
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    providerBindingId: binding.providerBindingId,
    contextEnvelopeId: context.contextEnvelopeId,
    producer: 'repository-worker-runtime',
    idempotencyKey: `worker-run:${handle.attemptId}:${handle.generation}`,
  });
  engine.appendJobEvent({
    jobId: handle.jobId,
    attemptId: handle.attemptId,
    generation: handle.generation,
    type: 'worker.execution_started',
    payload: { assignmentId: assignment.assignmentId, workerRunId: workerRun.workerRunId },
    producer: 'repository-worker-runtime',
    idempotencyKey: `worker-execution-started:${workerRun.workerRunId}`,
  });
  const resolved = await input.resolveProvider(binding);
  if (!resolved?.adapter || !resolved.paths) throw new Error('Worker provider binding could not be resolved');
  const snapshot = engine.repository.getSnapshot(assignment.repositorySnapshotId);
  const workspace = snapshot ? engine.repository.getWorkspace(snapshot.workspaceId) : undefined;
  if (!snapshot || !workspace) throw new Error('Worker repository snapshot is unavailable');
  const registry = createReadOnlyRepositoryWorkerToolRegistry({
    engine,
    assignmentId: assignment.assignmentId,
    workerRunId: workerRun.workerRunId,
  });
  if (registry.list().join('\0') !== READ_ONLY_REPOSITORY_WORKER_TOOLS.join('\0')) {
    throw new Error('Worker tool registry does not match the immutable capability set');
  }
  const calls = new Map<string, { call: ToolCallRequest; result?: ToolCallResult }>();
  const agent = new AidenAgent({
    provider: resolved.adapter,
    tools: registry.getSchemas(undefined, 'daemon'),
    toolExecutor: registry.buildExecutor({
      cwd: snapshot.repositoryRoot ?? workspace.canonicalPath,
      paths: resolved.paths,
      sessionId: `worker:${assignment.assignmentId}`,
    }),
    maxTurns: 8,
    iterationBudgetInjection: false,
    providerId: binding.providerId,
    modelId: binding.modelId,
    sessionId: `worker:${assignment.assignmentId}`,
    onToolCall(call, phase, result) {
      const item = calls.get(call.id) ?? { call };
      if (phase === 'after') item.result = result;
      calls.set(call.id, item);
      if (phase === 'after') {
        engine.appendJobEvent({
          jobId: handle.jobId,
          attemptId: handle.attemptId,
          generation: handle.generation,
          type: 'worker.tool_completed',
          payload: { workerRunId: workerRun.workerRunId, toolCallId: call.id, tool: call.name, status: result?.error ? 'failed' : 'completed' },
          producer: 'repository-worker-runtime',
          idempotencyKey: `worker-tool-completed:${workerRun.workerRunId}:${call.id}`,
        });
      }
    },
  });
  const startedAt = Date.now();
  const agentResult = await runWithProviderUsageContext({
    sessionId: `worker:${assignment.assignmentId}`,
    taskId: handle.jobId,
    runId: handle.runId,
    jobId: handle.jobId,
    attemptId: handle.attemptId,
    attemptGeneration: handle.generation,
    entryPoint: 'worker',
    purpose: 'primary',
    providerConfigured: binding.providerId,
    modelConfigured: binding.modelId,
    contextSnapshotId: context.contentDigest,
    toolSchemaSnapshotId: context.toolSchemaDigest,
    coreSchemaCount: READ_ONLY_REPOSITORY_WORKER_TOOLS.length,
    selectedProfile: 'repository-read-worker',
    selectedMode: 'economy',
  }, () => agent.runConversation([
    { role: 'system', content: workerSystemPrompt() },
    {
      role: 'user',
      content: JSON.stringify({
        assignmentId: assignment.assignmentId,
        repositorySnapshotId: assignment.repositorySnapshotId,
        goal: assignment.goal,
        planStepIds: context.planStepIds,
        claimIds: context.claimIds,
        sourceReferenceIds: context.sourceReferenceIds,
        instructionReferenceIds: context.instructionReferenceIds,
        boundedParentNote: context.boundedParentNote,
      }),
    },
  ], {
    stream: false,
    sessionId: `worker:${assignment.assignmentId}`,
    taskId: handle.jobId,
    runId: handle.runId,
    entryPoint: 'worker',
    purpose: 'primary',
    selectedMode: 'economy',
    selectedProfile: 'repository-read-worker',
    signal: handle.signal,
  }));
  if (agentResult.finishReason === 'interrupted') throw new Error('Worker execution was cancelled');
  if (agentResult.finishReason !== 'stop') throw new Error(`Worker provider loop did not complete: ${agentResult.finishReason}`);
  let modelResult: ModelResult;
  try {
    modelResult = parseModelResult(agentResult.finalContent);
  } catch (error) {
    engine.worker.recordWorkerResultFromRun({
      childJobId: handle.jobId,
      childAttemptId: handle.attemptId,
      childGeneration: handle.generation,
      childFenceToken: handle.fenceToken,
      workerResultId: identity('worker_result', { workerRunId, invalid: computeWorkerDigest(agentResult.finalContent) }),
      workerRunId,
      assignmentId: assignment.assignmentId,
      payload: { invalidWorkerResult: true },
      producer: 'repository-worker-runtime',
      idempotencyKey: `worker-result-invalid:${workerRunId}:${computeWorkerDigest(agentResult.finalContent)}`,
    });
    throw error;
  }
  const references = uniqueReferences(modelResult.findings);
  const verifiedReferences = new Map<string, Awaited<ReturnType<typeof verifyWorkerSourceReference>>>();
  try {
    for (const reference of references) {
      verifiedReferences.set(
        JSON.stringify(reference),
        await verifyWorkerSourceReference(engine, assignment.repositorySnapshotId, reference),
      );
    }
  } catch (error) {
    engine.worker.recordWorkerResultFromRun({
      childJobId: handle.jobId,
      childAttemptId: handle.attemptId,
      childGeneration: handle.generation,
      childFenceToken: handle.fenceToken,
      workerResultId: identity('worker_result', {
        workerRunId,
        invalidSources: computeWorkerDigest(agentResult.finalContent),
      }),
      workerRunId,
      assignmentId: assignment.assignmentId,
      payload: { invalidWorkerResult: true },
      producer: 'repository-worker-runtime',
      idempotencyKey: `worker-result-invalid-sources:${workerRunId}:${computeWorkerDigest(agentResult.finalContent)}`,
    });
    throw error;
  }
  const evidenceByReference = new Map<string, string>();
  for (const reference of references) {
    const verified = verifiedReferences.get(JSON.stringify(reference));
    if (!verified) throw new Error('Verified Worker source reference is unavailable');
    const evidence = engine.proof.recordEvidence({
      jobId: handle.jobId,
      attemptId: handle.attemptId,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      repositorySnapshotId: assignment.repositorySnapshotId,
      source: 'repository_worker_readback',
      producer: 'repository-worker-runtime',
      observedAt: Date.now(),
      coverage: 'full',
      verificationResult: 'verified',
      payload: {
        assignmentId: assignment.assignmentId,
        workerRunId: workerRun.workerRunId,
        sourceReference: reference,
        lineContent: verified.lineContent,
      },
    });
    evidenceByReference.set(JSON.stringify(reference), evidence.evidenceId);
    engine.appendJobEvent({
      jobId: handle.jobId,
      attemptId: handle.attemptId,
      generation: handle.generation,
      type: 'worker.child_evidence_recorded',
      payload: { workerRunId: workerRun.workerRunId, evidenceId: evidence.evidenceId, path: reference.path },
      producer: 'repository-worker-runtime',
      idempotencyKey: `worker-child-evidence:${workerRun.workerRunId}:${computeWorkerDigest(reference)}`,
    });
  }
  const completedAt = Date.now();
  const providerAttemptIds = currentProviderAttemptLedger()?.query({
    jobId: handle.jobId,
    attemptId: handle.attemptId,
  }).map((attempt) => attempt.callId) ?? [];
  const commandsExecuted = [...calls.values()].map(({ call, result }) => ({
    toolCallId: call.id,
    tool: call.name,
    inputHash: computeWorkerDigest(call.arguments),
    status: result?.error ? 'failed' : result ? 'completed' : 'unknown',
  }));
  const payload: WorkerResultPayloadV1 = {
    schemaVersion: 1,
    status: modelResult.status,
    summary: modelResult.summary,
    findings: modelResult.findings.map((finding) => ({
      ...finding,
      evidenceIds: finding.sourceReferences.map((reference) => evidenceByReference.get(JSON.stringify(reference))!).filter(Boolean),
    })),
    sourceReferences: references,
    filesInspected: [...new Map(references.map((reference) => [reference.path, {
      snapshotEntryId: reference.snapshotEntryId,
      path: reference.path,
      contentHash: reference.contentHash,
    }])).values()],
    commandsExecuted,
    diagnostics: [],
    evidenceIds: [...evidenceByReference.values()],
    unresolvedQuestions: modelResult.unresolvedQuestions,
    uncertainty: modelResult.uncertainty,
    providerAttemptIds,
    budgetUsage: engine.resources.getBudgets(handle.jobId).map((budget) => ({
      kind: budget.kind,
      amount: budget.hasUnknownUsage ? null : budget.used,
      ...(budget.hasUnknownUsage ? { unknownReason: 'provider usage was not fully reported' } : {}),
    })),
    timing: { startedAt, completedAt, wallClockMs: Math.max(0, completedAt - startedAt) },
    failure: modelResult.status === 'failed' || modelResult.status === 'blocked'
      ? {
        category: modelResult.status === 'blocked' ? 'validation' : 'unknown',
        code: modelResult.status,
        message: modelResult.summary,
        retryable: false,
        externalOutcomeUnknown: false,
      }
      : null,
    inputHash: assignment.inputHash,
    resultHash: '',
  };
  payload.resultHash = computeWorkerResultHash(payload);
  const workerResult = engine.worker.recordWorkerResultFromRun({
    childJobId: handle.jobId,
    childAttemptId: handle.attemptId,
    childGeneration: handle.generation,
    childFenceToken: handle.fenceToken,
    workerResultId: identity('worker_result', { workerRunId, resultHash: payload.resultHash }),
    workerRunId,
    assignmentId: assignment.assignmentId,
    payload,
    producer: 'repository-worker-runtime',
    idempotencyKey: `worker-result:${workerRunId}:${payload.resultHash}`,
  });
  if (workerResult.acceptanceState !== 'accepted') {
    throw new Error(`Worker result was rejected: ${workerResult.rejectionCode ?? 'unknown'}`);
  }
  const childRecorded = engine.recordChildResult({
    childJobId: handle.jobId,
    attemptId: handle.attemptId,
    generation: handle.generation,
    fenceToken: handle.fenceToken,
    status: workerResult.status,
    evidence: { workerResultId: workerResult.workerResultId, summary: workerResult.summary },
    evidenceHandles: workerResult.evidenceIds,
    producer: 'repository-worker-runtime',
    idempotencyKey: `worker-child-result:${workerResult.workerResultId}`,
  });
  if (!childRecorded.applied && !childRecorded.duplicate) throw new Error('Worker child result could not be recorded');
  const finalization: DurableJobDisposition = workerResult.status === 'completed'
    ? { status: 'completed', outcome: 'worker_completed', finishReason: 'stop', evidence: { workerResultId: workerResult.workerResultId } }
    : workerResult.status === 'failed'
      ? { status: 'failed', outcome: 'worker_failed', finishReason: 'error', evidence: { workerResultId: workerResult.workerResultId } }
      : workerResult.status === 'blocked'
        ? { status: 'blocked', outcome: 'worker_blocked', finishReason: 'blocked', evidence: { workerResultId: workerResult.workerResultId } }
        : { status: 'unknown', outcome: 'worker_partial', finishReason: 'verification_incomplete', evidence: { workerResultId: workerResult.workerResultId } };
  return {
    workerRun,
    workerResult,
    finalization,
    totalTokens: agentResult.totalUsage.inputTokens + agentResult.totalUsage.outputTokens,
  };
}

export async function verifyReadOnlyRepositoryWorkerResult(
  input: VerifyReadOnlyRepositoryWorkerResultInput,
): Promise<{ claims: ReturnType<JobEngine['proof']['listClaims']>; evidence: ReturnType<JobEngine['proof']['listEvidence']> }> {
  const producer = input.producer ?? 'repository-worker-parent-verifier';
  const result = input.engine.worker.getWorkerResult(input.workerResultId);
  if (!result || result.acceptanceState !== 'accepted' || !result.payload) {
    throw new Error('Accepted Worker result was not found');
  }
  const run = input.engine.worker.getWorkerRun(result.workerRunId);
  const assignment = input.engine.worker.getWorkerAssignment(result.assignmentId);
  const context = assignment ? input.engine.worker.getWorkerContextEnvelope(assignment.contextEnvelopeId) : null;
  if (!run || !assignment || !context || assignment.parentJobId !== input.parent.jobId
    || assignment.parentAttemptId !== input.parent.attemptId
    || assignment.parentGeneration !== input.parent.generation
    || !assignment.repositorySnapshotId) {
    throw new Error('Worker result does not belong to the parent verification authority');
  }
  const parent = input.engine.getJob(input.parent.jobId);
  const attempt = input.engine.getAttempt(input.parent.attemptId);
  if (!parent || parent.activeAttemptId !== input.parent.attemptId
    || attempt?.generation !== input.parent.generation || attempt.fenceToken !== input.parent.fenceToken) {
    throw new Error('Parent verification authority is no longer active');
  }
  input.engine.appendJobEvent({
    jobId: input.parent.jobId,
    attemptId: input.parent.attemptId,
    generation: input.parent.generation,
    type: 'worker.parent_verification_started',
    payload: { workerResultId: result.workerResultId },
    producer,
    idempotencyKey: `${input.idempotencyKey}:started`,
  });
  const claims = context.claimIds.map((claimId) => input.engine.proof.listClaims(input.parent.jobId)
    .find((claim) => claim.claimId === claimId));
  if (claims.some((claim) => !claim)) throw new Error('Worker context Claim reference is unavailable');
  const verifiedClaims: Array<{
    claim: NonNullable<(typeof claims)[number]>;
    sources: Array<{
      reference: WorkerResultSourceReference;
      lineContent: string;
      verificationKey: string;
    }>;
  }> = [];
  let verificationSubject: {
    claim: NonNullable<(typeof claims)[number]>;
    reference: WorkerResultSourceReference;
    verificationKey: string;
  } | null = null;
  try {
    for (const claim of claims) {
      if (!claim || claim.repositorySnapshotId !== assignment.repositorySnapshotId
        || claim.sourceReferences.length === 0) {
        throw new Error('Parent verification requires a source-bound pre-existing Claim');
      }
      const sources: Array<{
        reference: WorkerResultSourceReference;
        lineContent: string;
        verificationKey: string;
      }> = [];
      for (const claimReference of claim.sourceReferences) {
        const workerReference = result.payload.sourceReferences.find((reference) => (
          reference.snapshotId === claimReference.snapshotId
          && reference.path === claimReference.path
          && reference.startLine === claimReference.lineStart
          && reference.endLine === claimReference.lineEnd
        ));
        if (!workerReference) throw new Error('Worker result does not support the parent Claim source reference');
        const verificationKey = `${input.idempotencyKey}:${claim.claimId}:${computeWorkerDigest(workerReference)}`;
        verificationSubject = { claim, reference: workerReference, verificationKey };
        const verified = await verifyWorkerSourceReference(input.engine, assignment.repositorySnapshotId, workerReference);
        sources.push({ reference: workerReference, lineContent: verified.lineContent, verificationKey });
        verificationSubject = null;
      }
      verifiedClaims.push({ claim, sources });
    }
  } catch (error) {
    if (verificationSubject) {
      const { claim, reference, verificationKey } = verificationSubject;
      const existing = input.engine.proof.listEvidence(input.parent.jobId).find((evidence) => (
        evidence.source === 'repository_readback'
        && record(evidence.payload)?.verificationKey === verificationKey
      ));
      const evidence = existing ?? input.engine.proof.recordEvidence({
        jobId: input.parent.jobId,
        attemptId: input.parent.attemptId,
        generation: input.parent.generation,
        fenceToken: input.parent.fenceToken,
        repositorySnapshotId: assignment.repositorySnapshotId,
        source: 'repository_readback',
        producer,
        observedAt: Date.now(),
        coverage: 'unknown',
        verificationResult: 'failed',
        payload: {
          verificationKey,
          workerResultId: result.workerResultId,
          claimId: claim.claimId,
          sourceReference: reference,
          failureCode: 'source_readback_failed',
        },
      });
      if (claim.state !== 'failed') {
        input.engine.proof.checkClaim({
          claimId: claim.claimId,
          attemptId: input.parent.attemptId,
          generation: input.parent.generation,
          evidenceIds: [evidence.evidenceId],
          state: 'failed',
        });
      }
      input.engine.appendJobEvent({
        jobId: input.parent.jobId,
        attemptId: input.parent.attemptId,
        generation: input.parent.generation,
        type: 'worker.parent_verification_failed',
        payload: { workerResultId: result.workerResultId, claimId: claim.claimId, evidenceId: evidence.evidenceId },
        producer,
        idempotencyKey: `${input.idempotencyKey}:failed`,
      });
    }
    throw error;
  }
  const parentEvidence = [] as ReturnType<JobEngine['proof']['listEvidence']>;
  for (const { claim, sources } of verifiedClaims) {
    const evidenceIds: string[] = [];
    for (const { reference: workerReference, lineContent, verificationKey } of sources) {
      const existing = input.engine.proof.listEvidence(input.parent.jobId).find((evidence) => (
        evidence.source === 'repository_readback'
        && record(evidence.payload)?.verificationKey === verificationKey
      ));
      const evidence = existing ?? input.engine.proof.recordEvidence({
        jobId: input.parent.jobId,
        attemptId: input.parent.attemptId,
        generation: input.parent.generation,
        fenceToken: input.parent.fenceToken,
        repositorySnapshotId: assignment.repositorySnapshotId,
        source: 'repository_readback',
        producer,
        observedAt: Date.now(),
        coverage: 'full',
        verificationResult: 'verified',
        payload: {
          verificationKey,
          workerResultId: result.workerResultId,
          claimId: claim.claimId,
          sourceReference: workerReference,
          lineContent,
        },
      });
      evidenceIds.push(evidence.evidenceId);
      if (!parentEvidence.some((item) => item.evidenceId === evidence.evidenceId)) parentEvidence.push(evidence);
    }
    if (claim.state !== 'verified') {
      input.engine.proof.checkClaim({
        claimId: claim.claimId,
        attemptId: input.parent.attemptId,
        generation: input.parent.generation,
        evidenceIds,
        state: 'verified',
      });
    }
  }
  for (const nodeId of context.planStepIds) {
    if (!input.engine.graph.nodes(input.parent.jobId).some((node) => (
      node.nodeId === nodeId && node.kind === 'coding_step'
    ))) continue;
    const referenceUpdate = input.engine.graph.addNodeReferences({
      jobId: input.parent.jobId,
      attemptId: input.parent.attemptId,
      generation: input.parent.generation,
      fenceToken: input.parent.fenceToken,
      nodeId,
      references: parentEvidence.map((evidence) => ({ kind: 'evidence' as const, id: evidence.evidenceId })),
      producer,
      idempotencyKey: `${input.idempotencyKey}:graph-evidence:${nodeId}`,
    });
    if (!referenceUpdate.applied && !referenceUpdate.duplicate) {
      throw new Error('Parent verification Evidence could not be linked to the execution graph');
    }
  }
  input.engine.appendJobEvent({
    jobId: input.parent.jobId,
    attemptId: input.parent.attemptId,
    generation: input.parent.generation,
    type: 'worker.parent_verification_completed',
    payload: {
      workerResultId: result.workerResultId,
      evidenceIds: parentEvidence.map((evidence) => evidence.evidenceId),
      claimIds: verifiedClaims.map(({ claim }) => claim.claimId),
    },
    producer,
    idempotencyKey: `${input.idempotencyKey}:completed`,
  });
  return {
    claims: input.engine.proof.listClaims(input.parent.jobId).filter((claim) => context.claimIds.includes(claim.claimId)),
    evidence: parentEvidence,
  };
}
