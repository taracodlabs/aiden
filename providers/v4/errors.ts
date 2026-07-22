/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/errors.ts — Aiden v4.0.0
 *
 * Error taxonomy for provider adapters. Adapters throw these so callers
 * (AidenAgent, fallback strategies, future provider chain) can distinguish
 * retryable transport failures from permanent request bugs.
 *
 * Status: PHASE 3.
 */

/**
 * Format a raw response body for inclusion in the user-facing error
 * message. Recognises three JSON envelope shapes and falls back to the
 * raw string for plain-text bodies. Returns null when nothing useful is
 * available so callers can omit the ": <detail>" tail entirely.
 *
 * Recognised envelopes (most-specific first):
 *   1. OpenAI / Anthropic:  `{ error: { message: "..." } }`
 *   2. Top-level message:   `{ message: "..." }`
 *   3. Codex Responses:     `{ detail: "..." }` (Phase v4.1.2-bug3 —
 *      surfaced by slice5: the Codex backend at chatgpt.com/backend-api/
 *      codex/responses returns 4xx bodies in this shape, e.g.
 *      `{"detail": "The 'gpt-5.1-codex-max' model is not supported..."}`)
 *
 * Truncates to 300 chars to keep multi-line responses from blowing
 * up the user's terminal — full body remains on `error.raw` for
 * programmatic consumers / `aiden doctor --providers` deep mode.
 */
export function formatRawForMessage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;

  // OpenAI / Anthropic JSON envelope: { error: { message: "..." } }
  if (typeof raw === 'object') {
    const err = (raw as { error?: unknown }).error;
    if (err && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string' && msg.length > 0) {
        return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
      }
    }
    // Some providers put the message at the top level.
    const topMsg = (raw as { message?: unknown }).message;
    if (typeof topMsg === 'string' && topMsg.length > 0) {
      return topMsg.length > 300 ? `${topMsg.slice(0, 300)}…` : topMsg;
    }
    // Codex Responses envelope: { detail: "..." }. Distinct from the
    // OpenAI shape — the Codex backend uses FastAPI-style validation
    // errors that surface as `detail` (str) for tier/auth rejections
    // and `detail: [{...}]` for schema errors. Only the string form is
    // useful in the message tail; the array form is left to .raw.
    const detail = (raw as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.length > 0) {
      return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
    }
    return null;
  }

  // Plain string body.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  }

  return null;
}

/**
 * Compose the final `Error.message` from the short summary and (when
 * available) the parsed/truncated raw response body. The body remains
 * stashed on `ProviderError.raw` either way — this only enriches what
 * users see when the error is rendered.
 */
function composeMessage(message: string, raw: unknown): string {
  const tail = formatRawForMessage(raw);
  return tail ? `${message}: ${tail}` : message;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly providerName: string,
    public readonly statusCode?: number,
    public readonly raw?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(composeMessage(message, raw));
    this.name = 'ProviderError';
  }
}

/** Thrown when an in-flight request exceeds `timeoutMs`. Always retryable. */
export class ProviderTimeoutError extends ProviderError {
  constructor(providerName: string, timeoutMs: number) {
    super(
      `Provider ${providerName} timed out after ${timeoutMs}ms`,
      providerName,
      undefined,
      undefined,
      true,
    );
    this.name = 'ProviderTimeoutError';
  }
}

export type ProviderTimeoutPhase =
  | 'connection_timeout'
  | 'first_byte_timeout'
  | 'body_idle_timeout'
  | 'total_timeout';

/** Timeout with an exact request-lifecycle phase. */
export class ProviderPhaseTimeoutError extends ProviderTimeoutError {
  constructor(
    providerName: string,
    timeoutMs: number,
    public readonly phase: ProviderTimeoutPhase,
  ) {
    super(providerName, timeoutMs);
    this.name = 'ProviderPhaseTimeoutError';
    this.message = `Provider ${providerName} exceeded ${phase.replace(/_/g, ' ')} after ${timeoutMs}ms`;
  }
}

/** Thrown after retries are exhausted on HTTP 429. Caller may pause and retry. */
export class ProviderRateLimitError extends ProviderError {
  constructor(providerName: string, raw?: unknown) {
    super(
      `Provider ${providerName} rate limited`,
      providerName,
      429,
      raw,
      true,
    );
    this.name = 'ProviderRateLimitError';
  }
}

