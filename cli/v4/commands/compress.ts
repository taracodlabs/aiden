/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/compress.ts — Phase 14b
 *
 * `/compress` — force-runs Phase 13's ContextCompressor on the active
 * session's history and replaces it with the compressed version.
 */
import type { SlashCommand } from '../commandRegistry';
import { runWithProviderUsageContext } from '../../../providers/v4/providerAttemptAccounting';

export const compress: SlashCommand = {
  name: 'compress',
  description: 'Summarise older history to free up context.',
  category: 'system',
  icon: '#',
  handler: async (ctx) => {
    if (!ctx.compressor || !ctx.session) {
      ctx.display.warn('Compressor or session not wired.');
      return {};
    }
    const before = ctx.session.history.length;
    const providerId = ctx.session.getCurrentProvider();
    const modelId = ctx.session.getCurrentModel();
    const spinner = ctx.display.startSpinner('Compressing context…');
    let result;
    try {
      const sessionId = ctx.session.getSessionId?.() ?? null;
      result = await runWithProviderUsageContext(
        {
          sessionId,
          runId: sessionId,
          entryPoint: 'cli',
          purpose: 'compression',
          providerConfigured: providerId,
          modelConfigured: modelId,
        },
        () => ctx.compressor!.forceCompress(
          ctx.session!.history,
          providerId,
          modelId,
        ),
      );
    } catch (err) {
      spinner.stop();
      ctx.display.printError(`Compression failed: ${(err as Error).message}`);
      return {};
    }
    spinner.stop();
    if (result.error) {
      ctx.display.warn(result.errorMessage
        ? `Compression failed safely: ${result.errorMessage}`
        : 'Compression auxiliary call failed; history unchanged.');
      return {};
    }
    if (result.refused) {
      ctx.display.dim('Conversation too short — nothing compressed.');
      return {};
    }
    ctx.session.setHistory(result.compressedMessages);
    const after = result.compressedMessages.length;
    ctx.display.success(
      `Compressed ${before} → ${after} messages (~${result.summaryTokens} summary tokens).`,
    );
    return {};
  },
};
