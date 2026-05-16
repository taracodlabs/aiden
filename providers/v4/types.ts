/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/types.ts — Aiden v4.0.0
 *
 * Provider abstraction contracts. Every adapter (anthropic, chat_completions,
 * codex_responses, ollama_prompt_tools) implements `ProviderAdapter`.
 *
 * Status: SCAFFOLDING — types only. Concrete adapters land in Phase 3.
 *   See docs/v4.0.0-architecture.md, "v4.0.0 system architecture".
 */

/**
 * The four wire-format families Aiden speaks. Every (provider, model) pair
 * resolves to exactly one of these via `RuntimeResolver`.
 *
 *  - chat_completions:    OpenAI-style /v1/chat/completions wire format.
 *                         Used by Groq, OpenRouter, Together, Gemini-compat,
 *                         Cerebras, NVIDIA, and any OpenAI-spec endpoint.
 *  - anthropic_messages:  Native Anthropic /v1/messages with tool_use blocks
 *                         and prefix caching. Also used for Claude
 *                         subscription OAuth.
 *  - codex_responses:     OpenAI's /v1/responses stream (Codex). Also used
 *                         for ChatGPT subscription OAuth flows.
 *  - ollama_prompt_tools: Local Ollama fallback. Tools are emulated by
 *                         injecting JSON-call instructions into the prompt
 *                         (no native tool calling).
 */
export type ApiMode =
  | 'chat_completions'
  | 'anthropic_messages'
  | 'codex_responses'
  | 'ollama_prompt_tools';

/**
 * Result of resolving a (provider, model) request to concrete dispatch info.
 *
 * `apiKey` may be null for OAuth flows (`anthropic_messages` with Claude
 * subscription, `codex_responses` with ChatGPT subscription) — in those
 * cases the adapter calls `CredentialResolver` again at request time so a
 * fresh access token can be minted from the refresh token in `auth.json`.
 *
 * `source` records where the resolved value came from, for `aiden doctor`
 * diagnostics and for honest user-facing error messages ("API key from
 * config.yaml is rejected" beats "401").
 *
 */
export interface RuntimeResolution {
  provider: string;
  apiMode: ApiMode;
  baseUrl: string;
  apiKey: string | null;
  oauthRefreshable?: boolean;
  source: 'cli' | 'config' | 'env' | 'auth.json' | 'default';
}

/**
 * JSON-Schema subset accepted by both the Anthropic and OpenAI tool-calling
 * specs. Adapters translate this to their wire format (Anthropic embeds it
 * as `input_schema`; OpenAI wraps it under `function.parameters`; Ollama
 * stringifies it into the prompt).
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * A tool call requested by the model on a turn. `id` is the provider's
 * correlation token (Anthropic's `tool_use.id`, OpenAI's `tool_calls[].id`)
 * and must be echoed back in the matching `ToolCallResult`.
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The result of executing a tool call, fed back into the next provider call
 * as a `tool` role message. `error` is set instead of `result` when
 * dispatch threw — the model sees the error string and decides how to recover.
 *
 * v4.1.3-repl-polish: `degraded` and `degradedReason` are set by tool
 * implementations that complete with a best-effort / partial result (the
 * agent still receives the full result; the CLI trail row is rendered in
 * degraded-yellow rather than silently erased). Three built-in tools use
 * this: recall_session (cached data), app_launch (CLI fallback),
 * media_key (vault locked → default key).
 */
/**
 * Structured payload a tool can return to surface a "capability card"
 * to the user instead of (or alongside) a generic error string. v4.1.3-
 * essentials addition. The REPL renders this as a box-bordered block
 * with Can-still / Cannot-reliably / Fix sections — distinct from the
 * one-line tool trail row because it's a different category of
 * information (state assessment, not action trace).
 *
 * Schema is intentionally minimal — short labeled bullet lists + a
 * single-sentence fix hint. Anything richer should live in a skill.
 */
export interface CapabilityCardData {
  /** Headline — typically "<feature> requires <X>". */
  title:           string;
  /** Bullet list (~3-5 entries) of actions still available without
   *  the missing capability. */
  canStill:        string[];
  /** Bullet list (~3-5 entries) of actions blocked or unreliable. */
  cannotReliably:  string[];
  /** Single-sentence guidance — e.g. "Run /auth login chatgpt-plus"
   *  or "Open this skill on Windows for full functionality." */
  fix:             string;
  /**
   * v4.2 Phase 3 — optional one-line "what happened" summary surfaced
   * above the canStill section. Reserved for failure-report context
   * like "Tried 8 tool calls · 6 failed · 2 succeeded · 4.2s". Absent
   * for v4.1.3-style capability cards.
   */
  whatHappened?:   string;
  /**
   * v4.2 Phase 3 — optional failure-category breakdown, rendered as a
   * row of inline pills. Pure aggregation; renderer formats each
   * entry as `<category>(<count>)`. Ordered by descending count then
   * category priority. Absent for v4.1.3-style capability cards.
   */
  failuresByCategory?: Array<{ category: string; count: number }>;
  /**
   * v4.3 Phase 5 — optional one-line browser context summary surfaced
   * below the canStill section. Populated by `enrichCardWithReport`
   * from a RecoveryReport's `browserContext` field (active tab URL,
   * blocker kind, other-tab count, stale-ref retry count). Renderer
   * prints as a muted "Browser:" line; absent when browser depth
   * is off OR when no browser activity occurred this turn.
   */
  browserContext?: string;
  /**
   * v4.4 Phase 5 — optional one-line sandbox context summary. Populated
   * by `enrichCardWithReport` from a RecoveryReport's `sandboxContext`
   * field (violation count, FS-vs-shell split, last matched code,
   * auto-derived AIDEN_SANDBOX_ALLOW suggestion). Renderer prints as a
   * muted "Sandbox:" line right below `browserContext`; absent when
   * AIDEN_SANDBOX is off OR when no sandbox violation occurred this turn.
   */
  sandboxContext?: string;
}

