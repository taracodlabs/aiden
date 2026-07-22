/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * providers/v4/messageApiAdapter.ts
 *
 * Speaks Anthropic's native /v1/messages wire format on behalf of Aiden's
 * provider abstraction. Used for:
 *
 *   - api.anthropic.com with an x-api-key.
 *   - Third-party Anthropic-compatible endpoints (DashScope/Qwen, MiniMax)
 *     pointed at via `baseUrl`.
 *
 * Translation responsibilities:
 *
 *   request:  Aiden Message[] + ToolSchema[]   →  Anthropic POST body
 *   response: Anthropic content[] + stop_reason →  ProviderCallOutput
 *   stream:   SSE event stream                 →  StreamEvent yields
 *
 * Requests carry an honest `user-agent: aiden/<version>` — Aiden never
 * disguises itself as another client. Callers stay wire-format-agnostic.
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
} from './errors';
import { RequestLifecycle, requestDeadlines, type RequestDeadlines } from './requestLifecycle';
import { VERSION } from '../../core/version';

// ── Public options ──────────────────────────────────────────────────────────

export interface MessageApiAdapterOptions {
  /** Defaults to 'https://api.anthropic.com'. No trailing slash. */
  baseUrl?: string;
  /** Anthropic API key, sent as `x-api-key`. */
  apiKey: string;
  /** Model id, e.g. 'claude-haiku-4-5-20251001'. */
  model: string;
  /** Used for error messages, traces, and rate-limit telemetry. */
  providerName: string;
  /** Per-request wall clock. Default 120_000 ms. */
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Retries on 429 / 5xx / network errors. Default 2 (3 attempts total). */
  maxRetries?: number;
  /** Header overrides (escape hatch — wins over computed headers). */
  extraHeaders?: Record<string, string>;
}

// ── Wire-format types (private) ─────────────────────────────────────────────
//
// Kept narrow on purpose. Anthropic adds new fields freely; we only declare
// what we actually consume so the typechecker stays useful.

