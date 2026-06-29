/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * providers/v4/chatCompletionsAdapter.ts
 *
 * Speaks the OpenAI Chat Completions wire format on behalf of every
 * provider Aiden routes through `apiMode === 'chat_completions'` —
 * Together AI, Groq, OpenRouter, Cerebras, NVIDIA NIM, Gemini compat,
 * DeepSeek, xAI, Kimi, and any other endpoint that implements the
 * `/v1/chat/completions` spec.
 *
 * Six wire-format quirks the adapter normalises:
 *   1. `tool_calls[].function.arguments` is a JSON STRING — parsed; bad
 *      JSON falls back to `{}` so the agent loop sees a stable shape.
 *   2. `choices[0].message.content` may be null when the model emitted
 *      only tool calls. Returned as null in Aiden's shape so callers can
 *      distinguish "no message" from "empty message".
 *   3. `finish_reason: 'tool_calls'` (plural) → Aiden `'tool_use'` (singular).
 *   4. Tools wrapped as `{type:'function', function:{name,description,parameters}}`.
 *   5. Usage map: `prompt_tokens` → `inputTokens`, `completion_tokens` → `outputTokens`.
 *   6. Many providers reject >1 system message at the head of the
 *      conversation — fold them into one before sending.
 *
 * Plus a Groq-specific recovery: when Groq's strict tool surface 400s
 * with `tool_use_failed`, the body's `failed_generation` often contains
 * the model's intended tool call in a `<function=name(...)>` legacy
 * syntax. We parse that and synthesise a real tool_call response rather
 * than propagate the 400 — the agent loop runs the tool and the
 * conversation continues.
 *
 * Streaming notes:
 *   - `stream_options: { include_usage: true }` is sent on every
 *     streaming request. Several providers (Groq, Together's Qwen
 *     endpoint) rely on this to emit a final usage-bearing chunk and
 *     close the stream promptly; without it some hold the connection
 *     open longer than necessary.
 *   - Mid-stream provider error frames (`{"error":...}`) are surfaced as
 *     retryable `ProviderError` so the FallbackAdapter advances slots.
 *     OpenRouter and Groq both deliver errors this way for transient
 *     issues.
 */

import type {
  ApiMode,
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  StreamEvent,
  ToolCallRequest,
  ToolSchema,
} from './types';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors';

// ── Public options ──────────────────────────────────────────────────────

export interface ChatCompletionsAdapterOptions {
  /** Full base URL with no trailing slash, e.g. `https://api.groq.com/openai/v1`. */
  baseUrl:        string;
  apiKey:         string;
  model:          string;
  /** Used for error messages and traces. */
  providerName:   string;
  /** Per-request wall-clock. Default 120_000 ms. */
  timeoutMs?:     number;
  /** Retries on 429/5xx/network. Default 2 (so 3 attempts total). */
  maxRetries?:    number;
  /** Header overrides — wins over computed headers. e.g. OpenRouter wants HTTP-Referer + X-Title. */
  extraHeaders?:  Record<string, string>;
  /**
   * Phase v4.1.2-deepseek: model-mandated body fields merged before
   * each call. Resolver populates this from `MODEL_DEFAULTS` keyed by
   * `${providerId}:${modelId}` (see `providers/v4/modelDefaults.ts`).
   * Per-call `input.extraBody` is merged LAST so callers can override
   * a default on a single request without re-registering the model.
   *
   * Used today only by DeepSeek V4-Pro to set
   * `{ thinking: { type: 'enabled' }, reasoning_effort: 'high' }`
   * on every call.
   */
  defaultExtraBody?: Record<string, unknown>;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS  = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_TOKENS  = 4096;
const BACKOFF_BASE_MS     = 1000;

/**
 * v4.11 hi-budget fix — per-provider `max_tokens` cap.
 *
 * Most providers (Anthropic, OpenAI) bill rate limits on actual
 * completion tokens, so `DEFAULT_MAX_TOKENS = 4096` costs nothing
 * unless the model genuinely emits that much. **Groq is the
 * exception**: its TPM (tokens-per-minute) accounting charges
 * `prompt_tokens + max_tokens` — i.e. the *reserved* output budget
 * is billed up front whether the model uses it or not.
 *
 * On the 12K free tier this turns into a fixed 4K/call tax that
 * pushes a bare `"hi"` over the cap even on the `standard` tool
 * profile. Capping Groq at 2048 frees ~2K TPM headroom per request
 * without truncating realistic responses (most turns reply in
 * under 1K tokens; the few that need more can be served by a
 * different provider).
 *
 * Keyed by lowercase provider name (matches
 * `ChatCompletionsAdapterOptions.providerName` after normalisation).
 * Per-call `input.maxTokens` still wins over this map — callers
 * stay in control when they need a different bound.
 */
const GROQ_MAX_OUTPUT_TOKENS = 2048;
const MAX_TOKENS_BY_PROVIDER: Readonly<Record<string, number>> = {
  groq: GROQ_MAX_OUTPUT_TOKENS,
};

/**
 * Resolve the default `max_tokens` for this adapter instance.
 * Resolution order (highest wins):
 *   1. Per-call `input.maxTokens` (handled at the call site)
 *   2. Provider-specific cap from `MAX_TOKENS_BY_PROVIDER`
 *   3. `DEFAULT_MAX_TOKENS` (4096)
 *
 * Exposed for tests + the cli `/doctor` surface.
 */
export function resolveDefaultMaxTokens(providerName: string): number {
  const key = providerName.trim().toLowerCase();
  return MAX_TOKENS_BY_PROVIDER[key] ?? DEFAULT_MAX_TOKENS;
}

// ── Wire types (private, narrow on purpose) ─────────────────────────────

interface WireToolFunction {
  type:     'function';
  function: { name: string; description: string; parameters: ToolSchema['inputSchema'] };
}

interface WireToolCall {
  id:        string;
  type:      'function';
  function:  { name: string; arguments: string };
  /** Streaming chunks carry an index; non-streaming responses do not. */
  index?:    number;
}

interface WireMessage {
  role:           'system' | 'user' | 'assistant' | 'tool';
  content:        string | null;
  tool_calls?:    WireToolCall[];
  tool_call_id?:  string;
}

interface WireChoice {
  message: {
    role:         string;
    content:      string | null;
    tool_calls?:  WireToolCall[];
  };
  finish_reason: string | null;
}

interface WireResponse {
  choices: WireChoice[];
  usage?:  {
    prompt_tokens?:               number;
    completion_tokens?:           number;
    /** Anthropic-style cache fields some OAI-compat providers include. */
    cache_read_input_tokens?:     number;
    cache_creation_input_tokens?: number;
  };
}

interface WireRequestBody {
  model:           string;
  messages:        WireMessage[];
  max_tokens:      number;
  tools?:          WireToolFunction[];
  tool_choice?:    'auto';
  temperature?:    number;
  stream?:         boolean;
  stream_options?: { include_usage?: boolean };
  [extra: string]: unknown;
}

// ── Adapter ─────────────────────────────────────────────────────────────

export class ChatCompletionsAdapter implements ProviderAdapter {
  readonly apiMode: ApiMode = 'chat_completions';

