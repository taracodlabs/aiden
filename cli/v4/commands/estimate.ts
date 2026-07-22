import type { SlashCommand } from '../commandRegistry';
import { findModel } from '../../../providers/v4/modelCatalog';
import { estimateTaskUsage, parseUsageMode } from '../../../core/v4/usagePolicy';

export const estimate: SlashCommand = {
  name: 'estimate',
  description: 'Estimate tokens, provider calls, cost, and main drivers locally.',
  category: 'system',
  icon: '#',
  handler: async (ctx) => {
    const asJson = ctx.args.includes('--json');
    const task = ctx.args.filter((arg) => arg !== '--json').join(' ').trim();
    if (!task) {
      ctx.display.warn('Usage: /estimate [--json] <task>');
      return {};
    }
    const provider = ctx.session?.getCurrentProvider() ?? '';
    const model = ctx.session?.getCurrentModel() ?? '';
    const catalog = findModel(provider, model);
    const mode = parseUsageMode(ctx.config?.getValue<string>('usage.mode', 'balanced')) ?? 'balanced';
    const result = estimateTaskUsage({
      task,
      messages: ctx.session?.history ?? [],
      tools: ctx.toolRegistry?.getSchemas(undefined, 'repl') ?? [],
      mode,
      tokenBudget: ctx.config?.getValue<number>('budget.session_token_cap', 0) ?? 0,
      pricing: catalog?.pricing ?? null,
    });
    if (asJson) {
      ctx.display.write(`${JSON.stringify(result)}\n`);
      return {};
    }
    ctx.display.info(`Estimate: ${result.complexity} · ${result.confidence} confidence · ${result.selectedMode}`);
    ctx.display.write(`  Tokens: ${result.estimatedTokenLow.toLocaleString()}–${result.estimatedTokenHigh.toLocaleString()}\n`);
    ctx.display.write(`  Provider calls: ${result.estimatedCallsLow}–${result.estimatedCallsHigh}\n`);
    if (result.costStatus === 'unknown') ctx.display.dim('  Cost: unknown for the selected model');
    else ctx.display.write(`  Estimated cost: $${result.estimatedCostLow!.toFixed(4)}–$${result.estimatedCostHigh!.toFixed(4)}\n`);
    ctx.display.write(`  Main drivers: ${result.mainCostDrivers.join(', ')}\n`);
    if (result.configuredBudget) ctx.display.write(`  Token budget: ${result.configuredBudget.toLocaleString()}\n`);
    return {};
  },
};
