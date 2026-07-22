/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * providers/v4/responseStreamAdapter.ts
 *
 * Adapter for OpenAI's Responses API (`/v1/responses`). Two backends in one
 * file:
 *
 *   1. **Plain API key path** (`baseUrl` = `https://api.openai.com/v1`).
 *      Standard JSON request and response. Used when a user supplies an
 *      ordinary OpenAI API key for a Responses-API model.
 *
 *   2. **Subscription response backend path**. The backend requires
 *      compatibility headers derived from the OAuth JWT and rejects requests
 *      that do not stream. We force
 *      `stream: true`, parse the SSE event stream, and aggregate it into
 *      the same `ProviderCallOutput` shape callers see from path #1.
 *
 * The subscription backend's SSE stream may return incomplete terminal data:
 * `response.completed` regularly arrives with an empty `output[]` even
 * when items WERE streamed via `response.output_item.done` events. To
 * handle that we run a three-stage recovery in `aggregateSseEvents`:
 *
 *   Stage 1: if `response.completed.response.output` is non-empty, use it.
 *   Stage 2: else if `output_item.done` events were collected, build a
 *            response shape from those.
 *   Stage 3: else if any `output_text.delta` accumulated, synthesise a
 *            single `message` item with the joined text.
 *
 * The compatibility debug flag surfaces unknown SSE event types via `console.warn`
 * so a future API addition shows up loudly instead of being dropped.
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
import {
  beginPhysicalProviderAttempt,
  byteLength,
  createLogicalProviderCallId,
  type PhysicalAttemptLifecycle,
} from './providerAttemptAccounting';

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Pull the response account id from an OpenAI OAuth JWT claim. Returns `null`
 * on any failure (malformed bearer, no claim, parse error). The subscription
 * backend requires this header alongside the User-Agent +
 * originator pair; absent values are quietly omitted so a bad token
 * surfaces as an upstream 401 instead of a crash here.
 */
export function extractResponseAccountId(
  accessToken: string | null | undefined,
): string | null {
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    return null;
  }
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    const b64url   = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded   = b64url + '='.repeat((4 - (b64url.length % 4)) % 4);
    const decoded  = Buffer.from(padded, 'base64').toString('utf8');
    const claims   = JSON.parse(decoded) as Record<string, unknown>;
    const auth     = claims['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      const acct = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof acct === 'string' && acct.length > 0) return acct;
    }
  } catch {
    /* malformed JWT — null tells the caller to drop the header */
  }
  return null;
}

