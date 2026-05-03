# Phase 2 — Completed

**Date:** 2026-05-03
**Branch:** `v4-rewrite`
**Commits:**
- `c5481bf` — feat(v4): aidenAgent loop core — single-LLM tool-calling loop
- (this file) — docs(v4): phase 2 summary

## Goal

Build the single-loop agent that replaces v3's planner+responder split.
ONE LLM. Tools called inside the loop. Tool results return to LLM context
before the LLM generates its final response. Architecture prevents
fabrication by design.

## Hermes pattern summary (Task 1)

Mapped from `hermes-agent/run_agent.py` via graphify queries. Key surfaces:

- **Loop control** — `while api_call_count < max_iterations and iteration_budget.remaining > 0` (L10752). Each iteration consumes one budget unit (`IterationBudget.consume()` returns False if exhausted → break with `_turn_exit_reason = "budget_exhausted"`). Loop exits naturally when assistant returns content with no tool_calls.
- **Tool result feeding** — `_execute_tool_calls_sequential` (L9779) runs each call and appends `{role: "tool", tool_call_id, content}` directly to the in-place `messages` list. Next provider call sees the full history. **This is the fabrication fix.**
- **Iteration budget** — `IterationBudget` class (L271). Thread-safe `_used` counter, `consume()` / `refund()` / `remaining`. Default 90 (parent), 50 (subagents). Hermes injects budget pressure warnings into the last tool result's JSON; we replicate the cap + thresholds via callback in Phase 2 and defer the in-band injection to Phase 6 when tool results are real.
- **Fallback chain** — `_fallback_chain` list with `_fallback_index` + `_fallback_activated` flag (L1558+). On provider error the next entry is swapped in; once activated it stays active. Phase 2 simplifies to one-shot `FallbackStrategy.activate(error, attempt)`; multi-step chain is a later phase.

## Public API

`core/v4/aidenAgent.ts` (247 lines):

```ts
export type ToolExecutor = (call: ToolCallRequest) => Promise<ToolCallResult>;

export interface FallbackStrategy {
  activate(error: Error, attempt: number): Promise<ProviderAdapter | null>;
}

export interface AidenAgentOptions {
  provider: ProviderAdapter;
  toolExecutor: ToolExecutor;
  tools: ToolSchema[];
  maxTurns?: number;            // default 90
  fallback?: FallbackStrategy;
  onToolCall?: (call, phase: 'before'|'after', result?) => void;
  onBudgetWarning?: (level: 'caution'|'warning', turn, max) => void;
}

export interface AidenAgentResult {
  finalContent: string;
  messages: Message[];
  turnCount: number;
  toolCallCount: number;
  fallbackActivated: boolean;
  finishReason: 'stop' | 'budget_exhausted' | 'error';
  totalUsage: { inputTokens: number; outputTokens: number };
}

export class AidenAgent {
  constructor(options: AidenAgentOptions);
  runConversation(initialMessages: Message[]): Promise<AidenAgentResult>;
}
```

`core/v4/__mocks__/mockProvider.ts` (53 lines): scripted `ProviderAdapter`
for tests with `MockProviderAdapter.stop(content)` and
`MockProviderAdapter.toolUse(toolCalls)` helpers + `capturedInputs` for
asserting message-history growth.

## Test coverage

`tests/v4/aidenAgent.test.ts` (291 lines, 12 cases, all passing):

| # | Case | Verifies |
|---:|---|---|
| 1 | Happy path — single turn, no tool calls | Stop returns immediately; result shape correct |
| 2 | One tool call, then response | History grows: user → assistant(tool_use) → tool → assistant(stop); 2nd provider call sees tool result |
| 3 | Sequential tool chain | Each tool result is appended before the next provider call (capturedInputs[1] has 1 tool, [2] has 2) |
| 4 | Tool error handled | Throwing executor doesn't crash loop; error string propagates into tool message; LLM sees it |
| 5 | Multiple tool calls in one turn | Both run in order; both results appended; next call sees 2 tool messages |
| 6 | Budget exhaustion | `maxTurns=3` with always-tool_use → terminates with `budget_exhausted` at turn 3 |
| 7 | Budget warning at 70% (caution) | `maxTurns=10`, 7 turns → 1 callback with `('caution', 7, 10)` |
| 8 | Budget warning at 90% (warning) | `maxTurns=10`, 9 turns → 2 callbacks (`caution` at 7, `warning` at 9) |
| 9 | Fallback activates on error | Primary throws once, fallback returns adapter, loop continues, `fallbackActivated: true` |
| 10 | Fallback returns null | Original error propagates verbatim |
| 11 | onToolCall fires before/after | 2 events with correct phase + id + result on `after` |
| 12 | Total usage accumulates | Sum across all 3 turns: 600 input + 100 output |

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0, zero errors |
| `npx vitest run tests/v4/aidenAgent.test.ts` | ✅ **12/12 pass** (385 ms) |
| Full `npm test` | 16 file failures (same pre-existing set), 139 file pass, **1429 tests pass** = 1417 baseline + 12 new ✓ |

