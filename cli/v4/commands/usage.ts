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
import { currentProviderAttemptLedger } from '../../../providers/v4/providerAttemptAccounting';
import type {
  ProviderAttemptPurpose,
  ProviderAttemptRecord,
  ProviderUsageProjection,
} from '../../../core/v4/usageLedger';

const JSON_PURPOSES: ProviderAttemptPurpose[] = [
  'primary', 'retry', 'fallback', 'auxiliary', 'subagent', 'aggregation', 'compression',
];

const DETAIL_PURPOSES: ProviderAttemptPurpose[] = [
  'primary', 'retry', 'fallback', 'auxiliary', 'subagent', 'aggregation', 'compression',
  'distillation', 'title', 'memory_review', 'legacy_api', 'setup', 'readiness',
];

type PurposeProjection = Partial<Record<ProviderAttemptPurpose, ProviderUsageProjection>>;

export interface UsageProviderBreakdown {
  provider: string;
  model: string;
  projection: ProviderUsageProjection;
}

export interface UsagePresentation {
  providerId: string;
  modelId: string;
  total: ProviderUsageProjection;
  byPurpose: PurposeProjection;
  providers: readonly UsageProviderBreakdown[];
  records: readonly ProviderAttemptRecord[];
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1_000) return String(Math.round(value));
  if (absolute < 1_000_000) return `${(value / 1_000).toFixed(absolute < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(absolute < 10_000_000 ? 1 : 0)}M`;
}

function compactBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`;
  return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MB`;
}

function tokenSource(total: ProviderUsageProjection): 'reported' | 'estimated' | 'mixed' | 'unknown' {
  if (total.providerReportedAttempts > 0 && total.estimatedAttempts > 0) return 'mixed';
  if (total.providerReportedAttempts > 0) return 'reported';
  if (total.estimatedAttempts > 0) return 'estimated';
  return 'unknown';
}

function tokenTotals(total: ProviderUsageProjection): { input: number; output: number } {
  if (total.providerReportedAttempts > 0) {
    return { input: total.providerInputTokens, output: total.providerOutputTokens };
  }
  return { input: total.estimatedInputTokens, output: total.estimatedOutputTokens };
}

function splitLongWord(word: string, width: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < word.length; index += width) parts.push(word.slice(index, index + width));
  return parts;
}

