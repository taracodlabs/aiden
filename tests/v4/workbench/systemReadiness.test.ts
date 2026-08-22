import { describe, expect, it } from 'vitest';

import { createSystemReadinessAuthority } from '../../../core/v4/workbench/systemReadiness';

describe('Workbench system readiness projection', () => {
  it('aggregates truthful capability health without treating configuration as readiness', async () => {
    const authority = createSystemReadinessAuthority({
      providers: async () => ({
        defaultSelection: { providerId: 'groq', modelId: 'model' }, sessionSelection: null,
        providers: [{
          id: 'groq', displayName: 'Groq', description: '', authKinds: ['api_key'], requiredFields: ['apiKey'],
          actions: ['test'], connectionState: 'needs_attention', configured: true, healthy: false,
          models: [], currentModel: 'model', default: true,
        }],
      }),
      coding: async () => ({ ready: false, reason: 'Configured model is unsupported', isolation: 'available' }),
      apps: async () => ({ providers: [{ id: 'composio', label: 'Composio', health: 'not_configured' }], accounts: [] }),
      browser: async () => ({ ready: true, detail: 'Browser plugin is loaded', grantRequired: false }),
      workspace: async () => ({ ready: true, detail: 'Workspace is available' }),
      evidence: async () => ({ ready: true, detail: 'Durable Evidence storage is available' }),
      approvals: async () => ({ ready: true, detail: 'Exact-action approvals are protected' }),
      presence: async () => ({ ready: true, entitled: true, detail: 'Durable attention projection is ready' }),
    });

    const result = await authority.snapshot();
    expect(result.overall).toBe('needs_attention');
    expect(result.items.find((item) => item.id === 'chat-provider')).toMatchObject({
      state: 'needs_attention', configured: true, healthy: false, blocking: true,
    });
    expect(result.items.find((item) => item.id === 'coding-provider')).toMatchObject({ state: 'needs_setup' });
    expect(result.items.find((item) => item.id === 'apps')).toMatchObject({ state: 'setup_available', blocking: false });
    expect(result.items.find((item) => item.id === 'browser')).toMatchObject({ state: 'ready' });
    expect(result.items.find((item) => item.id === 'presence')).toMatchObject({ state: 'ready', category: 'presence' });
  });
});
