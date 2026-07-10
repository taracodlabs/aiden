/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/runtimeResolver.ts — Aiden v4.0.0
 *
 * Maps (providerId, modelId) → fully-wired `ProviderAdapter`.
 *
 * Walks the credential precedence chain:
 *   1. `apiKeyOverride` (CLI arg)
 *   2. `config.get('providers.{id}.apiKey')` (config.yaml — Phase 6+ via ConfigManager)
 *   3. `process.env[entry.apiKeyEnvVar]`
 *   4. `credentialResolver.getCredentialsForMode(apiMode)` (auth.json OAuth)
 *   5. Local providers (ollama) — no credentials needed
 *
 * Error contract: throws `ProviderError` with a clear, user-actionable
 * message when the provider/model is unknown or no credentials can be
 * resolved. The "available: ..." list in the error keeps the picker
 * unblocked even when the user typoed a name.
 *
 * Status: PHASE 5.
 *
 *   Aiden v4 collapses provider dispatch into one switch on `apiMode`
 *   because the per-provider quirks (URL stripping, OpenCode
 *   model-family inference, Azure auth bypass, AWS SDK chain) are
 *   deferred to Phase 8 / 13.
 */

import { ApiMode, ProviderAdapter, RuntimeResolution } from './types';
import { ProviderError } from './errors';
import {
  PROVIDER_REGISTRY,
  ProviderRegistryEntry,
  getProviderEntry,
} from './registry';
import {
  MODEL_CATALOG,
  ModelEntry,
  findModel,
  listModelsForProvider,
} from './modelCatalog';
import { CredentialResolver } from './credentialResolver';
import { ChatCompletionsAdapter } from './chatCompletionsAdapter';
import { AnthropicAdapter } from './anthropicAdapter';
import { CodexResponsesAdapter } from './codexResponsesAdapter';
import { OllamaPromptToolsAdapter } from './ollamaPromptToolsAdapter';
import { getModelDefaults } from './modelDefaults';
// v4.14.x — every adapter the factory hands out is wrapped so a shared message
// preflight runs before ANY provider call. The single seam; no caller can skip it.
import { withMessagePreflight } from './preflightAdapter';
import {
  loadTokens,
  isExpired,
  PREFLIGHT_REFRESH_WINDOW_MS,
} from '../../core/v4/auth/tokenStore';
import type { AidenPaths } from '../../core/v4/paths';

/**
 * Minimal interface RuntimeResolver consumes from the config layer. The
 * Phase 6 `core/v4/config.ts::ConfigManager` is the production
 * implementation; tests typically pass an inline `{ get: () => ... }`.
 */
export interface ConfigProvider {
  get(key: string): string | undefined;
}

export interface ResolveOptions {
  providerId: string;
  modelId: string;
  /** Override for API key — used by tests + CLI args. */
  apiKeyOverride?: string;
  /** Override for base URL — used by `custom_openai` and tests. */
  baseUrlOverride?: string;
  /** Reserved for `aiden doctor` diagnostics — currently unused. */
  credentialSourceHint?: 'cli' | 'config' | 'env' | 'auth.json' | 'default';
  /** Optional config provider — typically a Phase 6 `ConfigManager`. */
  config?: ConfigProvider;
  /**
   * Phase 18: Aiden user-data paths. When present and the resolved provider
   * has `oauth: { providerId }` in the registry, the credential chain
   * reads the bearer token from the tokenStore (`<paths.root>/auth/<id>.json`)
   * and passes it as the apiKey. Auto-refresh during inference is NOT done
   * here — when tokens are within the pre-flight refresh window, the
   * resolver throws a clear "run /auth refresh" error. (Auto-refresh during
   * inference is a v4.1 follow-up; v4.0 ships explicit /auth refresh.)
   */
  paths?: AidenPaths;
}

interface ResolvedCredentials {
  apiKey: string | null;
  source: RuntimeResolution['source'];
  oauthRefreshable?: boolean;
}

/**
 * Models with an announced end-of-life, keyed `${providerId}:${modelId}`.
 * DeepSeek retires its legacy `deepseek-chat` / `deepseek-reasoner` aliases
 * on 2026-07-24 in favour of the V4 line — surface a one-line heads-up at
 * resolve time so a session on a dying model sees the date and the migration
 * target before it's pulled.
 */
const DEPRECATED_MODELS: Readonly<Record<string, { date: string; replacement: string }>> =
  Object.freeze({
    'deepseek:deepseek-chat':     { date: '2026-07-24', replacement: 'deepseek-v4-pro' },
    'deepseek:deepseek-reasoner': { date: '2026-07-24', replacement: 'deepseek-v4-pro' },
  });

