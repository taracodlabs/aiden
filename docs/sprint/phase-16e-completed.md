# Phase 16e — Cooldown + tool-call parser + memory framing

Three bounded fixes from polish surfaced across 16b–16d smoke runs.

## 1. Cooldown / least-used selection
[`hermes-cooldown-audit.md`](hermes-cooldown-audit.md) — Hermes uses 1hr
TTL with `fill_first/least_used/round_robin/random` strategies
(`agent/credential_pool.py:894-925`). Decision: keep Aiden's 60s TTL
(Groq TPM is rolling-window, 1hr is wrong) but **switch default from
fill-first to least-used.**

`ChainCooldownState.requestCount` (optional Map) lets `runFallbackChain`
sort fresh slots ascending by call count before picking. Burst pattern
(4-5 LLM calls in <5s on a tool turn) used to send all calls to slot 0
until TPM cap → 60s cooldown → chain through others until all 4 cold.
Now distributes 1/1/1/1 from the start. Counter increments on every
committed pick (success OR 429 — TPM burns either way).
[`providerFallback.ts`](../../core/v4/providerFallback.ts) wires it through both `.call()` and `.callStream()`.

+5 unit tests (tie-on-count, increment-on-429, 4-call burst spreads
1/1/1/1, configured-order tiebreaker, FallbackAdapter integration).

## 2. Array-variant legacy tool call parser
No separate audit — Hermes's `qwen3_coder_parser.py` handles a different
format (`<tool_call><parameter>` nested tags), not applicable.
Phase 16c.1 already handled `<function=NAME(JSON)>` and
`<function=NAME JSON</function>`. New variant from 16d run 2:
`<function=session_search [{...}]</function>` — single-element JSON array
wrapping the args. `parseLegacyFunctionSyntax` in
[`chatCompletionsAdapter.ts`](../../providers/v4/chatCompletionsAdapter.ts)
now accepts `(`, `{`, or `[` as opener; on parse, single-element array of
object is unwrapped. Multi-element arrays fall through to `{}`.

+3 unit tests. `legacyToolCall.test` 13 → 16.

## 3. Memory section framing
[`hermes-memory-framing-audit.md`](hermes-memory-framing-audit.md) —
Hermes (`tools/memory_tool.py:393-409`) frames USER.md as
`USER PROFILE (who the user is)` and MEMORY.md as
`MEMORY (your personal notes)`, with `═══` visual separators. The
parenthetical is load-bearing: it tells the model the section is
current identity, not transcript snippets.

Aiden was using plain `## User profile` markdown — the model interpreted
it as "previous conversation history" and refused to surface (16d run 1).
Decision: copy Hermes's headers verbatim and add the
`[System note: …]` line Hermes uses on external-provider blocks
(`memory_manager.py:184-188`) — because the built-in case is exactly
where the bug lived.

+2 unit tests locking the new phrasing.

## Tests + tsc
v4 unit suite **1082 / 1 skip / 0 fail** (was 1070 in 16d). +12 unit
tests across the three fixes. `tsc --noEmit` clean.

## Smoke gates flagged for manual run
1. **Cooldown smoke:** Boot REPL → tool-heavy task → `/providers` should
   show different slots active; no 4-slot simultaneous 429.
2. **Memory smoke:** Boot REPL → "remember X" → "what do you remember?"
   → response surfaces X. Was failing in 16d run 1.
3. **Parser smoke:** Tool-heavy task with session_search etc. → no
   `<function=name [{...}]</function>` 400.

## Commits
- `6a2eb62 docs(v4): hermes cooldown + memory framing audits`
- `b0f2528 fix(providers): least-used slot selection`
- `e22ffe4 fix(providers): array-variant legacy tool call parser`
- `d1a89f5 fix(prompt): memory section framing`
- `<this commit> docs(v4): phase 16e summary`

All on `backup/v4-rewrite`. Origin untouched.

## Phase 16 series closed
Phase 16e closes Phase 16. Move to Phase 17.
