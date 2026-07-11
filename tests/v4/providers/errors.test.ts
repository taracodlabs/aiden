import { describe, it, expect } from 'vitest';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  formatRawForMessage,
  classifyProviderError,
  suggestForErrorClass,
} from '../../../providers/v4/errors';

/**
 * Phase v4.1.1-oauth-fix #3 — ProviderError.message must surface the
 * upstream response body so the user sees *why* a 4xx fired, not just
 * the HTTP status. Aligns the provider-error surface with Aiden's
 * "honest by design" commitment.
 *
 * Contract:
 *   - .raw is preserved verbatim for programmatic consumers.
 *   - .message is composed as `<short> [: <truncated raw summary>]`.
 *   - OpenAI / Anthropic envelope `{ error: { message } }` is recognised.
 *   - Plain string bodies pass through.
 *   - Empty / missing bodies leave the short message unchanged.
 *   - Long bodies are truncated to 300 chars with an ellipsis.
 */
describe('ProviderError message composition', () => {
  it('includes OpenAI-style error.message in the surfaced message', () => {
    const err = new ProviderError(
      'Provider chatgpt-plus request failed (400)',
      'chatgpt-plus',
      400,
      { error: { message: "model 'gpt-5' does not exist or you do not have access" } },
      false,
    );
    expect(err.message).toContain('chatgpt-plus');
    expect(err.message).toContain('400');
    expect(err.message).toContain('gpt-5');
    expect(err.message).toContain('does not exist');
  });

  it('includes Anthropic-style error.message in the surfaced message', () => {
    const err = new ProviderError(
      'Provider anthropic request failed (401)',
      'anthropic',
      401,
      { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    );
    expect(err.message).toContain('invalid x-api-key');
  });

  it('handles plain string body', () => {
    const err = new ProviderError(
      'Provider groq server error 500',
      'groq',
      500,
      'Internal Server Error',
      true,
    );
    expect(err.message).toContain('Internal Server Error');
  });

  it('falls back to top-level .message when error envelope absent', () => {
    const err = new ProviderError(
      'Provider test request failed (422)',
      'test',
      422,
      { message: 'Invalid request payload', code: 'invalid_payload' },
    );
    expect(err.message).toContain('Invalid request payload');
  });

  it('handles missing body gracefully — short message unchanged', () => {
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
    );
    expect(err.message).toBe('Provider test request failed (400)');
    expect(err.raw).toBeUndefined();
  });

  it('handles empty string body — no trailing ": "', () => {
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
      '',
    );
    expect(err.message).toBe('Provider test request failed (400)');
  });

  it('handles whitespace-only string body', () => {
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
      '   \n  ',
    );
    expect(err.message).toBe('Provider test request failed (400)');
  });

  it('truncates very long bodies with ellipsis and stays well under 400 chars', () => {
    const longBody = 'x'.repeat(1000);
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
      longBody,
    );
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).toContain('…');
    expect(err.message).toContain('xxxxx');
  });

  it('ollama-style plain JSON body does not duplicate when adapter passes raw separately', () => {
    // Phase v4.1.1-oauth-fix Phase 5 regression: ollama adapter used to
    // inline the body into the message string AND pass it as `raw`, so
    // the body appeared twice in err.message after composeMessage ran.
    // The adapter now emits a short message and lets composeMessage
    // do the rendering.
    const err = new ProviderError(
      'Provider ollama returned 404',
      'ollama',
      404,
      '{"error":"model \'llama3.2\' not found"}',
    );
    const occurrences = (err.message.match(/model 'llama3\.2' not found/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(err.message).toContain('Provider ollama returned 404');
  });

  it('preserves .raw for programmatic inspection', () => {
    const rawBody = { error: { message: 'boom', type: 'invalid_request_error' } };
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
      rawBody,
    );
    expect(err.raw).toEqual(rawBody);
    expect((err.raw as { error: { type: string } }).error.type).toBe('invalid_request_error');
  });

  it('preserves statusCode + providerName + retryable fields', () => {
    const err = new ProviderError(
      'Provider chatgpt-plus request failed (400)',
      'chatgpt-plus',
      400,
      { error: { message: 'nope' } },
      false,
    );
    expect(err.providerName).toBe('chatgpt-plus');
    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('ProviderError');
  });
});

describe('ProviderRateLimitError', () => {
  it('includes upstream rate-limit body when provided', () => {
    const err = new ProviderRateLimitError('groq', {
      error: { message: 'rate limit exceeded: 30 req/min' },
    });
    expect(err.message).toContain('rate limited');
    expect(err.message).toContain('30 req/min');
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('ProviderRateLimitError');
  });

  it('works without a raw body', () => {
    const err = new ProviderRateLimitError('groq');
    expect(err.message).toBe('Provider groq rate limited');
    expect(err.retryable).toBe(true);
  });
});

