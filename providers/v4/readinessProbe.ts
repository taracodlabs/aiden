import type {
  Message,
  ProviderAdapter,
  ToolSchema,
} from './types';
import {
  classifyReadinessError,
  ProviderReadinessError,
  type ProviderReadinessErrorCategory,
} from './readinessErrors';

export interface RuntimeReadinessProbeResult {
  plainCompletion: 'verified' | 'failed';
  streaming: 'verified' | 'failed';
  toolCall: 'verified' | 'failed';
  toolResultReplay: 'verified' | 'failed';
  structuredArguments: 'verified' | 'failed';
  errorCategory?: ProviderReadinessErrorCategory;
}

const failedAfterPlain = (
  errorCategory: ProviderReadinessErrorCategory,
  streaming: 'verified' | 'failed',
): RuntimeReadinessProbeResult => ({
  plainCompletion: 'verified',
  streaming,
  toolCall: 'failed',
  toolResultReplay: 'failed',
  structuredArguments: 'failed',
  errorCategory,
});

const PROBE_TOOL: ToolSchema = {
  name: 'runtime_readiness_probe',
  description: 'Return the supplied marker without side effects.',
  inputSchema: {
    type: 'object',
    properties: { marker: { type: 'string', enum: ['ready'] } },
    required: ['marker'],
    additionalProperties: false,
  },
};

function exactProbeCall(output: Awaited<ReturnType<ProviderAdapter['call']>>) {
  if (output.toolCalls.length !== 1 || output.toolCalls[0].name !== PROBE_TOOL.name) {
    throw new ProviderReadinessError(
      'tool_call_unsupported',
      'The model did not request the required readiness tool.',
      false,
    );
  }
  const call = output.toolCalls[0];
  if (call.arguments.marker !== 'ready' || Object.keys(call.arguments).some((key) => key !== 'marker')) {
    throw new ProviderReadinessError(
      'tool_schema_rejected',
      'The model produced invalid readiness tool arguments.',
      false,
    );
  }
  return call;
}

function requiredToolBody(adapter: ProviderAdapter): Record<string, unknown> | undefined {
  switch (adapter.apiMode) {
    case 'chat_completions':
      return { tool_choice: 'required' };
    case 'anthropic_messages':
      return { tool_choice: { type: 'tool', name: PROBE_TOOL.name } };
    case 'codex_responses':
      return { tool_choice: { type: 'function', name: PROBE_TOOL.name } };
    case 'ollama_prompt_tools':
      return undefined;
  }
}

export async function verifyRuntimeReadiness(
  adapter: ProviderAdapter,
  options: { signal?: AbortSignal; maxTokens?: number } = {},
): Promise<RuntimeReadinessProbeResult> {
  const maxTokens = options.maxTokens ?? 128;
  try {
    const plain = await adapter.call({
      messages: [{ role: 'user', content: 'Reply with exactly READY.' }],
      tools: [],
      maxTokens,
      signal: options.signal,
    });
    if (plain.finishReason !== 'stop' || !plain.content?.trim()) {
      throw new ProviderReadinessError('malformed_response', 'The plain completion did not finish with text.', true);
    }
  } catch (error) {
    const classified = classifyReadinessError(error, 'plain');
    return {
      plainCompletion: 'failed',
      streaming: 'failed',
      toolCall: 'failed',
      toolResultReplay: 'failed',
      structuredArguments: 'failed',
      errorCategory: classified.category,
    };
  }

  if (!adapter.callStream) {
    return failedAfterPlain('streaming_unsupported', 'failed');
  }
  try {
    let completed = false;
    let content = '';
    for await (const event of adapter.callStream({
      messages: [{ role: 'user', content: 'Reply with exactly STREAM READY.' }],
      tools: [],
      maxTokens,
      signal: options.signal,
    })) {
      if (event.type === 'delta') content += event.content;
      if (event.type === 'done') {
        completed = event.output.finishReason === 'stop';
        content = event.output.content ?? content;
      }
    }
    if (!completed || !content.trim()) {
      throw new ProviderReadinessError(
        'streaming_unsupported',
        'The provider did not complete a streamed response.',
        false,
      );
    }
  } catch (error) {
    const classified = classifyReadinessError(error, 'streaming');
    return failedAfterPlain(
      classified.category === 'unknown_provider_error' ? 'streaming_unsupported' : classified.category,
      'failed',
    );
  }

  let structuredArguments: 'verified' | 'failed' = 'failed';
  let toolCall: 'verified' | 'failed' = 'failed';
  try {
    const messages: Message[] = [{
      role: 'user',
      content: 'Call runtime_readiness_probe exactly once with JSON arguments {"marker":"ready"}. After its result, reply exactly PROBE COMPLETE.',
    }];
    let first;
    try {
      first = await adapter.call({
        messages,
        tools: [PROBE_TOOL],
        maxTokens,
        extraBody: requiredToolBody(adapter),
        signal: options.signal,
      });
    } catch (error) {
      throw classifyReadinessError(error, 'tool_schema');
    }
    const call = exactProbeCall(first);
    structuredArguments = 'verified';
    toolCall = 'verified';
    const replay: Message[] = [
      ...messages,
      { role: 'assistant', content: first.content ?? '', toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: call.id, content: JSON.stringify({ ok: true, marker: 'ready' }) },
    ];
    const final = await adapter.call({
      messages: replay,
      tools: [PROBE_TOOL],
      maxTokens,
      signal: options.signal,
    });
    if (final.toolCalls.length > 0 || final.finishReason !== 'stop' || !final.content?.trim()) {
      throw new ProviderReadinessError('malformed_response', 'The model did not finish after the readiness tool result.', true);
    }
    return {
      plainCompletion: 'verified',
      streaming: 'verified',
      toolCall: 'verified',
      toolResultReplay: 'verified',
      structuredArguments: 'verified',
    };
  } catch (error) {
    const classified = classifyReadinessError(error, 'tool_cycle');
    const category = toolCall === 'verified'
      && structuredArguments === 'verified'
      && classified.category === 'unknown_provider_error'
      ? 'tool_replay_unsupported'
      : classified.category;
    return {
      plainCompletion: 'verified',
      streaming: 'verified',
      toolCall,
      toolResultReplay: 'failed',
      structuredArguments,
      errorCategory: category,
    };
  }
}
