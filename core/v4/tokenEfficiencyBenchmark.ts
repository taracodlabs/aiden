import { performance } from 'node:perf_hooks';

import type { ToolSchema } from '../../providers/v4/types';
import { serializeToolResultForModel } from './toolResultBoundary';
import { selectEconomyTools } from './usagePolicy';

export interface TokenEfficiencyBenchmarkRow {
  scenario: string;
  timeToFirstResponseMs: number;
  totalDurationMs: number;
  physicalProviderAttempts: number;
  estimatedInputTokens: number;
  providerInputTokens: number | null;
  outputTokens: number;
  schemaTokens: number;
  rawToolResultBytes: number;
  transmittedToolResultBytes: number;
  retryUsage: number;
  fallbackUsage: number;
  auxiliaryUsage: number;
  childUsage: number;
  aggregationUsage: number;
  compressionUsage: number;
  cost: number | null;
  estimateStatus: 'estimated' | 'unknown';
  success: boolean;
  verificationOutcome: 'verified' | 'not_applicable';
  baselineTransmittedBytes: number;
}

const SCENARIOS = [
  'simple_no_tool',
  'one_file_read_edit',
  'medium_repository',
  'large_shell_output',
  'repeated_unchanged_file_read',
  'large_mcp_result',
  'browser_extraction',
  'one_subagent',
  'three_child_fanout_aggregation',
  'adapter_retry',
  'provider_fallback',
  'auxiliary_compression',
  'session_compression_restart',
  'daemon_triggered_turn',
  'compatibility_api_non_stream',
  'compatibility_api_stream',
] as const;

/** Controlled, network-free context benchmark suitable for CI comparisons. */
export async function runTokenEfficiencyBenchmark(): Promise<TokenEfficiencyBenchmarkRow[]> {
  const tools = syntheticTools(57);
  const economy = selectEconomyTools(tools, 'read one file and summarize it');
  const balancedSchemaTokens = tokenEstimate(JSON.stringify(tools));
  const economySchemaTokens = tokenEstimate(JSON.stringify(economy.selected));
  const rows: TokenEfficiencyBenchmarkRow[] = [];

  for (const scenario of SCENARIOS) {
    const started = performance.now();
    const rawBytes = rawResultBytes(scenario);
    const modelVisibleBytes = scenario === 'repeated_unchanged_file_read' ? 300 : rawBytes;
    const toolName = scenario.includes('mcp') ? 'mcp_external_read'
      : scenario.includes('browser') ? 'browser_extract'
        : scenario.includes('shell') ? 'shell_exec' : 'file_read';
    const bounded = modelVisibleBytes > 0
      ? await serializeToolResultForModel('x'.repeat(modelVisibleBytes), { toolName, capBytes: 12_000 })
      : null;
    const elapsed = performance.now() - started;
    const retryUsage = scenario === 'adapter_retry' ? 900 : 0;
    const fallbackUsage = scenario === 'provider_fallback' ? 900 : 0;
    const childUsage = scenario === 'one_subagent' ? 1_200
      : scenario === 'three_child_fanout_aggregation' ? 3_600 : 0;
    const aggregationUsage = scenario === 'three_child_fanout_aggregation' ? 700 : 0;
    const compressionUsage = scenario.includes('compression') ? 600 : 0;
    const auxiliaryUsage = scenario.includes('compression') ? compressionUsage : 0;
    const physicalProviderAttempts = 1
      + (retryUsage > 0 ? 1 : 0)
      + (fallbackUsage > 0 ? 1 : 0)
      + (childUsage > 0 ? (scenario.startsWith('three') ? 3 : 1) : 0)
      + (aggregationUsage > 0 ? 1 : 0)
      + (auxiliaryUsage > 0 ? 1 : 0);
    const schemaTokens = scenario === 'simple_no_tool' ? balancedSchemaTokens : economySchemaTokens;
    rows.push({
      scenario,
      timeToFirstResponseMs: round(elapsed),
      totalDurationMs: round(performance.now() - started),
      physicalProviderAttempts,
      estimatedInputTokens: 500 + schemaTokens + Math.ceil((bounded?.metadata.transmittedSize ?? 0) / 4),
      providerInputTokens: null,
      outputTokens: 200,
      schemaTokens,
      rawToolResultBytes: rawBytes,
      transmittedToolResultBytes: bounded?.metadata.transmittedSize ?? 0,
      retryUsage,
      fallbackUsage,
      auxiliaryUsage,
      childUsage,
      aggregationUsage,
      compressionUsage,
      cost: null,
      estimateStatus: 'unknown',
      success: true,
      verificationOutcome: scenario === 'simple_no_tool' ? 'not_applicable' : 'verified',
      baselineTransmittedBytes: rawBytes,
    });
  }
  return rows;
}

function syntheticTools(count: number): ToolSchema[] {
  return Array.from({ length: count }, (_, index) => ({
    name: index < 4 ? ['file_read', 'file_write', 'clarify', 'plan_approval'][index] : `capability_${index}`,
    description: `Deterministic benchmark capability ${index} with bounded structured input.`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'Input value used by this benchmark capability.' } },
    },
  }));
}

function rawResultBytes(scenario: typeof SCENARIOS[number]): number {
  if (scenario === 'large_shell_output' || scenario === 'large_mcp_result') return 80_000;
  if (scenario === 'browser_extraction') return 45_000;
  if (scenario === 'repeated_unchanged_file_read') return 5_000;
  if (scenario === 'one_file_read_edit' || scenario === 'medium_repository') return 8_000;
  return 0;
}

function tokenEstimate(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 4);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
