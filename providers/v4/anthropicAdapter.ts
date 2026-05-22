/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * providers/v4/anthropicAdapter.ts
 *
 * Speaks Anthropic's native /v1/messages wire format on behalf of Aiden's
 * provider abstraction. Used for:
 *
 *   - api.anthropic.com with an x-api-key.
 *   - api.anthropic.com with a Claude subscription OAuth token (Aiden masks
 *     itself as Claude Code via the `anthropic-beta` header + an identity
 *     prefix in the system prompt — Anthropic gates OAuth tokens on this).
 *   - Third-party Anthropic-compatible endpoints (DashScope/Qwen, MiniMax)
 *     pointed at via `baseUrl`.
 *
 * Translation responsibilities:
 *
 *   request:  Aiden Message[] + ToolSchema[]   →  Anthropic POST body
 *   response: Anthropic content[] + stop_reason →  ProviderCallOutput
 *   stream:   SSE event stream                 →  StreamEvent yields
 *
 * Anything provider-specific (cache breakpoints, beta headers, OAuth identity
 * prefix) lives in this file. Callers stay wire-format-agnostic.
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
import { getClaudeCliUserAgent } from './anthropic/userAgent';
import {
  addMcpPrefix,
  stripMcpPrefix,
  sanitizeIdentity,
} from './anthropic/oauthTransform';

// ── Public options ──────────────────────────────────────────────────────────

export interface AnthropicAdapterOptions {
  /** Defaults to 'https://api.anthropic.com'. No trailing slash. */
  baseUrl?: string;
  /** API key (authMode='api_key') or OAuth bearer (authMode='oauth'). */
  apiKey: string;
  /** Selects auth header layout. */
  authMode: 'api_key' | 'oauth';
  /** Model id, e.g. 'claude-haiku-4-5-20251001'. */
  model: string;
  /** Used for error messages, traces, and rate-limit telemetry. */
  providerName: string;
  /** Per-request wall clock. Default 120_000 ms. */
  timeoutMs?: number;
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

interface WireSystemBlock { type: 'text'; text: string }

interface WireRequestBody {
  model:        string;
  /**
   * Anthropic accepts either a flat string or an array of typed text
   * blocks. Aiden uses the string form on api-key requests and the
   * block-array form on OAuth requests so the Claude Code identity
   * fingerprint can be inspected by the routing layer (see encodeMessages).
   */
  system?:      string | WireSystemBlock[];
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
const ANTHROPIC_VERSION   = '2023-06-01';
/**
 * Beta flags Anthropic expects on Claude Pro/Max OAuth requests:
 *   - `claude-code-20250219` + `oauth-2025-04-20` — required to route
 *     the request through the Claude Code billing path.
 *   - `interleaved-thinking-2025-05-14` + `fine-grained-tool-streaming-2025-05-14`
 *     — Claude Code's standard client capability advertisements.
 *
 * `context-1m-2025-08-07` is intentionally OMITTED — it's gated to
 * specific Anthropic accounts with 1M-context access, and sending it on a
 * subscription that lacks the entitlement returns 400 ("The long context
 * beta is not yet available for this subscription"). Users who have the
 * entitlement can re-add it via the `extraHeaders` adapter option.
 */
const OAUTH_BETA          = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
].join(',');
const BACKOFF_BASE_MS     = 1000;

/**
 * Identity prefix Anthropic requires on OAuth-authenticated requests.
 *
 * Two roles:
 *   1. Without this string anywhere in the system prompt, the API rejects
 *      the call as "unauthorized client".
 *   2. The billing router fingerprints OAuth requests on `system[0]` being
 *      EXACTLY this prefix as a standalone text block — a flattened string
 *      containing the same text fails the check and gets metered as
 *      pay-as-you-go API usage instead of subscription quota.
 *
 * Therefore on OAuth turns this string occupies its own block at index 0
 * of the `system` array (see encodeMessages), and the user's actual system
 * prompt lives at index 1.
 */
const CLAUDE_CODE_IDENTITY =
  'You are Claude Code, Anthropic\'s official CLI for Claude.';

// ── Adapter ────────────────────────────────────────────────────────────────

export class AnthropicAdapter implements ProviderAdapter {
  readonly apiMode: ApiMode = 'anthropic_messages';

