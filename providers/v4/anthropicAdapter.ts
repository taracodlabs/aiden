/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * Portions adapted from NousResearch/hermes-agent (MIT).
 * Original copyright (c) NousResearch.
 */
/**
 * providers/v4/anthropicAdapter.ts — Aiden v4.0.0
 *
 * Adapter for Anthropic's native /v1/messages wire format.
 *
 * Covers:
 *   - api.anthropic.com (api_key + OAuth subscription auth)
 *   - third-party Anthropic-compatible endpoints (DashScope/Qwen, MiniMax)
 *
 * Status: PHASE 4 — non-streaming only. Streaming + prefix caching breakpoints
 *   land Phase 12-13.
 *
 * Hermes reference: agent/transports/anthropic.py + agent/anthropic_adapter.py
 *
 * Wire-format quirks handled here:
 *   1. Top-level `system` field (NOT in messages array). String OR list of blocks.
 *   2. Tool schema uses `input_schema` (not `parameters`).
 *   3. Assistant content is array of blocks: {type:'text'} | {type:'tool_use', id, name, input}.
 *      `input` arrives as a parsed object — no JSON.parse needed (unlike OpenAI).
 *   4. Tool replies go inside user messages as content blocks of type 'tool_result'.
 *   5. stop_reason ∈ {end_turn, tool_use, max_tokens, stop_sequence, refusal,
 *      model_context_window_exceeded}; mapped to v4's {stop, tool_use, length}.
 *   6. Empty content[] is LEGAL when stop_reason==='end_turn' — return '' not throw.
 *   7. Usage carries cache_creation_input_tokens / cache_read_input_tokens for
 *      prefix caching (captured into v4's cacheReadTokens / cacheWriteTokens).
 *   8. OAuth: Authorization: Bearer + anthropic-beta: claude-code-20250219,oauth-2025-04-20
 *      + minimal Claude Code identity prefix injected into system prompt.
 *      (Tool-name mcp_ prefixing and Hermes-specific name sanitization are
 *      deferred to Phase 13 OAuth wizard.)
 */

import {
  ApiMode,
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  StreamEvent,
  ToolCallRequest,
  ToolSchema,
} from './types';
import { parseSseStream } from './chatCompletionsAdapter';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors';

export interface AnthropicAdapterOptions {
  /** Default 'https://api.anthropic.com'. No trailing slash. */
  baseUrl?: string;
  /** Either an x-api-key value (authMode='api_key') or an OAuth bearer token (authMode='oauth'). */
  apiKey: string;
  /** Selects auth header shape. */
  authMode: 'api_key' | 'oauth';
  /** e.g. 'claude-haiku-4-5-20251001', 'claude-opus-4-7'. */
  model: string;
  /** For error messages and logging. */
  providerName: string;
  /** Per-request timeout. Default 120_000. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network. Default 2 (3 attempts total). */
  maxRetries?: number;
  /** Extra headers (escape hatch — merged after computed headers). */
  extraHeaders?: Record<string, string>;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ToolSchema['inputSchema'];
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: string; [k: string]: unknown };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Phase 16c: shape of a single Anthropic SSE event JSON. We dispatch on
 * `type` to route into the per-block state machine.
 */
interface AnthropicStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'error'
    | 'ping'
    | string;
  index?: number;
  content_block?: {
    type: 'text' | 'tool_use' | 'thinking' | string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: 'text_delta' | 'input_json_delta' | 'thinking_delta' | string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    stop_reason?: string;
  };
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20';

/**
 * Minimal Claude Code identity prefix used in OAuth mode. Anthropic's
 * subscription infrastructure expects requests to carry Claude Code
 * identity; without it, OAuth traffic intermittently 500s.
 */
const CLAUDE_CODE_IDENTITY_PREFIX =
  'You are Claude Code, Anthropic\'s official CLI for Claude.';

export class AnthropicAdapter implements ProviderAdapter {
  apiMode: ApiMode = 'anthropic_messages';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly authMode: 'api_key' | 'oauth';
  private readonly model: string;
  private readonly providerName: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: AnthropicAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.authMode = options.authMode;
    this.model = options.model;
    this.providerName = options.providerName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body = this.buildRequestBody(input);
    const url = `${this.baseUrl}/v1/messages`;
    const headers = this.buildHeaders();

