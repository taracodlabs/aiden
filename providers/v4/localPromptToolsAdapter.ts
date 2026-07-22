/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/localPromptToolsAdapter.ts — Aiden v4.0.0
 *
 * Local Ollama adapter with prompt-based fake tool calling.
 *
 * Why this exists: Ollama's native /api/chat tool support varies wildly across
 * models. To make tool calling reliable on small local models (llama3.2,
 * gemma2:2b, qwen2.5:7b, etc.), we don't send `tools` to the API at all —
 * instead we inject a tool catalog into the system prompt and parse
 * `<tool_call>{...}</tool_call>` tags out of the model's text output.
 * This is the same VLLM/Hermes-2-Pro tool format already understood by every
 * Hermes-trained, Qwen, and Llama tool-trained checkpoint.
 *
 * Status: PHASE 4 — non-streaming only.
 *
 * Wire-format quirks handled here:
 *   1. POST /api/chat with {model, messages, stream:false}; NO `tools` field.
 *   2. System prompt augmented with tool catalog + format instructions
 *      when input.tools.length > 0.
 *   3. Parse response.message.content for <tool_call>{...}</tool_call> blocks.
 *      Multiple blocks → multiple toolCalls. Malformed JSON → warn, skip.
 *   4. Tool calls present → finishReason='tool_use', content stripped to text
 *      preceding first <tool_call>.
 *   5. Tool replies (role='tool') translated to user messages with a
 *      "<tool_response>" wrapper so the model sees them clearly.
 *   6. Token usage: prompt_eval_count → inputTokens, eval_count → outputTokens.
 *   7. Network failure → ProviderError(retryable:true) with "Ollama not reachable".
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
import { ProviderError, ProviderPhaseTimeoutError } from './errors';
import { RequestLifecycle, requestDeadlines, type RequestDeadlines } from './requestLifecycle';
import {
  beginPhysicalProviderAttempt,
  byteLength,
  createLogicalProviderCallId,
} from './providerAttemptAccounting';

export interface LocalPromptToolsAdapterOptions {
  /** Default 'http://localhost:11434'. No trailing slash. */
  baseUrl?: string;
  /** e.g. 'llama3.2', 'qwen2.5:7b', 'gemma2:2b'. */
  model: string;
  /** For error messages and logging. */
  providerName: string;
  /** Per-request timeout. Default 120_000. */
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Retries on transient failures. Default 0 — local server, fail fast. */
  maxRetries?: number;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: false;
  options?: Record<string, unknown>;
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Phase 16c: a single NDJSON line from `/api/chat` with `stream:true`.
 * Schema is identical to `OllamaChatResponse` — Ollama uses the same
 * shape for streaming chunks and the final summary, with `done` flipping
 * to `true` only on the last line.
 */
interface OllamaStreamChunk extends OllamaChatResponse {}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 0;

interface ActiveDispatch {
  response: Response;
  lifecycle: RequestLifecycle;
}

/**
 * Hermes-2-Pro / VLLM tool_call regex.
 * Matches both closed and unclosed tags (truncated generation):
 *   <tool_call>...</tool_call>      → group 1
 *   <tool_call>...                  → group 2 (unclosed at end-of-string)
 */
const TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|<tool_call>\s*([\s\S]*)/g;

export class LocalPromptToolsAdapter implements ProviderAdapter {
  apiMode: ApiMode = 'ollama_prompt_tools';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly providerName: string;
  private readonly timeoutMs: number;
  private readonly deadlines: RequestDeadlines;
  private readonly maxRetries: number;

