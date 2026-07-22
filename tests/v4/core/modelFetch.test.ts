import { describe, expect, it, vi } from 'vitest';

import { fetchModels } from '../../../core/v4/providers/modelFetch';

describe('local model inventory discovery', () => {
  it('returns only models reported by the live Ollama inventory', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'gemma4:e4b-8k' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await fetchModels({ providerId: 'ollama', fetchImpl: fetchImpl as typeof fetch });

    expect(result.source).toBe('live');
    expect(result.models.map((model) => model.id)).toEqual(['gemma4:e4b-8k']);
    expect(result.models.map((model) => model.id)).not.toEqual(expect.arrayContaining([
      'llama3.2', 'qwen2.5:7b', 'gemma2:2b',
    ]));
  });

  it('does not substitute selectable catalog models when Ollama inventory fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));

    const result = await fetchModels({ providerId: 'ollama', fetchImpl: fetchImpl as typeof fetch });

    expect(result.source).toBe('fallback');
    expect(result.models).toEqual([]);
    expect(result.reason).toBe('HTTP 404');
  });
});
