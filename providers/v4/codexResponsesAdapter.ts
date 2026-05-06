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
 * providers/v4/codexResponsesAdapter.ts — Aiden v4.0.0
 *
 * Adapter for OpenAI's /v1/responses (Codex) wire format.
 *
 * Status: PHASE 4 — minimum-viable API-key path. Sufficient to validate the
 *   wire-format mapping (request shape, response.output[] item parsing,
 *   finish-reason semantics). Full feature set lands Phase 13:
 *     - ChatGPT subscription OAuth flow
 *     - Reasoning-item replay (encrypted_content round-trip)
 *     - Streaming
 *     - prompt_cache_key + Codex-backend session_id headers
 *     - xAI / GitHub Models / chatgpt.com backend variants
 *     - _preflight_codex_api_kwargs sanitization
 *
 * No real-network integration test in Phase 4 — gated on Phase 13 OAuth wiring
 * and an OpenAI Responses-API key (gpt-5-codex is gated). Unit tests with
 * mocked fetch carry the load until then.
 *
 * Hermes reference: agent/transports/codex.py + agent/codex_responses_adapter.py
 *
 * Wire-format quirks handled here:
 *   1. Endpoint: /v1/responses (NOT /v1/chat/completions).
 *   2. Top-level `instructions` field carries the system prompt; messages array
 *      becomes `input` items.
 *   3. Tool schema is FLAT: {type:'function', name, description, strict, parameters}
 *      (no nested function: {...}).
 *   4. Response.output[] is a list of items: message / reasoning / function_call.
 *   5. response.status ∈ {completed, incomplete, failed, cancelled}; mapped to
 *      v4's {stop, tool_use, length}.
 *   6. Empty output[] with output_text backfill is legal (rare stream-recovery case).
 *   7. Usage at response.usage.{input_tokens, output_tokens, cached_tokens}.
 *   8. store=false default — we do not persist threads server-side.
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
import { parseSseStream } from './chatCompletionsAdapter';

/**
 * Phase 21 #6 reopen — pull `chatgpt_account_id` out of an OpenAI OAuth
 * JWT's `https://api.openai.com/auth` claim. Used to populate the
 * `ChatGPT-Account-ID` header that the Codex Cloudflare layer requires.
 *
 * Direct port of Hermes `agent/auxiliary_client.py:_codex_cloudflare_headers`
 * (lines 384-396): tolerates malformed tokens silently (returns null) so
 * a bad bearer surfaces as a 401 from the backend instead of a crash at
 * adapter construction.
 *
 * Exported for unit tests.
 */
export function extractChatGptAccountId(accessToken: string | null | undefined): string | null {
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    return null;
  }
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    // base64url + padding compensation, matching Python's `parts[1] + "=" * (-len(...) % 4)`
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(json) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      const acct = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof acct === 'string' && acct.length > 0) return acct;
    }
  } catch {
    /* malformed token — drop the header */
  }
  return null;
}

export interface CodexResponsesAdapterOptions {
  /** Default 'https://api.openai.com/v1'. No trailing slash. */
  baseUrl?: string;
  /** Bearer token. */
  apiKey: string;
  /** e.g. 'gpt-5-codex', 'gpt-4.1-mini'. */
  model: string;
  /** For error messages and logging. */
  providerName: string;
  /** Per-request timeout. Default 120_000. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network. Default 2 (3 attempts total). */
  maxRetries?: number;
  /** Extra headers (escape hatch). */
  extraHeaders?: Record<string, string>;
}

interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  strict: boolean;
  parameters: ToolSchema['inputSchema'];
}

interface ResponsesInputContentPart {
  type: 'input_text' | 'output_text';
  text: string;
}

interface ResponsesMessageItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: ResponsesInputContentPart[];
}

interface ResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

interface ResponsesOutputMessage {
  type: 'message';
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  status?: string;
}

interface ResponsesOutputFunctionCall {
  type: 'function_call';
  id?: string;
  call_id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
  status?: string;
}

interface ResponsesOutputReasoning {
  type: 'reasoning';
  encrypted_content?: string;
  summary?: Array<{ type: string; text?: string }>;
}