export interface ResponseStreamAdapterOptions {
  /** No trailing slash. Default `https://api.openai.com/v1`. */
  baseUrl?:       string;
  apiKey:         string;
  model:          string;
  providerName:   string;
  timeoutMs?:     number;
  /** Default 2 (3 attempts total). */
  maxRetries?:    number;
  /** Caller-supplied headers — merged in last; wins over computed headers. */
  extraHeaders?:  Record<string, string>;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL    = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS  = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS     = 1000;

const STREAMING_BACKEND_HOST = 'chatgpt.com/backend-api/codex';
const STREAMING_USER_AGENT   = 'codex_cli_rs/0.0.0 (Aiden Agent)';
const STREAMING_ORIGINATOR   = 'codex_cli_rs';
let providerCallSequence     = 0;

// ── Wire-format types (private, narrow on purpose) ──────────────────────

interface WireFunctionTool {
  type:        'function';
  name:        string;
  description: string;
  strict:      boolean;
  parameters:  ToolSchema['inputSchema'];
}

interface WireMessageItem {
  type:    'message';
  role:    'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
}

interface WireFunctionCallItem {
  type:      'function_call';
  call_id:   string;
  name:      string;
  arguments: string;
}

interface WireFunctionCallOutputItem {
  type:    'function_call_output';
  call_id: string;
  output:  string;
}

type WireInputItem =
  | WireMessageItem
  | WireFunctionCallItem
  | WireFunctionCallOutputItem;

interface WireOutputMessage {
  type:    'message';
  id?:     string;
  role?:   string;
  content?: Array<{ type: string; text?: string }>;
  status?: string;
}

interface WireOutputFunctionCall {
  type:      'function_call';
  id?:       string;
  call_id?:  string;
  name:      string;
  arguments: string | Record<string, unknown>;
  status?:   string;
}

type WireOutputItem =
  | WireOutputMessage
  | WireOutputFunctionCall
  | { type: string; [k: string]: unknown };

interface WireResponseShape {
  output?:              WireOutputItem[];
  output_text?:         string;
  status?:              string;
  incomplete_details?:  { reason?: string };
  usage?: {
    input_tokens?:           number;
    output_tokens?:          number;
    cached_tokens?:          number;
    input_tokens_details?:   { cached_tokens?: number };
    output_tokens_details?:  { reasoning_tokens?: number };
  };
}

interface WireRequestBody {
  model:                  string;
  instructions?:          string;
  input:                  WireInputItem[];
  tools?:                 WireFunctionTool[];
  tool_choice?:           'auto';
  parallel_tool_calls?:   boolean;
  store?:                 boolean;
  max_output_tokens?:     number;
  stream?:                boolean;
  [extra: string]:        unknown;
}

interface ActiveDispatch {
  response: Response;
  attempt: PhysicalAttemptLifecycle;
  cleanup(): void;
  classifyError(error: unknown): unknown;
}

// ── Adapter ─────────────────────────────────────────────────────────────

export class ResponseStreamAdapter implements ProviderAdapter {
  readonly apiMode: ApiMode = 'codex_responses';

  private readonly endpoint:     string;
  private readonly apiKey:       string;
  private readonly model:        string;
  private readonly providerName: string;
  private readonly timeoutMs:    number;
  private readonly maxRetries:   number;
  private readonly extraHeaders: Record<string, string>;
  private readonly usesStreamingBackend: boolean;
  private readonly accountId:    string | null;

  constructor(opts: ResponseStreamAdapterOptions) {
    const baseUrl     = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.endpoint     = `${baseUrl}/responses`;
    this.apiKey       = opts.apiKey;
    this.model        = opts.model;
    this.providerName = opts.providerName;
    this.timeoutMs    = opts.timeoutMs  ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries   = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.usesStreamingBackend = baseUrl.includes(STREAMING_BACKEND_HOST);
    // JWT account-id is only meaningful on the subscription backend. We compute
    // it eagerly so a malformed token surfaces at construction (caller's
    // chosen point) rather than mid-request.
    this.accountId    = this.usesStreamingBackend ? extractResponseAccountId(opts.apiKey) : null;
  }

  // ── Public: non-streaming entry ─────────────────────────────────────

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const diagCallId = ++providerCallSequence;
    p2aDiag('response.call.start', {
      diagCallId, model: this.model, streamingBackend: this.usesStreamingBackend,
      messageCount: input.messages.length,
      lastRole: input.messages.length > 0 ? input.messages[input.messages.length - 1].role : null,
      aborted: input.signal?.aborted === true,
    });
    const body   = this.buildBody(input);
    const active = await this.dispatch(body, input, diagCallId);
    const reply  = active.response;

    // The subscription backend always streams; aggregate SSE frames into the
    // same shape the JSON path returns. Plain api.openai.com path returns
    // JSON directly.
    p2aDiag('response.body.start', {
      diagCallId, streamingBackend: this.usesStreamingBackend,
      aborted: input.signal?.aborted === true,
      pendingPromise: this.usesStreamingBackend ? 'aggregateSseEvents' : 'readJsonBody',
    });
    let wire: WireResponseShape;
    try {
      wire = this.usesStreamingBackend
        ? await aggregateSseEvents(reply)
        : await readJsonBody(reply, this.providerName);
    } catch (error) {
      const classified = active.classifyError(error);
      active.attempt.failure(classified, { sent: true });
      throw classified;
    } finally {
      active.cleanup();
    }
    p2aDiag('response.body.complete', {
      diagCallId, status: wire.status ?? null,
      outputItems: Array.isArray(wire.output) ? wire.output.length : 0,
      aborted: input.signal?.aborted === true,
    });

