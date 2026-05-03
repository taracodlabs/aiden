# Aiden v4.0.0 — AGENTS.md

## Sprint context
- Branch: `v4-rewrite` (NEVER push to main during this sprint)
- v3.19.9 stays live on npm/GitHub. `main` branch frozen.
- Reference architecture: `docs/v4.0.0-architecture.md` (READ FIRST)
- Sprint progress: `docs/sprint/phase-N-completed.md` (read previous phase before starting next)

## Mission
Aiden v4.0.0 = Hermes-grade everything (architecture, tooling, skills, memory, security, UX) + Aiden's unique layer (honesty enforcement, Pro tier, OAuth subscriptions, native Windows, npm distribution).

Single-loop agent replaces planner+responder split. ONE LLM. Tools called inside loop. Architecture prevents fabrication by design.

## Key paths
- Aiden repo: `C:\Users\shiva\DevOS`
- Aiden user data (runtime): `%LOCALAPPDATA%\aiden\`
- Hermes reference (read-only): `C:\Users\shiva\references\hermes-agent` (branch `aiden-v4-reference`)
- Architecture doc: `docs/v4.0.0-architecture.md`
- Sprint progress: `docs/sprint/`

## Working style
- Author all commits as Shiva Deore. NO Co-Authored-By Claude. NO "Generated with Claude Code" trailers.
- Conventional commit format: `type(scope): description`
- Phased delivery. Each phase leaves runnable build. Stop and ask if uncertain.
- No fabrication. No silent workarounds. Stop and report.

## Token-efficient working pattern (every phase)
1. Read previous phase summary: `docs/sprint/phase-N-1-completed.md`
2. Use `graphify query "..."` BEFORE reading files (200 tokens vs 5000+ for file reads)
3. Read only files explicitly listed as needed in the phase prompt
4. Commit after each subtask (forces context cleanup, hook updates graph)
5. Write `docs/sprint/phase-N-completed.md` at end of phase (under 200 lines)
6. Run `/clear` between phases when Shiva says so

## Graphify usage
- Aiden graph: `cd C:\Users\shiva\DevOS && graphify query "..."`
- Hermes graph: `cd C:\Users\shiva\references\hermes-agent && graphify query "..."`
- Hooks fire on every commit; graph stays fresh automatically.
- Windows hook patch: `.git/hooks/post-commit` + `post-checkout` use uv-managed python at `/c/Users/shiva/AppData/Roaming/uv/tools/graphifyy/Scripts/python.exe`. Re-apply if `graphify hook install` is rerun.

## What v4 KEEPS from v3.19.x
86 tool implementations, Pro license + Cloudflare KV (`devos-license-server`), npm dual-package (`aiden-runtime` + `aiden-os`), plugin system, 40 bundled skills, provider chain (4 Groq + 4 Gemini + 3 OR + Ollama), C7/C8 safety, PlannerGuard concept, MemoryGuard concept, SkillTeacher concept, all 12 fixes from v3.19.5–v3.19.9, SOUL.md, native Windows support.

## What v4 DELETES
- `planWithLLM()` in `core/agentLoop.ts` (~1500 LOC) — confirmed via graphify (community 0, L838)
- `respondWithResults()` in `core/agentLoop.ts` (~800 LOC) — confirmed via graphify (community 0, L2681)
- Glue between them (~2700 LOC)
- `direct_response` fast-path
- Replan logic, multi-Q parallel handling
- C20/C21 fabrication band-aids (architecture replaces them)
- `workspace/semantic.json` (replaced by SQLite + FTS5)

## Testing requirements (every phase)
- Each phase has acceptance criteria — verify them, don't claim completion without tests passing.
- Run `npm test` (or equivalent) before committing.
- New code requires new tests where applicable.
- No phase advances with known regressions.

## Common gotchas
- `PACKAGE_ROOT` (npm install dir) vs `WORKSPACE_ROOT` (user data dir) — conflating these caused 3 failed releases.
- npm dual-package atomic publish: `npm run release:npm` (`scripts/release-npm.ps1`).
- `AIDEN_CLI_MODE=1` set by `bin/aiden.js` auto-suppresses bracket-prefixed `console.log` when level >= warn.
- Together-1 provider disabled (HTTP 400 cascade since v3.19.5).
- Windows graphify hooks need patched python path (see above).
