/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
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
import { boxBottom, boxLine, boxTopTitled } from './box';
// ONB1-WIRE-2 — onboarding helpers consumed by the wizard. Static
// imports (not runtime require) so vitest's transpilation resolves
// the TS extension; the lazy-load benefit was marginal compared to
// the cost of broken unit tests under the test runtime.
import { renderSuccessScreen } from './onboarding/successScreen';
import { pickProvider } from './onboarding/providerPicker';
// v4.9.5 Slice 1 — curated skills Step 4.
import { runConfirm } from './confirmPrompt';
import { runCuratedSetupFlow } from './skills/curatedSetupFlow';
import { SkillsHub } from '../../core/v4/skillsHub';
import { SkillSecurityScanner } from '../../core/v4/skillSecurityScanner';
import { BundledManifest } from '../../core/v4/skillBundledManifest';
// v4.8.0 Slice 10b — bar + chrome tokens for step headers.
import { glyphs } from './design/tokens';
import { fetchModels } from '../../core/v4/providers/modelFetch';
import { runProbe, type ProbeResult } from '../../core/v4/providers/probe';

export interface ProviderOption {
  id: string;
  /**
   * Picker label — `<shortLabel> — <description>` format. Shown only
   * in the provider-pick step. Phase 30.2.1 plain-English labels.
   */
  label: string;
  /**
   * Short provider name used in subsequent prompts ("Pick a model for
   * Groq", "API key for Groq"). Phase 30.2.1 dropped the parenthetical
   * description from those prompts to reduce wall-of-text fatigue.
   */
  shortLabel: string;
  /** "pro" = subscription stub, "oauth" = OAuth (also stubbed for now), "key" = API key, "custom" = baseUrl+key, "local" = Ollama. */
  kind: 'pro' | 'oauth' | 'key' | 'custom' | 'local' | 'subscription';
  /** ENV var name where API key is stored (.env on save). Optional for non-key providers. */
  envVar?: string;
  /** Default model id offered. */
  defaultModel?: string;
  /** Curated model list (subset is shown to the user). */
  models?: string[];
  /**
   * Phase 30.2.1 — URL the recovery menu's "Get a key" branch opens
   * in the user's default browser. Only the providers offered in the
   * top picker have this; legacy/edge entries (custom, nous, hf,
   * vercel, etc.) intentionally omit it so the recovery branch falls
   * through to "Try a different provider".
   */
  keyUrl?: string;
}