/**
 * v4.1.3-prebump: classify a thrown error into a coarse outcome class
 * the REPL display layer can act on. NOT exhaustive — these are the
 * five classes we surface tailored guidance for; everything else is
 * `other` and the caller falls back to its default suggestion.
 *
 * The classifier examines (in order):
 *   1. `statusCode` on a ProviderError — the structured signal.
 *   2. Error class — `ProviderRateLimitError` → `rate_limit` even
 *      without a status code.
 *   3. Message substrings — for provider adapters that swallow the
 *      status code and surface only the upstream JSON `error.message`.
 *      The strings here cover the actual error messages produced by
 *      Groq / OpenAI / Anthropic / DeepSeek / chat-completions
 *      compatible endpoints.
 *
 * Pure. Returns lowercase string literals. Caller does its own copy.
 */
export type ProviderErrorClass =
  | 'context_overflow'   // 413 / context_length_exceeded / too large
  | 'rate_limit'         // 429 / TPM / quota burst
  | 'auth'               // 401 / 403 / invalid_api_key / unauthenticated
  | 'transport'          // network / DNS / timeout
  | 'other';

export function classifyProviderError(err: unknown): ProviderErrorClass {
  if (err == null) return 'other';

  // 1. Type-based class detection (fastest, most structured).
  if (err instanceof ProviderRateLimitError) return 'rate_limit';
  if (err instanceof ProviderTimeoutError)   return 'transport';

  if (err instanceof ProviderError) {
    if (err.statusCode === 413) return 'context_overflow';
    if (err.statusCode === 429) return 'rate_limit';
    if (err.statusCode === 401 || err.statusCode === 403) return 'auth';
  }

  // 2. Fall back to message scanning. Adapters that pass through the
  //    upstream JSON `error.message` verbatim land here.
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  // Context overflow / 413 family. Groq's free-tier TPM cap triggers
  // these on the first turn once the prompt + tool schemas inflate.
  if (
    lc.includes('413') ||
    lc.includes('context_length_exceeded') ||
    lc.includes('context length') ||
    lc.includes('too large') ||
    lc.includes('maximum context length') ||
    lc.includes('payload too large')
  ) {
    return 'context_overflow';
  }

  // Rate-limit family — 429 / TPM / quota / "too many requests".
  if (
    lc.includes('429') ||
    lc.includes('rate_limit') ||
    lc.includes('rate limit') ||
    lc.includes('too many requests') ||
    lc.includes('quota') ||
    lc.includes('tpm')
  ) {
    return 'rate_limit';
  }

  // Auth family — 401 / 403 / invalid keys / unauthenticated.
  if (
    lc.includes('401') ||
    lc.includes('403') ||
    lc.includes('invalid_api_key') ||
    lc.includes('invalid api key') ||
    lc.includes('unauthenticated') ||
    lc.includes('unauthorized') ||
    lc.includes('forbidden')
  ) {
    return 'auth';
  }

  // Transport — network, DNS, timeouts that escaped the typed path.
  if (
    lc.includes('econnrefused') ||
    lc.includes('enotfound') ||
    lc.includes('etimedout') ||
    lc.includes('socket hang up') ||
    lc.includes('network')
  ) {
    return 'transport';
  }

  return 'other';
}

/**
 * v4.1.3-prebump: produce a single-sentence actionable hint for the
 * given error class. Returns null for `'other'` so the caller can keep
 * its existing default suggestion. Provider name is surfaced where it
 * sharpens the advice ("groq rate-limited" reads clearer than
 * "rate limit").
 *
 * Pure helper. The REPL displays the result; tests assert it. No
 * registry / state access — feed it the class + provider name.
 */
export function suggestForErrorClass(
  cls: ProviderErrorClass,
  providerName: string | undefined,
): string | null {
  const p = providerName ?? 'this provider';
  switch (cls) {
    case 'context_overflow':
      return (
        `${p} returned 413 (context too large). The combined system prompt ` +
        `+ tool schemas exceed ${p}'s context window. Try \`/model\` to ` +
        `switch to a provider with more headroom (chatgpt-plus, anthropic, ` +
        `deepseek).`
      );
    case 'rate_limit':
      return (
        `${p} is rate-limited. Wait a minute, or run \`/model\` to switch ` +
        `to another authed provider while ${p} cools off.`
      );
    case 'auth':
      return (
        `${p} rejected the credentials. Run \`/auth status\` (or check the ` +
        `relevant API key env var) and \`/auth login\` if needed.`
      );
    case 'transport':
      return (
        `Network or transport error reaching ${p}. Check connectivity, then ` +
        `retry — or \`/model\` to a local provider (ollama) for offline work.`
      );
    case 'other':
      return null;
  }
}
