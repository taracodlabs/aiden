# Phase 16b.4 — completed

Closed two wiring gaps from 16b.3: SOUL.md now actually reaches the LLM and
`/personality` is live in the chat REPL.

## Hermes audit (Task 0)

`docs/sprint/hermes-prompt-injection-audit.md`. Hermes wires SOUL.md via
`AIAgent._build_system_prompt()` (`run_agent.py:4861`) → `load_soul_md()`
(`prompt_builder.py:1028`) → cached on `_cached_system_prompt`, prepended
as system message every API call. Aiden v4 had `PromptBuilder.build()`
mirroring that pattern already — only the agent constructor in
`buildAgentRuntime` was passing `null` for both prompt-builder fields.
Decision: copy the wire-up, don't refactor.

## Root cause: option (c)

`aidenCLI.ts::buildAgentRuntime` constructed `new AidenAgent({…})` without
`promptBuilder` / `promptBuilderOptions`. `runConversation` short-circuits
when both are absent — slot-1 SOUL.md path literally never ran.
`/identity` worked because it reads `paths.soulMd` off disk directly.

## Fix

`cli/v4/aidenCLI.ts:567-606` — instantiate `PromptBuilder` +
`PersonalityManager`, load `MemorySnapshot` + skills list + active overlay
once at boot, pass `promptBuilder` + `promptBuilderOptions` into the agent.
Same shape as Hermes. Three new agent accessors (no breaking changes to
`AidenAgentOptions`): `invalidateSystemPromptCache()`,
`setPersonalityOverlay(overlay)`, `getSystemPromptForDebug()`.

## /debug-prompt + redaction

`cli/v4/commands/debugPrompt.ts`. Calls `agent.getSystemPromptForDebug()`,
runs through 7 secret regexes (OpenAI / Groq / xAI / Cerebras / Google /
Bearer / JWT), replaces with `[REDACTED]`, prints between `BEGIN/END`
markers. Defense-in-depth — no current slot carries secrets.

## /personality wiring

`AgentRuntime` exposes `personalityManager`; `runInteractiveChat` threads
it into `ChatSession`; `ChatSession.run` forwards it AND the agent into the
slash-command context. `commands/personality.ts` pushes the active overlay
back into the agent via `setPersonalityOverlay` so the next turn rebuilds
slot 2. Slot 1 (SOUL.md) untouched. Added `/personality show` per spec.

## Smoke gate

`scripts/smoke-phase16b4.ts` — full runtime, real Groq. All 9 steps PASS.

```
Q1 (default):  who are you
A1: I am Aiden, a local-first AI agent built by Taracod. I have 71
    bundled skills and access to install more via skills.sh. I can
    remember past sessions via persistent storage and have 39 tools
    spanning files, browser, terminal, web, and memory.

Q2 (concise):  who are you  (personality=concise)
A2: I am Aiden.
```

5076-char system prompt verified via `getSystemPromptForDebug`. Identity
preserved across overlay swap. Concise tone visibly shorter (11 vs 241).

## Tests

New: `promptBuilder.soulInjection.test.ts` +4, `aidenAgent.promptCache.test.ts`
+6, `cli/debugPrompt.test.ts` +10. `cli/commands.test.ts` count 18 → 19.
Touched-path: 84/84. Full v4: 1047 pass / 5 pre-existing live-network fails
unchanged. `tsc --noEmit` clean.

## Manual REPL gate

`/identity` dumps SOUL.md (unchanged). `/debug-prompt` dumps the
SOUL.md-rooted system prompt with `[REDACTED]` for secret-shaped strings.
`/personality` lists 5 bundled, current starred. `/personality concise`
shifts tone, identity preserved. `/personality show` dumps overlay body.

## Deferred

MEMORY.md / USER.md snapshot still built once at boot (carried from 16b.3).
5 pre-existing live-network test failures unchanged.
