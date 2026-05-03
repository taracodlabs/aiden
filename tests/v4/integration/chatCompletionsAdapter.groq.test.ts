/**
 * Real-network integration test for ChatCompletionsAdapter against Groq.
 *
 * Skips automatically when neither GROQ_API_KEY nor GROQ_API_KEY_1 is set,
 * so CI without secrets passes without reformatting anything.
 *
 * This is the moment-of-truth test: AidenAgent's loop driving a real LLM
 * end-to-end with a real tool call.
 */
import { describe, it, expect } from 'vitest';
import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import type { ToolSchema } from '../../../providers/v4/types';

const GROQ_KEY = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_1;
const GROQ_MODEL = process.env.GROQ_TEST_MODEL || 'llama-3.3-70b-versatile';

describe.skipIf(!GROQ_KEY)('ChatCompletionsAdapter — Groq integration', () => {
  it('completes a simple conversation (no tools)', async () => {
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: GROQ_KEY!,
      model: GROQ_MODEL,
      providerName: 'groq',
    });

    const result = await adapter.call({
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      tools: [],
      maxTokens: 20,
    });

    expect(result.finishReason).toBe('stop');
    expect(result.content ?? '').toContain('PONG');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  }, 30_000);

  it('completes a tool-calling conversation end-to-end via AidenAgent', async () => {
    const adapter = new ChatCompletionsAdapter({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: GROQ_KEY!,
      model: GROQ_MODEL,
      providerName: 'groq',
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
