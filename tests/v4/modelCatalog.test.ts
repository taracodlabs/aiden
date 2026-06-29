import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG,
  listModelsForProvider,
  findModel,
  findProvidersForModelId,
} from '../../providers/v4/modelCatalog';
import { PROVIDER_REGISTRY } from '../../providers/v4/registry';

describe('MODEL_CATALOG', () => {
  it('has at least one default model per provider', () => {
    for (const providerId of Object.keys(PROVIDER_REGISTRY)) {
      const models = listModelsForProvider(providerId);
      expect(models.length).toBeGreaterThan(0);
      const defaults = models.filter((m) => m.isDefault);
      expect(defaults.length, `provider '${providerId}' must have one default`).toBe(1);
    }
  });

  it('every entry has a positive context length', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.contextLength).toBeGreaterThan(0);
    }
  });

  it('every entry references a registered provider', () => {
    for (const m of MODEL_CATALOG) {
      expect(PROVIDER_REGISTRY[m.providerId], `unknown providerId '${m.providerId}'`).toBeDefined();
    }
  });

  it('findModel locates exact (providerId, modelId) pairs', () => {
    expect(findModel('groq', 'llama-3.3-70b-versatile')?.isDefault).toBe(true);
    expect(findModel('groq', 'nope')).toBeUndefined();
    expect(findModel('nope', 'llama-3.3-70b-versatile')).toBeUndefined();
  });

  it('v4.11 — DeepSeek V4 Pro/Flash resolve via findModel (selectable in /model)', () => {
    const pro = findModel('deepseek', 'deepseek-v4-pro');
    expect(pro).toBeDefined();
    expect(pro!.displayName).toBe('DeepSeek V4 Pro');
    expect(pro!.supportsReasoning).toBe(true);
    expect(pro!.isDefault).toBe(false);          // selectable, not default
    const flash = findModel('deepseek', 'deepseek-v4-flash');
    expect(flash).toBeDefined();
    expect(flash!.supportsReasoning).toBe(true);
    expect(flash!.isDefault).toBe(false);
    // pricing omitted (unknown — not cited in-repo).
    expect(pro!.pricing).toBeUndefined();
    expect(flash!.pricing).toBeUndefined();
    // default stays on deepseek-chat (unchanged), which now flags deprecation.
    const chat = findModel('deepseek', 'deepseek-chat');
    expect(chat!.isDefault).toBe(true);
    expect(chat!.displayName).toMatch(/deprecating 2026-07-24/);
    expect(findModel('deepseek', 'deepseek-reasoner')!.displayName).toMatch(/deprecating 2026-07-24/);
  });

  it('findProvidersForModelId surfaces all providers serving a bare model id', () => {
    // Phase 21 #5: claude-opus-4-7 is offered by both anthropic and the
    // canonical OAuth provider claude-pro (legacy claude_subscription
    // removed under the one-name-per-service unification).
    const opusServers = findProvidersForModelId('claude-opus-4-7');
    expect(opusServers.length).toBeGreaterThanOrEqual(2);
    const providers = new Set(opusServers.map((m) => m.providerId));
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('claude-pro')).toBe(true);

    // A unique-to-one-provider model returns exactly one match.
    const uniques = findProvidersForModelId('llama-3.3-70b-versatile');
    expect(uniques.length).toBe(1);
    expect(uniques[0].providerId).toBe('groq');
  });
});
