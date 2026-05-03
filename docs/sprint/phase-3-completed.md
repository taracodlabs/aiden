# Phase 3 — Completed

**Date:** 2026-05-03
**Branch:** `v4-rewrite`
**Commits:**
- `e3e0291` — feat(v4): chat completions adapter + Groq/OR/Together/Gemini support
- (this file) — docs(v4): phase 3 summary

## Goal

Build the first real `ProviderAdapter` — `ChatCompletionsAdapter` — speaking
the OpenAI-style `/v1/chat/completions` API. Single adapter covers Groq,
OpenRouter, Together, Gemini-via-OpenAI-compat, and most other providers
because they all implement the same wire format.

After this phase, `AidenAgent` runs end-to-end against a real LLM. Verified.

## Wire format quirks (Task 1)

Mapped from `agent/transports/chat_completions.py` (Hermes
`ChatCompletionsTransport` at L102) and the OpenAI spec.

1. **Tool arguments are a JSON string.** `choices[0].message.tool_calls[i].function.arguments` is always stringified — adapter `JSON.parse`s it. On parse failure, falls back to `{}` and `console.warn`s; never throws (rare LLM hallucination, the loop must keep going).
2. **Content is nullable on `tool_calls`.** When the model emits only tool_calls, `message.content` is `null` (not `""`). v4 contract preserves the `null`.
3. **`finish_reason` enum mismatch.** OpenAI uses `'tool_calls'` (plural); v4 contract uses `'tool_use'` (singular, matches Anthropic). `'stop'`/`'length'` pass through; unknowns fall back to `'tool_use'` if any tool calls present, else `'stop'`.
4. **Tools wrap as `{type:'function', function:{name, description, parameters}}`** — JSON Schema nested under `function.parameters`. Anthropic's flat `input_schema` is the Phase-4 adapter's job.
5. **Usage uses `prompt_tokens` / `completion_tokens`** (not `input`/`output`). Adapter maps to v4's `inputTokens`/`outputTokens`. OpenRouter sometimes includes `cache_read_input_tokens` for Anthropic-via-OR — captured into `cacheReadTokens` opportunistically.

Bonus: multiple system messages at the head get concatenated with `\n\n` (some OAI-compat providers reject >1 system message).

## Public API

`providers/v4/chatCompletionsAdapter.ts` (408 lines):

```ts
export interface ChatCompletionsAdapterOptions {
  baseUrl: string;            // 'https://api.groq.com/openai/v1' (no trailing /)
  apiKey: string;
  model: string;
  providerName: string;       // for error messages and logging
  timeoutMs?: number;         // default 120_000
  maxRetries?: number;        // default 2 (so 3 attempts total)
  extraHeaders?: Record<string, string>;  // OpenRouter HTTP-Referer / X-Title
}

export class ChatCompletionsAdapter implements ProviderAdapter {
  apiMode: 'chat_completions';
  constructor(options: ChatCompletionsAdapterOptions);
  call(input: ProviderCallInput): Promise<ProviderCallOutput>;
}
```

`providers/v4/errors.ts` (50 lines): three error classes covering the
retryable / non-retryable taxonomy.

```ts
class ProviderError extends Error { providerName; statusCode?; raw?; retryable; }
class ProviderTimeoutError extends ProviderError { /* always retryable */ }
class ProviderRateLimitError extends ProviderError { /* statusCode 429 */ }
```

## Test coverage

**Unit tests** — `tests/v4/chatCompletionsAdapter.test.ts` (349 lines, 14 cases, all passing in 493 ms):

| # | Case | Verifies |
|---:|---|---|
| 1 | Builds correct request body | URL, headers, JSON shape (model, messages, tools wrapped, tool_choice='auto') |
| 2 | Parses simple stop response | content, empty toolCalls, finishReason='stop', usage mapped |
| 3 | Parses single tool_calls response | content=null, toolCalls len 1, parsed args, finishReason='tool_use' |
| 4 | Parses multiple tool_calls in one response | both args parsed correctly |
| 5 | Malformed tool args fall back to `{}` and warn | doesn't throw, console.warn fires once |
| 6 | Translates all 4 message roles correctly | system / user / assistant+toolCalls → tool_calls plural / tool → tool_call_id |
| 7 | Multiple system messages concatenated | 2 system → 1 system, joined with `\n\n` |
| 8 | Retries on 429 then succeeds | 3 fetch calls, content from 3rd response |
| 9 | After retries exhausted on 429 → ProviderRateLimitError | 3 fetches total, correct error class |
| 10 | Retries on 500 → ProviderError | 3 fetches, statusCode 500 |
| 11 | 401 does NOT retry | 1 fetch only, retryable=false |
| 12 | Timeout throws ProviderTimeoutError | AbortController fires correctly |
| 13 | Usage tokens map correctly | prompt→input, completion→output, cache_read captured |
| 14 | extraHeaders sent | HTTP-Referer + X-Title forwarded with request |

**Integration tests** — `tests/v4/integration/chatCompletionsAdapter.groq.test.ts` (80 lines, 2 cases):

