/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { WorkbenchProviderSnapshot } from './providerSetupAuthority';
import type { ExternalCodingHealthProjection } from './codingPort';

export type ReadinessState = 'ready' | 'setup_available' | 'needs_setup' | 'needs_attention' | 'unavailable' | 'checking' | 'degraded';

export interface SystemReadinessItem {
  id: string;
  category: 'chat' | 'coding' | 'browser' | 'validation' | 'apps' | 'automations' | 'presence' | 'workspace' | 'approvals' | 'evidence';
  state: ReadinessState;
  title: string;
  detail: string;
  configured: boolean;
  available: boolean;
  healthy: boolean;
  supported: boolean;
  authenticated: boolean;
  runtimeAvailable: boolean;
  permissionAvailable: boolean;
  validationAvailable: boolean;
  ready: boolean;
  reason: string;
  recommendedAction: string | null;
  blocking: boolean;
  severity: 'info' | 'warning' | 'error';
  availableActions: string[];
  checkedAt: number;
}

export interface SystemReadinessProjection {
  overall: 'ready' | 'needs_attention';
  items: SystemReadinessItem[];
  issues: SystemReadinessItem[];
  checkedAt: number;
}

type ReadinessDimensions = Pick<SystemReadinessItem,
  'supported' | 'authenticated' | 'runtimeAvailable' | 'permissionAvailable'
  | 'validationAvailable' | 'ready' | 'reason' | 'recommendedAction'>;

function item(
  input: Omit<SystemReadinessItem, 'checkedAt' | keyof ReadinessDimensions> & Partial<ReadinessDimensions>,
  checkedAt: number,
): SystemReadinessItem {
  return {
    ...input,
    supported: input.supported ?? input.available,
    authenticated: input.authenticated ?? input.configured,
    runtimeAvailable: input.runtimeAvailable ?? input.available,
    permissionAvailable: input.permissionAvailable ?? input.available,
    validationAvailable: input.validationAvailable ?? input.healthy,
    ready: input.ready ?? input.healthy,
    reason: input.reason ?? input.detail,
    recommendedAction: input.recommendedAction ?? input.availableActions[0] ?? null,
    checkedAt,
  };
}

