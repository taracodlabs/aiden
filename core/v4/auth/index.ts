/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/auth/index.ts — Aiden v4.0.0 (Phase 18)
 *
 * Public surface for OAuth core. Plugins import from here, not from the
 * individual files, so the import path stays stable across refactors.
 */

export {
  generatePkce,
  runCopyPasteFlow,
  runDeviceCodeFlow,
  refreshTokens,
} from './oauthFlow';
export type {
  PkceMaterial,
  OAuthFlowResult,
  OAuthUserAgent as FlowUserAgent,
  CopyPasteFlowConfig,
  DeviceCodeFlowConfig,
  RefreshConfig,
  FetchImpl,
} from './oauthFlow';

export {
  saveTokens,
  loadTokens,
  clearTokens,
  hasTokens,
  listAuthedProviders,
  isExpired,
  machineFingerprint,
  PREFLIGHT_REFRESH_WINDOW_MS,
} from './tokenStore';
export type { OAuthTokens } from './tokenStore';

export {
  OAuthProviderRuntime,
  OAuthProviderRegistry,
} from './providerAuth';
export type { OAuthProvider, OAuthUserAgent } from './providerAuth';
