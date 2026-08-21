import { describe, expect, it, vi } from 'vitest';

import {
  createWorkbenchProviderSetupAuthority,
  type ProviderSetupConfig,
  type ProviderSetupSecretAuthority,
} from '../../../core/v4/workbench/providerSetupAuthority';
import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';
import { listModelsForProvider } from '../../../providers/v4/modelCatalog';

class MemoryConfig implements ProviderSetupConfig {
  private readonly values = new Map<string, unknown>([
    ['model.provider', 'groq'],
    ['model.modelId', PROVIDER_REGISTRY.groq.modelIds[0]],
  ]);
  get(key: string): string | undefined {
    const value = this.values.get(key);
    return typeof value === 'string' ? value : undefined;
  }
  getValue<T>(key: string, fallback?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
  }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  async save(): Promise<void> {}
}

function fakeSecrets(): ProviderSetupSecretAuthority & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    backendHealth: () => ({ backend: 'test-os-store', available: true, protectedByOs: true, detail: 'test' }),
    health: (handle) => ({ exists: values.has(handle), available: true, protectedByOs: true, status: 'active', backend: 'test-os-store' }),
    create: vi.fn(async ({ value }) => {
      const handle = `secret_${values.size + 1}`;
      values.set(handle, value);
      return handle;
    }),
    resolve: vi.fn(async (handle) => {
      const value = values.get(handle);
      if (!value) throw new Error('missing secret');
      return value;
    }),
    replace: vi.fn(async (handle, value) => { values.set(handle, value); }),
    delete: vi.fn(async (handle) => { values.delete(handle); }),
  };
}

function harness() {
  const config = new MemoryConfig();
  const secrets = fakeSecrets();
  const sessions = new Map<string, { providerId: string | null; modelId: string | null }>();
  const resolver = {
    listProviders: () => Object.values(PROVIDER_REGISTRY),
    listModels: (providerId: string) => listModelsForProvider(providerId),
    describe: vi.fn(async ({ providerId, modelId }: { providerId: string; modelId: string }) => ({
      provider: providerId,
      model: modelId,
      apiMode: PROVIDER_REGISTRY[providerId].apiMode,
      baseUrl: PROVIDER_REGISTRY[providerId].baseUrl,
      apiKey: null,
      source: 'config',
      effectiveCredential: { configured: true },
    })),
    getLocalModelInventory: vi.fn(async () => ({
      source: 'live',
      models: [{ id: 'qwen2.5:7b', displayName: 'qwen2.5:7b' }],
    })),
  };
  const sessionStore = {
    ensureSession(id: string) {
      if (!sessions.has(id)) sessions.set(id, { providerId: null, modelId: null });
      return { id, ...sessions.get(id)! };
    },
    getSession(id: string) {
      const value = sessions.get(id);
      return value ? { id, ...value } : null;
    },
    updateSession(id: string, value: { providerId?: string | null; modelId?: string | null }) {
      const current = sessions.get(id) ?? { providerId: null, modelId: null };
      sessions.set(id, { ...current, ...value });
    },
  };
  const probe = vi.fn(async ({ providerId, modelId }: { providerId: string; modelId: string }) => ({
    state: 'complete', provider: providerId, model: modelId,
    plainCompletionStatus: 'verified', streamingStatus: 'verified', toolCallStatus: 'verified',
    toolResultReplayStatus: 'verified', structuredArgumentsStatus: 'verified',
    endpointFingerprint: 'endpoint', credentialSource: 'secure_store', transportMode: PROVIDER_REGISTRY[providerId].apiMode,
    verificationTimestamp: new Date().toISOString(), verificationErrorCategory: null,
  }));
  return {
    config, secrets, resolver, sessionStore, probe,
    authority: createWorkbenchProviderSetupAuthority({
      paths: { root: 'C:/aiden', configYaml: 'C:/aiden/config.yaml' } as any,
      config,
      resolver: resolver as any,
      secrets,
      secretScope: { ownerId: 'local-user', workspaceId: 'workspace_test' },
      sessionStore: sessionStore as any,
      probe: probe as any,
    }),
  };
}

