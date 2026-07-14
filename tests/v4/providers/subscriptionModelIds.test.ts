import { describe, it, expect } from 'vitest';

import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';
import { listModelsForProvider } from '../../../providers/v4/modelCatalog';

/**
 * Phase 21 #6 — subscription model ID parity with the canonical backend list.
 *
 * The bug: subscription inference returned 400 because the catalog listed
 * direct-API names that the subscription backend does not accept. The
 * canonical list below was verified Apr 2026 through the live model endpoint.
 *
 * These tests pin the Aiden catalog to the verified verbatim list so a
 * future "improvement" doesn't re-introduce invalid slugs.
 */

const VERIFIED_SUBSCRIPTION_SLUGS = [
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.5',
  // GPT-5.6 variants — confirmed via the live response endpoint (each streams;
  // bare `gpt-5.6` is rejected 400). Tool-calling live-verified before shipping.
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
  'gpt-5',
] as const;

describe('Phase 21 #6 — subscription model IDs', () => {
  it('1. modelCatalog chatgpt-plus entries match verified slug list verbatim', () => {
    const ids = listModelsForProvider('chatgpt-plus').map((m) => m.id);
    // Same set (order may differ in catalog ordering).
    expect(new Set(ids)).toEqual(new Set(VERIFIED_SUBSCRIPTION_SLUGS));
  });

  it('2. modelCatalog chatgpt-plus excludes the historically-invalid direct-API slugs', () => {
    const ids = listModelsForProvider('chatgpt-plus').map((m) => m.id);
    // These names appear in the public SDK's typed list but the subscription
    // backend rejects them for account-based authentication.
    expect(ids).not.toContain('gpt-5-mini');
    expect(ids).not.toContain('gpt-5-codex');
  });

  it('3. PROVIDER_REGISTRY[chatgpt-plus].modelIds matches the catalog list (no drift)', () => {
    const registryIds = new Set(PROVIDER_REGISTRY['chatgpt-plus'].modelIds);
    const catalogIds = new Set(
      listModelsForProvider('chatgpt-plus').map((m) => m.id),
    );
    // Registry is the picker's source-of-truth surface; catalog is the
    // model-detail source. Drift between them was the wider 21 #5 root
    // cause — keep them aligned.
    expect(registryIds).toEqual(catalogIds);
  });
});
