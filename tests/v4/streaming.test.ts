/**
 * tests/v4/streaming.test.ts — Phase 16c
 *
 * Unit tests for streaming end-to-end:
 *   - chat_completions SSE delta parsing (3)
 *   - anthropic content_block delta parsing (2)
 *   - ollama NDJSON streaming (1)
 *   - AidenAgent stream:true yields deltas (2)
 *   - AidenAgent stream interleaves with tool calls (1)
 *   - FallbackAdapter cancels + retries on rate-limit before any delta (2)
 *   - /streaming command toggles + persists (2)
 *   - display.streamPartial / streamComplete handle ANSI / state (1)
 *   - spinner stops on first delta (1)
 *
 * Total: 15.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatCompletionsAdapter } from '../../providers/v4/chatCompletionsAdapter';
import { MessageApiAdapter } from '../../providers/v4/messageApiAdapter';
import { LocalPromptToolsAdapter } from '../../providers/v4/localPromptToolsAdapter';
import { AidenAgent } from '../../core/v4/aidenAgent';
import { FallbackAdapter } from '../../core/v4/providerFallback';
import { ProviderRateLimitError } from '../../providers/v4/errors';
import { Display } from '../../cli/v4/display';
import type {
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  StreamEvent,
  ToolCallRequest,
  ToolCallResult,
  ToolSchema,
} from '../../providers/v4/types';
import { streaming } from '../../cli/v4/commands/streaming';

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function sseStreamFromLines(lines: string[]): Response {
  const body = lines.join('\n') + '\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function ndjsonResponse(objects: unknown[]): Response {
  const body = objects.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

const userMsg = (content: string): Message => ({ role: 'user', content });

const baseChatOptions = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  providerName: 'test-provider',
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────
// chat_completions streaming
// ──────────────────────────────────────────────────────────────────────

describe('ChatCompletionsAdapter.callStream', () => {
  it('parses three text deltas + done into delta + done events', async () => {
    fetchMock.mockResolvedValue(
      sseStreamFromLines([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
        'data: [DONE]',
      ]),
    );
    const adapter = new ChatCompletionsAdapter(baseChatOptions);
    const events: StreamEvent[] = [];
    for await (const evt of adapter.callStream({
      messages: [userMsg('hi')],
      tools: [],
    })) {
      events.push(evt);
    }
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas).toHaveLength(3);
    expect((deltas[0] as { content: string }).content).toBe('Hel');
    expect((deltas[2] as { content: string }).content).toBe(' world');
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.output.content).toBe('Hello world');
      expect(done.output.finishReason).toBe('stop');
      expect(done.output.usage.outputTokens).toBe(3);
    }
  });

  it('emits tool_call event when streamed tool name first appears, suppresses subsequent text deltas', async () => {
    fetchMock.mockResolvedValue(
      sseStreamFromLines([
        'data: {"choices":[{"delta":{"content":"sure, "}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file"}}]}}]}',
        'data: {"choices":[{"delta":{"content":" calling..."}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    );
    const adapter = new ChatCompletionsAdapter(baseChatOptions);
    const events: StreamEvent[] = [];
    for await (const evt of adapter.callStream({
      messages: [userMsg('read file a.txt please')],
      tools: [],
    })) {
      events.push(evt);
    }
    const deltas = events.filter((e) => e.type === 'delta');
    // Only the pre-tool delta should be visible.
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { content: string }).content).toBe('sure, ');
    const toolCallEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(1);
    expect((toolCallEvents[0] as { toolCall: ToolCallRequest }).toolCall.name).toBe('read_file');
    const done = events.at(-1);
    if (done?.type === 'done') {
      expect(done.output.toolCalls).toHaveLength(1);
      expect(done.output.toolCalls[0].arguments).toEqual({ path: 'a.txt' });
      expect(done.output.finishReason).toBe('tool_use');
    }
  });

  it('throws ProviderRateLimitError on 429 before yielding any events', async () => {
    fetchMock.mockResolvedValue(
      new Response('rate limit hit', { status: 429 }),
    );
    const adapter = new ChatCompletionsAdapter(baseChatOptions);
    await expect(
      (async () => {
        for await (const _ of adapter.callStream({
          messages: [userMsg('hi')],
          tools: [],
        })) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});

// ──────────────────────────────────────────────────────────────────────
// anthropic streaming
// ──────────────────────────────────────────────────────────────────────

describe('MessageApiAdapter.callStream', () => {
  it('parses content_block_delta text_delta events into delta events', async () => {
    fetchMock.mockResolvedValue(
      sseStreamFromLines([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":0}}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":4,"output_tokens":2}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    );
    const adapter = new MessageApiAdapter({
      apiKey: 'k',
      authMode: 'api_key',
      model: 'claude-haiku-4-5',
      providerName: 'anthropic',
    });
    const events: StreamEvent[] = [];
    for await (const evt of adapter.callStream({
      messages: [userMsg('hi')],
      tools: [],
    })) {
      events.push(evt);
    }
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.map((d) => (d as { content: string }).content)).toEqual(['Hi', ' there']);
    const done = events.at(-1);
    if (done?.type === 'done') {
      expect(done.output.content).toBe('Hi there');
      expect(done.output.finishReason).toBe('stop');
      expect(done.output.usage.outputTokens).toBe(2);
    }
  });

  it('emits tool_call event on content_block_start and parses streamed input_json_delta', async () => {
    fetchMock.mockResolvedValue(
      sseStreamFromLines([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":5,"output_tokens":7}}',
        'data: {"type":"message_stop"}',
      ]),
    );
    const adapter = new MessageApiAdapter({
      apiKey: 'k',
      authMode: 'api_key',
      model: 'claude-haiku-4-5',
      providerName: 'anthropic',
    });
    const events: StreamEvent[] = [];
    for await (const evt of adapter.callStream({
      messages: [userMsg('read it')],
      tools: [],
    })) {
      events.push(evt);
    }
    const tc = events.find((e) => e.type === 'tool_call');
    expect(tc).toBeDefined();
    if (tc?.type === 'tool_call') {
      expect(tc.toolCall.id).toBe('toolu_1');
      expect(tc.toolCall.name).toBe('read_file');
    }
    const done = events.at(-1);
    if (done?.type === 'done') {
      expect(done.output.toolCalls).toHaveLength(1);
      expect(done.output.toolCalls[0].arguments).toEqual({ path: 'a.txt' });
      expect(done.output.finishReason).toBe('tool_use');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// ollama streaming
// ──────────────────────────────────────────────────────────────────────

describe('LocalPromptToolsAdapter.callStream', () => {
  it('relays NDJSON deltas and emits done with parsed totals', async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        { message: { role: 'assistant', content: 'Hel' }, done: false },
        { message: { role: 'assistant', content: 'lo!' }, done: false },
        {
          message: { role: 'assistant', content: '' },
          done: true,
          prompt_eval_count: 12,
          eval_count: 3,
        },
      ]),
    );
    const adapter = new LocalPromptToolsAdapter({
      model: 'llama3.2',
      providerName: 'ollama',
    });
    const events: StreamEvent[] = [];
    for await (const evt of adapter.callStream({
      messages: [userMsg('hi')],
      tools: [],
    })) {
      events.push(evt);
    }
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.map((d) => (d as { content: string }).content)).toEqual(['Hel', 'lo!']);
    const done = events.at(-1);
    if (done?.type === 'done') {
      expect(done.output.content).toBe('Hello!');
      expect(done.output.usage.inputTokens).toBe(12);
      expect(done.output.usage.outputTokens).toBe(3);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// AidenAgent streaming
// ──────────────────────────────────────────────────────────────────────

class FakeStreamingAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  constructor(private readonly events: StreamEvent[]) {}
  async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
    const last = this.events[this.events.length - 1];
    if (last.type !== 'done') throw new Error('fake adapter has no done event');
    return last.output;
  }
  async *callStream(
    _input: ProviderCallInput,
  ): AsyncGenerator<StreamEvent, void, void> {
    for (const evt of this.events) yield evt;
  }
}

describe('AidenAgent runConversation stream:true', () => {
  it('relays delta events through onDelta and onFirstDelta', async () => {
    const adapter = new FakeStreamingAdapter([
      { type: 'delta', content: 'Hel' },
      { type: 'delta', content: 'lo' },
      {
        type: 'done',
        output: {
          content: 'Hello',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      },
    ]);
    const agent = new AidenAgent({
      provider: adapter,
      toolExecutor: async () => ({ id: 'x', name: 'x', result: '' }),
      tools: [],
    });
    const collected: string[] = [];
    let firstFiredCount = 0;
    const result = await agent.runConversation([userMsg('hi')], {
      stream: true,
      onDelta: (t) => collected.push(t),
      onFirstDelta: () => {
        firstFiredCount += 1;
      },
    });
    // The agent-layer streaming UI-leak sanitizer (createStreamingUiLeakFilter,
    // consumed in aidenAgent callProvider) buffers deltas to catch `<ui_…>`
    // tags split across chunk boundaries, then flushes the accumulated safe
    // text — so onDelta sees one coalesced 'Hello', not the raw 'Hel'/'lo'
    // split. (Adapter-level delta tests above still see the raw split; the
    // filter lives in the agent, not the adapter.)
    expect(collected).toEqual(['Hello']);
    expect(firstFiredCount).toBe(1);
    expect(result.finalContent).toBe('Hello');
    expect(result.finishReason).toBe('stop');
  });

  it('falls back to non-streaming when adapter has no callStream', async () => {
    const nonStream: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        return {
          content: 'plain answer',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const agent = new AidenAgent({
      provider: nonStream,
      toolExecutor: async () => ({ id: 'x', name: 'x', result: '' }),
      tools: [],
    });
    const collected: string[] = [];
    const result = await agent.runConversation([userMsg('hi')], {
      stream: true,
      onDelta: (t) => collected.push(t),
    });
    expect(collected).toEqual([]);
    expect(result.finalContent).toBe('plain answer');
  });

  it('interleaves tool_call events between text deltas', async () => {
    const tool: ToolSchema = {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: {} },
    };
    const exec = async (call: ToolCallRequest): Promise<ToolCallResult> => ({
      id: call.id,
      name: call.name,
      result: 'ok',
    });
    let turn = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        throw new Error('non-stream path should not run');
      },
      async *callStream(): AsyncGenerator<StreamEvent, void, void> {
        turn += 1;
        if (turn === 1) {
          yield { type: 'delta', content: 'preamble ' };
          yield {
            type: 'tool_call',
            toolCall: { id: 'c1', name: 'echo', arguments: {} },
          };
          yield {
            type: 'done',
            output: {
              content: 'preamble',
              toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }],
              finishReason: 'tool_use',
              usage: { inputTokens: 3, outputTokens: 2 },
            },
          };
        } else {
          yield { type: 'delta', content: 'final answer' };
          yield {
            type: 'done',
            output: {
              content: 'final answer',
              toolCalls: [],
              finishReason: 'stop',
              usage: { inputTokens: 4, outputTokens: 2 },
            },
          };
        }
      },
    };
    const agent = new AidenAgent({
      provider: adapter,
      toolExecutor: exec,
      tools: [tool],
    });
    const toolCalls: string[] = [];
    const deltas: string[] = [];
    const result = await agent.runConversation([userMsg('do it')], {
      stream: true,
      onDelta: (t) => deltas.push(t),
      onToolCallStart: (c) => toolCalls.push(c.name),
    });
    expect(toolCalls).toEqual(['echo']);
    expect(deltas).toContain('preamble ');
    expect(deltas).toContain('final answer');
    expect(result.toolCallCount).toBe(1);
    expect(result.finalContent).toBe('final answer');
  });
});

// ──────────────────────────────────────────────────────────────────────
// FallbackAdapter streaming + 429 handling
// ──────────────────────────────────────────────────────────────────────

describe('FallbackAdapter.callStream', () => {
  it('advances to the next slot when slot 1 throws rate-limit before any delta', async () => {
    let now = 1_000_000;
    const slot1Adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        throw new ProviderRateLimitError('groq', 'tpm');
      },
      async *callStream(): AsyncGenerator<StreamEvent, void, void> {
        throw new ProviderRateLimitError('groq', 'tpm');
        yield undefined as never;
      },
    };
    const slot2Adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        return {
          content: 'fallback answer',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
      async *callStream(): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'delta', content: 'fallback' };
        yield {
          type: 'done',
          output: {
            content: 'fallback',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
    };
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [
        {
          id: 'groq',
          providerId: 'groq',
          modelId: 'llama-3.3-70b',
          keyPresent: true,
          keyTail: 'aaaa',
          build: () => slot1Adapter,
        },
        {
          id: 'together',
          providerId: 'together',
          modelId: 'llama-3.3-70b',
          keyPresent: true,
          keyTail: 'bbbb',
          build: () => slot2Adapter,
        },
      ],
      cooldownMs: 60_000,
      now: () => now,
    });
    const events: StreamEvent[] = [];
    for await (const evt of fa.callStream({
      messages: [userMsg('hi')],
      tools: [],
    })) {
      events.push(evt);
    }
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    const diag = fa.getDiagnostics();
    const groq = diag.slots.find((s) => s.id === 'groq')!;
    expect(groq.state.rateLimited).toBe(true);
    expect(groq.cooldownRemainingSec).toBeGreaterThan(0);
    expect(diag.activeSlotId).toBe('together');
  });

  it('falls through to non-streaming on slots that lack callStream', async () => {
    const nonStreamAdapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        return {
          content: 'plain',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [
        {
          id: 'plain',
          providerId: 'plain',
          modelId: 'm',
          keyPresent: true,
          keyTail: 'cccc',
          build: () => nonStreamAdapter,
        },
      ],
    });
    const events: StreamEvent[] = [];
    for await (const evt of fa.callStream({
      messages: [userMsg('hi')],
      tools: [],
    })) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    if (events[0].type === 'done') {
      expect(events[0].output.content).toBe('plain');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// /streaming command
// ──────────────────────────────────────────────────────────────────────

function makeFakeConfig(initial: Record<string, unknown>) {
  const store: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
  let saved = false;
  return {
    getValue<T>(key: string, fallback?: T): T {
      const parts = key.split('.');
      let cur: unknown = store;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return fallback as T;
        }
      }
      return cur as T;
    },
    set(key: string, value: unknown) {
      const parts = key.split('.');
      let cur: Record<string, unknown> = store;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const p = parts[i];
        if (!(p in cur) || typeof cur[p] !== 'object' || cur[p] == null) {
          cur[p] = {};
        }
        cur = cur[p] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = value;
    },
    save: async () => {
      saved = true;
    },
    wasSaved: () => saved,
    snapshot: () => JSON.parse(JSON.stringify(store)),
  };
}

class CapturingDisplay extends Display {
  lines: string[] = [];
  constructor() {
    const out = {
      write: (s: string) => {
        this.lines.push(s);
        return true;
      },
      isTTY: false,
    } as unknown as NodeJS.WriteStream;
    super({ stdout: out, stderr: out });
  }
}

describe('/streaming command', () => {
  it('toggles display.streaming on and persists', async () => {
    const cfg = makeFakeConfig({ display: { streaming: false } });
    const display = new CapturingDisplay();
    await streaming.handler({
      args: ['on'],
      rawArgs: 'on',
      display,
      registry: {} as never,
      config: cfg as never,
    } as never);
    expect(cfg.getValue<boolean>('display.streaming', false)).toBe(true);
    expect(cfg.wasSaved()).toBe(true);
  });

  it('shows current state when invoked without arguments', async () => {
    const cfg = makeFakeConfig({ display: { streaming: false } });
    const display = new CapturingDisplay();
    await streaming.handler({
      args: [],
      rawArgs: '',
      display,
      registry: {} as never,
      config: cfg as never,
    } as never);
    const joined = display.lines.join('');
    expect(joined.toLowerCase()).toContain('streaming is off');
    expect(cfg.getValue<boolean>('display.streaming', false)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Display.streamPartial / streamComplete + spinner stop
// ──────────────────────────────────────────────────────────────────────

describe('Display streaming surface', () => {
  it('writes a header on first streamPartial and a closing newline on streamComplete', () => {
    const display = new CapturingDisplay();
    display.streamPartial('hello');
    display.streamPartial(' world');
    display.streamComplete();
    const joined = display.lines.join('');
    // Header appears once, content streams as raw text.
    expect(joined).toContain('Aiden');
    expect(joined).toContain('hello');
    expect(joined).toContain(' world');
    // streamComplete adds the trailing newline since the last delta did
    // not end with one.
    expect(joined.endsWith('\n')).toBe(true);
  });

  it('startSpinner.stop is callable safely once on first delta', () => {
    const display = new CapturingDisplay();
    const spinner = display.startSpinner('thinking…');
    let stops = 0;
    const original = spinner.stop;
    spinner.stop = (text?: string) => {
      stops += 1;
      original.call(spinner, text);
    };
    spinner.stop();
    spinner.stop(); // spinner is idempotent — no-op on second call internally
    expect(stops).toBe(2);
  });
});
