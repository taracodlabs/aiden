/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/queue.ts — v4.12.1 Pillar 4 Slice 2a.
 *
 * `/queue` — list the type-next queue (messages typed while a turn was
 * running, waiting to run). `/queue clear` — empty it. So a queued message is
 * never invisible or un-cancellable.
 */
import type { SlashCommand } from '../commandRegistry';

export const queue: SlashCommand = {
  name: 'queue',
  description: 'List the type-next queue (or `/queue clear` to empty it).',
  category: 'system',
  icon: '📝',
  handler: async (ctx) => {
    const session = ctx.session;
    if (!session?.listQueue || !session.clearQueue) {
      ctx.display.warn('Not available in this context.');
      return {};
    }
    const sub = (ctx.args[0] ?? '').trim().toLowerCase();
    if (sub === 'clear') {
      const n = session.clearQueue();
      ctx.display.success(n > 0 ? `Cleared ${n} queued message${n === 1 ? '' : 's'}.` : 'Queue was already empty.');
      return {};
    }
    const items = session.listQueue();
    if (items.length === 0) {
      ctx.display.info('Type-next queue is empty. Type while a turn runs to queue a message (see /busy).');
      return {};
    }
    ctx.display.info(`Type-next queue (${items.length}) — runs in order after the current turn:`);
    items.forEach((m, i) => ctx.display.write(`  ${i + 1}. ${m.length > 100 ? m.slice(0, 99) + '…' : m}\n`));
    ctx.display.dim('Run /queue clear to empty it.');
    return {};
  },
};
