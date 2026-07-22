export interface ProviderModelPolicy {
  mainDefault: string;
  auxiliaryDefault?: string;
  curatedModels: readonly string[];
  /** Boot profile that fits the provider's fresh-account request budget. */
  setupToolProfile?: 'minimal' | 'standard';
  deprecated?: Readonly<Record<string, { shutdownDate: string; replacements: readonly string[] }>>;
}

/** Curated policy used when live provider discovery is unavailable. */
export const PROVIDER_MODEL_POLICIES: Readonly<Record<string, ProviderModelPolicy>> =
  Object.freeze({
    groq: Object.freeze({
      mainDefault: 'openai/gpt-oss-120b',
      auxiliaryDefault: 'openai/gpt-oss-20b',
      curatedModels: Object.freeze(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']),
      setupToolProfile: 'minimal',
      deprecated: Object.freeze({
        'mixtral-8x7b-32768': Object.freeze({
          shutdownDate: '2025-03-20',
          replacements: Object.freeze(['openai/gpt-oss-120b']),
        }),
        'llama-3.1-8b-instant': Object.freeze({
          shutdownDate: '2026-08-16',
          replacements: Object.freeze(['openai/gpt-oss-20b']),
        }),
        'llama-3.3-70b-versatile': Object.freeze({
          shutdownDate: '2026-08-16',
          replacements: Object.freeze(['openai/gpt-oss-120b', 'qwen/qwen3.6-27b']),
        }),
      }),
    }),
    together: Object.freeze({
      mainDefault: 'openai/gpt-oss-120b',
      auxiliaryDefault: 'openai/gpt-oss-20b',
      curatedModels: Object.freeze([
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      ]),
    }),
    deepseek: Object.freeze({
      mainDefault: 'deepseek-v4-pro',
      auxiliaryDefault: 'deepseek-v4-flash',
      curatedModels: Object.freeze([
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-chat',
        'deepseek-reasoner',
      ]),
      deprecated: Object.freeze({
        'deepseek-chat': Object.freeze({
          shutdownDate: '2026-07-24',
          replacements: Object.freeze(['deepseek-v4-pro']),
        }),
        'deepseek-reasoner': Object.freeze({
          shutdownDate: '2026-07-24',
          replacements: Object.freeze(['deepseek-v4-pro']),
        }),
      }),
    }),
    huggingface: Object.freeze({
      mainDefault: 'openai/gpt-oss-120b',
      auxiliaryDefault: 'openai/gpt-oss-20b',
      curatedModels: Object.freeze([
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      ]),
    }),
  });