type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning
  | { type: string; [k: string]: unknown };

interface ResponsesAPIResponse {
  output?: ResponsesOutputItem[];
  output_text?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Phase 21 #6c — apply per-item text buffers (collected from
 * `response.output_text.delta` events) to message items inside an
 * aggregated ResponsesAPIResponse. Used as a defensive fallback when
 * `response.completed` arrives before all delta-bound items, or when
 * the stream ends without a `completed` event.
 */
function applyTextBuffers(
  resp: ResponsesAPIResponse,
  buffers: Map<string, string>,
): void {
  if (!Array.isArray(resp.output)) return;
  for (const item of resp.output) {
    const id = (item as { id?: string }).id ?? '';
    const buf = buffers.get(id);
    if (!buf || (item as { type?: string }).type !== 'message') continue;
    const msg = item as ResponsesOutputMessage;
    if (!Array.isArray(msg.content) || msg.content.length === 0) {
      msg.content = [{ type: 'output_text', text: buf }];
    } else {
      // If content already has text parts, append; otherwise insert.
      const hasText = msg.content.some(
        (p) => p.type === 'output_text' || p.type === 'text',
      );
      if (!hasText) {
        msg.content.push({ type: 'output_text', text: buf });
      }
    }
  }
}

export class CodexResponsesAdapter implements ProviderAdapter {
  apiMode: ApiMode = 'codex_responses';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly providerName: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: CodexResponsesAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.providerName = options.providerName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body = this.buildRequestBody(input);
    const url = `${this.baseUrl}/responses`;
    // Phase 21 #6 reopen: chatgpt.com/backend-api/codex Cloudflare layer
    // rejects requests without codex_cli_rs originator + UA + the
    // ChatGPT-Account-ID extracted from the OAuth JWT. Without these, the
    // backend returns 400 "model not supported when using Codex with a
    // ChatGPT account" regardless of slug. Hermes pattern verbatim from
    // agent/auxiliary_client.py:_codex_cloudflare_headers.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.codexBackendHeaders(),
      ...this.extraHeaders,
    };

    const totalAttempts = this.maxRetries + 1;
    let lastTransientError: ProviderError | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, headers, body);

        if (response.ok) {
          // Phase 21 #6c: Codex backend always streams. Collect the SSE
          // frames into a final ResponsesAPIResponse so the rest of the
          // adapter (parseResponse, callers) sees the same JSON shape
          // it expects from non-streaming providers.
          if (this.isCodexBackend()) {
            const aggregated = await this.collectStreamedResponse(response);
            return this.parseResponse(aggregated);
          }
          const json = (await response.json()) as ResponsesAPIResponse;
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

        lastTransientError = status === 429
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

  private buildRequestBody(input: ProviderCallInput): Record<string, unknown> {
    const { instructions, items } = this.translateMessages(input.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      input: items,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
    };
    if (instructions) body.instructions = instructions;
    if (input.tools.length > 0) {
      body.tools = this.translateTools(input.tools);
    }
    // Phase 21 #6 reopen: Codex backend (chatgpt.com/backend-api/codex)
    // does NOT accept max_output_tokens — see Hermes
    // agent/transports/codex.py:142-143: "if max_tokens is not None and
    // not is_codex_backend". Sending it triggers 400.
    if (input.maxTokens != null && !this.isCodexBackend()) {
      body.max_output_tokens = input.maxTokens;
    }
    if (input.temperature != null) body.temperature = input.temperature;
    // Phase 21 #6c: chatgpt.com/backend-api/codex requires `stream: true`
    // on every request — sending stream:false (or omitting) returns
    // HTTP 400 "Stream must be set to true." Hermes always streams the
    // Codex backend (run_agent.py _run_codex_stream call site). Aiden's
    // call() collects the SSE frames internally and returns the final
    // aggregated ResponsesAPIResponse so v4 callers that don't request
    // streaming still see the same JSON-style result.
    if (this.isCodexBackend()) {
      body.stream = true;
    }
    if (input.extraBody) Object.assign(body, input.extraBody);
    return body;
  }

  /**
   * True when this adapter is talking to the chatgpt.com/backend-api/codex
   * endpoint — a different protocol surface than `api.openai.com/v1`. The
   * Codex backend rejects max_output_tokens, requires Cloudflare-bypass
   * headers, and binds requests to a ChatGPT account via JWT.
   */
  private isCodexBackend(): boolean {
    return this.baseUrl.includes('chatgpt.com/backend-api/codex');
  }

  /**
   * Phase 21 #6 reopen — Codex Cloudflare-bypass headers, verbatim from
   * Hermes `agent/auxiliary_client.py:_codex_cloudflare_headers`:
   *
   *   User-Agent: codex_cli_rs/0.0.0 (Aiden Agent)
   *   originator: codex_cli_rs
   *   ChatGPT-Account-ID: <chatgpt_account_id from JWT claim>
   *
   * No-op for non-Codex backends (returns empty object). Malformed JWTs
   * drop the account-id header rather than raise — a bad token surfaces
   * as 401 from the backend, not a crash here.
   */
  private codexBackendHeaders(): Record<string, string> {
    if (!this.isCodexBackend()) return {};
    const headers: Record<string, string> = {
      'User-Agent': 'codex_cli_rs/0.0.0 (Aiden Agent)',
      originator: 'codex_cli_rs',
    };
    const acctId = extractChatGptAccountId(this.apiKey);
    if (acctId) {
      headers['ChatGPT-Account-ID'] = acctId;
    }
    return headers;
  }

  /**
   * Convert v4 Message[] to Responses API shape.
   * - System messages are extracted into a single `instructions` string
   *   (concatenated with \n\n if multiple).
   * - User/assistant messages become {type:'message', role, content:[...]} items.
   * - Assistant tool_calls become {type:'function_call', call_id, name, arguments} items.
   * - Tool result messages become {type:'function_call_output', call_id, output} items.
   */
  private translateMessages(messages: Message[]): {
    instructions: string | undefined;
    items: ResponsesInputItem[];
  } {
    const systemParts: string[] = [];
    const items: ResponsesInputItem[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          systemParts.push(msg.content);
          break;
        case 'user':
          items.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: msg.content }],
          });
          break;
        case 'assistant': {
          if (msg.content) {
            items.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: msg.content }],
            });
          }
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            for (const tc of msg.toolCalls) {
              items.push({
                type: 'function_call',
                call_id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments ?? {}),
              });
            }
          }
          break;
        }
        case 'tool':
          items.push({
            type: 'function_call_output',
            call_id: msg.toolCallId,
            output: msg.content,
          });
          break;
      }
    }

    const instructions = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    return { instructions, items };
  }

  private translateTools(tools: ToolSchema[]): ResponsesTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      strict: false,
      parameters: t.inputSchema,
    }));
  }

  private parseResponse(json: ResponsesAPIResponse): ProviderCallOutput {
    let output = Array.isArray(json.output) ? json.output : [];

    // Backfill: when stream recovery left output empty but output_text is set,
    // synthesize a message item so downstream parsing has something to read.
    if (output.length === 0 && typeof json.output_text === 'string' && json.output_text.trim()) {
      output = [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: json.output_text.trim() }],
          status: 'completed',
        } as ResponsesOutputMessage,
      ];
    }

    const status = (json.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'cancelled') {
      throw new ProviderError(
        `Provider ${this.providerName} returned status='${status}'`,
        this.providerName,
        undefined,
        json,
      );
    }

    if (output.length === 0) {
      throw new ProviderError(
        `Provider ${this.providerName} returned no output items`,
        this.providerName,
        undefined,
        json,
      );
    }

    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];

    for (const item of output) {
      const itemType = (item as { type: string }).type;
      const itemStatus =
        typeof (item as { status?: string }).status === 'string'
          ? ((item as { status: string }).status).toLowerCase()
          : undefined;

      if (itemType === 'message') {
        const msg = item as ResponsesOutputMessage;
        const text = (msg.content ?? [])
          .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('');
        if (text) textParts.push(text);
      } else if (itemType === 'function_call') {
        // Skip in-flight items.
        if (itemStatus === 'queued' || itemStatus === 'in_progress' || itemStatus === 'incomplete') {
          continue;
        }
        const fc = item as ResponsesOutputFunctionCall;
        const argsRaw = fc.arguments;
        let args: Record<string, unknown> = {};
        if (typeof argsRaw === 'string') {
          try {
            const parsed = argsRaw.trim() === '' ? {} : JSON.parse(argsRaw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            console.warn(
              `[${this.providerName}] failed to JSON.parse function_call arguments for ${fc.name}; falling back to {}`,
            );
            args = {};
          }
        } else if (argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)) {
          args = argsRaw as Record<string, unknown>;
        }
        const callId = (fc.call_id || fc.id || '').trim();
        toolCalls.push({
          id: callId || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: fc.name,
          arguments: args,
        });
      }
      // 'reasoning' items intentionally ignored at v4 minimum scope (Phase 13 will replay them).
    }

    let finishReason: ProviderCallOutput['finishReason'];
    if (toolCalls.length > 0) {
      finishReason = 'tool_use';
    } else if (status === 'incomplete') {
      const reason = json.incomplete_details?.reason;
      finishReason = reason === 'max_output_tokens' ? 'length' : 'stop';
    } else {
      finishReason = 'stop';
    }

    const usage = json.usage ?? {};
    const cachedTokens =
      usage.cached_tokens ?? usage.input_tokens_details?.cached_tokens;

    return {
      content: textParts.length > 0 ? textParts.join('\n') : '',
      toolCalls,
      finishReason,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        ...(cachedTokens != null ? { cacheReadTokens: cachedTokens } : {}),
      },
      raw: json,
    };
  }

  /**
   * Phase 21 #6c — drain the Codex Responses-API SSE stream.
   *
   * Phase 21 #6d — three-stage recovery, ported verbatim from Hermes
   * `run_agent.py:_run_codex_stream` lines 5895-5917. The Codex backend
   * (chatgpt.com/backend-api/codex) regularly emits `response.completed`
   * with an EMPTY `output[]` array even when items were streamed via
   * `response.output_item.done` or rendered as `output_text.delta`. We
   * must NOT trust `completed.response.output` blindly — instead:
   *
   *   1. If `response.completed.response.output` is non-empty → use it.
   *   2. Else if `output_item.done` events were collected → use them.
   *   3. Else if `output_text.delta` accumulated → synthesize one
   *      assistant message item from the joined text.
   *   4. Else → return empty (caller throws "no output items").
   *
   * Set AIDEN_DEBUG_CODEX=1 to log every event type seen — useful when
   * a future Codex backend adds new event types we haven't accounted
   * for. Per Hermes "treat provider adapters as hostile boundaries" —
   * we log unknowns rather than silently drop.
   */
  private async collectStreamedResponse(
    response: Response,
  ): Promise<ResponsesAPIResponse> {
    if (!response.body) {
      throw new ProviderError(
        `Provider ${this.providerName} returned a streaming response with no body`,
        this.providerName,
      );
    }
    const debug = process.env.AIDEN_DEBUG_CODEX === '1';
    const aggregate: ResponsesAPIResponse = { output: [], status: undefined };
    // Hermes parity: track collected `output_item.done` items separately
    // from the in-progress aggregate so backfill can use them when
    // `completed.response.output` is empty.
    const collectedItems: ResponsesOutputItem[] = [];
    // Per-item-id text buffer — `output_text.delta` events reference
    // an item_id that matches an earlier `output_item.added`.
    const textBuffers = new Map<string, string>();
    // Joined text deltas across all items (Hermes `_codex_streamed_text_parts`).
    const textParts: string[] = [];
    let hasToolCalls = false;
    let final: ResponsesAPIResponse | null = null;
    let terminalEvent: string | null = null; // 'completed' | 'incomplete' | 'failed'

    for await (const payload of parseSseStream(response.body)) {
      let event: {
        type?: string;
        response?: ResponsesAPIResponse;
        item?: ResponsesOutputItem;
        item_id?: string;
        delta?: string;
        error?: { message?: string };
      };
      try {
        event = JSON.parse(payload);
      } catch {
        if (debug) {
          // eslint-disable-next-line no-console
          console.warn(`[codex-debug] unparseable SSE payload: ${payload.slice(0, 200)}`);
        }
        continue;
      }
      const t = event.type ?? '';
      if (debug) {
        // eslint-disable-next-line no-console
        console.warn(`[codex-debug] event=${t}`);
      }

      if (t === 'response.completed' && event.response) {
        final = event.response;
        terminalEvent = 'completed';
        applyTextBuffers(final, textBuffers);
        continue;
      }
      if (t === 'response.incomplete') {
        // Hermes treats incomplete as a recoverable terminal — proceed
        // to backfill rather than throwing.
        final = event.response ?? null;
        terminalEvent = 'incomplete';
        if (final) applyTextBuffers(final, textBuffers);
        continue;
      }
      if (t === 'response.failed' || t === 'response.error') {
        const msg = event.error?.message ?? `${t} event from Codex stream`;
        throw new ProviderError(
          `Provider ${this.providerName} streaming failed: ${msg}`,
          this.providerName,
        );
      }
      if (t === 'response.created' && event.response) {
        Object.assign(aggregate, event.response);
        if (!Array.isArray(aggregate.output)) aggregate.output = [];
        continue;
      }
      if (t === 'response.output_item.added' && event.item) {
        if (!Array.isArray(aggregate.output)) aggregate.output = [];
        aggregate.output.push(event.item);
        if ((event.item as { type?: string }).type === 'function_call') {
          hasToolCalls = true;
        }
        continue;
      }
      if (t === 'response.output_item.done' && event.item) {
        if (!Array.isArray(aggregate.output)) aggregate.output = [];
        const idx = aggregate.output.findIndex(
          (o) => (o as { id?: string }).id === (event.item as { id?: string }).id,
        );
        if (idx >= 0) aggregate.output[idx] = event.item;
        else aggregate.output.push(event.item);
        // Hermes parity: collectedItems is the backfill source of truth.
        collectedItems.push(event.item);
        if ((event.item as { type?: string }).type === 'function_call') {
          hasToolCalls = true;
        }
        continue;
      }
      if (t === 'response.output_text.delta' && typeof event.delta === 'string') {
        const id = event.item_id ?? '';
        textBuffers.set(id, (textBuffers.get(id) ?? '') + event.delta);
        textParts.push(event.delta);
        continue;
      }
      // Hermes parity: any event_type containing `function_call`
      // signals tool-call mode; suppress synthesis from text deltas.
      if (t.includes('function_call')) {
        hasToolCalls = true;
        continue;
      }
      // All other events (reasoning.delta, output_text.done,
      // content_part.added, refusal, audio, ...) — log when debug is
      // on, otherwise quietly accept. Unknown types must NOT throw —
      // forward-compat with future Codex SSE additions.
      if (debug && t.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[codex-debug] unhandled event type: ${t}`);
      }
    }

    // ─── Three-stage recovery (Hermes run_agent.py:5895-5917) ───
    const result: ResponsesAPIResponse = final ?? aggregate;
    const out = Array.isArray(result.output) ? result.output : [];

    // Stage 1: trust completed.output if non-empty.
    if (out.length > 0) return result;

    // Stage 2: backfill from collected output_item.done events.
    if (collectedItems.length > 0) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.warn(
          `[codex-debug] backfilled ${collectedItems.length} output_item.done events into empty completed.output`,
        );
      }
      return { ...result, output: collectedItems };
    }

    // Stage 3: synthesize a single assistant message from joined deltas.
    if (textParts.length > 0 && !hasToolCalls) {
      const assembled = textParts.join('');
      if (debug) {
        // eslint-disable-next-line no-console
        console.warn(
          `[codex-debug] synthesized 1 message item from ${textParts.length} deltas (${assembled.length} chars)`,
        );
      }
      return {
        ...result,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: assembled }],
          } as ResponsesOutputItem,
        ],
      };
    }

    // Genuine empty — caller's parseResponse() throws the existing
    // "no output items" error. Honest framing: if we got here with
    // terminalEvent='incomplete', surface that.
    if (terminalEvent === 'incomplete') {
      result.status = result.status ?? 'incomplete';
    }
    return result;
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