    const decoded = decodeWireResponse(wire, this.providerName);
    active.attempt.success(decoded, responseShapeBytes(wire));
    p2aDiag('response.call.complete', {
      diagCallId, finishReason: decoded.finishReason,
      toolCalls: decoded.toolCalls.map((call) => ({ id: call.id, name: call.name })),
    });
    return decoded;
  }

  // ── Streaming entry (currently bridges to non-streaming) ────────────
  //
  // The Responses API surface doesn't yet expose an Aiden-internal
  // streaming consumer that benefits from incremental events; the agent
  // loop reads `done` events. We deliver one synthetic `done` after
  // aggregation so the contract is uniform.
  async *callStream(
    input: ProviderCallInput,
  ): AsyncGenerator<StreamEvent, void, void> {
    const out = await this.call(input);
    yield { type: 'done', output: out };
  }

  // ── Body assembly ───────────────────────────────────────────────────

  private buildBody(input: ProviderCallInput): WireRequestBody {
    const { instructions, items } = encodeMessages(input.messages);

    const body: WireRequestBody = {
      model:                this.model,
      input:                items,
      store:                false,
    };
    if (instructions)                  body.instructions  = instructions;
    // Phase v4.1.1-oauth-fix Phase 5: `tool_choice` and
    // `parallel_tool_calls` are only meaningful when tools are present.
    // The streaming backend returns HTTP 400 for `tool_choice: 'auto'`
    // without a `tools` field — surfaced by `aiden doctor --providers`'s
    // no-tools liveness probe.
    if (input.tools && input.tools.length > 0) {
      body.tools                = input.tools.map(toWireTool);
      body.tool_choice          = 'auto';
      body.parallel_tool_calls  = true;
    }
    if (typeof input.temperature === 'number') {
      (body as Record<string, unknown>).temperature = input.temperature;
    }
    // The streaming backend rejects max_output_tokens; only regular Responses
    // API accepts it.
    if (!this.usesStreamingBackend && input.maxTokens !== undefined) {
      body.max_output_tokens = input.maxTokens;
    }
    // The streaming backend requires stream:true (returns 400 otherwise).
    if (this.usesStreamingBackend) {
      body.stream = true;
    }
    if (input.extraBody) Object.assign(body, input.extraBody);
    return body;
  }

