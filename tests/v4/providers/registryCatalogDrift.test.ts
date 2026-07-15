import { describe, it, expect } from 'vitest';

import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';
import { findModel, listModelsForProvider } from '../../../providers/v4/modelCatalog';

/**
 * Registry ↔ catalog drift guard.
 *
 * PROVIDER_REGISTRY.modelIds is the picker / setup-wizard surface;
 * MODEL_CATALOG is the model-detail source. Drift between them causes
 * "model not found" at runtime when the fallback chain or defaults
 * reference a catalog entry the registry never advertises.
 */
describe('registry ↔ catalog drift guard', () => {
  it('every registry.modelIds entry resolves in MODEL_CATALOG for that provider', () => {
    const missing: string[] = [];

    for (const [providerId, entry] of Object.entries(PROVIDER_REGISTRY)) {
      for (const modelId of entry.modelIds) {
        if (!findModel(providerId, modelId)) {
          missing.push(`${providerId}:${modelId}`);
        }
      }
    }

    expect(missing, `registry modelIds missing from catalog: ${missing.join(', ')}`).toEqual([]);
  });

  it('every catalog isDefault model appears in registry.modelIds for that provider', () => {
    const missing: string[] = [];

    for (const providerId of Object.keys(PROVIDER_REGISTRY)) {
      const registryIds = new Set(PROVIDER_REGISTRY[providerId].modelIds);
      const defaults = listModelsForProvider(providerId).filter((m) => m.isDefault);

      for (const model of defaults) {
        if (!registryIds.has(model.id)) {
          missing.push(`${providerId}:${model.id} (default)`);
        }
      }
    }

    expect(missing, `catalog defaults missing from registry: ${missing.join(', ')}`).toEqual([]);
  });

  it('together registry includes gpt-oss defaults used by fallback chain and setup wizard', () => {
    const ids = PROVIDER_REGISTRY.together.modelIds;
    expect(ids).toContain('openai/gpt-oss-120b');
    expect(ids).toContain('openai/gpt-oss-20b');
  });

  it('deepseek registry includes deepseek-v4-flash from catalog', () => {
    const ids = PROVIDER_REGISTRY.deepseek.modelIds;
    expect(ids).toContain('deepseek-v4-flash');
    expect(findModel('deepseek', 'deepseek-v4-flash')).toBeDefined();
  });
});
