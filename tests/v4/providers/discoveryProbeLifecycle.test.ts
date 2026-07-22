import { describe, expect, it } from 'vitest';
import { fetchModels } from '../../../core/v4/providers/modelFetch';
import { runProbe } from '../../../core/v4/providers/probe';

function stalledBodyResponse(status = 200): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() { /* intentionally open */ } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('model discovery and setup probe lifecycle', () => {
  it('bounds model discovery through response-body completion', async () => {
    const result = await fetchModels({
      providerId: 'groq',
      apiKey: 'fixture-credential',
      timeoutMs: 20,
      fetchImpl: async () => stalledBodyResponse(),
    });

    expect(result.source).toBe('fallback');
    expect(result.reason).toMatch(/timeout/i);
  });

  it('bounds the setup probe through response-body completion', async () => {
    const result = await runProbe({
      providerId: 'groq',
      apiKey: 'fixture-credential',
      modelId: 'fixture-model',
      timeoutMs: 20,
      fetchImpl: async () => stalledBodyResponse(),
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ step: 'auth', ok: false, category: 'network' });
    expect(result.steps[0].reason).toMatch(/timeout/i);
  });
});
