import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runSetupWizard,
  isFreshInstall,
  PROVIDERS,
  type PromptIO,
  type SetupAnswers,
} from '../../../cli/v4/setupWizard';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { AidenPaths } from '../../../core/v4/paths';

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'memories', 'MEMORY.md'),
    userMd: path.join(root, 'memories', 'USER.md'),
    skillsDir: path.join(root, 'skills'),
    sessionsDir: path.join(root, 'sessions'),
    pluginsDir: path.join(root, 'plugins'),
    logsDir: path.join(root, 'logs'),
    bundledManifest: path.join(root, '.bundled_manifest'),
  };
}

/** Build a scripted PromptIO: each method dequeues from a queue. */
function scriptedPrompts(answers: {
  choose?: number[];
  input?: string[];
  confirm?: boolean[];
}): PromptIO {
  const choose = [...(answers.choose ?? [])];
  const input = [...(answers.input ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  return {
    async choose() {
      if (choose.length === 0) throw new Error('scripted choose ran out');
      return choose.shift()!;
    },
    async input() {
      if (input.length === 0) throw new Error('scripted input ran out');
      return input.shift()!;
    },
    async confirm() {
      if (confirm.length === 0) return false;
      return confirm.shift()!;
    },
  };
}

/** Sink display — captures writes for assertions. */
function sinkDisplay(): { display: Display; chunks: string[] } {
  const chunks: string[] = [];
  const stdout = {
    isTTY: false,
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const stderr = {
    isTTY: false,
    write(s: string): boolean {
      chunks.push(`STDERR:${s}`);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout,
    stderr,
  });
  return { display, chunks };
}

describe('SetupWizard', () => {
  let tmp: string;
  let paths: AidenPaths;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-setup-'));
    paths = makePaths(tmp);
  });

  it('isFreshInstall returns true when config.yaml is missing', async () => {
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('isFreshInstall returns false when config.yaml has a providers entry', async () => {
    // Phase 18 Task 7: isFreshInstall is lenient — empty providers section
    // also counts as fresh. Test fixture needs a providers entry.
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    await fs.writeFile(
      paths.configYaml,
      'model: {}\nproviders:\n  groq:\n    apiKey: ${GROQ_API_KEY}\n',
    );
    expect(await isFreshInstall(paths)).toBe(false);
  });

  it('PROVIDERS has 19 numbered entries', () => {
    expect(PROVIDERS).toHaveLength(19);
  });

  it('skips when config exists with providers and force=false', async () => {
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    // Phase 18 Task 7: providers section needed so isFreshInstall returns false.
    await fs.writeFile(
      paths.configYaml,
      'model: {}\nproviders:\n  groq:\n    apiKey: ${GROQ_API_KEY}\n',
    );
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({}),
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toMatch(/already exists/);
  });

  it('Pro option [1] (Claude Pro) prints OAuth explainer + beta note then waits for confirm', async () => {
    // Phase 18 Task 4 made these real OAuth flows; Phase 18.1 added the
    // beta note. With confirm: [false], the user declines and the wizard
    // returns oauth-skipped.
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [1], confirm: [false] }),
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe('oauth-skipped');
    const text = chunks.join('\n');
    expect(text).toMatch(/Claude Pro/);
    expect(text).toMatch(/OAuth flows are beta in v4\.0/);
  });

  it('Pro option [2] (ChatGPT Plus) prints OAuth explainer + beta note then waits for confirm', async () => {
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [2], confirm: [false] }),
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe('oauth-skipped');
    const text = chunks.join('\n');
    expect(text).toMatch(/ChatGPT Plus/);
    expect(text).toMatch(/OAuth flows are beta in v4\.0/);
  });

  it('API-key provider saves config.yaml + writes .env', async () => {
    // Anthropic is option [4]; it has 3 models so a model index is needed.
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [4, 1], input: ['sk-ant-test'] }),
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('anthropic');
    expect(result.config?.model.modelId).toBe('claude-opus-4-7');
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(env).toMatch(/ANTHROPIC_API_KEY=sk-ant-test/);
    const cfg = await fs.readFile(paths.configYaml, 'utf8');
    expect(cfg).toMatch(/anthropic/);
  });

  it('model is filtered by provider', async () => {
    // Phase 16f: providers reordered (Together moved above Groq as the
    // recommended primary). Groq is now option [7] with 3 models.
    // Pick model index 2 → llama-3.1-8b-instant.
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [7, 2], input: ['gsk-test'] }),
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('groq');
    expect(result.config?.model.modelId).toBe('llama-3.1-8b-instant');
  });

  it('Custom OpenAI-compatible collects baseUrl + apiKey', async () => {
    // Custom is option [18]
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({
        choose: [18],
        input: ['', 'https://api.example.com/v1', 'custom-key'],
        // first input is the model id (provider has no defaultModel)
      }),
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('custom');
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(env).toMatch(/CUSTOM_BASE_URL=https:\/\/api\.example\.com\/v1/);
    expect(env).toMatch(/CUSTOM_API_KEY=custom-key/);
  });

  it('Ollama option probes the local server', async () => {
    let probed = false;
    const fetchImpl = (async (url: string) => {
      probed = true;
      expect(String(url)).toContain('11434');
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [19], input: ['llama3.1:8b'] }),
      fetchImpl,
    });
    expect(probed).toBe(true);
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('ollama');
  });

  it('Ollama unreachable surfaces install hint', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [19], input: ['llama3.1:8b'] }),
      fetchImpl,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe('ollama-not-reachable');
    expect(chunks.join('\n')).toMatch(/ollama\.com/);
  });

  it('force=true re-runs even when config exists', async () => {
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    await fs.writeFile(paths.configYaml, 'model:\n  provider: oldprov\n');
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [4, 1], input: ['sk-ant-2'] }),
      force: true,
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('anthropic');
  });

  it('banner is shown at start', async () => {
    const { display, chunks } = sinkDisplay();
    await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [1] }), // pro stub — short-circuit, but banner runs first
    });
    expect(chunks.join('\n')).toMatch(/Aiden v/);
  });
});
