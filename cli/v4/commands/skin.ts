/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/skin.ts — Phase 14b + Phase 16a
 *
 * `/skin`              list available skins + show current
 * `/skin <name>`       switch to a named skin
 * `/skin reload`       re-read the active skin from disk (live iteration)
 */
import type { SlashCommand } from '../commandRegistry';
import { theme } from './theme';

export const skin: SlashCommand = {
  name: 'skin',
  description: 'Switch terminal colour skin, list available, or /skin reload.',
  category: 'system',
  icon: '🎨',
  handler: async (ctx) => {
    ctx.display.warn(
      '/skin is deprecated — use /theme. Legacy names now select the matching effective theme.',
    );
    const target = ctx.rawArgs.trim();
    const mapped = target === '' ? 'list'
      : target === 'reload' ? 'reload'
      : target === 'default' ? 'set aiden-ember'
      : target === 'monochrome' ? 'set monochrome'
      : target === 'light' ? 'set light'
      : null;
    if (!mapped) {
      ctx.display.printError(
        `Legacy skin '${target}' has no effective-theme mapping.`,
        'Use /theme list and /theme set <name>.',
      );
      return {};
    }
    return theme.handler({ ...ctx, rawArgs: mapped });
  },
};
