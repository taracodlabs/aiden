# Phase 16b.3 — completed

Fixed identity drift, slot hammering, and the deferred HonestyEnforcement
smoke. Added a standing rule: UX/identity/onboarding work audits Hermes first.

## Hermes audit (Task 0)

`docs/sprint/hermes-soul-cooldown-audit.md`. Findings: Hermes seeds SOUL.md
idempotently on first run (`hermes_cli/config.py:327`); slot 1 loads it,
falls back to `DEFAULT_AGENT_IDENTITY` when missing (`prompt_builder.py:1028`,
`run_agent.py:4861`); 429 cooldown is **1 hour** at slot-pick time
(`credential_pool.py:73`). Aiden diverges to **60s** — Groq TPM recovers
fast; 1h would freeze a slot interactive-session-long.

## AGENTS.md standing rule

Appended `### Hermes-audit-first`. Future UX/prompt/identity/error-handling/
onboarding work needs a `docs/sprint/` audit doc before code lands.

## SOUL.md identity (Task 1)

- `cli/v4/defaultSoul.ts::DEFAULT_SOUL_MD` — Aiden persona (Taracod, 71
  skills, 39 tools, honesty stance). Same string seeds disk AND fallbacks
  in-memory via `core/v4/promptBuilder.ts`.
- `core/v4/soulSeed.ts::ensureSoulMdSeeded(paths)` — Hermes-style idempotent;
  writes only when missing/whitespace-only. Wired into `buildAgentRuntime`.
- `/identity` slash command dumps the active SOUL.md and tags source as
  `disk` or `bundled-default`. `SlashCommandContext.paths` propagated
  aidenCLI → chatSession.
- User had no local SOUL.md. Seeded 1081 bytes. No preservation conflict.

## Per-slot cooldown (Task 2)

- `providerFallback.ts` `ChainCooldownState`: shared `cooldownUntil` map.
  **60s default** (`DEFAULT_SLOT_COOLDOWN_MS`, env `AIDEN_SLOT_COOLDOWN_MS`).
- Two-pass select: fresh slots first, cooling as last-resort retry. Success
  clears that slot's cooldown.
- `/providers` shows `[cooldown 47s]` per slot + `· cooldown 60s` footer.

## Smoke gate (Task 3)

`scripts/smoke-phase16b3.ts` boots full moat (yolo + honesty=enforce), runs
two real Groq turns. Verbatim:

```
Q1: remember that I prefer concise answers
A1: I'll keep answers brief.
    trace: memory_add(verified=true)

Q2: what do you remember about me?
A2: This conversation has just started. I don't have any information
    about you yet…
    disk: USER.md=24b ("I prefer concise answers")
```

- Turn 1: `memory_add` fired AND verified — moat green.
- Turn 2: agent honestly reported "no info" instead of fabricating. USER.md
  IS on disk; agent's cached system prompt (built pre-save) didn't see it.
  Honesty held; **stale-snapshot bug** in `PromptBuilder` surfaced for a
  future phase.

## Tests

- `providerFallback.test.ts` +10 → 30. `soulSeed.test.ts` (new) +7.
  `cli/commands.test.ts` count assertion 17 → 18 for `/identity`.
- Touched-path run: 23 files / 331 pass. Full v4: 1024/1031 (7 pre-existing
  live-network/timeout failures, none on 16b.3 paths). `tsc --noEmit` clean.

## Shiva manual gate (REPL)

`who are you` → identifies as Aiden + Taracod. `/identity` → dumps SOUL.md.
`/providers` → cooldown countdown when slot 429'd. No log spam.

## Deferred

- **PromptBuilder memory snapshot built once at boot** — mid-session
  USER.md/MEMORY.md updates not seen by `runConversation`. Separate phase.
- 7 pre-existing live-network test failures unchanged.