  // ── Headers + dispatch ──────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    if (this.usesStreamingBackend) {
      headers['User-Agent'] = STREAMING_USER_AGENT;
      headers['originator'] = STREAMING_ORIGINATOR;
      headers['Accept']     = 'text/event-stream';
      if (this.accountId) {
        headers['ChatGPT-Account-ID'] = this.accountId;
      }
    }
    return { ...headers, ...this.extraHeaders };
  }

  private async dispatch(
    body: WireRequestBody,
    input: ProviderCallInput,
    diagCallId?: number,
  ): Promise<ActiveDispatch> {
    const headers    = this.buildHeaders();
    const serialised = JSON.stringify(body);
    const totalTries = this.maxRetries + 1;
    const externalSignal = input.signal;
    const logicalCallId = input.usageContext?.logicalCallId ?? createLogicalProviderCallId();

    let lastErr: unknown = null;

    for (let attempt = 0; attempt < totalTries; attempt++) {
      const accounting = beginPhysicalProviderAttempt(input, {
        providerActual: this.providerName,
        modelActual: this.model,
        apiMode: this.apiMode,
        transport: this.endpoint.startsWith('https:') ? 'https' : 'http',
        attemptIndex: attempt,
        fallbackIndex: input.usageContext?.fallbackIndex ?? 0,
        logicalCallId,
        requestBytes: byteLength(serialised),
      });
      const controller = new AbortController();
      let abortCause: 'timeout' | 'external' | null = null;
      let cleaned = false;
      const abortFor = (cause: 'timeout' | 'external'): void => {
        if (abortCause !== null) return;
        abortCause = cause;
        controller.abort();
      };
      const timer = setTimeout(() => abortFor('timeout'), this.timeoutMs);
      // v4.6 prep — forward external abort into the internal controller.
      // External aborts surface as raw AbortError so AidenAgent routes
      // them as 'interrupted' rather than retrying as ProviderTimeoutError.
      let externalAbortHandler: (() => void) | null = null;
      if (externalSignal) {
        if (externalSignal.aborted) {
          abortFor('external');
        } else {
          externalAbortHandler = () => abortFor('external');
          externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
        }
      }

      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timer);
        if (externalAbortHandler && externalSignal) {
          externalSignal.removeEventListener('abort', externalAbortHandler);
        }
        p2aDiag('response.lifecycle.cleanup', {
          diagCallId, attempt: attempt + 1, abortCause,
        });
      };
      const classifyError = (error: unknown): unknown => {
        if (abortCause === 'external') return asAbortError(error);
        if (abortCause === 'timeout') {
          return new ProviderTimeoutError(this.providerName, this.timeoutMs);
        }
        return error;
      };

      let response: Response;
      try {
        p2aDiag('response.fetch.start', {
          diagCallId, attempt: attempt + 1, timeoutMs: this.timeoutMs,
          aborted: externalSignal?.aborted === true,
          pendingPromise: 'fetchHeaders',
        });
        response = await fetch(this.endpoint, {
          method:  'POST',
          headers,
          body:    serialised,
          signal:  controller.signal,
        });
        p2aDiag('response.headers.received', {
          diagCallId, attempt: attempt + 1,
          status: response.status, ok: response.ok,
          aborted: externalSignal?.aborted === true,
        });
      } catch (err: any) {
        const classified = classifyError(err);
        cleanup();
        if ((classified as { name?: unknown })?.name === 'AbortError') {
          accounting.failure(classified, { sent: true, status: 'interrupted' });
          throw classified;
        }
        accounting.failure(lastErr, { sent: true });
        if (classified instanceof ProviderTimeoutError) {
          lastErr = classified;
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
      if (response.ok) return { response, attempt: accounting, cleanup, classifyError };

      const status = response.status;
      let raw: unknown;
      try {
        raw = await safeReadBody(response);
      } catch (error) {
        throw classifyError(error);
      } finally {
        cleanup();
      }

      if (status === 429) {
        const error = new ProviderRateLimitError(this.providerName, raw);
        accounting.failure(error, { sent: true, responseBytes: responseShapeBytes(raw) });
        if (attempt < totalTries - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      }

      if (status >= 500 && status < 600) {
        const error = new ProviderError(
          `Provider ${this.providerName} server error ${status}`,
          this.providerName,
          status,
          raw,
          true,
        );
        accounting.failure(error, { sent: true, responseBytes: responseShapeBytes(raw) });
        if (attempt < totalTries - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      }

      // 4xx (auth, content policy, malformed) — fail fast.
      const error = new ProviderError(
        `Provider ${this.providerName} request failed (${status})`,
        this.providerName,
        status,
        raw,
        false,
      );
      accounting.failure(error, { sent: true, responseBytes: responseShapeBytes(raw) });
      throw error;
    }

    throw lastErr instanceof Error
      ? lastErr
      : new ProviderError(`Provider ${this.providerName} failed after retries`, this.providerName);
  }
}

function p2aDiag(event: string, data: Record<string, unknown>): void {
  if (process.env.AIDEN_P2A_DIAG !== '1') return;
  try {
    const monoMs = Number(process.hrtime.bigint() / 1_000_000n);
    process.stderr.write(`[p2a] ${JSON.stringify({ monoMs, event, ...data })}\n`);
  } catch { /* diagnostics must never affect provider calls */ }
}

// ── Encoders ────────────────────────────────────────────────────────────

function asAbortError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  const abort = new Error('Provider request cancelled by caller');
  abort.name = 'AbortError';
  (abort as Error & { cause?: unknown }).cause = error;
  return abort;
}

