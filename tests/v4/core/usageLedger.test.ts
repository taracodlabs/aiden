import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  ProviderAttemptLedger,
  type ProviderAttemptRecord,
} from '../../../core/v4/usageLedger';
import { createLedgerDailyBudgetTracker } from '../../../core/v4/daemon/dispatcher/dailyBudgetTracker';

let tmpDir: string;
let dbPath: string;
let ledger: ProviderAttemptLedger;

function attempt(
  overrides: Partial<ProviderAttemptRecord> = {},
): ProviderAttemptRecord {
  return {
    callId: 'call-primary-1',
    parentCallId: null,
    sessionId: 'session-1',
    taskId: 'task-1',
    runId: 'run-1',
    entryPoint: 'cli',
    purpose: 'primary',
    providerConfigured: 'hosted-provider',
    providerActual: 'hosted-provider',
    modelConfigured: 'model-a',
    modelActual: 'model-a',
    apiMode: 'chat_completions',
    transport: 'https',
    attemptIndex: 0,
    fallbackIndex: 0,
    credentialLabelRedacted: 'managed:configured',
    status: 'success',
    errorClass: null,
    startedAt: 1_000,
    completedAt: 1_250,
    estimatedInputTokens: 90,
    estimatedOutputTokens: 20,
    estimatedSchemaTokens: 10,
    estimatedImageTokens: 0,
    providerInputTokens: 100,
    providerOutputTokens: 15,
    providerCacheReadTokens: 40,
    providerCacheWriteTokens: 5,
    providerReasoningTokens: 3,
    requestBytes: 800,
    responseBytes: 220,
    usageSource: 'provider_reported',
    costAmount: 0.0025,
    costCurrency: 'USD',
    costStatus: 'estimated',
    costSource: 'catalog',
    contextSnapshotId: 'context-1',
    toolSchemaSnapshotId: 'schema-1',
    coreSchemaCount: 4,
    mcpSchemaCount: 2,
    pluginSchemaCount: 1,
    deferredSchemaCount: 3,
    serializedSchemaBytes: 400,
    selectedProfile: 'standard',
    selectedMode: 'balanced',
    rawToolResultBytes: 0,
    transmittedToolResultBytes: 0,
    memoryTokens: 12,
    userProfileTokens: 4,
    projectMemoryTokens: 8,
    skillIndexTokens: 15,
    loadedSkillTokens: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-usage-ledger-'));
  dbPath = path.join(tmpDir, 'sessions.db');
  ledger = new ProviderAttemptLedger(dbPath);
});

