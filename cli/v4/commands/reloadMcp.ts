/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/reloadMcp.ts — Phase 14b
 * `/reload-mcp` — re-discovers tools on every connected MCP server.
 */
import type { SlashCommand } from '../commandRegistry';

export const reloadMcp: SlashCommand = {
  name: 'reload-mcp',
  description: 'Re-discover tools on every connected MCP server.',
  category: 'system',
  icon: '🔌',
  handler: async (ctx) => {
    if (!ctx.mcpClient) {
      ctx.display.warn('MCP client not wired.');
      return {};
    }
    const spinner = ctx.display.startSpinner('Reloading MCP servers…');
    try {
      await ctx.mcpClient.reload();
    } catch (err) {
      spinner.stop();
      ctx.display.printError(`Reload failed: ${(err as Error).message}`);
      return {};
    }
    spinner.stop();
    // McpClient exposes server count via its public surface — fall back
    // gracefully if listServers() isn't available on the wired client.
    let count: number | undefined;
    const anyClient = ctx.mcpClient as unknown as {
      listServers?: () => unknown[];
    };
    if (typeof anyClient.listServers === 'function') {
      count = anyClient.listServers().length;
    }
    ctx.display.success(
      count !== undefined
        ? `MCP reloaded — ${count} server(s) ready.`
        : 'MCP reloaded.',
    );
    return {};
  },
};