  private readonly endpoint:     string;
  private readonly apiKey:       string;
  private readonly model:        string;
  private readonly providerName: string;
  private readonly timeoutMs:    number;
  private readonly maxRetries:   number;
  private readonly extraHeaders: Record<string, string>;
  /** Phase v4.1.2-deepseek: model-mandated body fields merged on every call. */
  private readonly defaultExtraBody?: Record<string, unknown>;

  constructor(opts: ChatCompletionsAdapterOptions) {
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.endpoint         = `${baseUrl}/chat/completions`;
    this.apiKey           = opts.apiKey;
    this.model            = opts.model;
    this.providerName     = opts.providerName;
    this.timeoutMs        = opts.timeoutMs  ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries       = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders     = opts.extraHeaders ?? {};
    this.defaultExtraBody = opts.defaultExtraBody;
  }

  // ── Non-streaming ────────────────────────────────────────────────────

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body  = this.buildBody(input, /* streaming */ false);
    const reply = await this.dispatch(body, /* streaming */ false, input.signal);
    const text  = await reply.text();
    let parsed: WireResponse;
    try {
      parsed = JSON.parse(text) as WireResponse;
    } catch {
      throw new ProviderError(
        `Provider ${this.providerName} returned non-JSON body`,
        this.providerName,
        reply.status,
        text,
        false,
      );
    }
    // Phase 28.2 — pass the request's tool-name set so the bare-JSON
    // inline-tool-call detector can validate names against the schemas
    // the provider was actually offered.
    const knownToolNames = collectKnownToolNames(input);
    return decodeChoice(parsed, knownToolNames);
  }

  // ── Streaming ────────────────────────────────────────────────────────

