import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  ProviderAttemptLedger,
  type ProviderAttemptRecord,
  type ProviderAttemptStatus,
  type ProviderUsageSource,
} from '../../core/v4/usageLedger';
import { findModel } from './modelCatalog';
import { classifyProviderError, ProviderError, ProviderTimeoutError } from './errors';
import type {
  ApiMode,
  ProviderCallInput,
  ProviderCallOutput,
  ProviderCallUsageContext,
} from './types';

export interface PhysicalAttemptMetadata {
  providerActual: string;
  modelActual: string;
  apiMode: ApiMode;
  transport: string;
  attemptIndex: number;
  fallbackIndex?: number;
  logicalCallId: string;
  requestBytes: number | null;
}

export interface AttemptFailureOptions {
  sent: boolean;
  responseBytes?: number | null;
  status?: ProviderAttemptStatus;
}

export interface PhysicalAttemptLifecycle {
  readonly callId: string;
  success(output: ProviderCallOutput, responseBytes?: number | null): void;
  failure(error: unknown, options: AttemptFailureOptions): void;
}

export class ProviderAttemptBudgetExceededError extends Error {
  constructor(readonly budgetLabel: string, message: string) {
    super(message);
    this.name = 'ProviderAttemptBudgetExceededError';
  }
}

let configuredLedger: ProviderAttemptLedger | null = null;
let configuredLedgerPath: string | null = null;
const usageContextStorage = new AsyncLocalStorage<ProviderCallUsageContext>();

/** Configure the process-wide leaf-adapter sink used by all v4 adapters. */
export function configureProviderAttemptLedger(dbPath: string | null): void {
  if (dbPath === configuredLedgerPath) return;
  try {
    configuredLedger?.close();
  } catch {
    // Best-effort replacement; an accounting sink is reopened below.
  }
  configuredLedger = dbPath ? new ProviderAttemptLedger(dbPath) : null;
  configuredLedgerPath = dbPath;
}

/** Test/embedded-runtime seam that avoids any global path discovery. */
export function setProviderAttemptLedger(ledger: ProviderAttemptLedger | null): void {
  configuredLedger = ledger;
  configuredLedgerPath = null;
}

export function currentProviderAttemptLedger(): ProviderAttemptLedger | null {
  return configuredLedger;
}

/**
 * Scope setup/readiness accounting without leaking a SQLite handle into the
 * caller. An already-configured runtime ledger for the same path is reused;
 * otherwise the prior process-wide authority is restored after the operation.
 */
export async function runWithProviderAttemptLedger<T>(
  dbPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (configuredLedger && configuredLedgerPath === dbPath) return operation();
  const previousLedger = configuredLedger;
  const previousPath = configuredLedgerPath;
  const scopedLedger = new ProviderAttemptLedger(dbPath);
  configuredLedger = scopedLedger;
  configuredLedgerPath = dbPath;
  try {
    return await operation();
  } finally {
    configuredLedger = previousLedger;
    configuredLedgerPath = previousPath;
    scopedLedger.close();
  }
}

export function runWithProviderUsageContext<T>(
  context: ProviderCallUsageContext,
  fn: () => T,
): T {
  return usageContextStorage.run(context, fn);
}

export function createLogicalProviderCallId(): string {
  return randomUUID();
}

