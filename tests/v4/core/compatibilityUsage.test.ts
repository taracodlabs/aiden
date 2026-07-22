import { describe, expect, it } from 'vitest';
import { estimateCompatibilityUsage } from '../../../core/v4/compatibilityUsage';

describe('compatibility usage reporting', () => {
  it('counts the complete normalized request and labels estimates honestly', () => {
    const usage = estimateCompatibilityUsage([
      { role: 'system', content: 'system context' },
      { role: 'user', content: 'prior question' },
      { role: 'assistant', content: 'prior answer' },
      { role: 'user', content: 'current question' },
    ], 'answer');
    expect(usage.prompt_tokens).toBeGreaterThan(Math.ceil('current question'.length / 4));
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
    expect(usage.usage_source).toBe('locally_estimated');
    expect(usage.estimated).toBe(true);
  });
});