  constructor(options: LocalPromptToolsAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = options.model;
    this.providerName = options.providerName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deadlines = requestDeadlines(this.timeoutMs, {
      connectionMs: options.connectionTimeoutMs,
      firstByteMs: options.firstByteTimeoutMs,
      bodyIdleMs: options.bodyIdleTimeoutMs,
      totalMs: options.totalTimeoutMs,
    });
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body = this.buildRequestBody(input);
    const url = `${this.baseUrl}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const totalAttempts = this.maxRetries + 1;
    let lastError: ProviderError | null = null;
    const serialised = JSON.stringify(body);
    const logicalCallId = input.usageContext?.logicalCallId ?? createLogicalProviderCallId();

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const accounting = beginPhysicalProviderAttempt(input, {
        providerActual: this.providerName,
        modelActual: this.model,
        apiMode: this.apiMode,
        transport: this.baseUrl.startsWith('https:') ? 'https' : 'http',
        attemptIndex: attempt - 1,
        fallbackIndex: input.usageContext?.fallbackIndex ?? 0,
        logicalCallId,
        requestBytes: byteLength(serialised),
      });
      try {
        const active = await this.fetchWithLifecycle(url, headers, body, input.signal);
        const response = active.response;
        let rawText: string;
        try {
          rawText = await active.lifecycle.readText(response);
        } catch (error) {
          throw active.lifecycle.classify(error);
        } finally {
          active.lifecycle.cleanup();
        }
        if (response.ok) {
          try {
            const json = JSON.parse(rawText) as OllamaChatResponse;
            const output = this.parseResponse(json);
            accounting.success(output, byteLength(rawText));
            return output;
          } catch (error) {
            accounting.failure(error, {
              sent: true,
              responseBytes: byteLength(rawText),
              status: 'validation_error',
            });
            throw error;
          }
        }
        const status = response.status;
        const retryable = status >= 500 || status === 429;
        // Phase v4.1.1-oauth-fix Phase 5: short message only. The raw
        // body flows via the .raw arg and composeMessage in errors.ts
        // appends a truncated summary into the final .message — this
        // file used to inline it, producing duplicated output in
        // `aiden doctor --providers` and anywhere else err.message is logged.
        const err = new ProviderError(
          `Provider ${this.providerName} returned ${status}`,
          this.providerName,
          status,
          rawText,
          retryable,
        );
        accounting.failure(err, { sent: true, responseBytes: byteLength(rawText) });
        if (!retryable || attempt >= totalAttempts) throw err;
        lastError = err;
        await this.sleep(this.backoffMs(attempt));
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          accounting.failure(err, { sent: true, status: 'interrupted' });
          throw err;
        }
        if (err instanceof ProviderError && !err.retryable) throw err;
        if (err instanceof ProviderPhaseTimeoutError) {
          accounting.failure(err, { sent: true });
          lastError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        if (err instanceof ProviderError) {
          accounting.failure(err, { sent: true });
          lastError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        // Network-level failure (fetch threw). Most common: connection refused.
        const wrapped = new ProviderError(
          `Ollama not reachable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          this.providerName,
          undefined,
          err,
          true,
        );
        accounting.failure(wrapped, { sent: true });
        if (attempt < totalAttempts) {
          lastError = wrapped;
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw wrapped;
      }
    }