interface WireTextBlock     { type: 'text';     text: string }
interface WireToolUseBlock  { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
type     WireContentBlock   = WireTextBlock | WireToolUseBlock | { type: string; [k: string]: unknown };

interface WireMessageBody {
  content?: WireContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface WireRequestBody {
  model:        string;
  /** Flat system-prompt string (Anthropic also accepts a typed-block array,
   *  but Aiden only sends the string form). */
  system?:      string;
  messages:     unknown[];
  tools?:       Array<{ name: string; description: string; input_schema: ToolSchema['inputSchema'] }>;
  tool_choice?: { type: 'auto' };
  max_tokens:   number;
  temperature?: number;
  [extra: string]: unknown;   // for ProviderCallInput.extraBody passthrough
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL    = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS  = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_TOKENS  = 4096;
const MESSAGE_API_VERSION = '2023-06-01';
const BACKOFF_BASE_MS     = 1000;

interface ActiveDispatch {
  response: Response;
  lifecycle: RequestLifecycle;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class MessageApiAdapter implements ProviderAdapter {
  readonly apiMode: ApiMode = 'anthropic_messages';

  private readonly endpoint:     string;
  private readonly apiKey:       string;
  private readonly model:        string;
  private readonly providerName: string;
  private readonly timeoutMs:    number;
  private readonly deadlines:    RequestDeadlines;
  private readonly maxRetries:   number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: MessageApiAdapterOptions) {
    const baseUrl     = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.endpoint     = `${baseUrl}/v1/messages`;
    this.apiKey       = opts.apiKey;
    this.model        = opts.model;
    this.providerName = opts.providerName;
    this.timeoutMs    = opts.timeoutMs  ?? DEFAULT_TIMEOUT_MS;
    this.deadlines    = requestDeadlines(this.timeoutMs, {
      connectionMs: opts.connectionTimeoutMs,
      firstByteMs: opts.firstByteTimeoutMs,
      bodyIdleMs: opts.bodyIdleTimeoutMs,
      totalMs: opts.totalTimeoutMs,
    });
    this.maxRetries   = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  // ── Public: non-streaming ────────────────────────────────────────────────

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body  = this.buildBody(input, /* streaming */ false);
    const active = await this.dispatch(body, /* streaming */ false, input.signal, input.headers);
    let text: string;
    try {
      text = await active.lifecycle.readText(active.response);
    } catch (error) {
      throw active.lifecycle.classify(error);
    } finally {
      active.lifecycle.cleanup();
    }
    const json = JSON.parse(text) as WireMessageBody;
    return decodeResponse(json);
  }

  // ── Public: streaming ────────────────────────────────────────────────────

  async *callStream(input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void> {
    const body = this.buildBody(input, /* streaming */ true);
    const active = await this.dispatch(body, /* streaming */ true, input.signal, input.headers);
    const reply = active.response;
    if (!reply.body) {
      // Server promised SSE but gave us nothing — fall through to a synthetic
      // empty done event so the agent loop terminates rather than hangs.
      yield {
        type: 'done',
        output: {
          content:      '',
          toolCalls:    [],
          finishReason: 'error',
          usage:        { inputTokens: 0, outputTokens: 0 },
        },
      };
      active.lifecycle.cleanup();
      return;
    }
    try {
      yield* decodeStream(reply.body, input.maxTokens ?? DEFAULT_MAX_TOKENS, active.lifecycle);
    } catch (error) {
      throw active.lifecycle.classify(error);
    } finally {
      active.lifecycle.cleanup();
    }
  }

  // ── Request body assembly ────────────────────────────────────────────────

  private buildBody(input: ProviderCallInput, streaming: boolean): WireRequestBody {
    const { system, wireMessages } = encodeMessages(input.messages);
    const body: WireRequestBody = {
      model:      this.model,
      messages:   wireMessages,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (system !== undefined) body.system = system;
    if (input.tools && input.tools.length > 0) {
      body.tools       = input.tools.map(t => toWireTool(t));
      body.tool_choice = { type: 'auto' };
    }
    if (typeof input.temperature === 'number') body.temperature = input.temperature;
    if (streaming)                              body.stream      = true;
    if (input.extraBody) Object.assign(body, input.extraBody);
    return body;
  }

  // ── Network with retry/timeout ───────────────────────────────────────────

  private buildHeaders(streaming: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type':      'application/json',
      'anthropic-version': MESSAGE_API_VERSION,
      // Honest client identity — Aiden never masquerades as another CLI.
      'user-agent':        `aiden/${VERSION}`,
      'x-api-key':         this.apiKey,
    };
    if (streaming) headers['Accept'] = 'text/event-stream';
    // Caller-supplied headers win. Useful for adding region pins, custom
    // beta flags, or per-deployment routing tags without forking the adapter.
    return { ...headers, ...this.extraHeaders };
  }

  private async dispatch(
    body: WireRequestBody,
    streaming: boolean,
    externalSignal?: AbortSignal,
    outboundHeaders?: Record<string, string>,
  ): Promise<ActiveDispatch> {
    // v4.9.0 Slice 7 — merge caller-supplied outbound headers (e.g.
    // `traceparent`, `X-Aiden-Run-Id`) below the adapter's defaults so
    // they can't override `x-api-key` / `anthropic-version` etc.,
    // but above `extraHeaders` so a deliberate per-deployment override
    // still wins.
    const base = this.buildHeaders(streaming);
    const headers = outboundHeaders ? { ...outboundHeaders, ...base } : base;
    const serialised  = JSON.stringify(body);
    const totalTries  = this.maxRetries + 1;

    let lastErr: unknown = null;

    for (let attempt = 0; attempt < totalTries; attempt++) {
      const lifecycle = new RequestLifecycle(this.providerName, this.deadlines, externalSignal);
      // v4.6 prep — forward an external AbortSignal into this attempt's
      // internal controller so a parent agent that aborts mid-flight
      // cancels the in-flight fetch. External aborts surface as a raw
      // AbortError (NOT ProviderTimeoutError) so AidenAgent can route
      // them as `finishReason: 'interrupted'` instead of treating them
      // as a retryable timeout.
      let response: Response;
      try {
        response = await lifecycle.race(fetch(this.endpoint, {
          method:  'POST',
          headers,
          body:    serialised,
          signal:  lifecycle.signal,
        }));
        lifecycle.markHeaders();
      } catch (err: any) {
        const classified = lifecycle.classify(err);
        lifecycle.cleanup();
        if (classified instanceof Error && classified.name === 'AbortError') {
          // v4.6 prep — external abort takes priority over internal
          // timeout. Surface the raw AbortError immediately (no retry)
          // so AidenAgent's catch routes it as 'interrupted'.
          if (externalSignal?.aborted) {
            throw classified;
          }
          lastErr = classified;
        } else if (classified instanceof Error && classified.name === 'ProviderPhaseTimeoutError') {
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
      if (response.ok) return { response, lifecycle };

      // Gated request diagnostic. Do not clone or consume the response here:
      // the lifecycle below must remain the sole body reader so its first-byte,
      // idle, total, and caller-cancellation deadlines cover every byte.
      // Sensitive headers are redacted before printing.
      if (process.env.AIDEN_DEBUG_ANTHROPIC === '1') {
        try {
          const safeHeaders = redactHeaders(headers);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] status: ${response.status} ${response.statusText}`);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] req url: ${this.endpoint}`);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] req headers: ${JSON.stringify(safeHeaders, null, 2)}`);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] req body (first 500 chars): ${serialised.slice(0, 500)}`);
        } catch {
          /* diagnostic best-effort; never block the real error path */
        }
      }

      // Non-2xx: classify and decide whether to retry.
      const status = response.status;
      let responseText: string;
      try {
        responseText = await lifecycle.readText(response);
      } catch (error) {
        const classified = lifecycle.classify(error);
        lifecycle.cleanup();
        throw classified;
      }
      const raw = tryParseJson(responseText);
      lifecycle.cleanup();

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

      // 4xx (auth, bad request, content policy, …) — fail fast, do not retry.
      throw new ProviderError(
        `Provider ${this.providerName} request failed (${status})`,
        this.providerName,
        status,
        raw,
        false,
      );
    }

    // Unreachable in practice — the loop either returns or throws.
    throw lastErr instanceof Error
      ? lastErr
      : new ProviderError(`Provider ${this.providerName} failed after retries`, this.providerName);
  }
}

// ── Free helpers (deliberately not on the class) ────────────────────────────

function toWireTool(
  t: ToolSchema,
): { name: string; description: string; input_schema: ToolSchema['inputSchema'] } {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}

/**
 * Walk Aiden's flat Message[] and produce:
 *   - the `system` field — a flat string, or `undefined` when the caller
 *     supplied no system prompts.
 *   - the messages array in Anthropic's expected shape.
 *
 * A tool reply (`role: 'tool'`) becomes a user message containing a single
 * `tool_result` block. Consecutive tool replies fold into the same user
 * message so we don't violate Anthropic's "alternating roles" expectation.
 */
/** Parse a `data:<media>;base64,<data>` URL into Anthropic's image-source parts. */
function parseImageDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

function encodeMessages(
  messages: Message[],
): { system: string | undefined; wireMessages: unknown[] } {
  const sysParts: string[]    = [];
  const wireMessages: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      sysParts.push(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      const block = {
        type:         'tool_result',
        tool_use_id:  msg.toolCallId,
        content:      msg.content,
      };
      // Glue onto a previous user-with-tool_result if it exists, otherwise
      // start a new one. Anthropic accepts either layout; folding keeps the
      // request body smaller.
      const last = wireMessages[wireMessages.length - 1] as
        | { role: string; content: unknown[] } | undefined;
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        wireMessages.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (msg.role === 'user') {
      // v4.12 B2.2a — a user turn may carry base64 image data URLs for vision.
      // Text-only (no images) stays a plain string — unchanged wire shape.
      if (msg.images && msg.images.length > 0) {
        const blocks: unknown[] = [];
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        for (const dataUrl of msg.images) {
          const img = parseImageDataUrl(dataUrl);
          if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        }
        wireMessages.push({ role: 'user', content: blocks });
      } else {
        wireMessages.push({ role: 'user', content: msg.content });
      }
      continue;
    }

    // assistant
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      wireMessages.push({ role: 'assistant', content: blocks });
    } else {
      wireMessages.push({ role: 'assistant', content: msg.content });
    }
  }

