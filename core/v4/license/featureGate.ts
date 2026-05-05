/**
 * core/v4/license/featureGate.ts — Aiden v4.0.0 (Phase 20)
 *
 * Single source of truth for "is this Pro feature available right now?"
 * Called by the runtime hot path (ApprovalEngine, OAuthProviderRuntime,
 * `/personality install`) so it must be cheap and never throw.
 *
 * Strategy:
 *   1. Read `LicenseCache` from disk (sync from cache, never network).
 *   2. If no valid cache → free tier; gate denies + returns upgrade copy.
 *   3. If cache valid, look up the feature flag. The worker pushes
 *      `features: { multi_tool_approval: true, ... }` in /verify; missing
 *      flags default to true once the user has *any* valid Pro license,
 *      so we don't break Pro users when the worker rolls out new gates
 *      slower than the client.
 *
 * Free-tier degradation: every gate has a `degradationMessage()` that
 * tells the user exactly which feature they hit and how to upgrade.
 * Honest framing — no hidden behaviour, no nag screen on every keystroke.
 */

import { LicenseClient } from './licenseClient';
import type { AidenPaths } from '../paths';

export const FEATURE_FLAGS = {
  /**
   * Phase 16f deferred: ApprovalEngine batches consecutive same-signature
   * tool calls into one prompt for Pro users; free tier prompts on each.
   */
  MULTI_TOOL_APPROVAL: 'multi_tool_approval',
  /**
   * Phase 18 deferred: OAuthProviderRuntime refreshes tokens silently
   * mid-inference for Pro; free tier prints a "run /auth refresh" hint
   * and skips the refresh.
   */
  SILENT_OAUTH_REFRESH: 'silent_oauth_refresh',
  /**
   * Phase 16: `/personality install <name>` accepts custom user-authored
   * personalities for Pro; free tier is restricted to the 5 bundled
   * defaults (developer, writer, analyst, teacher, friend).
   */
  CUSTOM_PERSONALITIES: 'custom_personalities',
} as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

const UPGRADE_URL = 'https://aiden.taracod.com/pro';

/** Human-friendly labels for diagnostics + upgrade prompts. */
const FEATURE_LABELS: Record<FeatureFlag, string> = {
  [FEATURE_FLAGS.MULTI_TOOL_APPROVAL]: 'Multi-tool batched approval',
  [FEATURE_FLAGS.SILENT_OAUTH_REFRESH]: 'Silent OAuth token refresh',
  [FEATURE_FLAGS.CUSTOM_PERSONALITIES]: 'Custom personalities',
};

export interface FeatureGateOptions {
  paths: AidenPaths;
  /** Reuse a pre-built client (so the cache+env settings stay consistent). */
  client?: LicenseClient;
  env?: NodeJS.ProcessEnv;
}

/**
 * Gate evaluator. Construct one per session (cheap — wraps a `LicenseClient`).
 * Methods are async because they read the disk cache; callers on the hot
 * path can cache the boolean result for a single tool-loop iteration.
 */
export class FeatureGate {
  private readonly client: LicenseClient;

  constructor(opts: FeatureGateOptions) {
    this.client =
      opts.client ?? new LicenseClient({ paths: opts.paths, env: opts.env });
  }

  /**
   * True if this feature is available right now. Reads cache only —
   * a stale-but-still-in-grace cache passes. A fresh worker round-trip
   * happens at boot via the `LicenseClient.verify()` call; this is the
   * fast read.
   */
  async isProEnabled(feature: FeatureFlag): Promise<boolean> {
    const status = await this.client.statusFromCache();
    if (status.tier !== 'pro') return false;

    const flag = status.cache.features[feature];
    // Missing flag on a valid Pro cache: default-on (forward-compatibility).
    if (flag === undefined) return true;
    return flag === true || (typeof flag === 'number' && flag > 0);
  }

  /** Same as `isProEnabled` but synchronous, off a pre-loaded status. */
  isProEnabledFromStatus(
    status: { tier: 'free' } | { tier: 'pro'; cache: { features: Record<string, boolean | number> } },
    feature: FeatureFlag,
  ): boolean {
    if (status.tier !== 'pro') return false;
    const flag = status.cache.features[feature];
    if (flag === undefined) return true;
    return flag === true || (typeof flag === 'number' && flag > 0);
  }

  /** Multi-line user-facing message for the degradation path. */
  degradationMessage(feature: FeatureFlag): string {
    const label = FEATURE_LABELS[feature] ?? feature;
    return [
      `${label} is a Pro feature.`,
      `Run /license activate <key> to enable it, or visit ${UPGRADE_URL} to upgrade.`,
    ].join('\n');
  }

  /** Single-line variant — fits in a boot card or a /tools status row. */
  shortDegradationMessage(feature: FeatureFlag): string {
    return `Pro feature gated. /license activate <key> or visit ${UPGRADE_URL}.`;
  }
}

/** Convenience: create a gate without boilerplate. */
export function createFeatureGate(paths: AidenPaths, env?: NodeJS.ProcessEnv): FeatureGate {
  return new FeatureGate({ paths, env });
}
