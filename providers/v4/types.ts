/**
 * providers/v4/types.ts — Aiden v4.0.0
 *
 * Provider abstraction contracts. Every adapter (anthropic, chat_completions,
 * codex_responses, ollama_prompt_tools) implements `ProviderAdapter`.
 *
 * Status: SCAFFOLDING — types only. Concrete adapters land in Phase 3.
 *   See docs/v4.0.0-architecture.md, sections "v4.0.0 system architecture"
 *   and "File-by-file mapping: Hermes → Aiden / Providers".
 *
 * Hermes references:
 *   - API mode dispatch:   hermes-agent/run_agent.py (the four-branch switch)
 *   - Anthropic adapter:   hermes-agent/agent/anthropic_adapter.py
 *   - Runtime resolver:    hermes-agent/hermes_cli/runtime_provider.py
 *   - Credential resolver: hermes-agent/hermes_cli/auth.py
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
 * Hermes reference: hermes_cli/runtime_provider.py — RuntimeProvider.resolve()
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
 */
export interface ToolCallResult {
  id: string;
  name: string;
  result: unknown;
  error?: string;
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
  callStream?(input: ProviderCallInput): AsyncIterable<Partial<ProviderCallOutput>>;
}

/**
 * Credential snapshot returned by `CredentialResolver` for a given provider.
 * Either `apiKey` or `oauthToken` is populated, never both. When
 * `oauthRefreshable` is true the resolver knows how to mint a new token
 * from the refresh token in `auth.json`; the adapter should retry once on
 * a 401 before propagating the error.
 *
 * Hermes reference: hermes_cli/auth.py — Credential / RefreshableCredential
 */
export interface CredentialSource {
  apiKey?: string;
  oauthToken?: string;
  oauthRefreshable: boolean;
  expiresAt?: Date;
}
