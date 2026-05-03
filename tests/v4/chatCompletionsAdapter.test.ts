import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatCompletionsAdapter } from '../../providers/v4/chatCompletionsAdapter';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '../../providers/v4/errors';
import type { Message, ToolSchema } from '../../providers/v4/types';

// Build an OpenAI-style chat completions response payload.
function makeResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  const status = init.status ?? 200;
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

const stopResponse = (content: string) => ({
  choices: [
    {
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const toolCallResponse = (toolCalls: Array<{ id: string; name: string; argumentsJson: string }>) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsJson },
        })),
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 8 },
});

const baseOptions = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  providerName: 'test-provider',
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

describe('ChatCompletionsAdapter', () => {
  it('1. builds correct request body (URL, headers, JSON shape)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(stopResponse('hi')));
    const adapter = new ChatCompletionsAdapter(baseOptions);

    const tools: ToolSchema[] = [
      {
        name: 'echo',
        description: 'echoes',
        inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      },
    ];

    await adapter.call({ messages: [userMsg('go')], tools });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer sk-test');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([{ role: 'user', content: 'go' }]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'echo',
          description: 'echoes',
          parameters: { type: 'object', properties: { x: { type: 'string' } } },
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('2. parses simple stop response', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(stopResponse('hello')));
    const adapter = new ChatCompletionsAdapter(baseOptions);

    const out = await adapter.call({ messages: [userMsg('hi')], tools: [] });

    expect(out.content).toBe('hello');
    expect(out.toolCalls).toEqual([]);
    expect(out.finishReason).toBe('stop');
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('3. parses tool_calls response (single call)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(toolCallResponse([{ id: 'call_1', name: 'get_time', argumentsJson: '{}' }])),
    );
    const adapter = new ChatCompletionsAdapter(baseOptions);

    const out = await adapter.call({ messages: [userMsg('go')], tools: [] });

    expect(out.content).toBeNull();
    expect(out.finishReason).toBe('tool_use');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toEqual({ id: 'call_1', name: 'get_time', arguments: {} });
  });

  it('4. parses multiple tool_calls in one response', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        toolCallResponse([
          { id: 'a', name: 'one', argumentsJson: '{"x":1}' },
          { id: 'b', name: 'two', argumentsJson: '{"y":"hi"}' },
        ]),
      ),
    );
    const adapter = new ChatCompletionsAdapter(baseOptions);

    const out = await adapter.call({ messages: [userMsg('go')], tools: [] });

    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls[0].arguments).toEqual({ x: 1 });
    expect(out.toolCalls[1].arguments).toEqual({ y: 'hi' });
  });

  it('5. malformed tool args fall back to {} and warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        toolCallResponse([{ id: 'x', name: 'broken', argumentsJson: 'not valid json' }]),
      ),
    );
    const adapter = new ChatCompletionsAdapter(baseOptions);

    const out = await adapter.call({ messages: [userMsg('go')], tools: [] });

    expect(out.toolCalls[0].arguments).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('6. translates message roles correctly (system/user/assistant+toolCalls/tool/user)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(stopResponse('done')));
    const adapter = new ChatCompletionsAdapter(baseOptions);

    const messages: Message[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'fn', arguments: { a: 1 } }],
      },
      { role: 'tool', toolCallId: 'tc1', content: 'result-data' },
      { role: 'user', content: 'q2' },
    ];

    await adapter.call({ messages, tools: [] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'fn', arguments: '{"a":1}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tc1', content: 'result-data' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('7. multiple system messages get concatenated into one', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(stopResponse('ok')));
    const adapter = new ChatCompletionsAdapter(baseOptions);

    const messages: Message[] = [
      { role: 'system', content: 'rule A' },
      { role: 'system', content: 'rule B' },
      { role: 'user', content: 'go' },
    ];

    await adapter.call({ messages, tools: [] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages.filter((m: Message) => m.role === 'system')).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'rule A\n\nrule B' });
  });

  it('8. retries on HTTP 429 then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(makeResponse('rate limited', { status: 429 }))
      .mockResolvedValueOnce(makeResponse('rate limited', { status: 429 }))
      .mockResolvedValueOnce(makeResponse(stopResponse('finally')));

    const adapter = new ChatCompletionsAdapter({ ...baseOptions, maxRetries: 2 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });

    await vi.advanceTimersByTimeAsync(5000);
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.content).toBe('finally');
  });

  it('9. throws ProviderRateLimitError after retries exhausted on 429', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse('rate limited', { status: 429 }));

    const adapter = new ChatCompletionsAdapter({ ...baseOptions, maxRetries: 2 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });
    promise.catch(() => {}); // silence unhandled rejection warning

    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('10. retries on HTTP 500 then throws ProviderError', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse('server error', { status: 500 }));

    const adapter = new ChatCompletionsAdapter({ ...baseOptions, maxRetries: 2 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).rejects.toMatchObject({
      name: 'ProviderError',
      statusCode: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('11. HTTP 401 does NOT retry; throws ProviderError immediately', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('unauthorized', { status: 401 }));

    const adapter = new ChatCompletionsAdapter({ ...baseOptions, maxRetries: 2 });

    await expect(adapter.call({ messages: [userMsg('hi')], tools: [] })).rejects.toMatchObject({
      name: 'ProviderError',
      statusCode: 401,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('12. timeout throws ProviderTimeoutError', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Honor the abort signal so AbortController can fire ProviderTimeoutError.
          const signal = init.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const adapter = new ChatCompletionsAdapter({
      ...baseOptions,
      timeoutMs: 50,
      maxRetries: 0,
    });

    await expect(
      adapter.call({ messages: [userMsg('hi')], tools: [] }),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  }, 5000);

  it('13. usage tokens map prompt_tokens/completion_tokens → input/output', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cache_read_input_tokens: 30,
        },
      }),
    );

    const adapter = new ChatCompletionsAdapter(baseOptions);
    const out = await adapter.call({ messages: [userMsg('hi')], tools: [] });

    expect(out.usage.inputTokens).toBe(100);
    expect(out.usage.outputTokens).toBe(50);
    expect(out.usage.cacheReadTokens).toBe(30);
  });

  it('14. extraHeaders are sent with the request', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(stopResponse('ok')));

    const adapter = new ChatCompletionsAdapter({
      ...baseOptions,
      extraHeaders: {
        'HTTP-Referer': 'https://aiden.taracod.com',
        'X-Title': 'Aiden',
      },
    });

    await adapter.call({ messages: [userMsg('hi')], tools: [] });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['HTTP-Referer']).toBe('https://aiden.taracod.com');
    expect(headers['X-Title']).toBe('Aiden');
    // Standard headers still present.
    expect(headers.Authorization).toBe('Bearer sk-test');
  });
});
