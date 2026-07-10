/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/providerBootSelector.ts — Phase v4.1.2-bug1.
 *
 * Boot-time provider/model picker. Replaces the hardcoded
 * `groq + llama-3.3-70b-versatile` fallback that bit new users:
 * users authenticated with ChatGPT Plus OAuth (the post-v4.1.1
 * onboarding default) booted into Groq anyway, and llama-3.3-70b's
 * tool emission triggers Groq's first-party 400
 * ("Failed to call a function. Please adjust your prompt.").
 *
 * Resolution precedence (caller in `aidenCLI.ts` enforces order):
 *   1. Both CLI flags `--provider` + `--model` set      → use as-is
 *   2. One CLI flag set                                  → use it, resolve other
 *   3. Persisted config (model-selection.json) complete  → use as-is
 *   4. Persisted config partial                          → use it, resolve other
 *   5. Neither → priority-list auto-pick                 → THIS MODULE
 *   6. Nothing authed                                    → hardcoded fallback
 *
 * `resolveBootProvider()` covers cases 1–5; the caller composes the
 * input shape and falls back when this returns `null` (case 6).
 *
 * Test surface: the enumerator is injected so unit tests mock it.
 */

import { pickProbeModel } from './doctorLiveness';
import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from '../../providers/v4/registry';
import type { ConfiguredProvider } from './doctorLiveness';

/**
 * Provider id ordering for auto-pick. Higher in the list = preferred.
 * OAuth subscription flows lead because they have no API-key
 * onboarding friction and are the default v4.1.1 install path.
 */
export const BOOT_PRIORITY: readonly string[] = [
  'chatgpt-plus',  // OAuth — primary onboarding flow
  'anthropic',     // API key — power-user tier
  'openai',        // API key — power-user tier
  // Phase v4.1.2-deepseek: paid tier, strong tool-caller, ranked
  // above groq for the same first-run-UX reason — groq's free-tier
  // tool emission was the original bug1 (llama-3.3-70b 400s on
  // tool calls).
  'deepseek',      // API key — paid, strong tool-caller (V4 Pro)
  'groq',          // free-tier API key — common but tool-emission flaky
  'ollama',        // local — only if daemon up
];

/** Shape returned by the selector to the caller. */
export interface BootSelection {
  providerId: string;
  modelId:    string;
  /**
   * Why this combination was picked. The caller uses this to render
   * the dim "(auto · first authed provider)" line in the boot card
   * — silent on `'cli-flag'` / `'persisted-config'` paths.
   */
  source:
    | 'cli-flag'
    | 'persisted-config'
    | 'auto-priority'
    | 'cli-flag-partial'
    | 'config-partial';
}

/**
 * Input shape — fields that may or may not be set, in the order the
 * caller resolved them from argv + config.
 */
export interface BootResolveInput {
  cliProviderId?: string;
  cliModelId?:    string;
  cfgProviderId?: string;
  cfgModelId?:    string;
}

/**
 * Dependency: callable that returns the configured-provider list.
 * In production this is `enumerateConfiguredProviders` from
 * `doctorLiveness.ts`; tests inject a stub.
 */
export type EnumerateConfigured = () => Promise<ConfiguredProvider[]>;

/**
 * Walk every provider's `modelIds` and return the entry that lists
 * `modelId`. Used by the `--model`-only path to validate the model
 * is at least known to one provider before we accept it.
 */
export function findProviderForModel(modelId: string): ProviderRegistryEntry | null {
  for (const entry of Object.values(PROVIDER_REGISTRY)) {
    if (entry.modelIds.includes(modelId)) return entry;
  }
  return null;
}

/**
 * Resolve the boot provider + model. Returns `null` when no choice
 * could be inferred AND nothing is authed (the caller falls back to
 * the hardcoded `groq + llama-3.3-70b-versatile` default in that
 * one case).
 *
 * Throws (`Error`) when input is internally inconsistent — e.g. the
 * user passed `--model foo` for a model no provider declares. Caller
 * surfaces the message via the standard error path.
 */
export async function resolveBootProvider(
  input: BootResolveInput,
  enumerate: EnumerateConfigured,
): Promise<BootSelection | null> {
  const { cliProviderId, cliModelId, cfgProviderId, cfgModelId } = input;

  // Case 1: both CLI flags set.
  if (cliProviderId && cliModelId) {
    return { providerId: cliProviderId, modelId: cliModelId, source: 'cli-flag' };
  }

  // Case 2a: `--provider` only. Use that provider + its first
  // non-codex model. The registry might not know this provider; we
  // accept it as-is (the runtime resolver will throw a clearer error
  // later if it's bogus).
  if (cliProviderId && !cliModelId) {
    const entry = PROVIDER_REGISTRY[cliProviderId];
    const modelId = entry ? pickProbeModel(entry) : '';
    if (!modelId) {
      throw new Error(
        `--provider '${cliProviderId}' set but no model could be inferred. ` +
        `Pass --model explicitly.`,
      );
    }
    return { providerId: cliProviderId, modelId, source: 'cli-flag-partial' };
  }

  // Case 2b: `--model` only. Verify the model is known to some
  // provider; pick the matching provider.
  if (!cliProviderId && cliModelId) {
    const entry = findProviderForModel(cliModelId);
    if (!entry) {
      throw new Error(
        `--model '${cliModelId}' is not declared by any provider in the ` +
        `registry. Run \`aiden model\` to see available models, or pass ` +
        `--provider explicitly.`,
      );
    }
    return { providerId: entry.id, modelId: cliModelId, source: 'cli-flag-partial' };
  }

  // Case 3: persisted config — both fields set.
  if (cfgProviderId && cfgModelId) {
    return { providerId: cfgProviderId, modelId: cfgModelId, source: 'persisted-config' };
  }

  // Case 4a: config has provider, no model — resolve via pickProbeModel.
  if (cfgProviderId && !cfgModelId) {
    const entry = PROVIDER_REGISTRY[cfgProviderId];
    const modelId = entry ? pickProbeModel(entry) : '';
    if (modelId) {
      return { providerId: cfgProviderId, modelId, source: 'config-partial' };
    }
    // Unknown provider in config — fall through to auto-pick rather
    // than refusing to boot.
  }

  // Case 4b: config has model only — same shape as Case 2b but
  // softer: fall through to auto-pick if the model isn't found in
  // the registry (config can lag the codebase).
  if (!cfgProviderId && cfgModelId) {
    const entry = findProviderForModel(cfgModelId);
    if (entry) {
      return { providerId: entry.id, modelId: cfgModelId, source: 'config-partial' };
    }
  }

  // Case 5: auto-pick from priority list.
  const configured = await enumerate();
  for (const id of BOOT_PRIORITY) {
    const hit = configured.find((c) => c.entry.id === id && c.configured);
    if (hit) {
      return {
        providerId: id,
        modelId:    pickProbeModel(hit.entry),
        source:     'auto-priority',
      };
    }
  }

  // Case 6: nothing authed — caller falls back to hardcoded default.
  return null;
}