export function beginPhysicalProviderAttempt(
  input: ProviderCallInput,
  metadata: PhysicalAttemptMetadata,
): PhysicalAttemptLifecycle {
  const estimates = estimateRequest(input);
  claimAttemptBudgets(
    input.usageContext?.attemptBudgets ?? usageContextStorage.getStore()?.attemptBudgets,
    estimates.input + Math.max(0, input.maxTokens ?? 0),
  );
  const callId = randomUUID();
  const startedAt = Date.now();
  let settled = false;

  const settle = (
    status: ProviderAttemptStatus,
    output: ProviderCallOutput | null,
    error: unknown,
    responseBytes: number | null,
  ): void => {
    if (settled) return;
    settled = true;
    const ledger = configuredLedger;
    if (!ledger) return;

    const providerUsage = output?.usage;
    const hasProviderUsage = !!providerUsage && (
      providerUsage.inputTokens > 0
      || providerUsage.outputTokens > 0
      || providerUsage.cacheReadTokens !== undefined
      || providerUsage.cacheWriteTokens !== undefined
      || providerUsage.reasoningTokens !== undefined
    );
    const usageSource: ProviderUsageSource = output
      ? (hasProviderUsage ? 'provider_reported' : 'locally_estimated')
      : (metadata.requestBytes !== null ? 'locally_estimated' : 'unknown');
    const context = {
      ...(usageContextStorage.getStore() ?? {}),
      ...(input.usageContext ?? {}),
    };
    const cost = projectCost(
      metadata.providerActual,
      metadata.modelActual,
      providerUsage?.inputTokens ?? (usageSource === 'locally_estimated' ? estimates.input : null),
      providerUsage?.outputTokens ?? null,
    );
    const record: ProviderAttemptRecord = {
      callId,
      parentCallId: metadata.logicalCallId,
      sessionId: context?.sessionId ?? null,
      taskId: context?.taskId ?? null,
      runId: context?.runId === undefined || context.runId === null
        ? null
        : String(context.runId),
      entryPoint: context?.entryPoint ?? 'unknown',
      purpose: effectivePurpose(context, metadata.attemptIndex, metadata.fallbackIndex ?? 0),
      providerConfigured: context?.providerConfigured ?? metadata.providerActual,
      providerActual: metadata.providerActual,
      modelConfigured: context?.modelConfigured ?? metadata.modelActual,
      modelActual: metadata.modelActual,
      apiMode: metadata.apiMode,
      transport: metadata.transport,
      attemptIndex: metadata.attemptIndex,
      fallbackIndex: metadata.fallbackIndex ?? context?.fallbackIndex ?? 0,
      credentialLabelRedacted: context?.credentialLabelRedacted ?? 'configured',
      status,
      errorClass: classifyAttemptError(error),
      startedAt,
      completedAt: Date.now(),
      estimatedInputTokens: estimates.input,
      estimatedOutputTokens: input.maxTokens ?? null,
      estimatedSchemaTokens: estimates.schema,
      estimatedImageTokens: estimates.images,
      providerInputTokens: providerUsage?.inputTokens ?? null,
      providerOutputTokens: providerUsage?.outputTokens ?? null,
      providerCacheReadTokens: providerUsage?.cacheReadTokens ?? null,
      providerCacheWriteTokens: providerUsage?.cacheWriteTokens ?? null,
      providerReasoningTokens: providerUsage?.reasoningTokens ?? null,
      requestBytes: metadata.requestBytes,
      responseBytes,
      usageSource,
      costAmount: cost.amount,
      costCurrency: cost.currency,
      costStatus: cost.status,
      costSource: cost.source,
      contextSnapshotId: context?.contextSnapshotId ?? null,
      toolSchemaSnapshotId: context?.toolSchemaSnapshotId ?? null,
      coreSchemaCount: context?.coreSchemaCount ?? input.tools.length,
      mcpSchemaCount: context?.mcpSchemaCount ?? null,
      pluginSchemaCount: context?.pluginSchemaCount ?? null,
      deferredSchemaCount: context?.deferredSchemaCount ?? null,
      serializedSchemaBytes: estimates.schemaBytes,
      selectedProfile: context?.selectedProfile ?? null,
      selectedMode: context?.selectedMode ?? null,
      rawToolResultBytes: context?.rawToolResultBytes ?? null,
      transmittedToolResultBytes: context?.transmittedToolResultBytes ?? null,
      memoryTokens: context?.memoryTokens ?? null,
      userProfileTokens: context?.userProfileTokens ?? null,
      projectMemoryTokens: context?.projectMemoryTokens ?? null,
      skillIndexTokens: context?.skillIndexTokens ?? null,
      loadedSkillTokens: context?.loadedSkillTokens ?? null,
    };
    try {
      ledger.append(record);
    } catch (ledgerError) {
      // Provider execution must not be converted into a user-visible failure by
      // an accounting disk fault. Keep the diagnostic free of request data.
      if (process.env.AIDEN_USAGE_DIAGNOSTICS === '1') {
        const message = ledgerError instanceof Error ? ledgerError.message : 'unknown ledger error';
        process.stderr.write(`[usage-ledger] append failed: ${message}\n`);
      }
    }
  };

  return {
    callId,
    success(output, responseBytes = null): void {
      settle('success', output, null, responseBytes);
    },
    failure(error, options): void {
      settle(
        options.status ?? classifyAttemptStatus(error, options.sent),
        null,
        error,
        options.responseBytes ?? null,
      );
    },
  };
}

