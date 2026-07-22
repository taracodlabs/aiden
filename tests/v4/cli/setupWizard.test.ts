import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runSetupWizard,
  isFreshInstall,
  printPostWizardTutorial,
  aidenHomeDisplayPath,
  setupRequiresRecoveryMode,
  PROVIDERS,
  type PromptIO,
  type SetupAnswers,
} from '../../../cli/v4/setupWizard';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { BACK } from '../../../cli/v4/onboarding/backNavInput';
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
    skillsBundleVersion: path.join(root, '.skills-bundle-version'),
  };
}

type ScriptedPromptIO = PromptIO & { defaultIndexCalls: (number | undefined)[] };

/** Build a scripted PromptIO: each method dequeues from a queue. */
function scriptedPrompts(answers: {
  choose?: number[];
  // v4.11 — `input` may yield the BACK sentinel to drive back-navigation
  // (the value-returning harness can't simulate the actual backspace key).
  input?: (string | typeof BACK)[];
  confirm?: boolean[];
}): ScriptedPromptIO {
  const choose = [...(answers.choose ?? [])];
  const input = [...(answers.input ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  // Capture defaultIndex args so tests can assert on them. Index N = the
  // defaultIndex passed to the Nth choose() call (1-based on call order).
  const defaultIndexCalls: (number | undefined)[] = [];
  const io: PromptIO & { defaultIndexCalls: (number | undefined)[] } = {
    async choose(_q: string, _choices: string[], defaultIndex?: number) {
      defaultIndexCalls.push(defaultIndex);
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
    defaultIndexCalls,
  };
  return io;
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

  it('PROVIDERS has 18 numbered entries', () => {
    expect(PROVIDERS).toHaveLength(18);
  });

  it('wizard pre-selects Groq as the recommended provider default', async () => {
    // Phase 30.2.1: Groq replaced Together as the recommended default —
    // free tier, fastest signup, no surprise charges. The wizard's
    // first choose() call must pass Groq's 1-based index as defaultIndex.
    const expectedIdx = PROVIDERS.findIndex((p) => p.id === 'groq') + 1;
    expect(expectedIdx).toBeGreaterThan(0);
    const { display } = sinkDisplay();
    // Groq has 3 models → second choose is model picker, take [1].
    const prompts = scriptedPrompts({
      choose: [expectedIdx, 1],
      input: ['gsk-test'],
    });
    const result = await runSetupWizard({
      paths,
      display,
      prompts,
      skipValidation: true,
    });
    expect(result.status).toBe('configured');
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('groq');
    expect(result.config?.agent.tool_profile).toBe('minimal');
    expect(prompts.defaultIndexCalls[0]).toBe(expectedIdx);
  });

  it('does not advance past an empty required credential', async () => {
    const groqIdx = PROVIDERS.findIndex((provider) => provider.id === 'groq') + 1;
    const { display } = sinkDisplay();
    const answers = ['', ['fixture', 'managed', 'credential'].join('-')];
    let credentialPrompts = 0;
    const prompts: PromptIO = {
      async choose(_question, _choices, defaultIndex) {
        return defaultIndex ?? groqIdx;
      },
      async input(question) {
        if (!question.startsWith('API key for')) throw new Error(`unexpected input prompt: ${question}`);
        credentialPrompts += 1;
        return answers.shift()!;
      },
      async confirm() {
        return false;
      },
    };

    const result = await runSetupWizard({
      paths,
      display,
      prompts,
      skipValidation: true,
      skipCuratedStep: true,
    });

    expect(result.status).toBe('configured');
    expect(credentialPrompts).toBe(2);
    expect(await fs.readFile(paths.envFile, 'utf8')).toMatch(/^GROQ_API_KEY=\S+$/m);
  });

  it('does not present an incomplete readiness transaction as configured', async () => {
    const groqIdx = PROVIDERS.findIndex((provider) => provider.id === 'groq') + 1;
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [groqIdx, 1], input: ['fixture-credential'] }),
      validator: async () => ({ valid: true }),
      readinessVerifier: async () => ({
        state: 'failed_requires_user_action',
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        endpointFingerprint: 'endpoint',
        credentialSource: 'managed_environment',
        transportMode: 'chat_completions',
        plainCompletionStatus: 'verified',
        streamingStatus: 'verified',
        toolCallStatus: 'failed',
        toolResultReplayStatus: 'failed',
        structuredArgumentsStatus: 'failed',
        verificationTimestamp: '2026-07-18T00:00:00.000Z',
        verificationErrorCategory: 'tool_call_unsupported',
      }),
      skipCuratedStep: true,
    });

    expect(result.readiness?.state).toBe('failed_requires_user_action');
    const text = chunks.join('');
    expect(text).not.toMatch(/configured with model/i);
    expect(text).toMatch(/settings were saved, but runtime readiness did not complete/i);
    expect(setupRequiresRecoveryMode(result)).toBe(true);
  });

  // ── v4.11 — back-navigation (Approach B, hybrid) ─────────────────
  it('model-pick "← Back" returns to the provider picker', async () => {
    const groqIdx = PROVIDERS.findIndex((p) => p.id === 'groq') + 1;
    const groq = PROVIDERS.find((p) => p.id === 'groq')!;
    // "← Back" is appended last → its 1-based index = models.length + 1.
    const backChoice = (groq.models?.length ?? 0) + 1;
    const { display } = sinkDisplay();
    // iter 1: provider=groq, key, model=BACK → loop to provider pick.
    // iter 2: provider=groq, key, model=1 → configured.
    const prompts = scriptedPrompts({
      choose: [groqIdx, backChoice, groqIdx, 1],
      input:  ['gsk-first', 'gsk-second'],
    });
    const result = await runSetupWizard({ paths, display, prompts, skipValidation: true });
    expect(result.status).toBe('configured');
    expect(result.config?.model.provider).toBe('groq');
    // 4 choose calls (2 provider + 2 model) prove the back loop re-ran step 1.
    expect(prompts.defaultIndexCalls).toHaveLength(4);
  });

  it('BACK from key entry (backspace-on-empty) returns to the provider picker', async () => {
    // The back-aware prompt resolves BACK on backspace-when-empty; here we
    // inject BACK directly to exercise the wizard's BACK → `continue outer`
    // WIRING (the keypress→BACK detection is unit-tested in
    // backNavInput.test.ts; it can't be driven by this value-returning harness).
    const groqIdx = PROVIDERS.findIndex((p) => p.id === 'groq') + 1;
    const { display } = sinkDisplay();
    // iter 1: provider=groq, key=BACK → loop (model pick NOT reached).
    // iter 2: provider=groq, key, model=1 → configured.
    const prompts = scriptedPrompts({
      choose: [groqIdx, groqIdx, 1],
      input:  [BACK, 'gsk-real'],
    });
    const result = await runSetupWizard({ paths, display, prompts, skipValidation: true });
    expect(result.status).toBe('configured');
    expect(result.config?.model.provider).toBe('groq');
    // 3 choose calls (provider, provider-again, model) — back skipped the
    // first model pick by re-entering at provider selection.
    expect(prompts.defaultIndexCalls).toHaveLength(3);
  });

  it('wizard prints the "Press Enter to accept Groq" hint', async () => {
    // Phase 30.2.1 — hint text changed alongside the default flip.
    // Use Ollama (kind=local) with a stubbed-reachable probe so the
    // wizard exits cleanly without needing API-key input.
    const fetchImpl = (async () => ({ ok: true } as Response)) as unknown as typeof fetch;
    const ollamaIdx = PROVIDERS.findIndex((p) => p.id === 'ollama') + 1;
    const { display, chunks } = sinkDisplay();
    await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [ollamaIdx], input: ['llama3.1:8b'] }),
      fetchImpl,
    });
    const text = chunks.join('\n');
    expect(text).toMatch(/Press Enter to accept Groq/i);
    expect(text).toMatch(/fast hosted inference; API key required/i);
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

  it('Pro option ChatGPT Plus prints OAuth explainer + beta note then waits for confirm', async () => {
    const subscriptionProviderIndex = PROVIDERS.findIndex((p) => p.id === 'chatgpt-plus') + 1;
    const ollamaIdx = PROVIDERS.findIndex((p) => p.id === 'ollama') + 1;
    const fetchImpl = (async () => ({ ok: true } as Response)) as unknown as typeof fetch;
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({
        choose: [subscriptionProviderIndex, ollamaIdx],
        confirm: [false],
        input: ['llama3.1:8b'],
      }),
      fetchImpl,
    });
    expect(result.status).toBe('configured');
    const text = chunks.join('\n');
    expect(text).toMatch(/ChatGPT Plus/);
    expect(text).toMatch(/OAuth flows are beta in v4\.0/);
  });

  it('API-key provider saves config.yaml + writes .env', async () => {
    // Phase 30.2.1: Anthropic moved to option [6]. It still has 3 models
    // so the second choose() picks the first model.
    const anthIdx = PROVIDERS.findIndex((p) => p.id === 'anthropic') + 1;
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [anthIdx, 1], input: ['sk-ant-test'] }),
      skipValidation: true,
    });
    expect(result.status).toBe('configured');
    expect(result.config?.model.provider).toBe('anthropic');
    expect(result.config?.model.modelId).toBe('claude-opus-4-7');
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(env).toMatch(/ANTHROPIC_API_KEY=sk-ant-test/);
    const cfg = await fs.readFile(paths.configYaml, 'utf8');
    expect(cfg).toMatch(/anthropic/);
  });

  it('model is filtered by provider', async () => {
    // Phase 30.2.1: Groq is now option [1] with 3 models.
    // Pick the second curated model.
    const groqIdx = PROVIDERS.findIndex((p) => p.id === 'groq') + 1;
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [groqIdx, 2], input: ['gsk-test'] }),
      skipValidation: true,
    });
    expect(result.status).toBe('configured');
    expect(result.config?.model.provider).toBe('groq');
    expect(result.config?.model.modelId).toBe('openai/gpt-oss-20b');
  });

  it('Custom OpenAI-compatible collects baseUrl + apiKey', async () => {
    // Phase 30.2.1: Custom moved to the end of the list (last entry).
    const customIdx = PROVIDERS.findIndex((p) => p.id === 'custom_openai') + 1;
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({
        choose: [customIdx],
        input: ['', 'https://api.example.com/v1', 'custom-key'],
        // first input is the model id (provider has no defaultModel)
      }),
      skipValidation: true,
    });
    expect(result.status).toBe('configured');
    expect(result.config?.model.provider).toBe('custom_openai');
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(result.config?.providers?.custom_openai?.baseUrl).toBe('https://api.example.com/v1');
    expect(env).toMatch(/CUSTOM_OPENAI_API_KEY=custom-key/);
  });

  it('Ollama option probes the local server', async () => {
    // Phase 30.2.1: Ollama moved to option [5].
    const ollamaIdx = PROVIDERS.findIndex((p) => p.id === 'ollama') + 1;
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
      prompts: scriptedPrompts({ choose: [ollamaIdx], input: ['llama3.1:8b'] }),
      fetchImpl,
    });
    expect(probed).toBe(true);
    expect(result.status).toBe('configured');
    expect(result.config?.model.provider).toBe('ollama');
  });

  it('Ollama unreachable loops back to provider pick (recovery flow)', async () => {
    // Phase 30.2.1: when Ollama is unreachable the wizard no longer
    // dead-ends with `ollama-not-reachable`. It logs the install hint
    // and `continue outer`s back to the provider picker, so the test
    // scripts a second pick (Groq with skipValidation) to terminate
    // the outer loop with status='configured'. The install hint is
    // still asserted on the captured display chunks.
    const ollamaIdx = PROVIDERS.findIndex((p) => p.id === 'ollama') + 1;
    const groqIdx = PROVIDERS.findIndex((p) => p.id === 'groq') + 1;
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({
        choose: [ollamaIdx, groqIdx, 1],
        input: ['llama3.1:8b', 'gsk-test'],
      }),
      fetchImpl,
      skipValidation: true,
    });
    expect(result.status).toBe('configured');
    expect(result.config?.model.provider).toBe('groq');
    expect(chunks.join('\n')).toMatch(/ollama\.com/);
  });

  it('force=true re-runs even when config exists', async () => {
    // Phase 30.2.1: Anthropic at index 6 now.
    const anthIdx = PROVIDERS.findIndex((p) => p.id === 'anthropic') + 1;
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    await fs.writeFile(paths.configYaml, 'model:\n  provider: oldprov\n');
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [anthIdx, 1], input: ['sk-ant-2'] }),
      force: true,
      skipValidation: true,
    });
    expect(result.status).toBe('configured');
    expect(result.config?.model.provider).toBe('anthropic');
  });

  it('resumes an interrupted persisted readiness transaction without replaying prompts', async () => {
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    await fs.writeFile(paths.configYaml, [
      'model:',
      '  provider: groq',
      '  modelId: openai/gpt-oss-120b',
      'providers:',
      '  groq:',
      '    modelVerification: curated',
      '    readiness:',
      '      state: credential_saved',
      '      provider: groq',
      '      model: openai/gpt-oss-120b',
      '      endpointFingerprint: null',
      '      credentialSource: managed_environment',
      '      transportMode: chat_completions',
      '      plainCompletionStatus: not_started',
      '      toolCallStatus: not_started',
      '      verificationTimestamp: null',
      '      verificationErrorCategory: null',
      '',
    ].join('\n'));
    const complete = {
      state: 'complete' as const,
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      endpointFingerprint: 'endpoint',
      credentialSource: 'managed_environment' as const,
      transportMode: 'chat_completions' as const,
      plainCompletionStatus: 'verified' as const,
      toolCallStatus: 'verified' as const,
      verificationTimestamp: '2026-07-18T00:00:00.000Z',
      verificationErrorCategory: null,
    };
    let resumed = 0;
    const result = await runSetupWizard({
      paths,
      readinessVerifier: async (options) => {
        resumed += 1;
        expect(options.providerId).toBe('groq');
        expect(options.modelId).toBe('openai/gpt-oss-120b');
        return complete;
      },
    });
    expect(resumed).toBe(1);
    expect(result.ran).toBe(true);
    expect(result.readiness).toEqual(complete);
  });

  it('banner is shown at start', async () => {
    // Phase 30.2.1: pick Ollama with successful probe so the wizard
    // exits cleanly through the API-key-less path. Banner prints
    // before the provider picker regardless.
    const ollamaIdx = PROVIDERS.findIndex((p) => p.id === 'ollama') + 1;
    const fetchImpl = (async () => ({ ok: true } as Response)) as unknown as typeof fetch;
    const { display, chunks } = sinkDisplay();
    await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [ollamaIdx], input: ['llama3.1:8b'] }),
      fetchImpl,
    });
    expect(chunks.join('\n')).toMatch(/█████╗/);
  });

  describe('printPostWizardTutorial (Phase 22 Task 6)', () => {
    function captureTutorial(): string {
      const { display, chunks } = sinkDisplay();
      printPostWizardTutorial(display, '4.0.0');
      return chunks.join('');
    }

    it('renders a rounded box with the Setup Complete title', () => {
      const out = captureTutorial();
      expect(out).toMatch(/┌── Setup Complete /);
      expect(out).toMatch(/└─+┘/);
    });

    it('shows the platform-aware aiden home path', () => {
      const out = captureTutorial();
      expect(out).toContain(aidenHomeDisplayPath());
      if (process.platform === 'win32') {
        expect(out).toMatch(/%LOCALAPPDATA%\\aiden\\/);
      } else {
        expect(out).toMatch(/~\/\.aiden\//);
      }
    });

    it('lists all five user-state files with one-line labels', () => {
      const out = captureTutorial();
      expect(out).toMatch(/config\.yaml\s+main config/);
      expect(out).toMatch(/\.env\s+API keys/);
      expect(out).toMatch(/SOUL\.md\s+identity prompt/);
      expect(out).toMatch(/sessions\/\s+conversation history/);
      expect(out).toMatch(/skills\/\s+installed skills/);
    });

    it('lists both re-run commands inside the box', () => {
      const out = captureTutorial();
      expect(out).toMatch(/aiden setup\s+full wizard/);
      expect(out).toMatch(/aiden setup model\s+change provider/);
    });

    it('closes with the "Try: aiden" CTA below the box', () => {
      const out = captureTutorial();
      // CTA appears AFTER the closing border.
      const closeIdx = out.lastIndexOf('┘');
      expect(closeIdx).toBeGreaterThan(0);
      expect(out.slice(closeIdx)).toMatch(/Try: aiden/);
    });

    it('prints the supplied version', () => {
      const { display, chunks } = sinkDisplay();
      printPostWizardTutorial(display, '4.7.3');
      expect(chunks.join('')).toMatch(/Aiden v4\.7\.3 is ready/);
    });
  });
});
