import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalPromptToolsAdapter } from '../../providers/v4/localPromptToolsAdapter';
import { ProviderError } from '../../providers/v4/errors';
import type { Message, ToolSchema } from '../../providers/v4/types';

function makeResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseOptions = {
  model: 'llama3.2',
  providerName: 'ollama',
};

const userMsg = (content: string): Message => ({ role: 'user', content });
const sysMsg = (content: string): Message => ({ role: 'system', content });

const tools: ToolSchema[] = [
  {
    name: 'get_time',
    description: 'returns current time',
    inputSchema: { type: 'object', properties: {} },
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LocalPromptToolsAdapter', () => {
  it('1. builds correct request body (no tools field, /api/chat, stream:false)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        message: { role: 'assistant', content: 'hi' },
        prompt_eval_count: 5,
        eval_count: 2,
        done: true,
      }),
    );
    await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama3.2');
    expect(body.stream).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('2. tool catalog injected into system message when tools provided', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ message: { role: 'assistant', content: 'ok' }, done: true }),
    );
    await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [sysMsg('be brief'), userMsg('hi')],
      tools,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('be brief');
    expect(body.messages[0].content).toContain('<tool_call>');
    expect(body.messages[0].content).toContain('get_time');
  });

  it('3. synthetic system message inserted when none in conversation but tools present', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ message: { role: 'assistant', content: 'ok' }, done: true }),
    );
    await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [userMsg('hi')],
      tools,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('get_time');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('4. parses single <tool_call> block', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        message: {
          role: 'assistant',
          content: 'thinking...\n<tool_call>{"name": "get_time", "arguments": {}}</tool_call>',
        },
        prompt_eval_count: 10,
        eval_count: 4,
        done: true,
      }),
    );
    const result = await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [userMsg('what time?')],
      tools,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('get_time');
    expect(result.toolCalls[0].arguments).toEqual({});
    expect(result.finishReason).toBe('tool_use');
    expect(result.content).toBe('thinking...');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it('5. parses multiple <tool_call> blocks in one response', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        message: {
          role: 'assistant',
          content:
            '<tool_call>{"name": "a", "arguments": {"x": 1}}</tool_call>\n' +
            '<tool_call>{"name": "b", "arguments": {"y": 2}}</tool_call>',
        },
        done: true,
      }),
    );
    const result = await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [userMsg('q')],
      tools,
    });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('a');
    expect(result.toolCalls[0].arguments).toEqual({ x: 1 });
    expect(result.toolCalls[1].name).toBe('b');
    expect(result.toolCalls[1].arguments).toEqual({ y: 2 });
  });

  it('6. malformed JSON inside <tool_call> block warns + skips, does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        message: {
          role: 'assistant',
          content:
            '<tool_call>{"name": "ok", "arguments": {}}</tool_call>\n' +
            '<tool_call>{not json}</tool_call>',
        },
        done: true,
      }),
    );
    const result = await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [userMsg('q')],
      tools,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('ok');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('7. no <tool_call> tags → content-only stop', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        message: { role: 'assistant', content: 'just a plain reply' },
        done: true,
      }),
    );
    const result = await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.content).toBe('just a plain reply');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
  });

  it('8. token usage maps prompt_eval_count → inputTokens, eval_count → outputTokens', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        message: { role: 'assistant', content: 'ok' },
        prompt_eval_count: 42,
        eval_count: 7,
        done: true,
      }),
    );
    const result = await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [userMsg('q')],
      tools: [],
    });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it('9. connection error → ProviderError with "Ollama not reachable"', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const adapter = new LocalPromptToolsAdapter({ ...baseOptions, maxRetries: 0 });
    await expect(adapter.call({ messages: [userMsg('hi')], tools: [] })).rejects.toThrow(
      /Ollama not reachable/,
    );
  });

  it('10. tool replies wrapped in <tool_response> as user messages', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ message: { role: 'assistant', content: 'done' }, done: true }),
    );
    await new LocalPromptToolsAdapter(baseOptions).call({
      messages: [
        userMsg('what time?'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'get_time', arguments: {} }],
        },
        { role: 'tool', toolCallId: 'tc1', content: '15:00' },
      ],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('<tool_response id="tc1">');
    expect(last.content).toContain('15:00');
    // Assistant prior tool_call re-serialized
    const assistantMsg = body.messages[body.messages.length - 2];
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toContain('<tool_call>');
    expect(assistantMsg.content).toContain('get_time');
  });

  it('11. timeout throws ProviderError (wrapping abort)', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const adapter = new LocalPromptToolsAdapter({
      ...baseOptions,
      timeoutMs: 10,
      maxRetries: 0,
    });
    await expect(adapter.call({ messages: [userMsg('hi')], tools: [] })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
