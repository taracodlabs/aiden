/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/verbose.ts — Phase 14b
 *
 * `/verbose [mode]` — cycle compact → normal → verbose. Persists to
 * config.yaml under `display.verbose`.
 */
import type { SlashCommand } from '../commandRegistry';

const ORDER = ['compact', 'normal', 'verbose'] as const;
type VerboseMode = (typeof ORDER)[number];

function isMode(s: string): s is VerboseMode {
  return (ORDER as readonly string[]).includes(s);
}

export const verbose: SlashCommand = {
  name: 'verbose',
  description: 'Set verbosity: compact | normal | verbose.',
  category: 'system',
  icon: '🔎',
  handler: async (ctx) => {
    const cfg = ctx.config;
    if (!cfg) {
      ctx.display.warn('Config not wired.');
      return {};
    }
    const explicit = ctx.rawArgs.trim();
    const current = (cfg.getValue<VerboseMode>('display.verbose', 'normal') ??
      'normal') as VerboseMode;
    let next: VerboseMode;
    if (explicit) {
      if (!isMode(explicit)) {
        ctx.display.printError(
          `Unknown verbosity '${explicit}'.`,
          'Use compact, normal, or verbose.',
        );
        return {};
      }
      next = explicit;
    } else {
      const idx = ORDER.indexOf(current);
      next = ORDER[(idx + 1) % ORDER.length];
    }
    cfg.set('display.verbose', next);
    try {
      await cfg.save();
    } catch (err) {
      ctx.display.warn(
        `Saved in-memory but persisting failed: ${(err as Error).message}`,
      );
    }
    ctx.display.success(`Verbosity: ${next}`);
    return {};
  },
};
