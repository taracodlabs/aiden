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
import { renderTable } from '../table';

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
        // v4.8.0 Slice 3 — framed auxiliary-calls table replaces the
        // ad-hoc padEnd lines. Right-align numeric columns.
        ctx.display.write('\n');
        ctx.display.write(renderTable(
          purposes.map((p) => ({
            purpose: p,
            calls:   String(aux[p].calls),
            in:      String(aux[p].inputTokens),
            out:     String(aux[p].outputTokens),
          })),
          [
            { key: 'purpose', header: 'purpose', align: 'left'  },
            { key: 'calls',   header: 'calls',   align: 'right' },
            { key: 'in',      header: 'in',      align: 'right' },
            { key: 'out',     header: 'out',     align: 'right' },
          ],
          {
            title:      'Auxiliary calls',
            totalCount: `${purposes.length} ${purposes.length === 1 ? 'purpose' : 'purposes'}`,
          },
        ));
      }
    }
    return {};
  },
};
