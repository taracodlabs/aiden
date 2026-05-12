# AGENTS.md — Aiden agent contract

The contract the Aiden agent honours on every turn, and the public surface
it exposes for callers (CLI, OpenAI-compatible HTTP API, channel adapters).

---

## What the agent is

Aiden is a **single-loop tool-calling agent** with a 90-turn cap. Every
turn:

1. Build / refresh the system prompt (8-slot composition: SOUL → personality
   → memory → user → skills → llama-hint → budget → environment).
2. Send the conversation + tool schemas to the active provider.
3. If the provider returns a tool-use response → dispatch each tool call
   sequentially through the injected `toolExecutor`, append the results
   as `tool` messages, loop.
4. If the provider returns a final assistant message → exit the loop.

There is **no planner / responder split**. There is **no subagent fanout**.
The single-loop architecture prevents fabrication by design: the model
either calls a tool or it ends the turn — there is no third "imagine the
result" path.

Source: `core/v4/aidenAgent.ts`.

---

## Public API

```ts
class AidenAgent {
  constructor(opts: AidenAgentOptions)
  setProvider(adapter: ProviderAdapter): void
  invalidateSystemPromptCache(): void
  setPersonalityOverlay(overlay: string | undefined): boolean
  getSystemPromptForDebug(): Promise<string | null>
  markMemoryDirty(file: 'memory' | 'user'): void
  getMemoryDirtyState(): 'memory' | 'user' | 'both' | null
  runConversation(history: Message[], opts?: RunConversationOptions): Promise<AidenAgentResult>
}
```

`AidenAgentResult` carries `finalContent`, `messages`, `turnCount`,
`toolCallCount`, `fallbackActivated`, `finishReason ∈ {stop, budget_exhausted, error}`,
`totalUsage`, `toolCallTrace`, `honestyFindings?`, `skillCreated?`,
`compressionEvents`, `auxiliaryUsage`, `skillEnforcement`, `urlProvenance`,
`emptyResponse`.

---

## Honesty contract (the moat)

Every turn is gated by a 10-module security and verification layer
(`moat/`):

| Module | Role |
|---|---|
| `approvalEngine.ts` | tier the tool call (`safe` / `caution` / `dangerous`) and consult the user when needed |
| `dangerousPatterns.ts` | classify shell commands; refuse the obviously-bad ones |
| `honestyEnforcement.ts` | post-loop scan: if the assistant claims a tool succeeded but the trace says it failed, rewrite the claim |
| `memoryGuard.ts` | reject `memory_add` when the value isn't backed by tool evidence |
| `plannerGuard.ts` | narrow the offered tools by intent, prevent prompt-bloat |
| `proLicense.ts` | gate Pro features |
| `providerChain.ts` | provider chain glue |
| `skillTeacher.ts` | propose a new skill (tier-3) or auto-create one (tier-4) when a multi-step success qualifies |
| `ssrfProtection.ts` | block private/loopback URLs from web tools |
| `tirithScanner.ts` | secret/PII pre-write scan on `file_write` and `file_patch` |

Together these are the difference between "an LLM with tools" and "an
agent that's safe to leave running".

---

## Provider fallback

`core/v4/providerFallback.ts`. 6-slot self-healing chain
(`together → together-fallback → groq × 4`). On rate-limit (429), the
adapter advances to the next slot in under a second; on success, the
slot's cooldown is cleared and the chain returns to baseline.

The agent never sees provider failures — fallback is transparent. The
result's `fallbackActivated: true` flag tells callers a slot advance
happened on this turn.

---

## Memory

Multi-layer:

- `MEMORY_INDEX.md` — declarative facts the user has confirmed
- `USER.md` — user identity, preferences, projects (re-read every turn)
- `SOUL.md` — Aiden's identity (re-read every turn)
- `LESSONS.md` — failure trace, written by the learning-memory module
- conversation / session / workspace memory — per-context history
- semantic memory — BM25 + embeddings over the recall layers

Dirty-bit invalidation: when a tool writes to `MEMORY_INDEX.md` or `USER.md`,
the agent calls `markMemoryDirty()`. The next turn rebuilds the system
prompt from disk; subsequent turns use the cached prompt until the bit
flips again.

---

## What the agent will not do

- Fabricate a tool result (architecture prevents it: model either calls
  the tool or ends the turn).
- Run a `dangerous`-tier shell command without explicit approval, even in
  `/yolo` mode (yolo lowers the bar, doesn't remove it).
- Send PII or secrets to a provider when `tirithScanner` flags the body
  pre-write.
- Visit private/loopback URLs from a web tool (SSRF guard).
- Claim a tool succeeded when the trace says it didn't (honesty
  enforcement post-loop scan rewrites the claim).

---

## What the agent will do

- Keep going on rate-limits — fallback chain advances slots under a
  second, the user only sees the final answer.
- Surface every failure with the tool, provider, retry count, fallback
  chain, error, and next step. No silent swallowing.
- Refresh `MEMORY_INDEX.md` / `USER.md` / `SOUL.md` mid-session when the user
  edits them — no restart required.
- Write a new skill when a multi-step success qualifies (tier-3 propose
  or tier-4 auto, depending on `skill_teacher_tier` in config).
- Stream tokens to the originating channel (CLI, HTTP, Discord, Slack,
  WhatsApp, Email, Webhook, Twilio, iMessage, Signal).

---

## Adding a new tool

1. Create `tools/v4/<category>/<name>.ts` exporting a `ToolDefinition`.
2. Add the import + `registry.register(myTool)` to `tools/v4/index.ts`.
3. Add a unit test in `tests/v4/tools/`.
4. If the tool mutates state, set `mutates: true` and add the dangerous
   patterns the approval engine should flag.

The tool is automatically advertised to every provider that supports
tool calling.

---

## Adding a new provider

1. Create `providers/v4/<name>Adapter.ts` implementing `ProviderAdapter`
   (`call(req)`, `callStream(req)`, `apiMode`).
2. Add the registry entry in `providers/v4/registry.ts` with `id`,
   `displayName`, `apiMode`, `baseUrl`, `apiKeyEnvVar`, `tier`.
3. Add the model IDs to `providers/v4/modelCatalog.ts`.
4. Add a smoke test in `tests/v4/providers/`.

The runtime resolver picks both up automatically — no other edits needed.

---

## Testing

```bash
npm test           # vitest, ~1,500 unit + integration tests
npm run typecheck  # tsc --noEmit
npm run build      # esbuild bundle
```

Pre-existing baseline failures (~10 documented files: plugins, claude-pro
registration, moatBoot parallel-flake, ollama-real env probe). New tests
must not regress passing files.