function toWireTool(t: ToolSchema): WireFunctionTool {
  return {
    type:        'function',
    name:        t.name,
    description: t.description,
    strict:      false,
    parameters:  t.inputSchema,
  };
}

/**
 * Convert Aiden's flat `Message[]` into Responses-API wire shape:
 *   - Multiple system messages collapse into a single `instructions` string.
 *   - User messages → `message` items with `input_text` parts.
 *   - Assistant messages → `message` items with `output_text` parts;
 *     when they carry tool calls, those become separate `function_call`
 *     items in the SAME order they appeared on the assistant turn.
 *   - Tool replies → `function_call_output` items, referencing the
 *     matching `call_id`.
 */
function encodeMessages(messages: Message[]): {
  instructions: string;
  items:        WireInputItem[];
} {
  const sysParts: string[]      = [];
  const items:    WireInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      sysParts.push(msg.content);
      continue;
    }
    if (msg.role === 'user') {
      items.push({
        type:    'message',
        role:    'user',
        content: [{ type: 'input_text', text: msg.content }],
      });
      continue;
    }
    if (msg.role === 'tool') {
      items.push({
        type:    'function_call_output',
        call_id: msg.toolCallId,
        output:  msg.content,
      });
      continue;
    }
    // assistant
    if (msg.content && msg.content.length > 0) {
      items.push({
        type:    'message',
        role:    'assistant',
        content: [{ type: 'output_text', text: msg.content }],
      });
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        items.push({
          type:      'function_call',
          call_id:   tc.id,
          name:      tc.name,
          arguments: JSON.stringify(tc.arguments ?? {}),
        });
      }
    }
  }

  return { instructions: sysParts.join('\n\n').trim(), items };
}

// ── Decoders ────────────────────────────────────────────────────────────

function decodeWireResponse(
  wire:         WireResponseShape,
  providerName: string,
): ProviderCallOutput {
  const status = wire.status ?? 'completed';
  if (status === 'failed') {
    // Same honesty as the streaming path — surface the real reason
    // (wire.error.message/code), not a bare "status=failed". Reason via `raw`
    // so composeMessage appends it once (no doubling).
    throw new ProviderError(
      `Provider ${providerName} reported failure`,
      providerName,
      undefined,
      extractSseFailureReason({ response: wire }),
      false,
    );
  }

  const outputs = Array.isArray(wire.output) ? wire.output : [];
  let textParts: string[]            = [];
  const toolCalls: ToolCallRequest[] = [];

  for (const item of outputs) {
    if (item.type === 'message') {
      const msg = item as WireOutputMessage;
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ((part.type === 'output_text' || part.type === 'text')
              && typeof part.text === 'string'
              && part.text.length > 0) {
            textParts.push(part.text);
          }
        }
      }
    } else if (item.type === 'function_call') {
      const fc = item as WireOutputFunctionCall;
      const id = fc.call_id ?? fc.id ?? '';
      const args = typeof fc.arguments === 'string'
        ? parseToolArgs(fc.arguments)
        : (fc.arguments && typeof fc.arguments === 'object' && !Array.isArray(fc.arguments)
            ? (fc.arguments as Record<string, unknown>)
            : {});
      toolCalls.push({ id, name: fc.name, arguments: args });
    }
    // Reasoning / unknown items are ignored at this layer — the Responses
    // API ships internal model state we don't need to surface.
  }

  // Stage-3-equivalent for the JSON path: empty output[] but a top-level
  // `output_text` present (some Responses API replies do this) → synthesise
  // a message body so callers see the text.
  if (textParts.length === 0 && toolCalls.length === 0
      && typeof wire.output_text === 'string' && wire.output_text.length > 0) {
    textParts = [wire.output_text];
  }

  return {
    content:      textParts.join(''),
    toolCalls,
    finishReason: mapFinishReason(wire, toolCalls.length > 0),
    usage:        decodeUsage(wire.usage),
    raw:          wire,
  };
}

