/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/modelCatalog.ts — Aiden v4.0.0
 *
 * Per-model metadata: context length, capabilities, pricing, default flags.
 * Joined to PROVIDER_REGISTRY by `providerId`.
 *
 * Status: PHASE 5.
 *
 *   OPENROUTER_MODELS, _xai_curated_models() (curated lists keyed by
 *   provider id). Aiden v4 keeps a static, hand-curated baseline so the
 *   picker works offline and
 *   adds models.dev hydration in a later phase.
 *
 * Pricing notes:
 *   - Numbers are USD per 1 million tokens, sourced from public pricing
 *     pages as of 2026-Q2.
 *   - Where pricing is uncertain or rapidly changing (e.g. preview models,
 *     subscription-only access, custom endpoints) we leave `pricing`
 *     undefined rather than fabricate. The picker handles both cases.
 *   - Subscription-tier rows (claude-pro, chatgpt-plus) never carry
 *     pricing — the user pays Anthropic / OpenAI a flat fee. Legacy
 *     `claude_subscription` / `chatgpt_subscription` rows were removed
 *     in Phase 21 #5; their
 *     models migrated under canonical IDs below.
 */

export interface ModelEntry {
  /** Model ID as the provider expects it on the wire. */
  id: string;
  /** Human-friendly name for UI. */
  displayName: string;
  /** Which provider serves this model — must match a PROVIDER_REGISTRY id. */
  providerId: string;
  /** Context window in tokens. */
  contextLength: number;
  /** Max output tokens (some providers cap separately from context window). */
  maxOutputTokens?: number;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  /** Pricing per 1M tokens — undefined when unknown / not applicable. */
  pricing?: { inputPerM: number; outputPerM: number };
  /** Recommended default for its provider — exactly one per provider. */
  isDefault: boolean;
  /** Tier classification for menu grouping. */
  tier: 'flagship' | 'standard' | 'small' | 'free';
  /** Optional notes for menu (e.g. "preview", "deprecated soon"). */
  notes?: string;
}

