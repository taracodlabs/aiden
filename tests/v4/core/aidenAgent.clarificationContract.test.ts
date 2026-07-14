import { describe, expect, it, vi } from 'vitest';
import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import type {
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ToolCallRequest,
} from '../../../providers/v4/types';

const usage = { inputTokens: 1, outputTokens: 1 };

function tools(...calls: ToolCallRequest[]): ProviderCallOutput {
  return { content: '', toolCalls: calls, usage, finishReason: 'tool_calls' };
}

function done(content = 'done'): ProviderCallOutput {
  return { content, toolCalls: [], usage, finishReason: 'stop' };
}

class ScriptedAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  constructor(private readonly outputs: ProviderCallOutput[]) {}
  async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
    const next = this.outputs.shift();
    if (!next) throw new Error('script exhausted');
    return next;
  }
}

const user = (content: string): Message => ({ role: 'user', content });

describe('cancelled required clarification contract', () => {
  it('blocks invented mutations until the user supplies or explicitly overrides the missing value', async () => {
    const adapter = new ScriptedAdapter([
      tools({
        id: 'clarify-1', name: 'clarify',
        arguments: { question: 'What topic should the Markdown report cover?' },
      }),
      tools({
        id: 'write-1', name: 'file_write',
        arguments: { path: 'report.md', content: 'invented topic' },
      }),
      done('I still need the topic.'),
      tools({
        id: 'write-2', name: 'file_write',
        arguments: { path: 'report.md', content: 'invented after create it' },
      }),
      done('I still need the topic.'),
      tools({
        id: 'write-3', name: 'file_write',
        arguments: { path: 'report.md', content: 'explicitly authorized default' },
      }),
      done('created'),
    ]);
    const executor = vi.fn<ToolExecutor>(async (call) => {
      if (call.name === 'clarify') {
        return {
          id: call.id,
          name: call.name,
          result: { ok: false, status: 'cancelled', answer: null },
        };
      }
      return { id: call.id, name: call.name, result: { ok: true } };
    });
    const agent = new AidenAgent({
      provider: adapter,
      tools: [],
      toolExecutor: executor,
      resolveMutates: (name) => name === 'file_write',
    });

    const first = await agent.runConversation([user('Create a Markdown report after asking for format and topic.')]);
    expect(executor.mock.calls.map(([call]) => call.name)).toEqual(['clarify']);
    expect(first.messages.some(
      (message) => message.role === 'tool' && message.content.includes('required clarification was cancelled'),
    )).toBe(true);

    const second = await agent.runConversation([user('create it')]);
    expect(executor.mock.calls.map(([call]) => call.name)).toEqual(['clarify']);
    expect(second.messages.some(
      (message) => message.role === 'tool' && message.content.includes('Do not invent the missing value'),
    )).toBe(true);

    await agent.runConversation([user('Use any topic; choose for me and proceed without asking again.')]);
    expect(executor.mock.calls.map(([call]) => call.name)).toEqual(['clarify', 'file_write']);
  });
});
