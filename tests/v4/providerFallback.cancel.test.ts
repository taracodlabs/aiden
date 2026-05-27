/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 3 — Phase A audit A6.4 amendment.
 *
 * Verifies the between-slot pre-flight AbortSignal check in:
 *   1. runFallbackChain (the pure walker used by non-streaming dispatch)
 *   2. FallbackAdapter.callStream (the streaming variant)
 *
 * Without this guard, a user Ctrl+C between two slot attempts wastes
 * the next slot's TPM + risks shipping a partial token stream. With
 * it, the chain throws a synthetic AbortError on the NEXT iteration
 * boundary, matching the same shape per-slot adapters surface when
 * fetch aborts mid-flight.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runFallbackChain,
  FallbackAdapter,
  type ProviderSlot,
} from '../../core/v4/providerFallback';
import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  StreamEvent,
} from '../../providers/v4/types';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSlot(id: string, build: () => ProviderAdapter | null): ProviderSlot {
  return {
    id,
    providerId: id,
    modelId:    'm',
    keyPresent: true,
    keyTail:    '1234',
    build,
  };
}

const okOutput: ProviderCallOutput = {
  content:      'ok',
  toolCalls:    [],
  finishReason: 'stop',
  usage:        { inputTokens: 1, outputTokens: 1 },
};

function okAdapter(label: string): ProviderAdapter {
  return {
    apiMode: 'chat_completions',
    call:    vi.fn(async () => ({ ...okOutput, content: `ok:${label}` })),
  };
}

function rateLimitAdapter(label: string): ProviderAdapter {
  return {
    apiMode: 'chat_completions',
    call:    vi.fn(async () => {
      const err = new Error(`Provider ${label} rate limited`);
      throw err;
    }),
  };
}

// ── runFallbackChain ────────────────────────────────────────────────────

