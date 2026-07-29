import { describe, it, expect, vi } from 'vitest';
import {
  AidenAgent,
  FallbackStrategy,
  ToolExecutor,
} from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import {
  Message,
  ToolCallRequest,
  ToolCallResult,
  ToolSchema,
  ProviderAdapter,
} from '../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];

const okExecutor: ToolExecutor = async (call) => ({
  id: call.id,
  name: call.name,
  result: { ok: true, echoed: call.arguments },
});

const userMsg = (content: string): Message => ({ role: 'user', content });

const tc = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({
  id,
  name,
  arguments: args,
});

describe('AidenAgent.runConversation', () => {
  it('1. happy path — single turn, no tool calls', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hello world'),
    ]);
    const agent = new AidenAgent({ provider, toolExecutor: okExecutor, tools: NO_TOOLS });

    const result = await agent.runConversation([userMsg('hi')]);

    expect(result.finalContent).toBe('hello world');
    expect(result.turnCount).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.fallbackActivated).toBe(false);
    expect(result.finishReason).toBe('stop');
    expect(result.messages).toHaveLength(2); // user, assistant
    expect(result.messages[1]).toEqual({ role: 'assistant', content: 'hello world' });
    expect(provider.capturedInputs).toHaveLength(1);
  });

  it('2. one tool call, then response — message history shape is correct', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('call_1', 'echo', { x: 1 })]),
      MockProviderAdapter.stop('done'),
    ]);
    const agent = new AidenAgent({ provider, toolExecutor: okExecutor, tools: NO_TOOLS });

    const result = await agent.runConversation([userMsg('go')]);

    expect(result.toolCallCount).toBe(1);
    expect(result.turnCount).toBe(2);
    expect(result.messages).toHaveLength(4); // user, assistant(tool_use), tool, assistant(final)
    expect(result.messages[0]).toEqual({ role: 'user', content: 'go' });
    expect(result.messages[1].role).toBe('assistant');
    expect((result.messages[1] as { toolCalls?: ToolCallRequest[] }).toolCalls).toHaveLength(1);
    expect(result.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    expect(result.messages[3]).toEqual({ role: 'assistant', content: 'done' });

    // Critical: the second provider call saw the tool result in its input.
    expect(provider.capturedInputs).toHaveLength(2);
    expect(provider.capturedInputs[1].messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('3. sequential tool chain — each result appended before next provider call', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('a', 'first')]),
      MockProviderAdapter.toolUse([tc('b', 'second')]),
      MockProviderAdapter.stop('finished'),
    ]);
    const agent = new AidenAgent({ provider, toolExecutor: okExecutor, tools: NO_TOOLS });

    const result = await agent.runConversation([userMsg('chain')]);

    expect(result.toolCallCount).toBe(2);
    expect(result.turnCount).toBe(3);
    expect(provider.capturedInputs).toHaveLength(3);
    expect(provider.capturedInputs[1].messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(provider.capturedInputs[2].messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(result.finalContent).toBe('finished');
  });

  it('4. tool error handled — error populated, loop continues', async () => {
    const throwingExecutor: ToolExecutor = async () => {
      throw new Error('boom');
    };
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('x', 'broken')]),
      MockProviderAdapter.stop('I saw the error'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: throwingExecutor,
      tools: NO_TOOLS,
    });

    const result = await agent.runConversation([userMsg('try')]);

    expect(result.finishReason).toBe('stop');
    expect(result.finalContent).toBe('I saw the error');
    const toolMsg = result.messages.find((m) => m.role === 'tool') as { content: string };
    expect(toolMsg.content).toContain('boom');
  });

  it('5. multiple tool calls in one turn — both run, both results appended', async () => {
    const seen: string[] = [];
    const recordingExecutor: ToolExecutor = async (call) => {
      seen.push(call.id);
      return { id: call.id, name: call.name, result: `ran:${call.id}` };
    };
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('p', 'one'), tc('q', 'two')]),
      MockProviderAdapter.stop('both done'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: recordingExecutor,
      tools: NO_TOOLS,
    });

    const result = await agent.runConversation([userMsg('parallel-ish')]);

    expect(seen).toEqual(['p', 'q']);
    expect(result.toolCallCount).toBe(2);
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    // Provider call #2 must see BOTH tool results in its input.
    const secondInputToolMsgs = provider.capturedInputs[1].messages.filter((m) => m.role === 'tool');
    expect(secondInputToolMsgs).toHaveLength(2);
  });

  it('6. budget exhaustion — terminates with budget_exhausted', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('1', 't')]),
      MockProviderAdapter.toolUse([tc('2', 't')]),
      MockProviderAdapter.toolUse([tc('3', 't')]),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      maxTurns: 3,
    });

    const result = await agent.runConversation([userMsg('forever')]);

    expect(result.finishReason).toBe('budget_exhausted');
    expect(result.turnCount).toBe(3);
    expect(result.toolCallCount).toBe(3);
  });

  it('7. budget warning fires at 70% (caution)', async () => {
    const responses = Array.from({ length: 6 }, (_, i) =>
      MockProviderAdapter.toolUse([tc(`${i}`, 't')]),
    );
    responses.push(MockProviderAdapter.stop('finally'));

    const provider = new MockProviderAdapter(responses);
    const onBudgetWarning = vi.fn();
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      maxTurns: 10,
      onBudgetWarning,
    });

    await agent.runConversation([userMsg('go')]);

    // 7 turns ran. 70% of 10 = 7. Caution should fire exactly once at turn 7. Warning (90%=9) should NOT fire.
    expect(onBudgetWarning).toHaveBeenCalledTimes(1);
    expect(onBudgetWarning).toHaveBeenCalledWith('caution', 7, 10);
  });

  it('8. budget warning fires at 90% (warning) after caution at 70%', async () => {
    const responses = Array.from({ length: 8 }, (_, i) =>
      MockProviderAdapter.toolUse([tc(`${i}`, 't')]),
    );
    responses.push(MockProviderAdapter.stop('done'));

    const provider = new MockProviderAdapter(responses);
    const onBudgetWarning = vi.fn();
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      maxTurns: 10,
      onBudgetWarning,
    });

    await agent.runConversation([userMsg('go')]);

    // 9 turns ran (8 tool_use + 1 stop). caution at 7, warning at 9 → 2 calls.
    expect(onBudgetWarning).toHaveBeenCalledTimes(2);
    expect(onBudgetWarning).toHaveBeenNthCalledWith(1, 'caution', 7, 10);
    expect(onBudgetWarning).toHaveBeenNthCalledWith(2, 'warning', 9, 10);
  });

  it('9. fallback activates on provider error — loop continues with new adapter', async () => {
    const failingProvider: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        throw new Error('primary down');
      },
    };
    const fallbackProvider = new MockProviderAdapter([
      MockProviderAdapter.stop('hello from fallback'),
    ]);
    const fallback: FallbackStrategy = {
      activate: vi.fn(async () => fallbackProvider),
    };
    const agent = new AidenAgent({
      provider: failingProvider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      fallback,
    });

    const result = await agent.runConversation([userMsg('hi')]);

    expect(result.fallbackActivated).toBe(true);
    expect(result.finalContent).toBe('hello from fallback');
    expect(fallback.activate).toHaveBeenCalledTimes(1);
  });

  it('10. fallback returns null — error propagates', async () => {
    const original = new Error('primary down hard');
    const failingProvider: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        throw original;
      },
    };
    const fallback: FallbackStrategy = {
      activate: async () => null,
    };
    const agent = new AidenAgent({
      provider: failingProvider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      fallback,
    });

    await expect(agent.runConversation([userMsg('hi')])).rejects.toThrow('primary down hard');
  });

  it('11. onToolCall fires before and after with correct args', async () => {
    const events: Array<{ phase: string; id: string; result?: ToolCallResult }> = [];
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('only', 'thing', { k: 'v' })]),
      MockProviderAdapter.stop('ok'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      onToolCall: (call, phase, result) => {
        events.push({ phase, id: call.id, result });
      },
    });

    await agent.runConversation([userMsg('go')]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: 'before', id: 'only', result: undefined });
    expect(events[1].phase).toBe('after');
    expect(events[1].id).toBe('only');
    expect(events[1].result).toBeDefined();
    expect(events[1].result!.id).toBe('only');
  });

  it('12. total usage accumulates across turns', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('1', 't')], { inputTokens: 100, outputTokens: 50 }),
      MockProviderAdapter.toolUse([tc('2', 't')], { inputTokens: 200, outputTokens: 30 }),
      MockProviderAdapter.stop('done', { inputTokens: 300, outputTokens: 20 }),
    ]);
    const agent = new AidenAgent({ provider, toolExecutor: okExecutor, tools: NO_TOOLS });

    const result = await agent.runConversation([userMsg('go')]);

    expect(result.totalUsage.inputTokens).toBe(600);
    expect(result.totalUsage.outputTokens).toBe(100);
  });
});
