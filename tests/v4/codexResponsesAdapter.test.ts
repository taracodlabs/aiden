import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexResponsesAdapter } from '../../providers/v4/codexResponsesAdapter';
import { ProviderError, ProviderRateLimitError } from '../../providers/v4/errors';
import type { Message } from '../../providers/v4/types';

function makeResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseOptions = {
  apiKey: 'sk-codex-test',
  model: 'gpt-5-codex',
  providerName: 'codex',
  maxRetries: 1,
};

const userMsg = (content: string): Message => ({ role: 'user', content });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CodexResponsesAdapter', () => {
  it('1. builds correct request body for /v1/responses (instructions, input items, flat tools)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
            status: 'completed',
          },
        ],
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
    const adapter = new CodexResponsesAdapter(baseOptions);
    await adapter.call({
      messages: [
        { role: 'system', content: 'you are codex' },
        userMsg('hi'),
      ],
      tools: [
        {
          name: 'echo',
          description: 'echoes',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
      maxTokens: 100,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5-codex');
    expect(body.instructions).toBe('you are codex');
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(100);
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'echo',
        description: 'echoes',
        strict: false,
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]);
  });

  it('2. parses simple text response', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello' }],
            status: 'completed',
          },
        ],
        status: 'completed',
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    );
    const result = await new CodexResponsesAdapter(baseOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.content).toBe('hello');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it('3. parses function_call output items', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        output: [
          {
            type: 'function_call',
            call_id: 'call_abc',
            id: 'fc_1',
            name: 'echo',
            arguments: '{"text":"hi"}',
            status: 'completed',
          },
        ],
        status: 'completed',
      }),
    );
    const result = await new CodexResponsesAdapter(baseOptions).call({
      messages: [userMsg('echo hi')],
      tools: [],
    });
    expect(result.toolCalls).toEqual([
      { id: 'call_abc', name: 'echo', arguments: { text: 'hi' } },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('4. malformed function_call arguments fall back to {} with warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        output: [
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'broken',
            arguments: '{ not json',
            status: 'completed',
          },
        ],
        status: 'completed',
      }),
    );
    const result = await new CodexResponsesAdapter(baseOptions).call({
      messages: [userMsg('q')],
      tools: [],
    });
    expect(result.toolCalls[0].arguments).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('5. empty output[] with output_text backfills a synthetic message', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        output: [],
        output_text: 'recovered text',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
    const result = await new CodexResponsesAdapter(baseOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.content).toBe('recovered text');
    expect(result.finishReason).toBe('stop');
  });

  it('6. status=incomplete with reason=max_output_tokens → finishReason=length', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'truncated...' }],
            status: 'incomplete',
          },
        ],
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    );
    const result = await new CodexResponsesAdapter(baseOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.finishReason).toBe('length');
  });

  it('7. status=failed throws ProviderError', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ output: [], status: 'failed' }));
    await expect(
      new CodexResponsesAdapter(baseOptions).call({ messages: [userMsg('hi')], tools: [] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('8. retries on 429 then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(makeResponse({ error: 'rate' }, { status: 429 }))
      .mockResolvedValueOnce(
        makeResponse({
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
              status: 'completed',
            },
          ],
          status: 'completed',
        }),
      );
    const adapter = new CodexResponsesAdapter({ ...baseOptions, maxRetries: 1 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('ok');
  });

  it('9. exhausted 429 throws ProviderRateLimitError', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse({ error: 'rate' }, { status: 429 }));
    const adapter = new CodexResponsesAdapter({ ...baseOptions, maxRetries: 1 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(promise).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it('10. 401 fails fast', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('unauthorized', { status: 401 }));
    await expect(
      new CodexResponsesAdapter(baseOptions).call({ messages: [userMsg('hi')], tools: [] }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('11. translates assistant tool_calls + tool replies into function_call / function_call_output items', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
            status: 'completed',
          },
        ],
        status: 'completed',
      }),
    );
    await new CodexResponsesAdapter(baseOptions).call({
      messages: [
        userMsg('q'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'hi' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'echoed' },
      ],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const types = body.input.map((it: { type: string }) => it.type);
    expect(types).toEqual(['message', 'function_call', 'function_call_output']);
    expect(body.input[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'echo',
      arguments: '{"text":"hi"}',
    });
    expect(body.input[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'echoed',
    });
  });

  it('12. captures cached_tokens into cacheReadTokens', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
            status: 'completed',
          },
        ],
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 5, cached_tokens: 80 },
      }),
    );
    const result = await new CodexResponsesAdapter(baseOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.usage.cacheReadTokens).toBe(80);
  });
});