afterEach(async () => {
  try {
    ledger.close();
  } catch {
    // already closed
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('ProviderAttemptLedger', () => {
  it('persists one immutable successful physical attempt across restart', () => {
    ledger.append(attempt());
    ledger.close();

    ledger = new ProviderAttemptLedger(dbPath);
    const records = ledger.query({ callId: 'call-primary-1' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      providerInputTokens: 100,
      providerOutputTokens: 15,
      providerCacheReadTokens: 40,
      providerCacheWriteTokens: 5,
      providerReasoningTokens: 3,
      status: 'success',
    });
    expect(Object.isFrozen(records[0])).toBe(true);
  });

  it('keeps failed attempts and unknown spend explicit instead of recording zero', () => {
    ledger.append(attempt({
      callId: 'call-failed-1',
      status: 'failed_after_send',
      errorClass: 'network',
      providerInputTokens: null,
      providerOutputTokens: null,
      providerCacheReadTokens: null,
      providerCacheWriteTokens: null,
      providerReasoningTokens: null,
      costAmount: null,
      costCurrency: null,
      costStatus: 'unknown',
      costSource: null,
      usageSource: 'unknown',
    }));

    const [record] = ledger.query({ status: 'failed_after_send' });
    expect(record.providerInputTokens).toBeNull();
    expect(record.costAmount).toBeNull();
    expect(record.costStatus).toBe('unknown');
  });

  it('queries by session, run, task, parent, provider, purpose, and status', () => {
    ledger.append(attempt());
    ledger.append(attempt({
      callId: 'call-retry-2',
      parentCallId: 'call-primary-1',
      purpose: 'retry',
      attemptIndex: 1,
      status: 'timeout',
      providerActual: 'fallback-provider',
      modelActual: 'model-b',
    }));

    expect(ledger.query({ sessionId: 'session-1' })).toHaveLength(2);
    expect(ledger.query({ runId: 'run-1' })).toHaveLength(2);
    expect(ledger.query({ taskId: 'task-1' })).toHaveLength(2);
    expect(ledger.query({ parentCallId: 'call-primary-1' })).toHaveLength(1);
    expect(ledger.query({ provider: 'fallback-provider' })).toHaveLength(1);
    expect(ledger.query({ model: 'model-b' })).toHaveLength(1);
    expect(ledger.query({ purpose: 'retry' })).toHaveLength(1);
    expect(ledger.query({ status: 'timeout' })).toHaveLength(1);
  });

  it('projects provider totals without mixing setup/readiness into task totals', () => {
    ledger.append(attempt());
    ledger.append(attempt({
      callId: 'call-ready-1',
      purpose: 'readiness',
      providerInputTokens: 25,
      providerOutputTokens: 2,
      costAmount: null,
      costCurrency: null,
      costStatus: 'unknown',
      costSource: null,
    }));

    const task = ledger.project({ sessionId: 'session-1' });
    const all = ledger.project({ sessionId: 'session-1', includeSetup: true });

    expect(task).toMatchObject({
      physicalAttempts: 1,
      providerInputTokens: 100,
      providerOutputTokens: 15,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      reasoningTokens: 3,
    });
    expect(all.physicalAttempts).toBe(2);
    expect(all.providerInputTokens).toBe(125);
  });

  it('is append-only for a call id', () => {
    ledger.append(attempt());
    expect(() => ledger.append(attempt({ providerOutputTokens: 99 }))).toThrow();
    expect(ledger.query({ callId: 'call-primary-1' })).toHaveLength(1);
  });

  it('migrates an existing version-one ledger and remains writable after restart', () => {
    ledger.close();
    const legacy = new Database(dbPath);
    for (const column of [
      'memory_tokens',
      'user_profile_tokens',
      'project_memory_tokens',
      'skill_index_tokens',
      'loaded_skill_tokens',
    ]) {
      legacy.exec(`ALTER TABLE provider_attempts DROP COLUMN ${column}`);
    }
    legacy.prepare('UPDATE provider_attempt_ledger_meta SET schema_version = 1 WHERE singleton = 1').run();
    legacy.close();

    ledger = new ProviderAttemptLedger(dbPath);
    ledger.append(attempt());
    expect(ledger.query({ callId: 'call-primary-1' })[0]).toMatchObject({
      memoryTokens: 12,
      loadedSkillTokens: 0,
    });
  });

  it('persists no prompt, response, or credential value', async () => {
    ledger.append(attempt({ credentialLabelRedacted: 'managed:configured' }));
    ledger.close();

    const bytes = await fs.readFile(dbPath);
    const persisted = bytes.toString('utf8');
    expect(persisted).not.toContain('raw prompt');
    expect(persisted).not.toContain('raw response');
    expect(persisted).not.toContain('credential value');

    ledger = new ProviderAttemptLedger(dbPath);
  });

  it('drives daemon daily limits from immutable attempt rows without double counting', () => {
    ledger.append(attempt({
      entryPoint: 'daemon',
      providerInputTokens: 60,
      providerOutputTokens: 20,
    }));
    const tracker = createLedgerDailyBudgetTracker({ ledger, budget: 100 });
    expect(tracker.peek({ now: 2_000 }).used).toBe(80);
    expect(tracker.addAndCheck(10, { now: 2_000 }).allowed).toBe(true);
    expect(tracker.peek({ now: 2_000 }).used).toBe(80);
    expect(tracker.addAndCheck(30, { now: 2_000 }).allowed).toBe(false);
  });
});
