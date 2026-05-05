/**
 * cli/v4/setupWizard.ts — Aiden v4.0.0 (Phase 14a)
 *
 * First-run setup wizard. Auto-fires on fresh install (no config.yaml).
 *
 * Steps:
 *   1. Banner
 *   2. Provider selection (19 numbered options)
 *   3. Model selection (filtered by provider)
 *   4. Credentials (API key OR baseUrl+key for custom OpenAI-compat)
 *   5. Save  → API keys to `.env`, provider/model to `config.yaml`
 *   6. Welcome
 *
 * The wizard's prompt functions are injectable so unit tests can stub
 * answers without spawning a TTY. Defaults wire to `@inquirer/prompts`.
 *
 * Hermes reference: hermes_cli/setup.py.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import kleur from 'kleur';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
  type AidenPaths,
} from '../../core/v4/paths';
import { ConfigManager, DEFAULT_CONFIG, type AidenConfig } from '../../core/v4/config';
import { Display } from './display';
import { validateProviderKey } from './keyValidator';
import {
  OAuthProviderRuntime,
  type OAuthUserAgent,
  type OAuthProvider,
} from '../../core/v4/auth/providerAuth';
import {
  loadOAuthProvider,
  openOAuthBrowserUrl,
} from './auth/loadProvider';

export interface ProviderOption {
  id: string;
  label: string;
  /** "pro" = subscription stub, "oauth" = OAuth (also stubbed for now), "key" = API key, "custom" = baseUrl+key, "local" = Ollama. */
  kind: 'pro' | 'oauth' | 'key' | 'custom' | 'local' | 'subscription';
  /** ENV var name where API key is stored (.env on save). Optional for non-key providers. */
  envVar?: string;
  /** Default model id offered. */
  defaultModel?: string;
  /** Curated model list (subset is shown to the user). */
  models?: string[];
}

export const PROVIDERS: ProviderOption[] = [
  { id: 'claude-pro', label: 'Use my Claude Pro/Max subscription', kind: 'pro' },
  { id: 'chatgpt-plus', label: 'Use my ChatGPT Plus subscription', kind: 'pro' },
  {
    id: 'nous',
    label: 'Nous Portal (subscription, zero-config)',
    kind: 'subscription',
    defaultModel: 'hermes-3-llama-3.1-405b',
  },
  {
    id: 'anthropic',
    label: 'Anthropic API key',
    kind: 'key',
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-4-7',
    models: ['claude-opus-4-7', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  },
  {
    id: 'openai',
    label: 'OpenAI API key',
    kind: 'key',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    models: ['gpt-5', 'gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'together',
    // Phase 16f: Together + Qwen3 is the recommended primary — strong tool
    // calling, $0.20/M throughput tier, 131k context. Free $5-10 credit on
    // signup covers a few hundred turns. Replaces Groq free tier as the
    // first recommendation after the user's Groq slots kept hammering
    // simultaneous 429s within 2 turns of normal use.
    label: 'Together AI (recommended — Qwen3-235B, paid throughput tier)',
    kind: 'key',
    envVar: 'TOGETHER_API_KEY',
    defaultModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
    models: [
      'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
    ],
  },
  {
    id: 'groq',
    label: 'Groq (free tier — fast but tight TPM cap)',
    kind: 'key',
    envVar: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (200+ models)',
    kind: 'key',
    envVar: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-opus-4',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (free tier)',
    kind: 'key',
    envVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.0-flash',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'key',
    envVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'key',
    envVar: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-large-latest',
  },
  { id: 'zai', label: 'Z.AI / GLM', kind: 'key', envVar: 'ZAI_API_KEY', defaultModel: 'glm-4-plus' },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot',
    kind: 'key',
    envVar: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshot-v1-128k',
  },
  { id: 'minimax', label: 'MiniMax', kind: 'key', envVar: 'MINIMAX_API_KEY', defaultModel: 'abab6.5s-chat' },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM (free tier)',
    kind: 'key',
    envVar: 'NVIDIA_API_KEY',
    defaultModel: 'meta/llama-3.3-70b-instruct',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face (free tier)',
    kind: 'key',
    envVar: 'HF_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    kind: 'key',
    envVar: 'VERCEL_AI_GATEWAY_KEY',
    defaultModel: 'anthropic/claude-opus-4',
  },
  { id: 'custom', label: 'Custom OpenAI-compatible endpoint', kind: 'custom', envVar: 'CUSTOM_API_KEY' },
  { id: 'ollama', label: 'Local (Ollama, no internet)', kind: 'local', defaultModel: 'llama3.1:8b' },
];

