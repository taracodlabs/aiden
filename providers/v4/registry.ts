/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/registry.ts — Aiden v4.0.0
 *
 * The single source of truth for the 19 providers Aiden supports.
 * Each entry carries the metadata `RuntimeResolver` needs to instantiate
 * an adapter and the metadata the Phase 13 menu UI needs to render the
 * picker.
 *
 * Status: PHASE 5.
 *
 * Each row carries the (provider → api_mode) mapping plus connection
 * metadata (api_key_env_vars, inference_base_url). One flat row per
 * provider — TypeScript object literal beats a giant switch when the
 * dispatch fan-out is small and stable.
 *
 * Adding a provider: append a row + add its models to MODEL_CATALOG. The
 * runtime resolver picks both up automatically — no other edits needed.
 */

import { ApiMode } from './types';

export interface ProviderRegistryEntry {
  /** Stable identifier, e.g. 'anthropic', 'groq', 'together'. */
  id: string;
  /** Human-friendly name for UI. */
  displayName: string;
  /** Which API mode this provider speaks. */
  apiMode: ApiMode;
  /** Default base URL (no trailing slash). */
  baseUrl: string;
  /** Env var name that holds the API key (null for OAuth-only or local). */
  apiKeyEnvVar: string | null;
  /** Description for the picker UI. */
  description: string;
  /** Tier classification for menu ordering. */
  tier: 'pro' | 'free' | 'paid' | 'local' | 'subscription';
  /** Free tier offered? */
  hasFreeTier: boolean;
  /** Optional: provider-specific extra headers (e.g. OpenRouter HTTP-Referer). */
  extraHeaders?: Record<string, string>;
  /** Optional: documentation URL shown in the picker. */
  docsUrl?: string;
  /**
   * Whether this provider supports tool calling on at least one model.
   * Per-model overrides live in the catalog; this is the menu-level hint.
   */
  supportsToolCalling: boolean;
  /** Model IDs offered by this provider. Full metadata in MODEL_CATALOG. */
  modelIds: string[];
  /**
   * Phase 18: OAuth-backed provider. When present, the runtime resolver
   * reads the bearer token from `<aiden-home>/auth/<oauth.providerId>.json`
   * (the tokenStore managed by the Phase 18 OAuth plugins) and passes it
   * as the `apiKey` to the underlying adapter. The adapter never knows
   * the difference between an API key and an OAuth bearer.
   *
   * Set on `claude-pro` and `chatgpt-plus`. Legacy `claude_subscription`
   * and `chatgpt_subscription` entries (Phase 5 stubs, no OAuth wiring)
   * stay as-is and remain unusable until removed in a future cleanup.
   */
  oauth?: { providerId: string };
}

/**
 * The supported providers. Order is roughly menu-presentation order
 * (subscription tiers first, then flagship paid, then free, then local).
 *
 * Phase 21 #5 unification: ONE registry entry per OAuth service. The
 * legacy `claude_subscription` / `chatgpt_subscription` snake_case stubs
 * (Phase 5, no OAuth wiring) have been removed: one canonical provider
 * name per service. Source tags (claude_code, oauth_pkce, device_code,
 * etc.) seed credentials INTO that single entry — they never appear as
 * parallel registry rows.
 *
 * Canonical IDs match the plugin manifests, the setup wizard, the /auth
 * slash command, and the tokenStore filename. Inference-time credential
 * lookup is `runtimeResolver.resolveCredentials → entry.oauth.providerId
 * → tokenStore` — one path, no fallback to a deprecated auth.json.
 */