/**
 * One-line deprecation notice for a resolved (provider, model), or null when
 * the model has no announced end-of-life. Pure — `resolve()` emits it via
 * `console.warn`; callers/tests can also consume the string directly.
 */
export function deprecationNotice(providerId: string, modelId: string): string | null {
  const d = DEPRECATED_MODELS[`${providerId}:${modelId}`];
  if (!d) return null;
  return `${providerId}:${modelId} is deprecated and stops working on ${d.date} — switch to ${d.replacement}.`;
}

export class RuntimeResolver {
  constructor(private readonly credentialResolver: CredentialResolver) {}

  /**
   * Build a fully-wired adapter for `(providerId, modelId)`. Throws
   * `ProviderError` when the provider, model, or credentials are missing.
   */
  async resolve(options: ResolveOptions): Promise<ProviderAdapter> {
    const { entry, model, baseUrl, credentials } = await this.describeInternal(options);

    // One-line heads-up when a session resolves a model with an announced EOL.
    const eol = deprecationNotice(entry.id, model.id);
    if (eol) console.warn(`⚠️  ${eol}`);

    switch (entry.apiMode) {
      case 'chat_completions':
        if (!credentials.apiKey) {
          throw missingKeyError(entry);
        }
        return withMessagePreflight(new ChatCompletionsAdapter({
          baseUrl,
          apiKey: credentials.apiKey,
          model: model.id,
          providerName: entry.id,
          extraHeaders: entry.extraHeaders,
          // Phase v4.1.2-deepseek: per-model body defaults (e.g.
          // DeepSeek V4-Pro's mandatory thinking + reasoning_effort).
          // Undefined for models without registered defaults — adapter
          // skips the merge in that case.
          defaultExtraBody: getModelDefaults(entry.id, model.id)?.extraBody,
        }));

      case 'anthropic_messages':
        if (!credentials.apiKey) {
          throw missingKeyError(entry);
        }
        return withMessagePreflight(new AnthropicAdapter({
          baseUrl,
          apiKey: credentials.apiKey,
          model: model.id,
          providerName: entry.id,
          extraHeaders: entry.extraHeaders,
        }));

      case 'codex_responses':
        if (!credentials.apiKey) {
          throw missingKeyError(entry);
        }
        return withMessagePreflight(new CodexResponsesAdapter({
          baseUrl,
          apiKey: credentials.apiKey,
          model: model.id,
          providerName: entry.id,
          extraHeaders: entry.extraHeaders,
        }));

      case 'ollama_prompt_tools':
        return withMessagePreflight(new OllamaPromptToolsAdapter({
          baseUrl,
          model: model.id,
          providerName: entry.id,
        }));

      default:
        // Exhaustiveness guard — switch covers every member of ApiMode.
        throw new ProviderError(
          `Unsupported apiMode '${entry.apiMode satisfies never}' for provider '${entry.id}'.`,
          entry.id,
        );
    }
  }

  /**
   * Returns the resolution data without instantiating an adapter.
   * Useful for `aiden doctor` diagnostics or dry-run previews.
   */
  async describe(options: ResolveOptions): Promise<RuntimeResolution> {
    const { entry, baseUrl, credentials } = await this.describeInternal(options);
    return {
      provider: entry.id,
      apiMode: entry.apiMode,
      baseUrl,
      apiKey: credentials.apiKey,
      oauthRefreshable: credentials.oauthRefreshable,
      source: credentials.source,
    };
  }

  /** All providers in registry order — feeds the picker UI. */
  listProviders(): ProviderRegistryEntry[] {
    return Object.values(PROVIDER_REGISTRY);
  }

