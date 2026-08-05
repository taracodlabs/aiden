/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/model.ts — Phase 14b
 *
 * `/model [provider:model | model]` — switches the live session's
 * provider/model. Empty args opens the interactive picker (also reused by
 * `aiden model`). Spec form is parsed via Phase 5's ModelSwitcher.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { ModelSwitcher } from '../../../providers/v4/modelSwitch';
import { runModelPicker } from './modelPicker';
import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';
import { loadTokens, isExpired } from '../../../core/v4/auth/tokenStore';
import type { ProviderAccessState } from './modelPicker';

/**
 * Sync auth-state probe used by the Phase 22 picker. Single source of
 * truth for "is this provider usable right now":
 *   - local providers (ollama) — assume authed; the actual switch
 *     surfaces a daemon-not-reachable error if not.
 *   - OAuth providers — token file at <root>/auth/<oauth-id>.json must
 *     exist. Token validity is the runtime resolver's concern.
 *   - env-var providers — process.env[apiKeyEnvVar] must be non-empty.
 */
export function makeProviderAccessProbe(ctx: SlashCommandContext): (id: string) => Promise<ProviderAccessState> {
  return async (providerId: string): Promise<ProviderAccessState> => {
    const entry = PROVIDER_REGISTRY[providerId];
    if (!entry) return 'not_configured';
    const readiness = ctx.config?.getValue<{ state?: string }>(`providers.${providerId}.readiness`);
    const readinessState = (): ProviderAccessState | null => {
      if (readiness?.state === 'complete') return 'readiness_verified';
      if (readiness?.state === 'failed_retryable' || readiness?.state === 'failed_requires_user_action') {
        return 'readiness_failed';
      }
      return null;
    };
    if (entry.tier === 'local') return readinessState() ?? (readiness ? 'authentication_valid' : 'not_configured');
    if (entry.oauth) {
      if (!ctx.paths) return 'authentication_missing';
      const tokens = await loadTokens(ctx.paths, entry.oauth.providerId);
      if (!tokens) return 'authentication_missing';
      if (isExpired(tokens)) return 'authentication_expired';
      return readinessState() ?? 'authentication_valid';
    }
    if (entry.apiKeyEnvVar) {
      const v = process.env[entry.apiKeyEnvVar];
      if (typeof v === 'string' && v.trim().length > 0) return readinessState() ?? 'authentication_valid';
      const configured = ctx.config?.get(`providers.${providerId}.apiKey`);
      return configured?.trim() ? readinessState() ?? 'authentication_valid' : 'authentication_missing';
    }
    return 'not_configured';
  };
}

export const model: SlashCommand = {
  name: 'model',
  description: 'Switch the active provider/model (interactive when no args).',
  category: 'system',
  icon: '🧠',
  handler: async (ctx: SlashCommandContext) => {
    if (!ctx.resolver) {
      ctx.display.warn('No runtime resolver wired — cannot switch model.');
      return {};
    }
    let providerId: string | undefined;
    let modelId: string | undefined;

    const spec = ctx.rawArgs.trim();
    if (spec) {
      try {
        const switcher = new ModelSwitcher(ctx.resolver);
        const parsed = switcher.parse(spec);
        if (!parsed.providerId) {
          ctx.display.printError(`Unable to resolve '${spec}'.`);
          return {};
        }
        providerId = parsed.providerId;
        modelId = parsed.modelId;
      } catch (err) {
        ctx.display.printError(
          (err as Error).message,
          'Try `provider:model`, e.g. anthropic:claude-opus-4-7.',
        );
        return {};
      }
    } else {
      const picked = await ctx.display.withModalLease('model-picker', () => runModelPicker({
        resolver: ctx.resolver,
        currentProviderId: ctx.session?.getCurrentProvider(),
        currentModelId: ctx.session?.getCurrentModel(),
        isProviderAuthed: makeProviderAccessProbe(ctx),
      }));
      if (!picked) {
        ctx.display.dim('Model unchanged.');
        return {};
      }
      providerId = picked.providerId;
      modelId = picked.modelId;
    }

    if (ctx.session) {
      try {
        await ctx.session.setProvider(providerId, modelId);
      } catch (err) {
        ctx.display.printError(`Switch failed: ${(err as Error).message}`);
        return {};
      }
    }

    // v4.1.3-prebump: persist the selection to config.yaml so the NEXT
    // boot honours the user's choice. Without this, `/model` only
    // updated the live session — and the persisted `model.provider /
    // model.modelId` keys (which Case 3 in providerBootSelector
    // consults first) silently kept their stale values from the
    // previous wizard run. Result: every reboot snapped the user back
    // to the wizard's original pick (typically groq + llama-3.3-70b),
    // confusing /model into looking like a "session-only" switch.
    //
    // The `aiden model` CLI subcommand (aidenCLI.ts:1773-1777) has
    // always persisted; this brings the REPL `/model` path in line.
    // Best-effort: if `ctx.config` isn't plumbed (test harness, etc.)
    // we still succeeded for the live session — emit a subtle warning
    // instead of failing the whole switch.
    let persisted = false;
    if (ctx.config) {
      try {
        ctx.config.set('model.provider', providerId);
        ctx.config.set('model.modelId', modelId);
        await ctx.config.save();
        persisted = true;
      } catch (err) {
        ctx.display.warn(
          `Switched the live session but could not persist to config.yaml: ` +
          `${(err as Error).message}. Next boot may revert.`,
        );
      }
    }

    ctx.display.success(
      persisted
        ? `Now using ${providerId}:${modelId}  (saved to config.yaml)`
        : `Now using ${providerId}:${modelId}  (session only — not persisted)`,
    );
    return {};
  },
};
