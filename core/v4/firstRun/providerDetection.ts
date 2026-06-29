/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/firstRun/providerDetection.ts — Aiden v4.0.2 (Phase 30.2)
 *
 * Fast (< 100 ms) check at boot: does the user have ANY working
 * provider configured? Drives the "auto-launch setup wizard if not"
 * behaviour in cli/v4/aidenCLI.ts and the "model not configured"
 * fallback in the boot card.
 *
 * Three signals are inspected, all local — no real API calls:
 *
 *   1. Env vars      — process.env keys matching any of the wizard's
 *                      `PROVIDERS[].envVar` entries. (Wizard-managed
 *                      `.env` is loaded into process.env upstream by
 *                      `loadAidenEnvFile`, so this catches both shell
 *                      env and Aiden's persisted .env.)
 *
 *   2. OAuth tokens  — `<paths.root>/auth/<provider>.json`. We treat
 *                      the file's presence as "credentials available"
 *                      — actual decrypt + expiry happens later in
 *                      `runtimeResolver` and is reported via plugin
 *                      boot-card status. Avoids paying scrypt + AES
 *                      cost on every boot just to gate the wizard.
 *
 *   3. Ollama        — TCP probe of `http://localhost:11434/api/tags`
 *                      with a HARD 80 ms abort. Non-fatal on timeout
 *                      so a slow loopback doesn't slow boot.
 *
 * Returns a `ProviderDetection` snapshot the caller can consult to
 * decide whether to launch the wizard. The shape is intentionally
 * descriptive (lists, not just a boolean) so smoke tests and
 * `aiden doctor` can render the why.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from '../paths';
import { PROVIDERS } from '../../../cli/v4/setupWizard';

export interface ProviderDetection {
  /**
   * True when at least one of envVars / oauthTokens / ollamaReachable
   * indicates we can reach a real model without any further setup.
   */
  hasAnyProvider: boolean;
  /**
   * Env-var names found populated (e.g. ['GROQ_API_KEY', 'TOGETHER_API_KEY']).
   * Order is registry order from cli/v4/setupWizard.PROVIDERS.
   */
  envVars: string[];
  /**
   * Provider ids whose `<paths.root>/auth/<provider>.json` exists. We
   * do NOT decrypt or check expiry here — that's the resolver's job.
   * If the file is stale, the resolver surfaces it later with the
   * canonical "/auth refresh" remediation.
   */
  oauthTokens: string[];
  /** True when http://localhost:11434/api/tags responded ok within 80 ms. */
  ollamaReachable: boolean;
  /**
   * Provider id parsed out of `config.yaml`'s `model.provider:` line.
   * Cheap regex — avoids importing js-yaml on the hot boot path. Null
   * when config is missing or unreadable.
   */
  configProvider: string | null;
  /** Model id parsed from `config.yaml`'s `model.modelId:` line. */
  configModel: string | null;
  /**
   * Provider ids that have `apiKey:` or `baseUrl:` set under the
   * `providers:` section in config.yaml. Counts as "configured" for
   * `hasAnyProvider` purposes — covers the moat-boot fixture that
   * stubs `providers.fake.apiKey: test` and any user who configures
   * via direct config edit instead of an env var.
   */
  configuredProviders: string[];
  /**
   * True when `configProvider` is set AND we found credentials that
   * match it. Used by the wizard-trigger logic: if config points at
   * `chatgpt-plus` but the OAuth file is missing, we still want to
   * fire the wizard even though `hasAnyProvider` may be true via an
   * unrelated env var like GROQ_API_KEY.
   */
  configuredProviderHasCredentials: boolean;
}

/** Inputs are injectable so smoke-30.2 can simulate fresh / configured states. */
export interface DetectOptions {
  paths: AidenPaths;
  /** Defaults to `process.env`. Tests pass a sealed object. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch;
  /** Override the Ollama probe timeout (ms). Default 80. */
  ollamaTimeoutMs?: number;
  /**
   * When true, skip the Ollama probe entirely. The smoke tests use this
   * to keep deterministic timing. Default false.
   */
  skipOllamaProbe?: boolean;
}

/**
 * Walk `PROVIDERS` and return env-var names whose value is set + non-empty.
 * Includes the multi-slot Groq fallback vars so a user with `GROQ_API_KEY_2`
 * but no primary still counts as configured.
 */
function detectEnvVars(env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (name: string | undefined): void => {
    if (!name) return;
    if (seen.has(name)) return;
    const val = env[name];
    if (typeof val === 'string' && val.trim().length > 0) {
      seen.add(name);
      out.push(name);
    }
  };
  for (const p of PROVIDERS) consider(p.envVar);
  // Multi-slot Groq fallbacks live in core/v4/providerFallback.ts. Keep
  // this list local so detection has zero deep imports off the boot
  // path; the fallback module is heavy.
  for (const extra of [
    'GROQ_API_KEY_2',
    'GROQ_API_KEY_3',
    'GROQ_API_KEY_4',
    'TOGETHER_API_KEY',
  ]) {
    consider(extra);
  }
  return out;
}

/**
 * Read `<paths.root>/auth/` and return provider ids whose `.json`
 * file exists. ENOENT on the directory is treated as "no tokens".
 */
async function detectOAuthTokens(paths: AidenPaths): Promise<string[]> {
  const dir = path.join(paths.root, 'auth');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const id = e.replace(/\.json$/, '');
    // tokenStore writes one JSON per provider id; the file itself is
    // always non-empty when it exists. Skip the size check — the
    // resolver will surface a corrupt file with a clear error.
    out.push(id);
  }
  return out;
}