describe('runFallbackChain — A6.4 between-slot signal check (v4.11 Slice 3)', () => {
  it('throws AbortError immediately when signal is pre-aborted (no adapter built)', async () => {
    const slot0Build = vi.fn(() => okAdapter('a'));
    const slot1Build = vi.fn(() => okAdapter('b'));
    const slots = [makeSlot('a', slot0Build), makeSlot('b', slot1Build)];

    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      runFallbackChain(slots, async (a) => a.call({ messages: [], tools: [] }), {}, undefined, {
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The pre-flight check fires BEFORE slot.build(). Neither builder runs.
    expect(slot0Build).not.toHaveBeenCalled();
    expect(slot1Build).not.toHaveBeenCalled();
  });

  it('aborts between slots after a 429 throw — next slot is NOT attempted', async () => {
    // Slot 0 throws rate-limit (chain would normally advance). Before
    // slot 1's adapter is built, an abort fires. Expect AbortError +
    // slot 1's adapter.call NEVER invoked.
    const ctrl   = new AbortController();
    const adapt0 = rateLimitAdapter('a');
    const adapt1Call = vi.fn(async () => okOutput);
    const adapt1: ProviderAdapter = { apiMode: 'chat_completions', call: adapt1Call };

    const slot0Build = vi.fn(() => adapt0);
    const slot1Build = vi.fn(() => adapt1);
    const slots = [makeSlot('a', slot0Build), makeSlot('b', slot1Build)];

    // requestFn proxies adapter.call AND triggers abort on slot 'a' failure.
    const requestFn = async (adapter: ProviderAdapter): Promise<ProviderCallOutput> => {
      try {
        return await adapter.call({ messages: [], tools: [] });
      } catch (e) {
        // Simulate Ctrl+C arriving DURING the catch (between-slot window).
        ctrl.abort();
        throw e;
      }
    };

    await expect(
      runFallbackChain(slots, requestFn, {}, undefined, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(slot0Build).toHaveBeenCalled();
    expect(adapt0.call).toHaveBeenCalledTimes(1);
    // slot 1 was built? No — pre-flight check fires before .build().
    expect(slot1Build).not.toHaveBeenCalled();
    expect(adapt1Call).not.toHaveBeenCalled();
  });

  it('a per-slot AbortError short-circuits — chain does NOT advance', async () => {
    // Mimic the per-adapter abort surface: the adapter throws an
    // AbortError directly (e.g. fetch's signal aborted mid-flight).
    // The chain must not interpret it as rate-limit and try the next.
    const abortErr = new Error('abort');
    abortErr.name = 'AbortError';
    const adapt0: ProviderAdapter = {
      apiMode: 'chat_completions',
      call:    vi.fn(async () => { throw abortErr; }),
    };
    const adapt1Call = vi.fn(async () => okOutput);
    const adapt1: ProviderAdapter = { apiMode: 'chat_completions', call: adapt1Call };

    const slots = [makeSlot('a', () => adapt0), makeSlot('b', () => adapt1)];

    await expect(
      runFallbackChain(slots, async (a) => a.call({ messages: [], tools: [] })),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(adapt0.call).toHaveBeenCalledTimes(1);
    expect(adapt1Call).not.toHaveBeenCalled();
  });

  it('omitting options leaves pre-Slice-3 behaviour intact', async () => {
    // Backwards-compat: signature is options? — undefined preserves the
    // existing chain semantics (advance on 429, success on first ok).
    const slots = [
      makeSlot('a', () => rateLimitAdapter('a')),
      makeSlot('b', () => okAdapter('b')),
    ];
    const result = await runFallbackChain(
      slots,
      async (a) => a.call({ messages: [], tools: [] }),
    );
    expect(result.slotId).toBe('b');
    expect(result.value.content).toBe('ok:b');
  });
});

// ── FallbackAdapter ─────────────────────────────────────────────────────

describe('FallbackAdapter — A6.4 between-slot signal check (v4.11 Slice 3)', () => {
  it('call() — pre-aborted input.signal short-circuits before any slot builds', async () => {
    const slot0Build = vi.fn(() => okAdapter('a'));
    const slots = [makeSlot('a', slot0Build)];

    const adapter = new FallbackAdapter({ apiMode: 'chat_completions', slots });
    const ctrl    = new AbortController();
    ctrl.abort();

    await expect(
      adapter.call({ messages: [], tools: [], signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(slot0Build).not.toHaveBeenCalled();
  });

  it('callStream() — pre-aborted input.signal throws AbortError before any slot streams', async () => {
    const streamFn = vi.fn(async function* (): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'done', output: okOutput };
    });
    const adapt0: ProviderAdapter = {
      apiMode:    'chat_completions',
      call:       async () => okOutput,
      callStream: streamFn,
    };
    const slot0Build = vi.fn(() => adapt0);
    const adapter = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots:   [makeSlot('a', slot0Build)],
    });

    const ctrl = new AbortController();
    ctrl.abort();

    const input: ProviderCallInput = { messages: [], tools: [], signal: ctrl.signal };
    const gen = adapter.callStream(input);

    await expect(gen.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(slot0Build).not.toHaveBeenCalled();
    expect(streamFn).not.toHaveBeenCalled();
  });

  it('callStream() — abort BETWEEN slots stops at the boundary', async () => {
    const ctrl = new AbortController();
    // Slot 0: rate-limit error pre-yield → chain would normally advance.
    const adapt0: ProviderAdapter = {
      apiMode:    'chat_completions',
      call:       async () => okOutput,
      callStream: async function* () {
        // Throw rate-limit BEFORE yielding. Then abort fires before
        // the next iteration starts.
        ctrl.abort();
        throw new Error('Provider a rate limited');
        // eslint-disable-next-line no-unreachable
        yield { type: 'done', output: okOutput };
      },
    };
    const adapt1Stream = vi.fn(async function* (): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'done', output: okOutput };
    });
    const adapt1: ProviderAdapter = {
      apiMode:    'chat_completions',
      call:       async () => okOutput,
      callStream: adapt1Stream,
    };
    const slot1Build = vi.fn(() => adapt1);

    const adapter = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots:   [makeSlot('a', () => adapt0), makeSlot('b', slot1Build)],
    });

    const input: ProviderCallInput = { messages: [], tools: [], signal: ctrl.signal };
    const events: StreamEvent[] = [];
    let caught: unknown = null;
    try {
      for await (const evt of adapter.callStream(input)) {
        events.push(evt);
      }
    } catch (e) {
      caught = e;
    }

    // No tokens yielded; AbortError surfaces; slot b never touched.
    expect(events).toHaveLength(0);
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(slot1Build).not.toHaveBeenCalled();
    expect(adapt1Stream).not.toHaveBeenCalled();
  });
});