function claimAttemptBudgets(
  budgets: import('./types').ProviderAttemptBudget[] | undefined,
  estimatedTokens: number,
): void {
  if (!budgets || budgets.length === 0) return;
  for (const budget of budgets) {
    if (budget.maxAttempts !== undefined && budget.usedAttempts + 1 > budget.maxAttempts) {
      throw new ProviderAttemptBudgetExceededError(
        budget.label,
        `${budget.label} provider-attempt limit reached (${budget.usedAttempts}/${budget.maxAttempts}).`,
      );
    }
    if (
      budget.maxEstimatedTokens !== undefined
      && budget.usedEstimatedTokens + estimatedTokens > budget.maxEstimatedTokens
    ) {
      throw new ProviderAttemptBudgetExceededError(
        budget.label,
        `${budget.label} estimated-token limit would be exceeded.`,
      );
    }
  }
  for (const budget of budgets) {
    budget.usedAttempts += 1;
    budget.usedEstimatedTokens += estimatedTokens;
  }
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function estimateRequest(input: ProviderCallInput): {
  input: number;
  schema: number;
  images: number;
  schemaBytes: number;
} {
  const messageText = input.messages.map((message) => {
    const images = message.role === 'user' && message.images
      ? message.images.map((image) => image.length).join(':')
      : '';
    return `${message.role}:${message.content}:${images}`;
  }).join('\n');
  const schemaText = safeJson(input.tools);
  const imageBytes = input.messages.reduce((total, message) => (
    total + (message.role === 'user'
      ? (message.images ?? []).reduce((sum, image) => sum + image.length, 0)
      : 0)
  ), 0);
  return {
    input: Math.ceil(messageText.length / 4),
    schema: Math.ceil(schemaText.length / 4),
    images: imageBytes > 0 ? Math.ceil(imageBytes / 4) : 0,
    schemaBytes: byteLength(schemaText),
  };
}

function effectivePurpose(
  context: ProviderCallUsageContext | undefined,
  attemptIndex: number,
  fallbackIndex: number,
): NonNullable<ProviderCallUsageContext['purpose']> {
  if (fallbackIndex > 0) return 'fallback';
  if (attemptIndex > 0) return 'retry';
  return context?.purpose ?? 'primary';
}

function projectCost(
  provider: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): {
  amount: number | null;
  currency: string | null;
  status: 'estimated' | 'included' | 'unknown';
  source: string | null;
} {
  const entry = findModel(provider, model);
  if (!entry?.pricing || inputTokens === null || outputTokens === null) {
    return { amount: null, currency: null, status: 'unknown', source: null };
  }
  return {
    amount: (inputTokens * entry.pricing.inputPerM + outputTokens * entry.pricing.outputPerM) / 1_000_000,
    currency: 'USD',
    status: 'estimated',
    source: 'model_catalog',
  };
}

function classifyAttemptStatus(error: unknown, sent: boolean): ProviderAttemptStatus {
  if (error instanceof ProviderTimeoutError) return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'interrupted';
  if (error instanceof ProviderError) {
    return error.statusCode === undefined
      ? (sent ? 'failed_after_send' : 'failed_before_send')
      : 'provider_error';
  }
  return sent ? 'failed_after_send' : 'failed_before_send';
}

function classifyAttemptError(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ProviderTimeoutError) return 'timeout';
  if (error instanceof ProviderError) {
    const classified = classifyProviderError(error);
    if (classified === 'rate_limit') return 'rate_limit';
    if (classified === 'context_overflow') return 'context_overflow';
    if (classified === 'request_size_limit') return 'request_size_limit';
    if (error.statusCode === 401 || error.statusCode === 403) return 'authentication';
    if (error.statusCode !== undefined) return `http_${error.statusCode}`;
    return error.retryable ? 'transport' : 'provider';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'interrupted';
  return error instanceof Error ? error.name || 'error' : 'unknown';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
