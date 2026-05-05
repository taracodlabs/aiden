# Hermes audit — credential pool cooldown + selection strategy (Phase 16e)

**Question:** All 4 Aiden Groq slots 429 simultaneously on multi-tool turns
(browser flow = 4-5 LLM calls in seconds). Per-slot 60s cooldown alone
isn't preventing the burst-hammer pattern. What does Hermes do?

## Sources
- `agent/credential_pool.py:59,64` — `STRATEGY_FILL_FIRST = "fill_first"` is the registered default
- `agent/credential_pool.py:73-74` — `EXHAUSTED_TTL_429_SECONDS = 60 * 60` (1 hour); `EXHAUSTED_TTL_DEFAULT_SECONDS = 60 * 60`
- `agent/credential_pool.py:191-195` — `_exhausted_ttl(error_code)` returns 1hr for both 429 and other errors
- `agent/credential_pool.py:824-892` — `_available_entries(clear_expired, refresh)` builds the candidate list, syncing token-refresh side-channels
- `agent/credential_pool.py:894-925` — `_select_unlocked()` is the picker. Branches on strategy:
  - `RANDOM` → `random.choice(available)`
  - `LEAST_USED` (when `len(available)>1`) → `min(available, key=request_count)`, increments counter
  - `ROUND_ROBIN` → picks `available[0]`, then rotates priorities so next call lands on next slot
  - `FILL_FIRST` (default) → `available[0]`
- `agent/credential_pool.py:934-950` — `mark_exhausted_and_rotate(status_code, error_context)` is the post-429 hook

## Findings
1. **Cooldown is 1 hour for both 429 and "other" exhaustion.** Hermes assumes provider quota windows are long (Anthropic weekly, OpenAI hourly).
2. **Default strategy is FILL_FIRST.** Same as Aiden today — first-non-cooled slot wins.
3. **`LEAST_USED` and `ROUND_ROBIN` are first-class alternatives.** Both spread load across slots intentionally; both are gated on `len(available) > 1` (so single-slot pools degrade to fill-first cleanly).
4. **`mark_exhausted_and_rotate` is the post-error hook.** Hermes immediately rotates after a 429 — the *next* slot becomes current, not the same one that just failed.
5. **Token-refresh sync** during pick (anthropic/nous/openai-codex) recovers slots whose external auth was refreshed by a sibling process. Not relevant to Aiden Groq slots (static API keys).

## Decision: **diverge** (least-used + keep 60s cooldown)

Two divergences, each with a reason:

**1. Keep Aiden's 60s cooldown (vs Hermes 1hr).**
Phase 16b.3 already audited this and chose 60s because Groq's free-tier TPM
cap is a rolling-window cap that recovers in <60s. Hermes's 1hr matches
Anthropic/OpenAI weekly/hourly quota windows — a different reset semantic.
60s is correct for our provider mix.

**2. Switch default strategy from fill-first to LEAST_USED for the runtime chain.**
The bug is bursts: a single user turn fires 4-5 LLM calls in <5s. Fill-first
sends all 5 calls to slot 1 → slot 1 hits its TPM cap on call 2 → cooldown.
Calls 3-5 advance through slots 2,3,4 each hitting their own TPM caps →
all 4 in cooldown within 5s.

`LEAST_USED` distributes by request count: call 1 → slot 1 (count=1),
call 2 → slot 2 (count=0 → 1), call 3 → slot 3, call 4 → slot 4. After 4
calls each slot has count=1 instead of slot 1 having count=4. The TPM cap
sits at the *account* level on each slot, so this is real load-spreading,
not just bookkeeping.

Implementation: per-call request_count on each slot in the FallbackAdapter,
incremented on successful pick (not just on success — picking burns the
TPM whether the call succeeds or 429s). `_available_entries` already exists
implicitly in the cooldown filter (`runFallbackChain` two-pass split).
Picker becomes `min(fresh, key=count)` when len(fresh) > 1.

## What we're NOT copying
- 1hr cooldown — wrong for Groq's TPM model.
- Token-refresh sync side-channel — Aiden Groq slots are static keys, no
  external refresh path. Anthropic ACP / OAuth flows in v4.1 may need
  this hook back.
- Persistent pool state across processes (`write_credential_pool`) — Aiden
  REPL is single-process; the in-memory `Map<slotId, count>` is sufficient.
