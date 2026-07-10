/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-bug1 — `resolveBootProvider` unit coverage.
 *
 * Verifies the resolution-precedence ladder (CLI both → CLI partial →
 * config both → config partial → auto-priority → null fallback).
 * The enumerator is mocked so this test is independent of the live
 * tokenStore / env state.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveBootProvider,
  BOOT_PRIORITY,
  findProviderForModel,
  type BootSelection,
} from '../../../cli/v4/providerBootSelector';
import type { ConfiguredProvider } from '../../../cli/v4/doctorLiveness';
import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';

/** Build a `ConfiguredProvider` record from the live registry entry. */
function cp(id: string, configured: boolean): ConfiguredProvider {
  const entry = PROVIDER_REGISTRY[id];
  if (!entry) throw new Error(`unknown provider in test fixture: ${id}`);
  return {
    entry,
    model: entry.modelIds[0] ?? '',
    configured,
    ...(configured ? {} : { reason: 'test stub: not configured' }),
  };
}

function enumerator(list: ConfiguredProvider[]): () => Promise<ConfiguredProvider[]> {
  return async () => list;
}

describe('resolveBootProvider', () => {
  it('Case 1: both CLI flags → use them verbatim, source=cli-flag', async () => {
    const out = await resolveBootProvider(
      { cliProviderId: 'groq', cliModelId: 'mixtral-8x7b-32768' },
      enumerator([]),
    );
    expect(out).toEqual({
      providerId: 'groq', modelId: 'mixtral-8x7b-32768', source: 'cli-flag',
    } satisfies BootSelection);
  });

  it('Case 2a: --provider only resolves the model via pickProbeModel', async () => {
    const out = await resolveBootProvider(
      { cliProviderId: 'chatgpt-plus' },
      enumerator([]),
    );
    expect(out?.providerId).toBe('chatgpt-plus');
    // chatgpt-plus's modelIds[0..3] are codex-* slugs; pickProbeModel
    // skips them and lands on gpt-5.5.
    expect(out?.modelId).toBe('gpt-5.5');
    expect(out?.source).toBe('cli-flag-partial');
  });

  it('Case 2b: --model only picks the matching provider', async () => {
    // claude-opus-4-7 is served by anthropic (API-key) — the sole provider
    // for the bare id now that the Claude subscription route is gone.
    const out = await resolveBootProvider(
      { cliModelId: 'claude-opus-4-7' },
      enumerator([]),
    );
    expect(out?.providerId).toBe('anthropic');
    expect(out?.modelId).toBe('claude-opus-4-7');
    expect(out?.source).toBe('cli-flag-partial');
  });

  it('Case 2b: --model unknown throws a helpful error', async () => {
    await expect(
      resolveBootProvider({ cliModelId: 'definitely-not-a-real-model' }, enumerator([])),
    ).rejects.toThrow(/not declared by any provider/);
  });

  it('Case 2a: --provider unknown throws when no model could be inferred', async () => {
    await expect(
      resolveBootProvider({ cliProviderId: 'imaginary-provider' }, enumerator([])),
    ).rejects.toThrow(/no model could be inferred/);
  });

  it('Case 3: persisted config (both) wins over auto-pick', async () => {
    // Even if chatgpt-plus is configured, persisted config takes precedence.
    const out = await resolveBootProvider(
      { cfgProviderId: 'groq', cfgModelId: 'llama-3.1-70b-versatile' },
      enumerator([cp('chatgpt-plus', true), cp('groq', true)]),
    );
    expect(out).toEqual({
      providerId: 'groq', modelId: 'llama-3.1-70b-versatile', source: 'persisted-config',
    } satisfies BootSelection);
  });

  it('Case 4a: config provider only → resolve model via pickProbeModel', async () => {
    const out = await resolveBootProvider(
      { cfgProviderId: 'chatgpt-plus' },
      enumerator([]),
    );
    expect(out?.providerId).toBe('chatgpt-plus');
    expect(out?.modelId).toBe('gpt-5.5');
    expect(out?.source).toBe('config-partial');
  });

  it('Case 4a: config provider unknown → falls through to auto-pick', async () => {
    const out = await resolveBootProvider(
      { cfgProviderId: 'unknown-provider' },
      enumerator([cp('groq', true)]),
    );
    expect(out?.providerId).toBe('groq');
    expect(out?.source).toBe('auto-priority');
  });

  it('Case 4b: config model only resolves to its provider', async () => {
    const out = await resolveBootProvider(
      { cfgModelId: 'claude-opus-4-7' },
      enumerator([]),
    );
    // anthropic is the sole provider for this bare id.
    expect(out?.providerId).toBe('anthropic');
    expect(out?.modelId).toBe('claude-opus-4-7');
    expect(out?.source).toBe('config-partial');
  });

  it('Case 4b: config model unknown falls through to auto-pick', async () => {
    const out = await resolveBootProvider(
      { cfgModelId: 'unknown-model-xyz' },
      enumerator([cp('openai', true)]),
    );
    expect(out?.providerId).toBe('openai');
    expect(out?.source).toBe('auto-priority');
  });

  describe('Case 5: priority-list auto-pick', () => {
    it('picks chatgpt-plus when authed, even if others are too', async () => {
      const out = await resolveBootProvider(
        {},
        enumerator([
          cp('groq', true), cp('chatgpt-plus', true),
          cp('anthropic', true), cp('openai', true),
        ]),
      );
      expect(out?.providerId).toBe('chatgpt-plus');
      expect(out?.modelId).toBe('gpt-5.5');
      expect(out?.source).toBe('auto-priority');
    });

    it('falls through to anthropic when chatgpt-plus is not authed', async () => {
      const out = await resolveBootProvider(
        {},
        enumerator([
          cp('chatgpt-plus', false),
          cp('anthropic', true), cp('groq', true),
        ]),
      );
      expect(out?.providerId).toBe('anthropic');
    });

    it('skips unauthed entries even if they sit at priority 1', async () => {
      const out = await resolveBootProvider(
        {},
        enumerator([
          cp('chatgpt-plus', false),
          cp('anthropic', false), cp('openai', false),
          cp('groq', true),
        ]),
      );
      expect(out?.providerId).toBe('groq');
      expect(out?.source).toBe('auto-priority');
    });
  });

  it('Case 6: nothing authed returns null (caller falls back to hardcoded)', async () => {
    const out = await resolveBootProvider(
      {},
      enumerator([
        cp('chatgpt-plus', false),
        cp('anthropic', false), cp('openai', false),
        cp('groq', false), cp('ollama', false),
      ]),
    );
    expect(out).toBeNull();
  });

  it('returns null when enumerator returns an empty list', async () => {
    const out = await resolveBootProvider({}, enumerator([]));
    expect(out).toBeNull();
  });

  it('CLI flag beats persisted config (both set)', async () => {
    const out = await resolveBootProvider(
      {
        cliProviderId: 'openai', cliModelId: 'gpt-5-mini',
        cfgProviderId: 'groq', cfgModelId: 'llama-3.3-70b-versatile',
      },
      enumerator([cp('chatgpt-plus', true)]),
    );
    expect(out?.providerId).toBe('openai');
    expect(out?.modelId).toBe('gpt-5-mini');
    expect(out?.source).toBe('cli-flag');
  });
});

