/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { IntegrationRuntime } from '../integrations/runtime';

export interface WorkbenchAppProvider {
  id: string;
  label: string;
  health: string;
  detail?: string;
}

export interface WorkbenchAppToolkit {
  providerId: string;
  toolkitId: string;
  label: string;
}

export interface WorkbenchConnectedAccount {
  accountId: string;
  providerId: string;
  toolkitId: string;
  label: string;
  status: string;
  health: string;
  scopes: string[];
  lastCheckedAt: number | null;
}

export interface WorkbenchAppsSnapshot {
  providers: WorkbenchAppProvider[];
  toolkits: WorkbenchAppToolkit[];
  accounts: WorkbenchConnectedAccount[];
  configuration: { workbench: boolean; command?: string };
}

export interface WorkbenchAppsPort {
  snapshot(): Promise<WorkbenchAppsSnapshot>;
  configureProvider(input: { providerId: string; credential: string }): Promise<WorkbenchAppProvider>;
  connect(input: { providerId: string; toolkitId: string; label?: string }): Promise<{
    connectionId: string;
    authorizationUrl?: string;
    userCode?: string;
    expiresAt?: number;
  }>;
  complete(connectionId: string): Promise<WorkbenchConnectedAccount>;
  refresh(accountId: string): Promise<WorkbenchConnectedAccount>;
  reconnect(accountId: string): Promise<{
    connectionId: string;
    authorizationUrl?: string;
    userCode?: string;
    expiresAt?: number;
  }>;
  disconnect(accountId: string): Promise<WorkbenchConnectedAccount>;
}

function projectAccount(account: ReturnType<IntegrationRuntime['accounts']['require']>): WorkbenchConnectedAccount {
  return {
    accountId: account.accountId,
    providerId: account.providerId,
    toolkitId: account.toolkitId,
    label: account.label,
    status: account.status,
    health: account.health,
    scopes: [...account.scopes],
    lastCheckedAt: account.lastCheckedAt,
  };
}

export function createWorkbenchAppsPort(runtime: IntegrationRuntime): WorkbenchAppsPort {
  const scope = runtime.scope;

  const connect = async (input: {
    providerId: string; toolkitId: string; label?: string; reconnectAccountId?: string;
  }) => {
    const start = await runtime.actions.initiateConnection({
      providerId: input.providerId.trim().toLowerCase(),
      toolkitId: input.toolkitId.trim().toLowerCase(),
      ...scope,
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      ...(input.reconnectAccountId ? { reconnectAccountId: input.reconnectAccountId } : {}),
    });
    return {
      connectionId: start.connectionId,
      ...(start.authorizationUrl ? { authorizationUrl: start.authorizationUrl } : {}),
      ...(start.userCode ? { userCode: start.userCode } : {}),
      ...(start.expiresAt ? { expiresAt: start.expiresAt } : {}),
    };
  };

  return {
    async snapshot() {
      const providers: WorkbenchAppProvider[] = [];
      const toolkits: WorkbenchAppToolkit[] = [];
      for (const provider of runtime.providers.list()) {
        try {
          const health = await runtime.actions.providerHealth({ providerId: provider.id, ...scope });
          providers.push({
            id: provider.id,
            label: provider.label,
            health: health.state,
            ...(health.detail ? { detail: health.detail } : {}),
          });
          if (health.state !== 'not_configured' && health.state !== 'unavailable') {
            for (const toolkit of await runtime.actions.listToolkits({ providerId: provider.id, ...scope })) {
              toolkits.push({ providerId: provider.id, toolkitId: toolkit.toolkitId, label: toolkit.label });
            }
          }
        } catch (error) {
          providers.push({
            id: provider.id,
            label: provider.label,
            health: 'unavailable',
            detail: error instanceof Error ? error.message : 'Provider unavailable',
          });
        }
      }
      return {
        providers,
        toolkits,
        accounts: runtime.accounts.list({ ...scope, includeRevoked: true }).map(projectAccount),
        configuration: { workbench: true },
      };
    },
    async configureProvider(input) {
      const providerId = input.providerId.trim().toLowerCase();
      await runtime.actions.configureProvider({ providerId, credential: input.credential, ...scope });
      const provider = runtime.providers.require(providerId);
      const health = await runtime.actions.providerHealth({ providerId, ...scope });
      return {
        id: provider.id,
        label: provider.label,
        health: health.state,
        ...(health.detail ? { detail: health.detail } : {}),
      };
    },
    connect,
    async complete(connectionId) {
      return projectAccount(await runtime.actions.completeConnection({ connectionId, ...scope }));
    },
    async refresh(accountId) {
      return projectAccount(await runtime.actions.refreshAccount({ accountId, ...scope }));
    },
    async reconnect(accountId) {
      const account = runtime.accounts.require(accountId);
      if (account.ownerId !== scope.ownerId || account.workspaceId !== scope.workspaceId) {
        throw new Error('Connected account is outside the current workspace');
      }
      return connect({
        providerId: account.providerId,
        toolkitId: account.toolkitId,
        label: account.label,
        reconnectAccountId: account.accountId,
      });
    },
    async disconnect(accountId) {
      return projectAccount(await runtime.actions.disconnect({ accountId, ...scope }));
    },
  };
}