  async *callStream(input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void> {
    const body  = this.buildBody(input, /* streaming */ true);
    const reply = await this.dispatch(body, /* streaming */ true, input.signal);
    if (!reply.body) {
      yield {
        type: 'done',
        output: {
          content:      '',
          toolCalls:    [],
          finishReason: 'error',
          usage:        { inputTokens: 0, outputTokens: 0 },
        },
      };
      return;
    }
    const knownToolNames = collectKnownToolNames(input);
    yield* decodeStream(reply.body, this.providerName, knownToolNames);
  }

  // ── Body assembly ────────────────────────────────────────────────────

  private buildBody(input: ProviderCallInput, streaming: boolean): WireRequestBody {
    const body: WireRequestBody = {
      model:      this.model,
      messages:   encodeMessages(input.messages),
      max_tokens: input.maxTokens ?? resolveDefaultMaxTokens(this.providerName),
    };
    if (input.tools && input.tools.length > 0) {
      body.tools       = input.tools.map(toWireTool);
      body.tool_choice = 'auto';
    }
    if (typeof input.temperature === 'number') body.temperature = input.temperature;
    if (streaming) {
      body.stream         = true;
      // `include_usage: true` — what the OpenAI SDK sends by default.
      // Several providers (Groq, Together's Qwen endpoint) hold the
      // connection open longer when this flag is absent. Request usage so
      // the stream closes promptly and we get accurate token accounting.
      body.stream_options = { include_usage: true };
    }
    // Phase v4.1.2-deepseek: merge order is base body → defaultExtraBody
    // (model-mandated, from resolver lookup in MODEL_DEFAULTS) → per-call
    // input.extraBody (caller). Per-call wins so a single request can
    // override a default (e.g. disabling thinking on a probe). This
    // matters because providers/v4/modelDefaults.ts sets thinking +
    // reasoning_effort for deepseek-v4-pro on EVERY call.
    if (this.defaultExtraBody) Object.assign(body, this.defaultExtraBody);
    if (input.extraBody)       Object.assign(body, input.extraBody);
    return body;
  }

  // ── Network with retry/timeout ───────────────────────────────────────

  private buildHeaders(streaming: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    if (streaming) headers['Accept'] = 'text/event-stream';
    return { ...headers, ...this.extraHeaders };
  }

  private async dispatch(
    body: WireRequestBody,
    streaming: boolean,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const headers    = this.buildHeaders(streaming);
    const serialised = JSON.stringify(body);
    const totalTries = this.maxRetries + 1;

    let lastErr: unknown = null;

    for (let attempt = 0; attempt < totalTries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      // v4.6 prep — forward external abort into the internal controller.
      // External aborts surface as raw AbortError so AidenAgent routes
      // them as 'interrupted' rather than retrying as ProviderTimeoutError.
      let externalAbortHandler: (() => void) | null = null;
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort();
        } else {
          externalAbortHandler = () => controller.abort();
          externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
        }
      }

      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method:  'POST',
          headers,
          body:    serialised,
          signal:  controller.signal,
        });
      } catch (err: any) {
        clearTimeout(timer);
        if (externalAbortHandler && externalSignal) {
          externalSignal.removeEventListener('abort', externalAbortHandler);
        }
        if (err?.name === 'AbortError') {
          // v4.6 prep — external abort takes priority over internal timeout.
          if (externalSignal?.aborted) {
            throw err;
          }
          lastErr = new ProviderTimeoutError(this.providerName, this.timeoutMs);
        } else {
          lastErr = new ProviderError(
            `Network failure calling ${this.providerName}: ${err?.message ?? err}`,
            this.providerName,
            undefined,
            err,
            true,
          );
        }
        if (attempt < totalTries - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      }
      clearTimeout(timer);
      if (externalAbortHandler && externalSignal) {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }

      if (response.ok) return response;

      const status = response.status;

      // Groq's `tool_use_failed` 400 sometimes carries the model's tool
      // call inline in `failed_generation`. Recover it into a synthetic
      // tool_use response instead of failing the turn. Only the
      // non-streaming path reaches here with a body — the streaming
      // path's 4xx already failed before the body would be relevant.
      if (status === 400 && !streaming) {
        const recoveredBody = await response.text();
        const recovered = tryRecoverLegacyToolCall(recoveredBody);
        if (recovered) {
          return synthesiseRecoveredResponse(recovered);
        }
        throw new ProviderError(
          `Provider ${this.providerName} returned 400 Bad Request`,
          this.providerName,
          400,
          tryParseJson(recoveredBody),
          false,
        );
      }

      const raw = await safeReadBody(response);

      if (status === 429) {
        if (attempt < totalTries - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ProviderRateLimitError(this.providerName, raw);
      }

      if (status >= 500 && status < 600) {
        if (attempt < totalTries - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ProviderError(
          `Provider ${this.providerName} server error ${status}`,
          this.providerName,
          status,
          raw,
          true,
        );
      }

      throw new ProviderError(
        `Provider ${this.providerName} request failed (${status})`,
        this.providerName,
        status,
        raw,
        false,
      );
    }

    throw lastErr instanceof Error
      ? lastErr
      : new ProviderError(`Provider ${this.providerName} failed after retries`, this.providerName);
  }
}

// ── Encoders ────────────────────────────────────────────────────────────

