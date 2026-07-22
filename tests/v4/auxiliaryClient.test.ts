import { describe, it, expect, vi } from 'vitest';
import {
  AuxiliaryClient,
  type AuxiliaryResolver,
} from '../../core/v4/auxiliaryClient';
import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
} from '../../providers/v4/types';

class StubAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  public calls: ProviderCallInput[] = [];
  constructor(
    private response: ProviderCallOutput = {
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 7 },
    },
    private behaviour: 'ok' | 'throw' | 'slow' = 'ok',
    private delayMs = 0,
  ) {}
  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.calls.push(input);
    if (this.behaviour === 'throw') throw new Error('boom');
    if (this.behaviour === 'slow' && this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return this.response;
  }
}

function makeResolver(adapter: ProviderAdapter): AuxiliaryResolver & { count: number } {
  const r = { count: 0 } as AuxiliaryResolver & { count: number };
  r.resolve = async () => {
    (r as { count: number }).count += 1;
    return adapter;
  };
  return r;
}

describe('AuxiliaryClient', () => {
  it('1. call returns content + usage', async () => {
    const adapter = new StubAdapter();
    const c = new AuxiliaryClient({
      defaultProvider: 'groq',
      defaultModel: 'llama-3.1-8b-instant',
      adapter,
      warn: () => {},
    });
    const r = await c.call({ purpose: 'compression', prompt: 'summarize this' });
    expect(r.content).toBe('ok');
    expect(r.usage.inputTokens).toBe(5);
    expect(r.usage.outputTokens).toBe(7);
  });

  it('2. different purposes log separately in usage tracking', async () => {
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      adapter: new StubAdapter(),
      warn: () => {},
    });
    await c.call({ purpose: 'compression', prompt: 'a' });
    await c.call({ purpose: 'risk_assess', prompt: 'b' });
    await c.call({ purpose: 'risk_assess', prompt: 'c' });
    const u = c.getUsage();
    expect(u.compression.calls).toBe(1);
    expect(u.risk_assess.calls).toBe(2);
  });

  it('3. default maxTokens is 200', async () => {
    const adapter = new StubAdapter();
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      adapter,
      warn: () => {},
    });
    await c.call({ purpose: 'plan_classify', prompt: 'x' });
    expect(adapter.calls[0].maxTokens).toBe(200);
  });

  it('4. timeout enforced', async () => {
    const adapter = new StubAdapter(undefined, 'slow', 200);
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      adapter,
      warn: () => {},
    });
    const r = await c.call({
      purpose: 'compression',
      prompt: 'x',
      timeoutMs: 50,
    });
    // Times out → empty content (not throw).
    expect(r.content).toBe('');
  });

  it('5. resolver failure: returns empty content + warning, does not throw', async () => {
    const warns: string[] = [];
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      resolver: { resolve: async () => { throw new Error('no key'); } },
      warn: (m) => warns.push(m),
    });
    const r = await c.call({ purpose: 'compression', prompt: 'x' });
    expect(r.content).toBe('');
    expect(warns.some((w) => w.includes('unavailable'))).toBe(true);
    expect(c.isUnavailable()).toBe(true);
  });

  it('6. getUsage returns by-purpose breakdown', async () => {
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      adapter: new StubAdapter(),
      warn: () => {},
    });
    await c.call({ purpose: 'honesty_classify', prompt: 'x' });
    const u = c.getUsage();
    expect(u.honesty_classify).toBeDefined();
    expect(u.honesty_classify.calls).toBe(1);
  });

  it('7. resolves the adapter lazily and only once', async () => {
    const adapter = new StubAdapter();
    const resolver = makeResolver(adapter);
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      resolver,
      warn: () => {},
    });
    expect(c._resolveCallCount()).toBe(0);
    await c.call({ purpose: 'compression', prompt: 'a' });
    await c.call({ purpose: 'compression', prompt: 'b' });
    await c.call({ purpose: 'compression', prompt: 'c' });
    expect(c._resolveCallCount()).toBe(1);
  });

  it('8. each call is independent (no conversation history bleed)', async () => {
    const adapter = new StubAdapter();
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      adapter,
      warn: () => {},
    });
    await c.call({ purpose: 'compression', prompt: 'first' });
    await c.call({ purpose: 'compression', prompt: 'second' });
    // Each call sees only system + this user message.
    for (const captured of adapter.calls) {
      expect(captured.messages.length).toBe(2);
      expect(captured.messages[0].role).toBe('system');
      expect(captured.messages[1].role).toBe('user');
    }
    expect((adapter.calls[1].messages[1] as { content: string }).content).toBe('second');
  });

  it('9. adapter throws → returns empty + warns, no throw', async () => {
    const adapter = new StubAdapter(undefined, 'throw');
    const warns: string[] = [];
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      adapter,
      warn: (m) => warns.push(m),
    });
    const r = await c.call({ purpose: 'compression', prompt: 'x' });
    expect(r.content).toBe('');
    expect(warns.some((w) => w.includes('failed'))).toBe(true);
  });

  // ── v4.8.0 Slice 11 — fallback chain coverage ─────────────────────────
  //
  // The resolver chain is `default → fallbacks[0] → fallbacks[1]` …
  // The first attempt that returns an adapter wins; failures are
  // recorded and the next attempt fires. If every attempt fails the
  // client logs a single combined warning and marks itself unavailable.

  it('11. fallback chain: falls through to fallback when default resolver throws', async () => {
    const adapter = new StubAdapter();
    const warns: string[] = [];
    let attemptIndex = 0;
    const c = new AuxiliaryClient({
      defaultProvider: 'groq',
      defaultModel:    'llama-3.1-8b-instant',
      fallbacks:       [{ providerId: 'chatgpt-plus', modelId: 'gpt-5' }],
      resolver: {
        resolve: async (o) => {
          attemptIndex += 1;
          if (o.providerId === 'groq') throw new Error('no GROQ_API_KEY');
          return adapter;
        },
      },
      warn: (m) => warns.push(m),
    });
    const r = await c.call({ purpose: 'risk_assess', prompt: 'is this safe?' });
    expect(r.content).toBe('ok');
    expect(attemptIndex).toBe(2);
    // Verbose log surfaces which attempt succeeded (Slice 11 telemetry).
    expect(warns.some((w) => w.includes('resolved via chatgpt-plus/gpt-5'))).toBe(true);
  });

  it('12. fallback chain: default wins when it resolves cleanly', async () => {
    const adapter = new StubAdapter();
    const warns: string[] = [];
    const c = new AuxiliaryClient({
      defaultProvider: 'groq',
      defaultModel:    'llama-3.1-8b-instant',
      fallbacks:       [{ providerId: 'anthropic', modelId: 'claude' }],
      resolver: { resolve: async () => adapter },
      warn: (m) => warns.push(m),
    });
    await c.call({ purpose: 'risk_assess', prompt: 'x' });
    // Only the default attempt fired — _resolveCallCount = 1.
    expect(c._resolveCallCount()).toBe(1);
    expect(warns.some((w) => w.includes('resolved via groq/llama-3.1-8b-instant'))).toBe(true);
  });

  it('13. fallback chain: every attempt fails → empty content + isUnavailable()', async () => {
    const warns: string[] = [];
    const c = new AuxiliaryClient({
      defaultProvider: 'groq',
      defaultModel:    'm',
      fallbacks:       [{ providerId: 'p2', modelId: 'm2' }],
      resolver: { resolve: async () => { throw new Error('boom'); } },
      warn: (m) => warns.push(m),
    });
    const r = await c.call({ purpose: 'compression', prompt: 'x' });
    expect(r.content).toBe('');
    expect(c.isUnavailable()).toBe(true);
    // Combined unavailability warning mentions BOTH attempts.
    const combined = warns.find((w) => w.includes('unavailable'));
    expect(combined).toBeDefined();
    expect(combined).toContain('groq/m');
    expect(combined).toContain('p2/m2');
  });

  it('falls back to the parent after the configured auxiliary fails a real call', async () => {
    const auxiliary = new StubAdapter(undefined, 'throw');
    const parent = new StubAdapter({
      content: 'parent result',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    const c = new AuxiliaryClient({
      defaultProvider: 'auxiliary',
      defaultModel: 'small',
      fallbacks: [{ providerId: 'parent', modelId: 'selected' }],
      resolver: {
        resolve: async ({ providerId }) => providerId === 'auxiliary' ? auxiliary : parent,
      },
      warn: () => {},
    });

    const result = await c.call({ purpose: 'compression', prompt: 'summarize' });

    expect(result.content).toBe('parent result');
    expect(auxiliary.calls).toHaveLength(1);
    expect(parent.calls).toHaveLength(1);
    expect(c._resolveCallCount()).toBe(2);
    expect(c.isUnavailable()).toBe(false);
  });

  it('disables the optional operation when auxiliary and parent both fail calls', async () => {
    const c = new AuxiliaryClient({
      defaultProvider: 'auxiliary',
      defaultModel: 'small',
      fallbacks: [{ providerId: 'parent', modelId: 'selected' }],
      resolver: { resolve: async () => new StubAdapter(undefined, 'throw') },
      warn: () => {},
    });

    const result = await c.call({ purpose: 'honesty_classify', prompt: 'classify' });

    expect(result.content).toBe('');
    expect(c._resolveCallCount()).toBe(2);
    expect(c.isUnavailable()).toBe(true);
  });

  it('keeps the selected parent cached after it proves live', async () => {
    const auxiliary = new StubAdapter(undefined, 'throw');
    const parent = new StubAdapter();
    const c = new AuxiliaryClient({
      defaultProvider: 'auxiliary',
      defaultModel: 'small',
      fallbacks: [{ providerId: 'parent', modelId: 'selected' }],
      resolver: {
        resolve: async ({ providerId }) => providerId === 'auxiliary' ? auxiliary : parent,
      },
      warn: () => {},
    });

    await c.call({ purpose: 'compression', prompt: 'first' });
    await c.call({ purpose: 'compression', prompt: 'second' });

    expect(auxiliary.calls).toHaveLength(1);
    expect(parent.calls).toHaveLength(2);
    expect(c._resolveCallCount()).toBe(2);
  });

  it('10. concurrent calls record usage independently (no race-bleed)', async () => {
    const adapter = new StubAdapter();
    const c = new AuxiliaryClient({
      defaultProvider: 'p',
      defaultModel: 'm',
      adapter,
      warn: () => {},
    });
    await Promise.all([
      c.call({ purpose: 'compression', prompt: 'a' }),
      c.call({ purpose: 'compression', prompt: 'b' }),
      c.call({ purpose: 'compression', prompt: 'c' }),
    ]);
    expect(c.getUsage().compression.calls).toBe(3);
  });
});
