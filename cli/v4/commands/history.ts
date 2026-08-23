/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/history.ts — Phase v4.1-tier3-essentials
 *
 * `/history [list|clear] [N]`
 *
 *   /history          — list last 50 entries (newest first)
 *   /history list 200 — list last 200 (clamped to HISTORY_MAX_ENTRIES)
 *   /history clear    — wipe the on-disk history (with double-Enter
 *                       confirmation)
 *
 * The on-disk file is `<aidenHome>/.aiden_history`, written by
 * `historyStore.appendHistory`. This command is read-only except for
 * `clear`, which removes the file entirely.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { SlashCommand } from '../commandRegistry';
import { loadRecent, HISTORY_MAX_ENTRIES } from '../historyStore';
import { resolveAidenPaths } from '../../../core/v4/paths';

const HISTORY_FILENAME = '.aiden_history';

export const history: SlashCommand = {
  name:        'history',
  description: 'List command/prompt recall history; use clear --yes to erase it.',
  category:    'system',
  handler: async (ctx) => {
    const sub = (ctx.args[0] ?? 'list').toLowerCase();

    if (sub === 'list') {
      const limit = (() => {
        const arg = ctx.args[1];
        const n = arg ? parseInt(arg, 10) : 50;
        if (!Number.isFinite(n) || n <= 0) return 50;
        return Math.min(n, HISTORY_MAX_ENTRIES);
      })();
      const entries = await loadRecent(limit);
      if (entries.length === 0) {
        ctx.display.dim('(history is empty)');
        return {};
      }
      ctx.display.info(`History (last ${entries.length}):`);
      // Newest first; render as numbered list. Truncate each entry
      // to keep the display tidy — full entry is one Enter away on
      // arrow-up in the new prompt.
      entries.forEach((entry, i) => {
        const oneLine = entry.replace(/\s+/g, ' ').trim();
        const display = oneLine.length > 100 ? oneLine.slice(0, 99) + '…' : oneLine;
        ctx.display.write(`  ${String(i + 1).padStart(3, ' ')}. ${display}\n`);
      });
      return {};
    }

    if (sub === 'clear') {
      const confirm = ctx.args[1];
      if (confirm !== '--yes') {
        ctx.display.warn('History clear requires confirmation.');
        ctx.display.dim('Run `/history clear --yes` to wipe the on-disk history file.');
        return {};
      }
      const filePath = path.join(resolveAidenPaths().root, HISTORY_FILENAME);
      try {
        await fsp.rm(filePath, { force: true });
        // Also drop any sibling .tmp left from an interrupted append.
        await fsp.rm(`${filePath}.tmp`, { force: true });
        ctx.display.success('History cleared.');
      } catch (err) {
        ctx.display.printError(`Failed to clear history: ${(err as Error).message}`);
      }
      return {};
    }

    ctx.display.printError(
      `Unknown subcommand: ${sub}`,
      'Try: /history list [N] | /history clear --yes',
    );
    return {};
  },
};