  const joined = sysParts.join('\n\n').trim();
  return { system: joined || undefined, wireMessages };
}

/** Anthropic stop_reason → Aiden finishReason. */
function mapStopReason(raw: string | undefined): ProviderCallOutput['finishReason'] {
  switch (raw) {
    case 'tool_use':                 return 'tool_use';
    case 'max_tokens':               return 'length';
    case 'end_turn':
    case 'stop_sequence':
    case undefined:
    case null as unknown as string:  return 'stop';
    default:                         return 'stop';
  }
}

/** Body of a non-streaming /v1/messages reply → Aiden output shape. */
function decodeResponse(reply: WireMessageBody): ProviderCallOutput {
  const blocks    = Array.isArray(reply.content) ? reply.content : [];
  const textParts: string[]            = [];
  const toolCalls: ToolCallRequest[]   = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof (block as WireTextBlock).text === 'string') {
      textParts.push((block as WireTextBlock).text);
    } else if (block.type === 'tool_use') {
      const tu = block as WireToolUseBlock;
      toolCalls.push({
        id:        tu.id,
        name:      tu.name,
        arguments: (tu.input ?? {}) as Record<string, unknown>,
      });
    }
    // Other block types (server_tool_use, thinking, etc.) ignored at this layer.
  }

  return {
    content:      textParts.join('\n'),
    toolCalls,
    finishReason: mapStopReason(reply.stop_reason),
    usage:        decodeUsage(reply.usage),
    raw:          reply,
  };
}