export interface SetupAnswers {
  providerIndex: number; // 1-based as shown to user
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  terminalBackend?: 'auto' | 'inline' | 'fullscreen';
}

export interface PromptIO {
  /** Multi-choice prompt; returns the 1-based selected index. */
  choose(question: string, choices: string[]): Promise<number>;
  /** Free-text input. */
  input(question: string, opts?: { default?: string; mask?: boolean }): Promise<string>;
  /** Yes/no confirmation. */
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
}

export interface SetupOptions {
  paths?: AidenPaths;
  display?: Display;
  prompts?: PromptIO;
  /** Force re-run even when config.yaml exists. */
  force?: boolean;
  /**
   * Override fetch for the Ollama probe. Defaults to global fetch.
   */
  fetchImpl?: typeof fetch;
  /** Override env so tests don't pollute process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Smoke-test mode: walk through prompts, build the resolved config, but
   * do NOT write to ~/.aiden/config.yaml or .env. Used for verifying the
   * wizard renders correctly without polluting real user state.
   */
  smokeTest?: boolean;
  /** Bypass API-key validation against provider endpoints. */
  skipValidation?: boolean;
  /** Injectable validator for tests. Defaults to the real `validateProviderKey`. */
  validator?: typeof validateProviderKey;
}

export interface SetupResult {
  /** True if the wizard ran (and saved). False if skipped. */
  ran: boolean;
  /** Reason wizard was skipped (only set when `ran=false`). */
  skipReason?: string;
  config?: AidenConfig;
  envFile?: string;
}

/** Lazy-load @inquirer/prompts so unit tests don't need a TTY. */
async function defaultPrompts(): Promise<PromptIO> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  return {
    async choose(question, choices) {
      const ans: string = await inq.select({
        message: question,
        choices: choices.map((c, i) => ({ name: `[${i + 1}] ${c}`, value: String(i + 1) })),
      });
      return Number.parseInt(ans, 10);
    },
    async input(question, opts) {
      if (opts?.mask) {
        return inq.password({ message: question, mask: true });
      }
      return inq.input({ message: question, default: opts?.default });
    },
    async confirm(question, defaultValue = false) {
      return inq.confirm({ message: question, default: defaultValue });
    },
  };
}

// Version surfaced by the post-wizard tutorial. Read from package.json
// so the bumped version flows through without a manual edit per release.
const AIDEN_VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../../package.json') as { version?: string }).version ?? '4.0.0';
  } catch {
    return '4.0.0';
  }
})();

// ─── Phase 18: OAuth helper plumbing for the wizard ─────────────────────
// loadOAuthProvider + openOAuthBrowserUrl live in cli/v4/auth/loadProvider.ts
// so /auth login (Task 5) and the wizard share one implementation.
const PRO_EXPLAINERS: Record<string, string> = {
  'claude-pro':
    'This connects your Claude Pro / Max subscription. No API charges, no API key needed.',
  'chatgpt-plus':
    'This connects your ChatGPT Plus subscription. No API charges, no API key needed.',
};

/** Build an OAuthUserAgent from the wizard's PromptIO + Display. */
function wizardUserAgent(prompts: PromptIO, display: Display): OAuthUserAgent {
  return {
    log: (line: string) => display.write(line + '\n'),
    openBrowser: openOAuthBrowserUrl,
    async prompt(question: string) {
      return prompts.input(question);
    },
    async sleep(ms: number) {
      return new Promise<void>((r) => setTimeout(r, ms));
    },
  };
}

/**
 * Determine whether the wizard should auto-fire. Phase 18 Task 7: lenient
 * — any of the following counts as "first run":
 *   - paths.root doesn't exist (truly fresh install)
 *   - config.yaml missing (legacy criterion)
 *   - config exists but providers section is empty (manual config that
 *     can't actually run, or wizard interrupted between save and provider
 *     entry write)
 *
 * Plugins-not-granted is intentionally NOT a fresh-install signal: bundled
 * plugins (CDP browser) ship in pending-grant state and the boot card
 * already surfaces them honestly. Forcing a user through grants before
 * their first chat would be hostile.
 */