function toWireTool(t: ToolSchema): WireToolFunction {
  return {
    type:     'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  };
}

/**
 * Walk Aiden's flat `Message[]` into OpenAI's wire shape.
 *
 *   - Multiple leading system messages get folded into a single
 *     `{role:'system'}` entry — providers like Groq reject duplicates.
 *   - Assistant turns with tool calls send `content: null` plus a
 *     `tool_calls[]` array; arguments stringified per the spec.
 *   - Tool replies translate to `{role:'tool', tool_call_id, content}`.
 */
function encodeMessages(messages: Message[]): WireMessage[] {
  const out:        WireMessage[] = [];
  const sysParts:   string[]      = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      sysParts.push(msg.content);
      continue;
    }

    if (out.length === 0 && sysParts.length > 0) {
      out.push({ role: 'system', content: sysParts.join('\n\n') });
      sysParts.length = 0;
    }

    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'tool') {
      out.push({
        role:          'tool',
        content:       msg.content,
        tool_call_id:  msg.toolCallId,
      });
      continue;
    }

    // assistant
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      out.push({
        role:        'assistant',
        content:     msg.content || null,
        tool_calls:  msg.toolCalls.map((tc) => ({
          id:        tc.id,
          type:      'function',
          function:  {
            name:      tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        })),
      });
    } else {
      out.push({ role: 'assistant', content: msg.content });
    }
  }

  // System-only conversation — flush whatever accumulated.
  if (out.length === 0 && sysParts.length > 0) {
    out.push({ role: 'system', content: sysParts.join('\n\n') });
  }

  return out;
}

// ── Decoders ────────────────────────────────────────────────────────────

function decodeChoice(
  reply: WireResponse,
  knownToolNames?: ReadonlySet<string>,
): ProviderCallOutput {
  const choice = reply.choices?.[0];
  if (!choice) {
    return {
      content:      '',
      toolCalls:    [],
      finishReason: 'error',
      usage:        decodeUsage(reply.usage),
      raw:          reply,
    };
  }

  const message       = choice.message ?? {} as WireChoice['message'];
  const wireToolCalls = message.tool_calls ?? [];
  // `content` may be `null` when the model emitted only tool calls. We
  // preserve that null so the agent loop can distinguish "no message"
  // from an empty string. Inline-tool recovery only fires on actual
  // string content.
  let contentText: string | null = message.content ?? null;
  let toolCalls   = wireToolCalls.map(decodeToolCall);

  if (typeof contentText === 'string' && contentText.length > 0
      && toolCalls.length === 0) {
    const inline = extractInlineToolCalls(contentText, knownToolNames);
    if (inline) {
      contentText = inline.content;
      toolCalls   = inline.toolCalls;
    }
  }

  return {
    content:      contentText,
    toolCalls,
    finishReason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    usage:        decodeUsage(reply.usage),
    raw:          reply,
  };
}

function decodeToolCall(tc: WireToolCall): ToolCallRequest {
  return {
    id:        tc.id,
    name:      tc.function?.name ?? '',
    arguments: parseToolArgs(tc.function?.arguments ?? ''),
  };
}

function decodeUsage(u: WireResponse['usage']): ProviderCallOutput['usage'] {
  const out: ProviderCallOutput['usage'] = {
    inputTokens:  u?.prompt_tokens     ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
  };
  if (typeof u?.cache_read_input_tokens === 'number') {
    out.cacheReadTokens = u.cache_read_input_tokens;
  }
  if (typeof u?.cache_creation_input_tokens === 'number') {
    out.cacheWriteTokens = u.cache_creation_input_tokens;
  }
  return out;
}

function mapFinishReason(
  raw: string | null | undefined,
  hasToolCalls: boolean,
): ProviderCallOutput['finishReason'] {
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool_use';
  if (raw === 'length')                                return 'length';
  if (hasToolCalls && (raw === null || raw === undefined || raw === 'stop')) {
    return 'tool_use';
  }
  return 'stop';
}

/** JSON.parse with a `{}` fallback on any failure. Used by inline
 *  recovery paths where malformed input is expected and silent. */
function parseJsonSafely(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object' && !Array.isArray(v))
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Same as parseJsonSafely but emits a warn line — `tool_calls.arguments`
 * being unparseable is a model bug worth surfacing in logs (the agent
 * loop still continues with `{}`, so it's a warning rather than an
 * error).
 */
function parseToolArgs(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object' && !Array.isArray(v))
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      '[chatCompletionsAdapter] tool_calls.arguments is not valid JSON; ' +
      'falling back to {}',
    );
    return {};
  }
}

// ── SSE stream parsing ──────────────────────────────────────────────────

/**
 * Read an SSE-encoded ReadableStream and yield the `data:` payload
 * strings, in order. `data: [DONE]` and blank lines are passed through
 * verbatim — callers filter as needed. Comment lines (starting with `:`)
 * are skipped. Cross-chunk byte boundaries inside a `data:` line are
 * preserved by holding the trailing partial line until the next chunk.
 *
 * Re-used by the Anthropic adapter for its event stream too.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader  = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer    = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) {
        buffer += decoder.decode();   // flush any pending bytes
        if (buffer.length > 0) {
          for (const payload of extractDataLines(buffer + '\n')) yield payload;
        }
        return;
      }

      // Process complete lines; keep the trailing partial in `buffer`.
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) continue;
      const ready  = buffer.slice(0, lastNewline + 1);
      buffer       = buffer.slice(lastNewline + 1);
      for (const payload of extractDataLines(ready)) yield payload;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* may already be released */ }
  }
}

