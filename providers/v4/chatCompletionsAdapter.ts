/**
 * providers/v4/chatCompletionsAdapter.ts — Aiden v4.0.0
 *
 * Adapter for the OpenAI-style /v1/chat/completions wire format.
 *
 * Covers (single adapter, swap baseUrl/model/key):
 *   - Groq                (api.groq.com/openai/v1)
 *   - OpenRouter          (openrouter.ai/api/v1)              + extraHeaders
 *   - Together            (api.together.xyz/v1)
 *   - Gemini compat       (generativelanguage.googleapis.com/v1beta/openai)
 *   - Cerebras, NVIDIA NIM, DeepSeek, xAI, Kimi, custom OAI-spec endpoints
 *
 * Status: PHASE 3 — non-streaming only. Streaming lands Phase 13.
 *
 * Hermes reference: agent/transports/chat_completions.py (ChatCompletionsTransport)
 *
 * Wire-format quirks handled here:
 *   1. tool_calls[].function.arguments is a JSON STRING — parsed; falls back to {} on bad JSON.
 *   2. choices[0].message.content can be null when only tool_calls present.
 *   3. finish_reason 'tool_calls' (plural) → v4 'tool_use' (singular).
 *   4. Tools wrapped as {type:'function', function:{name, description, parameters}}.
 *   5. Usage is prompt_tokens / completion_tokens (mapped to inputTokens / outputTokens).
 *   6. Multiple system messages at the head get concatenated (some providers reject >1).
 */

import {
  ApiMode,
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ToolCallRequest,
  ToolSchema,
} from './types';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors';

export interface ChatCompletionsAdapterOptions {
  /** Full base URL (no trailing slash), e.g. 'https://api.groq.com/openai/v1' */
  baseUrl: string;
  /** Bearer token. */
  apiKey: string;
  /** Provider-specific model identifier, e.g. 'llama-3.3-70b-versatile'. */
  model: string;
  /** Provider name for error messages and logging. */
  providerName: string;
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Max retries on transient errors (429, 5xx). Default 2 (so 3 attempts total). */
  maxRetries?: number;
  /** Extra headers (e.g. OpenRouter requires `HTTP-Referer` + `X-Title`). */
  extraHeaders?: Record<string, string>;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolSchema['inputSchema'];
  };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string | null;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

export class ChatCompletionsAdapter implements ProviderAdapter {
  apiMode: ApiMode = 'chat_completions';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly providerName: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: ChatCompletionsAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.providerName = options.providerName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body = this.buildRequestBody(input);
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };

    const totalAttempts = this.maxRetries + 1;
    let lastTransientError: ProviderError | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, headers, body);

        if (response.ok) {
          const json = (await response.json()) as OpenAIResponse;
          return this.parseResponse(json);
        }

        const status = response.status;
        const rawText = await this.safeReadText(response);

        // Non-retryable: 4xx that's NOT 429 (request bugs).
        if (status >= 400 && status < 500 && status !== 429) {
          throw new ProviderError(
            `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
            this.providerName,
            status,
            rawText,
            false,
          );
        }

        // Retryable: 429 or 5xx.
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
        if (err instanceof ProviderError && !err.retryable) {
          throw err;
        }
        if (err instanceof ProviderTimeoutError) {
          // Timeouts are retryable — keep going if budget remains.
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
        // Unknown error (e.g. network failure) — wrap and treat as retryable.
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

    // Loop guarantees a return or throw above; this satisfies TS.
    throw lastTransientError ?? new ProviderError(
      `Provider ${this.providerName} exhausted retries`,
      this.providerName,
    );
  }

  private buildRequestBody(input: ProviderCallInput): Record<string, unknown> {
    const messages = this.translateMessages(input.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (input.tools.length > 0) {
      body.tools = this.translateTools(input.tools);
      body.tool_choice = 'auto';
    }
    if (input.maxTokens != null) body.max_tokens = input.maxTokens;
    if (input.temperature != null) body.temperature = input.temperature;
    if (input.extraBody) Object.assign(body, input.extraBody);
    return body;
  }

  private translateMessages(messages: Message[]): OpenAIMessage[] {
    // Concat consecutive system messages at the head — some OAI-compat
    // providers reject >1 system message.
    const out: OpenAIMessage[] = [];
    let i = 0;
    if (messages.length > 0 && messages[0].role === 'system') {
      const headSystems: string[] = [];
      while (i < messages.length && messages[i].role === 'system') {
        headSystems.push((messages[i] as { content: string }).content);
        i += 1;
      }
      out.push({ role: 'system', content: headSystems.join('\n\n') });
    }
    for (; i < messages.length; i += 1) {
      const msg = messages[i];
      switch (msg.role) {
        case 'system':
          out.push({ role: 'system', content: msg.content });
          break;
        case 'user':
          out.push({ role: 'user', content: msg.content });
          break;
        case 'assistant': {
          const oai: OpenAIMessage = {
            role: 'assistant',
            content: msg.content || null,
          };
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            oai.tool_calls = msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments ?? {}),
              },
            }));
          }
          out.push(oai);
          break;
        }
        case 'tool':
          out.push({
            role: 'tool',
            tool_call_id: msg.toolCallId,
            content: msg.content,
          });
          break;
      }
    }
    return out;
  }

  private translateTools(tools: ToolSchema[]): OpenAITool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  private parseResponse(json: OpenAIResponse): ProviderCallOutput {
    const choice = json.choices?.[0];
    if (!choice) {
      throw new ProviderError(
        `Provider ${this.providerName} returned no choices`,
        this.providerName,
        undefined,
        json,
      );
    }

    const message = choice.message ?? { role: 'assistant', content: null };
    const toolCalls: ToolCallRequest[] = (message.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        if (typeof args !== 'object' || args === null) args = {};
      } catch {
        console.warn(
          `[${this.providerName}] failed to JSON.parse tool call arguments for ${tc.function.name} (id=${tc.id}); falling back to {}`,
        );
        args = {};
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: args,
      };
    });

    const rawFinish = choice.finish_reason ?? 'stop';
    let finishReason: ProviderCallOutput['finishReason'];
    switch (rawFinish) {
      case 'stop':
        finishReason = 'stop';
        break;
      case 'tool_calls':
      case 'function_call':
        finishReason = 'tool_use';
        break;
      case 'length':
        finishReason = 'length';
        break;
      default:
        finishReason = toolCalls.length > 0 ? 'tool_use' : 'stop';
        break;
    }

    const usage = json.usage ?? {};
    return {
      content: message.content ?? null,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
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
    // 1s after attempt 1, 2s after attempt 2.
    return 1000 * attempt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
