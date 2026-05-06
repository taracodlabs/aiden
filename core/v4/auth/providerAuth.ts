/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/auth/providerAuth.ts — Aiden v4.0.0 (Phase 18)
 *
 * Provider-agnostic interface for OAuth providers contributed by plugins.
 *
 * Each OAuth provider plugin (claude-pro, chatgpt-plus, ...) constructs an
 * `OAuthProvider` and registers it with the runtime via the new
 * `auth-providers` plugin permission. The /auth slash command, the setup
 * wizard, and the token-refresh middleware all consume providers through
 * this surface — they do not know whether a given provider uses copy-paste,
 * device-code, or some future flow.
 *
 * Hermes has no analogous abstraction (each provider's auth lives in its
 * own module). Aiden centralises here because plugins should not have to
 * re-derive the boilerplate of "save tokens / read tokens / refresh on
 * 401" — that's repeated, mechanical, and should be one piece of code.
 */

import type { AidenPaths } from '../paths';
import type { OAuthFlowResult } from './oauthFlow';
import {
  loadTokens,
  saveTokens,
  clearTokens,
  isExpired,
  PREFLIGHT_REFRESH_WINDOW_MS,
  type OAuthTokens,
} from './tokenStore';

/**
 * UI surface threaded into login()/refresh() so the provider can show
 * progress, prompt for a paste, or open a browser. Identical shape to
 * `OAuthUserAgent` in oauthFlow.ts but re-exported here so plugins
 * import a single module.
 */
