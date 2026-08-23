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
      coding: async () => ({
        ready: false, state: 'unsupported_model' as const, reason: 'Configured model is unsupported',
        provider: 'Codex CLI', executable: 'codex', executableSource: 'path' as const,
        version: '0.147.0', model: 'unsupported-model', modelValidation: 'unsupported_model' as const,
        authentication: 'ready', authenticationMode: 'chatgpt_account' as const,
        isolation: 'available' as const, network: 'disabled_by_default' as const,
      }),
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
    expect(result.items.find((item) => item.id === 'coding-provider')).toMatchObject({
      state: 'needs_attention', supported: true, configured: true, authenticated: true,
      runtimeAvailable: true, permissionAvailable: true, validationAvailable: false,
      ready: false, recommendedAction: 'Choose a supported coding model.',
    });
    expect(result.items.find((item) => item.id === 'apps')).toMatchObject({ state: 'setup_available', blocking: false });
    expect(result.items.find((item) => item.id === 'browser')).toMatchObject({ state: 'ready' });
    expect(result.items.find((item) => item.id === 'presence')).toMatchObject({ state: 'ready', category: 'presence' });
  });

  it('does not classify unconfigured optional capabilities as attention issues', async () => {
    const authority = createSystemReadinessAuthority({
      providers: async () => ({
        defaultSelection: { providerId: 'groq', modelId: 'model' }, sessionSelection: null,
        providers: [{
          id: 'groq', displayName: 'Groq', description: '', authKinds: ['api_key'], requiredFields: ['apiKey'],
          actions: ['test'], connectionState: 'ready', configured: true, healthy: true,
          models: [], currentModel: 'model', default: true,
        }],
      }),
      coding: async () => ({
        ready: false, state: 'not_configured' as const, reason: 'Coding model is not selected.',
        provider: 'Codex CLI', executable: 'codex', executableSource: 'path' as const,
        version: '0.147.0', model: null, modelValidation: 'not_configured' as const,
        authentication: 'ready', authenticationMode: 'chatgpt_account' as const,
        isolation: 'available' as const, network: 'disabled_by_default' as const,
      }),
      apps: async () => ({ providers: [{ id: 'composio', label: 'Composio', health: 'not_configured' }], accounts: [] }),
      browser: async () => ({ ready: false, detail: 'Browser access can be enabled later.', grantRequired: true }),
      workspace: async () => ({ ready: true, detail: 'Workspace is available' }),
      evidence: async () => ({ ready: true, detail: 'Evidence is ready' }),
      approvals: async () => ({ ready: true, detail: 'Approvals are ready' }),
      automations: async () => ({ ready: false, entitled: false, detail: 'Not enabled.' }),
      presence: async () => ({ ready: false, entitled: false, detail: 'Not enabled.' }),
    });
    const result = await authority.snapshot();
    expect(result.overall).toBe('ready');
    expect(result.issues).toEqual([]);
    expect(result.items.find((item) => item.id === 'coding-provider')).toMatchObject({
      state: 'setup_available', configured: false, ready: false,
    });
    expect(result.items.find((item) => item.id === 'apps')).toMatchObject({ state: 'setup_available' });
  });
});