function mapFinishReason(
  wire:         WireResponseShape,
  hasToolCalls: boolean,
): ProviderCallOutput['finishReason'] {
  const status = wire.status ?? 'completed';
  if (status === 'incomplete') {
    const reason = wire.incomplete_details?.reason ?? '';
    if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'length';
  }
  if (hasToolCalls) return 'tool_use';
  return 'stop';
}

function decodeUsage(u: WireResponseShape['usage']): ProviderCallOutput['usage'] {
  const out: ProviderCallOutput['usage'] = {
    inputTokens:  u?.input_tokens  ?? 0,
    outputTokens: u?.output_tokens ?? 0,
  };
  // Responses API reports cached tokens either at top-level usage or
  // inside `input_tokens_details`. Accept either; prefer the nested one.
  const cached =
    u?.input_tokens_details?.cached_tokens ?? u?.cached_tokens;
  if (typeof cached === 'number') {
    out.cacheReadTokens = cached;
  }
  if (typeof u?.output_tokens_details?.reasoning_tokens === 'number') {
    out.reasoningTokens = u.output_tokens_details.reasoning_tokens;
  }
  return out;
}

function responseShapeBytes(value: unknown): number {
  if (typeof value === 'string') return byteLength(value);
  try { return byteLength(JSON.stringify(value) ?? ''); }
  catch { return 0; }
}

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
      '[responseStreamAdapter] function_call.arguments is not valid JSON; ' +
      'falling back to {}',
    );
    return {};
  }
}

// ── SSE aggregation ─────────────────────────────────────────────────────
//
// Recognised event types:
//
//   response.created                         — informational, capture initial response
//   response.in_progress                     — informational
//   response.output_item.added               — open an item
//   response.output_item.done                — close an item; collect for backfill
//   response.output_text.delta               — append text to per-item text buffer
//   response.function_call_arguments.delta   — append args to per-item args buffer
//   response.completed                       — terminal, carries `response`
//   response.incomplete                      — terminal, recoverable
//   response.failed / response.error         — terminal, throw

interface AggregationState {
  finalResponse:  WireResponseShape | null;
  collectedItems: WireOutputItem[];
  textBuffers:    Map<string, string>;
  argsBuffers:    Map<string, string>;
  failed:         string | null;
}

