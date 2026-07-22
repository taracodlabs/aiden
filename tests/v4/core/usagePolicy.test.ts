import { describe, expect, it } from 'vitest';
import type { Message, ToolSchema } from '../../../providers/v4/types';
import {
  classifyBudgetState,
  estimateTaskUsage,
  selectEconomyTools,
} from '../../../core/v4/usagePolicy';

const schema = (name: string): ToolSchema => ({
  name,
  description: `${name} capability`,
  inputSchema: { type: 'object', properties: {} },
});

describe('usage policy', () => {
  it('reduces Economy schemas deterministically while retaining safety tools', () => {
    const tools = [
      'clarify', 'plan_approval', 'file_read', 'file_write', 'file_patch',
      'shell_exec', 'web_search', 'browser_click', 'memory_add', 'skills_list',
      'process_spawn', 'session_search', 'spawn_sub_agent', 'tool_result_artifact_read',
    ].map(schema);
    const result = selectEconomyTools(tools, 'read package.json and explain it');
    expect(result.selected.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'clarify', 'plan_approval', 'file_read', 'tool_result_artifact_read',
    ]));
    expect(result.selected.length).toBeLessThan(tools.length);
    expect(result.estimatedSchemaSavings).toBeGreaterThan(0);
  });

  it('keeps Balanced behavior unchanged while reporting a shadow Economy set', () => {
    const tools = ['clarify', 'file_read', 'web_search', 'browser_click'].map(schema);
    const shadow = selectEconomyTools(tools, 'read a file');
    expect(tools.map((tool) => tool.name)).toEqual(['clarify', 'file_read', 'web_search', 'browser_click']);
    expect(shadow.deferredCount).toBeGreaterThan(0);
  });

  it('transitions token budgets at 80 and 100 percent', () => {
    expect(classifyBudgetState(0, null)).toBe('unbudgeted');
    expect(classifyBudgetState(79, 100)).toBe('running_green');
    expect(classifyBudgetState(80, 100)).toBe('running_yellow');
    expect(classifyBudgetState(100, 100)).toBe('running_red');
    expect(classifyBudgetState(101, 100)).toBe('over_budget_critical');
  });

  it('estimates without a provider call and keeps unknown pricing unknown', () => {
    const messages: Message[] = [{ role: 'user', content: 'inspect this repository and run tests' }];
    const result = estimateTaskUsage({
      task: messages[0].content,
      messages,
      tools: ['file_read', 'shell_exec'].map(schema),
      mode: 'balanced',
      tokenBudget: 20_000,
      pricing: null,
    });
    expect(result.complexity).toBe('medium');
    expect(result.estimatedTokenHigh).toBeGreaterThan(result.estimatedTokenLow);
    expect(result.estimatedCallsHigh).toBeGreaterThanOrEqual(result.estimatedCallsLow);
    expect(result.estimatedCostLow).toBeNull();
    expect(result.costStatus).toBe('unknown');
  });
});
