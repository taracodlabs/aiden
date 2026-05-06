/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/credentialResolver.ts — Aiden v4.0.0
 *
 * Loads, persists, and refreshes credentials for the OAuth-capable API modes
 * (anthropic_messages, codex_responses).  chat_completions and
 * ollama_prompt_tools modes use env vars directly and do NOT touch this
 * resolver.
 *
 * Storage: a single auth.json file at:
 *   - Windows : %LOCALAPPDATA%\aiden\auth.json
 *   - Linux/Mac: ~/.aiden/auth.json
 * (Phase 4 hardcodes these paths; core/v4/paths.ts will own them in a later
 * phase.) On POSIX, auth.json is chmod 600 after every write.
 *
 * Status: PHASE 4 — load / save / preflight refresh stub.
 *   The actual OAuth refresh HTTP calls are stubbed (logged, no network).
 *   Real refresh + browser-flow initiation lands in Phase 13.
 *
 * Hermes reference: hermes_cli/auth.py — Credential / RefreshableCredential.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ApiMode, CredentialSource } from './types';
import { ProviderError } from './errors';
import { resolveAidenPaths } from '../../core/v4/paths';

/**
 * Exact on-disk shape of `auth.json`.  Modes that don't go through this
 * resolver (chat_completions, ollama_prompt_tools) are intentionally absent.
 */
export interface AuthJsonShape {
  anthropic_messages?: AuthJsonEntry;
  codex_responses?: AuthJsonEntry;
}

export interface AuthJsonEntry {
  type: 'api_key' | 'oauth';
  apiKey?: string;
  oauthToken?: string;
  refreshToken?: string;
  /** ISO 8601 timestamp. Used for the 5-minute preflight refresh check. */
  expiresAt?: string;
}

/** Internal extension of CredentialSource so refresh can update entries in-place. */
interface ResolvedCredential extends CredentialSource {
  apiMode: ApiMode;
  refreshToken?: string;
}

/** Hook the test suite injects to override / fail the (stubbed) refresh. */
export type RefreshHook = (
  apiMode: ApiMode,
  source: ResolvedCredential,
) => Promise<ResolvedCredential>;

const PREFLIGHT_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const RESOLVER_MODES: ReadonlySet<ApiMode> = new Set<ApiMode>([
  'anthropic_messages',
  'codex_responses',
]);

export class CredentialResolver {
  private readonly authJsonPath: string;
  private refreshHook?: RefreshHook;

  constructor(authJsonPath?: string) {
    this.authJsonPath = authJsonPath ?? defaultAuthJsonPath();
  }

  /** Test seam: override the (stubbed) refresh behaviour. */
  setRefreshHook(hook: RefreshHook | undefined): void {
    this.refreshHook = hook;
  }

  /** Returns the resolved auth.json path (for diagnostics / `aiden doctor`). */
  getAuthJsonPath(): string {
    return this.authJsonPath;
  }

  /**
   * Load credentials for `apiMode` from auth.json.
   * Returns null if the file doesn't exist OR the requested mode has no entry.
   * Throws if the file is malformed JSON (don't fail silently — auth bugs).
   */
  async loadCredentials(apiMode: ApiMode): Promise<CredentialSource | null> {
    if (!RESOLVER_MODES.has(apiMode)) return null;
    const all = await this.readAuthJson();
    if (!all) return null;
    const entry = all[apiMode];
    if (!entry) return null;
    return entryToSource(entry);
  }

  /**
   * Persist credentials for `apiMode` to auth.json.  Other modes' entries are
   * preserved.  Creates the parent directory if needed.  On POSIX, sets
   * permissions to 0o600 after writing.
   */
  async saveCredentials(apiMode: ApiMode, credentials: CredentialSource): Promise<void> {
    if (!RESOLVER_MODES.has(apiMode)) {
      throw new Error(
        `CredentialResolver does not manage credentials for apiMode='${apiMode}'. ` +
          `Use environment variables for chat_completions and ollama_prompt_tools.`,
      );
    }
    const existing = (await this.readAuthJson()) ?? {};
    existing[apiMode] = sourceToEntry(credentials);
    await fs.mkdir(path.dirname(this.authJsonPath), { recursive: true });
    await fs.writeFile(this.authJsonPath, JSON.stringify(existing, null, 2), 'utf8');
    if (process.platform !== 'win32') {
      try {
        await fs.chmod(this.authJsonPath, 0o600);
      } catch {
        // chmod may fail on some filesystems (network mounts, WSL crossing) —
        // not worth failing the save for. The file is still written.
      }
    }
  }

  /**
   * Resolve credentials for an apiMode, refreshing if the token is within 5
   * minutes of expiry.  Throws when no credentials exist (caller should kick
   * the OAuth wizard, but that's Phase 13).
   */
  async getCredentialsForMode(apiMode: ApiMode): Promise<CredentialSource> {
    const loaded = await this.loadCredentials(apiMode);
    if (!loaded) {
      throw new ProviderError(
        `No credentials found for apiMode='${apiMode}' at ${this.authJsonPath}. ` +
          `Run the OAuth wizard (Phase 13) or set the appropriate env var.`,
        apiMode,
        undefined,
        undefined,
        false,
      );
    }
    const all = (await this.readAuthJson()) ?? {};
    const refreshToken = all[apiMode]?.refreshToken;
    const resolved: ResolvedCredential = { ...loaded, apiMode, refreshToken };
    return this.refreshIfNeeded(resolved);
  }

