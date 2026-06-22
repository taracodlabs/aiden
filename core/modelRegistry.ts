/**
 * core/modelRegistry.ts
 * Curated list of best free/cheap models per provider.
 * Updated manually — not auto-discovered (keeps things simple and predictable).
 *
 * Usage:
 *   getDefaultModel('groq')              → 'llama-3.3-70b-versatile'
 *   getNextModelOnFailure('groq', 'llama-3.3-70b-versatile') → 'llama-3.1-70b-versatile'
 *   getRegistryEntry('groq', 'llama-3.3-70b-versatile')      → ModelConfig | undefined
 */

export interface ModelConfig {
  id: string
  contextWindow: number
  pricing: 'free' | 'paid'
  quality: 'high' | 'medium' | 'low'
  speed: 'fast' | 'medium' | 'slow'
  notes?: string
}

/**
 * Ordered by preference — first entry is the default.
 * Free models come before paid unless quality difference is large.
 * Env var override: set ${PROVIDER_UPPER}_MODEL to force a specific model.
 *   e.g. GROQ_MODEL=mixtral-8x7b-32768 overrides groq default
 */
export const MODEL_REGISTRY: Record<string, ModelConfig[]> = {
  groq: [
    {
      id: 'llama-3.3-70b-versatile',
      contextWindow: 128_000,
      pricing: 'free',
      quality: 'high',
      speed: 'fast',
      notes: 'Primary — fastest + highest quality free tier',
    },
    {
      id: 'llama-3.1-70b-versatile',
      contextWindow: 128_000,
      pricing: 'free',
      quality: 'high',
      speed: 'fast',
      notes: 'Fallback when 3.3 is rate-limited',
    },
    {
      id: 'llama3-70b-8192',
      contextWindow: 8_192,
      pricing: 'free',
      quality: 'high',
      speed: 'fast',
      notes: 'Smaller context but very reliable',
    },
    {
      id: 'mixtral-8x7b-32768',
      contextWindow: 32_768,
      pricing: 'free',
      quality: 'medium',
      speed: 'fast',
      notes: 'Good for structured JSON tasks',
    },
    {
      id: 'gemma2-9b-it',
      contextWindow: 8_192,
      pricing: 'free',
      quality: 'medium',
      speed: 'fast',
      notes: 'Light fallback',
    },
  ],

  openrouter: [
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      contextWindow: 131_072,
      pricing: 'free',
      quality: 'high',
      speed: 'medium',
      notes: 'Best free model on OpenRouter',
    },
    {
      id: 'meta-llama/llama-3.1-70b-instruct:free',
      contextWindow: 131_072,
      pricing: 'free',
      quality: 'high',
      speed: 'medium',
      notes: 'Reliable free fallback',
    },
    {
      id: 'mistralai/mistral-7b-instruct:free',
      contextWindow: 32_768,
      pricing: 'free',
      quality: 'medium',
      speed: 'fast',
      notes: 'Fast small model for simple tasks',
    },
    {
      id: 'google/gemma-2-9b-it:free',
      contextWindow: 8_192,
      pricing: 'free',
      quality: 'medium',
      speed: 'fast',
      notes: 'Emergency fallback',
    },
  ],

  requesty: [
    {
      id: 'openai/gpt-4o-mini',
      contextWindow: 128_000,
      pricing: 'paid',
      quality: 'high',
      speed: 'fast',
      notes: 'Cheap, fast default via Requesty gateway',
    },
    {
      id: 'openai/gpt-4o',
      contextWindow: 128_000,
      pricing: 'paid',
      quality: 'high',
      speed: 'medium',
      notes: 'Flagship OpenAI model via Requesty',
    },
    {
      id: 'anthropic/claude-sonnet-4-5',
      contextWindow: 200_000,
      pricing: 'paid',
      quality: 'high',
      speed: 'medium',
      notes: 'Strong reasoning + tool calling via Requesty',
    },
    {
      id: 'deepseek/deepseek-chat',
      contextWindow: 64_000,
      pricing: 'paid',
      quality: 'high',
      speed: 'medium',
      notes: 'Low-cost capable model via Requesty',
    },
  ],

  together: [
    {
      id: 'meta-llama/llama-3.1-405b-instruct',
      contextWindow: 130_000,
      pricing: 'paid',
      quality: 'high',
      speed: 'medium',
      notes: '405B — highest quality, use sparingly ($5 credit)',
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct-turbo',
      contextWindow: 131_072,
      pricing: 'paid',
      quality: 'high',
      speed: 'fast',
      notes: 'Faster cheaper Together option',
    },
    {
      id: 'meta-llama/llama-3.1-70b-instruct-turbo',
      contextWindow: 131_072,
      pricing: 'paid',
      quality: 'high',
      speed: 'fast',
      notes: 'Fallback paid',
    },
  ],

  nvidia: [
    {
      id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
      contextWindow: 131_072,
      pricing: 'free',
      quality: 'high',
      speed: 'medium',
      notes: 'NVIDIA NIM — high quality free inference',
    },
    {
      id: 'meta/llama-3.3-70b-instruct',
      contextWindow: 131_072,
      pricing: 'free',
      quality: 'high',
      speed: 'medium',
      notes: 'NVIDIA-hosted Llama fallback',
    },
    {
      id: 'mistralai/mixtral-8x7b-instruct-v0.1',
      contextWindow: 32_768,
      pricing: 'free',
      quality: 'medium',
      speed: 'fast',
      notes: 'Lightweight NVIDIA fallback',
    },
  ],

  gemini: [
    {
      id: 'gemini-2.5-flash',
      contextWindow: 1_000_000,
      pricing: 'free',
      quality: 'high',
      speed: 'fast',
      notes: '1M context, thinking model, best free Gemini',
    },
    {
      id: 'gemini-2.0-flash',
      contextWindow: 1_000_000,
      pricing: 'free',
      quality: 'high',
      speed: 'fast',
      notes: 'Stable previous gen, good fallback',
    },
    {
      id: 'gemini-1.5-flash',
      contextWindow: 1_000_000,
      pricing: 'free',
      quality: 'medium',
      speed: 'fast',
      notes: 'Conservative fallback if 2.x rate-limited',
    },
    {
      id: 'gemini-1.5-flash-8b',
      contextWindow: 1_000_000,
      pricing: 'free',
      quality: 'low',
      speed: 'fast',
      notes: 'Emergency fallback — smallest Gemini',
    },
  ],

  ollama: [
    {
      id: 'gemma4:e4b',
      contextWindow: 8_192,
      pricing: 'free',
      quality: 'medium',
      speed: 'medium',
      notes: 'Local default — requires GTX 1060 VRAM',
    },
    {
      id: 'qwen2.5-coder:7b',
      contextWindow: 32_768,
      pricing: 'free',
      quality: 'medium',
      speed: 'medium',
      notes: 'Local coder model',
    },
    {
      id: 'llama3.2:latest',
      contextWindow: 128_000,
      pricing: 'free',
      quality: 'medium',
      speed: 'fast',
      notes: 'Local fast model',
    },
  ],
}