describe('ProviderTimeoutError', () => {
  it('reports the timeout duration; no raw body to surface', () => {
    const err = new ProviderTimeoutError('chatgpt-plus', 30000);
    expect(err.message).toBe('Provider chatgpt-plus timed out after 30000ms');
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBeUndefined();
    expect(err.name).toBe('ProviderTimeoutError');
  });
});

describe('formatRawForMessage helper', () => {
  it('returns null for undefined / null', () => {
    expect(formatRawForMessage(undefined)).toBeNull();
    expect(formatRawForMessage(null)).toBeNull();
  });

  it('extracts OpenAI envelope', () => {
    expect(
      formatRawForMessage({ error: { message: 'bad model' } }),
    ).toBe('bad model');
  });

  it('returns null when envelope present but message missing', () => {
    expect(formatRawForMessage({ error: { type: 'x' } })).toBeNull();
  });

  it('returns null for non-string non-object scalars', () => {
    expect(formatRawForMessage(42)).toBeNull();
    expect(formatRawForMessage(true)).toBeNull();
  });

  // Phase v4.1.2-bug3: Codex Responses {detail: "..."} envelope.
  // Surfaced by v4.1.2-slice5 (the chatgpt-plus liveness probe
  // 400'd with this body shape, but the user saw bare "request
  // failed (400)" until we manually instrumented).

  it('extracts Codex {detail: "..."} envelope verbatim', () => {
    expect(
      formatRawForMessage({
        detail: "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
      }),
    ).toBe("The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.");
  });

  it('falls through to null when detail is empty', () => {
    expect(formatRawForMessage({ detail: '' })).toBeNull();
  });

  it('falls through to null when detail is non-string (FastAPI array form)', () => {
    // FastAPI schema validation: detail is an array of {loc, msg, type}.
    // Leave it to .raw for programmatic consumers; the message tail
    // stays empty rather than rendering "[object Object]".
    expect(
      formatRawForMessage({
        detail: [{ loc: ['body', 'tools'], msg: 'invalid', type: 'value_error' }],
      }),
    ).toBeNull();
    // Nested objects.
    expect(
      formatRawForMessage({ detail: { code: 'BAD_MODEL', reason: 'tier' } }),
    ).toBeNull();
  });

  it('truncates long detail bodies to 300 chars with ellipsis', () => {
    const long = 'd'.repeat(500);
    const out = formatRawForMessage({ detail: long });
    expect(out!.length).toBeLessThanOrEqual(301);
    expect(out).toMatch(/…$/);
  });

  it('regression: OpenAI envelope still wins over a co-present detail field', () => {
    // Defensive — if a provider ever returns both shapes in the same
    // body, the OpenAI envelope is the canonical one we already
    // recognised, so it must keep precedence.
    expect(
      formatRawForMessage({
        error: { message: 'canonical openai reason' },
        detail: 'codex reason',
      }),
    ).toBe('canonical openai reason');
  });

  it('regression: top-level message still wins over detail', () => {
    expect(
      formatRawForMessage({
        message: 'top-level reason',
        detail:  'codex reason',
      }),
    ).toBe('top-level reason');
  });
});

describe('ProviderError composes Codex {detail} into the surfaced message', () => {
  it('renders the Codex detail string in the tail', () => {
    // The exact body captured in slice5's diagnostic instrumentation.
    const err = new ProviderError(
      'Provider chatgpt-plus request failed (400)',
      'chatgpt-plus',
      400,
      {
        detail: "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
      },
      false,
    );
    expect(err.message).toContain('Provider chatgpt-plus request failed (400)');
    expect(err.message).toContain("'gpt-5.1-codex-max' model is not supported");
    // .raw is preserved verbatim so doctor / programmatic consumers
    // see the full envelope (including the leading FastAPI key).
    expect((err.raw as { detail: string }).detail)
      .toContain("'gpt-5.1-codex-max'");
  });
});

// ── v4.1.3-prebump: classifyProviderError ──────────────────────────────
//
// Coarse error-class detection feeds the REPL's tailored action-hint
// suggestion. Status-code is the structured signal; message-substring
// scan covers adapters that pass through the upstream JSON message
// verbatim.