async function aggregateSseEvents(reply: Response): Promise<WireResponseShape> {
  if (!reply.body) {
    throw new ProviderError(
      'Responses stream had no body',
      'codex_responses',
      reply.status,
      undefined,
      true,
    );
  }
  const debug = process.env.AIDEN_DEBUG_CODEX === '1';
  const state: AggregationState = {
    finalResponse:  null,
    collectedItems: [],
    textBuffers:    new Map(),
    argsBuffers:    new Map(),
    failed:         null,
  };

  for await (const payload of readSseDataLines(reply.body)) {
    if (!payload || payload === '[DONE]') continue;
    let event: any;
    try { event = JSON.parse(payload); }
    catch { continue; }

    handleSseEvent(event, state, debug);
    if (state.failed) break;
  }

  if (state.failed) {
    // The reason is passed as `raw` (not interpolated into the summary too):
    // composeMessage appends it ONCE → "...failure: <reason>". Passing it in
    // both places is what produced the doubled "failure: failed: failed".
    throw new ProviderError(
      'Responses stream reported failure',
      'codex_responses',
      undefined,
      state.failed,
      false,
    );
  }

  // Three-stage recovery:
  //
  // Stage 1 — completed.response.output is non-empty.
  if (state.finalResponse && Array.isArray(state.finalResponse.output)
      && state.finalResponse.output.length > 0) {
    applyTextBuffers(state.finalResponse.output, state.textBuffers);
    return state.finalResponse;
  }

  // Stage 2 — completed.output is empty but we collected items via
  // `output_item.done`. Build a synthetic shape from those.
  if (state.collectedItems.length > 0) {
    const shape: WireResponseShape = {
      output: state.collectedItems,
      status: state.finalResponse?.status ?? 'completed',
      usage:  state.finalResponse?.usage,
      ...(state.finalResponse?.incomplete_details
        ? { incomplete_details: state.finalResponse.incomplete_details }
        : {}),
    };
    applyTextBuffers(shape.output!, state.textBuffers);
    return shape;
  }

  // Stage 3 — only text deltas accumulated. Synthesise a single message.
  if (state.textBuffers.size > 0) {
    const joined = Array.from(state.textBuffers.values()).join('');
    if (joined.length > 0) {
      return {
        output: [
          {
            type:    'message',
            role:    'assistant',
            content: [{ type: 'output_text', text: joined }],
          } as WireOutputMessage,
        ],
        status: state.finalResponse?.status ?? 'completed',
        usage:  state.finalResponse?.usage,
      };
    }
  }

  // Nothing recoverable — return whatever the final response gave us
  // (empty output → caller sees content='', finishReason='stop' or
  // 'length' depending on status).
  return state.finalResponse ?? { output: [] };
}

/**
 * Pull the real failure reason from a `response.failed` / error event.
 * The Responses API carries the cause at `response.error.{message,code}` — a
 * bare top-level `error` or a `response.status` of "failed" is NOT a reason.
 * We dig the actual pockets in priority order, collapse an accidental self-chant
 * ("failed: failed" → "failed"), reject useless non-reasons, and NEVER return a
 * bare "failed": if no real reason exists we surface the error shape or status,
 * so the message always says WHY (Phase 6 honesty: an error explains itself).
 */
function extractSseFailureReason(event: any): string {
  const err = (event && (event.response?.error ?? event.error)) || null;
  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    let s = v.trim();
    const m = s.match(/^(.+?):\s*\1$/i);            // collapse "failed: failed" → "failed"
    if (m) s = m[1].trim();
    return s && !/^(failed|error|unknown)$/i.test(s) ? s : null;   // reject useless non-reasons
  };
  const message = clean(err?.message) ?? clean(event?.message);
  const code    = clean(err?.code)    ?? clean(event?.code);
  if (message) return code && code !== message ? `${message} (${code})` : message;
  if (code) return code;
  // No real reason in the usual pockets — never chant "failed"; surface the shape.
  const status = typeof event?.response?.status === 'string' ? event.response.status : undefined;
  try {
    const blob = JSON.stringify(err ?? event.response ?? event);
    if (blob && blob !== '{}' && blob !== 'null' && blob !== '""') {
      return `${status ? `status=${status}; ` : ''}${blob.slice(0, 300)}`;
    }
  } catch { /* non-serialisable — fall through */ }
  return status
    ? `status=${status} (no error detail in the stream event)`
    : 'unknown stream error (no detail in the event)';
}

