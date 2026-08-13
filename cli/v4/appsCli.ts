/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { daemonDbPath } from '../../core/v4/daemon/daemonConfig';
import { closeDaemonDb, openDaemonDb } from '../../core/v4/daemon/db/connection';
import { createIntegrationRuntime, integrationLocalScope } from '../../core/v4/integrations/runtime';
import type { SecretBackend } from '../../core/v4/integrations/secretAuthority';
import { openOAuthBrowserUrl } from './auth/loadProvider';

export interface AppsCliInput {
  action: 'list' | 'accounts' | 'status' | 'configure' | 'connect' | 'complete' | 'reconnect' | 'disconnect';
  providerId?: string;
  toolkitId?: string;
  accountId?: string;
  connectionId?: string;
  label?: string;
  yes?: boolean;
  open?: boolean;
}

export interface AppsCliDependencies {
  rootDir: string;
  cwd?: string;
  write?: (text: string) => void;
  readCredential?: (providerId: string) => Promise<string>;
  confirm?: (message: string) => Promise<boolean>;
  openUrl?: (url: string) => Promise<void>;
  includeFake?: boolean;
  secretBackend?: SecretBackend;
}

function labelHealth(health: string): string {
  switch (health) {
    case 'healthy': return 'Healthy';
    case 'expired': return 'Authentication expired';
    case 'insufficient_scope': return 'Insufficient access';
    case 'revoked': return 'Disconnected';
    case 'degraded': return 'Needs attention';
    default: return 'Not checked';
  }
}

async function defaultCredential(providerId: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Interactive credential input requires a terminal');
  const moduleName = '@inquirer/prompts';
  const prompts = await import(moduleName) as { password(input: { message: string; mask: string }): Promise<string> };
  return prompts.password({ message: `${providerId} API key`, mask: '•' });
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const moduleName = '@inquirer/prompts';
  const prompts = await import(moduleName) as { confirm(input: { message: string; default: boolean }): Promise<boolean> };
  return prompts.confirm({ message, default: false });
}