/**
 * Quick local probe of an Ollama daemon. Hard-aborts at `timeoutMs`
 * so a slow loopback (e.g. WSL2 mirror mode warming up) never delays
 * boot past the budget.
 */
async function probeOllamaQuick(opts: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetchImpl(
      'http://localhost:11434/api/tags',
      { signal: ctrl.signal },
    );
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cheap regex parse of `model.provider:` / `model.modelId:` AND the
 * `providers:` section from config.yaml. Avoids pulling in js-yaml on
 * the boot hot-path. Tolerates quoted values and inline comments.
 * Returns nulls / empty list when the file is missing.
 *
 * The `providers:` walker mirrors `cli/v4/setupWizard.isFreshInstall`
 * so a config.yaml that only carries inline `providers.foo.apiKey`
 * (no env var) still counts as "the user has configured something" —
 * the moat-boot test suite relies on this fixture shape.
 */
async function readConfigProviders(
  configYaml: string,
): Promise<{
  provider: string | null;
  model: string | null;
  configuredProviders: string[];
}> {
  let text: string;
  try {
    text = await fs.readFile(configYaml, 'utf8');
  } catch {
    return { provider: null, model: null, configuredProviders: [] };
  }
  const lines = text.split(/\r?\n/);
  let inModel = false;
  let inProviders = false;
  let provider: string | null = null;
  let model: string | null = null;
  // Two-line lookahead would let us match `apiKey: ...` under each
  // provider id; instead we keep the most recently seen provider id
  // and stamp it on `configuredProviders` when its child field is
  // populated. Idempotent within a single file.
  let currentProviderId: string | null = null;
  const seenProviders: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (/^model\s*:\s*$/.test(line)) {
      inModel = true;
      inProviders = false;
      currentProviderId = null;
      continue;
    }
    if (/^providers\s*:\s*$/.test(line)) {
      inProviders = true;
      inModel = false;
      currentProviderId = null;
      continue;
    }
    // Top-level non-indented key ends both blocks.
    if (/^\S/.test(line) && line.length > 0) {
      inModel = false;
      inProviders = false;
      currentProviderId = null;
      continue;
    }
    if (inModel) {
      const provM = line.match(/^\s+provider\s*:\s*['"]?([^'"\s]+)['"]?\s*$/);
      if (provM) provider = provM[1];
      const modM = line.match(/^\s+modelId\s*:\s*['"]?([^'"\s]+)['"]?\s*$/);
      if (modM) model = modM[1];
      continue;
    }
    if (inProviders) {
      // 2-space indented `<id>:` opens a provider entry.
      const idM = line.match(/^  ([A-Za-z0-9_.-]+)\s*:\s*$/);
      if (idM) {
        currentProviderId = idM[1];
        continue;
      }
      // 4-space indented `apiKey:` / `baseUrl:` flags it as configured.
      if (
        currentProviderId &&
        /^    (apiKey|baseUrl|auth)\s*:\s*\S/.test(line)
      ) {
        if (!seenProviders.includes(currentProviderId)) {
          seenProviders.push(currentProviderId);
        }
      }
    }
  }
  return { provider, model, configuredProviders: seenProviders };
}

/**
 * Map a config provider id to the env-var name(s) and/or OAuth provider
 * id that would represent valid credentials for it. Drives the
 * `configuredProviderHasCredentials` flag.
 */
function configProviderCredentialKeys(providerId: string): {
  envVars: string[];
  oauthIds: string[];
} {
  const entry = PROVIDERS.find((p) => p.id === providerId);
  const envVars: string[] = [];
  const oauthIds: string[] = [];
  if (entry?.envVar) envVars.push(entry.envVar);
  // Pro/oauth providers store tokens under their provider id.
  if (entry?.kind === 'pro' || entry?.kind === 'oauth') {
    oauthIds.push(providerId);
  }
  // Ollama needs no credentials; mirror the env-var-less local-key path.
  if (entry?.kind === 'local') {
    envVars.push('__OLLAMA_REACHABLE__'); // sentinel handled by caller
  }
  return { envVars, oauthIds };
}