  /** All models for `providerId`. Empty when unknown — never throws. */
  listModels(providerId: string): ModelEntry[] {
    return listModelsForProvider(providerId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async describeInternal(options: ResolveOptions): Promise<{
    entry: ProviderRegistryEntry;
    model: ModelEntry;
    baseUrl: string;
    credentials: ResolvedCredentials;
  }> {
    const entry = getProviderEntry(options.providerId);
    if (!entry) {
      const available = Object.keys(PROVIDER_REGISTRY).join(', ');
      throw new ProviderError(
        `Provider '${options.providerId}' not found. Available: ${available}`,
        options.providerId,
      );
    }

    const model = findModel(entry.id, options.modelId);
    if (!model) {
      const available = listModelsForProvider(entry.id)
        .map((m) => m.id)
        .join(', ');
      throw new ProviderError(
        `Model '${options.modelId}' not found for provider '${entry.id}'. ` +
          `Available: ${available || '(none)'}`,
        entry.id,
      );
    }

    const baseUrl = (options.baseUrlOverride ?? entry.baseUrl).replace(/\/+$/, '');
    const credentials = await this.resolveCredentials(entry, options);
    return { entry, model, baseUrl, credentials };
  }

  private async resolveCredentials(
    entry: ProviderRegistryEntry,
    options: ResolveOptions,
  ): Promise<ResolvedCredentials> {
    // 1. CLI override.
    if (options.apiKeyOverride && options.apiKeyOverride.length > 0) {
      return { apiKey: options.apiKeyOverride, source: 'cli' };
    }

    // 1b. Phase 18: OAuth bearer from tokenStore. Wins over config/env so
    // a stale env var can't shadow a fresh OAuth login. Only applies when
    // the registry entry declares `oauth.providerId` AND the caller passed
    // a paths handle (boot path does; tests opt in).
    if (entry.oauth && options.paths) {
      const tokens = await loadTokens(options.paths, entry.oauth.providerId);
      if (tokens && tokens.accessToken) {
        if (isExpired(tokens, PREFLIGHT_REFRESH_WINDOW_MS)) {
          throw new ProviderError(
            `OAuth token for ${entry.id} is expired or about to expire. ` +
              `Run \`/auth refresh ${entry.id}\` (or \`/auth login ${entry.id}\` if refresh fails).`,
            entry.id,
          );
        }
        return {
          apiKey: tokens.accessToken,
          source: 'auth.json',
          oauthRefreshable: !!tokens.refreshToken,
        };
      }
      // No tokens for an OAuth-only provider — surface the clearest error.
      if (entry.apiKeyEnvVar === null) {
        throw new ProviderError(
          `${entry.id} requires OAuth login. Run \`/auth login ${entry.id}\`.`,
          entry.id,
        );
      }
    }

    // 2. Config provider (Phase 6 ConfigManager or test stub).
    if (options.config) {
      const fromConfig = options.config.get(`providers.${entry.id}.apiKey`);
      if (fromConfig && fromConfig.length > 0) {
        return { apiKey: fromConfig, source: 'config' };
      }
    }

    // 3. Env var.
    if (entry.apiKeyEnvVar) {
      const fromEnv = process.env[entry.apiKeyEnvVar];
      if (fromEnv && fromEnv.length > 0) {
        return { apiKey: fromEnv, source: 'env' };
      }
    }

    // 4. OAuth via credentialResolver.
    if (
      entry.apiMode === 'anthropic_messages' ||
      entry.apiMode === 'codex_responses'
    ) {
      try {
        const creds = await this.credentialResolver.getCredentialsForMode(entry.apiMode);
        const refreshed = await this.credentialResolver.refreshIfNeeded(creds);
        const token = refreshed.oauthToken ?? refreshed.apiKey;
        if (token && token.length > 0) {
          return {
            apiKey: token,
            source: 'auth.json',
            oauthRefreshable: refreshed.oauthRefreshable,
          };
        }
      } catch (err) {
        // No usable auth.json entry — surface a clearer error for OAuth-only
        // providers and fall through for paid providers that still might
        // succeed via a missing env var (handled by the missingKeyError
        // below). Phase 21 #5: the canonical OAuth provider (chatgpt-plus)
        // hits the entry.oauth fast-path above, so this
        // legacy branch only fires for raw anthropic_messages/codex_responses
        // entries that lack oauth.providerId — i.e. nothing in the live
        // registry today, kept as a safety net for custom-config providers.
        if (entry.apiKeyEnvVar === null) {
          throw new ProviderError(
            `OAuth credentials missing or expired for ${entry.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            entry.id,
            undefined,
            err,
          );
        }
      }
    }

    // 5. Local providers — no credentials required.
    if (entry.apiMode === 'ollama_prompt_tools') {
      return { apiKey: null, source: 'default' };
    }

    return { apiKey: null, source: 'default' };
  }
}

function missingKeyError(entry: ProviderRegistryEntry): ProviderError {
  if (entry.apiKeyEnvVar) {
    return new ProviderError(
      `No API key found for ${entry.id}. Set the ${entry.apiKeyEnvVar} environment variable ` +
        `or add it to config.yaml under providers.${entry.id}.apiKey.`,
      entry.id,
    );
  }
  return new ProviderError(
    `No credentials found for ${entry.id}. Run 'aiden model' to authenticate.`,
    entry.id,
  );
}

// Make MODEL_CATALOG re-exportable at the resolver entry point so callers
// don't need to import from two files when both are needed.
export { MODEL_CATALOG };