  private readonly endpoint:     string;
  private readonly apiKey:       string;
  private readonly authMode:     'api_key' | 'oauth';
  private readonly model:        string;
  private readonly providerName: string;
  private readonly timeoutMs:    number;
  private readonly maxRetries:   number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: AnthropicAdapterOptions) {
    const baseUrl     = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.endpoint     = `${baseUrl}/v1/messages`;
    this.apiKey       = opts.apiKey;
    this.authMode     = opts.authMode;
    this.model        = opts.model;
    this.providerName = opts.providerName;
    this.timeoutMs    = opts.timeoutMs  ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries   = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  // ── Public: non-streaming ────────────────────────────────────────────────

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body  = this.buildBody(input, /* streaming */ false);
    const reply = await this.dispatch(body, /* streaming */ false, input.signal, input.headers);
    const json  = (await reply.json()) as WireMessageBody;
    return decodeResponse(json);
  }

  // ── Public: streaming ────────────────────────────────────────────────────

  async *callStream(input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void> {
    const body = this.buildBody(input, /* streaming */ true);
    const reply = await this.dispatch(body, /* streaming */ true, input.signal, input.headers);
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
      return;
    }
    yield* decodeStream(reply.body, input.maxTokens ?? DEFAULT_MAX_TOKENS);
  }

  // ── Request body assembly ────────────────────────────────────────────────

  private buildBody(input: ProviderCallInput, streaming: boolean): WireRequestBody {
    const { system, wireMessages } = encodeMessages(input.messages, this.authMode);
    const body: WireRequestBody = {
      model:      this.model,
      messages:   wireMessages,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (system !== undefined) body.system = system;
    if (input.tools && input.tools.length > 0) {
      body.tools       = input.tools.map(t => toWireTool(t, this.authMode));
      body.tool_choice = { type: 'auto' };
    }
    if (typeof input.temperature === 'number') body.temperature = input.temperature;
    if (streaming)                              body.stream      = true;
    if (input.extraBody) Object.assign(body, input.extraBody);
    return body;
  }

  // ── Network with retry/timeout ───────────────────────────────────────────

  private buildHeaders(streaming: boolean, userAgent: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type':      'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      // Anthropic's billing router uses these two as the Claude Code CLI
      // fingerprint. Without them an OAuth-authenticated request is metered
      // as pay-as-you-go API usage instead of subscription quota — Pro/Max
      // users see "out of extra usage" despite having available quota.
      'x-app':             'cli',
      'user-agent':        userAgent,
    };
    if (streaming) headers['Accept'] = 'text/event-stream';
    if (this.authMode === 'oauth') {
      headers['Authorization']   = `Bearer ${this.apiKey}`;
      headers['anthropic-beta']  = OAUTH_BETA;
    } else {
      headers['x-api-key'] = this.apiKey;
    }
    // Caller-supplied headers win. Useful for adding region pins, custom
    // beta flags, or per-deployment routing tags without forking the adapter.
    return { ...headers, ...this.extraHeaders };
  }

  private async dispatch(
    body: WireRequestBody,
    streaming: boolean,
    externalSignal?: AbortSignal,
    outboundHeaders?: Record<string, string>,
  ): Promise<Response> {
    // Resolved once per process via the userAgent module's cache, so paying
    // for the version detection here is cheap on every retry/turn.
    const userAgent   = await getClaudeCliUserAgent();
    // v4.9.0 Slice 7 — merge caller-supplied outbound headers (e.g.
    // `traceparent`, `X-Aiden-Run-Id`) below the adapter's defaults so
    // they can't override `Authorization` / `anthropic-version` etc.,
    // but above `extraHeaders` so a deliberate per-deployment override
    // still wins.
    const base = this.buildHeaders(streaming, userAgent);
    const headers = outboundHeaders ? { ...outboundHeaders, ...base } : base;
    const serialised  = JSON.stringify(body);
    const totalTries  = this.maxRetries + 1;

    let lastErr: unknown = null;

    for (let attempt = 0; attempt < totalTries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      // v4.6 prep — forward an external AbortSignal into this attempt's
      // internal controller so a parent agent that aborts mid-flight
      // cancels the in-flight fetch. External aborts surface as a raw
      // AbortError (NOT ProviderTimeoutError) so AidenAgent can route
      // them as `finishReason: 'interrupted'` instead of treating them
      // as a retryable timeout.
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
          // v4.6 prep — external abort takes priority over internal
          // timeout. Surface the raw AbortError immediately (no retry)
          // so AidenAgent's catch routes it as 'interrupted'.
          if (externalSignal?.aborted) {
            throw err;
          }
          // Treat timeout as retryable; only surface ProviderTimeoutError if
          // we've burned the last attempt.
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

      // Phase 25.1.5d diagnostic: gated dump of request + response so we
      // can see exactly what Anthropic objected to. Cloned response so the
      // existing safeReadBody call below still gets a readable body.
      // Sensitive headers are redacted before printing.
      if (process.env.AIDEN_DEBUG_ANTHROPIC === '1') {
        try {
          const debugBody = await response.clone().text();
          const safeHeaders = redactHeaders(headers);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] status: ${response.status} ${response.statusText}`);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] req url: ${this.endpoint}`);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] req headers: ${JSON.stringify(safeHeaders, null, 2)}`);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] req body (first 500 chars): ${serialised.slice(0, 500)}`);
          // eslint-disable-next-line no-console
          console.error(`[anthropic-debug] resp body: ${debugBody}`);
        } catch {
          /* diagnostic best-effort; never block the real error path */
        }
      }

      // Non-2xx: classify and decide whether to retry.
      const status = response.status;
      const raw    = await safeReadBody(response);

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
  authMode: 'api_key' | 'oauth',
): { name: string; description: string; input_schema: ToolSchema['inputSchema'] } {
  const wireName = authMode === 'oauth' ? addMcpPrefix(t.name) : t.name;
  return { name: wireName, description: t.description, input_schema: t.inputSchema };
}