| # | Case | Verifies |
|---:|---|---|
| 1 | Simple completion, no tools | Real Groq returns 'PONG'; finishReason='stop'; usage > 0 |
| 2 | End-to-end tool-calling via AidenAgent | Real Groq picks tool, AidenAgent dispatches, model sees result, generates final response containing the time |

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0, zero errors |
| `npx vitest run tests/v4/chatCompletionsAdapter.test.ts` | ✅ **14/14 pass** (493 ms) |
| `GROQ_API_KEY=… npx vitest run tests/v4/integration/…groq.test.ts` | ✅ **2/2 pass** (1.23 s) |
| `npx vitest run tests/v4/` (no env) | ✅ 28 passed, 2 skipped (integration auto-skips without key) |
| Full `npm test` | ✅ 16 file failures (same pre-existing set), **140 file pass** (+1), **1443 tests pass** = 1417 baseline + 12 (Phase 2) + 14 (Phase 3) ✓ |

**Integration result: PASS.** First v4 LLM-driven tool-calling conversation
end-to-end. The fabrication-fix architecture works against a real provider.

## Graphify

| Metric | Pre-Phase 3 | Post-Phase 3 | Δ |
|---|---:|---:|---:|
| Nodes | 1858 | **1882** | +24 |
| Edges | 3368 | 3406 | +38 |
| Communities | 153 | 151 | -2 |

Hook fired on `e3e0291`; rebuild ran inline.

## Skipped / deferred (by design)

- **Streaming (`callStream`)** — Phase 13. Adapter implements only the
  required `call`; streaming gets a separate path so the non-streaming
  contract stays simple.
- **Other adapters** (Anthropic, Codex, Ollama) — Phase 4.
- **Provider chain / fallback orchestration** — Phase 8. Phase 2 has the
  one-shot `FallbackStrategy` hook on `AidenAgent`; the chain that drives it
  comes later.
- **Credential resolver** — Phase 4. Phase 3 takes `apiKey` directly so the
  adapter is testable in isolation; `runtimeResolver`/`credentialResolver`
  produce that key.
- **Auxiliary client routing** (vision/summary models) — Phase 12.
- **Prompt caching breakpoints** — Phase 12 (Anthropic-specific anyway).
- **`reasoning_effort`, full `extra_body` plumbing** — Phase 13. The adapter
  forwards `input.extraBody` if present, but the various provider quirks
  (Gemini thinkingConfig, GitHub Models reasoning, LM Studio effort, Moonshot
  schema sanitizer) live in Hermes `build_kwargs` and will be ported as
  needed.
- **Codex sanitization** (drop `codex_reasoning_items`, `call_id`) — only
  needed when forwarding from a Codex Responses adapter; lands when that
  adapter does (Phase 4).

## What Phase 4 needs to know

**Phase 4 mission:** the remaining three adapters — Anthropic, Codex,
Ollama — plus credentialResolver / runtimeResolver.

**Recommended order:**

1. **`anthropicAdapter.ts`** first. Reasons:
   - Different wire format (top-level `system`, `tool_use`/`tool_result`
     content blocks, `input_schema` flat) — exercises a fundamentally
     different shape than chat_completions and proves the abstraction holds.
   - Prefix caching (`cache_control` breakpoints) is the killer feature that
     justifies the Pro tier OAuth flow. Even though caching itself lands in
     Phase 12, the request shape needs to support it now.
   - Required for Claude subscription OAuth login (`anthropic_messages` API
     mode). Higher-priority than Codex for v4.0.0 launch.
2. **`ollamaPromptToolsAdapter.ts`** second. Local fallback — emulates tool
   calling by injecting JSON-call instructions into the prompt. Smaller
   surface area; mostly a parser + prompt template.
3. **`codexResponsesAdapter.ts`** last. Most complex — Codex wraps requests
   under `/v1/responses` with `reasoning_items` blocks, item IDs, and a
   distinct streaming envelope. Defer until after Anthropic + Ollama prove
   the contract.

**Surfaces ready to plug into:**
- `ProviderError` / `ProviderTimeoutError` / `ProviderRateLimitError` — reuse for all adapters.
- `ChatCompletionsAdapter`'s retry / timeout pattern — copy the helper
  shape (`fetchWithTimeout`, `backoffMs`, `safeReadText`) into a small
  shared `providers/v4/_transport.ts` if/when the second adapter wants the
  same logic. Don't preemptively refactor.

**Token-efficient pattern for Phase 4:** start with `graphify query
"anthropic adapter request format"` against Hermes (file is
`agent/anthropic_adapter.py`). Don't re-read this file.

## Acceptance check (Phase 3)

- [x] Wire format summary written (Task 1, 5 bullets above)
- [x] `providers/v4/chatCompletionsAdapter.ts` implements `ProviderAdapter` (408 lines)
- [x] `providers/v4/errors.ts` has 3 error classes (50 lines)
- [x] All 14 unit tests pass
- [x] Integration tests run and **both PASS** against real Groq
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression: 1443 tests passing = 1417 baseline + 12 + 14 ✓
- [x] Two commits on `v4-rewrite` (`e3e0291` + this docs commit)
- [x] Both pushed to `backup`
- [x] Hook fired; graph **1858 → 1882 nodes**
- [x] `docs/sprint/phase-3-completed.md` written, under 200 lines