function* extractDataLines(block: string): Generator<string, void, void> {
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0)            continue;   // event boundary
    if (line.startsWith(':'))         continue;   // SSE comment
    if (line.startsWith('data:')) {
      yield line.slice(5).replace(/^ /, '');
    }
  }
}

// ── Streaming decoder ───────────────────────────────────────────────────
//
// OpenAI's chat completions stream emits chunks shaped like:
//
//   { choices: [ { delta: { content?: string, tool_calls?: [...] },
//                  finish_reason?: string } ] }
//
// Tool calls stream in incrementally — the first chunk for a tool carries
// `id` + `name`; subsequent chunks carry partial `arguments`. We:
//   - emit a `tool_call` event the moment a tool index first shows up
//     with id+name (consumer needs this fast for UI mode-switching),
//   - accumulate argument fragments per index,
//   - SUPPRESS text deltas after the first tool_call event — once the
//     model is in tool mode any text fragments are scratch and replaying
//     them confuses display layers,
//   - on `finish_reason`, parse buffered tool args, build the final
//     ProviderCallOutput, yield `done`, and stop.
//
// Mid-stream provider error frames (`{"error":...}`) are surfaced as
// retryable ProviderErrors so the FallbackAdapter advances slots.

interface StreamingTool {
  id:    string;
  name:  string;
  args:  string;       // accumulated JSON string
}

async function* decodeStream(
  body:           ReadableStream<Uint8Array>,
  providerName:   string,
  knownToolNames?: ReadonlySet<string>,
): AsyncGenerator<StreamEvent, void, void> {
  const tools:     Map<number, StreamingTool> = new Map();
  let textBuffer:  string                = '';
  let finishReason: string | null        = null;
  let usage:       WireResponse['usage'] = undefined;
  let toolMode     = false;

  for await (const payload of parseSseStream(body)) {
    if (!payload || payload === '[DONE]') continue;
    let chunk: any;
    try { chunk = JSON.parse(payload); }
    catch { continue; }

    // Mid-stream provider error frames. Some providers (OpenRouter,
    // Groq with `tool_use_failed`, Together when a backend transient
    // hits) embed the error inside the SSE stream rather than closing
    // the connection or returning a 4xx/5xx. Surface these so the
    // FallbackAdapter can advance slots — silently `continue`-ing
    // would make the loop wait until the server eventually closes,
    // which can be tens of seconds.
    if (chunk?.error) {
      const recovered = tryRecoverLegacyToolCall(
        JSON.stringify({ error: chunk.error }),
      );
      if (recovered) {
        for (const tc of recovered.toolCalls) {
          yield { type: 'tool_call', toolCall: tc };
        }
        yield {
          type: 'done',
          output: {
            content:      '',
            toolCalls:    recovered.toolCalls,
            finishReason: recovered.finishReason,
            usage:        decodeUsage(usage),
          },
        };
        return;
      }
      const message: string =
        (chunk.error && typeof chunk.error.message === 'string')
          ? chunk.error.message
          : 'unknown';
      throw new ProviderError(
        `Provider ${providerName} stream error: ${message}`,
        providerName,
        undefined,
        chunk.error,
        true,
      );
    }

    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!toolMode) {
        textBuffer += delta.content;
        yield { type: 'delta', content: delta.content };
      }
      // else: suppress — model is in tool mode, this is scratch text.
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tcDelta of delta.tool_calls as WireToolCall[]) {
        const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
        let tool = tools.get(idx);
        const incomingId   = tcDelta.id;
        const incomingName = tcDelta.function?.name;
        if (!tool) {
          if (incomingId && incomingName) {
            tool = { id: incomingId, name: incomingName, args: '' };
            tools.set(idx, tool);
            toolMode = true;
            yield {
              type:     'tool_call',
              toolCall: { id: incomingId, name: incomingName, arguments: {} },
            };
          } else {
            // First we hear of this index but no id/name yet — wait.
            continue;
          }
        }
        // Some providers send the id later in the stream; fill in if so.
        if (!tool.id   && incomingId)   tool.id   = incomingId;
        if (!tool.name && incomingName) tool.name = incomingName;

        const argFragment = tcDelta.function?.arguments;
        if (typeof argFragment === 'string' && argFragment.length > 0) {
          tool.args += argFragment;
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const finalisedToolCalls: ToolCallRequest[] = Array.from(tools.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id:        t.id,
      name:      t.name,
      arguments: parseJsonSafely(t.args),
    }));

  // If the model emitted only inline-syntax tool calls in the text body,
  // recover them now so the streaming and non-streaming paths agree.
  let content: string | null = textBuffer;
  let toolCalls = finalisedToolCalls;
  if (content && toolCalls.length === 0) {
    const inline = extractInlineToolCalls(content, knownToolNames);
    if (inline) {
      content   = inline.content;
      toolCalls = inline.toolCalls;
    }
  }

  yield {
    type: 'done',
    output: {
      content,
      toolCalls,
      finishReason: mapFinishReason(finishReason, toolCalls.length > 0),
      usage:        decodeUsage(usage),
    },
  };
}