export async function runAppsCli(input: AppsCliInput, deps: AppsCliDependencies): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const dbPath = daemonDbPath(deps.rootDir);
  const db = openDaemonDb(dbPath);
  const runtime = createIntegrationRuntime({
    db,
    rootDir: deps.rootDir,
    scope: integrationLocalScope(deps.cwd ?? process.cwd()),
    includeFake: deps.includeFake,
    secretBackend: deps.secretBackend,
  });
  try {
    if (input.action === 'configure') {
      const providerId = input.providerId?.trim().toLowerCase();
      if (!providerId || !runtime.providers.get(providerId)) throw new Error('A valid integration provider is required');
      const credential = (await (deps.readCredential ?? defaultCredential)(providerId)).trim();
      if (!credential) throw new Error('Provider credential is required');
      await runtime.actions.configureProvider({ providerId, ...runtime.scope, credential });
      write(`Configured ${runtime.providers.require(providerId).label}.\n`);
      return 0;
    }

    if (input.action === 'list') {
      write('Aiden Apps\n\nConnected\n');
      const accounts = runtime.accounts.list({ ...runtime.scope, includeRevoked: false });
      if (accounts.length === 0) write('  No connected accounts.\n');
      for (const account of accounts) {
        write(`  ${account.toolkitId.padEnd(12)} ${account.label.padEnd(18)} ${labelHealth(account.health)}\n`);
      }
      write('\nAvailable\n');
      for (const provider of runtime.providers.list()) {
        const health = await runtime.actions.providerHealth({ providerId: provider.id, ...runtime.scope });
        if (health.state === 'not_configured') {
          write(`  ${provider.label.padEnd(12)} Not configured\n`);
          continue;
        }
        try {
          const toolkits = await runtime.actions.listToolkits({ providerId: provider.id, ...runtime.scope });
          for (const toolkit of toolkits) write(`  ${toolkit.label.padEnd(12)} ${provider.label}\n`);
        } catch {
          write(`  ${provider.label.padEnd(12)} Needs attention\n`);
        }
      }
      return 0;
    }

    if (input.action === 'accounts') {
      const accounts = runtime.accounts.list({
        ...runtime.scope,
        ...(input.toolkitId ? { toolkitId: input.toolkitId.toLowerCase() } : {}),
        includeRevoked: true,
      });
      write('Connected accounts\n');
      if (accounts.length === 0) write('  No connected accounts.\n');
      for (const account of accounts) {
        write(`  ${account.toolkitId} · ${account.label} · ${labelHealth(account.health)}\n`);
        write(`    ${account.accountId}\n`);
      }
      return 0;
    }

    if (input.action === 'connect') {
      const providerId = input.providerId?.trim().toLowerCase() || 'composio';
      const toolkitId = input.toolkitId?.trim().toLowerCase();
      if (!toolkitId) throw new Error('An app is required: github or gmail');
      const start = await runtime.actions.initiateConnection({
        providerId, toolkitId, ...runtime.scope, ...(input.label ? { label: input.label } : {}),
      });
      write(`Connecting ${toolkitId}${input.label ? ` · ${input.label}` : ''}\n`);
      write(`Connection: ${start.connectionId}\n`);
      if (start.authorizationUrl) {
        write(`Open: ${start.authorizationUrl}\n`);
        if (input.open !== false) await (deps.openUrl ?? openOAuthBrowserUrl)(start.authorizationUrl);
      }
      write(`After authorization: aiden apps complete ${start.connectionId}\n`);
      return 0;
    }

    if (input.action === 'complete') {
      if (!input.connectionId) throw new Error('A connection identity is required');
      const account = await runtime.actions.completeConnection({ connectionId: input.connectionId, ...runtime.scope });
      write(`Connected: ${account.toolkitId} · ${account.label}\n`);
      write(`Account: ${account.accountId}\n`);
      return 0;
    }

    if (input.action === 'status') {
      if (input.accountId) {
        const account = await runtime.actions.refreshAccount({ accountId: input.accountId, ...runtime.scope });
        write(`${account.toolkitId} · ${account.label}\n${labelHealth(account.health)}\n`);
      } else {
        for (const provider of runtime.providers.list()) {
          const health = await runtime.actions.providerHealth({ providerId: provider.id, ...runtime.scope });
          write(`${provider.label}: ${health.state.replace(/_/g, ' ')}\n`);
        }
      }
      return 0;
    }

    if (input.action === 'reconnect') {
      if (!input.accountId) throw new Error('An account identity is required');
      const account = runtime.accounts.require(input.accountId);
      if (account.ownerId !== runtime.scope.ownerId || account.workspaceId !== runtime.scope.workspaceId) {
        throw new Error('Connected account is outside the current workspace');
      }
      const start = await runtime.actions.initiateConnection({
        providerId: account.providerId, toolkitId: account.toolkitId,
        label: account.label, reconnectAccountId: account.accountId, ...runtime.scope,
      });
      write(`Reconnecting ${account.toolkitId} · ${account.label}\nConnection: ${start.connectionId}\n`);
      if (start.authorizationUrl) {
        write(`Open: ${start.authorizationUrl}\n`);
        if (input.open !== false) await (deps.openUrl ?? openOAuthBrowserUrl)(start.authorizationUrl);
      }
      write(`After authorization: aiden apps complete ${start.connectionId}\n`);
      return 0;
    }

    if (input.action === 'disconnect') {
      if (!input.accountId) throw new Error('An account identity is required');
      const account = runtime.accounts.require(input.accountId);
      if (account.ownerId !== runtime.scope.ownerId || account.workspaceId !== runtime.scope.workspaceId) {
        throw new Error('Connected account is outside the current workspace');
      }
      const allowed = input.yes === true || await (deps.confirm ?? defaultConfirm)(
        `Disconnect ${account.toolkitId} · ${account.label}? Existing Evidence and history will remain.`,
      );
      if (!allowed) { write('Disconnect cancelled.\n'); return 1; }
      await runtime.actions.disconnect({ accountId: account.accountId, ...runtime.scope });
      write(`Disconnected ${account.toolkitId} · ${account.label}.\n`);
      return 0;
    }
    throw new Error('Unknown Apps action');
  } catch (error) {
    write(`Apps error: ${error instanceof Error ? error.message : 'request failed'}\n`);
    return 1;
  } finally {
    closeDaemonDb(dbPath);
  }
}
