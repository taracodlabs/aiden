# Phase 1 — Completed

**Date:** 2026-05-03
**Branch:** `v4-rewrite`
**Commits:**
- `10370b6` — feat(v4): phase 1 scaffolding — directory structure + provider abstraction
- (this file) — docs(v4): phase 1 summary

## Goal

Lay down the empty bones of v4.0.0 — directory structure, TypeScript wiring,
and provider abstraction interfaces. No business logic. The skeleton that
Phases 2–9 plug into.

## Directory structure created

| Tree | Files | Purpose |
|---|---:|---|
| `core/v4/` | 22 | The single-loop agent, prompt builder, compressor, session/memory/config, skills, MCP, processes |
| `providers/v4/` | 10 | Provider abstraction (`types.ts` is real; 9 others are placeholders for Phase 2–3) |
| `cli/v4/` | 10 | CLI / TUI / setup wizard / doctor / display / theming / commands |
| `moat/` | 9 | Aiden-only: PlannerGuard, MemoryGuard, HonestyEnforcement, SkillTeacher, ProLicense, Approval, Tirith, SSRF, ProviderChain |
| `platform/` | 6 | Cross-platform: shell, windows, linux, macos, paths, encoding |
| `tools/v4/` | 4 | `executeCode.ts`, terminal backends (`local`, `docker`), utils dir |
| `tests/v4/` | 1 | `scaffolding.test.ts` — passes 2 type-level + smoke tests |
| **Total new files** | **62** | (60 placeholders + types.ts + 1 test) |

`tsconfig.json` extended with an `include` block covering `core/v4`,
`providers/v4`, `cli/v4`, `moat`, `platform`, `tools/v4`. The existing v3
`files` array is **untouched** — v3 build is unaffected.

## Provider abstraction interfaces ([providers/v4/types.ts](../../providers/v4/types.ts))

189 lines. Defines the contract every adapter implements in Phase 3:

| Export | Kind | Purpose |
|---|---|---|
| `ApiMode` | union | The four wire formats: `chat_completions`, `anthropic_messages`, `codex_responses`, `ollama_prompt_tools` |
| `RuntimeResolution` | interface | `(provider, model)` → concrete dispatch info |
| `ToolSchema` | interface | JSON-Schema subset compatible with Anthropic + OpenAI specs |
| `ToolCallRequest` | interface | A tool call requested by the model |
| `ToolCallResult` | interface | Result fed back into the next turn |
| `Message` | union | Discriminated on `role` (system / user / assistant / tool) |
| `ProviderCallInput` | interface | One-turn inputs (messages, tools, sampling, `extraBody`) |
| `ProviderCallOutput` | interface | One-turn outputs (content, toolCalls, finishReason, usage) |
| `ProviderAdapter` | interface | The contract; required `call`, optional `callStream` |
| `CredentialSource` | interface | `apiKey` xor `oauthToken`, with refreshability + expiry |

JSDoc on each type cross-references the Hermes file it descends from
(`run_agent.py`, `agent/anthropic_adapter.py`, `hermes_cli/runtime_provider.py`,
`hermes_cli/auth.py`).

## Test results

| Step | Result |
|---|---|
| Task 1 — v3 baseline `npm run build` | ✅ pass (cli 17.0 MB, api 45.4 MB) |
| Task 1 — v3 baseline `npm test` | 16 file failures (pre-existing) / 137 file pass / 1415 tests pass / 0 actual test regressions |
| Task 4 — `npx tsc --noEmit` | ✅ exit 0, zero errors |
| Task 5 — `npx vitest run tests/v4/scaffolding.test.ts` | ✅ 2/2 pass |
| Task 6 — full `npm test` | 16 file failures (same set) / **138** file pass / **1417** tests pass — ✅ **zero v3 regressions**, +1 file +2 tests are mine |

The 16 file-level failures are pre-existing and unrelated to v4 work:
- 14 in `native-modules/` (vendored puppeteer/zod test files missing peer
  deps like `recheck`, `@web-std/file`).
- 2 empty regression stubs in `scripts/test-suite/regression/`
  (`c22-skill-bundle-path.test.ts`, `c23-cli-noise.test.ts` — no `describe`).

These existed at Phase 0 baseline and stayed unchanged through Phase 1.

## Graphify

| Metric | Pre-Phase 1 | Post-Phase 1 | Δ |
|---|---:|---:|---:|
| Nodes | 1782 | **1843** | +61 |
| Files indexed | 277 | 338 | +61 |
| Edges | 3353 | 3353 | 0 |
| Communities | 48 | 48 | 0 |

Edges/communities unchanged because placeholder files contain no
`import`/`export` linkages yet (just `export {}`). They will populate as
real implementations land in Phase 2+.

Hook fired on commit `10370b6` and rebuild ran. Confirmed via `head
graphify-out/GRAPH_REPORT.md`.

## Skipped / deferred

None of Phase 1's acceptance criteria were skipped. Items deferred to later phases (by design, not by oversight):

- All 60 placeholder files have `export {};` and a JSDoc header. Real
  implementations are gated behind their phase numbers in the JSDoc
  `Status:` line.
- `tools/v4/utils/` was given an `index.ts` placeholder (rather than a
  `.gitkeep`) so the directory is a proper TS module. Same for
  `cli/v4/commands/` and `core/v4/builtinHooks/`.

## What Phase 2 needs to know

**Phase 2 mission:** port the actual single-loop agent — `core/aidenAgent.ts`
plus `runtimeResolver.ts` + `credentialResolver.ts` + the four real adapters.

**Reference reading order for Phase 2:**
1. Read this file.
2. Read `docs/v4.0.0-architecture.md` sections "v4.0.0 system architecture"
   and "OAuth subscription login — flow detail".
3. `cd C:\Users\shiva\references\hermes-agent && graphify query "main agent loop"`
   to navigate `run_agent.py` (community 2) before touching `aidenAgent.ts`.

**Surfaces ready to plug into:**
- `providers/v4/types.ts` — frozen contract, do not break compatibility
  without explicit Phase-2 ADR.
- `core/v4/aidenAgent.ts` — empty stub waiting for `import { ProviderAdapter }
  from '../../providers/v4/types'`.

**Surfaces still on v3 and needing care:**
- `providers/router.ts`, `providers/{groq,gemini,openrouter,...}.ts` — v3
  active code, do **not** delete. Phase 2 will introduce `providers/v4/registry.ts`
  alongside, then phase-3 migration cuts over consumers.
- `core/agentLoop.ts` — v3 planner+responder split; lives until Phase 2
  finishes the v4 loop with passing parity tests.

**Token-efficient pattern for Phase 2:** start every turn by re-reading this
file, then graphify-querying for the specific surface. The architecture doc
itself does not need re-reading unless the question is about a locked
decision.

## Acceptance check (Phase 1)

- [x] All v4 directories and placeholder files exist (60 placeholders + types.ts + test)
- [x] `providers/v4/types.ts` exports all 10 contract types
- [x] `npx tsc --noEmit` passes with zero errors
- [x] `npx vitest run tests/v4/scaffolding.test.ts` passes 2/2
- [x] Full `npm test` shows zero v3 regressions
- [x] Two commits on `v4-rewrite` (`10370b6` + this docs commit)
- [x] Hook fired; graph node count rose from 1782 → 1843 (>1782 ✓)
- [x] `docs/sprint/phase-1-completed.md` written, under 200 lines
- [x] No commits on `main`; no pushes to remote
