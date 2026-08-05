/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/setup.ts — Phase 30.2.1
 *
 * `/setup` — re-runs the setup wizard from inside an existing REPL
 * session. Most useful in explore mode (after the boot wizard's
 * "Skip — explore Aiden first" branch) where the user has decided
 * they want to actually configure a provider after looking around.
 *
 * After the wizard returns, the session rebuilds the selected provider
 * adapter before swapping it in. A failed rebuild leaves the prior working
 * provider untouched.
 */
import type { SlashCommand } from '../commandRegistry';
import { runSetupWizard } from '../setupWizard';
import { runtimeTrace } from '../../../core/v4/runtimeTrace';

export const setup: SlashCommand = {
  name: 'setup',
  description: 'Re-run the setup wizard (configure provider + API key).',
  category: 'system',
  icon: '⚙',
  handler: async (ctx) => {
    if (!ctx.paths) {
      ctx.display.printError(
        'Cannot run wizard from this context — no paths available.',
        'This is a wiring bug; please report.',
      );
      return;
    }
    const result = await ctx.display.withModalLease('setup', () => runSetupWizard({
      paths: ctx.paths!,
      display: ctx.display,
      force: true,
    }));
    if (result.status === 'configured' && result.ran) {
      const providerId = result.config?.model.provider;
      const modelId = result.config?.model.modelId;
      runtimeTrace('provider', 'setup.completed', {
        providerId: providerId ?? null,
        modelId: modelId ?? null,
        readiness: result.readiness?.state ?? null,
      });
      if (!providerId || !modelId || !ctx.session) {
        ctx.display.printError(
          'Provider was saved but could not activate in this session.',
          'The previous provider remains active; run /model to retry activation.',
        );
        return;
      }
      try {
        await ctx.session.setProvider(providerId, modelId);
        runtimeTrace('provider', 'adapter.rebuilt', { providerId, modelId, activated: true });
        ctx.display.write(`\nProvider configured and active: ${providerId}:${modelId}.\n\n`);
      } catch (error) {
        runtimeTrace('provider', 'adapter.rebuilt', {
          providerId,
          modelId,
          activated: false,
          errorKind: error instanceof Error ? error.name : 'unknown',
        });
        ctx.display.printError(
          'Provider was configured but could not activate in this session.',
          'The previous provider remains active; check readiness and run /model to retry.',
        );
      }
    } else if (result.status === 'skipped') {
      ctx.display.write(
        '\nStill in explore mode. Run /setup again whenever you\'re ready.\n\n',
      );
    } else if (result.status === 'exited') {
      // Wizard explicitly chose to exit — but we're inside a REPL,
      // so just report and stay in the session.
      ctx.display.dim('Wizard exited; continuing existing session.');
    }
    return;
  },
};