export const PROVIDER_REGISTRY: Record<string, ProviderRegistryEntry> = {
  // ─── Subscription / OAuth (Phase 18 tokenStore-wired) ────────────────────
  'claude-pro': {
    id: 'claude-pro',
    displayName: 'Claude Pro / Max (OAuth)',
    apiMode: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnvVar: null,
    oauth: { providerId: 'claude-pro' },
    description: 'Sign in with your Claude Pro/Max subscription. No API key needed.',
    tier: 'subscription',
    hasFreeTier: false,
    docsUrl: 'https://docs.anthropic.com/',
    supportsToolCalling: true,
    modelIds: ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  'chatgpt-plus': {
    id: 'chatgpt-plus',
    displayName: 'ChatGPT Plus (OAuth)',
    apiMode: 'codex_responses',
    // Inference base URL per audit § ChatGPT Plus — chatgpt.com Codex
    // endpoint, NOT api.openai.com. Plugin describeRuntime() agrees.
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKeyEnvVar: null,
    oauth: { providerId: 'chatgpt-plus' },
    description: 'Sign in with your ChatGPT Plus subscription. No API key needed.',
    tier: 'subscription',
    hasFreeTier: false,
    docsUrl: 'https://platform.openai.com/docs/',
    supportsToolCalling: true,
    // Phase 21 #6: Codex slugs from a live probe of
    // chatgpt.com/backend-api/codex/models (Apr 2026). Direct OpenAI API names
    // (gpt-5-mini, gpt-5-codex) are NOT valid here — Codex OAuth has
    // its own slug taxonomy.
    modelIds: [
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2',
      'gpt-5',
    ],
  },
  nous_portal: {
    id: 'nous_portal',
    displayName: 'Nous Portal',
    apiMode: 'chat_completions',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    apiKeyEnvVar: 'NOUS_PORTAL_API_KEY',
    description: 'Nous Research portal-managed inference (subscription).',
    tier: 'subscription',
    hasFreeTier: false,
    docsUrl: 'https://nousresearch.com/',
    supportsToolCalling: true,
    modelIds: ['Hermes-3-Llama-3.1-405B', 'DeepHermes-3-Llama-3-8B-Preview'],
  },

  // ─── Flagship paid APIs ──────────────────────────────────────────────────
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic API',
    apiMode: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    description: 'Direct Anthropic API access — flagship Claude models.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://docs.anthropic.com/',
    supportsToolCalling: true,
    modelIds: ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI API',
    apiMode: 'codex_responses',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    description: 'Direct OpenAI API access — GPT-5 family via /v1/responses.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://platform.openai.com/docs/',
    supportsToolCalling: true,
    modelIds: ['gpt-5.4', 'gpt-5.2', 'gpt-5-codex', 'gpt-5-nano'],
  },

  // ─── Free / freemium APIs ────────────────────────────────────────────────
  groq: {
    id: 'groq',
    displayName: 'Groq',
    apiMode: 'chat_completions',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVar: 'GROQ_API_KEY',
    description: 'Ultra-fast inference on open-weight models — generous free tier.',
    tier: 'free',
    hasFreeTier: true,
    docsUrl: 'https://console.groq.com/docs/',
    supportsToolCalling: true,
    modelIds: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini',
    apiMode: 'chat_completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    description: 'Google Gemini via the OpenAI-compatible endpoint.',
    tier: 'free',
    hasFreeTier: true,
    docsUrl: 'https://ai.google.dev/',
    supportsToolCalling: true,
    modelIds: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  },
  nvidia: {
    id: 'nvidia',
    displayName: 'NVIDIA NIM',
    apiMode: 'chat_completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnvVar: 'NVIDIA_API_KEY',
    description: 'NVIDIA NIM hosted inference — free credits with developer account.',
    tier: 'free',
    hasFreeTier: true,
    docsUrl: 'https://build.nvidia.com/',
    supportsToolCalling: true,
    modelIds: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-v3'],
  },
  huggingface: {
    id: 'huggingface',
    displayName: 'Hugging Face',
    apiMode: 'chat_completions',
    baseUrl: 'https://api-inference.huggingface.co/v1',
    apiKeyEnvVar: 'HF_TOKEN',
    description: 'Hugging Face Inference API — free tier on most open-weight models.',
    tier: 'free',
    hasFreeTier: true,
    docsUrl: 'https://huggingface.co/docs/api-inference/',
    supportsToolCalling: true,
    modelIds: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
  },

  // ─── Aggregators / paid APIs ─────────────────────────────────────────────
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    apiMode: 'chat_completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    description: 'OpenRouter — 200+ models routed through one API.',
    tier: 'paid',
    hasFreeTier: true,
    extraHeaders: {
      'HTTP-Referer': 'https://aiden.ai',
      'X-Title': 'Aiden',
    },
    docsUrl: 'https://openrouter.ai/docs/',
    supportsToolCalling: true,
    modelIds: [
      'anthropic/claude-opus-4.7',
      'anthropic/claude-sonnet-4.6',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
      'google/gemini-2.5-pro',
      'openai/gpt-5.4',
      'qwen/qwen-2.5-72b-instruct',
    ],
  },
  together: {
    id: 'together',
    displayName: 'Together AI',
    apiMode: 'chat_completions',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnvVar: 'TOGETHER_API_KEY',
    description: 'Together AI — fast hosted inference for Llama, DeepSeek, Mixtral.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://docs.together.ai/',
    supportsToolCalling: true,
    modelIds: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'meta-llama/Llama-3.1-8B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
    ],
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    apiMode: 'chat_completions',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek direct API — V4 Pro reasoning flagship + legacy aliases.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://api-docs.deepseek.com/',
    supportsToolCalling: true,
    // Phase v4.1.2-deepseek: `deepseek-v4-pro` prepended as the new
    // flagship — becomes the auto-pick default for new users via
    // pickProbeModel(). Legacy `deepseek-chat` and `deepseek-reasoner`
    // retained for back-compat (still functional aliases of the V4
    // flash family per DeepSeek docs; deprecated-but-live). Removal
    // is its own deprecation slice. Per-call thinking + reasoning
    // _effort defaults for v4-pro live in providers/v4/modelDefaults.ts.
    modelIds: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    apiMode: 'chat_completions',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    description: 'Mistral AI direct API — Large, Codestral, and Ministral.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://docs.mistral.ai/',
    supportsToolCalling: true,
    modelIds: ['mistral-large-latest', 'codestral-latest'],
  },
  zai: {
    id: 'zai',
    displayName: 'Z.AI / GLM',
    apiMode: 'chat_completions',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnvVar: 'ZAI_API_KEY',
    description: 'Zhipu AI / GLM — flagship Chinese frontier models.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://docs.z.ai/',
    supportsToolCalling: true,
    modelIds: ['glm-4.6', 'glm-4.5'],
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi / Moonshot',
    apiMode: 'chat_completions',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnvVar: 'KIMI_API_KEY',
    description: 'Moonshot AI / Kimi — long-context flagship models.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://platform.moonshot.ai/docs/',
    supportsToolCalling: true,
    modelIds: ['kimi-k2-turbo-preview', 'kimi-k2-0905-preview'],
  },
  minimax: {
    id: 'minimax',
    displayName: 'MiniMax',
    apiMode: 'chat_completions',
    baseUrl: 'https://api.minimax.io/v1',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    description: 'MiniMax — agentic flagship M2 family.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://www.minimax.io/platform_overview',
    supportsToolCalling: true,
    modelIds: ['MiniMax-M2', 'MiniMax-M2.1'],
  },
  vercel_gateway: {
    id: 'vercel_gateway',
    displayName: 'Vercel AI Gateway',
    apiMode: 'chat_completions',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKeyEnvVar: 'VERCEL_AI_GATEWAY_KEY',
    description: 'Vercel AI Gateway — unified gateway with usage analytics.',
    tier: 'paid',
    hasFreeTier: false,
    docsUrl: 'https://vercel.com/docs/ai-gateway/',
    supportsToolCalling: true,
    modelIds: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.4'],
  },
  custom_openai: {
    id: 'custom_openai',
    displayName: 'Custom OpenAI-compatible',
    apiMode: 'chat_completions',
    baseUrl: 'http://localhost:8000/v1',
    apiKeyEnvVar: 'CUSTOM_OPENAI_API_KEY',
    description: 'Any OpenAI-compatible endpoint — supply your own base URL.',
    tier: 'paid',
    hasFreeTier: false,
    supportsToolCalling: true,
    modelIds: ['custom-default'],
  },

  // ─── Local ───────────────────────────────────────────────────────────────
  ollama: {
    id: 'ollama',
    displayName: 'Ollama (local)',
    apiMode: 'ollama_prompt_tools',
    baseUrl: 'http://localhost:11434',
    apiKeyEnvVar: null,
    description: 'Local Ollama with prompt-injected tool calling — no API key needed.',
    tier: 'local',
    hasFreeTier: true,
    docsUrl: 'https://github.com/ollama/ollama/',
    supportsToolCalling: true,
    modelIds: ['llama3.2', 'qwen2.5:7b', 'gemma2:2b'],
  },
};

/** Returns the registry entry for `id`, or `undefined` when unknown. */
export function getProviderEntry(id: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY[id];
}

/** Returns all registered provider IDs (insertion order). */
export function listProviderIds(): string[] {
  return Object.keys(PROVIDER_REGISTRY);
}