    throw lastError ?? new ProviderError(
      `Provider ${this.providerName} exhausted retries`,
      this.providerName,
    );
  }

  /**
   * Phase 16c: streaming variant. Ollama's /api/chat with `stream:true`
   * emits NDJSON — one JSON object per line — rather than SSE. Each
   * object has shape `{message:{role, content:<delta>}, done:bool, ...}`.
   * The final object has `done:true` plus full token-count fields.
   *
   * Tool emulation runs end-of-turn: we accumulate the full text and
   * THEN parse `<tool_call>` tags out of it, emitting `tool_call` events
   * as they're discovered (via incremental scanning of the buffer). To
   * keep the streamed UX clean, we suppress text deltas the moment a
   * `<tool_call>` opening tag appears in the buffer (matches the
   * non-streaming `parseResponse` behaviour where `textBefore` is the
   * portion before the first tag).
   */
  async *callStream(
    input: ProviderCallInput,
  ): AsyncGenerator<StreamEvent, void, void> {
    const baseBody = this.buildRequestBody(input);
    const body = { ...baseBody, stream: true };
    const url = `${this.baseUrl}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const serialised = JSON.stringify(body);
    const accounting = beginPhysicalProviderAttempt(input, {
      providerActual: this.providerName,
      modelActual: this.model,
      apiMode: this.apiMode,
      transport: this.baseUrl.startsWith('https:') ? 'https' : 'http',
      attemptIndex: 0,
      fallbackIndex: input.usageContext?.fallbackIndex ?? 0,
      logicalCallId: input.usageContext?.logicalCallId ?? createLogicalProviderCallId(),
      requestBytes: byteLength(serialised),
    });

    let active: ActiveDispatch;
    try {
      active = await this.fetchWithLifecycle(url, headers, body, input.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        accounting.failure(err, { sent: true, status: 'interrupted' });
        throw err;
      }
      if (err instanceof Error && err.name === 'ProviderPhaseTimeoutError') {
        accounting.failure(err, { sent: true });
        throw err;
      }
      const error = new ProviderError(
        `Ollama not reachable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        this.providerName,
        undefined,
        err,
        true,
      );
      accounting.failure(error, { sent: true });
      throw error;
    }
    const response = active.response;

    if (!response.ok) {
      const status = response.status;
      let rawText: string;
      try {
        rawText = await active.lifecycle.readText(response);
      } catch (error) {
        const classified = active.lifecycle.classify(error);
        accounting.failure(classified, { sent: true });
        throw classified;
      } finally {
        active.lifecycle.cleanup();
      }
      // Phase v4.1.1-oauth-fix Phase 5: composeMessage handles body
      // rendering centrally; inlining it here would duplicate.
      const error = new ProviderError(
        `Provider ${this.providerName} returned ${status}`,
        this.providerName,
        status,
        rawText,
        status >= 500,
      );
      accounting.failure(error, { sent: true, responseBytes: byteLength(rawText) });
      throw error;
    }
    if (!response.body) {
      active.lifecycle.cleanup();
      const error = new ProviderError(
        `Provider ${this.providerName} returned an empty stream body`,
        this.providerName,
      );
      accounting.failure(error, { sent: true, status: 'validation_error' });
      throw error;
    }
    // Response is good; the stream consumer will run for a while. The
    // controller stays armed (with `externalSignal` still listening) so
    // that mid-stream aborts cancel reader.read() via fetch's signal.
    // Listener cleanup happens in the stream-consumer try/finally below.

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let lineBuffer = '';
    let fullContent = '';
    let toolTagSeen = false;
    let promptEvalCount = 0;
    let evalCount = 0;
    let doneReason: string | undefined;

    try {
      while (true) {
        const { value, done } = await active.lifecycle.readChunk(reader);
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, nl).trim();
          lineBuffer = lineBuffer.slice(nl + 1);
          if (!line) continue;
          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(line) as OllamaStreamChunk;
          } catch {
            continue;
          }
          const piece = chunk.message?.content ?? '';
          if (piece) {
            fullContent += piece;
            // Detect tool tag boundary. Once seen, stop streaming text
            // deltas — the rest of the response is tool-call markup.
            if (!toolTagSeen && fullContent.includes('<tool_call>')) {
              toolTagSeen = true;
              // Emit any pre-tag remainder of THIS piece (the part of
              // `piece` before the `<tool_call>` substring inside it).
              const localTagIdx = piece.indexOf('<tool_call>');
              if (localTagIdx > 0) {
                yield { type: 'delta', content: piece.slice(0, localTagIdx) };
              }
            } else if (!toolTagSeen) {
              yield { type: 'delta', content: piece };
            }
          }
          if (chunk.done) {
            if (typeof chunk.prompt_eval_count === 'number') {
              promptEvalCount = chunk.prompt_eval_count;
            }
            if (typeof chunk.eval_count === 'number') {
              evalCount = chunk.eval_count;
            }
            if (typeof chunk.done_reason === 'string') {
              doneReason = chunk.done_reason;
            }
          }
        }
      }
    } catch (err) {
      const classified = active.lifecycle.classify(err);
      if (classified instanceof Error &&
          (classified.name === 'AbortError' || classified.name === 'ProviderPhaseTimeoutError')) {
        accounting.failure(classified, {
          sent: true,
          ...(classified.name === 'AbortError' ? { status: 'interrupted' as const } : {}),
        });
        throw classified;
      }
      const error = new ProviderError(
        `Provider ${this.providerName} stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
        this.providerName,
        undefined,
        err,
        true,
      );
      accounting.failure(error, { sent: true });
      throw error;
    } finally {
      active.lifecycle.cleanup();
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    // Now extract <tool_call> blocks from the full content. Reuse the
    // exact same logic used by the non-streaming path so behaviour
    // matches across modes.
    const { textBefore, toolCalls } = this.extractToolCalls(fullContent);

    // For each parsed tool call, emit a `tool_call` event so display
    // knows tools are about to fire. (We deliberately emit AFTER the
    // text deltas, since Ollama doesn't tell us tool names mid-stream.)
    for (const tc of toolCalls) {
      yield {
        type: 'tool_call',
        toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
      };
    }

    let mappedFinish: ProviderCallOutput['finishReason'];
    if (toolCalls.length > 0) {
      mappedFinish = 'tool_use';
    } else if (doneReason === 'length') {
      mappedFinish = 'length';
    } else {
      mappedFinish = 'stop';
    }

    const output: ProviderCallOutput = {
      content: toolCalls.length > 0 ? textBefore : fullContent,
      toolCalls,
      finishReason: mappedFinish,
      usage: {
        inputTokens: promptEvalCount,
        outputTokens: evalCount,
      },
    };
    accounting.success(output);
    yield { type: 'done', output };
  }

  private buildRequestBody(input: ProviderCallInput): OllamaChatRequest {
    const messages = this.translateMessages(input.messages, input.tools);
    const body: OllamaChatRequest = {
      model: this.model,
      messages,
      stream: false,
    };
    const options: Record<string, unknown> = {};
    if (input.maxTokens != null) options.num_predict = input.maxTokens;
    if (input.temperature != null) options.temperature = input.temperature;
    if (input.extraBody && typeof input.extraBody === 'object') {
      Object.assign(options, input.extraBody);
    }
    if (Object.keys(options).length > 0) body.options = options;
    return body;
  }

  /**
   * Convert v4 Message[] to Ollama messages, injecting the tool catalog
   * into / prepending a system message when tools are provided.
   */
  private translateMessages(messages: Message[], tools: ToolSchema[]): OllamaMessage[] {
    const out: OllamaMessage[] = [];
    const toolPrompt = tools.length > 0 ? this.buildToolPrompt(tools) : '';

    let toolPromptInjected = false;

    for (const msg of messages) {
      switch (msg.role) {
        case 'system': {
          const augmented =
            !toolPromptInjected && toolPrompt
              ? `${msg.content}\n\n${toolPrompt}`
              : msg.content;
          out.push({ role: 'system', content: augmented });
          if (toolPrompt) toolPromptInjected = true;
          break;
        }
        case 'user':
          out.push({ role: 'user', content: msg.content });
          break;
        case 'assistant': {
          // Re-serialize prior tool calls back into <tool_call> tags so the
          // model sees its own canonical history.
          let body = msg.content ?? '';
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const calls = msg.toolCalls.map((tc) =>
              `<tool_call>${JSON.stringify({ name: tc.name, arguments: tc.arguments ?? {} })}</tool_call>`,
            );
            body = body ? `${body}\n${calls.join('\n')}` : calls.join('\n');
          }
          out.push({ role: 'assistant', content: body });
          break;
        }
        case 'tool':
          // Ollama has no native 'tool' role — wrap the result so the model
          // can clearly see which call_id it is responding to.
          out.push({
            role: 'user',
            content: `<tool_response id="${msg.toolCallId}">\n${msg.content}\n</tool_response>`,
          });
          break;
      }
    }

    // Edge case: tools provided but no system message in conversation.
    // Insert a synthetic system message at the head so the model sees the catalog.
    if (toolPrompt && !toolPromptInjected) {
      out.unshift({ role: 'system', content: toolPrompt });
    }

    return out;
  }

  private buildToolPrompt(tools: ToolSchema[]): string {
    const catalog = tools
      .map((t) =>
        JSON.stringify({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }),
      )
      .join('\n');
    return [
      'You have access to the following tools. To call a tool, output exactly:',
      '<tool_call>{"name": "<tool_name>", "arguments": {...}}</tool_call>',
      'You may emit multiple <tool_call> blocks in one turn. After the final closing tag, emit nothing else.',
      'If no tool is needed, respond directly with text.',
      '',
      'Tools:',
      catalog,
    ].join('\n');
  }

  private parseResponse(json: OllamaChatResponse): ProviderCallOutput {
    const message = json.message;
    const rawContent = message?.content ?? '';

    const { textBefore, toolCalls } = this.extractToolCalls(rawContent);

    let finishReason: ProviderCallOutput['finishReason'];
    if (toolCalls.length > 0) {
      finishReason = 'tool_use';
    } else if (json.done_reason === 'length') {
      finishReason = 'length';
    } else {
      finishReason = 'stop';
    }

    return {
      content: toolCalls.length > 0 ? textBefore : rawContent,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
      },
      raw: json,
    };
  }

  /**
   * Pull <tool_call> JSON blobs out of model text.
   * Returns:
   *   - textBefore: text up to (but not including) the first <tool_call> tag.
   *   - toolCalls: parsed tool calls (skips malformed blocks with a warning).
   */
  private extractToolCalls(text: string): {
    textBefore: string;
    toolCalls: ToolCallRequest[];
  } {
    if (!text.includes('<tool_call>')) {
      return { textBefore: text, toolCalls: [] };
    }

    const toolCalls: ToolCallRequest[] = [];
    const pattern = new RegExp(TOOL_CALL_PATTERN.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const raw = (match[1] ?? match[2] ?? '').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { name?: string; arguments?: unknown };
        if (typeof parsed.name !== 'string' || !parsed.name) {
          console.warn(
            `[${this.providerName}] tool_call missing 'name' field; skipping. raw=${raw.slice(0, 100)}`,
          );
          continue;
        }
        const args =
          parsed.arguments != null &&
          typeof parsed.arguments === 'object' &&
          !Array.isArray(parsed.arguments)
            ? (parsed.arguments as Record<string, unknown>)
            : {};
        toolCalls.push({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          name: parsed.name,
          arguments: args,
        });
      } catch {
        console.warn(
          `[${this.providerName}] failed to JSON.parse tool_call body; skipping. raw=${raw.slice(0, 100)}`,
        );
      }
    }

    const firstTagIdx = text.indexOf('<tool_call>');
    const textBefore = firstTagIdx >= 0 ? text.slice(0, firstTagIdx).trim() : text;

    return { textBefore, toolCalls };
  }

  private async fetchWithLifecycle(
    url: string,
    headers: Record<string, string>,
    body: OllamaChatRequest | (Omit<OllamaChatRequest, 'stream'> & { stream: true }),
    externalSignal?: AbortSignal,
  ): Promise<ActiveDispatch> {
    const lifecycle = new RequestLifecycle(this.providerName, this.deadlines, externalSignal);
    try {
      const response = await lifecycle.race(fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      }));
      lifecycle.markHeaders();
      return { response, lifecycle };
    } catch (err) {
      const classified = lifecycle.classify(err);
      lifecycle.cleanup();
      throw classified;
    }
  }

  private backoffMs(attempt: number): number {
    return 500 * attempt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