function decodeUsage(u: WireMessageBody['usage']): ProviderCallOutput['usage'] {
  const out: ProviderCallOutput['usage'] = {
    inputTokens:  u?.input_tokens  ?? 0,
    outputTokens: u?.output_tokens ?? 0,
  };
  if (typeof u?.cache_read_input_tokens === 'number') {
    out.cacheReadTokens = u.cache_read_input_tokens;
  }
  if (typeof u?.cache_creation_input_tokens === 'number') {
    out.cacheWriteTokens = u.cache_creation_input_tokens;
  }
  return out;
}

// ── Streaming decoder ───────────────────────────────────────────────────────
//
// The Anthropic SSE protocol uses these `type` values:
//
//   message_start          — initial usage envelope
//   content_block_start    — opens a text or tool_use block at index N
//   content_block_delta    — text_delta (text) or input_json_delta (tool args)
//   content_block_stop     — closes block N; tool args are now finalisable
//   message_delta          — final stop_reason and finalised usage
//   message_stop           — terminator
//
// Tool call args stream in as JSON fragments; we accumulate them per-block
// and parse at content_block_stop. The agent loop wants the `tool_call`
// event ASAP (so the UI can switch from "streaming" to "executing tool"),
// so we emit it on content_block_start with empty args, then patch the args
// onto the assembled output before yielding `done`.

interface BlockState {
  kind:           'text' | 'tool_use';
  text?:          string;
  toolCallId?:    string;
  toolCallName?:  string;
  argsBuffer?:    string;
}

