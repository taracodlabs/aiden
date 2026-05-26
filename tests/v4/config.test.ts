import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ConfigManager, DEFAULT_CONFIG } from '../../core/v4/config';
import type { ConfigProvider } from '../../providers/v4/runtimeResolver';
import { resolveAidenPaths, ensureAidenDirsExist } from '../../core/v4/paths';

let tmpDir: string;
let mgr: ConfigManager;
let configPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-cfg-'));
  const paths = resolveAidenPaths({ rootOverride: tmpDir });
  await ensureAidenDirsExist(paths);
  configPath = paths.configYaml;
  mgr = new ConfigManager(paths);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('ConfigManager', () => {
  it('1. load returns defaults when config.yaml is missing', async () => {
    const cfg = await mgr.load();
    expect(cfg.model.provider).toBe(DEFAULT_CONFIG.model.provider);
    expect(cfg.agent.max_turns).toBe(DEFAULT_CONFIG.agent.max_turns);
    // v4.10 Slice 10.9 — streaming default flipped to ON. The
    // Phase A audit caught that pre-10.9 the default was `false` and
    // EVERY wizard install baked that into user configs, causing the
    // "Aiden feels slow" perception bug. The flip ships the default
    // users always expected. Existing users with explicit `false`
    // keep their setting + see a one-shot disclosure (see
    // chatSession.ts streamingDisabledWarned flag).
    expect(cfg.display.streaming).toBe(true);
    expect(cfg.memory.provider).toBe('default');
  });

  it('2. load parses a real config.yaml and merges over defaults', async () => {
    await fs.writeFile(
      configPath,
      [
        'model:',
        '  provider: groq',
        '  modelId: llama-3.3-70b-versatile',
        'agent:',
        '  max_turns: 50',
        '  approval_mode: smart',
        'display:',
        '  skin: dark',
        '  streaming: false',
        'providers:',
        '  groq:',
        '    apiKey: gsk_real_key_here',
        '',
      ].join('\n'),
      'utf8',
    );
    const cfg = await mgr.load();
    expect(cfg.model.provider).toBe('groq');
    expect(cfg.agent.approval_mode).toBe('smart');
    expect(cfg.agent.max_turns).toBe(50);
    expect(cfg.display.streaming).toBe(false);
    expect(cfg.memory.provider).toBe('default'); // from defaults
    expect(cfg.providers?.groq?.apiKey).toBe('gsk_real_key_here');
  });

  it('3. ${ENV_VAR} interpolation expands at get() time', async () => {
    await fs.writeFile(
      configPath,
      [
        'providers:',
        '  groq:',
        '    apiKey: ${MY_TEST_GROQ_KEY}',
        '',
      ].join('\n'),
      'utf8',
    );
    process.env.MY_TEST_GROQ_KEY = 'expanded-secret-1234';
    try {
      await mgr.load();
      expect(mgr.get('providers.groq.apiKey')).toBe('expanded-secret-1234');
    } finally {
      delete process.env.MY_TEST_GROQ_KEY;
    }
  });

  it('4. unset ${VAR} is left literal', async () => {
    delete process.env.UNSET_TEST_VAR;
    await fs.writeFile(
      configPath,
      ['providers:', '  groq:', '    apiKey: ${UNSET_TEST_VAR}', ''].join('\n'),
      'utf8',
    );
    await mgr.load();
    expect(mgr.get('providers.groq.apiKey')).toBe('${UNSET_TEST_VAR}');
  });

  it('5. get / getValue support dotted key paths', async () => {
    await fs.writeFile(
      configPath,
      ['display:', '  skin: monokai', '  streaming: false', ''].join('\n'),
      'utf8',
    );
    await mgr.load();
    expect(mgr.get('display.skin')).toBe('monokai');
    expect(mgr.getValue<boolean>('display.streaming')).toBe(false);
    expect(mgr.getValue<number>('agent.max_turns')).toBe(
      DEFAULT_CONFIG.agent.max_turns,
    );
  });

  it('6. set then save round-trips through disk', async () => {
    await mgr.load();
    mgr.set('model.provider', 'anthropic');
    mgr.set('model.modelId', 'claude-opus-4-7');
    mgr.set('display.streaming', false);
    await mgr.save();

    const fresh = new ConfigManager(resolveAidenPaths({ rootOverride: tmpDir }));
    const cfg = await fresh.load();
    expect(cfg.model.provider).toBe('anthropic');
    expect(cfg.model.modelId).toBe('claude-opus-4-7');
    expect(cfg.display.streaming).toBe(false);
  });

  it('7. unknown top-level keys are preserved with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(
      configPath,
      ['custom_future_key:', '  some_value: 42', ''].join('\n'),
      'utf8',
    );
    try {
      const cfg = await mgr.load();
      expect((cfg as any).custom_future_key).toEqual({ some_value: 42 });
      expect(warn).toHaveBeenCalled();
      const calls = warn.mock.calls.flat().join(' ');
      expect(calls).toMatch(/custom_future_key/);
    } finally {
      warn.mockRestore();
    }
  });

  it('8. reload returns true when the file changes, false otherwise', async () => {
    await fs.writeFile(
      configPath,
      ['model:', '  provider: groq', '  modelId: a', ''].join('\n'),
      'utf8',
    );
    await mgr.load();
    expect(await mgr.reload()).toBe(false);

    await fs.writeFile(
      configPath,
      ['model:', '  provider: anthropic', '  modelId: claude-opus-4-7', ''].join('\n'),
      'utf8',
    );
    expect(await mgr.reload()).toBe(true);
    expect(mgr.get('model.provider')).toBe('anthropic');
  });

  it('9. get returns undefined for missing keys', async () => {
    await mgr.load();
    expect(mgr.get('does.not.exist')).toBeUndefined();
    expect(mgr.get('providers.unset_provider.apiKey')).toBeUndefined();
    expect(mgr.getValue<string>('nope', 'fallback')).toBe('fallback');
  });

  it('10. ConfigManager satisfies the ConfigProvider type', async () => {
    await mgr.load();
    const provider: ConfigProvider = mgr;
    expect(typeof provider.get('model.provider')).toBe('string');
  });

  it('11. malformed YAML surfaces a clear error', async () => {
    await fs.writeFile(configPath, 'model: [unterminated\n  provider: x', 'utf8');
    await expect(mgr.load()).rejects.toThrow(/config\.yaml/i);
  });

  it('12. (16b.1) `terminal` is a known top-level key and does not warn', async () => {
    const warns: string[] = [];
    const spy = vi
      .spyOn(console, 'warn')
      .mockImplementation((msg) => warns.push(String(msg)));
    await fs.writeFile(
      configPath,
      ['terminal:', '  backend: auto'].join('\n'),
      'utf8',
    );
    const cfg = await mgr.load();
    spy.mockRestore();
    // No "Unknown top-level key 'terminal'" warning should have been emitted.
    expect(warns.some((w) => w.includes("Unknown top-level key 'terminal'"))).toBe(false);
    expect(((cfg as any).terminal as { backend: string }).backend).toBe('auto');
  });
});