  /**
   * Preflight refresh: if the OAuth token is within 5 minutes of expiry,
   * refresh it before returning.  In Phase 4 the refresh HTTP call is
   * stubbed (logs, no network) — tests inject a `refreshHook` to simulate
   * success or failure.  Phase 13 wires the real refresh endpoints.
   *
   * For sources without `oauthToken` or without `expiresAt`, returns
   * unchanged.
   */
  async refreshIfNeeded(source: CredentialSource): Promise<CredentialSource> {
    if (!source.oauthToken) return source;
    if (!source.expiresAt) return source;
    const expiresAtMs = source.expiresAt.getTime();
    const nowMs = Date.now();
    if (expiresAtMs - nowMs > PREFLIGHT_REFRESH_WINDOW_MS) {
      return source;
    }

    // Token is within the refresh window or already expired.
    const resolved = source as ResolvedCredential;
    const apiMode = resolved.apiMode;

    if (this.refreshHook) {
      try {
        const refreshed = await this.refreshHook(apiMode, resolved);
        await this.persistRefreshed(apiMode, refreshed, resolved.refreshToken);
        return refreshed;
      } catch (err) {
        throw new ProviderError(
          `Failed to refresh OAuth token for apiMode='${apiMode}': ${
            err instanceof Error ? err.message : String(err)
          }`,
          apiMode ?? 'unknown',
          undefined,
          err,
          false,
        );
      }
    }

    // Phase 4 stub: log + return unchanged. Real refresh logic lands in Phase 13.
    // eslint-disable-next-line no-console
    console.warn(
      `[credentialResolver] Refresh would happen here for apiMode='${apiMode ?? 'unknown'}'. ` +
        `OAuth refresh is stubbed until Phase 13.`,
    );
    return source;
  }

  /**
   * Phase 4 stub.  Real OAuth browser-flow initiation lands in Phase 13.
   */
  async initiateOAuthFlow(_apiMode: ApiMode): Promise<never> {
    throw new Error(
      'OAuth browser flow not implemented until Phase 13. Provide an API key in .env for now.',
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async readAuthJson(): Promise<AuthJsonShape | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.authJsonPath, 'utf8');
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('top-level value is not an object');
      }
      return parsed as AuthJsonShape;
    } catch (err) {
      throw new Error(
        `auth.json is malformed at ${this.authJsonPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async persistRefreshed(
    apiMode: ApiMode,
    refreshed: CredentialSource,
    priorRefreshToken: string | undefined,
  ): Promise<void> {
    // Best-effort: persist the refreshed token so future calls see fresh state.
    // Failures here are not fatal — the in-memory token is still good for
    // the current call.
    try {
      const existing = (await this.readAuthJson()) ?? {};
      existing[apiMode] = sourceToEntry(refreshed, priorRefreshToken);
      await fs.mkdir(path.dirname(this.authJsonPath), { recursive: true });
      await fs.writeFile(this.authJsonPath, JSON.stringify(existing, null, 2), 'utf8');
      if (process.platform !== 'win32') {
        try {
          await fs.chmod(this.authJsonPath, 0o600);
        } catch {
          /* see saveCredentials */
        }
      }
    } catch {
      // Swallow — the caller still has a usable token in memory.
    }
  }
}

/**
 * Default platform path for auth.json — delegates to core/v4/paths.ts as
 * the single source of truth (Phase 6 migration).
 */
export function defaultAuthJsonPath(): string {
  return resolveAidenPaths().authJson;
}

function entryToSource(entry: AuthJsonEntry): CredentialSource {
  const source: CredentialSource = {
    oauthRefreshable: entry.type === 'oauth' && Boolean(entry.refreshToken),
  };
  if (entry.apiKey) source.apiKey = entry.apiKey;
  if (entry.oauthToken) source.oauthToken = entry.oauthToken;
  if (entry.expiresAt) {
    const d = new Date(entry.expiresAt);
    if (!Number.isNaN(d.getTime())) source.expiresAt = d;
  }
  return source;
}

function sourceToEntry(
  source: CredentialSource,
  priorRefreshToken?: string,
): AuthJsonEntry {
  const isOauth = Boolean(source.oauthToken);
  const entry: AuthJsonEntry = {
    type: isOauth ? 'oauth' : 'api_key',
  };
  if (source.apiKey) entry.apiKey = source.apiKey;
  if (source.oauthToken) entry.oauthToken = source.oauthToken;
  if (source.expiresAt) entry.expiresAt = source.expiresAt.toISOString();
  if (priorRefreshToken) entry.refreshToken = priorRefreshToken;
  return entry;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