/**
 * Returns the default model ID for a provider.
 * Env var ${PROVIDER_UPPER}_MODEL overrides the registry default.
 *
 * e.g. GROQ_MODEL=mixtral-8x7b-32768 → uses that instead
 */
export function getDefaultModel(provider: string): string {
  const envKey = `${provider.toUpperCase()}_MODEL`
  const envOverride = process.env[envKey]
  if (envOverride) return envOverride

  const models = MODEL_REGISTRY[provider.toLowerCase()]
  if (!models || models.length === 0) return ''
  return models[0].id
}

/**
 * Returns the next model to try after currentModel fails (rate-limited / error).
 * Returns null if currentModel is already the last in the list — caller should
 * then mark the whole provider entry rate-limited and rotate to next provider.
 */
export function getNextModelOnFailure(
  provider: string,
  currentModel: string
): string | null {
  const models = MODEL_REGISTRY[provider.toLowerCase()]
  if (!models || models.length === 0) return null

  const idx = models.findIndex(m => m.id === currentModel)
  if (idx === -1 || idx >= models.length - 1) return null
  return models[idx + 1].id
}

/**
 * Returns the ModelConfig for a specific provider + model id.
 */
export function getRegistryEntry(
  provider: string,
  modelId: string
): ModelConfig | undefined {
  const models = MODEL_REGISTRY[provider.toLowerCase()]
  if (!models) return undefined
  return models.find(m => m.id === modelId)
}

/**
 * Returns all models for a provider, optionally filtered by pricing tier.
 */
export function getModelsForProvider(
  provider: string,
  filter?: { pricing?: 'free' | 'paid' }
): ModelConfig[] {
  const models = MODEL_REGISTRY[provider.toLowerCase()] ?? []
  if (!filter) return models
  return models.filter(m => !filter.pricing || m.pricing === filter.pricing)
}
