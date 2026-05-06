/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/usage.ts — Phase 14b
 *
 * `/usage` — token + cost report for the current session. Pricing comes
 * from MODEL_CATALOG; missing pricing rows print "(pricing unknown)" — we
 * never fabricate.
 */
import type { SlashCommand } from '../commandRegistry';
import { findModel } from '../../../providers/v4/modelCatalog';

export const usage: SlashCommand = {
  name: 'usage',
  description: 'Show token consumption and estimated cost.',
  category: 'system',
  icon: '💰',
  handler: async (ctx) => {
    const session = ctx.session;
    if (!session) {
      ctx.display.warn('No active session.');
      return {};
    }
    const providerId = session.getCurrentProvider();
    const modelId = session.getCurrentModel();
    const usage = session.getTotalUsage?.() ?? { inputTokens: 0, outputTokens: 0 };
    const entry = findModel(providerId, modelId);

    ctx.display.info(`Model: ${providerId}:${modelId}`);
    ctx.display.write(`  Input tokens : ${usage.inputTokens}\n`);
    ctx.display.write(`  Output tokens: ${usage.outputTokens}\n`);

    if (entry?.pricing) {
      const inCost = (usage.inputTokens / 1_000_000) * entry.pricing.inputPerM;
      const outCost = (usage.outputTokens / 1_000_000) * entry.pricing.outputPerM;
      const total = inCost + outCost;
      ctx.display.write(`  Estimated cost: $${total.toFixed(4)}\n`);
    } else {
      ctx.display.dim('  (pricing unknown for this model)');
    }

    if (ctx.auxiliaryClient) {
      const aux = ctx.auxiliaryClient.getUsage();
      const purposes = Object.keys(aux);
      if (purposes.length > 0) {
        ctx.display.write('\n');
        ctx.display.info('Auxiliary calls:');
        for (const p of purposes) {
          const u = aux[p];
          ctx.display.write(
            `  ${p.padEnd(18)} calls=${u.calls} in=${u.inputTokens} out=${u.outputTokens}\n`,
          );
        }
      }
    }
    return {};
  },
};
