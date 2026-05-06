/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/help.ts — Phase 14b
 * Lists every visible slash command, grouped by category.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';

export const help: SlashCommand = {
  name: 'help',
  description: 'List available slash commands.',
  category: 'system',
  icon: '❔',
  aliases: ['h', '?'],
  handler: async (ctx: SlashCommandContext) => {
    const all = ctx.registry.list();
    const system = all.filter((c) => c.category === 'system');
    const skill = all.filter((c) => c.category === 'skill');

    ctx.display.info('System commands:');
    for (const c of system) {
      const icon = c.icon ?? ' ';
      ctx.display.write(`  ${icon} /${c.name.padEnd(14)} ${c.description}\n`);
    }
    if (skill.length > 0) {
      ctx.display.write('\n');
      ctx.display.info('Skill commands:');
      for (const c of skill) {
        ctx.display.write(`  ⚡ /${c.name.padEnd(14)} ${c.description}\n`);
      }
    }
    return {};
  },
};