export function createSystemReadinessAuthority(options: {
  providers(sessionId?: string): Promise<WorkbenchProviderSnapshot>;
  coding(): Promise<ExternalCodingHealthProjection>;
  apps(): Promise<{ providers: Array<{ id: string; label: string; health: string }>; accounts: unknown[] }>;
  browser(): Promise<{ ready: boolean; detail: string; grantRequired: boolean }>;
  workspace(): Promise<{ ready: boolean; detail: string }>;
  evidence(): Promise<{ ready: boolean; detail: string }>;
  approvals(): Promise<{ ready: boolean; detail: string }>;
  automations?: () => Promise<{ ready: boolean; entitled: boolean; detail: string }> | { ready: boolean; entitled: boolean; detail: string };
  presence?: () => Promise<{ ready: boolean; entitled: boolean; detail: string }> | { ready: boolean; entitled: boolean; detail: string };
  now?: () => number;
}) {
  return {
    async snapshot(sessionId?: string): Promise<SystemReadinessProjection> {
      const checkedAt = (options.now ?? Date.now)();
      const [providerSnapshot, coding, apps, browser, workspace, evidence, approvals, automations, presence] = await Promise.all([
        options.providers(sessionId), options.coding(), options.apps(), options.browser(), options.workspace(), options.evidence(), options.approvals(),
        options.automations?.() ?? null, options.presence?.() ?? null,
      ]);
      const selected = providerSnapshot.sessionSelection ?? providerSnapshot.defaultSelection;
      const chat = selected
        ? providerSnapshot.providers.find((provider) => provider.id === selected.providerId)
        : undefined;
      const appConfigured = apps.providers.some((provider) => !['not_configured', 'unavailable'].includes(provider.health));
      const codingConfigured = coding.model !== null;
      const codingRuntimeAvailable = coding.executable !== null && coding.state !== 'provider_unreachable';
      const codingSupported = coding.state !== 'unsupported_cli';
      const codingAuthenticated = coding.authentication === 'ready';
      const codingValidationAvailable = coding.modelValidation === 'ready' && coding.isolation === 'available';
      const codingAction = !codingRuntimeAvailable
        ? 'Install or repair the supported coding runtime.'
        : !codingSupported
          ? 'Install a supported coding runtime version.'
          : !codingConfigured || coding.state === 'unsupported_model' || coding.state === 'model_unavailable_for_auth_mode'
            ? 'Choose a supported coding model.'
            : !codingAuthenticated
              ? 'Authenticate the coding provider.'
              : !codingValidationAvailable
                ? 'Restore independent coding validation.'
                : null;
      const items: SystemReadinessItem[] = [
        item({
          id: 'chat-provider', category: 'chat', title: 'Chat provider',
          state: chat?.healthy ? 'ready' : chat?.configured ? 'needs_attention' : 'needs_setup',
          detail: chat?.healthy ? `${chat.displayName} · ${selected?.modelId}` : chat?.detail ?? 'Connect and verify a chat provider.',
          configured: chat?.configured ?? false, available: Boolean(chat), healthy: chat?.healthy ?? false,
          blocking: true, severity: chat?.healthy ? 'info' : 'error', availableActions: ['manage_provider', 'test_provider'],
        }, checkedAt),
        item({
          id: 'coding-provider', category: 'coding', title: 'Coding provider',
          state: coding.ready ? 'ready' : codingConfigured ? 'needs_attention' : 'setup_available', detail: coding.reason,
          configured: codingConfigured, available: codingRuntimeAvailable, healthy: coding.ready,
          supported: codingSupported, authenticated: codingAuthenticated,
          runtimeAvailable: codingRuntimeAvailable, permissionAvailable: true,
          validationAvailable: codingValidationAvailable, ready: coding.ready,
          reason: coding.reason, recommendedAction: codingAction,
          blocking: false, severity: codingConfigured && !coding.ready ? 'warning' : 'info', availableActions: ['manage_coding', 'recheck'],
        }, checkedAt),
        item({
          id: 'validation', category: 'validation', title: 'Independent validation',
          state: coding.isolation === 'available' ? 'ready' : 'needs_attention',
          detail: coding.isolation === 'available' ? 'Docker validation is ready.' : 'Docker validation is unavailable.',
          configured: true, available: coding.isolation === 'available', healthy: coding.isolation === 'available',
          blocking: false, severity: coding.isolation === 'available' ? 'info' : 'warning', availableActions: ['recheck'],
        }, checkedAt),
        item({
          id: 'browser', category: 'browser', title: 'Browser',
          state: browser.ready ? 'ready' : browser.grantRequired ? 'setup_available' : 'unavailable', detail: browser.detail,
          configured: browser.ready, available: browser.ready || browser.grantRequired, healthy: browser.ready,
          blocking: false, severity: browser.ready ? 'info' : 'warning', availableActions: browser.grantRequired ? ['review_browser_permission'] : ['recheck'],
        }, checkedAt),
        item({
          id: 'apps', category: 'apps', title: 'Connected Apps',
          state: appConfigured ? 'ready' : 'setup_available',
          detail: appConfigured ? `${apps.accounts.length} connected account(s).` : 'Apps provider setup is available.',
          configured: appConfigured, available: true, healthy: appConfigured,
          blocking: false, severity: 'info', availableActions: ['manage_apps'],
        }, checkedAt),
        ...(automations ? [item({
          id: 'automations', category: 'automations' as const, title: 'Reliable Automations',
          state: automations.ready ? 'ready' : automations.entitled ? 'needs_attention' : 'unavailable',
          detail: automations.detail,
          configured: automations.ready, available: automations.entitled, healthy: automations.ready,
          blocking: false, severity: automations.entitled && !automations.ready ? 'warning' : 'info', availableActions: ['manage_automations'],
        }, checkedAt)] : []),
        ...(presence ? [item({
          id: 'presence', category: 'presence' as const, title: 'Agentic Presence',
          state: presence.ready ? 'ready' : presence.entitled ? 'needs_attention' : 'unavailable',
          detail: presence.detail,
          configured: presence.ready, available: presence.entitled, healthy: presence.ready,
          blocking: false, severity: presence.entitled && !presence.ready ? 'warning' : 'info', availableActions: ['open_attention'],
        }, checkedAt)] : []),
        item({
          id: 'workspace', category: 'workspace', title: 'Coding workspace',
          state: workspace.ready ? 'ready' : 'needs_attention', detail: workspace.detail,
          configured: true, available: workspace.ready, healthy: workspace.ready,
          blocking: true, severity: workspace.ready ? 'info' : 'error', availableActions: ['recheck'],
        }, checkedAt),
        item({
          id: 'approvals', category: 'approvals', title: 'Approvals',
          state: approvals.ready ? 'ready' : 'unavailable', detail: approvals.detail,
          configured: true, available: approvals.ready, healthy: approvals.ready,
          blocking: true, severity: approvals.ready ? 'info' : 'error', availableActions: [],
        }, checkedAt),
        item({
          id: 'evidence', category: 'evidence', title: 'Evidence storage',
          state: evidence.ready ? 'ready' : 'unavailable', detail: evidence.detail,
          configured: true, available: evidence.ready, healthy: evidence.ready,
          blocking: true, severity: evidence.ready ? 'info' : 'error', availableActions: [],
        }, checkedAt),
      ];
      const issues = items.filter((candidate) =>
        (candidate.blocking && candidate.state !== 'ready')
        || candidate.state === 'needs_attention'
        || candidate.state === 'degraded',
      );
      return { overall: issues.some((candidate) => candidate.blocking) ? 'needs_attention' : 'ready', items, issues, checkedAt };
    },
  };
}