function handleSseEvent(
  event: any,
  state: AggregationState,
  debug: boolean,
): void {
  const type = String(event?.type ?? '');
  switch (type) {
    case 'response.created':
    case 'response.in_progress':
      // Capture incrementally; the `completed` event will overwrite.
      if (event.response) state.finalResponse = event.response;
      return;

    case 'response.output_item.added':
      // We don't need to track the open item — `output_item.done` carries
      // the final state. But if the added item has an id and is a
      // message, the text buffer keys align with it.
      return;

    case 'response.output_item.done': {
      const item = event.item;
      if (item && typeof item === 'object') {
        state.collectedItems.push(item as WireOutputItem);
      }
      return;
    }

    case 'response.output_text.delta': {
      const itemId = typeof event.item_id === 'string' ? event.item_id : '';
      const delta  = typeof event.delta   === 'string' ? event.delta   : '';
      if (delta.length === 0) return;
      const prev = state.textBuffers.get(itemId) ?? '';
      state.textBuffers.set(itemId, prev + delta);
      return;
    }

    case 'response.function_call_arguments.delta': {
      const itemId = typeof event.item_id === 'string' ? event.item_id : '';
      const delta  = typeof event.delta   === 'string' ? event.delta   : '';
      if (delta.length === 0) return;
      const prev = state.argsBuffers.get(itemId) ?? '';
      state.argsBuffers.set(itemId, prev + delta);
      return;
    }

    case 'response.completed':
      if (event.response) state.finalResponse = event.response;
      return;

    case 'response.incomplete':
      // Recoverable terminal — caller still gets whatever items collected.
      if (event.response) state.finalResponse = event.response;
      return;

    case 'response.failed':
    case 'response.error': {
      // Read the reason from the RIGHT pocket (response.error.message/code),
      // never the useless status word — see extractSseFailureReason.
      state.failed = extractSseFailureReason(event);
      return;
    }

    default:
      if (debug) {
        // eslint-disable-next-line no-console
        console.warn(`[responseStreamAdapter] unknown SSE event: ${type}`);
      }
  }
}

/**
 * Fill in empty `message` content using accumulated text buffers. Items
 * whose `content` already has text parts are left alone — the streamed
 * `output_item.done` may have arrived with everything baked in.
 */
function applyTextBuffers(
  items:    WireOutputItem[],
  buffers:  Map<string, string>,
): void {
  for (const item of items) {
    if (item.type !== 'message') continue;
    const msg   = item as WireOutputMessage;
    const id    = typeof msg.id === 'string' ? msg.id : '';
    const buf   = buffers.get(id);
    if (!buf) continue;
    const arr   = Array.isArray(msg.content) ? msg.content : (msg.content = []);
    const hasText = arr.some(
      (p) => (p.type === 'output_text' || p.type === 'text')
             && typeof p.text === 'string'
             && p.text.length > 0,
    );
    if (!hasText) {
      arr.push({ type: 'output_text', text: buf });
    }
  }
}

// ── SSE line reader (private, tighter than chatCompletions's parser) ────

async function* readSseDataLines(
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
        buffer += decoder.decode();
        if (buffer.length > 0) {
          for (const payload of extractDataLines(buffer + '\n')) yield payload;
        }
        return;
      }
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) continue;
      const ready = buffer.slice(0, lastNewline + 1);
      buffer      = buffer.slice(lastNewline + 1);
      for (const payload of extractDataLines(ready)) yield payload;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* may already be released */ }
  }
}

function* extractDataLines(block: string): Generator<string, void, void> {
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0)            continue;
    if (line.startsWith(':'))         continue;   // SSE comment
    if (line.startsWith('data:')) {
      yield line.slice(5).replace(/^ /, '');
    }
  }
}

// ── Misc helpers ────────────────────────────────────────────────────────

async function readJsonBody(
  reply:        Response,
  providerName: string,
): Promise<WireResponseShape> {
  const text = await reply.text();
  try {
    return JSON.parse(text) as WireResponseShape;
  } catch {
    throw new ProviderError(
      `Provider ${providerName} returned non-JSON body`,
      providerName,
      reply.status,
      text,
      false,
    );
  }
}

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
    try { return JSON.parse(text); } catch { return text; }
  } catch {
    return null;
  }
}
