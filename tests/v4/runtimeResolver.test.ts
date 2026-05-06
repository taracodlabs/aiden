import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { RuntimeResolver, type ConfigProvider } from '../../providers/v4/runtimeResolver';
import { CredentialResolver } from '../../providers/v4/credentialResolver';
import { ProviderError } from '../../providers/v4/errors';
import { ChatCompletionsAdapter } from '../../providers/v4/chatCompletionsAdapter';
import { AnthropicAdapter } from '../../providers/v4/anthropicAdapter';
import { CodexResponsesAdapter } from '../../providers/v4/codexResponsesAdapter';
import { OllamaPromptToolsAdapter } from '../../providers/v4/ollamaPromptToolsAdapter';

let tmpDir: string;
let authPath: string;

const ENV_KEYS_TO_SAVE = [
  'GROQ_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-resolver-'));
  authPath = path.join(tmpDir, 'auth.json');
  for (const k of ENV_KEYS_TO_SAVE) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS_TO_SAVE) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function makeResolver(): RuntimeResolver {
  return new RuntimeResolver(new CredentialResolver(authPath));
}

describe('RuntimeResolver.resolve', () => {
  it('1. resolves groq + llama-3.3 → ChatCompletionsAdapter when env var set', async () => {
    process.env.GROQ_API_KEY = 'gsk-test-123';
    const adapter = await makeResolver().resolve({
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
    });
    expect(adapter).toBeInstanceOf(ChatCompletionsAdapter);
    expect(adapter.apiMode).toBe('chat_completions');
  });

  it('2. resolves anthropic + claude-opus → AnthropicAdapter', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const adapter = await makeResolver().resolve({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
    expect(adapter.apiMode).toBe('anthropic_messages');
  });

  it('3. resolves openai → CodexResponsesAdapter', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const adapter = await makeResolver().resolve({
      providerId: 'openai',
      modelId: 'gpt-5.4',
    });
    expect(adapter).toBeInstanceOf(CodexResponsesAdapter);
    expect(adapter.apiMode).toBe('codex_responses');
  });

  it('4. resolves ollama → OllamaPromptToolsAdapter (no creds needed)', async () => {
    const adapter = await makeResolver().resolve({
      providerId: 'ollama',
      modelId: 'llama3.2',
    });
    expect(adapter).toBeInstanceOf(OllamaPromptToolsAdapter);
    expect(adapter.apiMode).toBe('ollama_prompt_tools');
  });

  it('5. throws clear error for unknown model', async () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    await expect(
      makeResolver().resolve({ providerId: 'groq', modelId: 'fake-model' }),
    ).rejects.toThrow(/Model 'fake-model' not found/);
  });

  it('6. throws clear error for unknown provider', async () => {
    await expect(
      makeResolver().resolve({ providerId: 'fake-provider', modelId: 'whatever' }),
    ).rejects.toThrow(/Provider 'fake-provider' not found.*Available:/);
  });

  it('7. throws "no API key" when env var unset and no override', async () => {
    await expect(
      makeResolver().resolve({
        providerId: 'groq',
        modelId: 'llama-3.3-70b-versatile',
      }),
    ).rejects.toThrow(/No API key found for groq.*GROQ_API_KEY/);
  });

  it('8. apiKeyOverride wins over env var', async () => {
    process.env.GROQ_API_KEY = 'gsk-from-env';
    const resolution = await makeResolver().describe({
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      apiKeyOverride: 'gsk-from-cli',
    });
    expect(resolution.apiKey).toBe('gsk-from-cli');
    expect(resolution.source).toBe('cli');
  });

  it('9. config provider beats env var when both present', async () => {
    process.env.GROQ_API_KEY = 'gsk-from-env';
    const config: ConfigProvider = {
      get: (key: string) =>
        key === 'providers.groq.apiKey' ? 'gsk-from-config' : undefined,
    };
    const resolution = await makeResolver().describe({
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      config,
    });
    expect(resolution.apiKey).toBe('gsk-from-config');
    expect(resolution.source).toBe('config');
  });

  it('10. for OAuth provider with env var set, env wins over auth.json', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    await fs.writeFile(
      authPath,
      JSON.stringify({
        anthropic_messages: { type: 'api_key', apiKey: 'sk-ant-from-authjson' },
      }),
      'utf8',
    );
    const resolution = await makeResolver().describe({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
    expect(resolution.apiKey).toBe('sk-ant-env');
    expect(resolution.source).toBe('env');
  });

  it('11. for OAuth provider with no env var, auth.json is used', async () => {
    await fs.writeFile(
      authPath,
      JSON.stringify({
        anthropic_messages: { type: 'api_key', apiKey: 'sk-ant-from-authjson' },
      }),
      'utf8',
    );
    const resolution = await makeResolver().describe({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
    expect(resolution.apiKey).toBe('sk-ant-from-authjson');
    expect(resolution.source).toBe('auth.json');
  });

  it('12. refreshIfNeeded is invoked for near-expiry OAuth tokens', async () => {
    const nearExpiryIso = new Date(Date.now() + 60_000).toISOString();
    await fs.writeFile(
      authPath,
      JSON.stringify({
        anthropic_messages: {
          type: 'oauth',
          oauthToken: 'old-token',
          refreshToken: 'refresh-1',
          expiresAt: nearExpiryIso,
        },
      }),
      'utf8',
    );
    const credResolver = new CredentialResolver(authPath);
    const refreshHook = vi.fn(async (apiMode, source) => ({
      ...source,
      oauthToken: 'new-fresh-token',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }));
    credResolver.setRefreshHook(refreshHook);
    const resolver = new RuntimeResolver(credResolver);
    // Phase 21 #5: legacy `claude_subscription` removed. Use `anthropic`
    // (apiMode anthropic_messages, no oauth.providerId) to exercise the
    // same credentialResolver/auth.json fallback path the legacy stub
    // hit. The path remains as a safety net for custom-config providers.
    delete process.env.ANTHROPIC_API_KEY;
    const resolution = await resolver.describe({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
    expect(refreshHook).toHaveBeenCalled();
    expect(resolution.apiKey).toBe('new-fresh-token');
    expect(resolution.source).toBe('auth.json');
  });

  it('13. describe() returns RuntimeResolution without instantiating an adapter', async () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    const resolution = await makeResolver().describe({
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
    });
    expect(resolution.provider).toBe('groq');
    expect(resolution.apiMode).toBe('chat_completions');
    expect(resolution.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(resolution.apiKey).toBe('gsk-test');
    expect(resolution.source).toBe('env');
  });

  it('14. listProviders returns at least 19 entries', () => {
    expect(makeResolver().listProviders().length).toBeGreaterThanOrEqual(19);
  });

  it('15. listModels(providerId) returns provider-specific models, empty for unknown', () => {
    const resolver = makeResolver();
    const groqModels = resolver.listModels('groq');
    expect(groqModels.length).toBeGreaterThan(0);
    expect(groqModels.every((m) => m.providerId === 'groq')).toBe(true);
    expect(resolver.listModels('does-not-exist')).toEqual([]);
  });

  it('16. baseUrlOverride is honored on custom_openai', async () => {
    process.env.CUSTOM_OPENAI_API_KEY = 'cust-test';
    const resolution = await makeResolver().describe({
      providerId: 'custom_openai',
      modelId: 'custom-default',
      baseUrlOverride: 'http://my-host:9000/v1',
    });
    expect(resolution.baseUrl).toBe('http://my-host:9000/v1');
  });
});
