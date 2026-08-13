/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { openOAuthBrowserUrl } from '../auth/loadProvider';

function healthLabel(value: string): string {
  switch (value) {
    case 'healthy': return 'Healthy';
    case 'expired': return 'Authentication expired';
    case 'insufficient_scope': return 'Insufficient access';
    case 'revoked': return 'Disconnected';
    case 'degraded': return 'Needs attention';
    default: return 'Not checked';
  }
}

async function showApps(ctx: SlashCommandContext): Promise<void> {
  const runtime = ctx.integrationRuntime;
  if (!runtime) { ctx.display.warn('Apps are not available in this session.'); return; }
  ctx.display.info('Aiden Apps');
  const accounts = runtime.accounts.list({ ...runtime.scope, includeRevoked: false });
  ctx.display.write('\nConnected\n');
  if (accounts.length === 0) ctx.display.dim('  No connected accounts.');
  for (const account of accounts) {
    ctx.display.write(`  ${account.toolkitId.padEnd(12)} ${account.label.padEnd(18)} ${healthLabel(account.health)}\n`);
  }
  ctx.display.write('\nAvailable\n');
  let available = 0;
  for (const provider of runtime.providers.list()) {
    const health = await runtime.actions.providerHealth({ providerId: provider.id, ...runtime.scope });
    if (health.state === 'not_configured') {
      ctx.display.write(`  ${provider.label.padEnd(12)} Not configured\n`);
      continue;
    }
    try {
      for (const toolkit of await runtime.actions.listToolkits({ providerId: provider.id, ...runtime.scope })) {
        available += 1;
        ctx.display.write(`  ${toolkit.label.padEnd(12)} ${provider.label}\n`);
      }
    } catch {
      ctx.display.write(`  ${provider.label.padEnd(12)} ${health.state === 'healthy' ? 'Unavailable' : healthLabel(health.state)}\n`);
    }
  }
  if (available === 0) ctx.display.dim('  Configure a provider, then connect GitHub or Gmail.');
  ctx.display.dim('Use /apps accounts, /apps connect, /apps status, or /apps disconnect.');
}

async function showAccounts(ctx: SlashCommandContext, toolkitId?: string): Promise<void> {
  const runtime = ctx.integrationRuntime;
  if (!runtime) { ctx.display.warn('Apps are not available in this session.'); return; }
  const rows = runtime.accounts.list({ ...runtime.scope, ...(toolkitId ? { toolkitId } : {}), includeRevoked: true });
  ctx.display.info(toolkitId ? `${toolkitId} accounts` : 'Connected accounts');
  if (rows.length === 0) { ctx.display.dim('No connected accounts.'); return; }
  for (const account of rows) {
    ctx.display.write(`  ${account.label}  ·  ${account.toolkitId}  ·  ${healthLabel(account.health)}\n`);
    ctx.display.dim(`    ${account.accountId}`);
  }
}

async function startConnection(
  ctx: SlashCommandContext,
  providerId: string,
  toolkitId: string,
  label?: string,
  reconnectAccountId?: string,
): Promise<void> {
  const runtime = ctx.integrationRuntime!;
  const start = await runtime.actions.initiateConnection({
    providerId, toolkitId, ...runtime.scope,
    ...(label ? { label } : {}),
    ...(reconnectAccountId ? { reconnectAccountId } : {}),
  });
  ctx.display.info(`Connecting ${toolkitId}${label ? ` · ${label}` : ''}`);
  if (start.authorizationUrl) {
    ctx.display.write(`  Open: ${start.authorizationUrl}\n`);
    await openOAuthBrowserUrl(start.authorizationUrl);
  }
  ctx.display.dim(`After authorization, run /apps complete ${start.connectionId}`);
}

export const apps: SlashCommand = {
  name: 'apps',
  description: 'Connect and manage app accounts.',
  category: 'system',
  icon: '◇',
  handler: async (ctx) => {
    const runtime = ctx.integrationRuntime;
    if (!runtime) { ctx.display.warn('Apps are not available in this session.'); return {}; }
    const sub = (ctx.args[0] ?? 'list').toLowerCase();
    try {
      if (sub === 'list') await showApps(ctx);
      else if (sub === 'accounts') await showAccounts(ctx, ctx.args[1]);
      else if (sub === 'status') {
        const accountId = ctx.args[1];
        if (!accountId) { await showAccounts(ctx); return {}; }
        const account = await runtime.actions.refreshAccount({ accountId, ...runtime.scope });
        ctx.display.info(`${account.toolkitId} · ${account.label}`);
        ctx.display.write(`  ${healthLabel(account.health)}\n`);
      } else if (sub === 'connect') {
        const toolkitId = ctx.args[1]?.toLowerCase();
        if (!toolkitId) { ctx.display.printError('Usage: /apps connect <github|gmail> [label] [provider]'); return {}; }
        await startConnection(ctx, (ctx.args[3] ?? 'composio').toLowerCase(), toolkitId, ctx.args[2]);
      } else if (sub === 'complete') {
        const connectionId = ctx.args[1];
        if (!connectionId) { ctx.display.printError('Usage: /apps complete <connection-id>'); return {}; }
        const account = await runtime.actions.completeConnection({ connectionId, ...runtime.scope });
        ctx.display.info(`✓ ${account.toolkitId} connected`);
        ctx.display.write(`  ${account.label}  ·  ${healthLabel(account.health)}\n`);
      } else if (sub === 'disconnect') {
        const accountId = ctx.args[1];
        if (!accountId) { ctx.display.printError('Usage: /apps disconnect <account-id>'); return {}; }
        const account = runtime.accounts.require(accountId);
        if (account.ownerId !== runtime.scope.ownerId || account.workspaceId !== runtime.scope.workspaceId) {
          throw new Error('Connected account is outside the current workspace');
        }
        if (!ctx.confirm || !(await ctx.confirm(
          `Disconnect ${account.toolkitId} · ${account.label}? Existing Evidence and history will remain.`,
        ))) {
          ctx.display.dim('Disconnect cancelled.');
          return {};
        }
        await runtime.actions.disconnect({ accountId, ...runtime.scope });
        ctx.display.info(`✓ Disconnected ${account.toolkitId} · ${account.label}`);
      } else if (sub === 'reconnect') {
        const accountId = ctx.args[1];
        if (!accountId) { ctx.display.printError('Usage: /apps reconnect <account-id>'); return {}; }
        const account = runtime.accounts.require(accountId);
        if (account.ownerId !== runtime.scope.ownerId || account.workspaceId !== runtime.scope.workspaceId) {
          throw new Error('Connected account is outside the current workspace');
        }
        await startConnection(ctx, account.providerId, account.toolkitId, account.label, account.accountId);
      } else {
        ctx.display.printError(`Unknown apps command: ${sub}`,
          'Try: /apps list | accounts | connect | complete | status | reconnect | disconnect');
      }
    } catch (error) {
      ctx.display.printError(error instanceof Error ? error.message : 'Apps request failed');
    }
    return {};
  },
};
