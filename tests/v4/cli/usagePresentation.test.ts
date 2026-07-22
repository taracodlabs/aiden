import { describe, expect, it } from 'vitest';

import {
  formatUsageDetails,
  formatUsageSummary,
  type UsagePresentation,
} from '../../../cli/v4/commands/usage';
import type {
  ProviderAttemptPurpose,
  ProviderAttemptRecord,
  ProviderUsageProjection,
} from '../../../core/v4/usageLedger';

const stringWidth: (value: string) => number = require('string-width');

function projection(overrides: Partial<ProviderUsageProjection> = {}): ProviderUsageProjection {
  return {
    physicalAttempts: 3,
    successfulAttempts: 3,
    failedAttempts: 0,
    estimatedInputTokens: 30_000,
    estimatedOutputTokens: 600,
    estimatedSchemaTokens: 21_900,
    estimatedImageTokens: 0,
    providerInputTokens: 26_300,
    providerOutputTokens: 179,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 300,
    reasoningTokens: 13,
    requestBytes: 5_000,
    responseBytes: 1_000,
    rawToolResultBytes: 9_100,
    transmittedToolResultBytes: 2_800,
    memoryTokens: 900,
    userProfileTokens: 400,
    projectMemoryTokens: 300,
    skillIndexTokens: 4_100,
    loadedSkillTokens: 3_000,
    coreSchemaCount: 61,
    mcpSchemaCount: 29,
    pluginSchemaCount: 4,
    deferredSchemaCount: 127,
    knownCostAmount: 0,
    costCurrency: null,
    unknownCostAttempts: 3,
    providerReportedAttempts: 2,
    estimatedAttempts: 1,
    ...overrides,
  };
}

function record(overrides: Partial<ProviderAttemptRecord> = {}): ProviderAttemptRecord {
  return {
    callId: 'call-1',
    parentCallId: null,
    sessionId: 'session-1',
    taskId: null,
    runId: null,
    entryPoint: 'cli',
    purpose: 'primary',
    providerConfigured: 'groq',
    providerActual: 'groq',
    modelConfigured: 'model-a',
    modelActual: 'model-a',
    apiMode: 'chat_completions',
    transport: 'https',
    attemptIndex: 0,
    fallbackIndex: 0,
    credentialLabelRedacted: 'configured',
    status: 'success',
    errorClass: null,
    startedAt: 1,
    completedAt: 2,
    estimatedInputTokens: 100,
    estimatedOutputTokens: 10,
    estimatedSchemaTokens: 20,
    estimatedImageTokens: 0,
    providerInputTokens: 90,
    providerOutputTokens: 8,
    providerCacheReadTokens: 0,
    providerCacheWriteTokens: 0,
    providerReasoningTokens: 0,
    requestBytes: 100,
    responseBytes: 20,
    usageSource: 'provider_reported',
    costAmount: null,
    costCurrency: null,
    costStatus: 'unknown',
    costSource: null,
    contextSnapshotId: null,
    toolSchemaSnapshotId: null,
    coreSchemaCount: 1,
    mcpSchemaCount: 0,
    pluginSchemaCount: 0,
    deferredSchemaCount: 0,
    serializedSchemaBytes: 20,
    selectedProfile: 'balanced',
    selectedMode: 'balanced',
    rawToolResultBytes: 0,
    transmittedToolResultBytes: 0,
    memoryTokens: 0,
    userProfileTokens: 0,
    projectMemoryTokens: 0,
    skillIndexTokens: 0,
    loadedSkillTokens: 0,
    ...overrides,
  };
}

function presentation(): UsagePresentation {
  const empty = projection({
    physicalAttempts: 0,
    successfulAttempts: 0,
    failedAttempts: 0,
    unknownCostAttempts: 0,
    providerReportedAttempts: 0,
    estimatedAttempts: 0,
  });
  const byPurpose: Partial<Record<ProviderAttemptPurpose, ProviderUsageProjection>> = {
    primary: projection({ physicalAttempts: 1, successfulAttempts: 1 }),
    retry: projection({ physicalAttempts: 1, successfulAttempts: 1 }),
    fallback: projection({ physicalAttempts: 1, successfulAttempts: 1 }),
    auxiliary: empty,
    subagent: empty,
    aggregation: empty,
    compression: empty,
  };
  const records = [
    record(),
    record({ callId: 'call-2', providerActual: 'together', modelActual: 'model-b', purpose: 'retry' }),
  ];
  return {
    providerId: 'groq',
    modelId: 'model-a',
    total: projection(),
    byPurpose,
    providers: [
      { provider: 'groq', model: 'model-a', projection: projection({ physicalAttempts: 1 }) },
      { provider: 'together', model: 'model-b', projection: projection({ physicalAttempts: 2 }) },
    ],
    records,
  };
}

describe('human usage presentation', () => {
  it('renders a concise honest summary without treating unknown cost as zero', () => {
    const output = formatUsageSummary(presentation(), 100);
    expect(output).toContain('Usage — Current session');
    expect(output).toContain('groq -> together');
    expect(output).toContain('Tokens (mixed)');
    expect(output).toContain('cumulative exposures');
    expect(output).toContain('127 deferred');
    expect(output).toContain('Unknown for 3 calls');
    expect(output).not.toContain('0.0000');
    expect(output).toContain('Retries');
    expect(output).toContain('Fallback attempts');
    expect(output).not.toContain('Auxiliary calls');
  });

  it('keeps every summary line within a narrow terminal width', () => {
    const output = formatUsageSummary(presentation(), 44);
    for (const line of output.trimEnd().split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(44);
    }
  });

  it('renders provider, model, purpose, cache, context, and cost details', () => {
    const output = formatUsageDetails(presentation(), 80);
    expect(output).toContain('Usage details — Current session');
    expect(output).toContain('Providers and models');
    expect(output).toContain('groq:');
    expect(output).toContain('model-a');
    expect(output).toContain('Purposes');
    expect(output).toContain('primary');
    expect(output).toContain('retry');
    expect(output).toContain('provider-reported');
    expect(output).toContain('locally estimated');
    expect(output).toContain('Cache');
    expect(output).toContain('Tool results');
    expect(output).toContain('cumulative exposures');
    expect(output).toContain('Unknown for 3 calls');
  });

  it('keeps detailed output readable at 44 columns', () => {
    const output = formatUsageDetails(presentation(), 44);
    for (const line of output.trimEnd().split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(44);
    }
  });

  it('labels fully estimated usage without claiming provider reporting', () => {
    const input = presentation();
    input.total = projection({
      providerReportedAttempts: 0,
      estimatedAttempts: 3,
      providerInputTokens: 0,
      providerOutputTokens: 0,
    });
    const output = formatUsageSummary(input, 80);
    expect(output).toContain('Tokens (estimated)');
    expect(output).toContain('30K input');
  });
});