async function* decodeStream(
  body: ReadableStream<Uint8Array>,
  maxTokens: number,
  lifecycle?: RequestLifecycle,
): AsyncGenerator<StreamEvent, void, void> {
  const blocks  = new Map<number, BlockState>();
  const toolCalls: ToolCallRequest[] = [];
  let stopReason: string | undefined;
  let usage: WireMessageBody['usage'] = undefined;
  // Stable text emission order: walk content blocks by index at end-of-stream.
  const textOrder: number[] = [];
  // v4.1.4 Part 1.6: track the last-emitted output-token count so we
  // only yield a `progress` event when the counter actually advances.
  // Anthropic emits `message_delta.usage.output_tokens` as a running
  // total — multiple deltas may carry the same value if no new tokens
  // were produced between them. Deduping keeps the event stream
  // proportional to real progress.
  let lastProgressEmitted = -1;

  for await (const payload of parseSseStream(body, lifecycle)) {
    if (!payload || payload === '[DONE]') continue;
    let evt: any;
    try { evt = JSON.parse(payload); }
    catch { continue; }

    switch (evt?.type) {
      case 'message_start': {
        if (evt.message?.usage) usage = evt.message.usage;
        break;
      }

      case 'content_block_start': {
        const idx = typeof evt.index === 'number' ? evt.index : 0;
        const cb  = evt.content_block ?? {};
        if (cb.type === 'tool_use') {
          const internalName = String(cb.name ?? '');
          blocks.set(idx, {
            kind:          'tool_use',
            toolCallId:    cb.id,
            toolCallName:  internalName,
            argsBuffer:    '',
          });
          // Up-front emit so consumers can flip UI mode immediately. Args
          // get populated on content_block_stop and reflected on `done`.
          yield {
            type: 'tool_call',
            toolCall: { id: cb.id, name: internalName, arguments: {} },
          };
        } else {
          blocks.set(idx, { kind: 'text', text: '' });
          textOrder.push(idx);
        }
        break;
      }

      case 'content_block_delta': {
        const idx   = typeof evt.index === 'number' ? evt.index : 0;
        const block = blocks.get(idx);
        if (!block) break;
        const delta = evt.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && block.kind === 'text') {
          block.text = (block.text ?? '') + delta.text;
          yield { type: 'delta', content: delta.text };
        } else if (delta.type === 'input_json_delta' && block.kind === 'tool_use') {
          block.argsBuffer = (block.argsBuffer ?? '') + (delta.partial_json ?? '');
        }
        break;
      }

      case 'content_block_stop': {
        const idx   = typeof evt.index === 'number' ? evt.index : 0;
        const block = blocks.get(idx);
        if (!block || block.kind !== 'tool_use') break;
        const id   = block.toolCallId   ?? '';
        const name = block.toolCallName ?? '';
        let args: Record<string, unknown> = {};
        if (block.argsBuffer) {
          try { args = JSON.parse(block.argsBuffer); }
          catch { /* malformed JSON — surface empty args, agent may retry */ }
        }
        toolCalls.push({ id, name, arguments: args });
        break;
      }

      case 'message_delta': {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) {
          usage = { ...(usage ?? {}), ...evt.usage };
          // v4.1.4 Part 1.6 — emit a `progress` event when the running
          // output-token counter advances. The display layer uses these
          // for the ▰▱ progress bar. Deduped via `lastProgressEmitted`
          // so a stream of message_delta events with no real progress
          // doesn't flood the consumer.
          const outputTokens = typeof evt.usage.output_tokens === 'number'
            ? evt.usage.output_tokens
            : -1;
          if (outputTokens > lastProgressEmitted) {
            lastProgressEmitted = outputTokens;
            yield {
              type:         'progress',
              outputTokens,
              maxTokens,
            };
          }
        }
        break;
      }

      case 'message_stop':
      default:
        // Either terminal or an event we don't model — keep going until the
        // SSE stream closes. Anthropic occasionally adds new event types.
        break;
    }
  }

  const content = textOrder
    .map(i => blocks.get(i)?.text ?? '')
    .join('\n');

  const output: ProviderCallOutput = {
    content,
    toolCalls,
    finishReason: mapStopReason(stopReason),
    usage:        decodeUsage(usage),
  };
  yield { type: 'done', output };
}

// ── Misc helpers ────────────────────────────────────────────────────────────

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, 8s … with a small jitter so retries from many sessions don't
  // all wake up on the same tick.
  const base   = BACKOFF_BASE_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * Math.min(BACKOFF_BASE_MS, base / 4));
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Redact credentials before logging headers. The whole point of the
 * diagnostic is for the user to share output with the maintainer; leaving
 * the OAuth bearer or x-api-key visible defeats the gate.
 */
function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const kl = k.toLowerCase();
    if (kl === 'authorization' || kl === 'x-api-key') {
      out[k] = redactValue(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactValue(v: string): string {
  if (!v) return '';
  if (v.length <= 12) return '***';
  return `${v.slice(0, 6)}…${v.slice(-4)} (len=${v.length})`;
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
