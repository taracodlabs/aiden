/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B2.2a — the vision-call routing path: active model if supportsVision,
 * else a clear capability error (no silent re-routing). The image must reach
 * the adapter as a user-message image.
 */
import { describe, it, expect, vi } from 'vitest';
import { setVisionProvider, askVision, visionAvailable } from '../../../core/v4/visionClient';
import type { ProviderAdapter, ProviderCallInput } from '../../../providers/v4/types';

function fakeAdapter() {
  const calls: ProviderCallInput[] = [];
  const adapter = {
    call: vi.fn(async (input: ProviderCallInput) => {
      calls.push(input);
      return { content: 'a red square', toolCalls: [], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    }),
  } as unknown as ProviderAdapter;
  return { adapter, calls };
}

describe('visionClient — routing', () => {
  it('vision-capable active model → image reaches adapter.call, returns text', async () => {
    const { adapter, calls } = fakeAdapter();
    setVisionProvider({ adapter, providerId: 'anthropic', modelId: 'claude-opus-4-7' });
    expect(visionAvailable().ok).toBe(true);

    const r = await askVision({ imageDataUrl: 'data:image/png;base64,AAA', question: 'what is this?' });
    expect(r).toEqual({ ok: true, text: 'a red square' });

    const user = calls[0].messages.find((m) => m.role === 'user') as { content: string; images?: string[] };
    expect(user.content).toBe('what is this?');
    expect(user.images).toEqual(['data:image/png;base64,AAA']); // image carried to the model
  });

  it('non-vision active model → clear error, adapter NEVER called (no silent re-routing)', async () => {
    const { adapter, calls } = fakeAdapter();
    setVisionProvider({ adapter, providerId: 'chatgpt-plus', modelId: 'gpt-5.1-codex-mini' });
    expect(visionAvailable().ok).toBe(false);

    const r = await askVision({ imageDataUrl: 'data:image/png;base64,AAA', question: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/can't see images|vision-capable/i);
    expect(calls.length).toBe(0);
  });

  it('no provider configured → clear error', async () => {
    setVisionProvider(null);
    expect(visionAvailable().ok).toBe(false);
    const r = await askVision({ imageDataUrl: 'x', question: 'x' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/vision/i);
  });
});