// ── Legacy `<function=…>` syntax recovery ───────────────────────────────
//
// Three forms are recognised in real-world model output:
//
//   PAREN     <function=foo({"a":1})>
//   XML-OBJ   <function=foo {"a":1}</function>
//   XML-ARR   <function=foo [{"a":1}]</function>           (singleton arrays only)
//
// Used for two purposes:
//   a) Inline recovery on a successful response whose `tool_calls[]` is
//      empty but whose `content` text contains a function call.
//   b) Recovery on Groq's `tool_use_failed` 400 where the body's
//      `error.failed_generation` contains the rejected call.

interface LegacyCall { name: string; args: Record<string, unknown> }

/** Shape returned by both legacy-syntax recovery helpers. */
export interface LegacyRecoveryResult {
  toolCalls:    ToolCallRequest[];
  finishReason: 'tool_use';
}

/**
 * Parse a body of text for `<function=…>` calls. Returns
 * `{toolCalls, finishReason: 'tool_use'}` when at least one call was
 * recovered; `null` otherwise (so callers can short-circuit cheaply).
 */
export function parseLegacyFunctionSyntax(
  text: string,
): LegacyRecoveryResult | null {
  if (!text || !text.includes('<function=')) return null;
  const calls: LegacyCall[] = [];

  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<function=', cursor);
    if (start === -1) break;
    const nameStart = start + '<function='.length;

    // Name runs until the first separator (paren, whitespace).
    let nameEnd = nameStart;
    while (nameEnd < text.length && !/[(\s]/.test(text[nameEnd])) nameEnd++;
    const name = text.slice(nameStart, nameEnd).trim();

    // Walk forward past whitespace to the args region.
    let argsStart = nameEnd;
    while (argsStart < text.length && /\s/.test(text[argsStart])) argsStart++;

    let args: Record<string, unknown> = {};
    let consumeUpTo = argsStart;

    if (text[argsStart] === '(') {
      // PAREN form: args is a balanced-paren region containing JSON object.
      const closeParen = matchBalanced(text, argsStart, '(', ')');
      if (closeParen === -1) break;
      const inner = text.slice(argsStart + 1, closeParen).trim();
      args = decodeArgs(inner);
      consumeUpTo = closeParen + 1;
      if (text[consumeUpTo] === '>') consumeUpTo += 1;
    } else if (text[argsStart] === '{') {
      // XML-OBJ form: balanced braces, then `</function>` closer.
      const closeBrace = matchBalanced(text, argsStart, '{', '}');
      if (closeBrace === -1) break;
      args = decodeArgs(text.slice(argsStart, closeBrace + 1));
      consumeUpTo = closeBrace + 1;
      const endTag = text.indexOf('</function>', consumeUpTo);
      if (endTag !== -1) consumeUpTo = endTag + '</function>'.length;
    } else if (text[argsStart] === '[') {
      // XML-ARR form: balanced brackets, accept singleton arrays only.
      const closeBracket = matchBalanced(text, argsStart, '[', ']');
      if (closeBracket === -1) break;
      const arrayText = text.slice(argsStart, closeBracket + 1);
      try {
        const parsed = JSON.parse(arrayText);
        if (Array.isArray(parsed) && parsed.length === 1
            && parsed[0] && typeof parsed[0] === 'object'
            && !Array.isArray(parsed[0])) {
          args = parsed[0] as Record<string, unknown>;
        }
      } catch { /* fall back to {} */ }
      consumeUpTo = closeBracket + 1;
      const endTag = text.indexOf('</function>', consumeUpTo);
      if (endTag !== -1) consumeUpTo = endTag + '</function>'.length;
    } else {
      cursor = nameEnd;
      continue;
    }

    if (name) calls.push({ name, args });
    cursor = consumeUpTo;
  }

  if (calls.length === 0) return null;
  return {
    toolCalls: calls.map((c, idx) => ({
      id:        `call_inline_${idx}`,
      name:      c.name,
      arguments: c.args,
    })),
    finishReason: 'tool_use',
  };
}

/**
 * Walk a balanced `(open, close)` region starting at `text[fromIdx]`.
 * Returns the index of the matching close char, or -1 if unmatched.
 * String literals (`"..."`) are skipped so braces inside JSON keys/
 * values don't disturb the count.
 */