describe('BOOT_PRIORITY (sanity)', () => {
  it('places chatgpt-plus first, ollama last', () => {
    expect(BOOT_PRIORITY[0]).toBe('chatgpt-plus');
    expect(BOOT_PRIORITY[BOOT_PRIORITY.length - 1]).toBe('ollama');
  });
  it('every entry exists in the live PROVIDER_REGISTRY', () => {
    for (const id of BOOT_PRIORITY) {
      expect(PROVIDER_REGISTRY[id]).toBeDefined();
    }
  });
  // Phase v4.1.2-deepseek: deepseek sits between openai and groq.
  // Paid tier, strong tool-caller; placed above groq because groq's
  // free-tier tool emission was the original first-run UX bug.
  it('deepseek is positioned between openai and groq', () => {
    const i_openai   = BOOT_PRIORITY.indexOf('openai');
    const i_deepseek = BOOT_PRIORITY.indexOf('deepseek');
    const i_groq     = BOOT_PRIORITY.indexOf('groq');
    expect(i_deepseek).toBeGreaterThan(-1);
    expect(i_openai).toBeLessThan(i_deepseek);
    expect(i_deepseek).toBeLessThan(i_groq);
  });
});

describe('priority-list auto-pick across deepseek (Phase v4.1.2-deepseek)', () => {
  it('picks deepseek when openai/anthropic/chatgpt-plus all unauthed but deepseek is', async () => {
    const out = await resolveBootProvider(
      {},
      enumerator([
        cp('chatgpt-plus', false),
        cp('anthropic', false),    cp('openai', false),
        cp('deepseek', true),      cp('groq', true),
      ]),
    );
    expect(out?.providerId).toBe('deepseek');
    expect(out?.modelId).toBe('deepseek-v4-pro'); // first non-codex in modelIds
    expect(out?.source).toBe('auto-priority');
  });

  it('openai still wins over deepseek when both authed', async () => {
    const out = await resolveBootProvider(
      {},
      enumerator([
        cp('chatgpt-plus', false),
        cp('anthropic', false),    cp('openai', true),
        cp('deepseek', true),
      ]),
    );
    expect(out?.providerId).toBe('openai');
  });

  it('deepseek still beats groq when both authed', async () => {
    const out = await resolveBootProvider(
      {},
      enumerator([
        cp('chatgpt-plus', false),
        cp('anthropic', false),    cp('openai', false),
        cp('deepseek', true),      cp('groq', true),
      ]),
    );
    expect(out?.providerId).toBe('deepseek');
  });
});

describe('findProviderForModel', () => {
  it('finds anthropic for a claude model id', () => {
    // anthropic (API key) is the sole provider for claude-opus-4-7 now that
    // the Claude subscription route is removed.
    const entry = findProviderForModel('claude-opus-4-7');
    expect(entry?.id).toBe('anthropic');
  });
  it('returns null for unknown models', () => {
    expect(findProviderForModel('nope-not-a-model')).toBeNull();
  });
});
