import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ModelSwitcher } from '../../providers/v4/modelSwitch';
import { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import { CredentialResolver } from '../../providers/v4/credentialResolver';

let tmpDir: string;
let authPath: string;
const ENV_KEYS = ['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'TOGETHER_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-modsw-'));
  authPath = path.join(tmpDir, 'auth.json');
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function makeSwitcher(): ModelSwitcher {
  return new ModelSwitcher(new RuntimeResolver(new CredentialResolver(authPath)));
}

describe('ModelSwitcher.parse', () => {
  it('1. parses provider:model into structured form', () => {
    const parsed = makeSwitcher().parse('anthropic:claude-opus-4-7');
    expect(parsed.providerId).toBe('anthropic');
    expect(parsed.modelId).toBe('claude-opus-4-7');
  });

  it('2. resolves bare model id to its provider via catalog walk', () => {
    const parsed = makeSwitcher().parse('llama-3.3-70b-versatile');
    expect(parsed.providerId).toBe('groq');
    expect(parsed.modelId).toBe('llama-3.3-70b-versatile');
  });

  it('3. throws on ambiguous bare model with options listed', () => {
    // gpt-5.4 is served by both chatgpt-plus (OAuth) and openai (API key).
    expect(() => makeSwitcher().parse('gpt-5.4')).toThrow(
      /ambiguous.*Did you mean.*chatgpt-plus:gpt-5\.4/,
    );
  });

  it('4. throws "model not found" for unknown bare specs', () => {
    expect(() => makeSwitcher().parse('totally-fake-model-xyz')).toThrow(
      /Model 'totally-fake-model-xyz' not found/,
    );
  });

  it('5. empty / whitespace-only spec throws clear error', () => {
    expect(() => makeSwitcher().parse('')).toThrow(/Model spec is empty/);
    expect(() => makeSwitcher().parse('   ')).toThrow(/Model spec is empty/);
  });

  it('6. preserves colons inside model id when prefix is not a known provider (ollama qwen2.5:7b)', () => {
    // qwen2.5:7b is a bare ollama model id with a colon. The first colon
    // splits "qwen2.5" / "7b" — "qwen2.5" is NOT a registered provider,
    // so parser falls back to bare-model lookup on the full string.
    const parsed = makeSwitcher().parse('qwen2.5:7b');
    expect(parsed.providerId).toBe('ollama');
    expect(parsed.modelId).toBe('qwen2.5:7b');
  });

  it('7. preserves colons inside model id with explicit provider prefix', () => {
    const parsed = makeSwitcher().parse('ollama:qwen2.5:7b');
    expect(parsed.providerId).toBe('ollama');
    expect(parsed.modelId).toBe('qwen2.5:7b');
  });
});

describe('ModelSwitcher.switch', () => {
  it('8. instantiates a new adapter for a valid spec', async () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    const result = await makeSwitcher().switch({
      spec: 'groq:llama-3.3-70b-versatile',
    });
    expect(result.newAdapter).toBeDefined();
    expect(result.newProvider.id).toBe('groq');
    expect(result.newModel.id).toBe('llama-3.3-70b-versatile');
    expect(result.changed).toBe(true);
  });

  it('9. changed=false when current matches target', async () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    const result = await makeSwitcher().switch({
      spec: 'groq:llama-3.3-70b-versatile',
      currentProviderId: 'groq',
      currentModelId: 'llama-3.3-70b-versatile',
    });
    expect(result.changed).toBe(false);
  });

  it('10. changed=true when switching from anthropic to groq', async () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    const result = await makeSwitcher().switch({
      spec: 'groq:llama-3.3-70b-versatile',
      currentProviderId: 'anthropic',
      currentModelId: 'claude-opus-4-7',
    });
    expect(result.changed).toBe(true);
  });
});
