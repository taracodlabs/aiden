import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Workbench runtime model projection', () => {
  it('reloads the authoritative configured default instead of projecting launch-time model state', () => {
    const source = readFileSync('cli/v4/aidenCLI.ts', 'utf8');
    const start = source.indexOf('runtime: () => {');
    const end = source.indexOf('\n        activeJobs:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    expect(block).toContain('new ConfigManager(paths).loadSync()');
    expect(block).not.toContain('workbenchRuntime.providerId');
    expect(block).not.toContain('workbenchRuntime.modelId');
  });
});
