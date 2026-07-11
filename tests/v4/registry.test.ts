import { describe, it, expect } from 'vitest';
import { PROVIDER_REGISTRY, listProviderIds, getProviderEntry } from '../../providers/v4/registry';
import type { ApiMode } from '../../providers/v4/types';

const ALL_API_MODES: ApiMode[] = [
  'chat_completions',
  'anthropic_messages',
  'codex_responses',
  'ollama_prompt_tools',
];

describe('PROVIDER_REGISTRY', () => {
  it('has at least 18 providers registered', () => {
    expect(listProviderIds().length).toBeGreaterThanOrEqual(18);
  });

  it('every entry has all required fields populated', () => {
    for (const [id, entry] of Object.entries(PROVIDER_REGISTRY)) {
      expect(entry.id).toBe(id);
      expect(entry.displayName).toBeTruthy();
      expect(entry.baseUrl).toMatch(/^https?:\/\//);
      expect(entry.description).toBeTruthy();
      expect(['pro', 'free', 'paid', 'local', 'subscription']).toContain(entry.tier);
      expect(['local', 'free', 'subscription', 'paid']).toContain(entry.billingTier);
      expect(typeof entry.hasFreeTier).toBe('boolean');
      expect(typeof entry.supportsToolCalling).toBe('boolean');
      expect(Array.isArray(entry.modelIds)).toBe(true);
    }
  });

  it('covers all four ApiModes from types.ts', () => {
    const modesUsed = new Set(Object.values(PROVIDER_REGISTRY).map((e) => e.apiMode));
    for (const mode of ALL_API_MODES) {
      expect(modesUsed.has(mode)).toBe(true);
    }
  });

  it('has non-empty modelIds for every non-OAuth-only provider', () => {
    for (const entry of Object.values(PROVIDER_REGISTRY)) {
      expect(entry.modelIds.length).toBeGreaterThan(0);
    }
  });

  it('OAuth-only providers (apiKeyEnvVar=null) are subscription or local tier', () => {
    for (const entry of Object.values(PROVIDER_REGISTRY)) {
      if (entry.apiKeyEnvVar === null) {
        expect(['subscription', 'local']).toContain(entry.tier);
      }
    }
  });

  it('getProviderEntry returns the entry for known ids and undefined otherwise', () => {
    expect(getProviderEntry('groq')?.id).toBe('groq');
    expect(getProviderEntry('does-not-exist')).toBeUndefined();
  });
});
