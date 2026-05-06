# Phase 21 — Manual QA matrix (completed)

**Branch:** `v4-rewrite` · **Range:** `d976318..2d9f249` (10 bug fixes + audits + 5 Hermes primary-source docs)
**Status:** closed. Aiden v4.0-beta is QA-passing on Windows, ChatGPT Plus working end-to-end via the Codex backend, all blocking bugs fixed.

## Discipline observed
- One bug = one commit. No batching.
- Hermes-first audit on every bug where Hermes had a relevant pattern (8 of 10).
- Hermes-pattern ported, never patched. When Aiden DIVERGES, the divergence is documented (e.g. memory invalidate-on-write — `hermes-architecture-wisdom.md` row 3).

## Bugs caught + fixed

| # | Commit | Surface |
|---|---|---|
| 1 | `d976318` | CDP plugin auto-launched Chrome at REPL boot — moved to lazy on first `browser_real_*` call. |
| 2 | `6e4897e` | `memory_add` warned "attempted but not verified" on substring duplicates — now `ok: true, deduped: true`. |
| 3 | `7ea8971` | `media-search` skill stopped after `web_search`, never called `open_url` — REQUIRED-tool-sequence callout + anti-patterns. |
| 4 | `639ced6` | Bare `<tool_call>` JSON leaked into assistant content (Qwen3 via Together) — Hermes parser ported (`extractHermesToolCalls`). |
| 5 | `9b3ecab` + `5a9b585` | `/model` switch to chatgpt-plus errored on legacy `auth.json` path — registry deduplicated (one canonical name per service); `chatSession.setProvider` forwards `paths` to resolver. |
| 6a | `2457a19` | Codex model slugs invalid (`gpt-5-mini`, `gpt-5-codex`) — Hermes-verified list ported (`gpt-5.x-codex` family). |
| 6b | `3756cc9` | Codex 400 even with valid slug — added Cloudflare-bypass headers (`User-Agent: codex_cli_rs/...`, `originator`, `ChatGPT-Account-ID` from JWT); omit `max_output_tokens` for Codex backend. |
| 6c | `73233a0` | Codex 400 "Stream must be set to true" — adapter always streams on Codex backend, aggregates SSE internally for non-streaming callers. |
| 6d | `2d9f249` | Codex SSE returned 0 output items despite content streamed — three-stage recovery (trust completed → backfill from `output_item.done` → synthesize from `output_text.delta`). |

## Platforms

| Platform | Status |
|---|---|
| Windows 11 (native) | ✅ Full QA pass. Primary daily driver. |
| Linux WSL2 Ubuntu | ⚠ Deferred to Phase 22 cross-platform smoke. CI matrix already covers Linux containers. |
| macOS | ❌ Untested. **Launch-time risk acceptance** — no Mac available; CI-Matrix Phase 19 covers macOS-darwin path resolution + `open_url`, but no human-eyes pass. Document in known-issues at launch. |

## OAuth status

| Provider | Status |
|---|---|
| ChatGPT Plus (Codex backend) | ✅ Working end-to-end. `gpt-5.3-codex`, `gpt-5.1-codex-max` confirmed responding via `/responses` SSE. |
| Claude Pro/Max | ⚠ Untested upstream. Routing layer fixed (Phase 21 #5 unification covers it identically). Will work if Anthropic upstream is available; documented as beta in setup wizard. |

## Tests
- 1338+ v4 unit tests, all green at HEAD.
- 0 live-API tests run during Phase 21 (per cost discipline). Live smoke is the manual user retest gate.
- $0 spend.

## Banked for v4.1 (per Hermes wire-diff + retrospective)

1. **Live `/codex/models` probe** — replace hardcoded slug list with cached runtime probe (Hermes `model_metadata.py:_fetch_codex_oauth_context_lengths`).
2. **Codex reasoning config** — `reasoning: {effort, summary}` and `include: ['reasoning.encrypted_content']` per Hermes transports/codex.py.
3. **Codex `session_id` + `prompt_cache_key` wiring** — cross-turn cache benefits on the Codex backend.
4. **OS keychain for tokens** — Windows DPAPI / macOS Keychain / Linux libsecret (today's `tokenStore` is machine-bound AES = obfuscation, not protection).

Plus the Hermes retrospective items already in `v4.1-roadmap.md`: trace-schema standardization · OS plugin sandbox · unified policy engine · skill telemetry · per-provider streaming strategy · Phase 16d memory-snapshot revisit.

## Honest framing

Every bug audited Hermes-first when Hermes had a relevant pattern. Every fix ported the Hermes shape verbatim, never invented or patched around the symptom. Where Aiden DIVERGES (memory snapshot lifecycle, streaming uniformity, free-tier rules-only approval), the divergence is captured in `hermes-architecture-wisdom.md` with the v4.0 acceptance rationale and v4.1 review trigger.

## Next

Phase 22 — UX polish (per the original sprint plan) or cross-platform smoke (per the deferred Linux/macOS items above), whichever the user dispatches.
