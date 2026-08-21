/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { WorkbenchCodingPort } from '../../../core/v4/workbench/codingPort';
import type { SlashCommand } from '../commandRegistry';

const REVIEW_OUTPUT_LIMIT = 24 * 1024;

function boundedReviewText(value: string | null, remaining: number): string {
  if (value === null || remaining <= 0) return '';
  return value.length <= remaining ? value : `${value.slice(0, Math.max(0, remaining - 18))}\n[review truncated]`;
}

export function makeCodingCommand(input: { port: WorkbenchCodingPort }): SlashCommand {
  return {
    name: 'coding',
    description: 'Review, apply, or discard verified isolated coding changes.',
    category: 'system',
    icon: '◇',
    handler: async (ctx) => {
      const operation = (ctx.args[0] ?? '').toLowerCase();
      const identity = (ctx.args[1] ?? '').trim();
      try {
        if (operation === 'health' || operation === 'status') {
          const health = await input.port.health();
          ctx.display.info('External Coding');
          ctx.display.write(`  Provider        ${health.provider}\n`);
          ctx.display.write(`  Version         ${health.version}\n`);
          ctx.display.write(`  Model           ${health.model ?? 'Not configured'}\n`);
          ctx.display.write(`  Authentication  ${health.authentication}\n`);
          ctx.display.write(`  Isolation       ${health.isolation}\n`);
          ctx.display.write('  Network         Disabled by default\n');
          ctx.display.write(`  Status          ${health.ready ? 'Ready' : 'Not ready'}\n`);
          if (!health.ready) ctx.display.warn(`  Reason          ${health.reason}`);
          return {};
        }
        if (operation === 'list') {
          if (!identity) {
            ctx.display.printError('Usage: /coding list <parent-job-id>');
            return {};
          }
          const sessions = input.port.list(identity);
          ctx.display.info(`Coding sessions for ${identity}`);
          if (sessions.length === 0) ctx.display.dim('  No durable coding sessions.');
          for (const session of sessions) {
            const promotion = session.promotion?.promotionId ?? 'no promotion';
            ctx.display.write(`  ${session.state} · ${session.codingSessionId} · ${promotion}\n`);
          }
          return {};
        }

        if (operation === 'review') {
          if (!identity) {
            ctx.display.printError('Usage: /coding review <promotion-id>');
            return {};
          }
          const review = await input.port.review(identity);
          ctx.display.info(`Coding change review · ${review.promotionId}`);
          ctx.display.dim(`  ${review.state} · ${review.files.length} file${review.files.length === 1 ? '' : 's'}${review.truncated ? ' · bounded view' : ''}`);
          let remaining = REVIEW_OUTPUT_LIMIT;
          for (const file of review.files) {
            if (remaining <= 0) break;
            const heading = `\n${file.operation.toUpperCase()} ${file.path}\n`;
            ctx.display.write(heading);
            remaining -= heading.length;
            const before = boundedReviewText(file.before, Math.floor(remaining / 2));
            if (before) {
              const block = `Before:\n${before}\n`;
              ctx.display.write(block);
              remaining -= block.length;
            }
            const after = boundedReviewText(file.after, remaining);
            if (after) {
              const block = `After:\n${after}\n`;
              ctx.display.write(block);
              remaining -= block.length;
            }
          }
          if (remaining <= 0 || review.truncated) ctx.display.dim('Review output is bounded; use Workbench for the full available review.');
          ctx.display.dim(`Apply: /coding apply ${review.promotionId} · Discard: /coding discard ${review.promotionId}`);
          return {};
        }

        if (operation === 'apply' || operation === 'discard') {
          if (!identity) {
            ctx.display.printError(`Usage: /coding ${operation} <promotion-id>`);
            return {};
          }
          if (!ctx.confirm) {
            ctx.display.printError('This action requires an interactive confirmation channel.');
            return {};
          }
          const confirmed = await ctx.confirm(
            operation === 'apply'
              ? `Apply the exact reviewed coding promotion ${identity} to its target workspace?`
              : `Discard the isolated coding promotion ${identity}?`,
          );
          if (!confirmed) {
            ctx.display.dim(`${operation === 'apply' ? 'Apply' : 'Discard'} cancelled.`);
            return {};
          }
          const result = operation === 'apply'
            ? await input.port.apply(identity)
            : await input.port.discard(identity);
          if (result.value.disposition === 'applied') ctx.display.success(`Applied coding promotion ${identity}.`);
          else if (result.value.disposition === 'rejected') ctx.display.success(`Discarded coding promotion ${identity}.`);
          else ctx.display.warn(`Coding promotion ${identity}: ${result.value.disposition}.`);
          return {};
        }

        ctx.display.printError(
          'Usage: /coding health | list <parent-job-id> | review <promotion-id> | apply <promotion-id> | discard <promotion-id>',
        );
      } catch (error) {
        ctx.display.printError(error instanceof Error ? error.message : 'Coding promotion request failed');
      }
      return {};
    },
  };
}
