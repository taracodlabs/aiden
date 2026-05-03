import { describe, it, expect } from 'vitest';
import type {
  ApiMode,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
} from '../../providers/v4/types';

describe('v4 scaffolding', () => {
  it('ApiMode includes all 4 modes', () => {
    const modes: ApiMode[] = [
      'chat_completions',
      'anthropic_messages',
      'codex_responses',
      'ollama_prompt_tools',
    ];
    expect(modes).toHaveLength(4);
  });

  it('ProviderAdapter interface compiles', () => {
    const stub: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
        return {
          content: null,
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    expect(stub.apiMode).toBe('chat_completions');
  });
});
