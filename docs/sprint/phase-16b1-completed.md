# Phase 16b.1 — REPL runtime hardening (completed)

**Goal:** Patch the four issues Phase 16b's smoke gate surfaced once the
moat was wired into `runInteractiveChat`. No new features — just make a
real `aiden` invocation boot cleanly and survive a Groq quota hiccup.

## The four issues

| # | Symptom | Root cause | Fix |
|---|---------|------------|-----|
| 1 | `Provider groq rate limited` on first "hi" | `RuntimeResolver` only wires one slot. `testProvider.ts` had a 4-tier fallback; the runtime path didn't. | Extracted the chain into `core/v4/providerFallback.ts`. New `FallbackAdapter` wraps the resolved primary adapter when ≥2 slots are reachable; `aidenAgent.ts` is unchanged (the wrapper implements `ProviderAdapter`). |
| 2 | Error hint suggested `/providers` but no such command existed | Spec misremembered the v3 CLI's slash table; the v4 hint already pointed at `/model`. | Shipped option (a): added a real `/providers` command. Lists each slot, marks the active one, redacts keys (only last 4 chars + `••••` mask). |
| 3 | Banner showed "0 skills" | `BundledManifest.initialize()` existed, but **no code ever copied the bundled `skills/` tree into `paths.skillsDir`**. Phase 10 shipped the manifest; Phase 16b inherited an empty skills dir. | New `core/v4/skillBundledRestore.ts`. Called from `buildAgentRuntime` right after `ensureAidenDirsExist`. Resolves the bundled-skills source via `__dirname` candidates + `process.cwd()` fallback, copies anything not already in the user's dir, then runs `BundledManifest.initialize()`. Idempotent — only the first run actually copies. |
| 4 | `[config] Unknown top-level key 'terminal'` warn on every boot | Phase 10 added the terminal toolset and a `terminal:` config block, but `KNOWN_KEYS` in `core/v4/config.ts` was never updated. | Added `'terminal'` to the set with a Phase 10 comment. |

## Where the new code lives

- `core/v4/providerFallback.ts` — shared chain (`isRateLimitError`, `runFallbackChain`, `buildDefaultSlots`, `FallbackAdapter`, `ChainExhaustedError`, `maskKey`).
- `tests/v4/_helpers/testProvider.ts` — refactored to import from the shared module. Public surface (`getTestProvider`, `withRateLimitFallback`, `isRateLimitError`) unchanged so existing tests stay green.
- `core/v4/skillBundledRestore.ts` — first-run copy + manifest init.
- `cli/v4/commands/providers.ts` — `/providers` slash command.
- `cli/v4/aidenCLI.ts::buildAgentRuntime` — wires `restoreBundledSkillsIfNeeded` and conditionally wraps the adapter in `FallbackAdapter`.

## Test counts
- New: **+22 v4 unit tests** (5 files):
  - `providerFallback.test.ts` — 18 (rate-limit detector, mask, chain runner, default slots, FallbackAdapter)
  - `skillBundledRestore.test.ts` — 3 (first-run copy, preservation, missing source)
  - `aidenAgent.fallback.test.ts` — 1 (integration: 429 on slot 1 → slot 2)
  - `cli/commands.providers.test.ts` — 2 (rendering with mask, no-fallback fallback)
  - `config.test.ts` (+1) — terminal-key smoke
  - `cli/commands.test.ts` (count update) — 17 instead of 16
- v4 unit suite: **987 passed / 3 skipped** (was 941 in 16b).
- Full `npm test`: **2401 passed / 4 failed / 3 skipped / 1 todo**. Same 4 pre-existing real-network failures as 16b (Groq rate-limit, runtimeResolver real, 2× Ollama llama3.2-not-installed). Zero new regressions.
- `npx tsc --noEmit` — clean.

## Smoke gate
`scripts/smoke-phase16b1.ts` runs four asserts against tmp paths:
1. `terminal:` config block produces NO `[config] Unknown top-level key` warn — **PASS**.
2. Bundled-skill restore copies `>70` skills into an empty dir — **PASS** (71 copied, 67 valid; 4 malformed v3 single-file skills lack frontmatter and are skipped — pre-existing condition).
3. Banner skill count > 0 — **PASS** (67 vs. the previous 0).
4. `AidenAgent` driven through a `FallbackAdapter` whose slot 1 throws `Provider groq rate limited` returns slot 2's content — **PASS**.

`SMOKE PASS — Phase 16b.1 hardening verified.`

## Anything deferred

- **Live REPL `hi` round-trip with HonestyEnforcement notice** — still needs a manual Shiva run with real keys; the smoke harness exercises the boot path + agent loop but not an actual provider call to Groq. The moat wiring is unchanged from 16b.
- **Per-slot cooldown timer** — the FallbackAdapter records `lastRateLimitAt` but doesn't gate retries by it. The chain re-tries every slot on every call so recovery is fast. Adding a cooldown is a v4.1 polish.
- **Streaming fallback** — `callStream` is not implemented on `FallbackAdapter`; streaming routes around the wrapper. Phase 16c (streaming) will revisit.