describe('classifyProviderError', () => {
  it('returns rate_limit for ProviderRateLimitError instances', () => {
    expect(classifyProviderError(new ProviderRateLimitError('groq'))).toBe('rate_limit');
  });

  it('returns transport for ProviderTimeoutError instances', () => {
    expect(classifyProviderError(new ProviderTimeoutError('groq', 5000))).toBe('transport');
  });

  it('classifies statusCode 413 as context_overflow', () => {
    const err = new ProviderError('payload', 'groq', 413);
    expect(classifyProviderError(err)).toBe('context_overflow');
  });

  it('classifies statusCode 429 as rate_limit (even without subclass)', () => {
    const err = new ProviderError('throttled', 'groq', 429);
    expect(classifyProviderError(err)).toBe('rate_limit');
  });

  it('classifies statusCode 401/403 as auth', () => {
    expect(classifyProviderError(new ProviderError('x', 'p', 401))).toBe('auth');
    expect(classifyProviderError(new ProviderError('x', 'p', 403))).toBe('auth');
  });

  it('falls back to message scan for context_overflow ("too large" / "413" / "context_length_exceeded")', () => {
    expect(classifyProviderError(new Error('Request payload too large'))).toBe('context_overflow');
    expect(classifyProviderError(new Error('HTTP 413 Payload Too Large'))).toBe('context_overflow');
    expect(classifyProviderError(new Error('context_length_exceeded: 50000 > 32768')))
      .toBe('context_overflow');
    expect(classifyProviderError(new Error('exceeds maximum context length')))
      .toBe('context_overflow');
  });

  it('falls back to message scan for rate_limit ("429" / "rate limit" / "TPM" / "quota")', () => {
    expect(classifyProviderError(new Error('429 Too Many Requests'))).toBe('rate_limit');
    expect(classifyProviderError(new Error('rate_limit reached for model'))).toBe('rate_limit');
    expect(classifyProviderError(new Error('Free-tier TPM exceeded'))).toBe('rate_limit');
    expect(classifyProviderError(new Error('quota exhausted'))).toBe('rate_limit');
  });

  it('falls back to message scan for auth ("401" / "invalid_api_key" / "unauthorized")', () => {
    expect(classifyProviderError(new Error('401 Unauthorized'))).toBe('auth');
    expect(classifyProviderError(new Error('invalid_api_key: keys revoked'))).toBe('auth');
    expect(classifyProviderError(new Error('Forbidden — token expired'))).toBe('auth');
  });

  it('falls back to message scan for transport (ECONNREFUSED / ENOTFOUND / network)', () => {
    expect(classifyProviderError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe('transport');
    expect(classifyProviderError(new Error('getaddrinfo ENOTFOUND api.groq.com'))).toBe('transport');
    expect(classifyProviderError(new Error('socket hang up'))).toBe('transport');
  });

  it('returns other for unrelated errors', () => {
    expect(classifyProviderError(new Error('zoinks something weird'))).toBe('other');
    expect(classifyProviderError('not even an Error')).toBe('other');
    expect(classifyProviderError(null)).toBe('other');
    expect(classifyProviderError(undefined)).toBe('other');
  });

  it('prefers statusCode over message scan when both signals disagree', () => {
    // statusCode says 413; message contains "rate limit". Structured
    // signal wins.
    const err = new ProviderError('rate limit hit', 'groq', 413);
    expect(classifyProviderError(err)).toBe('context_overflow');
  });
});

// ── v4.1.3-prebump: suggestForErrorClass ───────────────────────────────

describe('suggestForErrorClass', () => {
  it('context_overflow suggestion names the provider and points at /model', () => {
    const s = suggestForErrorClass('context_overflow', 'groq');
    expect(s).toBeTruthy();
    expect(s!).toContain('groq');
    expect(s!).toContain('413');
    expect(s!).toContain('/model');
    // Names larger-context alternatives.
    expect(s!).toContain('chatgpt-plus');
  });

  it('rate_limit suggestion names the provider and gives a wait-or-switch option', () => {
    const s = suggestForErrorClass('rate_limit', 'groq');
    expect(s).toContain('groq');
    expect(s).toMatch(/rate.?limit/i);
    expect(s).toContain('/model');
  });

  it('auth suggestion points at /auth status + /auth login', () => {
    const s = suggestForErrorClass('auth', 'anthropic');
    expect(s).toContain('anthropic');
    expect(s).toContain('/auth status');
    expect(s).toContain('/auth login');
  });

  it('transport suggestion mentions ollama as offline fallback', () => {
    const s = suggestForErrorClass('transport', 'groq');
    expect(s).toContain('ollama');
  });

  it('other returns null so the caller keeps its generic fallback', () => {
    expect(suggestForErrorClass('other', 'groq')).toBeNull();
  });

  it('handles missing provider name gracefully', () => {
    const s = suggestForErrorClass('rate_limit', undefined);
    expect(s).toBeTruthy();
    expect(s!).toContain('this provider');
  });
});
