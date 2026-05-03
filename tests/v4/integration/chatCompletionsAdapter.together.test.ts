/**
 * Real-network integration test for ChatCompletionsAdapter against Together AI.
 *
 * Skips automatically when TOGETHER_API_KEY is not set, so CI without secrets
 * passes without reformatting anything.
 *
 * Cost discipline (paid tier; $10 sprint budget):
 *   - simple stop test: maxTokens=50
 *   - tool-calling test: maxTokens=200
 *   - both runs together should burn well under 3k tokens.
 * Do not add stress / load / repeated-run cases here.
 */
import { describe, it, expect } from 'vitest';
import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import type { ToolSchema } from '../../../providers/v4/types';

const TOGETHER_KEY = process.env.TOGETHER_API_KEY;
const TOGETHER_MODEL =
  process.env.TOGETHER_TEST_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

describe.skipIf(!TOGETHER_KEY)('ChatCompletionsAdapter — Together AI integration', () => {
  it('completes a simple conversation (no tools)', async () => {
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: TOGETHER_KEY!,
      model: TOGETHER_MODEL,
      providerName: 'together',
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
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: TOGETHER_KEY!,
      model: TOGETHER_MODEL,
      providerName: 'together',
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
        return {
          id: call.id,
          name: call.name,
          result: { now: '2026-05-03T15:00:00Z' },
        };
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
