import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderCallOutput } from '../../../providers/v4/types';
import { verifyRuntimeReadiness } from '../../../providers/v4/readinessProbe';

const output = (overrides: Partial<ProviderCallOutput> = {}): ProviderCallOutput => ({
  content: 'READY',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
  ...overrides,
});

function adapter(replies: ProviderCallOutput[]): ProviderAdapter {
  let index = 0;
  return {
    apiMode: 'chat_completions',
    call: async () => replies[index++],
    async *callStream() {
      yield { type: 'delta', content: 'STREAM READY' };
      yield { type: 'done', output: output({ content: 'STREAM READY' }) };
    },
  };
}

describe('production runtime readiness probe', () => {
  it('requires a complete harmless tool cycle', async () => {
    const result = await verifyRuntimeReadiness(adapter([
      output(),
      output({ content: null, toolCalls: [{ id: 'tc-1', name: 'runtime_readiness_probe', arguments: { marker: 'ready' } }], finishReason: 'tool_use' }),
      output({ content: 'Probe complete.' }),
    ]));
    expect(result).toEqual({
      plainCompletion: 'verified',
      streaming: 'verified',
      toolCall: 'verified',
      toolResultReplay: 'verified',
      structuredArguments: 'verified',
    });
  });

  it('uses a constrained schema and enough output budget for hosted reasoning models', async () => {
    const inputs: any[] = [];
    let index = 0;
    const replies = [
      output(),
      output({ content: null, toolCalls: [{ id: 'tc-1', name: 'runtime_readiness_probe', arguments: { marker: 'ready' } }], finishReason: 'tool_use' }),
      output({ content: 'PROBE COMPLETE' }),
    ];
    await verifyRuntimeReadiness({
      apiMode: 'chat_completions',
      call: async (input) => {
        inputs.push(input);
        return replies[index++];
      },
      async *callStream() {
        yield { type: 'done', output: output({ content: 'STREAM READY' }) };
      },
    });

    expect(inputs[1].maxTokens).toBeGreaterThanOrEqual(128);
    expect(inputs[1].messages[0].content).toContain('After its result');
    expect(inputs[1].tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { marker: { type: 'string', enum: ['ready'] } },
      required: ['marker'],
      additionalProperties: false,
    });
  });

  it('distinguishes plain completion from missing tool emission', async () => {
    const result = await verifyRuntimeReadiness(adapter([output(), output({ content: 'I will not call it.' })]));
    expect(result).toEqual({
      plainCompletion: 'verified',
      streaming: 'verified',
      toolCall: 'failed',
      toolResultReplay: 'failed',
      structuredArguments: 'failed',
      errorCategory: 'tool_call_unsupported',
    });
  });

  it('does not report readiness when streaming is unavailable', async () => {
    const current: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => output(),
    };
    const result = await verifyRuntimeReadiness(current);
    expect(result).toEqual({
      plainCompletion: 'verified',
      streaming: 'failed',
      toolCall: 'failed',
      toolResultReplay: 'failed',
      structuredArguments: 'failed',
      errorCategory: 'streaming_unsupported',
    });
  });

  it('rejects malformed tool arguments', async () => {
    const result = await verifyRuntimeReadiness(adapter([
      output(),
      output({ content: null, toolCalls: [{ id: 'tc-1', name: 'runtime_readiness_probe', arguments: { marker: 'wrong' } }], finishReason: 'tool_use' }),
    ]));
    expect(result.errorCategory).toBe('tool_schema_rejected');
  });

  it('fails when the final response after execution does not complete', async () => {
    const result = await verifyRuntimeReadiness(adapter([
      output(),
      output({ content: null, toolCalls: [{ id: 'tc-1', name: 'runtime_readiness_probe', arguments: { marker: 'ready' } }], finishReason: 'tool_use' }),
      output({ content: '', finishReason: 'error' }),
    ]));
    expect(result.errorCategory).toBe('malformed_response');
  });

  it.each([
    ['chat_completions', 'required'],
    ['anthropic_messages', { type: 'tool', name: 'runtime_readiness_probe' }],
    ['codex_responses', { type: 'function', name: 'runtime_readiness_probe' }],
    ['ollama_prompt_tools', undefined],
  ] as const)('uses the required-tool form for %s', async (apiMode, toolChoice) => {
    const inputs: unknown[] = [];
    let index = 0;
    const replies = [
      output(),
      output({ content: null, toolCalls: [{ id: 'tc-1', name: 'runtime_readiness_probe', arguments: { marker: 'ready' } }], finishReason: 'tool_use' }),
      output({ content: 'Probe complete.' }),
    ];
    const current: ProviderAdapter = {
      apiMode,
      call: async (input) => {
        inputs.push(input);
        return replies[index++];
      },
      async *callStream() {
        yield { type: 'done', output: output({ content: 'STREAM READY' }) };
      },
    };
    await verifyRuntimeReadiness(current);
    expect((inputs[1] as { extraBody?: { tool_choice?: unknown } }).extraBody?.tool_choice).toEqual(toolChoice);
  });
});