export const MODEL_CATALOG: ModelEntry[] = [
  // ─── claude-pro (Phase 18 OAuth, canonical) ──────────────────────────────
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    providerId: 'claude-pro',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: true,
    tier: 'flagship',
    notes: 'Routed through Claude Pro/Max OAuth — no per-token charges.',
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    providerId: 'claude-pro',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    providerId: 'claude-pro',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'standard',
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    providerId: 'claude-pro',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: false,
    isDefault: false,
    tier: 'small',
  },

  // ─── chatgpt-plus (Phase 18 OAuth) ───────────────────────────────────────
  // Phase 21 #6: model IDs sourced from a live probe of
  // chatgpt.com/backend-api/codex/models (Apr 2026). The Codex OAuth
  // endpoint requires its own slug list — the plain OpenAI API names
  // (`gpt-5`, `gpt-5-mini`, `gpt-5-codex`) get rejected with HTTP 400
  // "model is not supported when using Codex with a ChatGPT account"
  // for many accounts. The slugs below are the authoritative list. v4.1
  // will replace this hardcode with a live `/codex/models` probe.
  {
    id: 'gpt-5.1-codex-max',
    displayName: 'GPT-5.1 Codex Max',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: true,
    tier: 'flagship',
    notes: 'Routed through ChatGPT Plus OAuth (chatgpt.com/backend-api/codex).',
  },
  {
    id: 'gpt-5.1-codex-mini',
    displayName: 'GPT-5.1 Codex Mini',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    isDefault: false,
    tier: 'small',
  },
  {
    id: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
    notes: 'Codex caps context at 272K; direct OpenAI API serves 1.05M for the same slug.',
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'standard',
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    isDefault: false,
    tier: 'small',
  },
  {
    id: 'gpt-5.2',
    displayName: 'GPT-5.2',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'standard',
  },
  {
    id: 'gpt-5',
    displayName: 'GPT-5',
    providerId: 'chatgpt-plus',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'standard',
    notes: 'Base GPT-5; some Codex accounts entitle only the *-codex variants. If 400-rejected, switch to gpt-5.1-codex-max.',
  },

  // ─── nous_portal ─────────────────────────────────────────────────────────
  {
    id: 'Hermes-3-Llama-3.1-405B',
    displayName: 'Hermes 3 Llama 405B',
    providerId: 'nous_portal',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'DeepHermes-3-Llama-3-8B-Preview',
    displayName: 'DeepHermes 3 Llama 8B (preview)',
    providerId: 'nous_portal',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    isDefault: false,
    tier: 'small',
    notes: 'Preview release.',
  },

  // ─── anthropic ───────────────────────────────────────────────────────────
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    providerId: 'anthropic',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { inputPerM: 15.0, outputPerM: 75.0 },
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    providerId: 'anthropic',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { inputPerM: 15.0, outputPerM: 75.0 },
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    providerId: 'anthropic',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { inputPerM: 3.0, outputPerM: 15.0 },
    isDefault: false,
    tier: 'standard',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    providerId: 'anthropic',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: false,
    pricing: { inputPerM: 1.0, outputPerM: 5.0 },
    isDefault: false,
    tier: 'small',
  },

  // ─── openai ──────────────────────────────────────────────────────────────
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    providerId: 'openai',
    contextLength: 400_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'gpt-5.2',
    displayName: 'GPT-5.2',
    providerId: 'openai',
    contextLength: 400_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    providerId: 'openai',
    contextLength: 272_000,
    maxOutputTokens: 32_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'gpt-5-nano',
    displayName: 'GPT-5 Nano',
    providerId: 'openai',
    contextLength: 200_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'small',
  },

  // ─── groq ────────────────────────────────────────────────────────────────
  {
    id: 'llama-3.3-70b-versatile',
    displayName: 'Llama 3.3 70B Versatile',
    providerId: 'groq',
    contextLength: 131_072,
    maxOutputTokens: 32_768,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.59, outputPerM: 0.79 },
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'llama-3.1-8b-instant',
    displayName: 'Llama 3.1 8B Instant',
    providerId: 'groq',
    contextLength: 131_072,
    maxOutputTokens: 8_192,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.05, outputPerM: 0.08 },
    isDefault: false,
    tier: 'small',
  },
  {
    id: 'mixtral-8x7b-32768',
    displayName: 'Mixtral 8x7B',
    providerId: 'groq',
    contextLength: 32_768,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.24, outputPerM: 0.24 },
    isDefault: false,
    tier: 'standard',
  },

  // ─── gemini ──────────────────────────────────────────────────────────────
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    providerId: 'gemini',
    contextLength: 2_097_152,
    maxOutputTokens: 65_536,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { inputPerM: 1.25, outputPerM: 10.0 },
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    providerId: 'gemini',
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { inputPerM: 0.3, outputPerM: 2.5 },
    isDefault: true,
    tier: 'standard',
  },
  {
    id: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash Lite',
    providerId: 'gemini',
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: false,
    isDefault: false,
    tier: 'small',
  },

  // ─── nvidia ──────────────────────────────────────────────────────────────
  {
    id: 'meta/llama-3.3-70b-instruct',
    displayName: 'Llama 3.3 70B (NIM)',
    providerId: 'nvidia',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'deepseek-ai/deepseek-v3',
    displayName: 'DeepSeek V3 (NIM)',
    providerId: 'nvidia',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'standard',
  },

  // ─── huggingface ─────────────────────────────────────────────────────────
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct',
    displayName: 'Llama 3.3 70B Instruct',
    providerId: 'huggingface',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'Qwen/Qwen2.5-72B-Instruct',
    displayName: 'Qwen 2.5 72B Instruct',
    providerId: 'huggingface',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'standard',
  },

  // ─── openrouter ──────────────────────────────────────────────────────────
  {
    id: 'anthropic/claude-opus-4.7',
    displayName: 'Claude Opus 4.7 (via OpenRouter)',
    providerId: 'openrouter',
    contextLength: 200_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { inputPerM: 15.0, outputPerM: 75.0 },
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    displayName: 'Claude Sonnet 4.6 (via OpenRouter)',
    providerId: 'openrouter',
    contextLength: 200_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { inputPerM: 3.0, outputPerM: 15.0 },
    isDefault: false,
    tier: 'standard',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    displayName: 'Llama 3.3 70B Instruct (via OpenRouter)',
    providerId: 'openrouter',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'deepseek/deepseek-chat',
    displayName: 'DeepSeek Chat (via OpenRouter)',
    providerId: 'openrouter',
    contextLength: 64_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'standard',
  },
  {
    id: 'google/gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro (via OpenRouter)',
    providerId: 'openrouter',
    contextLength: 2_097_152,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'openai/gpt-5.4',
    displayName: 'GPT-5.4 (via OpenRouter)',
    providerId: 'openrouter',
    contextLength: 400_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'qwen/qwen-2.5-72b-instruct',
    displayName: 'Qwen 2.5 72B Instruct (via OpenRouter)',
    providerId: 'openrouter',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'standard',
  },

  // ─── together ────────────────────────────────────────────────────────────
  // openai/gpt-oss-120b is the Together default — tool-calling capable and
  // available at Build Tier 0. Replaces Qwen3-235B-…-tput, which is gated
  // behind a higher Together build tier ("not in this key's catalog" on
  // Tier-0 keys). This entry's `isDefault: true` is what marks it
  // "recommended" in the /setup picker (fallbackFor → recommended = isDefault).
  {
    id: 'openai/gpt-oss-120b',
    displayName: 'GPT-OSS 120B (Together)',
    providerId: 'together',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.15, outputPerM: 0.6 },
    isDefault: true,
    tier: 'flagship',
    notes: 'Tool-calling capable. Available at Build Tier 0.',
  },
  {
    id: 'openai/gpt-oss-20b',
    displayName: 'GPT-OSS 20B (Together)',
    providerId: 'together',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.05, outputPerM: 0.2 },
    isDefault: false,
    tier: 'small',
    notes: 'Smaller/cheaper tool-calling option. Tier-0 accessible.',
  },
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    displayName: 'Llama 3.3 70B Turbo',
    providerId: 'together',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.88, outputPerM: 0.88 },
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
    displayName: 'Llama 3.1 8B Turbo',
    providerId: 'together',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.18, outputPerM: 0.18 },
    isDefault: false,
    tier: 'small',
  },
  {
    id: 'deepseek-ai/DeepSeek-V3',
    displayName: 'DeepSeek V3',
    providerId: 'together',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'deepseek-ai/DeepSeek-R1',
    displayName: 'DeepSeek R1 (reasoning)',
    providerId: 'together',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },

  // ─── deepseek ────────────────────────────────────────────────────────────
  // v4.11 — DeepSeek V4 Pro / Flash. The provider + per-call defaults
  // (mandatory thinking + reasoning_effort) are already wired in
  // providers/v4/registry.ts + modelDefaults.ts; these catalog entries are
  // what surface them in /model. IDs confirmed against DeepSeek's official
  // docs (api.deepseek.com, OpenAI-compatible).
  //
  // contextLength mirrors the in-repo DeepSeek family value (chat/reasoner
  // = 64_000); v4-specific context + maxOutputTokens are not cited in-repo,
  // so maxOutputTokens is omitted rather than asserted. pricing is omitted
  // (unknown — no DeepSeek-direct price is cited anywhere in-repo; per the
  // header rule we leave `pricing` undefined rather than invent numbers).
  // isDefault stays FALSE — selectable, not automatic; the default + the
  // registry auto-pick wait on live tool-calling verification.
  {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    providerId: 'deepseek',
    contextLength: 64_000,           // family default; v4 context not cited in-repo
    // maxOutputTokens omitted — not cited for v4.
    // supportsToolCalling matches the provider registry flag, but is
    // PROVIDER-DECLARED, not live-verified: we have not confirmed v4-pro
    // returns tool_calls in its mandatory reasoning mode (key-blocked
    // test). Confirm when a DeepSeek key is available before flipping any
    // default/auto-pick to it.
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,         // mandatory thinking + reasoning_effort
    // pricing omitted — unknown, not cited in-repo.
    isDefault: false,
    tier: 'flagship',
  },
  {
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    providerId: 'deepseek',
    contextLength: 64_000,           // family default; v4 context not cited in-repo
    // supportsToolCalling: provider-declared, not live-verified (see v4-pro).
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    // pricing omitted — unknown, not cited in-repo.
    isDefault: false,
    tier: 'standard',
  },
  {
    // Deprecating 2026-07-24 (per DeepSeek). Per modelDefaults.ts these
    // are v4-flash aliases (chat = non-think, reasoner = think). Marker
    // surfaced in the display name so /model users see they're going away.
    id: 'deepseek-chat',
    displayName: 'DeepSeek Chat (deprecating 2026-07-24)',
    providerId: 'deepseek',
    contextLength: 64_000,
    maxOutputTokens: 8_192,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.27, outputPerM: 1.1 },
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner (R1) (deprecating 2026-07-24)',
    providerId: 'deepseek',
    contextLength: 64_000,
    maxOutputTokens: 8_192,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    pricing: { inputPerM: 0.55, outputPerM: 2.19 },
    isDefault: false,
    tier: 'flagship',
  },

  // ─── mistral ─────────────────────────────────────────────────────────────
  {
    id: 'mistral-large-latest',
    displayName: 'Mistral Large',
    providerId: 'mistral',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 2.0, outputPerM: 6.0 },
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'codestral-latest',
    displayName: 'Codestral',
    providerId: 'mistral',
    contextLength: 32_768,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { inputPerM: 0.3, outputPerM: 0.9 },
    isDefault: false,
    tier: 'standard',
  },

  // ─── zai ─────────────────────────────────────────────────────────────────
  {
    id: 'glm-4.6',
    displayName: 'GLM 4.6',
    providerId: 'zai',
    contextLength: 200_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'glm-4.5',
    displayName: 'GLM 4.5',
    providerId: 'zai',
    contextLength: 128_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'standard',
  },

  // ─── kimi ────────────────────────────────────────────────────────────────
  {
    id: 'kimi-k2-turbo-preview',
    displayName: 'Kimi K2 Turbo (preview)',
    providerId: 'kimi',
    contextLength: 256_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: true,
    tier: 'flagship',
    notes: 'Preview model.',
  },
  {
    id: 'kimi-k2-0905-preview',
    displayName: 'Kimi K2 0905 (preview)',
    providerId: 'kimi',
    contextLength: 256_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'flagship',
    notes: 'Preview model.',
  },

  // ─── minimax ─────────────────────────────────────────────────────────────
  {
    id: 'MiniMax-M2',
    displayName: 'MiniMax M2',
    providerId: 'minimax',
    contextLength: 200_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    isDefault: true,
    tier: 'flagship',
  },
  {
    id: 'MiniMax-M2.1',
    displayName: 'MiniMax M2.1',
    providerId: 'minimax',
    contextLength: 200_000,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },

  // ─── vercel_gateway ──────────────────────────────────────────────────────
  {
    id: 'anthropic/claude-sonnet-4.6',
    displayName: 'Claude Sonnet 4.6 (via Vercel)',
    providerId: 'vercel_gateway',
    contextLength: 200_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: true,
    tier: 'standard',
  },
  {
    id: 'openai/gpt-5.4',
    displayName: 'GPT-5.4 (via Vercel)',
    providerId: 'vercel_gateway',
    contextLength: 400_000,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    isDefault: false,
    tier: 'flagship',
  },

  // ─── custom_openai ───────────────────────────────────────────────────────
  {
    id: 'custom-default',
    displayName: 'Custom endpoint default',
    providerId: 'custom_openai',
    contextLength: 32_768,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: true,
    tier: 'standard',
    notes: 'Override base URL via custom_openai config; model name passes through.',
  },

  // ─── ollama ──────────────────────────────────────────────────────────────
  {
    id: 'llama3.2',
    displayName: 'Llama 3.2 (local)',
    providerId: 'ollama',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: true,
    tier: 'standard',
  },
  {
    id: 'qwen2.5:7b',
    displayName: 'Qwen 2.5 7B (local)',
    providerId: 'ollama',
    contextLength: 131_072,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'standard',
  },
  {
    id: 'gemma2:2b',
    displayName: 'Gemma 2 2B (local)',
    providerId: 'ollama',
    contextLength: 8_192,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'small',
  },
];

/** All entries that match `providerId`. Empty array when unknown provider. */
export function listModelsForProvider(providerId: string): ModelEntry[] {
  return MODEL_CATALOG.filter((m) => m.providerId === providerId);
}

/**
 * Look up a single (providerId, modelId) pair. Returns undefined when no
 * such pair exists — callers must throw their own provider/model errors.
 */
export function findModel(providerId: string, modelId: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((m) => m.providerId === providerId && m.id === modelId);
}

/** All providers (across the catalog) that serve a given bare modelId. */
export function findProvidersForModelId(modelId: string): ModelEntry[] {
  return MODEL_CATALOG.filter((m) => m.id === modelId);
}