The 16 file-level failures are the unchanged pre-existing set from Phase 1
(14 puppeteer/zod missing peer deps in `native-modules/`, 2 empty regression
stubs). Zero v3 regressions.

## Graphify

| Metric | Pre-Phase 2 | Post-Phase 2 | Δ |
|---|---:|---:|---:|
| Nodes | 1843 | **1858** | +15 |
| Edges | 3353 | 3368 | +15 |
| Communities | 48 | 153 | +105 |

Hook fired on `c5481bf`; rebuild ran inline. The big community bump is the
graph picking up the v4 module structure now that real imports exist (Phase
1's `export {}` placeholders had no edges).

## Skipped / deferred (by design)

- **Real provider adapters** — Phase 3. Loop currently driven by `MockProviderAdapter`.
- **Prompt builder** — Phase 12. `runConversation` accepts pre-built `Message[]`.
- **Context compression** — Phase 12.
- **Tool execution implementations** — Phases 6–7. Loop takes a `ToolExecutor` callback.
- **Honesty enforcement** — Phase 11.
- **Memory / sessions** — Phase 5.
- **Streaming** — Phase 13. `callStream` on `ProviderAdapter` is optional and unused here.
- **Parallel tool execution** — deferred to v4.1 (Hermes `_execute_tool_calls_concurrent`). v4.0 ships sequential, which is correct and simpler.
- **In-band budget warning injection** — Hermes injects pressure warnings into the last tool result's JSON. We fire the callback now and add the in-band injection in Phase 6 when tool results gain real structure.
- **Multi-step fallback chain** — Phase 2 supports one activation per `runConversation`. Hermes's `_fallback_chain` walks a list across turns; that lands when `providers/registry.ts` is populated (Phase 3).

## What Phase 3 needs to know

**Phase 3 mission:** the four real `ProviderAdapter` implementations.

**Build first: `chatCompletionsAdapter.ts`.** Reasons:
1. It's the highest-coverage wire format (Groq, OpenRouter, Together,
   Cerebras, NVIDIA, Gemini-compat — 6 providers in one adapter).
2. It's the simplest of the four — pure JSON, no SSE peculiarities, no
   prompt-injected fake tool calling, no OAuth at request time.
3. It unblocks integration tests that swap in a real provider behind the
   same `ProviderAdapter` interface the mock satisfies. Once it lands, every
   test in `tests/v4/aidenAgent.test.ts` can be re-run as a parity test
   against a live (or VCR-cassette) Groq endpoint.

After it: `anthropicAdapter.ts` (prefix caching is the killer feature, and
needed for the Pro tier OAuth flow), then `ollamaPromptToolsAdapter.ts`
(local fallback), then `codexResponsesAdapter.ts` (ChatGPT subscription
OAuth — most plumbing).

**Surfaces ready to plug into:**
- `providers/v4/types.ts` — frozen contract; do not break compatibility.
- `core/v4/aidenAgent.ts` — accepts any `ProviderAdapter`; tests prove it.

**Token-efficient pattern for Phase 3:** start by graphifying Hermes
`agent/anthropic_adapter.py` (already mapped in Phase 1's File-by-file table)
and the chat-completions branch in `run_agent.py`. Don't re-read this file.

## Acceptance check (Phase 2)

- [x] Hermes pattern summary written (Task 1, 4 bullets above)
- [x] `core/v4/aidenAgent.ts` implements `AidenAgent` class with `runConversation()`
- [x] `core/v4/__mocks__/mockProvider.ts` exists and is used in tests
- [x] All 12 test cases in `tests/v4/aidenAgent.test.ts` pass
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression: 1417 + 12 = **1429 tests passing**
- [x] Two commits on `v4-rewrite` (`c5481bf` + this docs commit)
- [x] Both pushed to `backup` (origin frozen)
- [x] Hook fired; graph rebuilt to **1858 nodes** (>1843 ✓)
- [x] `docs/sprint/phase-2-completed.md` written, under 200 lines