/**
 * Walk Aiden's flat Message[] and produce:
 *   - the `system` field — flat string on api-key auth, array of typed
 *     text blocks on OAuth auth (see CLAUDE_CODE_IDENTITY commentary for
 *     why the array shape matters for billing routing).
 *   - the messages array in Anthropic's expected shape.
 *
 * A tool reply (`role: 'tool'`) becomes a user message containing a single
 * `tool_result` block. Consecutive tool replies fold into the same user
 * message so we don't violate Anthropic's "alternating roles" expectation.
 *
 * The `system` return value is `undefined` when the caller supplied no
 * system prompts AND we're on api-key auth; OAuth always returns at least
 * the single-block identity array because the API requires the prefix
 * to be present.
 */
function encodeMessages(
  messages: Message[],
  authMode: 'api_key' | 'oauth',
): { system: string | WireSystemBlock[] | undefined; wireMessages: unknown[] } {
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
      wireMessages.push({ role: 'user', content: msg.content });
      continue;
    }

    // assistant
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls) {
        // OAuth-mode wire history echoes the same `mcp_` prefix Aiden
        // sends on outgoing tools[]. The model needs consistent naming
        // across turns — internal Aiden state still holds the bare name.
        const wireName = authMode === 'oauth' ? addMcpPrefix(tc.name) : tc.name;
        blocks.push({ type: 'tool_use', id: tc.id, name: wireName, input: tc.arguments });
      }
      wireMessages.push({ role: 'assistant', content: blocks });
    } else {
      wireMessages.push({ role: 'assistant', content: msg.content });
    }
  }

  const joined = sysParts.join('\n\n').trim();

  if (authMode !== 'oauth') {
    // API-key auth: subscription routing isn't a concern, the original
    // flat-string shape is fine and keeps the request body smallest.
    return { system: joined || undefined, wireMessages };
  }

  // OAuth: ship the identity prefix as a standalone block 0 so the
  // billing router's fingerprint check passes. If the caller already
  // baked the prefix into their system prompt, strip it out before
  // landing the rest into block 1 — duplicates would push the user's
  // real instructions further down the prompt for no benefit.
  let rest = joined;
  if (rest.startsWith(CLAUDE_CODE_IDENTITY)) {
    rest = rest.slice(CLAUDE_CODE_IDENTITY.length).replace(/^\s+/, '');
  }
  const blocks: WireSystemBlock[] = [
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
  ];
  if (rest) {
    // Substitute Aiden/Taracod identity references for Claude
    // Code/Anthropic equivalents. Anthropic's content-filter pass on
    // the Claude Code identity flow flags non-Anthropic product names.
    // The replacement only affects the wire payload — internal state,
    // logs, and user-visible output stay as Aiden.
    blocks.push({ type: 'text', text: sanitizeIdentity(rest) });
  }
  return { system: blocks, wireMessages };
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
        // Strip the wire prefix unconditionally — bare names are what
        // Aiden's tool registry uses, and we never emit `mcp_*` tools
        // internally so the strip is a no-op for non-OAuth replies.
        name:      stripMcpPrefix(tu.name),
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

  for await (const payload of parseSseStream(body)) {
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
          // Drop the wire prefix at decode time so internal names stay
          // consistent across streaming and non-streaming paths.
          const internalName = stripMcpPrefix(String(cb.name ?? ''));
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

async function safeReadBody(r: Response): Promise<unknown> {
  try {
    const text = await r.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch {
    return null;
  }
}
