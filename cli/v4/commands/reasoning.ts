/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/reasoning.ts — Phase 16a
 *
 * `/reasoning`              show the current effort
 * `/reasoning show`         alias of bare invocation
 * `/reasoning low|med|high` set effort and persist to config
 *
 * The setting is stored as `agent.reasoning_effort` in the user config.
 * Adapters that support reasoning effort (Anthropic thinking budgets, OpenAI
 * o-series) will read the value at call time in Phase 16c. Adapters that
 * don't support it silently ignore the setting.
 */
import type { SlashCommand } from '../commandRegistry';

const VALID = new Set(['low', 'medium', 'high']);

function normalize(arg: string): string {
  const lower = arg.toLowerCase().trim();
  if (lower === 'med') return 'medium';
  return lower;
}

export const reasoning: SlashCommand = {
  name: 'reasoning',
  description: 'Show or set reasoning effort (low/medium/high) for supported models.',
  category: 'system',
  icon: '🧩',
  handler: async (ctx) => {
    const cfg = ctx.config;
    if (!cfg) {
      ctx.display.warn('Config manager not wired in this context.');
      return {};
    }
    const arg = ctx.rawArgs.trim();

    if (!arg || arg === 'show') {
      const current = cfg.getValue<string>('agent.reasoning_effort', 'medium');
      ctx.display.info(`Reasoning effort: ${current ?? 'medium'}`);
      ctx.display.dim(
        '  Anthropic + OpenAI o-series honour this; other providers ignore it.',
      );
      return {};
    }

    const next = normalize(arg);
    if (!VALID.has(next)) {
      ctx.display.printError(
        `Invalid effort '${arg}'.`,
        'Use: /reasoning [low|medium|high|show]',
      );
      return {};
    }

    cfg.set('agent.reasoning_effort', next);
    try {
      await cfg.save();
    } catch (err) {
      ctx.display.printError(
        `Could not save config: ${err instanceof Error ? err.message : String(err)}`,
        'The setting is active for this session only.',
      );
      return {};
    }
    ctx.display.success(`Reasoning effort set to ${next}.`);
    return {};
  },
};
