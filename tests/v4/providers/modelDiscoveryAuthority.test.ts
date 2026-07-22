import { describe, expect, it, vi } from 'vitest';
import {
  clearModelDiscoveryCache,
  fetchModels,
} from '../../../core/v4/providers/modelFetch';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('provider model discovery authority', () => {
  it('keeps Groq chat families in the default view and quarantines non-agent families', async () => {
    clearModelDiscoveryCache();
    const body = { data: [
      { id: 'openai/gpt-oss-120b', owned_by: 'OpenAI' },
      { id: 'whisper-large-v3', owned_by: 'Groq' },
      { id: 'groq/compound-mini', owned_by: 'Groq' },
    ] };
    const fetchImpl = vi.fn(async () => json(body));

    const compatible = await fetchModels({
      providerId: 'groq',
      apiKey: 'fixture-credential',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const all = await fetchModels({
      providerId: 'groq',
      apiKey: 'fixture-credential',
      includeIncompatible: true,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(compatible.models.map((model) => model.id)).toEqual(['openai/gpt-oss-120b']);
    expect(all.models).toHaveLength(3);
    expect(all.models.filter((model) => model.compatibleWithAgent === false).map((model) => model.id).sort()).toEqual([
      'groq/compound-mini',
      'whisper-large-v3',
    ]);
  });

  it('uses Together live discovery and keeps only serverless chat models by default', async () => {
    clearModelDiscoveryCache();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://api.together.xyz/v1/models?dedicated=false');
      return json([
        { id: 'live/chat-model', type: 'chat', display_name: 'Live Chat', organization: 'Example', context_length: 131072 },
        { id: 'live/image-model', type: 'image', display_name: 'Image' },
        { id: 'live/embedding-model', type: 'embedding', display_name: 'Embedding' },
      ]);
    });

    const result = await fetchModels({
      providerId: 'together',
      apiKey: 'fixture-credential',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.source).toBe('live');
    expect(result.models.map((model) => model.id)).toEqual(['live/chat-model']);
    expect(result.models[0]).toMatchObject({
      displayName: 'Live Chat',
      creator: 'Example',
      contextLength: 131072,
      compatibleWithAgent: true,
    });
  });

  it('uses DeepSeek live discovery instead of retired static aliases', async () => {
    clearModelDiscoveryCache();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://api.deepseek.com/v1/models');
      return json({
        data: [
          { id: 'deepseek-v4-flash', owned_by: 'deepseek' },
          { id: 'deepseek-v4-pro', owned_by: 'deepseek' },
        ],
      });
    });

    const result = await fetchModels({
      providerId: 'deepseek',
      apiKey: 'fixture-credential',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.source).toBe('live');
    expect(result.models.map((model) => model.id)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
    expect(result.models.every((model) => model.creator === 'deepseek')).toBe(true);
  });

  it('uses the unified inference router and filters to a live tool-capable route', async () => {
    clearModelDiscoveryCache();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://router.huggingface.co/v1/models');
      return json({
        data: [
          {
            id: 'org/tool-model',
            owned_by: 'org',
            providers: [{
              provider: 'route-a',
              status: 'live',
              context_length: 262144,
              supports_tools: true,
              supports_structured_output: true,
            }],
          },
          {
            id: 'org/plain-model',
            owned_by: 'org',
            providers: [{ provider: 'route-b', status: 'live', supports_tools: false }],
          },
          {
            id: 'org/offline-model',
            owned_by: 'org',
            providers: [{ provider: 'route-c', status: 'error', supports_tools: true }],
          },
        ],
      });
    });

    const result = await fetchModels({
      providerId: 'huggingface',
      apiKey: 'fixture-credential',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.source).toBe('live');
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      id: 'org/tool-model',
      creator: 'org',
      hostedBy: 'route-a',
      contextLength: 262144,
      supportsToolCalling: true,
      supportsStructuredOutput: true,
      compatibleWithAgent: true,
    });
  });

  it('can include incompatible live models for an explicit show-all view', async () => {
    clearModelDiscoveryCache();
    const fetchImpl = vi.fn(async () => json({
      data: [{
        id: 'org/plain-model',
        owned_by: 'org',
        providers: [{ provider: 'route-b', status: 'live', supports_tools: false }],
      }],
    }));

    const result = await fetchModels({
      providerId: 'huggingface',
      apiKey: 'fixture-credential',
      includeIncompatible: true,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.models[0]).toMatchObject({
      id: 'org/plain-model',
      compatibleWithAgent: false,
      incompatibilityReason: 'tool calling not advertised by any live route',
    });
  });

  it('caches live discovery, supports refresh, and retains last-known-good on outage', async () => {
    clearModelDiscoveryCache();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return json({ data: [{ id: 'deepseek-v4-flash', owned_by: 'deepseek' }] });
      throw new Error('temporary network outage');
    });

    const first = await fetchModels({ providerId: 'deepseek', apiKey: 'fixture-credential', fetchImpl: fetchImpl as typeof fetch });
    const cached = await fetchModels({ providerId: 'deepseek', apiKey: 'fixture-credential', fetchImpl: fetchImpl as typeof fetch });
    const retained = await fetchModels({ providerId: 'deepseek', apiKey: 'fixture-credential', refresh: true, fetchImpl: fetchImpl as typeof fetch });

    expect(first).toMatchObject({ source: 'live', cacheStatus: 'fresh' });
    expect(cached).toMatchObject({ source: 'live', cacheStatus: 'cached' });
    expect(retained).toMatchObject({ source: 'last-known-good', cacheStatus: 'last-known-good' });
    expect(retained.models.map((model) => model.id)).toEqual(['deepseek-v4-flash']);
    expect(calls).toBe(2);
  });

  it('never exposes provider or credential text through discovery failure reasons', async () => {
    clearModelDiscoveryCache();
    const secret = 'fixture-sensitive-value';
    const result = await fetchModels({
      providerId: 'deepseek',
      apiKey: secret,
      fetchImpl: (async () => { throw new Error(`socket failed with ${secret}`); }) as typeof fetch,
    });

    expect(result.source).toBe('fallback');
    expect(result.reason).toBe('provider discovery unavailable');
    expect(result.reason).not.toContain(secret);
  });
});
