# Phase 0 + 0.5 — Completed

**Dates:** 2026-05-03
**Branch:** `v4-rewrite`
**Commits:** `e309234` (hook test marker), `1afaeb9` (Phase-0 setup), Phase-0.5 commit (this scaffolding)

## What was set up

### Tooling
- **uv 0.11.8** installed via official PowerShell installer to `C:\Users\shiva\.local\bin`
- **graphify 0.6.8** installed via `uv tool install graphifyy` (Python 3.12.13 venv at `C:\Users\shiva\AppData\Roaming\uv\tools\graphifyy\`)

### Hermes reference repo
- Cloned shallow to `C:\Users\shiva\references\hermes-agent` (HEAD `d87fd9f`, 92 MB, 2933 files)
- Branch `aiden-v4-reference` created locally (not pushed)
- Graph: 53,365 nodes / 96,865 edges / 1,892 communities, build time 1m22s
- `.graphifyignore` added (no actual filtering needed for Python repo, kept for consistency)

### Aiden repo
- Branch `v4-rewrite` created (2 commits ahead of `main` at session end)
- Graph: 1,782 nodes / 3,353 edges / 89 communities, build time 21s
- 277 code files extracted (down from 4924 unfiltered, 94% reduction)
- `.graphifyignore` excludes: standard build dirs + `native-modules/`, `dashboard-next/`, `release/`, `packaging/`, `installer/`, `dist-bundle/`, `electron/`, `workspace-templates/`, `scratch/`, `packages/`, `cloudflare-worker/`
- Skills/ directory KEPT in graph (40 bundled skills survive into v4)

### Hooks + Claude Code integration
- `graphify hook install` ran — wrote `.git/hooks/post-commit` and `post-checkout`
- Both **patched for Windows**: hardcode `GRAPHIFY_PYTHON=/c/Users/shiva/AppData/Roaming/uv/tools/graphifyy/Scripts/python.exe` (graphify 0.6.8 ships hooks that hardcode `python3` which doesn't exist on Windows)
- `graphify claude install` wrote PreToolUse hook to `.claude/settings.json` (fires on `Glob|Grep`, injects "knowledge graph exists" reminder)
- CLAUDE.md graphify section appended at lines 46-53
- Skill installed at `C:\Users\shiva\.claude\skills\graphify\SKILL.md`
- Hook firing verified: post-commit triggered rebuild on test commit `e309234` and Phase-0 commit `1afaeb9`

### Files created/modified
| Path | Status |
|---|---|
| `docs/v4.0.0-architecture.md` | NEW (966 lines, source of truth) |
| `AGENTS.md` | NEW (Phase 0.5, sprint context) |
| `docs/sprint/phase-0-completed.md` | NEW (this file) |
| `docs/v4-rewrite-marker.md` | NEW (hook firing test artifact, can be deleted later) |
| `.gitignore` | MODIFIED (Option B: `graphify-out/*` + `!graphify-out/GRAPH_REPORT.md`; removed `.graphifyignore` exclusion) |
| `.graphifyignore` | NEW (build-artifact filtering for graphify) |
| `graphify-out/GRAPH_REPORT.md` | NEW (committed; rest of graphify-out gitignored) |
| `.git/hooks/post-commit` | INSTALLED + PATCHED for Windows |
| `.git/hooks/post-checkout` | INSTALLED + PATCHED for Windows |
| `.claude/settings.json` | MODIFIED (graphify PreToolUse hook added) |
| `CLAUDE.md` | MODIFIED (graphify section added at L46-53) |

## Decisions confirmed in Phase 0
1. **graphify-out commit strategy:** Option B (commit only `GRAPH_REPORT.md`, gitignore `graph.json` + `manifest.json` + caches). Rationale: `graph.json` is 41 MB; treat as build artifact, regenerate locally.
2. **`.graphifyignore` final list** (Aiden): standard build dirs + 11 additional Aiden-specific dirs identified through manifest analysis. Skills/ kept.
3. **Hermes branch** stays local-only (`aiden-v4-reference`); never push to NousResearch upstream.
4. **Architecture doc fix:** `graphify .` → `graphify update .` (3 occurrences).
5. **Architecture doc note added:** Windows hook patch documented as known issue with re-application instructions.

## Known issues
- **graphify 0.6.8 + Windows hook bug:** hooks hardcode `python3`. Patched locally in both hook files. Upstream bug to be filed later.
- **graphify 0.6.8 + extraction warning:** `multer_lib` node has invalid `file_type='dependency'` — cosmetic, package.json scanning quirk. Ignored.
- **Pre-existing April 25 graphify-out content** (`build_graph.py`, `audit_q1.py`...`audit_q10.py`, `merge_extract.py`, etc.) was wiped per user direction. Was leftover scaffolding from an earlier graphify experiment.

## Verification queries (Phase 0)

**Hermes — "Where is the main agent loop implemented?"**
Top hits cluster in community 2 around `run_agent.py`: `AIAgent` (L873), `.run_conversation()` (L10382), `IterationBudget` (L271), `._execute_tool_calls_sequential/_concurrent()` (L9779/L9400). Confirms arch doc's claim that `run_agent.py` (~13.7k LOC) is the main loop file.

**Aiden — "How does the current agent loop work?"**
Top hits cluster in community 0 around `core/agentLoop.ts`: `planWithLLM()` (L838), `respondWithResults()` (L2681), `executePlan()` (L2131), `callLLM()` (L3037). **Confirms the doc's diagnosis exactly:** v3 has the planner+responder split that v4 deletes.

## What Phase 1 needs to know

**Phase 1 goal:** port `run_agent.py` → `core/aidenAgent.ts` (the single tool-calling loop).

**Reference reading order:**
1. Read `docs/v4.0.0-architecture.md` sections "The fabrication problem" and "v4.0.0 system architecture" before starting.
2. Use graphify to navigate Hermes structure: `cd C:\Users\shiva\references\hermes-agent && graphify query "..."`.
3. Identify tool dispatch + provider abstraction patterns in Hermes before touching Aiden.

**Surfaces to be aware of from v3 (will be deleted/replaced):**
- `core/agentLoop.ts:planWithLLM()` (L838)
- `core/agentLoop.ts:respondWithResults()` (L2681)
- `core/agentLoop.ts:executePlan()` (L2131)
- `core/agentLoop.ts:callLLM()` (L3037) — may survive in different form
- All in community 0 of Aiden graph

**Surfaces to integrate with (kept):**
- `core/toolRegistry.ts` (community 6, with `executeTool()` at L2877)
- `providers/router.ts` (community 0, with `getModelForTask()` at L453)
- `core/conversationMemory.ts`, `core/semanticMemory.ts`, `core/knowledgeBase.ts` (will be re-architected per arch doc storage section)

**Token-efficient pattern:** start every Phase 1 turn by reading this file, then graphify-querying for the specific surface. Do not re-read the architecture doc unless the question is about a locked decision.

## Acceptance check (Phase 0 + 0.5)
- [x] Both repos mapped, queryable
- [x] Aiden file count under 3000 (277 code files, 1951 manifest entries)
- [x] Hooks fire on commit (verified twice)
- [x] `graphify-out/GRAPH_REPORT.md` committed; rest gitignored
- [x] AGENTS.md exists, under 200 lines (64)
- [x] docs/sprint/ directory exists
- [x] phase-0-completed.md exists, under 200 lines
- [x] Architecture doc has the 12→13 fix and the `graphify update` correction
- [x] No commits on `main`; no pushes to remote
