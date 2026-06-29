/**
 * tests/v4/providerFallback.test.ts — Phase 16b.1
 *
 * Unit tests for the shared provider fallback chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isRateLimitError,
  runFallbackChain,
  buildDefaultSlots,
  FallbackAdapter,
  ChainExhaustedError,
  maskKey,
  resolveSlotCooldownMs,
  DEFAULT_SLOT_COOLDOWN_MS,
  type ProviderSlot,
} from '../../core/v4/providerFallback';
import type { ProviderAdapter } from '../../providers/v4/types';

describe('isRateLimitError', () => {
  it('matches a 429 status code', () => {
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });
  it('matches a "rate limit" message', () => {
    expect(isRateLimitError(new Error('Provider groq rate limited'))).toBe(true);
  });
  it('matches "429" in the message', () => {
    expect(isRateLimitError(new Error('HTTP 429 too many requests'))).toBe(true);
  });
  it('matches by error name "ProviderRateLimitError"', () => {
    const e = new Error('boom');
    e.name = 'ProviderRateLimitError';
    expect(isRateLimitError(e)).toBe(true);
  });
  it('matches the explicit `rateLimit` flag', () => {
    expect(isRateLimitError({ rateLimit: true })).toBe(true);
  });
  it('does NOT match an unrelated error', () => {
    expect(isRateLimitError(new Error('schema validation failed'))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
  it('does NOT match Groq tool_use_failed 400 errors (Phase 16b.2)', () => {
    // Llama-3.3 emitting `<function=...>` produces a 400 with code
    // `tool_use_failed`. The chain MUST NOT advance — it's a model-format
    // bug, not a quota issue. The chatCompletionsAdapter recovers it
    // separately via tryRecoverLegacyToolCall.
    const err = new Error(
      "Provider groq returned 400: { code: 'tool_use_failed', failed_generation: '<function=foo({})>' }",
    );
    (err as unknown as { statusCode: number }).statusCode = 400;
    expect(isRateLimitError(err)).toBe(false);
  });
});

describe('maskKey', () => {
  it('returns null for empty input', () => {
    expect(maskKey(null)).toBeNull();
    expect(maskKey('')).toBeNull();
  });
  it('masks all but the last 4 chars', () => {
    expect(maskKey('abcdef1234')).toMatch(/1234$/);
    expect(maskKey('abcdef1234')).not.toContain('abcdef');
  });
  it('caps mask length to 8 dots', () => {
    const masked = maskKey('a'.repeat(50) + '1234');
    // 8 dots + 4 tail = 12 chars
    expect(masked!.length).toBe(12);
  });
});

describe('runFallbackChain', () => {
  function makeSlot(id: string, build: () => ProviderAdapter | null): ProviderSlot {
    return {
      id,
      providerId: id,
      modelId: 'm',
      keyPresent: true,
      keyTail: '1234',
      build,
    };
  }
  const okAdapter: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => ({
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
  const rateLimitedAdapter: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => {
      throw new Error('Provider groq rate limited');
    },
  };

  it('returns the first slot that succeeds', async () => {
    const slots = [makeSlot('a', () => okAdapter)];
    const r = await runFallbackChain(slots, (a) => a.call({ messages: [], tools: [] }));
    expect(r.slotId).toBe('a');
    expect(r.value.content).toBe('ok');
  });

  it('advances past a rate-limited slot', async () => {
    const onRateLimit = vi.fn();
    const slots = [
      makeSlot('a', () => rateLimitedAdapter),
      makeSlot('b', () => okAdapter),
    ];
    const r = await runFallbackChain(
      slots,
      (a) => a.call({ messages: [], tools: [] }),
      { onRateLimit },
    );
    expect(r.slotId).toBe('b');
    expect(onRateLimit).toHaveBeenCalledWith('a', expect.any(Error));
  });

  it('throws ChainExhaustedError when every slot rate-limits', async () => {
    const slots = [
      makeSlot('a', () => rateLimitedAdapter),
      makeSlot('b', () => rateLimitedAdapter),
    ];
    await expect(
      runFallbackChain(slots, (a) => a.call({ messages: [], tools: [] })),
    ).rejects.toThrow(ChainExhaustedError);
  });

  it('rethrows non-rate-limit errors immediately', async () => {
    const bombAdapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => {
        throw new Error('schema validation failed');
      },
    };
    const slots = [
      makeSlot('a', () => bombAdapter),
      makeSlot('b', () => okAdapter),
    ];
    await expect(
      runFallbackChain(slots, (a) => a.call({ messages: [], tools: [] })),
    ).rejects.toThrow('schema validation failed');
  });

  it('skips slots whose build() returns null', async () => {
    const slots = [
      makeSlot('a', () => null),
      makeSlot('b', () => okAdapter),
    ];
    const r = await runFallbackChain(slots, (a) =>
      a.call({ messages: [], tools: [] }),
    );
    expect(r.slotId).toBe('b');
  });
});

describe('buildDefaultSlots', () => {
  it('builds 6 slots: together → together-fallback → groq×4 (Phase 16f)', () => {
    const slots = buildDefaultSlots({
      adapterFactory: () => okStub(),
      env: {
        GROQ_API_KEY: 'k1',
        GROQ_API_KEY_2: 'k2',
        TOGETHER_API_KEY: 'tk',
      },
    });
    expect(slots.map((s) => s.id)).toEqual([
      'together',
      'together-fallback',
      'groq',
      'groq2',
      'groq3',
      'groq4',
    ]);
    // Together slots both share TOGETHER_API_KEY so both keyPresent.
    expect(slots[0].keyPresent).toBe(true);
    expect(slots[1].keyPresent).toBe(true);
    expect(slots[2].keyPresent).toBe(true); // groq → GROQ_API_KEY
    expect(slots[3].keyPresent).toBe(true); // groq2 → GROQ_API_KEY_2
    expect(slots[4].keyPresent).toBe(false); // groq3 unset
    expect(slots[5].keyPresent).toBe(false); // groq4 unset
  });

  it('Together primary uses gpt-oss-120b by default; fallback uses Llama-3.3-Turbo', () => {
    const slots = buildDefaultSlots({
      adapterFactory: () => okStub(),
      env: { TOGETHER_API_KEY: 'tk' },
    });
    const primary = slots.find((s) => s.id === 'together')!;
    const fallback = slots.find((s) => s.id === 'together-fallback')!;
    expect(primary.modelId).toBe('openai/gpt-oss-120b');
    expect(fallback.modelId).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(primary.providerId).toBe('together');
    expect(fallback.providerId).toBe('together');
  });

  it('groq4 slot picks up GROQ_API_KEY_4', () => {
    const slots = buildDefaultSlots({
      adapterFactory: () => okStub(),
      env: { GROQ_API_KEY_4: 'k4-secret-tail' },
    });
    const groq4 = slots.find((s) => s.id === 'groq4')!;
    expect(groq4.keyPresent).toBe(true);
    expect(groq4.keyTail).toBe('tail');
    expect(groq4.providerId).toBe('groq');
  });

  it('uses model overrides when provided', () => {
    const slots = buildDefaultSlots({
      adapterFactory: () => okStub(),
      env: { GROQ_API_KEY: 'k' },
      groqModel: 'llama-custom',
      togetherModel: 'together-custom',
      togetherFallbackModel: 'together-fallback-custom',
    });
    // New order: together (custom) → together-fallback (custom) → groq×4
    expect(slots[0].modelId).toBe('together-custom');
    expect(slots[1].modelId).toBe('together-fallback-custom');
    // groq slots inherit groqModel.
    expect(slots[2].modelId).toBe('llama-custom');
    expect(slots[5].modelId).toBe('llama-custom');
  });
});

describe('FallbackAdapter', () => {
  const okStub = (): ProviderAdapter => ({
    apiMode: 'chat_completions',
    call: async () => ({
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
  const rlStub = (): ProviderAdapter => ({
    apiMode: 'chat_completions',
    call: async () => {
      throw new Error('rate limit hit');
    },
  });
  function slot(id: string, build: () => ProviderAdapter | null): ProviderSlot {
    return {
      id,
      providerId: 'groq',
      modelId: 'm',
      keyPresent: build() !== null,
      keyTail: 'abcd',
      build,
    };
  }

  it('falls through on rate-limit and reports the active slot', async () => {
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [slot('a', rlStub), slot('b', okStub)],
    });
    const out = await fa.call({ messages: [], tools: [] });
    expect(out.content).toBe('ok');
    const diag = fa.getDiagnostics();
    expect(diag.activeSlotId).toBe('b');
    expect(diag.slots.find((s) => s.id === 'a')!.state.rateLimitCount).toBe(1);
    expect(diag.slots.find((s) => s.id === 'b')!.state.successCount).toBe(1);
  });

  it('throws ChainExhaustedError after all slots rate-limit', async () => {
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [slot('a', rlStub), slot('b', rlStub)],
    });
    await expect(fa.call({ messages: [], tools: [] })).rejects.toBeInstanceOf(
      ChainExhaustedError,
    );
  });
});

function okStub(): ProviderAdapter {
  return {
    apiMode: 'chat_completions',
    call: async () => ({
      content: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
}

// ─── Phase 16b.3: per-slot cooldown ─────────────────────────────────────
describe('resolveSlotCooldownMs', () => {
  it('returns the default when AIDEN_SLOT_COOLDOWN_MS is unset', () => {
    expect(resolveSlotCooldownMs({})).toBe(DEFAULT_SLOT_COOLDOWN_MS);
    expect(DEFAULT_SLOT_COOLDOWN_MS).toBe(60_000);
  });
  it('honours a valid override', () => {
    expect(resolveSlotCooldownMs({ AIDEN_SLOT_COOLDOWN_MS: '15000' })).toBe(15000);
  });
  it('falls back to the default for invalid values', () => {
    expect(resolveSlotCooldownMs({ AIDEN_SLOT_COOLDOWN_MS: 'nope' })).toBe(
      DEFAULT_SLOT_COOLDOWN_MS,
    );
    expect(resolveSlotCooldownMs({ AIDEN_SLOT_COOLDOWN_MS: '-5' })).toBe(
      DEFAULT_SLOT_COOLDOWN_MS,
    );
  });
});

describe('runFallbackChain cooldown skip', () => {
  function makeSlot(id: string, build: () => ProviderAdapter | null): ProviderSlot {
    return {
      id,
      providerId: id,
      modelId: 'm',
      keyPresent: true,
      keyTail: '1234',
      build,
    };
  }
  const okAdapter: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => ({
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
  const rl: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => {
      throw new Error('429 too many requests');
    },
  };

  it('skips a slot whose cooldown has not yet expired and uses the next fresh slot first', async () => {
    let nowMs = 1_000_000;
    const cooldownUntil = new Map<string, number>([['a', nowMs + 30_000]]);
    const cooldown = {
      cooldownUntil,
      cooldownMs: 60_000,
      now: () => nowMs,
    };
    const slots = [makeSlot('a', () => okAdapter), makeSlot('b', () => okAdapter)];
    const r = await runFallbackChain(
      slots,
      (a) => a.call({ messages: [], tools: [] }),
      {},
      cooldown,
    );
    // 'a' is in cooldown, so even though okAdapter would succeed, the
    // chain MUST pick 'b' on the fresh-slot pass.
    expect(r.slotId).toBe('b');
  });

  it('writes a fresh cooldown deadline when a slot 429s', async () => {
    let nowMs = 2_000_000;
    const cooldownUntil = new Map<string, number>();
    const cooldown = {
      cooldownUntil,
      cooldownMs: 60_000,
      now: () => nowMs,
    };
    const slots = [makeSlot('a', () => rl), makeSlot('b', () => okAdapter)];
    await runFallbackChain(
      slots,
      (a) => a.call({ messages: [], tools: [] }),
      {},
      cooldown,
    );
    expect(cooldownUntil.get('a')).toBe(nowMs + 60_000);
    // 'b' succeeded — it must NOT be in cooldown.
    expect(cooldownUntil.get('b')).toBeUndefined();
  });

  it('falls back to a cooling slot when every fresh slot is rate-limited', async () => {
    // Both slots are configured but slot 'a' is in cooldown and slot 'b'
    // immediately 429s. The chain should retry 'a' as a last resort.
    let nowMs = 3_000_000;
    let aCalls = 0;
    const aAdapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => {
        aCalls += 1;
        return {
          content: 'recovered',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const cooldownUntil = new Map<string, number>([['a', nowMs + 5_000]]);
    const cooldown = {
      cooldownUntil,
      cooldownMs: 60_000,
      now: () => nowMs,
    };
    const slots = [makeSlot('a', () => aAdapter), makeSlot('b', () => rl)];
    const r = await runFallbackChain(
      slots,
      (a) => a.call({ messages: [], tools: [] }),
      {},
      cooldown,
    );
    expect(r.slotId).toBe('a');
    expect(aCalls).toBe(1);
    // Successful retry clears 'a's cooldown.
    expect(cooldownUntil.get('a')).toBeUndefined();
  });
});

describe('Phase 16e — least-used slot selection', () => {
  function makeSlot(
    id: string,
    build: () => ProviderAdapter | null,
  ): ProviderSlot {
    return {
      id,
      providerId: id,
      modelId: 'm',
      keyPresent: true,
      keyTail: '1234',
      build,
    };
  }
  const okAdapter = (): ProviderAdapter => ({
    apiMode: 'chat_completions',
    call: async () => ({
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  });

  it('picks the slot with the lowest request count when fresh slots tie on cooldown', async () => {
    const slots = [
      makeSlot('a', okAdapter),
      makeSlot('b', okAdapter),
      makeSlot('c', okAdapter),
    ];
    const requestCount = new Map<string, number>([
      ['a', 5],
      ['b', 0],
      ['c', 3],
    ]);
    const cooldown = {
      cooldownUntil: new Map<string, number>(),
      cooldownMs: 60_000,
      requestCount,
      now: () => 1_000_000,
    };
    const r = await runFallbackChain(
      slots,
      (_a, slot) => Promise.resolve({ slotId: slot.id }),
      {},
      cooldown,
    );
    expect(r.slotId).toBe('b');
    expect(requestCount.get('b')).toBe(1); // 0 → 1 after the pick
  });

  it('increments count on rate-limit too (TPM burns regardless of success)', async () => {
    const rlAdapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => {
        throw new Error('429 rate limit');
      },
    };
    const slots = [
      makeSlot('a', () => rlAdapter),
      makeSlot('b', okAdapter),
    ];
    const requestCount = new Map<string, number>();
    const cooldown = {
      cooldownUntil: new Map<string, number>(),
      cooldownMs: 60_000,
      requestCount,
      now: () => 1_000_000,
    };
    await runFallbackChain(
      slots,
      (a) => a.call({ messages: [], tools: [] }),
      {},
      cooldown,
    );
    expect(requestCount.get('a')).toBe(1);
    expect(requestCount.get('b')).toBe(1);
  });

  it('a 4-call burst spreads 1/1/1/1 across 4 fresh slots (vs 4/0/0/0 with fill-first)', async () => {
    const slots = [
      makeSlot('s1', okAdapter),
      makeSlot('s2', okAdapter),
      makeSlot('s3', okAdapter),
      makeSlot('s4', okAdapter),
    ];
    const requestCount = new Map<string, number>();
    const cooldown = {
      cooldownUntil: new Map<string, number>(),
      cooldownMs: 60_000,
      requestCount,
    };
    for (let i = 0; i < 4; i++) {
      await runFallbackChain(
        slots,
        (_a, slot) => Promise.resolve({ slotId: slot.id }),
        {},
        cooldown,
      );
    }
    // Distribution must be even — that's the entire point of least_used.
    expect(requestCount.get('s1')).toBe(1);
    expect(requestCount.get('s2')).toBe(1);
    expect(requestCount.get('s3')).toBe(1);
    expect(requestCount.get('s4')).toBe(1);
  });

  it('preserves slot order as a tiebreaker when all counts are equal', async () => {
    const slots = [
      makeSlot('a', okAdapter),
      makeSlot('b', okAdapter),
    ];
    const requestCount = new Map<string, number>([
      ['a', 7],
      ['b', 7],
    ]);
    const cooldown = {
      cooldownUntil: new Map<string, number>(),
      cooldownMs: 60_000,
      requestCount,
    };
    const r = await runFallbackChain(
      slots,
      (_a, slot) => Promise.resolve({ slotId: slot.id }),
      {},
      cooldown,
    );
    // 'a' wins on configured-order tiebreaker.
    expect(r.slotId).toBe('a');
  });

  it('FallbackAdapter spreads load across slots over multiple calls', async () => {
    const log: string[] = [];
    const trackingAdapter = (id: string): ProviderAdapter => ({
      apiMode: 'chat_completions',
      call: async () => {
        log.push(id);
        return {
          content: 'ok',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });
    const slots = [
      makeSlot('a', () => trackingAdapter('a')),
      makeSlot('b', () => trackingAdapter('b')),
      makeSlot('c', () => trackingAdapter('c')),
    ];
    const fa = new FallbackAdapter({ apiMode: 'chat_completions', slots });
    for (let i = 0; i < 3; i++) {
      await fa.call({ messages: [], tools: [] });
    }
    // After 3 calls each slot should have been touched exactly once.
    expect(log.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('Phase 16b.3 cooldown countdown', () => {
  function makeSlot(
    id: string,
    build: () => ProviderAdapter | null,
  ): ProviderSlot {
    return {
      id,
      providerId: id,
      modelId: 'm',
      keyPresent: true,
      keyTail: '1234',
      build,
    };
  }
  const okAdapter: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => ({
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
  const rl: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => {
      throw new Error('429 too many requests');
    },
  };

  it('FallbackAdapter exposes cooldown countdown via getDiagnostics', async () => {
    let nowMs = 4_000_000;
    const rlSlot: ProviderSlot = {
      id: 'a',
      providerId: 'groq',
      modelId: 'm',
      keyPresent: true,
      keyTail: 'aaaa',
      build: () => rl,
    };
    const okSlot: ProviderSlot = {
      id: 'b',
      providerId: 'groq',
      modelId: 'm',
      keyPresent: true,
      keyTail: 'bbbb',
      build: () => okAdapter,
    };
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [rlSlot, okSlot],
      cooldownMs: 60_000,
      now: () => nowMs,
    });
    await fa.call({ messages: [], tools: [] });
    // Slot 'a' should now be in cooldown ~= 60s.
    let diag = fa.getDiagnostics();
    expect(diag.cooldownSec).toBe(60);
    const aDiag = diag.slots.find((s) => s.id === 'a')!;
    expect(aDiag.cooldownRemainingSec).toBe(60);
    expect(aDiag.state.cooldownUntil).toBe(nowMs + 60_000);
    // Slot 'b' never 429'd.
    const bDiag = diag.slots.find((s) => s.id === 'b')!;
    expect(bDiag.cooldownRemainingSec).toBe(0);
    expect(bDiag.state.cooldownUntil).toBeNull();

    // Advance the virtual clock; remaining countdown should drop.
    nowMs += 30_000;
    diag = fa.getDiagnostics();
    expect(diag.slots.find((s) => s.id === 'a')!.cooldownRemainingSec).toBe(30);
  });

  it('FallbackAdapter does NOT pick a slot whose cooldown is still active', async () => {
    let nowMs = 5_000_000;
    let aCalls = 0;
    const aOk: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => {
        aCalls += 1;
        return {
          content: 'a-result',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    let bCalls = 0;
    const bOk: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => {
        bCalls += 1;
        return {
          content: 'b-result',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const aSlot: ProviderSlot = {
      id: 'a', providerId: 'groq', modelId: 'm', keyPresent: true, keyTail: 'a',
      build: () => aOk,
    };
    const bSlot: ProviderSlot = {
      id: 'b', providerId: 'groq', modelId: 'm', keyPresent: true, keyTail: 'b',
      build: () => bOk,
    };
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [aSlot, bSlot],
      cooldownMs: 60_000,
      now: () => nowMs,
    });
    // Manually mark 'a' as cooling (e.g. reuse from a previous turn).
    (fa as any).cooldownUntil.set('a', nowMs + 10_000);
    const out = await fa.call({ messages: [], tools: [] });
    expect(out.content).toBe('b-result');
    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
  });
});