export async function detectAvailableProviders(
  opts: DetectOptions,
): Promise<ProviderDetection> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.ollamaTimeoutMs ?? 80;

  // Run the four independent probes in parallel — Ollama is the only
  // one that can take real wall time, but capping it at 80 ms keeps
  // total detection cost under the 100 ms budget on every realistic host.
  const [envVars, oauthTokens, ollamaReachable, cfg] = await Promise.all([
    Promise.resolve(detectEnvVars(env)),
    detectOAuthTokens(opts.paths),
    opts.skipOllamaProbe
      ? Promise.resolve(false)
      : probeOllamaQuick({ fetchImpl, timeoutMs }),
    readConfigProviders(opts.paths.configYaml),
  ]);

  const hasAnyProvider =
    envVars.length > 0 ||
    oauthTokens.length > 0 ||
    ollamaReachable ||
    cfg.configuredProviders.length > 0;

  let configuredProviderHasCredentials = false;
  if (cfg.provider) {
    const want = configProviderCredentialKeys(cfg.provider);
    const envHit = want.envVars.some((v) =>
      v === '__OLLAMA_REACHABLE__' ? ollamaReachable : envVars.includes(v),
    );
    const oauthHit = want.oauthIds.some((id) => oauthTokens.includes(id));
    // Inline `providers.<id>.apiKey` in config.yaml is also a valid
    // credential source — it's what the moat-boot fixtures rely on
    // and what users get when they hand-edit config.yaml.
    const inlineHit = cfg.configuredProviders.includes(cfg.provider);
    configuredProviderHasCredentials = envHit || oauthHit || inlineHit;
  }

  return {
    hasAnyProvider,
    envVars,
    oauthTokens,
    ollamaReachable,
    configProvider: cfg.provider,
    configModel: cfg.model,
    configuredProviders: cfg.configuredProviders,
    configuredProviderHasCredentials,
  };
}

/**
 * Format a single-line summary suitable for the boot UX preamble.
 * Public so the wizard auto-trigger path can mirror it and so smoke
 * tests can assert on stable text.
 */
export function summarizeDetection(d: ProviderDetection): string {
  if (d.hasAnyProvider) {
    const parts: string[] = [];
    if (d.envVars.length > 0) parts.push(`env: ${d.envVars.length}`);
    if (d.oauthTokens.length > 0) parts.push(`oauth: ${d.oauthTokens.length}`);
    if (d.ollamaReachable) parts.push('ollama');
    if (d.configuredProviders.length > 0) {
      parts.push(`config: ${d.configuredProviders.length}`);
    }
    return `Providers detected — ${parts.join(', ')}.`;
  }
  return 'No AI provider configured yet.';
}

/**
 * Pure gate decision: should the first-run wizard fire? Extracted from
 * cli/v4/aidenCLI.ts:buildAgentRuntime so the logic is unit-testable.
 *
 * Fires when:
 *   - the caller forced it (`aiden setup`), OR
 *   - no provider credentials exist anywhere (env / OAuth / Ollama /
 *     inline config) — `!hasAnyProvider`, OR
 *   - config.yaml NAMES a provider but that provider has no usable
 *     credentials (points at a broken setup), OR
 *   - the config is effectively empty (`configEmpty`, from isFreshInstall)
 *     AND it does NOT already name a provider that HAS working credentials.
 *
 * v4.11 bug fix: the last clause's `&& !haveUsableConfiguredProvider`
 * guard is the fix. Previously the boot gate OR'd in `isFreshInstall`
 * raw, so a LIVE config whose credentials live OUTSIDE the config.yaml
 * `providers:` map — OAuth tokens in the auth store, or an env API key —
 * was mis-classified as fresh: the wizard auto-fired and offered to
 * overwrite a working config (the footgun). `configuredProviderHasCredentials`
 * already knows the config's provider is usable via env/OAuth/inline, so
 * we now honour it instead of letting the providers-section-only check
 * override it.
 */
export function shouldRunWizard(
  detection: ProviderDetection,
  opts: { forceSetup: boolean; configEmpty: boolean },
): boolean {
  if (opts.forceSetup) return true;
  if (!detection.hasAnyProvider) return true;
  const configuredProviderBroken =
    !!detection.configProvider && !detection.configuredProviderHasCredentials;
  if (configuredProviderBroken) return true;
  const haveUsableConfiguredProvider =
    !!detection.configProvider && detection.configuredProviderHasCredentials;
  if (opts.configEmpty && !haveUsableConfiguredProvider) return true;
  return false;
}