function matchBalanced(text: string, fromIdx: number, open: string, close: string): number {
  if (text[fromIdx] !== open) return -1;
  let depth   = 0;
  let inStr   = false;
  let escaped = false;
  for (let i = fromIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped)        { escaped = false; continue; }
      if (ch === '\\')    { escaped = true;  continue; }
      if (ch === '"')     { inStr   = false; continue; }
      continue;
    }
    if (ch === '"')   { inStr = true; continue; }
    if (ch === open)  { depth++; }
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function decodeArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Scan `text` for inline tool-call markers in any of three recovery
 * formats Aiden recognises:
 *
 *   1. `<function=name(...)>`  / `<function=name {...}</function>`
 *      — Groq / Llama legacy syntax. Handled by `parseLegacyFunctionSyntax`.
 *   2. `<tool_call>{"name":…, "arguments":…}</tool_call>`
 *      — public XML tool-call format used by Qwen and several other
 *      open-source instruction-tuned models; closing tag may be missing
 *      (truncated generation) which we still recover from.
 *   3. **Phase 28.2** — bare JSON `{"name": "...", "parameters"|"arguments": {...}}`
 *      with NO surrounding tags. Llama / Qwen / NVIDIA-Llama
 *      occasionally emit raw tool calls inside their answer text.
 *      The bare-JSON detector is **conservative**: it only fires when
 *      `knownToolNames` is provided AND the parsed `name` is in that
 *      set. Code-fenced blocks (``` … ``` and `inline`) are masked out
 *      first so JSON in code samples is left alone.
 *
 * Returns `null` when no recoverable marker is present at all so callers
 * can short-circuit cheaply. On recovery returns `{toolCalls, content}`
 * with the markers stripped from `content` (or `content: null` when the
 * stripped text is empty). All ids are synthesised as `tc-inline-<n>`.
 */
export function extractInlineToolCalls(
  text: string | null | undefined,
  knownToolNames?: ReadonlySet<string>,
): { content: string | null; toolCalls: ToolCallRequest[] } | null {
  if (!text) return null;

  const fromFunctionSyntax = parseLegacyFunctionSyntax(text);
  const fromTagSyntax      = parseToolCallTags(text);

  // Coarse strip of the legacy marker formats; the bare-JSON detector
  // runs against the residual so a raw JSON object that follows a
  // legacy tag in the same response is still caught.
  let stripped = text;
  if (fromFunctionSyntax || fromTagSyntax) {
    stripped = text
      .replace(
        /<function=[^(<\s]+\s*(?:\([^]*?\)>|\{[^]*?\}<\/function>|\[[^]*?\]<\/function>)/g,
        '',
      )
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<tool_call>[\s\S]*$/g, '');
  }

  const fromRawJson = knownToolNames && knownToolNames.size > 0
    ? parseRawJsonToolCalls(stripped, knownToolNames)
    : null;

  if (!fromFunctionSyntax && !fromTagSyntax && !fromRawJson) return null;

  const toolCalls: ToolCallRequest[] = [];
  let n = 0;
  if (fromFunctionSyntax) {
    for (const tc of fromFunctionSyntax.toolCalls) {
      toolCalls.push({ ...tc, id: `tc-inline-${n++}` });
    }
  }
  if (fromTagSyntax) {
    for (const c of fromTagSyntax) {
      toolCalls.push({ id: `tc-inline-${n++}`, name: c.name, arguments: c.args });
    }
  }
  if (fromRawJson) {
    for (const c of fromRawJson.calls) {
      toolCalls.push({ id: `tc-inline-${n++}`, name: c.name, arguments: c.args });
    }
  }

  const finalText = (fromRawJson ? fromRawJson.stripped : stripped).trim();
  return {
    content:   finalText.length > 0 ? finalText : null,
    toolCalls,
  };
}

/**
 * Phase 28.2 — bare-JSON tool-call detector. Walks `text`, masking
 * out fenced code blocks (``` … ```) and inline backticks, then scans
 * for balanced `{ … }` blocks whose JSON shape is
 *   `{ "name": "<known>", "parameters"|"arguments": { … } }`.
 *
 * Only fires when `name` is in `knownToolNames` (otherwise a model
 * that quotes a JSON example in its answer would auto-execute random
 * shapes). Returns `{ calls, stripped }` with the matched JSON spans
 * removed from `text`, or `null` when nothing fired.
 */
function parseRawJsonToolCalls(
  text: string,
  knownToolNames: ReadonlySet<string>,
): { calls: LegacyCall[]; stripped: string } | null {
  if (!text) return null;
  const masked = maskCodeBlocksForScan(text);

  const calls: LegacyCall[] = [];
  const removeRanges: Array<[number, number]> = [];
  let cursor = 0;
  while (cursor < masked.length) {
    const open = masked.indexOf('{', cursor);
    if (open === -1) break;
    const close = matchBalanced(masked, open, '{', '}');
    if (close === -1) break;
    const slice = masked.slice(open, close + 1);
    let parsed: unknown;
    try { parsed = JSON.parse(slice); }
    catch { cursor = open + 1; continue; }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const name = obj.name;
      const argsRaw = (obj.parameters ?? obj.arguments) as unknown;
      if (
        typeof name === 'string' &&
        argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw) &&
        knownToolNames.has(name)
      ) {
        calls.push({ name, args: argsRaw as Record<string, unknown> });
        removeRanges.push([open, close + 1]);
        cursor = close + 1;
        continue;
      }
    }
    cursor = open + 1;
  }

  if (calls.length === 0) return null;

  // Strip ranges from original text in reverse so earlier indexes stay valid.
  let stripped = text;
  for (const [start, end] of [...removeRanges].reverse()) {
    stripped = stripped.slice(0, start) + stripped.slice(end);
  }
  return { calls, stripped };
}