export interface ToolCallResult {
  id: string;
  name: string;
  result: unknown;
  error?: string;
  /** True when the tool completed but with a degraded / partial result. */
  degraded?: boolean;
  /** Human-readable reason shown in the trail row suffix (≤40 chars). */
  degradedReason?: string;
  /**
   * v4.1.3-essentials: structured tags for what this tool requires to
   * succeed. Free-form labels — `['Windows']`, `['ChatGPT Plus OAuth']`,
   * `['GITHUB_TOKEN env var']`. The REPL doesn't act on these directly
   * (yet); they're set alongside `capabilityCard` for diagnostics and
   * potential future "what's missing across all my tools" tooling.
   */
  requires?:       string[];
  /**
   * v4.1.3-essentials: when set, the REPL renders this card instead of
   * the bare error string. Tools opt in by returning this payload from
   * their `windowsOnlyError`-style failure paths or from provider-auth
   * failure paths. Pure data — render is the REPL's concern.
   */
  capabilityCard?: CapabilityCardData;
}

/**
 * Conversation message. Discriminated on `role`. Assistant turns may carry
 * `toolCalls` alongside (or instead of) text content. Tool turns carry the
 * matching `toolCallId` so the model can correlate result → request.
 *
 * `content` is plain text in v4.0.0; structured content blocks (images,
 * documents) get added in Phase 4 when vision/file tools land.
 */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; content: string };

/**
 * Inputs to a single provider call. `extraBody` is the escape hatch for
 * provider-specific fields (Anthropic `metadata`, OpenAI `response_format`,
 * Ollama `options.num_ctx`, etc.) so we can extend without churning the
 * core interface.
 */
export interface ProviderCallInput {
  messages: Message[];
  tools: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  extraBody?: Record<string, unknown>;
}

/**
 * Output of a single provider call (one turn).
 *
 * `finishReason`:
 *   - 'stop'     : model produced a final answer; loop ends.
 *   - 'tool_use' : model requested tools; dispatch them and loop again.
 *   - 'length'   : hit max_tokens; caller may retry with a longer budget.
 *   - 'error'    : adapter-detected protocol-level failure.
 *
 * `usage` carries cache read/write tokens for Anthropic prefix caching;
 * other adapters leave them undefined.
 *
 * `raw` is retained on debug builds for trajectory replay; production
 * code should never depend on its shape.
 */
export interface ProviderCallOutput {
  content: string | null;
  toolCalls: ToolCallRequest[];
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  raw?: unknown;
}

/**
 * Phase 16c streaming event union. `callStream` yields these in order:
 *   1. Zero or more `delta` events carrying incremental text content.
 *   2. Zero or more `tool_call` events. Once a `tool_call` is seen on a
 *      turn, the adapter SHOULD stop emitting `delta` events for the
 *      same turn — agent loops use `tool_call` arrival as the cue to
 *      switch the display from "streaming reply" to "executing tool"
 *      mode ( `_call_chat_completions` line 6852).
 *   3. Exactly one `done` event at end-of-turn carrying finish reason +
 *      usage + the assembled final `ProviderCallOutput`. The agent loop
 *      pushes `output` onto its conversation history just like the
 *      non-streaming path.
 *
 * `delta.content` may include partial UTF-8 codepoints split across SSE
 * chunks; downstream consumers should accept the bytes as-is and let
 * later concatenation reconstitute multi-byte chars.
 *
 * `done.output` MUST be self-contained — callers should not mix
 * accumulated `delta` text with `output.content`. The adapter assembles
 * the final content for them.
 */
export type StreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'tool_call'; toolCall: ToolCallRequest }
  /**
   * v4.1.4 Part 1.6 — incremental output-token counter. Optional;
   * adapters opt in when they have the data (Anthropic emits
   * `message_delta.usage.output_tokens` running counter, OpenAI-compat
   * varies, Ollama has no mid-stream signal). When no `progress`
   * events are emitted, the display layer's token progress bar stays
   * hidden — honest degradation, no fake estimates.
   *
   * `outputTokens` is the CUMULATIVE count for the turn so far
   * (not a delta between chunks). Adapters that report deltas should
   * accumulate before emitting.
   *
   * `maxTokens` is the budget the turn was called with — display
   * uses it for the bar's fill ratio. Adapters that don't know the
   * budget can omit (display falls back to `?` denominator).
   */
  | { type: 'progress'; outputTokens: number; maxTokens?: number }
  | { type: 'done'; output: ProviderCallOutput };

/**
 * The contract every adapter must satisfy. `call` is the required
 * non-streaming path (used by tests, `aiden batch`, and any code path that
 * needs deterministic completion). `callStream` is optional; when present
 * it yields incremental partials and the loop wires them to the display
 * layer.
 *
 * Adapters MUST be stateless. All session state lives in the messages
 * array — this is what makes prompt caching and trajectory replay tractable.
 */
export interface ProviderAdapter {
  apiMode: ApiMode;
  call(input: ProviderCallInput): Promise<ProviderCallOutput>;
  callStream?(input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void>;
}

/**
 * Credential snapshot returned by `CredentialResolver` for a given provider.
 * Either `apiKey` or `oauthToken` is populated, never both. When
 * `oauthRefreshable` is true the resolver knows how to mint a new token
 * from the refresh token in `auth.json`; the adapter should retry once on
 * a 401 before propagating the error.
 *
 */
export interface CredentialSource {
  apiKey?: string;
  oauthToken?: string;
  oauthRefreshable: boolean;
  expiresAt?: Date;
}
