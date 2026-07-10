import { describe, it, expect } from 'vitest';

import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';
import { listModelsForProvider } from '../../../providers/v4/modelCatalog';

/**
 * Phase 21 #6 — Codex model ID parity with the canonical Codex backend list.
 *
 * The bug: ChatGPT Plus inference returned 400 "model is not supported
 * when using Codex with a ChatGPT account" because Aiden's catalog
 * listed direct-OpenAI-API names (`gpt-5-mini`, `gpt-5-codex`) that
 * the Codex OAuth backend doesn't accept. The canonical list below was
 * verified Apr 2026 via live /codex/models probe.
 *
 * These tests pin the Aiden catalog to the verified verbatim list so a
 * future "improvement" doesn't re-introduce invalid slugs.
 */

const VERIFIED_CODEX_SLUGS = [
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.5',
  // GPT-5.6 variants — confirmed via live /codex/responses probe (each streams;
  // bare `gpt-5.6` is rejected 400). Tool-calling live-verified before shipping.
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
  'gpt-5',
] as const;

describe('Phase 21 #6 — Codex OAuth model IDs', () => {
  it('1. modelCatalog chatgpt-plus entries match verified slug list verbatim', () => {
    const ids = listModelsForProvider('chatgpt-plus').map((m) => m.id);
    // Same set (order may differ in catalog ordering).
    expect(new Set(ids)).toEqual(new Set(VERIFIED_CODEX_SLUGS));
  });

  it('2. modelCatalog chatgpt-plus excludes the historically-invalid direct-API slugs', () => {
    const ids = listModelsForProvider('chatgpt-plus').map((m) => m.id);
    // These names appear in the OpenAI Python SDK's typed list but the
    // Codex backend rejects them for ChatGPT-account auth.
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