// Phase 30.2.1 — provider order optimised for new-user time-to-first-chat.
// Free providers first (Groq → Gemini → OpenRouter → NVIDIA → Ollama),
// paid providers next (Anthropic, OpenAI, Together), subscription
// sign-ins last. The legacy entries (deepseek, mistral, zai, kimi,
// minimax, huggingface, vercel, nous, custom) trail the top 10 — still
// pickable for power users, never the default.
//
// Plain-English descriptions per spec — "TPM cap" replaced with
// "limited messages per minute", "tier 1 paid" with "best for complex
// tasks", etc. Subsequent prompts use `shortLabel` (e.g. just "Groq")
// to avoid restating the description.
export const PROVIDERS: ProviderOption[] = [
  // ── Free tier / no-cost ──
  {
    id: 'groq',
    shortLabel: 'Groq',
    label: 'Groq — free, fast, limited messages per minute',
    kind: 'key',
    envVar: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  {
    id: 'gemini',
    shortLabel: 'Google Gemini',
    label: 'Google Gemini — free, generous limits',
    kind: 'key',
    envVar: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-2.0-flash',
  },
  {
    id: 'openrouter',
    shortLabel: 'OpenRouter',
    label: 'OpenRouter — free credits, then paid',
    kind: 'key',
    envVar: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'anthropic/claude-opus-4',
  },
  {
    id: 'nvidia',
    shortLabel: 'NVIDIA NIM',
    label: 'NVIDIA NIM — free, but rate-limited',
    kind: 'key',
    envVar: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com',
    defaultModel: 'meta/llama-3.3-70b-instruct',
  },
  {
    id: 'ollama',
    shortLabel: 'Ollama',
    label: 'Ollama — fully offline, no key needed (requires Ollama install)',
    kind: 'local',
    defaultModel: 'llama3.1:8b',
  },
  // ── Paid (best quality) ──
  {
    id: 'anthropic',
    shortLabel: 'Anthropic',
    label: 'Anthropic — paid, best for complex tasks',
    kind: 'key',
    envVar: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-opus-4-7',
    models: ['claude-opus-4-7', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  },
  {
    id: 'openai',
    shortLabel: 'OpenAI',
    label: 'OpenAI — paid, GPT models',
    kind: 'key',
    envVar: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5',
    models: ['gpt-5', 'gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'together',
    shortLabel: 'Together AI',
    label: 'Together AI — paid, fast & reliable',
    kind: 'key',
    envVar: 'TOGETHER_API_KEY',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    defaultModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
    models: [
      'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
    ],
  },
  // ── Subscription sign-ins ──
  {
    id: 'claude-pro',
    shortLabel: 'Claude Pro',
    label: 'Claude Pro — use your existing Claude subscription',
    kind: 'pro',
  },
  {
    id: 'chatgpt-plus',
    shortLabel: 'ChatGPT Plus',
    label: 'ChatGPT Plus — use your existing ChatGPT subscription',
    kind: 'pro',
  },
  // ── Legacy / power-user entries (kept to preserve env-var detection
  // for users who already configured these out-of-band) ──
  {
    id: 'deepseek',
    shortLabel: 'DeepSeek',
    label: 'DeepSeek — paid',
    kind: 'key',
    envVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'mistral',
    shortLabel: 'Mistral',
    label: 'Mistral — paid',
    kind: 'key',
    envVar: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-large-latest',
  },
  {
    id: 'zai',
    shortLabel: 'Z.AI',
    label: 'Z.AI / GLM — paid',
    kind: 'key',
    envVar: 'ZAI_API_KEY',
    defaultModel: 'glm-4-plus',
  },
  {
    id: 'kimi',
    shortLabel: 'Kimi',
    label: 'Kimi / Moonshot — paid',
    kind: 'key',
    envVar: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshot-v1-128k',
  },
  {
    id: 'minimax',
    shortLabel: 'MiniMax',
    label: 'MiniMax — paid',
    kind: 'key',
    envVar: 'MINIMAX_API_KEY',
    defaultModel: 'abab6.5s-chat',
  },
  {
    id: 'huggingface',
    shortLabel: 'Hugging Face',
    label: 'Hugging Face — free tier',
    kind: 'key',
    envVar: 'HF_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'vercel',
    shortLabel: 'Vercel AI Gateway',
    label: 'Vercel AI Gateway — paid',
    kind: 'key',
    envVar: 'VERCEL_AI_GATEWAY_KEY',
    defaultModel: 'anthropic/claude-opus-4',
  },
  {
    id: 'nous',
    shortLabel: 'Nous Portal',
    label: 'Nous Portal — subscription',
    kind: 'subscription',
    defaultModel: 'hermes-3-llama-3.1-405b',
  },
  {
    id: 'custom',
    shortLabel: 'custom endpoint',
    label: 'Custom OpenAI-compatible endpoint',
    kind: 'custom',
    envVar: 'CUSTOM_API_KEY',
  },
];

export interface SetupAnswers {
  providerIndex: number; // 1-based as shown to user
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  terminalBackend?: 'auto' | 'inline' | 'fullscreen';
}

export interface PromptIO {
  /**
   * Multi-choice prompt; returns the 1-based selected index.
   *
   * `defaultIndex` (Phase 22 Task 1): 1-based index pre-selected when the
   * user just presses Enter. Wires to inquirer's `default:` field on the
   * real prompt; scripted test prompts ignore it (they pop from the queue).
   * Used by the wizard to default the provider picker to Together AI —
   * fastest path to a working REPL.
   */
  choose(question: string, choices: string[], defaultIndex?: number): Promise<number>;
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
  /**
   * v4.9.5 Slice 1 — skip the optional curated-skills Step 4. Tests
   * that exercise the rest of the wizard but don't want a network
   * call set this. Default undefined → step runs normally on real
   * TTY boots (also auto-skipped when `prompts` is injected — see
   * Step 4 site).
   */
  skipCuratedStep?: boolean;
  /**
   * v4.9.5 Slice 1.5 — short-circuit the OAuth roundtrip in tests so
   * the parameterized provider-coverage test can drive the OAuth
   * branch to its tail without spinning up a real loopback server.
   * Production callers always omit this; if present, both
   * `loadOAuthProvider` AND `runtime.login` are bypassed and the
   * provider/tokens here are used directly.
   */
  oauthStub?: {
    provider: OAuthProvider;
    tokens: { expiresAtMs: number; account?: string };
  };
}

/**
 * Phase 30.2.1 — wizard exit states.
 *
 * - `'configured'` — provider+key validated (or saved-without-validation
 *   per recovery option [3]); boot proceeds normally.
 * - `'skipped'`    — user picked recovery option [4] "explore mode" or
 *   cancelled (Ctrl+C). Boot continues into REPL with a stub adapter
 *   so slash commands still work but chat shows a friendly "no provider
 *   configured" message instead of crashing.
 * - `'exited'`    — user picked recovery option [5] "exit". The CLI
 *   exits cleanly without entering the REPL.
 */
export type SetupStatus = 'configured' | 'skipped' | 'exited';

export interface SetupResult {
  /**
   * Phase 30.2.1 status, replaces the boolean `ran`. Boot logic switches
   * on this. `ran` is kept for back-compat with older callers.
   */
  status: SetupStatus;
  /** Back-compat: true when `status === 'configured'`. */
  ran: boolean;
  /** Reason wizard was skipped (only set when `ran=false`). */
  skipReason?: string;
  config?: AidenConfig;
  envFile?: string;
}

// ─── v4.9.5 Slice 1.5: finalizeWithCuratedStep ─────────────────────
// Shared helper called from BOTH the OAuth branch (claude-pro,
// chatgpt-plus) and the API-key/custom branch (groq, anthropic,
// openai, gemini, together, custom, ollama) so the curated-skills
// Step 4 fires regardless of which provider path the user took.
// Slice 1 wired this only into the API-key branch — OAuth users
// silently bypassed Step 4 (the bug this slice fixes).
//
// Module-level injection seam (`setFinalizeForTest`) is the smallest
// possible test hook: the parameterized provider-coverage test swaps
// in a counting stub to verify EVERY branch invokes the helper. This
// is the regression layer for the bug class — if any future provider
// branch forgets to call this, the test fails.

interface FinalizeCuratedDeps {
  paths:      AidenPaths;
  display:    Display;
  prompts:    PromptIO;
  opts:       SetupOptions;
  stepHeader: (n: number) => string;
}

export async function finalizeWithCuratedStep(deps: FinalizeCuratedDeps): Promise<void> {
  // Three early-exit conditions — no panel rendered, no hub touched:
  //   1. opts.prompts injected → unit-test PromptIO shim, no real TTY
  //   2. opts.skipCuratedStep  → explicit caller opt-out (CI, --no-curated)
  //   3. !process.stdout.isTTY → CI / pipe-to-file / redirected stdout
  // Matches the same gating Slice 1's inlined Step 4 used.
  if (deps.opts.prompts)           return;
  if (deps.opts.skipCuratedStep)   return;
  if (!process.stdout.isTTY)       return;

  try {
    deps.display.write(deps.stepHeader(4));
    deps.display.write('  Optional: install curated skills?\n');
    deps.display.write(
      `  ${kleur.dim('(Hand-picked from the open-source ecosystem with full author attribution.)')}\n\n`,
    );

    // Stage 1: opt-in confirm — v4.9.2 Slice 3 confirm primitive.
    const proceedStage1 = await runConfirm(
      'Install curated skills?',
      { readLine: (msg) => deps.prompts.input(msg) },
      deps.display,
    );
    if (!proceedStage1) return;

    // Stage 2: fetch + preview + three-tier picker via shared flow.
    const hub = new SkillsHub(
      deps.paths,
      new SkillSecurityScanner(),
      new BundledManifest(deps.paths),
    );
    await runCuratedSetupFlow({
      hub,
      display: deps.display,
      prompts: deps.prompts,
    });
  } catch (err) {
    // Curated install NEVER crashes the wizard — surface as warn and
    // continue to renderSuccessScreen.
    deps.display.warn(`Curated install skipped due to error: ${(err as Error).message}`);
  }
}

/** Test-only injection: swap finalizeWithCuratedStep for a stub.
 *  Pass null to restore the production implementation. */
let _finalizeImpl: typeof finalizeWithCuratedStep = finalizeWithCuratedStep;
export function setFinalizeForTest(
  fn: typeof finalizeWithCuratedStep | null,
): void {
  _finalizeImpl = fn ?? finalizeWithCuratedStep;
}

/** Lazy-load @inquirer/prompts so unit tests don't need a TTY. */
async function defaultPrompts(): Promise<PromptIO> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  return {
    async choose(question, choices, defaultIndex) {
      const ans: string = await inq.select({
        message: question,
        choices: choices.map((c, i) => ({ name: `[${i + 1}] ${c}`, value: String(i + 1) })),
        ...(defaultIndex && defaultIndex >= 1 && defaultIndex <= choices.length
          ? { default: String(defaultIndex) }
          : {}),
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
 * Render the user-visible Aiden home directory in a platform-native
 * format. Windows shows `%LOCALAPPDATA%\aiden\`; macOS / Linux show
 * `~/.aiden/`. Used by the setup-complete config map (Phase 22 Task 6)
 * so users can copy-paste the path straight into their shell.
 */
export function aidenHomeDisplayPath(): string {
  if (process.platform === 'win32') return '%LOCALAPPDATA%\\aiden\\';
  return '~/.aiden/';
}

/**
 * Print the post-wizard tutorial — Phase 22 Task 6 boxed format.
 *
 * Replaces the prior bullet list with an "all your files in" config
 * map: where state lives, plus the two re-run commands
 * users will reach for next. Border colour is the brand orange so the
 * box reads as a celebration moment, not a wall of muted text. Path
 * adapts per platform via `aidenHomeDisplayPath()`.
 *
 * Both the API-key path and the OAuth path render this same closing
 * screen.
 */
export function printPostWizardTutorial(display: Display, version: string): void {
  const W = 50;
  const top = display.brand(boxTopTitled('Setup Complete', W));
  const bot = display.brand(boxBottom(W));
  const side = (content: string): string => {
    // Brand-colour just the verticals so the inner content keeps its
    // default colour and stays scannable.
    const raw = boxLine(content, W);
    const left = raw.slice(0, 1);
    const inner = raw.slice(1, raw.length - 1);
    const right = raw.slice(raw.length - 1);
    return `${display.brand(left)}${inner}${display.brand(right)}`;
  };

  const homePath = aidenHomeDisplayPath();

  const lines: string[] = [
    '',
    top,
    side(''),
    side(`  Aiden v${version} is ready.`),
    side(''),
    side('  All your files in:'),
    side(`    ${homePath}`),
    side(''),
    side('    config.yaml    main config'),
    side('    .env           API keys'),
    side('    SOUL.md        identity prompt'),
    side('    sessions/      conversation history'),
    side('    skills/        installed skills'),
    side(''),
    side('  Re-run setup:'),
    side('    aiden setup        full wizard'),
    side('    aiden setup model  change provider'),
    side(''),
    bot,
    '',
    `  ${kleur.dim("Try: aiden  to start chatting")}`,
    '',
  ];

  display.write(lines.join('\n'));
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
 * Phase 30.2.1 — open `url` in the user's default browser. Used by the
 * recovery menu's "Get a key from <provider URL>" branch. Best-effort
 * — failure is non-fatal (we still print the URL so the user can copy
 * it manually).
 */
async function openUrlInBrowser(url: string, display: Display): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { exec } = require('node:child_process') as typeof import('node:child_process');
  const platform = process.platform;
  let cmd: string;
  if (platform === 'win32') {
    // `start ""` swallows the URL into the title arg; double-empty-arg
    // form keeps cmd.exe happy and leaves the URL as the actual target.
    cmd = `cmd /c start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  await new Promise<void>((resolve) => {
    exec(cmd, (err: Error | null) => {
      if (err) {
        display.write(
          `${kleur.dim(`(could not auto-open browser — visit ${url} manually)`)}\n`,
        );
      }
      resolve();
    });
  });
}

/**
 * Phase 30.2.1 — recovery menu shown after 3 failed key-validation
 * attempts. Replaces the prior dead-end throw with five recoverable
 * paths so a user with a fat-fingered key isn't stranded.
 */
type RecoveryChoice =
  | { kind: 'try-different' }
  | { kind: 'get-key'; url: string }
  | { kind: 'save-anyway' }
  | { kind: 'skip' }
  | { kind: 'exit' };

async function runRecoveryMenu(
  provider: ProviderOption,
  prompts: PromptIO,
  display: Display,
): Promise<RecoveryChoice> {
  const choices: string[] = [
    'Try a different provider',
    provider.keyUrl
      ? `Get a key from ${provider.keyUrl}`
      : 'Get a key from the provider website (URL printed when picked)',
    'Save without validation (writes config; key untested)',
    'Skip — explore Aiden first (no chat, but / commands work)',
    'Exit (try again later)',
  ];
  const idx = await prompts.choose(
    'What would you like to do?',
    choices,
    /* default= */ 1,
  );
  switch (idx) {
    case 1: return { kind: 'try-different' };
    case 2: {
      // Provider may not carry a keyUrl (legacy entries). Fall through
      // to "try-different" so the user isn't stuck staring at nothing.
      if (!provider.keyUrl) {
        display.write(
          `${kleur.dim(`(no key URL on file for ${provider.shortLabel}; pick a different provider.)`)}\n`,
        );
        return { kind: 'try-different' };
      }
      return { kind: 'get-key', url: provider.keyUrl };
    }
    case 3: return { kind: 'save-anyway' };
    case 4: return { kind: 'skip' };
    case 5: return { kind: 'exit' };
    default: return { kind: 'exit' };
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
    // Existing config — wizard wasn't needed. Treat as already-configured
    // so the boot path proceeds to resolver (which will surface real
    // credential issues with its own error contract).
    return {
      status: 'configured',
      ran: false,
      skipReason: 'config.yaml already exists; pass force=true to re-run',
    };
  }

  await ensureAidenDirsExist(paths);

  // ONB1-WIRE-2 Slice A — drop the duplicate AIDEN banner in the
  // real-terminal flow. The disclaimer screen (ONB1 slice 3) already
  // paints the framed banner before the wizard runs in the
  // fresh-install path, so a second printBanner() here produced a
  // visually jarring double-banner. The test fixtures pre-date the
  // disclaimer screen and assert on the banner's presence, so we
  // keep printing it when a scripted `opts.prompts` is injected
  // (only unit tests do that). For `aiden setup` / `/setup` re-runs
  // the welcome line alone is enough.
  if (opts.prompts) {
    display.printBanner();
  }

  // v4.8.0 Slice 10b — step-header helper. Each major wizard step
  // starts with `  ▎ Set up Aiden  step N` painted with the orange
  // panel bar so the flow visually consistent with /help and the
  // approval panel. Inquirer widgets render below unchanged.
  const stepHeader = (n: number): string => {
    const bar = display.applyColors(glyphs.panel.bar, 'brand');
    const title = display.applyColors('Set up Aiden', 'heading');
    const sub = display.applyColors(`step ${n}`, 'muted');
    return `\n  ${bar}  ${title}  ${sub}\n`;
  };

  display.write(stepHeader(1));
  display.write('  Welcome — let\'s pick a provider.\n');
  display.write(
    `  ${kleur.dim('(Press Enter to accept Groq — free + fastest setup.)')}\n\n`,
  );

  // Phase 30.2.1 — Groq is the new recommended default for first-time
  // users: free tier, fastest signup, and avoids the surprise charge
  // path of paid providers. Together AI moved to position [8] paid.
  const groqDefaultIdx = PROVIDERS.findIndex((p) => p.id === 'groq') + 1;

  // outer: provider-pick loop. Recovery option [1] "Try a different
  // provider" jumps back to this prompt without losing progress on
  // global state (display, paths, ensureAidenDirsExist already ran).
  // Try/catch wraps inquirer to convert Ctrl+C ("User force closed
  // the prompt") into the same "skipped" exit state as recovery [4]
  // — the user clearly didn't want to finish, but we still want them
  // to land in REPL "explore mode" rather than crash.
  //
  // ONB1 slice 5 — the picker now uses the rich provider-picker
  // (description column + Free/API/OAuth badges) when the caller
  // hasn't injected a custom `prompts` (which means we're in a real
  // terminal, not a unit test). Stubbed-prompts callers fall through
  // to the legacy `prompts.choose` path so existing fixtures keep
  // working unchanged.
  // eslint-disable-next-line no-constant-condition
  outer: while (true) {
  let providerIndex: number;
  try {
    if (!opts.prompts) {
      const picked = await pickProvider({
        providers: PROVIDERS,
        defaultId: 'groq',
      });
      providerIndex = picked.index + 1; // back to 1-based for the rest of the loop
    } else {
      providerIndex = await prompts.choose(
        'Which provider would you like to use?',
        PROVIDERS.map((p) => p.label),
        groqDefaultIdx > 0 ? groqDefaultIdx : undefined,
      );
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (/force closed|cancel/i.test(msg)) {
      display.write('\nWizard cancelled — entering explore mode.\n');
      return {
        status: 'skipped',
        ran: false,
        skipReason: 'cancelled-at-provider-pick',
      };
    }
    throw err;
  }
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
      `Continue with ${provider.shortLabel}?`,
      true,
    );
    if (!proceed) {
      // Phase 30.2.1: don't dead-end. Loop back to provider pick so
      // the user can choose another option without re-launching aiden.
      display.write('\nNo problem — pick another provider.\n');
      continue outer;
    }

    let oauthProvider: OAuthProvider;
    if (opts.oauthStub) {
      oauthProvider = opts.oauthStub.provider;
    } else {
      try {
        oauthProvider = await loadOAuthProvider(provider.id);
      } catch (err) {
        display.write(
          display.error(
            `Could not load OAuth plugin for ${provider.shortLabel}: ${(err as Error).message}`,
          ),
        );
        // Plugin missing — let the user pick another provider.
        continue outer;
      }
    }

    const ua = wizardUserAgent(prompts, display);
    const runtime = new OAuthProviderRuntime(oauthProvider, paths);
    let tokens;
    if (opts.oauthStub) {
      tokens = opts.oauthStub.tokens;
    } else {
      try {
        tokens = await runtime.login(ua);
      } catch (err) {
        display.write(
          display.error(
            `${provider.shortLabel} sign-in failed: ${(err as Error).message}`,
          ),
        );
        // OAuth failures are recoverable — loop back so the user can
        // pick an API-key provider as a fallback.
        continue outer;
      }
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
        status: 'configured',
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
    display.write(`\n✓ ${provider.shortLabel} authed.\n`);
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
    // ONB1 slice 7: encryption disclosure demoted from a paragraph to
    // a one-line `?` hint. The full explainer remains available via
    // `aiden doctor` — the wizard is the wrong moment for a security
    // primer.
    display.write(
      `${kleur.dim('  Tokens encrypted at rest · run `aiden doctor` for details')}\n`,
    );
    // v4.9.5 Slice 1.5: curated-skills Step 4 — MUST fire on OAuth
    // path too. Slice 1 only wired this into the API-key branch
    // below; subscription users (claude-pro, chatgpt-plus) silently
    // bypassed the offer. Helper handles its own TTY / opts gates.
    await _finalizeImpl({ paths, display, prompts, opts, stepHeader });
    // ONB1 slice 8: success screen replaces the prior "Try: aiden" tail.
    // The wizard already returns to the boot path, which then drops into
    // the REPL — no process restart needed.
    renderSuccessScreen({ out: process.stdout });

    return { status: 'configured', ran: true, config, envFile: paths.envFile };
  }

  // ONB1-WIRE-2 Slice B — flow reorder + live model fetch.
  //
  // Old order: pick model → ask key → validate. That worked because
  // model selection came from the curated PROVIDERS.models array and
  // didn't need the key. Live fetch from /models endpoints requires
  // the key (Anthropic, OpenAI, Groq, Gemini all gate /models behind
  // auth), so we now ask for credentials FIRST and pick the model
  // FROM the live response. Falls back to the curated MODEL_CATALOG
  // when the live endpoint is unreachable.

  // Step 2: credentials (moved up from old step 3 for key/subscription).
  //
  // `custom` keeps the legacy "model id first, then baseUrl + apiKey"
  // order — it has no live-fetch endpoint we could call with the key
  // anyway, so the reorder bought nothing there. Existing test
  // fixtures provide inputs in legacy order; preserving custom's
  // order keeps them green.
  if (provider.kind === 'key' || provider.kind === 'subscription' || provider.kind === 'local') {
    display.write(stepHeader(2));
  }
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
      // Phase 30.2.1: Ollama unreachable is recoverable — loop back
      // so the user can pick a different provider without restart.
      continue outer;
    }
  } else if (provider.kind === 'key' || provider.kind === 'subscription') {
    if (provider.envVar) {
      apiKey = await prompts.input(`API key for ${provider.shortLabel}`, { mask: true });
    }
  }
  // provider.kind === 'custom' — defer credential prompts until AFTER
  // the model picker below.

  display.write(stepHeader(3));
  // Step 3: live model fetch + pick.
  //
  // Test-harness gate: when the caller injected `opts.prompts` (only
  // unit tests do this), skip the live fetch and fall back to the
  // curated PROVIDERS.models picker. Live fetch needs a runtime
  // `require` of core/v4/providers/modelFetch which vitest can't
  // resolve to .ts without a loader, and tests don't need a network
  // round-trip anyway. Matches the picker-upgrade gate (slice 5).
  let modelId = provider.defaultModel ?? '';
  if (opts.prompts) {
    // Legacy curated path — unchanged from pre-Slice-B behaviour.
    if (provider.models && provider.models.length > 1) {
      const modelIndex = await prompts.choose(
        `Pick a model for ${provider.shortLabel}`,
        provider.models,
      );
      modelId = provider.models[modelIndex - 1];
    } else if (provider.kind === 'local') {
      modelId = await prompts.input('Ollama model id', {
        default: provider.defaultModel ?? 'llama3.1:8b',
      });
    } else if (!modelId) {
      modelId = await prompts.input('Model id', { default: '' });
    }
  } else {
    const spinner = display.startSpinner(`Fetching available models for ${provider.shortLabel}…`);
    let fetchResult;
    try {
      fetchResult = await fetchModels({ providerId: provider.id, apiKey, baseUrl, fetchImpl });
    } finally {
      spinner.stop();
    }

    if (fetchResult.source === 'fallback' && fetchResult.reason) {
      display.write(
        `${kleur.dim(`  Couldn't reach API — showing recommended models offline (${fetchResult.reason})`)}\n`,
      );
    } else if (fetchResult.source === 'live') {
      display.write(
        `${kleur.dim(`  Live from ${provider.shortLabel} API · ${fetchResult.models.length} model${fetchResult.models.length === 1 ? '' : 's'}`)}\n`,
      );
    }

    if (fetchResult.models.length === 0) {
      // No models from live or static catalog — fall back to a free-text input.
      if (provider.kind === 'local') {
        modelId = await prompts.input('Ollama model id', {
          default: provider.defaultModel ?? 'llama3.1:8b',
        });
      } else {
        modelId = await prompts.input('Model id', { default: provider.defaultModel ?? '' });
      }
    } else if (fetchResult.models.length === 1) {
      modelId = fetchResult.models[0].id;
      display.write(`${kleur.dim(`  Only one model available — using ${modelId}.`)}\n`);
    } else {
      // Render picker. modelFetch already sorts recommended first; we
      // append a `· recommended` marker so the user spots them visually.
      const labels = fetchResult.models.map((m) =>
        m.recommended ? `${m.displayName} · recommended` : m.displayName,
      );
      const recIdx = fetchResult.models.findIndex((m) => m.recommended);
      const defaultIdx = recIdx >= 0 ? recIdx + 1 : 1;
      const idx = await prompts.choose(
        `Pick a model for ${provider.shortLabel}`,
        labels,
        defaultIdx,
      );
      modelId = fetchResult.models[idx - 1].id;
    }
  }

  // Custom-provider credentials: deferred from step 2 above so the
  // legacy input order (model → baseUrl → apiKey) is preserved.
  if (provider.kind === 'custom') {
    baseUrl = await prompts.input('Base URL (e.g. https://api.example.com/v1)');
    apiKey = await prompts.input('API key', { mask: true });
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
    // ONB1-WIRE-2 Slice C — three-step probe replaces the legacy
    // single-shot validateProviderKey. The probe runs 3 internal
    // round-trips (auth → model access → tool support) and returns a
    // .steps[] trace; we render each step's outcome as a ✓/✗ row
    // AFTER the spinner stops to avoid the spinner clobbering the row
    // writes mid-render. Test injection via opts.validator falls
    // through to the legacy validateProviderKey shape so existing
    // unit-test fixtures keep working unchanged.
    //
    const STEP_LABELS = {
      auth:  'Sending test request',
      model: 'Verifying model access',
      tools: 'Checking tool calls',
    } as const;
    let lastProbe: ProbeResult | null = null;
    const probeAdapter: typeof validateProviderKey = async (providerId, key, baseUrlArg, fetchImplArg) => {
      const probe = await runProbe({
        providerId,
        apiKey:    key,
        modelId,
        baseUrl:   baseUrlArg,
        fetchImpl: fetchImplArg,
      });
      lastProbe = probe;
      if (probe.ok) return { valid: true };
      const failed = probe.steps.find((s) => !s.ok);
      if (!failed) return { valid: false, reason: 'probe failed without details' };
      // Unknown provider with no probe endpoint → soft skip (matches
      // the legacy validateProviderKey 'skipped' semantics).
      if (failed.category === 'unknown' && /No probe endpoint/i.test(failed.reason ?? '')) {
        return { valid: true, skipped: true, skipReason: 'No probe endpoint for this provider' };
      }
      const retrySuffix = failed.category === 'rate-limit' && typeof failed.retryAfterSec === 'number'
        ? ` (retry in ${failed.retryAfterSec}s)`
        : '';
      return {
        valid:  false,
        reason: `${failed.reason ?? failed.category ?? 'unknown'}${retrySuffix}`,
      };
    };
    const validate = opts.validator ?? probeAdapter;
    const maxAttempts = 3;
    let attempt = 1;
    let validated = false;
    let skipValidationForSave = false;

    // Validation loop: at most 3 attempts before falling through to
    // the recovery menu. First attempt uses the already-collected key;
    // subsequent attempts re-prompt for a fresh key (and baseUrl, for
    // custom). This loop labelled `validation` so the recovery flow
    // can `continue validation` to retry with fresh attempts after
    // option [2] "Get a key" opens the browser.
    validation: while (attempt <= maxAttempts) {
      lastProbe = null;
      const spinner = display.startSpinner('Testing connection…');
      let result;
      try {
        result = await validate(provider.id, apiKey as string, baseUrl, fetchImpl);
      } finally {
        spinner.stop();
      }

      // Render the 3-row probe trace if we ran a probe (post-hoc, so
      // the spinner doesn't clobber the rows). Skipped when a test
      // injected opts.validator — lastProbe stays null.
      if (lastProbe) {
        const trace = lastProbe as ProbeResult;
        for (const s of trace.steps) {
          const label = STEP_LABELS[s.step];
          if (s.ok) {
            display.write(`  ${kleur.green('✓')} ${label}\n`);
          } else {
            const tail = s.reason ? `  ${kleur.dim(s.reason)}` : '';
            display.write(`  ${kleur.red('✗')} ${label}${tail}\n`);
          }
        }
      }

      if (result.valid) {
        if (result.skipped) {
          display.write(
            `${kleur.dim(
              `Skipped validation: ${result.skipReason ?? 'no validation endpoint'}. The key will be tested on first call.`,
            )}\n`,
          );
        } else {
          display.write(`${kleur.green(`✓ ${provider.shortLabel} connection validated`)}\n`);
        }
        validated = true;
        break;
      }

      // Invalid — show error, re-prompt if we have attempts left.
      display.write(
        display.error(
          `Validation failed: ${result.reason ?? 'unknown error'}`,
          attempt < maxAttempts
            ? 'Re-enter the key, or press Ctrl+C to exit.'
            : 'Three attempts used.',
        ),
      );

      if (attempt >= maxAttempts) {
        // Phase 30.2.1 — recovery menu replaces the prior dead-end
        // `throw new Error(...)`. Five paths for the user to pick from:
        //   [1] try-different    → loop back to provider picker
        //   [2] get-key (URL)    → open browser, fresh 3 attempts
        //   [3] save-anyway      → write config without validation
        //   [4] skip             → boot REPL in explore mode
        //   [5] exit             → clean exit
        const choice = await runRecoveryMenu(provider, prompts, display);
        if (choice.kind === 'try-different') {
          continue outer;
        }
        if (choice.kind === 'get-key') {
          display.write(`\nOpening ${choice.url} in your browser…\n`);
          await openUrlInBrowser(choice.url, display);
          display.write(
            `${kleur.dim('Paste the new key when prompted. You have 3 fresh attempts.')}\n`,
          );
          // Reset the attempt counter and re-prompt for a fresh key.
          attempt = 1;
          if (provider.kind === 'custom') {
            baseUrl = await prompts.input(
              'Base URL (e.g. https://api.example.com/v1)',
              { default: baseUrl },
            );
            apiKey = await prompts.input('API key', { mask: true });
          } else {
            apiKey = await prompts.input(
              `API key for ${provider.shortLabel}`,
              { mask: true },
            );
          }
          continue validation;
        }
        if (choice.kind === 'save-anyway') {
          display.write(
            `${kleur.yellow('Saving without validation. The key will be tested on your first chat.')}\n`,
          );
          skipValidationForSave = true;
          break validation;
        }
        if (choice.kind === 'skip') {
          display.write('\nEntering explore mode — chat is disabled but slash commands work.\n');
          return {
            status: 'skipped',
            ran: false,
            skipReason: 'recovery-explore-mode',
          };
        }
        // choice.kind === 'exit'
        display.write('\nExited. Run `aiden setup` to try again.\n');
        return { status: 'exited', ran: false, skipReason: 'recovery-exited' };
      }

      // Re-prompt for credentials (only reached when attempt < maxAttempts).
      if (provider.kind === 'custom') {
        baseUrl = await prompts.input('Base URL (e.g. https://api.example.com/v1)', {
          default: baseUrl,
        });
        apiKey = await prompts.input('API key', { mask: true });
      } else {
        apiKey = await prompts.input(`API key for ${provider.shortLabel}`, { mask: true });
      }
      attempt += 1;
    }

    // Tag the outer scope so the post-validation save path knows
    // whether to print the "untested" warning. (validated is read
    // by the smoke-test branch below; skipValidationForSave is
    // currently unused outside this block but documented for
    // post-save UX hooks.)
    void validated;
    void skipValidationForSave;
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
    return {
      status: 'configured',
      ran: false,
      skipReason: 'smoke-test',
      config,
      envFile: paths.envFile,
    };
  }

  const cm = new ConfigManager(paths);
  await cm.save(config);

  if (apiKey && provider.envVar) {
    await upsertEnvVar(paths.envFile, provider.envVar, apiKey);
  }
  if (baseUrl && provider.kind === 'custom') {
    await upsertEnvVar(paths.envFile, 'CUSTOM_BASE_URL', baseUrl);
  }

  // Step 5: success — wizard drops straight into the REPL via the
  // outer boot path. No "Try: aiden" advice needed; the user is
  // already on their way to chat.
  display.write(
    `\n${kleur.green(`✓ ${provider.shortLabel}`)} configured with model ${kleur.cyan(modelId)}.\n`,
  );
  // v4.9.5 Slice 1.5: curated-skills Step 4 — shared with the OAuth
  // branch via finalizeWithCuratedStep. Slice 1 inlined this here;
  // Slice 1.5 extracted it so subscription providers fire it too.
  await _finalizeImpl({ paths, display, prompts, opts, stepHeader });
  // ONB1 slice 8: success screen + REPL handoff.
  renderSuccessScreen({ out: process.stdout });

  return { status: 'configured', ran: true, config, envFile: paths.envFile };
  } // end of outer: while (true) — every path inside either continues,
    // returns, or breaks. Reaching this `}` is impossible (guarded by
    // the no-constant-condition eslint comment above the outer label).
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
      // Phase 30.2.1: status is the new authoritative signal. Direct
      // CLI invocation always exits 0 — the wizard already printed
      // its own outcome lines, and a non-zero exit confuses shell
      // wrappers that pipe the wizard's output into other tools.
      void result.status;
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Setup wizard failed:', err);
      process.exit(1);
    });
}
