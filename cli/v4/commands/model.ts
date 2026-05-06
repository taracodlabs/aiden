/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/model.ts — Phase 14b
 *
 * `/model [provider:model | model]` — switches the live session's
 * provider/model. Empty args opens the interactive picker (also reused by
 * `aiden model`). Spec form is parsed via Phase 5's ModelSwitcher.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { ModelSwitcher } from '../../../providers/v4/modelSwitch';
import { runModelPicker } from './modelPicker';

export const model: SlashCommand = {
  name: 'model',
  description: 'Switch the active provider/model (interactive when no args).',
  category: 'system',
  icon: '🧠',
  handler: async (ctx: SlashCommandContext) => {
    if (!ctx.resolver) {
      ctx.display.warn('No runtime resolver wired — cannot switch model.');
      return {};
    }
    let providerId: string | undefined;
    let modelId: string | undefined;

    const spec = ctx.rawArgs.trim();
    if (spec) {
      try {
        const switcher = new ModelSwitcher(ctx.resolver);
        const parsed = switcher.parse(spec);
        if (!parsed.providerId) {
          ctx.display.printError(`Unable to resolve '${spec}'.`);
          return {};
        }
        providerId = parsed.providerId;
        modelId = parsed.modelId;
      } catch (err) {
        ctx.display.printError(
          (err as Error).message,
          'Try `provider:model`, e.g. anthropic:claude-opus-4-7.',
        );
        return {};
      }
    } else {
      const picked = await runModelPicker({ resolver: ctx.resolver });
      if (!picked) {
        ctx.display.dim('Model unchanged.');
        return {};
      }
      providerId = picked.providerId;
      modelId = picked.modelId;
    }

    if (ctx.session) {
      try {
        await ctx.session.setProvider(providerId, modelId);
      } catch (err) {
        ctx.display.printError(`Switch failed: ${(err as Error).message}`);
        return {};
      }
    }
    ctx.display.success(`Now using ${providerId}:${modelId}`);
    return {};
  },
};