export interface OAuthUserAgent {
  log(line: string): void;
  openBrowser(url: string): Promise<void>;
  prompt(question: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

/**
 * Plugin-implemented contract. The plugin's `register(ctx)` calls
 * `ctx.registerOAuthProvider(provider)` (Phase 18 PluginContext addition).
 */
export interface OAuthProvider {
  /** Provider id used as the tokenStore filename and /auth subcommand arg. */
  readonly id: string;
  /** Human-readable display name for the wizard and /auth status. */
  readonly displayName: string;
  /** Optional model whitelist — appended to the model picker once authed. */
  readonly defaultModels?: string[];
  /** Free-form short description shown next to the provider in the wizard. */
  readonly description?: string;

  /**
   * Run the interactive login flow. Returns the freshly-issued token
   * bundle. The OAuthProviderRuntime persists it via tokenStore.
   *
   * Plugins typically call `runCopyPasteFlow` or `runDeviceCodeFlow` from
   * oauthFlow.ts and translate the result. They MAY enrich `extras` with
   * provider-specific fields (account email, base URL override).
   */
  login(ua: OAuthUserAgent): Promise<OAuthFlowResult>;

  /**
   * Refresh an expired or near-expiry token bundle. Returns a new bundle.
   * Throws when refresh-token is missing or the provider rejects the
   * refresh — caller falls back to a fresh login() flow.
   */
  refresh(refreshToken: string): Promise<OAuthFlowResult>;

  /**
   * Optional: describe the inference shape so the runtime can register
   * this provider on the model-resolver chain. Returned descriptor is
   * informational; actual provider integration happens in the plugin's
   * `register()` (which may call `ctx.registerProvider(...)` once that
   * hook lands).
   */
  describeRuntime?(): {
    apiMode: 'anthropic_messages' | 'codex_responses' | 'chat_completions';
    baseUrl?: string;
    headerName?: string; // e.g. 'Authorization'
    headerPrefix?: string; // e.g. 'Bearer '
  };
}

/**
 * Runtime helper that wraps an OAuthProvider with the tokenStore round-trip
 * and the pre-flight refresh window. /auth and the inference adapter both
 * consume `getAccessToken(paths)` to pull a fresh bearer.
 *
 * Phase 20: optional `silentRefreshAllowed` predicate gates the pre-flight
 * refresh path. When the predicate returns false (free tier), pre-flight
 * refresh is suppressed — the runtime returns the still-valid token (good
 * for the next ~5 min) and surfaces a `onRefreshGated` hint so the CLI can
 * tell the user to run /auth refresh. Hard-expired tokens still refresh
 * regardless of tier (otherwise free-tier OAuth would stop working
 * mid-session, which is an unacceptable degradation). This matches the
 * Phase 20 spec: "Pro users get silent token refresh during inference,
 * free tier gets explicit /auth refresh" — interpreted as "Pro avoids
 * the 5-min pre-expiry stutter; free tier sees it once per token."
 */
export interface SilentRefreshGate {
  /** Returns true if silent pre-flight refresh is allowed (Pro tier). */
  allowed(): Promise<boolean>;
  /** Optional hint surface — called once per gated refresh. */
  onGated?(providerId: string): void;
}

export class OAuthProviderRuntime {
  constructor(
    public readonly provider: OAuthProvider,
    private readonly paths: AidenPaths,
    private readonly silentRefresh?: SilentRefreshGate,
  ) {}

  /** Run the provider's login flow and persist the result. */
  async login(ua: OAuthUserAgent): Promise<OAuthTokens> {
    const result = await this.provider.login(ua);
    return await this.persist(result);
  }

  /** Get a valid access token, refreshing if within the pre-flight window. */
  async getAccessToken(opts: { force?: boolean } = {}): Promise<string | null> {
    const tokens = await loadTokens(this.paths, this.provider.id);
    if (!tokens) return null;

    const expired = isExpired(tokens);
    const inPreflightWindow =
      Date.now() + PREFLIGHT_REFRESH_WINDOW_MS >= tokens.expiresAtMs;
    const stale = opts.force || expired || inPreflightWindow;
    if (!stale) return tokens.accessToken;

    // Phase 20 gate: if this is a *pre-flight* refresh (not yet expired)
    // and silent refresh is not allowed, surface the hint and return the
    // still-valid token. Force or hard-expired always refreshes.
    if (
      this.silentRefresh &&
      !opts.force &&
      !expired &&
      inPreflightWindow
    ) {
      const allowed = await this.silentRefresh.allowed();
      if (!allowed) {
        this.silentRefresh.onGated?.(this.provider.id);
        return tokens.accessToken;
      }
    }

    if (!tokens.refreshToken) {
      // No refresh token → tell caller to re-login.
      return null;
    }
    try {
      const refreshed = await this.provider.refresh(tokens.refreshToken);
      const persisted = await this.persist(refreshed);
      return persisted.accessToken;
    } catch {
      // Refresh failed (network, revoked) — caller falls back to /auth login.
      return null;
    }
  }

  /** Read current tokens without refreshing. Used by /auth status. */
  async readTokens(
    opts: { onError?: (msg: string) => void } = {},
  ): Promise<OAuthTokens | null> {
    return loadTokens(this.paths, this.provider.id, opts);
  }

  /** Force a refresh now and persist the new bundle. Used by `/auth refresh`. */
  async refreshNow(): Promise<OAuthTokens> {
    const tokens = await loadTokens(this.paths, this.provider.id);
    if (!tokens || !tokens.refreshToken) {
      throw new Error(
        `${this.provider.id}: no refresh token on disk — run /auth login first`,
      );
    }
    const refreshed = await this.provider.refresh(tokens.refreshToken);
    return this.persist(refreshed);
  }

  /** Drop tokens. Used by `/auth logout`. */
  async logout(): Promise<void> {
    await clearTokens(this.paths, this.provider.id);
  }

  /** Persist a flow result as a tokenStore record. */
  private async persist(result: OAuthFlowResult): Promise<OAuthTokens> {
    // Phase 18 Task 4: lift `extras.account` / `extras.email` into the
    // top-level `account` field so /providers + /auth status can render
    // "Authed as <name>" without reaching into provider-specific extras.
    const account =
      result.extras &&
      typeof (result.extras as Record<string, unknown>).account === 'string'
        ? ((result.extras as Record<string, unknown>).account as string)
        : result.extras &&
            typeof (result.extras as Record<string, unknown>).email ===
              'string'
          ? ((result.extras as Record<string, unknown>).email as string)
          : undefined;

    const tokens: OAuthTokens = {
      provider: this.provider.id,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAtMs: Date.now() + result.expiresInSeconds * 1000,
      models: this.provider.defaultModels,
      account,
      extras: result.extras,
    };
    await saveTokens(this.paths, tokens);
    return tokens;
  }
}

/**
 * In-memory registry of constructed OAuth providers. Plugins call
 * `registerOAuthProvider` from their `register(ctx)`; the runtime keeps
 * one of these alongside the existing PluginRegistry. /auth and the
 * setup wizard read from it.
 *
 * Kept separate from PluginRegistry so a provider's lifecycle is tied
 * to its plugin's lifecycle without coupling auth code to plugin code.
 */
export class OAuthProviderRegistry {
  private readonly providers = new Map<string, OAuthProvider>();

  register(provider: OAuthProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`OAuth provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): OAuthProvider | undefined {
    return this.providers.get(id);
  }

  list(): OAuthProvider[] {
    return [...this.providers.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  /** Build the runtime helper for a provider (or undefined when unknown). */
  runtimeFor(id: string, paths: AidenPaths): OAuthProviderRuntime | undefined {
    const p = this.providers.get(id);
    return p ? new OAuthProviderRuntime(p, paths) : undefined;
  }

  clear(): void {
    this.providers.clear();
  }
}
