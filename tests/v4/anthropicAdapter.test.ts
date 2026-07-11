import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../providers/v4/anthropicAdapter';
import { ProviderError, ProviderRateLimitError } from '../../providers/v4/errors';
import type { Message, ToolSchema } from '../../providers/v4/types';

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

const apiKeyOptions = {
  apiKey: 'sk-ant-test',
  model: 'claude-haiku-4-5-20251001',
  providerName: 'anthropic',
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
  vi.restoreAllMocks();
});

describe('AnthropicAdapter', () => {
  it('1. builds correct request body (system separated, tools as input_schema)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
    const adapter = new AnthropicAdapter(apiKeyOptions);
    const tools: ToolSchema[] = [
      {
        name: 'echo',
        description: 'echoes',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ];

    await adapter.call({
      messages: [
        { role: 'system', content: 'be brief' },
        userMsg('hello'),
      ],
      tools,
      maxTokens: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toBe('be brief');
    expect(body.max_tokens).toBe(50);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.tools).toEqual([
      {
        name: 'echo',
        description: 'echoes',
        input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('2. API key mode sends x-api-key header + honest Aiden identity (no impersonation fingerprint)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // The API-key path must carry an honest Aiden identity — no billing
    // fingerprint (`x-app: cli`) and an honest aiden/<version> user-agent.
    expect(headers['x-app']).toBeUndefined();
    expect(headers['user-agent']).toMatch(/^aiden\//);
  });

  it('3. sends NO anthropic-beta header', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('4. keeps system as a flat string (no identity block array)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({
      messages: [{ role: 'system', content: 'be brief' }, userMsg('hi')],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(typeof body.system).toBe('string');
    expect(body.system).toBe('be brief');
  });

  it('4b. does NOT rewrite Aiden/Taracod identity in the system prompt', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({
      messages: [{ role: 'system', content: 'You are Aiden, built by Taracod.' }, userMsg('hi')],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Equality to the caller's exact prompt proves no identity rewrite ran.
    expect(body.system).toBe('You are Aiden, built by Taracod.');
  });

  it('5. keeps tool names raw (no mcp_ prefix on the wire)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    const tools: ToolSchema[] = [
      {
        name: 'web_search',
        description: 'searches',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    await new AnthropicAdapter(apiKeyOptions).call({ messages: [userMsg('hi')], tools });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools[0].name).toBe('web_search');
  });

  it('6. parses simple text response', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'hello world' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.content).toBe('hello world');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it('7. parses tool_use response', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('echo hi')],
      tools: [],
    });
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'echo', arguments: { text: 'hi' } },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('8. parses mixed text + tool_use blocks', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 't1', name: 'lookup', input: {} },
          { type: 'text', text: '...' },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('q')],
      tools: [],
    });
    expect(result.content).toBe('let me check\n...');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.finishReason).toBe('tool_use');
  });

  it('9. empty content[] with stop_reason=end_turn returns content="" and stop (does NOT throw)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 0 } }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
  });

  it('10. maps stop_reason: end_turn → stop, max_tokens → length, stop_sequence → stop', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ content: [{ type: 'text', text: 'a' }], stop_reason: 'max_tokens' }),
      )
      .mockResolvedValueOnce(
        makeResponse({ content: [{ type: 'text', text: 'b' }], stop_reason: 'stop_sequence' }),
      );
    const adapter = new AnthropicAdapter({ ...apiKeyOptions, maxRetries: 0 });
    const r1 = await adapter.call({ messages: [userMsg('1')], tools: [] });
    const r2 = await adapter.call({ messages: [userMsg('2')], tools: [] });
    expect(r1.finishReason).toBe('length');
    expect(r2.finishReason).toBe('stop');
  });

  it('11. captures cache_creation_input_tokens / cache_read_input_tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 1000,
        },
      }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
    });
  });

  it('12. translates tool reply messages into tool_result content blocks', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({
      messages: [
        userMsg('echo hi'),
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'echo', arguments: { text: 'hi' } }] },
        { role: 'tool', toolCallId: 'tc1', content: 'echoed: hi' },
      ],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Tool reply should be folded into a user message as a tool_result block.
    const lastMsg = body.messages[body.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(Array.isArray(lastMsg.content)).toBe(true);
    expect(lastMsg.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tc1',
      content: 'echoed: hi',
    });
  });

  it('13. echoes assistant tool_use history with raw (unprefixed) tool names', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({
      messages: [
        userMsg('search'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'web_search', arguments: { q: 'x' } }],
        },
        { role: 'tool', toolCallId: 'tc1', content: 'result' },
      ],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
    const toolUseBlock = assistantMsg.content.find((b: any) => b.type === 'tool_use');
    expect(toolUseBlock.name).toBe('web_search');
  });

  it('14. retries on 429 with backoff then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(makeResponse({ error: 'rate' }, { status: 429 }))
      .mockResolvedValueOnce(
        makeResponse({ content: [{ type: 'text', text: 'finally' }], stop_reason: 'end_turn' }),
      );
    const adapter = new AnthropicAdapter({ ...apiKeyOptions, maxRetries: 1 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('finally');
  });

  it('15. exhausted retries on 429 throws ProviderRateLimitError', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse({ error: 'rate' }, { status: 429 }));
    const adapter = new AnthropicAdapter({ ...apiKeyOptions, maxRetries: 1 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });
    promise.catch(() => undefined); // suppress unhandled
    await vi.advanceTimersByTimeAsync(2500);
    await expect(promise).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('16. 401 fails fast, no retry', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('unauthorized', { status: 401 }));
    const adapter = new AnthropicAdapter({ ...apiKeyOptions, maxRetries: 2 });
    await expect(adapter.call({ messages: [userMsg('hi')], tools: [] })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AnthropicAdapter — image content (B2.2a)', () => {
  it('maps user images to base64 image blocks alongside the text block', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'a red square' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 } }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({
      messages: [{ role: 'user', content: 'what is in this image?', images: ['data:image/png;base64,iVBORabc'] }],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORabc' } },
      ],
    }]);
  });

  it('text-only user message is UNCHANGED (string content — backward-compatible)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({ messages: [userMsg('plain text')], tools: [] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([{ role: 'user', content: 'plain text' }]);
  });
});