    const totalAttempts = this.maxRetries + 1;
    let lastTransientError: ProviderError | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, headers, body);

        if (response.ok) {
          const json = (await response.json()) as AnthropicResponse;
          return this.parseResponse(json);
        }

        const status = response.status;
        const rawText = await this.safeReadText(response);

        if (status >= 400 && status < 500 && status !== 429) {
          throw new ProviderError(
            `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
            this.providerName,
            status,
            rawText,
            false,
          );
        }

        const isRateLimit = status === 429;
        lastTransientError = isRateLimit
          ? new ProviderRateLimitError(this.providerName, rawText)
          : new ProviderError(
              `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
              this.providerName,
              status,
              rawText,
              true,
            );

        if (attempt < totalAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw lastTransientError;
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        if (err instanceof ProviderTimeoutError) {
          lastTransientError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        if (err instanceof ProviderError) {
          lastTransientError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        const wrapped = new ProviderError(
          `Provider ${this.providerName} request failed: ${err instanceof Error ? err.message : String(err)}`,
          this.providerName,
          undefined,
          err,
          true,
        );
        lastTransientError = wrapped;
        if (attempt < totalAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw wrapped;
      }
    }

    throw lastTransientError ?? new ProviderError(
      `Provider ${this.providerName} exhausted retries`,
      this.providerName,
    );
  }

  /**
   * Phase 16c: streaming variant. Parses Anthropic's SSE event stream into
   * `delta` / `tool_call` / `done` events.
   *
   * Anthropic SSE wire shape (see anthropic/messages/streaming docs):
   *   message_start { message: { ... } }
   *   content_block_start { index, content_block: {type, ...} }
   *   content_block_delta { index, delta: {type, text|partial_json|thinking, ...} }
   *   content_block_stop { index }
   *   message_delta { delta: {stop_reason, ...}, usage }
   *   message_stop
   *
   * Each event arrives as `event: <name>\ndata: <json>\n\n`. The shared
   * `parseSseStream` extracts the `data:` payloads only; we read the
   * `type` field on each JSON to dispatch.
   *
   * Mirrors Hermes `_call_anthropic` (run_agent.py:7009) — text deltas
   * are suppressed once a `tool_use` block appears in the same response,
   * matching the chat_completions semantics.
   */
  async *callStream(
    input: ProviderCallInput,
  ): AsyncGenerator<StreamEvent, void, void> {
    const baseBody = this.buildRequestBody(input);
    const body = { ...baseBody, stream: true };
    const url = `${this.baseUrl}/v1/messages`;
    const headers = {
      ...this.buildHeaders(),
      Accept: 'text/event-stream',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderTimeoutError(this.providerName, this.timeoutMs);
      }
      throw new ProviderError(
        `Provider ${this.providerName} stream request failed: ${err instanceof Error ? err.message : String(err)}`,
        this.providerName,
        undefined,
        err,
        true,
      );
    }

    if (!response.ok) {
      clearTimeout(timer);
      const status = response.status;
      const rawText = await this.safeReadText(response);
      if (status === 429) {
        throw new ProviderRateLimitError(this.providerName, rawText);
      }
      const retryable = status >= 500;
      throw new ProviderError(
        `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
        this.providerName,
        status,
        rawText,
        retryable,
      );
    }
    if (!response.body) {
      clearTimeout(timer);
      throw new ProviderError(
        `Provider ${this.providerName} returned an empty stream body`,
        this.providerName,
      );
    }

    // Block accumulators, keyed by `index`.
    type BlockState = {
      type: 'text' | 'tool_use' | 'thinking' | 'unknown';
      text: string;
      toolName?: string;
      toolId?: string;
      partialJson: string;
    };
    const blocks = new Map<number, BlockState>();
    let stopReason: string | null = null;
    let usage: { input_tokens?: number; output_tokens?: number } | null = null;
    let toolUseSeen = false;
    const toolCalls: ToolCallRequest[] = [];

    try {
      for await (const payload of parseSseStream(response.body)) {
        let evt: AnthropicStreamEvent;
        try {
          evt = JSON.parse(payload) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        // Top-level error frame (rare on Anthropic but possible on third-party
        // anthropic-compat endpoints).
        if (evt.type === 'error') {
          const msg = evt.error?.message ?? 'unknown';
          throw new ProviderError(
            `Provider ${this.providerName} stream error: ${msg}`,
            this.providerName,
            undefined,
            evt.error,
            true,
          );
        }

        if (evt.type === 'content_block_start' && evt.content_block) {
          const idx = evt.index ?? 0;
          const cb = evt.content_block;
          if (cb.type === 'text') {
            blocks.set(idx, { type: 'text', text: '', partialJson: '' });
          } else if (cb.type === 'tool_use') {
            blocks.set(idx, {
              type: 'tool_use',
              text: '',
              toolName: cb.name,
              toolId: cb.id,
              partialJson: '',
            });
            toolUseSeen = true;
            yield {
              type: 'tool_call',
              toolCall: {
                id: cb.id ?? `pending-${idx}`,
                name: cb.name ?? '?',
                arguments: {},
              },
            };
          } else if (cb.type === 'thinking') {
            blocks.set(idx, { type: 'thinking', text: '', partialJson: '' });
          } else {
            blocks.set(idx, { type: 'unknown', text: '', partialJson: '' });
          }
        } else if (evt.type === 'content_block_delta' && evt.delta) {
          const idx = evt.index ?? 0;
          const block = blocks.get(idx);
          if (!block) continue;
          const d = evt.delta;
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            block.text += d.text;
            // Per Hermes line 7053: only stream text while no tool_use
            // block has appeared in this turn.
            if (!toolUseSeen && d.text.length > 0) {
              yield { type: 'delta', content: d.text };
            }
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            block.partialJson += d.partial_json;
          }
          // thinking_delta is captured but not surfaced — extended-thinking
          // support is deferred to v4.1 per spec.
        } else if (evt.type === 'message_delta' && evt.delta) {
          if (typeof evt.delta.stop_reason === 'string') {
            stopReason = evt.delta.stop_reason;
          }
          if (evt.usage) usage = evt.usage;
        } else if (evt.type === 'message_start' && evt.message?.usage) {
          usage = evt.message.usage;
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Provider ${this.providerName} stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
        this.providerName,
        undefined,
        err,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    // Assemble final tool calls + content from the per-block state.
    let textContent = '';
    for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
      const block = blocks.get(idx)!;
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        let args: Record<string, unknown> = {};
        const buf = block.partialJson.trim();
        if (buf.length > 0) {
          try {
            const parsed = JSON.parse(buf);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            console.warn(
              `[${this.providerName}] failed to JSON.parse streamed tool args for ${block.toolName}; falling back to {}`,
            );
          }
        }
        toolCalls.push({
          id: block.toolId ?? `call_${idx}_${Date.now().toString(36)}`,
          name: block.toolName ?? '?',
          arguments: args,
        });
      }
    }

    let mappedFinish: ProviderCallOutput['finishReason'];
    switch (stopReason) {
      case 'end_turn':
      case 'stop_sequence':
        mappedFinish = 'stop';
        break;
      case 'tool_use':
        mappedFinish = 'tool_use';
        break;
      case 'max_tokens':
      case 'model_context_window_exceeded':
        mappedFinish = 'length';
        break;
      default:
        mappedFinish = toolCalls.length > 0 ? 'tool_use' : 'stop';
        break;
    }

    const output: ProviderCallOutput = {
      content: textContent,
      toolCalls,
      finishReason: mappedFinish,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
    };
    yield { type: 'done', output };
  }

  private buildHeaders(): Record<string, string> {
    const base: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (this.authMode === 'oauth') {
      base['Authorization'] = `Bearer ${this.apiKey}`;
      base['anthropic-beta'] = OAUTH_BETAS;
    } else {
      base['x-api-key'] = this.apiKey;
    }
    return { ...base, ...this.extraHeaders };
  }

  private buildRequestBody(input: ProviderCallInput): Record<string, unknown> {
    const { system, messages } = this.translateMessages(input.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      // Anthropic requires max_tokens. Use input.maxTokens if provided, else 4096.
      max_tokens: input.maxTokens ?? 4096,
    };
    if (system) body.system = system;
    if (input.tools.length > 0) {
      body.tools = this.translateTools(input.tools);
      body.tool_choice = { type: 'auto' };
    }
    if (input.temperature != null) body.temperature = input.temperature;
    if (input.extraBody) Object.assign(body, input.extraBody);
    return body;
  }

  /**
   * Translate v4 Message[] to Anthropic shape.
   * Returns:
   *   - `system`: concatenated system text (or undefined if no system messages)
   *   - `messages`: Anthropic-formatted user/assistant messages with content blocks.
   *
   * Tool result messages (role='tool') get folded into the immediately
   * preceding user message as a {type:'tool_result'} content block. If the
   * sequence starts with a tool message (no preceding user), a synthetic user
   * message is created — Anthropic requires alternating user/assistant.
   */
  private translateMessages(messages: Message[]): {
    system: string | undefined;
    messages: AnthropicMessage[];
  } {
    const systemParts: string[] = [];
    const out: AnthropicMessage[] = [];

    if (this.authMode === 'oauth') {
      systemParts.push(CLAUDE_CODE_IDENTITY_PREFIX);
    }

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          systemParts.push(msg.content);
          break;
        case 'user':
          out.push({ role: 'user', content: msg.content });
          break;
        case 'assistant': {
          const blocks: AnthropicContentBlock[] = [];
          if (msg.content) {
            blocks.push({ type: 'text', text: msg.content });
          }
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            for (const tc of msg.toolCalls) {
              blocks.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: tc.arguments ?? {},
              });
            }
          }
          out.push({
            role: 'assistant',
            content:
              blocks.length === 1 && blocks[0].type === 'text'
                ? (blocks[0] as AnthropicTextBlock).text
                : blocks,
          });
          break;
        }
        case 'tool': {
          const toolBlock: AnthropicContentBlock = {
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content: msg.content,
          };
          const last = out[out.length - 1];
          if (last && last.role === 'user' && Array.isArray(last.content)) {
            last.content.push(toolBlock);
          } else if (last && last.role === 'user' && typeof last.content === 'string') {
            last.content = [{ type: 'text', text: last.content }, toolBlock];
          } else {
            out.push({ role: 'user', content: [toolBlock] });
          }
          break;
        }
      }
    }

    const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    return { system, messages: out };
  }

  private translateTools(tools: ToolSchema[]): AnthropicTool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  private parseResponse(json: AnthropicResponse): ProviderCallOutput {
    const blocks = Array.isArray(json.content) ? json.content : [];
    const stopReason = json.stop_reason ?? 'end_turn';

    // Empty content[] is legitimate when stop_reason==='end_turn'.
    // Hermes treats this as a valid completion (model has nothing to add).
    // For other stop_reasons with empty content, the response is malformed.
    if (blocks.length === 0 && stopReason !== 'end_turn') {
      throw new ProviderError(
        `Provider ${this.providerName} returned empty content with stop_reason='${stopReason}'`,
        this.providerName,
        undefined,
        json,
      );
    }

    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        textParts.push((block as AnthropicTextBlock).text ?? '');
      } else if (block.type === 'tool_use') {
        const tu = block as AnthropicToolUseBlock;
        const args =
          tu.input != null && typeof tu.input === 'object' && !Array.isArray(tu.input)
            ? (tu.input as Record<string, unknown>)
            : {};
        toolCalls.push({ id: tu.id, name: tu.name, arguments: args });
      }
    }

    let finishReason: ProviderCallOutput['finishReason'];
    switch (stopReason) {
      case 'end_turn':
      case 'stop_sequence':
        finishReason = 'stop';
        break;
      case 'tool_use':
        finishReason = 'tool_use';
        break;
      case 'max_tokens':
      case 'model_context_window_exceeded':
        finishReason = 'length';
        break;
      default:
        finishReason = toolCalls.length > 0 ? 'tool_use' : 'stop';
        break;
    }

    const content = blocks.length === 0 ? '' : (textParts.length > 0 ? textParts.join('\n') : '');
    const usage = json.usage ?? {};

    return {
      content,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        ...(usage.cache_read_input_tokens != null
          ? { cacheReadTokens: usage.cache_read_input_tokens }
          : {}),
        ...(usage.cache_creation_input_tokens != null
          ? { cacheWriteTokens: usage.cache_creation_input_tokens }
          : {}),
      },
      raw: json,
    };
  }

  private async fetchWithTimeout(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderTimeoutError(this.providerName, this.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  private backoffMs(attempt: number): number {
    return 1000 * attempt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