describe('Workbench provider setup authority', () => {
  it('derives the authentication support matrix from the runtime registry', async () => {
    const { authority } = harness();
    const snapshot = await authority.snapshot();
    const oauth = snapshot.providers.find((provider) => provider.id === 'chatgpt-plus')!;
    const anthropic = snapshot.providers.find((provider) => provider.id === 'anthropic')!;
    const ollama = snapshot.providers.find((provider) => provider.id === 'ollama')!;

    expect(oauth.authKinds).toEqual(expect.arrayContaining(['oauth', 'device_code', 'subscription']));
    expect(oauth.actions).toContain('connect');
    expect(anthropic.authKinds).toEqual(['api_key']);
    expect(anthropic.authKinds).not.toContain('oauth');
    expect(ollama.authKinds).toEqual(['local']);
    expect(ollama.requiredFields).toEqual([]);
  });

  it('stores an API key only through the secret authority and returns masked state', async () => {
    const { authority, config, secrets, probe } = harness();
    const projection = await authority.connectApiKey({
      providerId: 'groq', modelId: PROVIDER_REGISTRY.groq.modelIds[0], credential: 'gsk_private_82KJ',
    });

    expect(secrets.create).toHaveBeenCalledOnce();
    expect(config.get('providers.groq.credentialHandle')).toBe('secret_1');
    expect(config.get('providers.groq.apiKey')).toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
    expect(projection.credentialHint).toBe('••••82KJ');
    expect(JSON.stringify(projection)).not.toContain('gsk_private_82KJ');
  });

  it('does not persist or replace a credential until verification succeeds', async () => {
    const { authority, config, secrets, probe } = harness();
    probe.mockRejectedValueOnce(new Error('invalid credential'));

    await expect(authority.connectApiKey({
      providerId: 'groq', modelId: PROVIDER_REGISTRY.groq.modelIds[0], credential: 'invalid_key',
    })).rejects.toThrow('invalid credential');

    expect(secrets.create).not.toHaveBeenCalled();
    expect(secrets.replace).not.toHaveBeenCalled();
    expect(config.get('providers.groq.credentialHandle')).toBeUndefined();
  });

  it('replaces and deletes the exact secure credential without returning it', async () => {
    const { authority, secrets } = harness();
    await authority.connectApiKey({
      providerId: 'groq', modelId: PROVIDER_REGISTRY.groq.modelIds[0], credential: 'first_key',
    });
    await authority.replaceCredential({
      providerId: 'groq', modelId: PROVIDER_REGISTRY.groq.modelIds[0], credential: 'second_key',
    });
    expect(secrets.replace).toHaveBeenCalledWith('secret_1', 'second_key', expect.any(Object));

    const disconnected = await authority.disconnect('groq');
    expect(secrets.delete).toHaveBeenCalledWith('secret_1', expect.any(Object));
    expect(disconnected.configured).toBe(false);
    expect(JSON.stringify(disconnected)).not.toContain('second_key');
  });

  it('keeps current-conversation and future-default model changes separate', async () => {
    const { authority, config, sessionStore } = harness();
    sessionStore.ensureSession('session_a');

    await authority.setSessionModel({ sessionId: 'session_a', providerId: 'anthropic', modelId: 'claude-sonnet-4-6' });
    expect(sessionStore.getSession('session_a')).toMatchObject({ providerId: 'anthropic', modelId: 'claude-sonnet-4-6' });
    expect(config.get('model.provider')).toBe('groq');

    await authority.setDefaultModel({ providerId: 'openai', modelId: 'gpt-5.4' });
    expect(config.get('model.provider')).toBe('openai');
    expect(config.get('model.modelId')).toBe('gpt-5.4');
    expect(sessionStore.getSession('session_a')).toMatchObject({ providerId: 'anthropic', modelId: 'claude-sonnet-4-6' });
  });

  it('refreshes Ollama from the live local inventory without requiring a key', async () => {
    const { authority, resolver } = harness();
    const provider = await authority.refreshModels('ollama');
    expect(resolver.getLocalModelInventory).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    expect(provider.models.map((model) => model.id)).toEqual(['qwen2.5:7b']);
    expect(provider.authKinds).toEqual(['local']);
  });
});
