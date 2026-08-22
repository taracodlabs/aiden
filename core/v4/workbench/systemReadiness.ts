/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { WorkbenchProviderSnapshot } from './providerSetupAuthority';

export type ReadinessState = 'ready' | 'setup_available' | 'needs_setup' | 'needs_attention' | 'unavailable' | 'checking' | 'degraded';

export interface SystemReadinessItem {
  id: string;
  category: 'chat' | 'coding' | 'browser' | 'validation' | 'apps' | 'automations' | 'workspace' | 'approvals' | 'evidence';
  state: ReadinessState;
  title: string;
  detail: string;
  configured: boolean;
  available: boolean;
  healthy: boolean;
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

function item(input: Omit<SystemReadinessItem, 'checkedAt'>, checkedAt: number): SystemReadinessItem {
  return { ...input, checkedAt };
}

export function createSystemReadinessAuthority(options: {
  providers(sessionId?: string): Promise<WorkbenchProviderSnapshot>;
  coding(): Promise<{ ready: boolean; reason: string; isolation: string }>;
  apps(): Promise<{ providers: Array<{ id: string; label: string; health: string }>; accounts: unknown[] }>;
  browser(): Promise<{ ready: boolean; detail: string; grantRequired: boolean }>;
  workspace(): Promise<{ ready: boolean; detail: string }>;
  evidence(): Promise<{ ready: boolean; detail: string }>;
  approvals(): Promise<{ ready: boolean; detail: string }>;
  automations?: () => Promise<{ ready: boolean; entitled: boolean; detail: string }> | { ready: boolean; entitled: boolean; detail: string };
  now?: () => number;
}) {
  return {
    async snapshot(sessionId?: string): Promise<SystemReadinessProjection> {
      const checkedAt = (options.now ?? Date.now)();
      const [providerSnapshot, coding, apps, browser, workspace, evidence, approvals, automations] = await Promise.all([
        options.providers(sessionId), options.coding(), options.apps(), options.browser(), options.workspace(), options.evidence(), options.approvals(),
        options.automations?.() ?? null,
      ]);
      const selected = providerSnapshot.sessionSelection ?? providerSnapshot.defaultSelection;
      const chat = selected
        ? providerSnapshot.providers.find((provider) => provider.id === selected.providerId)
        : undefined;
      const appConfigured = apps.providers.some((provider) => !['not_configured', 'unavailable'].includes(provider.health));
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
          state: coding.ready ? 'ready' : 'needs_setup', detail: coding.reason,
          configured: coding.ready, available: true, healthy: coding.ready,
          blocking: false, severity: coding.ready ? 'info' : 'warning', availableActions: ['manage_coding', 'recheck'],
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
          state: browser.ready ? 'ready' : browser.grantRequired ? 'needs_setup' : 'unavailable', detail: browser.detail,
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
          blocking: false, severity: automations.ready ? 'info' : 'warning', availableActions: ['manage_automations'],
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
      const issues = items.filter((candidate) => candidate.state !== 'ready' && candidate.state !== 'setup_available');
      return { overall: issues.some((candidate) => candidate.blocking) ? 'needs_attention' : 'ready', items, issues, checkedAt };
    },
  };
}