export async function isFreshInstall(paths: AidenPaths): Promise<boolean> {
  try {
    await fs.access(paths.root);
  } catch {
    return true;
  }
  try {
    await fs.access(paths.configYaml);
  } catch {
    return true;
  }
  // Config exists. Inspect for an empty providers section.
  try {
    const text = await fs.readFile(paths.configYaml, 'utf8');
    // Cheap parse: split on lines, look for `providers:` followed by a
    // top-level key. Avoids pulling YAML into this hot-path module just
    // for a presence check. ConfigManager.load handles full validation
    // when the wizard isn't fired.
    const lines = text.split(/\r?\n/);
    let inProviders = false;
    let providerCount = 0;
    for (const line of lines) {
      if (/^providers\s*:/i.test(line)) {
        inProviders = true;
        continue;
      }
      if (inProviders) {
        if (/^\S/.test(line)) break; // top-level key reached → leave block
        if (/^  \S/.test(line) && !/^\s*#/.test(line)) providerCount++;
      }
    }
    if (providerCount === 0) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * Print the post-wizard tutorial. Under 10 lines. Lives here so both
 * the API-key path and the OAuth path render the same closing screen
 * without copy-pasting copy.
 *
 * Phase 18 Task 7: deliberately minimal. No feature lists, no
 * architecture explanations, no marketing copy — users discover via
 * use. Banked for v4.1: post-launch onboarding analytics on which
 * examples users try first.
 */
export function printPostWizardTutorial(display: Display, version: string): void {
  display.write(`\n✓ Setup complete. Aiden v${version} is ready.\n\n`);
  display.write('Try one of these to get started:\n');
  display.write('  • ask me anything\n');
  display.write('  • remember that I prefer concise answers\n');
  display.write('  • search the web for the latest on <topic>\n');
  display.write('  • play me a popular song\n');
  display.write('\nType /help for all commands, /quit to exit.\n');
}

export async function probeOllama(opts: { fetchImpl: typeof fetch; timeoutMs?: number }): Promise<boolean> {
  const ms = opts.timeoutMs ?? 2_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await opts.fetchImpl('http://localhost:11434/api/tags', { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Append (or overwrite) an entry in `.env`. Existing entries with the same
 * key are replaced. New entries are appended to the bottom. Keys are
 * uppercased automatically.
 */
async function upsertEnvVar(envFile: string, key: string, value: string): Promise<void> {
  const k = key.toUpperCase();
  let body = '';
  try {
    body = await fs.readFile(envFile, 'utf8');
  } catch {
    body = '';
  }
  const lines = body.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(`${k}=`)) {
      lines[i] = `${k}=${value}`;
      replaced = true;
    }
  }
  if (!replaced) lines.push(`${k}=${value}`);
  // collapse trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, `${lines.join('\n')}\n`, 'utf8');
}

export async function runSetupWizard(opts: SetupOptions = {}): Promise<SetupResult> {
  const paths = opts.paths ?? resolveAidenPaths();
  const display = opts.display ?? new Display();
  const prompts = opts.prompts ?? (await defaultPrompts());
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!opts.force && !(await isFreshInstall(paths))) {
    return { ran: false, skipReason: 'config.yaml already exists; pass force=true to re-run' };
  }

  await ensureAidenDirsExist(paths);

  display.printBanner();
  display.write('\nWelcome — let\'s pick a provider.\n\n');

  // Step 1: provider selection
  const providerIndex = await prompts.choose(
    'Which provider would you like to use?',
    PROVIDERS.map((p) => p.label),
  );
  const provider = PROVIDERS[providerIndex - 1];
  if (!provider) throw new Error(`invalid provider selection: ${providerIndex}`);

  // Phase 18: real OAuth flow for kind: 'pro' providers (claude-pro,
  // chatgpt-plus). The flow is the same one /auth login uses (Task 5);
  // single entry point.
  if (provider.kind === 'pro') {
    // 1-line explainer up-front so the user knows what they're agreeing to.
    const explainer =
      PRO_EXPLAINERS[provider.id] ??
      'This connects your subscription via OAuth. No API key needed.';
    display.write(`\n${explainer}\n`);
    // Phase 18.1: honest beta framing per diagnostic 292c7cd. Some
    // upstream errors are account-state-specific and have no client-side
    // fix. We show this every time so a user who hits a wall has clear
    // remediation: rerun setup with an API-key provider.
    display.write(
      'Note: OAuth flows are beta in v4.0. If signin fails, rerun `aiden setup` and pick an API-key provider instead.\n\n',
    );

    const proceed = await prompts.confirm(
      `Continue with ${provider.label}?`,
      true,
    );
    if (!proceed) {
      display.write('\nSkipped. Run `aiden setup` again to retry, or pick a different provider.\n');
      return { ran: false, skipReason: 'oauth-skipped' };
    }

    let oauthProvider: OAuthProvider;
    try {
      oauthProvider = await loadOAuthProvider(provider.id);
    } catch (err) {
      display.write(
        display.error(
          `Could not load OAuth plugin for ${provider.label}: ${(err as Error).message}`,
        ),
      );
      return { ran: false, skipReason: 'oauth-plugin-missing' };
    }

    const ua = wizardUserAgent(prompts, display);
    const runtime = new OAuthProviderRuntime(oauthProvider, paths);
    let tokens;
    try {
      tokens = await runtime.login(ua);
    } catch (err) {
      display.write(
        display.error(
          `${provider.label} sign-in failed: ${(err as Error).message}`,
        ),
      );
      return { ran: false, skipReason: 'oauth-failed' };
    }

    // Pick a default model from the registry's known list; user can /model later.
    const modelId = oauthProvider.defaultModels?.[0] ?? '';

    const config: AidenConfig = {
      ...DEFAULT_CONFIG,
      model: { provider: provider.id, modelId },
      agent: { ...DEFAULT_CONFIG.agent, max_turns: DEFAULT_CONFIG.agent.max_turns },
      display: { ...DEFAULT_CONFIG.display, skin: 'default' },
      memory: { ...DEFAULT_CONFIG.memory },
      providers: {
        ...(DEFAULT_CONFIG.providers ?? {}),
        // Marker for /providers + future tooling. The actual bearer
        // lives in tokenStore — config.yaml does NOT carry the secret.
        [provider.id]: { auth: 'oauth' },
      },
      terminal: { backend: 'auto' },
    };

    if (opts.smokeTest) {
      display.write('\n✓ Smoke test complete — would have saved this config:\n');
      display.write(`${JSON.stringify(config, null, 2)}\n`);
      display.write(
        `(would have saved tokens to ${path.join(paths.root, 'auth', `${provider.id}.json`)})\n`,
      );
      return {
        ran: false,
        skipReason: 'smoke-test',
        config,
        envFile: paths.envFile,
      };
    }

    const cm = new ConfigManager(paths);
    await cm.save(config);

    // Confirmation surface — what's wired now.
    const expIso = new Date(tokens.expiresAtMs).toISOString();
    display.write(`\n✓ ${provider.label} authed.\n`);
    if (tokens.account) display.write(`  Account: ${tokens.account}\n`);
    if (oauthProvider.defaultModels?.length) {
      display.write(
        `  Models: ${oauthProvider.defaultModels.join(', ')}\n`,
      );
    }
    display.write(
      `  Tokens stored at: ${path.join(paths.root, 'auth', `${provider.id}.json`)}\n`,
    );
    display.write(`  Expires: ${expIso}\n`);
    display.write(
      `\nTokens encrypted with a machine-derived key. Protects against casual ` +
        `file inspection but NOT against code execution on this machine. ` +
        `Real OS keychain integration in v4.1.\n`,
    );
    printPostWizardTutorial(display, AIDEN_VERSION);

    return { ran: true, config, envFile: paths.envFile };
  }

  // Step 2: model selection
  let modelId = provider.defaultModel ?? '';
  if (provider.models && provider.models.length > 1) {
    const modelIndex = await prompts.choose(
      `Pick a model for ${provider.label}`,
      provider.models,
    );
    modelId = provider.models[modelIndex - 1];
  } else if (provider.kind === 'local') {
    modelId = await prompts.input('Ollama model id', { default: provider.defaultModel ?? 'llama3.1:8b' });
  } else if (!modelId) {
    modelId = await prompts.input('Model id', { default: '' });
  }

  // Step 3: credentials
  let apiKey: string | undefined;
  let baseUrl: string | undefined;

  if (provider.kind === 'local') {
    const reachable = await probeOllama({ fetchImpl });
    if (!reachable) {
      display.write(
        display.error(
          'Ollama not reachable on http://localhost:11434',
          'install from https://ollama.com, run `ollama serve`, then re-run `aiden setup`.',
        ),
      );
      return { ran: false, skipReason: 'ollama-not-reachable' };
    }
  } else if (provider.kind === 'custom') {
    baseUrl = await prompts.input('Base URL (e.g. https://api.example.com/v1)');
    apiKey = await prompts.input('API key', { mask: true });
  } else if (provider.kind === 'key' || provider.kind === 'subscription') {
    if (provider.envVar) {
      apiKey = await prompts.input(`API key for ${provider.label}`, { mask: true });
    }
  }

  // Step 3.5: validate the API key against the provider endpoint.
  // Bypassed when smokeTest or skipValidation is set, or when there's no key
  // to validate (Ollama, or a subscription provider without an env var).
  const shouldValidate =
    !opts.smokeTest &&
    !opts.skipValidation &&
    typeof apiKey === 'string' &&
    apiKey.length > 0;

  if (shouldValidate) {
    const validate = opts.validator ?? validateProviderKey;
    const maxAttempts = 3;
    let attempt = 1;

    // First attempt uses the key already collected. Subsequent attempts
    // re-prompt for a fresh key (and baseUrl, for custom).
    while (attempt <= maxAttempts) {
      const spinner = display.startSpinner(`Validating ${provider.label} API key…`);
      let result;
      try {
        result = await validate(provider.id, apiKey as string, baseUrl, fetchImpl);
      } finally {
        spinner.stop();
      }

      if (result.valid) {
        if (result.skipped) {
          display.write(
            `${kleur.dim(
              `Skipped validation: ${result.skipReason ?? 'no validation endpoint'}. The key will be tested on first call.`,
            )}\n`,
          );
        } else {
          display.write(`${kleur.green(`✓ ${provider.label} API key validated`)}\n`);
        }
        break;
      }

      // Invalid — show error, re-prompt if we have attempts left.
      display.write(
        display.error(
          `Validation failed: ${result.reason ?? 'unknown error'}`,
          'Re-enter the key, or press Ctrl+C to exit.',
        ),
      );

      if (attempt >= maxAttempts) {
        throw new Error(
          'Could not validate key after 3 attempts. Run `aiden setup --skip-validation` to bypass.',
        );
      }

      // Re-prompt for credentials.
      if (provider.kind === 'custom') {
        baseUrl = await prompts.input('Base URL (e.g. https://api.example.com/v1)', {
          default: baseUrl,
        });
        apiKey = await prompts.input('API key', { mask: true });
      } else {
        apiKey = await prompts.input(`API key for ${provider.label}`, { mask: true });
      }
      attempt += 1;
    }
  }

  // Step 4: terminal backend (basic — keeps wizard in scope for 14a).
  // Default to "auto" — full picker lands in 14b.
  const terminalBackend: 'auto' | 'inline' | 'fullscreen' = 'auto';

  // Step 5: save
  const config: AidenConfig = {
    ...DEFAULT_CONFIG,
    model: { provider: provider.id, modelId },
    agent: { ...DEFAULT_CONFIG.agent, max_turns: DEFAULT_CONFIG.agent.max_turns },
    display: { ...DEFAULT_CONFIG.display, skin: 'default' },
    memory: { ...DEFAULT_CONFIG.memory },
    providers: {
      ...(DEFAULT_CONFIG.providers ?? {}),
      [provider.id]: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(provider.envVar ? { apiKey: `\${${provider.envVar}}` } : {}),
      },
    },
    terminal: { backend: terminalBackend },
  };

  if (opts.smokeTest) {
    display.write('\n✓ Smoke test complete — would have saved this config:\n');
    display.write(`${JSON.stringify(config, null, 2)}\n`);
    if (apiKey && provider.envVar) {
      display.write(`(would have written ${provider.envVar}=*** to ${paths.envFile})\n`);
    }
    if (baseUrl && provider.kind === 'custom') {
      display.write(`(would have written CUSTOM_BASE_URL=${baseUrl} to ${paths.envFile})\n`);
    }
    display.write('(no files written because --smoke-test was passed)\n');
    return { ran: false, skipReason: 'smoke-test', config, envFile: paths.envFile };
  }

  const cm = new ConfigManager(paths);
  await cm.save(config);

  if (apiKey && provider.envVar) {
    await upsertEnvVar(paths.envFile, provider.envVar, apiKey);
  }
  if (baseUrl && provider.kind === 'custom') {
    await upsertEnvVar(paths.envFile, 'CUSTOM_BASE_URL', baseUrl);
  }

  // Step 6: tutorial
  display.write(
    `\n${kleur.green(`✓ ${provider.label}`)} configured with model ${kleur.cyan(modelId)}.\n`,
  );
  printPostWizardTutorial(display, AIDEN_VERSION);

  return { ran: true, config, envFile: paths.envFile };
}

// ---------------------------------------------------------------------------
// Direct invocation: `npx tsx cli/v4/setupWizard.ts [--smoke-test] [--force]`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const smokeTest = argv.includes('--smoke-test');
  const force = argv.includes('--force');
  const skipValidation = argv.includes('--skip-validation');
  runSetupWizard({ smokeTest, force, skipValidation })
    .then((result) => {
      if (!result.ran && result.skipReason && result.skipReason !== 'smoke-test') {
        // Skipped for a reason that's already been displayed; non-zero so callers can detect.
        process.exit(0);
      }
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Setup wizard failed:', err);
      process.exit(1);
    });
}
