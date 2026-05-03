/**
 * Real-network integration test for AnthropicAdapter.
 *
 * Skips automatically when ANTHROPIC_API_KEY is not set.
 *
 * Cost discipline: claude-haiku-4-5-20251001 is the cheapest current Claude
 * model. simple-stop test caps at maxTokens=50, tool-calling test at 200.
 * Combined run should burn well under 3k tokens.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../../providers/v4/anthropicAdapter';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import type { ToolSchema } from '../../../providers/v4/types';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_TEST_MODEL || 'claude-haiku-4-5-20251001';

describe.skipIf(!ANTHROPIC_KEY)('AnthropicAdapter — real Anthropic integration', () => {
  it('completes a simple conversation (no tools)', async () => {
    const adapter = new AnthropicAdapter({
      apiKey: ANTHROPIC_KEY!,
      authMode: 'api_key',
      model: ANTHROPIC_MODEL,
      providerName: 'anthropic',
    });

    const result = await adapter.call({
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      tools: [],
      maxTokens: 50,
    });

    expect(result.finishReason).toBe('stop');
    expect(result.content ?? '').toContain('PONG');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  }, 30_000);

  it('completes a tool-calling conversation end-to-end via AidenAgent', async () => {
    const adapter = new AnthropicAdapter({
      apiKey: ANTHROPIC_KEY!,
      authMode: 'api_key',
      model: ANTHROPIC_MODEL,
      providerName: 'anthropic',
    });

    const tools: ToolSchema[] = [
      {
        name: 'get_current_time',
        description: 'Returns the current time as an ISO 8601 string',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    let toolWasCalled = false;
    const agent = new AidenAgent({
      provider: adapter,
      tools,
      toolExecutor: async (call) => {
        toolWasCalled = true;
        return { id: call.id, name: call.name, result: { now: '2026-05-03T15:00:00Z' } };
      },
      maxTurns: 5,
    });

    const result = await agent.runConversation([
      { role: 'system', content: 'You are a helpful assistant. Use tools when needed.' },
      { role: 'user', content: 'What is the current time? Use the get_current_time tool.' },
    ]);

    expect(toolWasCalled).toBe(true);
    expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(result.finishReason).toBe('stop');
    expect(result.finalContent).toMatch(/2026-05-03|15:00/);
  }, 60_000);
});
