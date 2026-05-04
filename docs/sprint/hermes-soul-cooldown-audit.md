# Hermes audit — SOUL.md, identity, credential cooldown

Phase 16b.3 prep audit. Reference repo: `C:\Users\shiva\references\hermes-agent`.

## A. SOUL.md / identity

### A.1 First-run seed
- `hermes_cli/default_soul.py:3` — `DEFAULT_SOUL_MD` constant (one paragraph, "You are Hermes Agent, an intelligent AI assistant created by Nous Research…").
- `hermes_cli/config.py:327` — `_ensure_default_soul_md(home)` writes the constant to `<HERMES_HOME>/SOUL.md` only if the file does not exist (`if soul_path.exists(): return`).
- `hermes_cli/config.py:357,379` — both code paths of `ensure_hermes_home()` (managed + standalone) call the seeder during home-dir setup. So the seed runs on first launch + on every subsequent boot but is a no-op once the file exists.
- Profile creation (`hermes_cli/profiles.py:494`) seeds the same template for new profiles.
- File chmod 0600 / 0660 depending on managed mode.

### A.2 Slot #1 injection
- `agent/prompt_builder.py:1028 load_soul_md()` reads `HERMES_HOME/SOUL.md`, returns content stripped (or `None` if missing/empty), with content scan + 20k-char truncation.
- `run_agent.py:4861 _build_system_prompt()` — slot order is comment-documented:
  1. SOUL.md (or `DEFAULT_AGENT_IDENTITY` fallback)
  2. user/gateway system prompt
  3. memory
  4. skills guidance
  5. context files (AGENTS.md / .cursorrules — `skip_soul=True` so SOUL isn't double-injected)
  6. timestamp
  7. platform hint
- `agent/prompt_builder.py:134 DEFAULT_AGENT_IDENTITY` — same string as `DEFAULT_SOUL_MD`. The seeded file IS the fallback, written to disk so it can be edited.
- `agent/codex_responses_adapter.py:627` — uses `DEFAULT_AGENT_IDENTITY` as the OpenAI Responses API `instructions` field when no system msg.

### A.3 "Who are you" handling
- No `agent/identity.py` exists. There is no special routing for the "who are you" question — Hermes relies entirely on the SOUL/identity slot being slot #1 of the system prompt. The model answers from the persona text it sees there.
- `HERMES_AGENT_HELP_GUIDANCE` (prompt_builder.py:144) is appended right after identity and tells the model to load the `hermes-agent` skill when the user asks setup/usage questions about the product itself. Identity vs. self-help are split deliberately.

### A.4 Decision for Aiden
- **Copy** the seed-on-first-run pattern: idempotent write, `if exists return`, called from the same path that creates user-data dirs (`ensureAidenDirsExist`).
- **Copy** the slot-1 + fallback pattern: SOUL.md content first if present, hard-coded `DEFAULT_IDENTITY` only when the file is missing/empty (already wired in `core/v4/promptBuilder.ts:117`).
- **Diverge** on content: Aiden identity must mention skills/tools/local-first/Aiden-by-Taracod (per spec). Hermes' template is too generic for our smoke test.
- **Adapt** seed-mismatch detection: track the bundled-default hash (or version tag) so a future template bump can re-seed without overwriting user edits — Hermes does NOT do this; it just bails if the file exists. We use the same conservative rule for 16b.3 (only seed on missing) and revisit if v4.1 needs a content bump.

## B. Per-slot cooldown

### B.1 Cooldown constants + classifier
- `agent/credential_pool.py:73` — `EXHAUSTED_TTL_429_SECONDS = 60 * 60` (one hour).
- Same value for 402 (billing/quota): `EXHAUSTED_TTL_DEFAULT_SECONDS`.
- `agent/credential_pool.py:191 _exhausted_ttl(error_code)` — picks 1h for 429, 1h default otherwise.
- Provider-supplied `reset_at` timestamps override the default — `_parse_absolute_timestamp` (line 198) accepts epoch seconds, ms, or ISO-8601.

### B.2 Skip-on-pick logic
- `agent/credential_pool.py:824 _available_entries(clear_expired, refresh)` — iterates entries; skips any with `last_status == STATUS_EXHAUSTED` whose `_exhausted_until(entry)` is still in the future. Expired cooldowns are reset to OK + persisted.
- `_select_unlocked()` (line 894) calls `_available_entries(clear_expired=True, refresh=True)` first. So the picker NEVER returns a slot still in cooldown.
- Pool strategies (line 59-67): `fill_first` / `round_robin` / `random` / `least_used`. Selection runs over the already-filtered "available" list.

### B.3 Detection of 429 vs other errors
- The cooldown is set when a request returns an error and the caller invokes a "mark exhausted" routine that records `last_error_code` (the HTTP status). `_exhausted_ttl` keys off that code.
- 429 and 402 → 1h cooldown. Other errors (network, 5xx) follow the same default 1h. There is no separate "transient" bucket.

### B.4 Decision for Aiden
- **Diverge on duration**: Hermes uses 1h because it serves multi-day/cron workloads on free quotas with proper reset windows. Aiden's smoke shows Groq's TPM cap recovers in <60s during interactive use; a 1h cooldown would freeze a slot for an entire interactive session needlessly. **Choose 60s default** per the spec — matches Groq's TPM rolling window, leaves room for the manual user retry pattern.
- **Copy** the skip-on-pick pattern: cooldown is checked at slot-pick time, expired cooldowns auto-clear, no separate timer thread.
- **Diverge** on persistence: Hermes persists the pool to disk (`write_credential_pool`). Aiden's slot state is in-memory in `FallbackAdapter.state` — fine for a per-process REPL where session lifetime is short. Don't add disk persistence for 16b.3.
- **Adapt** the error classifier: `core/v4/providerFallback.ts:60 isRateLimitError` already exists and matches statusCode 429 + name + message patterns. Reuse it; the cooldown is set on the path that already detects 429.

## C. Identity probe behavior

- Hermes does nothing special. The persona in slot #1 is load-bearing — when a user asks "who are you", the model answers from that text.
- This implies: if Aiden answers as "Llama-3.3" today, the bundled default identity is too generic OR the slot isn't actually being injected. Live-check both before assuming a promptBuilder bug. Local SOUL.md was confirmed missing on this machine, so `DEFAULT_IDENTITY` (the generic "You are Aiden, a careful, honest AI assistant…") is what the model sees today — that explains the drift completely.
- Decision: the fix is content, not wiring. Replace `DEFAULT_IDENTITY` AND seed a richer SOUL.md identical to it on first run.

## Summary

| Topic | Hermes file | Aiden decision |
|-------|-------------|----------------|
| SOUL.md template | hermes_cli/default_soul.py | Replace with Aiden-specific content, mirror constant location: `cli/v4/defaultSoul.ts` (new). |
| First-run seed | hermes_cli/config.py:327 (idempotent, `if exists return`) | Copy. Add `ensureSoulMdSeeded(paths)` called from `ensureAidenDirsExist` or `buildAgentRuntime` boot. |
| Slot 1 injection | run_agent.py:4861 + prompt_builder.py:1028 | Already wired. Use new template as `DEFAULT_IDENTITY` fallback. |
| Identity probe | (no special handling) | Copy — content carries the load. |
| Cooldown duration | 1 hour (credential_pool.py:73) | **Diverge**: 60s for interactive REPL. |
| Cooldown skip | _available_entries + _select_unlocked | Copy: filter slots whose `cooldownUntil > now` at pick time. |
| Cooldown persistence | disk-backed pool | **Diverge**: in-memory `SlotState` only. |
| 429 classifier | error_code field | Reuse existing `isRateLimitError`. |
