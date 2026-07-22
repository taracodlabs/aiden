import { describe, expect, it } from 'vitest';
import {
  deduplicateRuntimeSlots,
  providerRuntimeIdentity,
} from '../../../providers/v4/providerIdentity';
import { PROVIDERS } from '../../../cli/v4/setupWizard';
import { getProviderEntry } from '../../../providers/v4/registry';

describe('provider runtime identity', () => {
  it('deduplicates only the exact provider, endpoint, credential, and model tuple', () => {
    const base = {
      provider: 'groq',
      endpointFingerprint: 'endpoint-a',
      credentialFingerprint: 'credential-a',
      model: 'model-a',
    };
    expect(providerRuntimeIdentity(base)).toBe(providerRuntimeIdentity({ ...base, provider: 'GROQ' }));
    expect(providerRuntimeIdentity(base)).not.toBe(providerRuntimeIdentity({ ...base, model: 'model-b' }));
    expect(providerRuntimeIdentity(base)).not.toBe(providerRuntimeIdentity({ ...base, credentialFingerprint: 'credential-b' }));
    expect(providerRuntimeIdentity(base)).not.toBe(providerRuntimeIdentity({ ...base, endpointFingerprint: 'endpoint-b' }));
  });

  it('removes a primary identity repeated in defaults', () => {
    const slots = [
      { id: 'same', identity: 'primary' },
      { id: 'other', identity: 'other' },
    ];
    expect(deduplicateRuntimeSlots(slots, ['primary']).map((slot) => slot.id)).toEqual(['other']);
  });

  it('deduplicates the same credential exposed through two sources', () => {
    const slots = [
      { id: 'managed', identity: 'provider|endpoint|credential|model' },
      { id: 'process', identity: 'provider|endpoint|credential|model' },
    ];
    expect(deduplicateRuntimeSlots(slots).map((slot) => slot.id)).toEqual(['managed']);
  });

  it('preserves different credentials at the same endpoint', () => {
    const slots = [
      { id: 'one', identity: 'provider|endpoint|credential-one|model' },
      { id: 'two', identity: 'provider|endpoint|credential-two|model' },
    ];
    expect(deduplicateRuntimeSlots(slots)).toEqual(slots);
  });

  it('preserves different models for the same credential', () => {
    const slots = [
      { id: 'main', identity: 'provider|endpoint|credential|model-main' },
      { id: 'small', identity: 'provider|endpoint|credential|model-small' },
    ];
    expect(deduplicateRuntimeSlots(slots)).toEqual(slots);
  });

  it('keeps several additional credential slots in deterministic order', () => {
    const slots = [
      { id: 'one', identity: 'provider|endpoint|one|model' },
      { id: 'two', identity: 'provider|endpoint|two|model' },
      { id: 'three', identity: 'provider|endpoint|three|model' },
    ];
    expect(deduplicateRuntimeSlots(slots).map((slot) => slot.id)).toEqual(['one', 'two', 'three']);
  });

  it('uses the same provider identity and managed credential name in setup and runtime', () => {
    for (const setup of PROVIDERS.filter((provider) =>
      provider.kind === 'key' || provider.kind === 'custom' || provider.kind === 'subscription')) {
      const runtime = getProviderEntry(setup.id);
      expect(runtime, setup.id).toBeDefined();
      expect(setup.envVar, setup.id).toBe(runtime?.apiKeyEnvVar);
    }
  });
});