/**
 * Phase 28.2 — collect the set of tool names this request was made
 * with. Used by the bare-JSON tool-call detector to validate inline
 * `{"name": "..."}` candidates against the schemas the provider
 * was actually offered. Empty set when no tools were sent (the
 * detector then no-ops and the legacy paths still apply).
 */
function collectKnownToolNames(input: ProviderCallInput): Set<string> {
  const out = new Set<string>();
  if (input.tools) {
    for (const t of input.tools) {
      if (t && typeof t.name === 'string' && t.name.length > 0) out.add(t.name);
    }
  }
  return out;
}

/**
 * Replace fenced code blocks and inline backticks with same-length
 * whitespace so position-based scanners can ignore JSON inside them
 * without losing index alignment with the original text.
 */
function maskCodeBlocksForScan(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * Parse `<tool_call>{...}</tool_call>` (and the unclosed `<tool_call>{...}`
 * variant) into a list of `{name, args}` records, or `null` when no
 * marker matched cleanly. Tags whose JSON body is malformed, missing the
 * required `name` key, or has a non-object `arguments` value are skipped
 * silently — partial recovery is better than nothing, but we never
 * fabricate a tool name.
 */
function parseToolCallTags(text: string): LegacyCall[] | null {
  if (!text || !text.includes('<tool_call>')) return null;
  const TAG = '<tool_call>';
  const calls: LegacyCall[] = [];

  let cursor = 0;
  while (cursor < text.length) {
    const tagStart = text.indexOf(TAG, cursor);
    if (tagStart === -1) break;
    const afterTag = tagStart + TAG.length;

    const jsonStart = text.indexOf('{', afterTag);
    if (jsonStart === -1) break;

    const jsonEnd = matchBalanced(text, jsonStart, '{', '}');
    if (jsonEnd === -1) {
      cursor = afterTag;
      continue;
    }

    const slice = text.slice(jsonStart, jsonEnd + 1);
    let parsed: any;
    try { parsed = JSON.parse(slice); }
    catch { cursor = jsonEnd + 1; continue; }

    if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string'
        || parsed.name.length === 0) {
      cursor = jsonEnd + 1;
      continue;
    }

    const args =
      parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
        ? (parsed.arguments as Record<string, unknown>)
        : {};
    calls.push({ name: parsed.name, args });

    let after = jsonEnd + 1;
    const closeIdx = text.indexOf('</tool_call>', after);
    if (closeIdx !== -1 && closeIdx - after <= 8) {
      after = closeIdx + '</tool_call>'.length;
    }
    cursor = after;
  }

  return calls.length > 0 ? calls : null;
}

/**
 * Recover the tool call(s) from a Groq `tool_use_failed` 400 body.
 * Returns `null` when the body isn't tool_use_failed, isn't JSON, or
 * carries no recoverable inline syntax.
 */
export function tryRecoverLegacyToolCall(
  rawBody: string,
): LegacyRecoveryResult | null {
  if (!rawBody) return null;
  let body: any;
  try { body = JSON.parse(rawBody); } catch { return null; }
  const code = body?.error?.code ?? body?.error?.type;
  if (code !== 'tool_use_failed' && code !== 'tool_use_failed_to_validate') {
    return null;
  }
  const generation: string | undefined = body?.error?.failed_generation;
  if (typeof generation !== 'string' || !generation.includes('<function=')) {
    return null;
  }
  return parseLegacyFunctionSyntax(generation);
}

/**
 * Build a synthetic `Response` whose body is a chat completions reply
 * carrying the recovered tool call(s). Used when `dispatch()` rescues a
 * Groq `tool_use_failed` 400 — the caller's `response.text() + JSON.parse`
 * path still works without conditional branching.
 */
function synthesiseRecoveredResponse(recovered: LegacyRecoveryResult): Response {
  const wireBody: WireResponse = {
    choices: [
      {
        message: {
          role:    'assistant',
          content: null,
          tool_calls: recovered.toolCalls.map((tc) => ({
            id:        tc.id,
            type:      'function',
            function:  {
              name:      tc.name,
              arguments: JSON.stringify(tc.arguments ?? {}),
            },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
  return new Response(JSON.stringify(wireBody), {
    status:     200,
    statusText: 'OK',
    headers:    { 'Content-Type': 'application/json' },
  });
}

// ── Misc helpers ────────────────────────────────────────────────────────

function backoffMs(attempt: number): number {
  const base   = BACKOFF_BASE_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * Math.min(BACKOFF_BASE_MS, base / 4));
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadBody(r: Response): Promise<unknown> {
  try {
    const text = await r.text();
    return tryParseJson(text);
  } catch {
    return null;
  }
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
