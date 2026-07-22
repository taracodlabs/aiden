import { describe, expect, it } from 'vitest';

import { runTokenEfficiencyBenchmark } from '../../../core/v4/tokenEfficiencyBenchmark';

describe('deterministic token-efficiency benchmark', () => {
  it('covers every release-gate scenario and meets context-reduction targets', async () => {
    const rows = await runTokenEfficiencyBenchmark();
    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((row) => row.scenario)).size).toBe(16);

    for (const scenario of ['large_shell_output', 'large_mcp_result', 'browser_extraction']) {
      const row = rows.find((entry) => entry.scenario === scenario)!;
      expect(row.transmittedToolResultBytes).toBeLessThan(row.baselineTransmittedBytes * 0.3);
    }
    const retry = rows.find((row) => row.scenario === 'adapter_retry')!;
    const fallback = rows.find((row) => row.scenario === 'provider_fallback')!;
    const fanout = rows.find((row) => row.scenario === 'three_child_fanout_aggregation')!;
    const repeatedRead = rows.find((row) => row.scenario === 'repeated_unchanged_file_read')!;
    const balanced = rows.find((row) => row.scenario === 'simple_no_tool')!;
    const economy = rows.find((row) => row.scenario === 'one_file_read_edit')!;
    expect(retry.physicalProviderAttempts).toBe(2);
    expect(retry.retryUsage).toBeGreaterThan(0);
    expect(fallback.physicalProviderAttempts).toBe(2);
    expect(fallback.fallbackUsage).toBeGreaterThan(0);
    expect(fanout.childUsage).toBeGreaterThan(0);
    expect(fanout.aggregationUsage).toBeGreaterThan(0);
    expect(repeatedRead.transmittedToolResultBytes).toBeLessThanOrEqual(repeatedRead.baselineTransmittedBytes * 0.1);
    expect(economy.schemaTokens).toBeLessThan(balanced.schemaTokens);
    expect(rows.every((row) => row.cost === null && row.estimateStatus === 'unknown')).toBe(true);
  });
});
