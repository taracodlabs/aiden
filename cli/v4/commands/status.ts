/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/status.ts — Tier-3.1 (v4.1-tier3.1)
 *
 * `/status` — full environment + capability table that the v4.0 boot
 * card used to print inline. Slim boot now ships a 3-4 line summary;
 * users who want the full picture (provider table, skill counts, MCP
 * details, channel adapter list) call `/status` on demand.
 */

import type { SlashCommand } from '../commandRegistry';
import { detectOS, detectShell } from '../chatSession';
import { summarizeChannelState } from '../display';

export const status: SlashCommand = {
  name: 'status',
  description: 'Detailed runtime status (env, providers, skills, channels).',
  category: 'system',
  icon: 'i',
  handler: async (ctx) => {
    const display = ctx.display;

    // Provider / model — drawn from the live session when available.
    const provider = ctx.session?.getCurrentProvider() ?? '(unset)';
    const model    = ctx.session?.getCurrentModel()    ?? '(unset)';

    // Tools / skills counts.
    const toolsCount = ctx.toolRegistry?.list().length ?? 0;
    let skillsLoaded = 0;
    try {
      if (ctx.skillLoader) skillsLoaded = (await ctx.skillLoader.list()).length;
    } catch {
      skillsLoaded = 0;
    }

    // Channels — uses the same summariser the boot card used.
    let channelSummary: string;
    const cm = ctx.channelManager;
    if (cm) {
      const adapterStatuses = cm.getStatus().map((s) => {
        const adapter = cm.get(s.name) as any;
        const botHandle =
          typeof adapter?.getBotUsername === 'function' ? adapter.getBotUsername() : null;
        const state =
          typeof adapter?.getState === 'function' ? adapter.getState() : undefined;
        return { id: s.name, healthy: s.healthy, botHandle, state };
      });
      channelSummary = summarizeChannelState({ adapters: adapterStatuses });
    } else {
      channelSummary = summarizeChannelState(null);
    }

    display.write('\n');
    display.write(
      display.twoColumnBlock(
        {
          title: 'Environment',
          rows: [
            { key: 'OS',       value: detectOS() },
            { key: 'shell',    value: detectShell() },
            { key: 'runtime',  value: 'local-first' },
            { key: 'provider', value: provider },
            { key: 'model',    value: model },
            { key: 'tools',    value: `${toolsCount} loaded` },
            { key: 'skills',   value: `${skillsLoaded} loaded` },
            { key: 'channels', value: channelSummary },
          ],
        },
        {
          title: 'Capabilities',
          rows: [
            { key: 'web',       value: 'research, extract' },
            { key: 'browser',   value: 'navigate, automate' },
            { key: 'files',     value: 'read, patch, organize' },
            { key: 'execution', value: 'shell, code, workflows' },
            { key: 'memory',    value: 'persistent recall' },
          ],
        },
      ) + '\n',
    );
    display.write('\n');
    display.write(`  ${display.rule()}\n`);
    if (
      typeof display.fixedBottomRegionEnabled !== 'function'
      || !display.fixedBottomRegionEnabled()
    ) {
      display.write(display.bottomPromptHint() + '\n');
    }
    display.write('\n');
    return {};
  },
};