function wrapPlain(value: string, width: number): string[] {
  const safeWidth = Math.max(8, width);
  const words = value.trim().split(/\s+/).flatMap((word) => (
    word.length > safeWidth ? splitLongWord(word, safeWidth) : [word]
  ));
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= safeWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function labelled(label: string, value: string, width: number): string[] {
  const safeWidth = Math.max(24, width);
  const inlinePrefix = `${label.padEnd(12)} `;
  if (inlinePrefix.length + value.length <= safeWidth) return [`${inlinePrefix}${value}`];
  return [label, ...wrapPlain(value, safeWidth - 2).map((line) => `  ${line}`)];
}

function costSummary(total: ProviderUsageProjection): string {
  if (total.unknownCostAttempts > 0) {
    const known = total.knownCostAmount > 0
      ? `; known estimate ${total.knownCostAmount.toFixed(4)} ${total.costCurrency ?? 'currency unknown'}`
      : '';
    return `Unknown for ${total.unknownCostAttempts} ${total.unknownCostAttempts === 1 ? 'call' : 'calls'}${known}`;
  }
  return `${total.knownCostAmount.toFixed(4)} ${total.costCurrency ?? 'currency unknown'} estimated`;
}

function routeSummary(input: UsagePresentation): string {
  const route = input.records
    .map((record) => record.providerActual)
    .filter((provider): provider is string => !!provider)
    .filter((provider, index, providers) => index === 0 || provider !== providers[index - 1]);
  if (route.length === 0) return `${input.providerId}:${input.modelId}`;
  return route.join(' -> ');
}

function activitySummary(byPurpose: PurposeProjection): string[] {
  const rows: string[] = [];
  const add = (label: string, purpose: ProviderAttemptPurpose): void => {
    const attempts = byPurpose[purpose]?.physicalAttempts ?? 0;
    if (attempts > 0) rows.push(`${label}: ${attempts}`);
  };
  add('Retries', 'retry');
  add('Fallback attempts', 'fallback');
  add('Auxiliary calls', 'auxiliary');
  add('Subagent calls', 'subagent');
  add('Aggregation calls', 'aggregation');
  add('Compression calls', 'compression');
  return rows;
}

export function formatUsageSummary(input: UsagePresentation, width = 80): string {
  const total = input.total;
  const tokens = tokenTotals(total);
  const source = tokenSource(total);
  const schemaExposures = total.coreSchemaCount + total.mcpSchemaCount + total.pluginSchemaCount;
  const memoryTokens = total.memoryTokens + total.userProfileTokens + total.projectMemoryTokens;
  const skillTokens = total.skillIndexTokens + total.loadedSkillTokens;
  const rows: string[] = ['Usage — Current session', ''];
  rows.push(...labelled('Route', routeSummary(input), width));
  rows.push(...labelled('Calls', `${total.successfulAttempts} successful · ${total.failedAttempts} failed`, width));
  rows.push(...labelled(
    `Tokens (${source})`,
    `${compactNumber(tokens.input)} input · ${compactNumber(tokens.output)} output · ${compactNumber(total.reasoningTokens)} reasoning`,
    width,
  ));
  rows.push(...labelled(
    'Context',
    `${compactNumber(total.estimatedSchemaTokens)} schemas · ${compactNumber(skillTokens)} skills · ${compactNumber(memoryTokens)} memory`,
    width,
  ));
  rows.push(...labelled(
    'Schemas',
    `${compactNumber(schemaExposures)} cumulative exposures · ${compactNumber(total.deferredSchemaCount)} deferred`,
    width,
  ));
  rows.push(...labelled(
    'Tool data',
    `${compactBytes(total.transmittedToolResultBytes)} sent · ${compactBytes(total.rawToolResultBytes)} raw`,
    width,
  ));
  rows.push(...labelled('Cost', costSummary(total), width));
  for (const activity of activitySummary(input.byPurpose)) {
    const [label, value] = activity.split(': ', 2);
    rows.push(...labelled(label, value, width));
  }
  return `${rows.join('\n')}\n`;
}

function projectionSummary(projection: ProviderUsageProjection): string {
  const tokens = tokenTotals(projection);
  return `${projection.successfulAttempts} ok, ${projection.failedAttempts} failed; `
    + `${compactNumber(tokens.input)} in, ${compactNumber(tokens.output)} out`;
}

export function formatUsageDetails(input: UsagePresentation, width = 80): string {
  const total = input.total;
  const rows: string[] = ['Usage details — Current session', ''];
  rows.push(...labelled('Configured', `${input.providerId}:${input.modelId}`, width));
  const modes = input.records
    .map((record) => record.selectedMode)
    .filter((mode): mode is NonNullable<ProviderAttemptRecord['selectedMode']> => !!mode);
  if (modes.length > 0) rows.push(...labelled('Mode', modes[modes.length - 1]!, width));
  rows.push('', 'Providers and models');
  for (const provider of input.providers) {
    rows.push(...labelled(`${provider.provider}:`, provider.model, width));
    rows.push(...labelled('  Calls', projectionSummary(provider.projection), width));
  }
  rows.push('', 'Purposes');
  for (const purpose of DETAIL_PURPOSES) {
    const projection = input.byPurpose[purpose];
    if (!projection || projection.physicalAttempts === 0) continue;
    rows.push(...labelled(purpose, projectionSummary(projection), width));
  }
  rows.push('', 'Accounting');
  rows.push(...labelled(
    'Usage source',
    `${total.providerReportedAttempts} provider-reported · ${total.estimatedAttempts} locally estimated`,
    width,
  ));
  rows.push(...labelled(
    'Cache',
    `${compactNumber(total.cacheReadTokens)} read · ${compactNumber(total.cacheWriteTokens)} write`,
    width,
  ));
  rows.push(...labelled('Reasoning', `${compactNumber(total.reasoningTokens)} tokens`, width));
  rows.push(...labelled(
    'Memory',
    `${compactNumber(total.memoryTokens)} memory · ${compactNumber(total.userProfileTokens)} profile · ${compactNumber(total.projectMemoryTokens)} project`,
    width,
  ));
  rows.push(...labelled(
    'Skills',
    `${compactNumber(total.skillIndexTokens)} index · ${compactNumber(total.loadedSkillTokens)} loaded`,
    width,
  ));
  rows.push(...labelled(
    'Schemas',
    `${compactNumber(total.coreSchemaCount)} core · ${compactNumber(total.mcpSchemaCount)} MCP · ${compactNumber(total.pluginSchemaCount)} plugin · ${compactNumber(total.deferredSchemaCount)} deferred; cumulative exposures`,
    width,
  ));
  rows.push(...labelled(
    'Tool results',
    `${compactBytes(total.rawToolResultBytes)} raw · ${compactBytes(total.transmittedToolResultBytes)} transmitted`,
    width,
  ));
  rows.push(...labelled('Cost status', costSummary(total), width));
  return `${rows.join('\n')}\n`;
}

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
    const sessionId = session.getSessionId?.();
    const includeSetup = ctx.args.includes('--include-setup');
    const asJson = ctx.args.includes('--json');
    const details = ctx.args.includes('details');
    const ledger = currentProviderAttemptLedger();
    if (ledger && sessionId) {
      const total = ledger.project({ sessionId, includeSetup });
      const purposes = [
        ...JSON_PURPOSES,
        ...(includeSetup ? ['setup', 'readiness'] as ProviderAttemptPurpose[] : []),
      ];
      const byPurpose = Object.fromEntries(purposes.map((purpose) => [
        purpose,
        ledger.project({ sessionId, purpose, includeSetup: true }),
      ])) as Record<ProviderAttemptPurpose, ProviderUsageProjection>;
      const report = { sessionId, providerId, modelId, includeSetup, total, byPurpose };
      if (asJson) {
        ctx.display.write(`${JSON.stringify(report)}\n`);
        return {};
      }
      const records = ledger.query({ sessionId }).filter((record) => (
        includeSetup || (record.purpose !== 'setup' && record.purpose !== 'readiness')
      ));
      const detailPurposes = DETAIL_PURPOSES.filter((purpose) => (
        includeSetup || (purpose !== 'setup' && purpose !== 'readiness')
      ));
      const completeByPurpose = Object.fromEntries(detailPurposes.map((purpose) => [
        purpose,
        ledger.project({ sessionId, purpose, includeSetup: true }),
      ])) as Record<ProviderAttemptPurpose, ProviderUsageProjection>;
      const pairs = records.reduce<Array<{ provider: string; model: string }>>((found, record) => {
        const provider = record.providerActual ?? record.providerConfigured;
        const model = record.modelActual ?? record.modelConfigured;
        if (!provider || !model || found.some((pair) => pair.provider === provider && pair.model === model)) {
          return found;
        }
        found.push({ provider, model });
        return found;
      }, []);
      const presentation: UsagePresentation = {
        providerId,
        modelId,
        total,
        byPurpose: completeByPurpose,
        providers: pairs.map((pair) => ({
          ...pair,
          projection: ledger.project({ sessionId, provider: pair.provider, model: pair.model, includeSetup }),
        })),
        records,
      };
      const width = Math.max(24, ctx.display.terminalColumns());
      ctx.display.write(details
        ? formatUsageDetails(presentation, width)
        : formatUsageSummary(presentation, width));
      return {};
    }
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
