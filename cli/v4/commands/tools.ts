/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/tools.ts — Phase 14b
 * Lists tools registered with ToolRegistry, grouped by toolset.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';

export const tools: SlashCommand = {
  name: 'tools',
  description: 'List available tools, grouped by toolset.',
  category: 'system',
  icon: '🛠',
  handler: async (ctx: SlashCommandContext) => {
    if (!ctx.toolRegistry) {
      ctx.display.warn('Tool registry not wired in this context.');
      return {};
    }
    const groups = new Map<string, string[]>();
    for (const name of ctx.toolRegistry.list()) {
      const handler = ctx.toolRegistry.get(name);
      const toolset = handler?.toolset ?? 'misc';
      const arr = groups.get(toolset) ?? [];
      arr.push(name);
      groups.set(toolset, arr);
    }
    if (groups.size === 0) {
      ctx.display.dim('(no tools registered)');
      return {};
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [toolset, names] of sorted) {
      ctx.display.info(`${toolset} (${names.length})`);
      for (const n of names.sort()) {
        ctx.display.write(`  • ${n}\n`);
      }
    }
    return {};
  },
};
