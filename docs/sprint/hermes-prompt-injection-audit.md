# Hermes audit — system prompt injection (Phase 16b.4)

Pre-code audit per the standing AGENTS.md rule. Inspects how Hermes wires
SOUL.md and personality overlays into the actual LLM call.

## Scope

Why Aiden v3.20-rewrite Phase 16b.3 left two bugs:
1. SOUL.md seeded to disk + `/identity` reads it, but the LLM still says it's
   Llama-3.3 → SOUL.md never reaches the model.
2. `/personality` returns "Personality manager not wired in this context."

## Hermes — how it builds the system prompt

`agent/prompt_builder.py:1028` `load_soul_md()` reads `~/.hermes/SOUL.md` and
returns the trimmed string (or `None`).

`run_agent.py:4861` `AIAgent._build_system_prompt(system_message=None)` is the
**single integration point**. It:
- Calls `load_soul_md()` (line 4883) and uses its return value as
  `prompt_parts[0]` — the agent identity slot.
- Falls back to `DEFAULT_AGENT_IDENTITY` (line 4890) when SOUL.md is missing
  or empty.
- Appends tool guidance, memory blocks, USER.md, skills, environment etc.
- Joins everything with `\n\n` and returns.

`run_agent.py:10573` caches the result on `self._cached_system_prompt`.
`run_agent.py:9102` rebuilds it after compression. The agent prepends
`{"role": "system", "content": <cached>}` to every API call — that's the
single place SOUL.md becomes visible to the LLM.

Hermes has no dedicated personality module; users edit SOUL.md to change
voice. Aiden is keeping the explicit `/personality` overlay as a v4 UX
feature (slot 2 in `core/v4/promptBuilder.ts:122`).

## Aiden v4 — what's wired vs missing

`core/v4/promptBuilder.ts:111` already loads SOUL.md from
`opts.paths.soulMd` and falls back to `DEFAULT_SOUL_MD` if missing. Slot 2
already accepts a `personalityOverlay` string.

`core/v4/aidenAgent.ts:223` `runConversation()` already builds + caches the
system prompt **but only when `promptBuilder` AND `promptBuilderOptions`
are passed in via the constructor**.

`cli/v4/aidenCLI.ts:568` `buildAgentRuntime()` constructs `new AidenAgent({…})`
**without `promptBuilder` or `promptBuilderOptions`** → the cached prompt is
`null` forever, no system message is prepended, the LLM gets a bare user
message and replies as base Llama-3.3.

That's the integration gap. Both halves exist, just disconnected.

`/personality` lives at `cli/v4/commands/personality.ts:16` and reads
`ctx.personalityManager`. Nothing in `aidenCLI.runInteractiveChat` →
`ChatSession` → `commandRegistry.execute()` constructs a `PersonalityManager`
or passes it down. That's the second integration gap.

## Decision: copy the Hermes pattern, don't refactor

Aiden's slot architecture (`promptBuilder.build()` returning a single string,
cached once per session) already mirrors Hermes's
`_cached_system_prompt`. **Wire the existing pieces, don't rebuild.**

Concretely:
- **Copy** Hermes pattern: build `PromptBuilder` + `PromptBuilderOptions` at
  runtime construction time (`buildAgentRuntime`), pass them into the
  `AidenAgent` constructor. SOUL.md content lands in slot #1 the first time
  `runConversation()` runs.
- **Copy** Hermes idea of recomputing on overlay change: when
  `/personality` switches the active overlay, invalidate
  `aidenAgent.cachedSystemPrompt` so the next turn rebuilds with the new
  slot-2 body. Hermes does this implicitly via compression; Aiden adds an
  explicit `invalidateSystemPromptCache()` accessor.
- **Diverge** — Hermes has no personality module. Aiden keeps `/personality`
  as a separate manager because the v4 UX spec calls for switchable
  overlays without editing SOUL.md.
- **Diverge** — Hermes has no `/debug-prompt`. Add one: dump the cached (or
  freshly-built) system prompt with API-key-shaped strings redacted. Useful
  for verifying SOUL/overlay changes without booting a provider.

## Files to touch

- `core/v4/aidenAgent.ts` — expose `invalidateSystemPromptCache()` so
  `/personality` switching forces a rebuild on the next turn.
- `cli/v4/aidenCLI.ts::buildAgentRuntime` — instantiate `PromptBuilder`,
  `MemorySnapshot`, `PersonalityManager`; pass `promptBuilder` +
  `promptBuilderOptions` into `new AidenAgent({…})`; thread the personality
  manager into `ChatSession`.
- `cli/v4/chatSession.ts` — accept `personalityManager` and forward it into
  the slash-command context; on personality switch, invalidate the agent's
  cached prompt and rebuild with the new overlay body.
- `cli/v4/commandRegistry.ts` — already has `personalityManager` on the
  context type; only the wiring above is missing.
- New `cli/v4/commands/debugPrompt.ts` — `/debug-prompt` command.

No `AidenAgent` surface change beyond adding one cache-invalidation method
+ propagating personality overlay for rebuilds. No `AidenAgentOptions`
field changes — keeps the Phase 12/13 contract.

## Redaction approach (debug-prompt)

Aiden never injects API keys into the system prompt today (verified by
reading every slot in `promptBuilder.ts`). But to stay safe under future
edits, `/debug-prompt` runs the assembled string through a regex sweep:

- `/sk-[A-Za-z0-9_-]{16,}/g`           — OpenAI-style
- `/gsk_[A-Za-z0-9]{20,}/g`            — Groq
- `/xai-[A-Za-z0-9-]{20,}/g`           — xAI
- `/csk-[A-Za-z0-9-]{20,}/g`           — Cerebras
- `/AIza[A-Za-z0-9_-]{30,}/g`          — Google
- `/(?:Bearer\s+)[A-Za-z0-9._-]{20,}/g` — generic Authorization
- `/[A-Za-z0-9-_]{32,}\.[A-Za-z0-9-_]{32,}\.[A-Za-z0-9-_]{32,}/g` — JWTs
- Replace each match with `[REDACTED]`. Final output goes through
  `display.write` so the skin formatter sees it; no logging to disk.
