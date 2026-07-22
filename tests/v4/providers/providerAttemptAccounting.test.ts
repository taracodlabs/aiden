import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProviderAttemptLedger } from '../../../core/v4/usageLedger';
import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import {
  ProviderAttemptBudgetExceededError,
  setProviderAttemptLedger,
} from '../../../providers/v4/providerAttemptAccounting';
import { FallbackAdapter } from '../../../core/v4/providerFallback';

let tmpDir: string;
let ledger: ProviderAttemptLedger;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-attempt-adapter-'));
  ledger = new ProviderAttemptLedger(path.join(tmpDir, 'sessions.db'));
  setProviderAttemptLedger(ledger);
});

afterEach(async () => {
  setProviderAttemptLedger(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  ledger.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function input() {
  return {
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [],
    usageContext: {
      logicalCallId: 'logical-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      runId: 'run-1',
      entryPoint: 'cli',
      providerConfigured: 'groq',
      modelConfigured: 'llama-3.3-70b-versatile',
      purpose: 'primary' as const,
      selectedMode: 'balanced' as const,
    },
  };
}

describe('physical provider-attempt accounting', () => {
  it('records a successful adapter attempt with provider usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 4,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }), { status: 200 })));
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'configured-value',
      model: 'llama-3.3-70b-versatile',
      providerName: 'groq',
      maxRetries: 0,
    });

    await adapter.call(input());

    const [record] = ledger.query({ sessionId: 'session-1' });
    expect(record).toMatchObject({
      parentCallId: 'logical-1',
      purpose: 'primary',
      providerConfigured: 'groq',
      providerActual: 'groq',
      modelActual: 'llama-3.3-70b-versatile',
      status: 'success',
      providerInputTokens: 11,
      providerOutputTokens: 4,
      providerReasoningTokens: 2,
      usageSource: 'provider_reported',
    });
  });

  it('records each adapter retry as a distinct physical attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"temporary"}}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'configured-value',
      model: 'llama-3.3-70b-versatile',
      providerName: 'groq',
      maxRetries: 1,
    });

    await adapter.call(input());

    const records = ledger.query({ parentCallId: 'logical-1' });
    expect(records).toHaveLength(2);
    expect(records.map((record) => ({
      attempt: record.attemptIndex,
      purpose: record.purpose,
      status: record.status,
    }))).toEqual([
      { attempt: 0, purpose: 'primary', status: 'provider_error' },
      { attempt: 1, purpose: 'retry', status: 'success' },
    ]);
  });

  it('records interruption separately from timeout and does not retry it', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })));
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'configured-value',
      model: 'llama-3.3-70b-versatile',
      providerName: 'groq',
      maxRetries: 2,
    });

    const pending = adapter.call({ ...input(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const records = ledger.query({ parentCallId: 'logical-1' });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('interrupted');
  });

  it('records a transport failure after dispatch as failed_after_send', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('socket closed'); }));
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'configured-value',
      model: 'model',
      providerName: 'provider',
      maxRetries: 0,
    });

    await expect(adapter.call(input())).rejects.toThrow(/Network failure/);
    expect(ledger.query({ parentCallId: 'logical-1' })).toHaveLength(1);
    expect(ledger.query({ parentCallId: 'logical-1' })[0]).toMatchObject({
      status: 'failed_after_send',
      usageSource: 'locally_estimated',
    });
  });

  it('records serialization failure before any request is sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'configured-value',
      model: 'model',
      providerName: 'provider',
      maxRetries: 0,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(adapter.call({ ...input(), extraBody: circular })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.query({ parentCallId: 'logical-1' })).toHaveLength(1);
    expect(ledger.query({ parentCallId: 'logical-1' })[0].status).toBe('failed_before_send');
  });

  it('records configured and actual provider/model for each fallback slot', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://primary.invalid')) {
        return new Response('{"error":{"message":"limited"}}', { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      }), { status: 200 });
    }));
    const fallback = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [
        {
          id: 'primary-slot',
          providerId: 'primary-provider',
          modelId: 'primary-model',
          keyPresent: true,
          keyTail: null,
          build: () => new ChatCompletionsAdapter({
            baseUrl: 'https://primary.invalid/v1',
            apiKey: 'configured-value',
            model: 'primary-model',
            providerName: 'primary-provider',
            maxRetries: 0,
          }),
        },
        {
          id: 'fallback-slot',
          providerId: 'fallback-provider',
          modelId: 'fallback-model',
          keyPresent: true,
          keyTail: null,
          build: () => new ChatCompletionsAdapter({
            baseUrl: 'https://fallback.invalid/v1',
            apiKey: 'configured-value',
            model: 'fallback-model',
            providerName: 'fallback-provider',
            maxRetries: 0,
          }),
        },
      ],
      cooldownMs: 0,
    });

    await fallback.call({
      ...input(),
      usageContext: {
        ...input().usageContext,
        providerConfigured: 'primary-provider',
        modelConfigured: 'primary-model',
      },
    });

    const records = ledger.query({ parentCallId: 'logical-1' });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      providerConfigured: 'primary-provider',
      providerActual: 'primary-provider',
      modelConfigured: 'primary-model',
      modelActual: 'primary-model',
      fallbackIndex: 0,
      status: 'provider_error',
    });
    expect(records[1]).toMatchObject({
      providerConfigured: 'primary-provider',
      providerActual: 'fallback-provider',
      modelConfigured: 'primary-model',
      modelActual: 'fallback-model',
      fallbackIndex: 1,
      purpose: 'fallback',
      status: 'success',
    });
  });

  it('counts retries against an exact physical-attempt budget', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '{"error":{"message":"temporary"}}',
      { status: 503 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'configured-value',
      model: 'model',
      providerName: 'provider',
      maxRetries: 2,
    });
    const attemptBudget = {
      label: 'subagent child 1',
      maxAttempts: 1,
      usedAttempts: 0,
      usedEstimatedTokens: 0,
    };

    await expect(adapter.call({
      ...input(),
      usageContext: { ...input().usageContext, attemptBudgets: [attemptBudget] },
    })).rejects.toBeInstanceOf(ProviderAttemptBudgetExceededError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(attemptBudget.usedAttempts).toBe(1);
    expect(ledger.query({ parentCallId: 'logical-1' })).toHaveLength(1);
  });

  it('blocks an estimated-token overrun before sending or recording a physical attempt', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'configured-value',
      model: 'model',
      providerName: 'provider',
      maxRetries: 0,
    });
    const attemptBudget = {
      label: 'subagent fanout',
      maxEstimatedTokens: 1,
      usedAttempts: 0,
      usedEstimatedTokens: 0,
    };

    await expect(adapter.call({
      ...input(),
      usageContext: { ...input().usageContext, attemptBudgets: [attemptBudget] },
    })).rejects.toBeInstanceOf(ProviderAttemptBudgetExceededError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(attemptBudget.usedAttempts).toBe(0);
    expect(ledger.query({ parentCallId: 'logical-1' })).toHaveLength(0);
  });
});
