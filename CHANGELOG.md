## v4.14.1 — 2026-07-05

The input bar is always there, and connecting a server is one command.

(The v4.11 → v4.14.0 line shipped via GitHub Releases; this entry resumes the changelog at the v4.14.x point release.)

- **One-tap MCP connect.** `/mcp connect <name>` adds the server, authorizes it, and connects — one command, no env vars, no three-step dance.
- **Always-present steering bar.** The input line stays live while Aiden works. Steer it mid-task, queue your next message, or stop with Ctrl+C — in both idle and busy.
- **`/mode` — pick your trust level.** Safe by default: Aiden asks before risky, spendy, or out-of-folder actions. `/mode auto` opts into hands-off; the floors always hold.
- **Warm intro + greeting.** Aiden asks your name once and actually uses it, and the boot greeting knows how long you've been away.

Fixes: no more "[compress] refused" noise on a fresh chat; the busy-hint text is width-safe.

---

## v4.10.0 — 2026-05-26

Aiden becomes inspectable, durable, and finally streams properly.

Spanning v4.9.1 → v4.10.0. The v4.9.2 / v4.9.3 / v4.9.4 hotfix series shipped to npm but never got dedicated GitHub releases; this entry covers everything since v4.9.1 plus the eleven v4.10 sprint slices.

### Critical fix
- **Streaming default restored at the wizard layer.** `DEFAULT_CONFIG.display.streaming` now defaults to `true` — restoring what v4.1.4 attempted but couldn't operationally land. The pre-10.9 architecture had `chatSession.ts` runtime fallback at `true` (since v4.1.4) but the setup wizard wrote `...DEFAULT_CONFIG.display` into `config.yaml` with `streaming: false`, so the runtime fallback never fired for any wizard-installed user. Every install since v4.0 silently received non-streaming. Users reported "Aiden feels slow" because they waited for full responses with no visible feedback. v4.10 fixes the wizard layer to match the runtime intent. Existing users with explicit `streaming: false` in their config keep their setting AND see a one-time per-session disclosure suggesting the flip. (Slice 10.9)

### New features
- **Durable Task object.** Every user prompt now creates a persistent `Task` row with status / goal / traceIds back-reference. `/tasks [active|completed|cancelled|failed|<N>]` lists them; `/adjust <task_id> cancel` or `/adjust <task_id> goal <new text>` controls them. Lifecycle states: pending / active / completed / failed / cancelled. (Slice 10.8)
- **Full trace persistence with rich schema.** Every tool call, permission decision, task lifecycle event lands in a 21-column `run_events` ledger with `(category, kind, name)` taxonomy + per-run `seq` + payload truncation tracking + tool-call-id correlation. Eight indexes for cheap filtering. `/trace recent` slash command + model-facing `trace_query` tool with scope dispatch (`current_run` / `current_session` / `run_id` / `session_id` / `last_hours` / `all`) + filters (category / kind / name / tool_call_id). (Slices 10.2 / 10.2b / 10.2c / 10.2d)
- **Scoped permission grants with audit.** `Once` / `Session (this <arg-kind>)` / `Always (this <arg-kind>)` / `Deny` picker labels carry a dynamic qualifier showing what the scope actually covers (path / command / url / code / call). Per-project allowlists at `<cwd>/.aiden/approvals.json` shadow global `~/.aiden/approvals.json` entries. Entries now persist `createdAt` + `lastUsedAt` timestamps; refresh-on-reuse keeps the audit trail accurate. REPL approval decisions now emit to `run_events` symmetric to the daemon path (`category=approval kind=approval.decided`). Smart-mode auto-allow / auto-deny paths now record the actual decided risk tier in `onDecision` callbacks, fixing audit-trail drift. (Slices 10.6 / 10.6c)
- **Project memory namespace as first-class file.** `PROJECT.md` travels with each project root, separate from global SOUL.md. Project-root detection cached at REPL boot and reused across the session. (Slices 10.1 / 10.1b)
- **REPL crash survival.** Process-level `unhandledRejection` + `uncaughtException` handlers installed at boot with survive-by-default semantics — log + render one dim line + keep the session alive. Asymmetric with the daemon path's fail-fast handlers (daemon has no user to recover; REPL does). (Slice 10.7)
- **Eval harness v1.** 20 contract tests under `tests/v4/eval/` protecting v4.10 substrate from regression at the cross-slice level: streaming-end-to-end (mockProvider-backed real adapter contract), streaming-default-audit (pins the wizard default), trace-end-to-end (multi-turn session surface), tasks-end-to-end (full lifecycle + traceIds back-reference), permission-grants-end-to-end (scope semantics + audit symmetry). (Slice 10.9)

### Fixed
- **Bug D ghost-text cursor (third attempt that actually works).** Ghost suggestion text moved out of the inline input line into the bottomContent tuple slot. Cursor now naturally lands right after the typed value because `@inquirer/core`'s screen-manager owns positioning on `content`, not `bottomContent`. Two prior attempts (v4.9.2 Slice 2 inline cursorBackward; v4.9.6 same shape reframed) shipped INERT because the screen-manager's absolute `cursorTo()` overrode any inline escape. Slice 10.4's node-pty harness is the regression layer those attempts lacked. (Slice 10.5)
- **`/trace recent` works between turns.** Pre-10.2c the slash command read `replParentRunRef.sessionId` (turn-scoped, nulled post-turn) instead of `chatSessionId` (long-lived). Worked only mid-turn; reported "no active REPL session" between turns even though the chat was clearly alive. (Slice 10.2c)
- **Channel isolation hardening.** `/channel telegram remove` now prints a shell-cleanup hint disclosing that Aiden can't reach `setx` / `~/.bashrc`-persisted env vars; also scans `config.yaml` for `${TELEGRAM_BOT_TOKEN}` references and warns when found. SIGINT/SIGTERM handlers now call `channelManager.stopAll()` with a 1s hard cap before `process.exit`, closing the Telegram polling-lock stale window. (Slice 10.7)
- **Approval-prompt picker label accuracy.** Pre-10.6c the labels read "Session" / "Always" — temporal-scope vocabulary — but the engine treats them as signature scopes (this tool + this primary arg). Users granted "Session" for `file_write test3.txt` and were surprised when `file_write test4.txt` re-prompted. Labels now carry a dynamic arg-kind qualifier: "Session (this path)" / "Always (this command)" etc. (Slice 10.6c)

### Internal
- **Status footer enhancements** (Slice 10.3). REPL ergonomics polish.
- **PTY test harness** (Slice 10.4). `tests/v4/harness/aidenTerm.ts` + `mockProvider.ts` for terminal regression coverage — load-bearing for Slice 10.5 + Slice 10.9.
- **REPL StderrSink drop** (Slice 10.7a). Sub-slice ahead of full Slice 10.7 channel work.
- **Symmetric-coverage source-contract guards.** A new test pattern asserts that paired emit sites (REPL + daemon paths) both fire their categorized events. Catches the "missing emit at a site that should emit" regression class that grep-based audits silently pass.

### Known limitations (deferred to v4.11)
- Mid-turn task abort. `/adjust <id> cancel` records intent but doesn't abort the in-flight agent loop; requires abort-signal-from-outside-the-turn plumbing.
- Live status-bar refresh during streaming. Needs the renderer-ownership refactor.
- Inline ghost text. Moved to footer for v4.10 — the inline form would require Aiden to own the final cursor position rather than `@inquirer/core`.
- Full task-kernel ledger (claim_lock, worker_pid, heartbeat). Slice 10.8 ships the lighter REPL-scoped Task object; the multi-worker daemon path picks up the heavier kernel.
- Cross-channel rendering coordination. Tasks are REPL-scoped this slice; Telegram / Discord task surfacing is v4.11+.

---

## v4.9.4 — 2026-05-24

Hotfix for tool-call protocol orphans.

### Fixed
- **Provider 400 "No tool output found for function call <id>"** — When the tool-loop surface decision or abort signal interrupted a multi-call batch, the assistant message's tool_call_ids could be left without matching tool result messages. The next provider call (this turn or a resumed history) returned 400. Both guards now fill synthetic blocked-tool-result messages with a uniform shape (`{ ok: false, blocked: true, reason, message }`) so the LLM sees a consistent signal regardless of which guard fired.
- New `assertNoUnansweredToolCalls()` preflight at the single provider call boundary (`AidenAgent.callProvider`). Throws loud if any future guard leaves orphans. Safety net for upcoming v4.10 work.

### Known follow-ups for v4.10
- Hooks subprocess runner + MCP install healthCheck still use the pre-v4.9.2 spawn pattern.
- Typing-suggestion cursor misalignment in REPL input area (carried from v4.9.0).

---

## v4.9.3 — 2026-05-24

The boot greeter.

### Added
- **Boot greeter** — Aiden now notices things on boot and may speak first. Detects last session's open items, update availability, time of day, and cwd changes. Says ONE thing, or stays silent. Silent on first-ever launch — `renderFirstRunHint` owns that moment. Passive decay rules prevent re-offering ignored items.
- **`/greeter on | off | status`** slash command. Off is durable until re-enabled.
- **`~/.aiden/.greeter-history.json`** state file tracks offer acceptance passively (no runtime hooks, no LLM calls — pure templated speech).

### Known follow-ups for v4.10
- Daemon-crash and hook-auto-disable scanners (Tier-1 templates wired, scanners deferred until daemon log + hook registry surfaces stabilize).
- Git status scanner (needs per-cwd allowlist UX).
- Real PTY integration tests (needs node-pty + cross-platform native compilation; in-process forced-TTY tests cover wiring for now).
- Typing-suggestion cursor misalignment in REPL input area (carried from v4.9.0 — proper save/restore refactor needs the test-harness work planned for v4.10).

---

## v4.9.2 — 2026-05-23

Hotfix for Windows update install + REPL confirmation UX.

### Fixed
- **Windows `/update install` spawn EINVAL** — `npm.cmd` now spawns cleanly via `cmd.exe /c` on Windows. MCP server connect (`npx`-based MCP installs) gets the same fix.
- **REPL confirmation prompts now visible** — `(y/N)` hint, distinct `?` glyph, explicit cancellation reasons. Affects `/channel telegram remove`/`takeover`, `/cron remove`, `/plugins install`/`uninstall`.

### Known follow-ups for v4.10
- Typing-suggestion cursor misalignment in REPL input area (carried from v4.9.0 — proper save/restore refactor needs the test-harness work planned for v4.10).
- Hooks subprocess runner + MCP install healthCheck still use the older spawn pattern (same root cause as Windows update spawn, lower exposure in practice — migration scheduled for v4.10).

---

## v4.9.1 — 2026-05-23

Same-day hotfix for the Windows update flow + install UX polish.

### Added (post-release amendment)
- **REPL slash commands** for memory + hooks + daemon — manage Aiden without quitting the chat. Read-only and safe-mutating ops execute inline; destructive ops (`/memory remove`, `/hooks trust`, `/daemon start`) show a shell hint with the correct CLI command.

### Fixed
- **Windows update permission denied** — `/update install` now shows correct PowerShell instructions (not bash `export` syntax)
- **Update modal overlap** — update prompt no longer stacks on welcome banner
- **NPM deprecation noise** — DEP0190 warnings filtered from displayed output (logged to `~/.aiden/logs/update.log`)
- **Stale npm prefix detection** — warns users with risky prefix paths (Program Files on Windows, /usr/local without write access on Mac/Linux)

### Added
- **Install progress animation** — `/update install` shows live progress bar with phase indicators (spawning → resolving → downloading → extracting → verifying → installed). Reusable component ready for future long-running commands.

### Cross-platform
All fixes are platform-aware. Windows / Mac / Linux each get correct shell syntax in instructions. Progress bar works identically across platforms.

### For existing users
- Mac/Linux v4.9.0: unaffected, no need to update
- Windows v4.9.0: update via Admin PowerShell — `npm install -g aiden-runtime@latest`

---

## v4.9.0 — 2026-05-23

The biggest Aiden release yet. Three new feature families on a fully rebuilt observability substrate.

### 🧠 Memory system

Aiden now has structured, persistent memory across conversations.

- **Three namespaces:** `memory` (project & environment facts), `user` (your identity & preferences), `project` (per-repo context auto-detected from `.git`)
- **CLI surface:** `aiden memory list/show/add/remove/edit/backup/restore/diff/namespaces`
- **Post-turn reviewer:** Aiden quietly reviews each conversation for memory candidates, surfaces them in a pending section, you approve via `aiden memory approve <id>` or `reject <id>`
- **Strict skip rules:** Sensitive-class filtering, negation rejection, duplicate detection — "don't store harmful inferences" guardrail layer
- **Substrate-integrated:** Every memory op produces a `mem_<uuidv7>` span with full audit trail

### 🪝 Hook system

User-defined subprocess hooks that observe, decide, or transform Aiden's behavior.

- **Six events:** `tool.call.pre`, `tool.call.post`, `session.start`, `session.end`, `approval.requested`, `approval.responded`
- **Three authority levels:** observe, decision (allow/block), transform
- **Three modes:** best_effort_observer, advisory_policy, mandatory_policy
- **Security defaults:** Subprocess isolation (no in-process eval), env-scrubbed (no API key leaks), per-hook timeout, default `untrusted` until explicitly trusted
- **Auto-disable:** `on_error: disable_hook` policy + 3-strike rule (defense in depth)
- **CLI surface:** `aiden hooks list/show/trust/revoke/rescan/test/doctor/audit`
- **Drift detection:** SHA256 hash pinning catches modified hook scripts automatically
- **Full audit trail:** Every hook firing recorded in `hook_executions` table with stdout/stderr previews

### ⚙️ Strategic substrate (production-grade observability)

The daemon now has real durability + tracing infrastructure.

- **UUIDv7 identity** with typed prefixes: `dmn_/inc_/run_/trc_/spn_/mem_/hook_/tool_/req_/att_`
- **W3C Trace Context** propagation — incoming `traceparent` adopted, outgoing requests emit it
- **AsyncLocalStorage ambient context** for log injection; explicit `ExecutionContext` for crossings
- **Durable run queue** — runs, attempts, spans, idempotency keys all persisted; 202 responses only after durable insert
- **Idempotency keys** — duplicate webhooks/triggers rejected at ingress, no double-execution
- **Subprocess context propagation** via env vars (works across `spawn`/`exec` boundaries where AsyncLocalStorage can't reach)
- **Crash recovery** — daemon incarnations table tracks every process start; stuck-attempt watchdog sweeps abandoned work; orphan spans cleaned up automatically
- **Retry policy** with exponential backoff, error classification, dead-letter handling
- **Structured NDJSON logs** with redaction sink + automatic context enrichment
- **`aiden daemon doctor`** with `--json` and `--fix` for production diagnostics

### ✨ Polish

- **Theme system:** 5 bundled themes (default, monochrome, light, tokyo-night, dracula) with hot-reload at `~/.aiden/theme.yaml`
- **MCP integration:** `aiden mcp init/doctor/repair/uninstall` for Claude Desktop, Cursor, and VS Code (5 server profiles: general/dev/readonly/browser/research)
- **UI refinements:** Cleaner status line, sandwiched prompt zone with horizontal rules, blank-line breathing room around Aiden's responses, improved markdown rendering with proper inter-block spacing

### 🛠️ Internals

- Schema migrations v8→v12 (incarnations, runs/attempts/spans/idempotency, traceparent columns, hooks family, hook consecutive_failures)
- 4166 tests passing (started this sprint at 902 — added 3264 tests)
- Project memory auto-detection via `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.aiden/PROJECT.md` anchors
- Honest LOC accounting: ~9000 LOC added across 22 feature commits + 1 ship commit

### 🐛 Known follow-ups for v4.9.1

- `hook_subscriptions.subscription_id` foreign-key missing `ON DELETE CASCADE` (cosmetic noise on rescan, functional behavior correct)
- `runtime.lock` stale-PID handling for programmatic daemon bootstrap
- Hook firings produce audit rows in `hook_executions` but don't nest under `kind='hook'` spans (two surfaces, unified later)
- Typing-suggestion cursor misalignment in REPL input area
- 3 non-Anthropic LLM adapters silently drop outbound trace headers (W3C-recommended fallback, no regression — formal merge deferred)

---

## v4.8.1 — 2026-05-21

### Fixed

- **Paste handling**: Robust paste support across terminal environments (Windows ConPTY, SSH without `-t`, tmux/screen passthrough, VS Code integrated terminal). Stateful parser across stdin chunk boundaries, 800ms watchdog for missing paste-end markers, degraded marker form normalisation, universal CRLF / bare-CR → LF normalisation, and 30ms timing accumulation that catches line-by-line paste delivery. Typed prefix is preserved when a paste is added mid-input.
- **Tables**: Markdown tables now render as proper grids. Proportional column distribution with header-floor minimum widths so short labels never wrap awkwardly. Model nudged via system prompt to prefer sectioned lists or 3-column tables for wide comparison content.
- **Version reporting**: Boot card and `/version` now read from the runtime `package.json` instead of a build-time injected constant. Fixes stale version display after `/update install` and the v4.8.0 case where the tsc-compiled `dist/core/version.js` baked the pre-publish version.
- **`/update install`**: Dropped the Node 20+ deprecation warning by removing `shell: true` from the npm child-process spawn (uses `npm.cmd` directly on Windows). Install progress shown via the sliding-shimmer indicator. Install-method detection broadened to Windows user-mode globals (`AppData/Roaming/npm`).
- **Loading indicator**: Now aligned at column 2 matching all other structured surfaces. Conditional erase preserves a clean 1-blank rhythm between user input and `▎ Aiden` header without consuming tool-row content.
- **Spacing**: Exactly one blank line between the user input echo and the Aiden reply header. Removed accumulated blanks that had stacked across multiple v4.8.0 slices.
- **Timer glyph**: Hourglass `⌛` now visible at all terminal widths in the status bar (mid and compact tiers previously dropped it).
- **Approval prompts**: Single panel per `file_write` approval. The `ui_approval_request` event-row paint that stacked above the framed panel was suppressed; the panel is now the sole chat-surface paint.

### Changed

- `core/version.ts` is now a runtime reader (walks up from `__dirname` to find the `aiden-runtime` `package.json`). The `prebuild:cli` / `prebuild:api` hooks that ran `scripts/inject-version.js` have been removed.

### Notes

- All visual changes apply at first build; no migration required.
- Runtime version detection means the published artifact reports its own version correctly without a re-bake step at publish time.

---

## v4.8.0 — 2026-05-21

### Semantic ui_* event surface (Phase 2.1–2.7)

Seven new uiOnly tools the model can call to communicate render-time state without writing it as markdown text. The agent's dispatch loop branches early for these: no executor, no iteration count, no observability hooks, no verifier, no recovery, no trace. A `(no output)` tool_result satisfies the provider protocol. The caller fires `onUiEvent(name, args)` and the REPL renders structured rows in the chat surface.

**Tools registered (all `uiOnly: true`, `mutates: false`):**
- `ui_task_update` — task state signal (running / paused / blocked); supports `kind: 'subagent'` with depth indent
- `ui_task_done` — task complete with status (success / failure / blocked) and optional summary
- `ui_command_result` — shell output as a formatted block; muted stdout cap-5 lines, error stderr cap-5 lines, exit-code row when non-zero
- `ui_test_result` — pass/fail count with framework + optional duration
- `ui_approval_request` — structured prompt; fires automatically alongside the existing y/n flow before risky tool dispatch
- `ui_toast` — transient notice with info / success / warning / error kinds
- `ui_artifact_created` — file / skill / directory creation surface

**Wiring:**
- Agent dispatch branch in `core/v4/aidenAgent.ts` (Phase 2.1) — bypasses observability + iteration accounting, fires `onUiEvent`
- `Display.renderUiEvent` renders all 7 events with chrome matching `toolRow` (muted `┊` gutter + space + colored content per line). Multi-line surfaces carry the gutter on every physical line.
- REPL `chatSession.onUiEvent` stops the activity indicator before paint (the dispatch branch bypasses `onToolCall('before')` which normally stops it)
- `ApprovalEngine` emits `ui_approval_request` immediately before `promptUser` (additive — y/n flow unchanged)
- `spawn_sub_agent` emits `ui_task_update` (kind:`'subagent'`, depth:1) on child start and `ui_task_done` on completion
- Daemon agent + subagent surfaces register `resolveUiOnly` but use no-op `onUiEvent` stubs (no chat surface)

**System prompt nudge:** `## UI events` section added to every system prompt with WRONG/RIGHT examples teaching the model to emit structured events instead of markdown status text during multi-step work.

### Visual redesign (Slices 2–11c)

Comprehensive UI refresh across every surface the user sees.

**Design system foundation:**
- `cli/v4/design/tokens.ts` — central tokens for colors, glyphs, and spacing. All surfaces consume from one source so chrome stays consistent and a future palette swap is a one-line change.
- Brand orange `#FF6B35` carried by colour, not by exotic codepoints. Glyph set locked to universal-font characters: `│ ─ ● ○ ✔ ⌛ ♥ ▲ ╭ ╮ ╰ ╯ █`.

**Status bar:**
- Packed cross-glance footer: cyan model name · amber token ratio · semantic-tiered context bar (`●●●●●●○○○○`) · purple turn counter · teal `⌛` per-turn timer · state dot.
- Auto-progressive disclosure: drops segments on narrow terminals (status state → turn count → timer → tokens → model) preserving the highest-signal info.

**Reply + tool surfaces:**
- Aiden reply chrome: `│ Aiden` header in brand orange, content aligned to column 2.
- Tool-trail rows: emoji icons + verb (`✏️  writing`, `👁️  reading`, `🌐 fetching`) followed by truncated arg preview. Indicator pulses + (Ns) elapsed time.
- Activity indicator: single-row sliding-block shimmer — 4-cell `█` segment scrolls L→R on a muted `─` track at 250ms/cell, wraps continuously. Replaces the prior 2-row hourglass + wave-bar layout.

**Framed panel chrome:**
- Aiden-native asymmetric framing: orange `│` left-edge bar with top-divider + bottom-hint footer; no closing corners. Used by `/help`, approval prompts, setup wizard step headers, and the framed-panel renderer.
- Approval prompt redesigned: structured key/value rows replace the prior ASCII box. Tier carried by colour (cyan info / amber caution / red destructive) so the bar paint signals the tier without a separate label.
- Code blocks: top-divider asymmetric chrome (`── python ─────`) with brand-orange language label. Left-rail dropped (competed visually with dark-bg syntax highlighting).

**Markdown rendering:**
- Bullet lists: `●` filled top-level / `○` hollow nested.
- Task lists: `✔️` checked / `○` unchecked (GFM-compatible).
- Numbered lists: zero-padded alignment for double-digit counts.

**Onboarding refresh:**
- 24-bit ANSI ASCII banner — bypasses theme depth-detection so the brand mark renders crisp on Windows ConPTY regardless of `COLORTERM`.
- Disclaimer rewritten with capability bullets + scannable legal acknowledgments inside the framed panel.
- Loading sequence: 10-cell progress bar (`●●○○○○○○○○ 25%`) above per-step rows; each step has a real check (`✓ Checking system`) and a right-aligned status (`Node v22 · Windows 11`).
- "Built solo" card: rounded heavy frame (`╭─╮ │ │ ╰─╯`) — distinct from the `│` panel chrome to signal "identity card" rather than "navigation surface".

### ChatGPT Plus + gpt-5 auxiliary routing fix (Slice 11)

Auxiliary cheap-LLM calls (`risk_assess`, `compression`, `session_summary`, `skill_describe`) previously inherited the parent loop's provider/model. When the parent was ChatGPT Plus + gpt-5, every auxiliary call returned `400 model-not-supported` from the Codex backend (which accepts only `gpt-5-codex` / `gpt-4.1-mini` / etc.).

Fix: `AuxiliaryClient` gained a `fallbacks[]` chain. aidenCLI now passes Groq + `llama-3.1-8b-instant` as the default and the parent provider/model as the fallback. Auxiliary calls land on Groq when configured (cheap, fast, reliable for the cheap classify/summarise jobs auxiliary is designed for) and fall through to the parent only when Groq is absent. `AIDEN_VERBOSE=1` surfaces which provider handled each call.

### Debug spam silenced

`[auxiliary]`, `[skill] candidate`, `[compress]`, `[budget] caution`, `[memory]` lines now gated behind `AIDEN_VERBOSE=1`. End-user terminal stays quiet; power users opt in.

### Tests

- 13 new behavioural tests in `tests/v4/cli/display.test.ts` covering all 7 ui_* renderers, dispatch gates, subagent indent, multi-line gutter integrity, kind-glyph mapping, line-cap truncation, required-field guards.
- 3 new fallback-chain tests in `tests/v4/auxiliaryClient.test.ts` (default-wins, fallback-wins, all-fail unavailable path).
- Shimmer indicator coverage rewritten in `tests/v4/cli/activityIndicator.test.ts` (slide, wrap, opt-out, single-row erase, breathing-space `\n`).
- Full `tests/v4/cli/` suite: 891 passed, 16 skipped, 0 failed.

### Breaking (cosmetic only)

- Panel chrome glyph changed from `▎` (U+258E LEFT ONE QUARTER BLOCK) to `│` (U+2502 BOX DRAWING LIGHT VERTICAL). `▎` rendered as outline-tofu on Cascadia / common Windows ConPTY fonts; `│` is universal. Affects `/help`, approval prompt, Aiden reply header, setup wizard, framed-panel renderer, onboarding disclaimer + success screens.
- Status footer glyphs swapped from hex dots (`⬢`/`⬡`) to circles (`●`/`○`) for cross-font compatibility.

### Known limitations (deferred to v4.8.1)

- Render path consolidation — some surfaces still drift on first paint until the v4.8.1 refactor unifies them.
- Daemon-side `onUiEvent` serialization to `run_events` stream — currently no-op; planned alongside daemon UX work.

---

## v4.7.0 — 2026-05-20

### Honesty verifier — outcome-based, no more false refusals

The post-loop honesty verifier no longer scans natural-language text against a hardcoded English-verb table. It now records deterministic outcomes from the tool trace: mutating tools that errored, and memory_* tools that came back with `verified: false`. Everything else is silence.

What this fixes:
- The "I should not claim actions" false-refusal class is gone. If the model says "I checked the docs" and the trace shows a `web_search` call, the verifier is silent — no rewriting, no rebuttal.
- Tool aliases / phantom names that never matched a real tool (`open_browser`, `run_python`, `run_node`, `memory_upsert`, `memory_forget`, `model_switch`, `web_fetch`) are gone — they were unmatched anyway.
- Assistant message history is never rewritten. The previous `correctedResponse` rewrite path that mutated `loopResult.messages` in place is removed.

What the verifier still catches:
- `mutation_errored` — a tool tagged `mutates: true` returned an `error`. Path is extracted from `result.path` when present.
- `memory_unverified` — a memory_add / memory_replace / memory_remove tool returned with `verified: false`. This was the v3 C20/C21 lying surface and the only remaining memory-specific check.

Enforce mode appends a one-paragraph footer summarising unverified outcomes (one summary line + one row per event). The assistant's text is left intact above the footer. Detect mode records events without user-visible output. Off mode bypasses entirely.

### Scope

- New: `HonestyEnforcement` runs in subagents (mode `detect`) and daemon agents (mode mirrors REPL config, default `enforce`). Previously REPL-only because regex false-refusals would have broken autonomous contexts; the new verifier is cheap enough to run everywhere.
- New: `HonestyTraceEntry.handlerMutates` flag, stamped at dispatch time from `resolveMutates`.
- New: `HonestyEvent` union (`mutation_errored | memory_unverified`) returned from `recordOutcomes` for external consumers.
- Changed: `HonestyResult.correctedResponse` removed, replaced by `HonestyResult.footer` (append-only).
- Changed: `HonestyEnforcement.check` is a thin orchestrator over `recordOutcomes` + `buildFooter`; both are exposed as callable surfaces for telemetry / external use.

### Tests

- 22 regex-asserting tests deleted, 27 behavioural tests added across `tests/v4/moat/honestyEnforcement.test.ts` and `tests/v4/aidenAgent.moat.test.ts`. Zero remaining honesty-related skips.
- Coverage: all 3 modes; mutation and memory event paths; legacy trace compatibility; footer aggregation; `originalResponse` preservation; `loopResult.messages` history untouched; regression guard against the "no_tool_call" false-refusal class.

### Known issues (deferred to v4.7.x)

- Integration tests under `tests/v4/integration/` (`aidenAgent.honesty.test.ts`, `aidenAgent.moat.repl.test.ts`) use loose filter patterns that mostly survive the new event shape, but any assertion expecting `no_tool_call` findings will need rebase. Both are gated by `AIDEN_LIVE_*` env vars and excluded from CI.
- CI still surfaces ~29 pre-existing sandbox-default-list mismatches on Linux/macOS runners (`tests/v4/tools/files.test.ts`, `sandboxFsIntegration.test.ts`, `dryRunIntegration.test.ts`, two cases in `core/sandboxFs.test.ts`, plus two XDG path tests). These predate v4.7.0 and were uncovered when the smoke gate was unblocked in v4.6.2. Not blocking ship.

---

## v4.6.2 — 2026-05-20

### Security
- Fix critical SSRF in transitive `form-data@2.3.x` (GHSA scoped via `request` chain). Scoped override pins `form-data >= 2.5.5` along that path while keeping direct `form-data` at v4.
- Bump direct `ws` 8.20.0 → 8.20.1 (regex DoS, GHSA-3h5v-q93c-6h6q).
- Pin transitive `qs >= 6.14.1`, `tough-cookie >= 4.1.3`, `protobufjs >= 7.5.8` via npm `overrides`.
- Bump `next` to 16.2.6 in `dashboard-next` (covers 11 stacked Next.js CVEs).
- Pin `postcss >= 8.5.10` in dashboard overrides (transitive vuln in next's bundled postcss).
- Dependabot count: 19 → 4 residuals, no user-facing behavior change.

### Known issues
- 4 residual alerts chain through deprecated `request` (via `node-telegram-bot-api`). `request` will never be patched upstream. Real-world risk in Aiden's usage is essentially zero (bot lib calls Telegram API with no user-controlled URLs). Full fix requires swapping to a maintained telegram client — scoped for v4.7.x.

### Notes
- No application code changed. Dependency overrides only.
- 56 tools still register. Build clean.
- Carries forward all v4.6.1 onboarding work.

---

## v4.6.1 — 2026-05-20

### Onboarding redesign
- Disclaimer screen with framed banner and honest "still rough in spots" copy
- 4-step loading sequence (system / skills / tools / memory) with timing readouts
- Rich provider picker with badges, no defaults — force explicit selection
- Live `/models` API fetch with curated static fallback for 6 providers
- 3-step connection probe: key works → model accessible → tool calls supported
- Success screen with 3 example prompts and REPL handoff
- First-run hint banner
- `/walkthrough` slash command — 5-screen guided tour

### Site
- Landing-site honesty rewrite: removed unshipped sections (dashboard mockup,
  4-modes, watch mode, fake slash commands, unverifiable benchmark claims)
- Added v4.6 feature cards reflecting what actually shipped
- Hero, theme, navigation, contact form preserved

### Known issues (deferred to v4.6.2)
- Tool count shows "0 registered" briefly during loading (race condition)
- `[skills] 72 loaded` line prints after success screen (race condition)
- Capability card shows "60 tools" — actual count is 56 (display drift)

---

## [4.6.0] — Sub-agents + Self-Improvement — 2026-05-19

### Added

- `spawn_sub_agent` tool: spawn focused child agents with toolset intersection from parent, isolated workspace
- `subagent_fanout` tool: parallel ensemble or partition workflows with merge strategies (`all` / `vote` / `pick-best` / `combine`)
- `/spawn-pause` slash command: operator kill-switch for sub-agent spawning (durable across restart, file-marker storage at `~/.aiden/spawn.paused`)
- `/recovery list/show/clear` slash command: cross-session failure pattern review surface
- `failure_signatures` + `recovery_reports` tables (v7 migration): TCE writes signatures on classify, recoveries on failure→success transition
- `aiden runs list --include-children` flag: show fanout/spawn children in run history
- Provider override per spawn: `subagent_fanout` accepts per-child `provider` field; fail-loud validation via `ProviderNotFoundError`

### Changed

- `subagent_fanout` refactored as layered API on top of `spawn_sub_agent` primitive (Phase 2 architecture)
- PlannerGuard now opt-in (default OFF, was ON); enable via `AIDEN_PLANNER_GUARD=1` or `/planner-guard on`
- REPL writes parent-run row per turn; child runs filter from default `aiden runs list` view; child-count badge on parent rows

### Fixed

- MCP-mode `subagent_fanout` regression (silently broken since v4.5 refactor; now uses spawnDeps wiring like REPL)

---

## [4.5.0] — Autonomous Aiden — 2026-05-17

### Headline

Aiden 4.5 introduces persistent daemon mode — register file watchers, webhooks, email triggers, and scheduled jobs that fire real autonomous agent turns. Plus continuous error recovery (TCE), browser depth observation, an execution sandbox, and a contextual slash-command UX layer.

### Added

- Daemon mode (`AIDEN_DAEMON=1`) with file / webhook / email / cron trigger sources, durable SQLite-backed bus + dispatcher
- Real-time agent invocation on trigger fires via `createRealAgentRunner` with per-trigger `sessionId` isolation
- Execution sandbox (`AIDEN_SANDBOX=1`) with three-tier risk classification (safe / caution / dangerous), file-op allowlist, Docker isolation, dry-run support
- Browser depth observation (`AIDEN_BROWSER_DEPTH=1`) with stale-reference auto-recovery and multi-tab state tracking
- TCE: turn-by-turn continuous evaluation with 16 failure categories and structured retry decisions
- Slash commands: `/sandbox`, `/tce`, `/browser-depth`, `/daemon`, `/suggestions` for live subsystem toggling
- Boot-time update notifications with `y/n/later` prompt, 5s timeout, semver-aware skip-version persistence
- Install-method detection (`npm-global` / `npm-local` / `npx` / `standalone-binary`) for context-correct upgrade commands
- CLI surface: `aiden trigger`, `aiden cron`, `aiden daemon`, `aiden runs` subcommands with `list`, `show`, `logs`, `runs` views
- Soak test harness (`tests/v4/daemon/soak/`) for production validation — CI-safe quick mode + manual 1h / 72h profiles
- HMAC webhook verification (GitHub `sha256=`, GitLab token, generic hex) with route → size → hmac → event → rate → idempotency ordering
- IMAP email trigger with sender allowlist, automated-sender filter (`noreply@`, `MAILER-DAEMON`), attachment policy
- Cron misfire policies (`skip_stale`, `run_once_if_late`, `catch_up_with_limit`, `manual_review`)
- Per-trigger token budgets (`maxTokensPerFire`) and daemon-wide daily cap (`AIDEN_DAEMON_DAILY_BUDGET`)
- Per-trigger approval policies (`safe-only`, `caution-ok`, `dangerous-ok`) — `safe-only` default for untrusted-ingress sources
- Comprehensive docs at `docs/v4.5/` (overview, triggers, dispatcher, sandbox, TCE, browser-depth, architecture)

### Changed

- Bold markdown rendering: dropped underline (`paintBoldUnderline` → `paintEmphasis`); bold is now bold-only
- Boot screen spacing improved; boot card UX polish
- Update check cache TTL bumped 6h → 24h
- `/update` flow now distinguishes registry-known vs GitHub-only releases

### Architecture

- SQLite daemon foundation with 5-table schema (`triggers`, `trigger_events`, `runs`, `run_events`, `daemon_instances`); migrations v1 → v5
- Per-trigger `sessionId` derived from `idempotencyKey` keys docker context, browser state, and TCE history isolation
- Two-phase bootstrap: foundation (bus + dispatcher + bootstraps) runs first; late-install agent builder injected via `bootstrapDaemon({ agentBuilder })`
- Wizard TTY guard skips raw-mode prompts under systemd / launchd; daemon mode boots non-interactively
- Run-event audit trail: `dispatcher:invoked` → `tool_call_started` → `tool_call_completed` → `approval_decision` → `dispatcher:completed` (or `:rejected` / `:builder_failed`)

### Migrations

- Existing `cron_jobs.json` auto-migrates to SQLite `scheduled_workflows` on first daemon boot (backup written alongside)

### Breaking

- None. Every new subsystem is opt-in via env var or slash command.
- `AIDEN_DAEMON=0` default — zero behavioral change from v4.0.2.
- `AIDEN_SANDBOX=0` default; `AIDEN_TCE=1` auto-on (disable via `/tce off`); `AIDEN_BROWSER_DEPTH=1` auto-on (disable via `/browser-depth off`).

### Install

```bash
npm install -g aiden-runtime@4.5.0
# or
npx aiden-runtime@4.5.0
```

### Stats

- 38 commits since v4.0.2
- 3432 tests passing, 41 skipped, zero failures
- ~22,000 LOC added
- 14 internal version arcs bundled

### Acknowledgements

Built solo by Shiva at [Taracod](https://taracod.com).

---

## [4.1.2] - 2026-05-13

### Memory Architecture (Phases A-D)

Aiden now remembers across sessions in ways that actually work:

- **Phase A — Reliable session-end firing**: Distillation triggers on every CLI exit path (`/quit`, SIGINT, SIGTERM, EOF, crash), not just `/quit`. 4-second timeout with honest skip logging. In-memory idempotency flag prevents double-summary.

- **Phase B — Structured distillation**: Replaces lossy 5-bullet summary with structured `SessionDistillation` JSON: bullets, decisions, open_items, keywords (semantic, from auxiliary LLM) + files_touched, tools_used (deterministic, from tool trace) + schema_version, exit_path, partial (metadata). Persisted to `<aiden_home>/distillations/<session_id>.json`. Transcript filtered before auxiliary call to prevent agent-boilerplate leakage. Hardened prompt with explicit anti-boilerplate rules.

- **Phase C — Cross-session retrieval**: New `recall_session` tool queries past distillations by topic + recency. Inputs: query, limit, days, include_full. Output includes `total_found` and `scanned` to distinguish "no history" from "history exists, no match."

- **Phase D — Promotion path (opt-in)**: At session-end after distillation writes, Aiden surfaces promotion candidates from explicit user signals (`remember that...`, `save this for next time...`) + distillation decisions/open_items. User approves with numbers (`1,3`), ranges (`1-3`), `all`, `none`, or `skip`. Approved facts land in new `## Durable facts` section of MEMORY.md.

- **Memory consent contract**: `memory_remove` refuses autonomous deletion of facts in `## Durable facts`. Model can propose, only user can revoke. Two-layer defense (tool description warning + tool-side rejection).

### Update Flow

- `/update` slash command — bypass cache, fresh registry probe, print current vs latest
- `/update install` — execute `npm install -g aiden-runtime@latest` from inside Aiden, prompt restart
- `aiden_self_update` tool — natural language works: "update yourself" → two-step confirmation → install
- Permission-aware fallback prints platform-specific copy-paste commands (Windows admin, macOS/Linux sudo, user-local npm prefix)

### Provider Work

- **Boot auto-pick**: New users get best authed provider at boot — priority `chatgpt-plus → claude-pro → anthropic → openai → deepseek → groq → ollama`. Persisted user choice still wins.
- **Runtime slot freshness**: System prompt's provider/model description updates on `/model` switch (was caching at boot).
- **Liveness probe fix**: `aiden doctor --providers` correctly reports chatgpt-plus green.
- **Codex `{detail}` envelope**: Upstream error messages now surface in standard error path.
- **DeepSeek V4 Pro** added with `thinking: enabled` + `reasoning_effort: high` defaults via new per-model defaults pattern.

### Telemetry Foundation

- **Subsystem health registry**: Silent failures in ContextCompressor, SkillTeacher, SkillMiner, Logger surface via `aiden doctor`. Slice 3 of v4.1.2.
- **Skill outcome telemetry**: Tool success/failure attributed to recently-loaded skills (5-tool attribution window after `skill_view`). Persisted to `<aiden_home>/skills/.skill-outcomes.json`.

### Eval Harness

- Standalone `evals/cli.ts` runner via ts-node (vitest can't gate publish on eval failures)
- 18 honesty scenarios (10 easy + 8 hard) — catches regressions in honesty enforcement
- Variance-prone scenarios documented (model phrasing flickers between 17-18 across runs; baseline is 17/18)

### Computer Control (Windows)

8 new tools: `screenshot`, `os_process_list`, `media_key`, `volume_set`, `app_launch`, `app_close`, `clipboard_read`, `clipboard_write`. All PowerShell-wrapped. Cross-platform support deferred to v4.1.3+.

### Self-Awareness

- Boot card shows current version (`● v4.1.2`)
- Runtime slot in system prompt tells Aiden which provider/model it's actually running

### Bug Fixes

- Phase D explicit-signal regex preserves decimals in version strings, URLs, filenames (was truncating `gpt-5.5` at `5`)
- Distiller no longer produces agent self-description boilerplate (transcript filtered, prompt hardened)
- `memory_remove` cannot autonomously delete user-approved durable facts

### Install / Upgrade

```bash
npm install -g aiden-runtime@latest
```

Or from inside Aiden: `/update install`

### Counts

- 53 tools (was 45)
- 74 skills (was 68)
- 33 slash commands (was 28)
- 1,983 tests (was ~1,500)
- 18 honesty scenarios (was 10)

---

## v4.1.1 — 2026-05-12

Hotfix release. Fixes ChatGPT Plus OAuth users hitting 400 errors on every message. Adds proactive provider health checks.

### Fixed

- **ChatGPT Plus 400 on every message** — `subagent_fanout` tool schema was missing `items` declaration; OpenAI's Codex backend rejected it on strict validation. Real chats now work normally.
- **Codex adapter sent orphaned `tool_choice`** — `tool_choice: 'auto'` and `parallel_tool_calls: true` were unconditionally set in the request body even when `tools` was absent. Now conditional on tools being present.
- **Ollama error doubled** — response body appeared twice in error messages. Adapter no longer pre-formats the body; `ProviderError.composeMessage` handles surface rendering centrally.
- **README drift** — removed two stale lines claiming `subagent_fanout` was deferred (it shipped in v4.1.0).

### Added

- **`aiden doctor --providers`** — opt-in deep mode that pings each configured / authed provider with a minimal request and reports green / red + latency + error per provider. Catches OAuth-class bugs proactively. Default `aiden doctor` is unchanged (fast config check, ~2 s).
- **Provider error bodies surfaced** — `ProviderError` constructor now composes the upstream response body (OpenAI / Anthropic-style JSON `error.message`, plain text, or truncated) into the surfaced error message. No more opaque "request failed (400)" with no detail.

### Known issue

- `aiden doctor --providers` shows ChatGPT Plus as red even when real chat works. The diagnostic's no-tools probe triggers a Codex backend edge case (requires non-empty tools field). Real chatgpt-plus chat in the REPL is unaffected. Probe payload will be refined in v4.1.2.

### Upgrade

```bash
npm install -g aiden-runtime@4.1.1
```

Or rebuild from source:

```bash
git pull && npm install -g .
```

---

## v4.1.0 — 2026-05-09 · Multi-channel autonomous AI engine

Headline release after 22 ship phases. Aiden becomes a multi-surface
agent: Telegram channel (text/voice/photo/PDF/groups/admin), MCP
server (24 tools + 72 skills exposed to Claude Desktop), parallel
subagent fanout, REPL voice mode, hardened cron, auto-mined skills,
structured markdown rendering, cross-platform CI matrix, and a deep
REPL polish layer (custom @inquirer/core prompt, autosuggest,
sectioned boot card, sharp ASCII corners, theme detection).

### Added

- **Telegram channel**: text, voice (Whisper), photos with caption,
  PDFs, group mentions, admin controls, file uploads, vision chain,
  outbound dedup. `/channel telegram` slash command + 409 takeover.
- **MCP server**: `aiden mcp serve` exposes the full 24-tool +
  72-skill surface over stdio for Claude Desktop and other MCP
  hosts. Auto-loads `.env` in serve mode.
- **Subagent fanout**: parallel agent execution via `Promise.all`
  with cloned fallback adapter, mutex primitive, rotation across
  groq/together. Wired into `buildAgentRuntime` for real provider
  execution.
- **Voice CLI**: PTT + continuous modes, sentence-stream TTS, RMS
  VAD, hallucination filter. Provider/voice persistence via .env.
- **Hardened cron**: `proper-lockfile` state lock, hybrid tick
  (per-job setTimeout + 60s heartbeat), adaptive grace window
  (`min(period/2, 7200s)` floored 120s), skip-not-replay,
  advance-before-execute, inactivity timeout, atomic schema
  migration v0→v1.
- **Skill mining**: auto-extract skills from successful workflows
  with staged review queue.
- **REPL polish layer**:
  - Custom @inquirer/core prompt with autosuggest + dropdown
  - Paste compression with disk-backed expansion
  - Sectioned boot card (environment + capabilities)
  - Responsive tables, sharp ASCII corners (┌┐└┘)
  - Custom Aiden spinner
  - Visual identity: orange accent, ▲ prompt, turn separators
- **4-state approval ladder**: Once / Session / Always / Deny
- **`{!cmd}` inline shell interpolation** in user input
- **Resize ghost cleanup** on terminal resize
- **Theme detection** (auto light/dark)
- **Structured markdown rendering** with marked-terminal v7,
  syntax highlighting, citation footer, streaming stable-prefix
- **Cross-platform CI matrix**: Linux / macOS / Windows × Node
  20/22, audio backend detection (winmm/afplay/sox/aplay/paplay),
  case-insensitive skill loader, doctor checks per OS

### Changed

- Identity scrub: all third-party reference names replaced.
- Day-one test suite: 37 vitest failures triaged into FIX (5) +
  DEFER (10 files marked `it.skip` with `TODO v4.1.1`).

### Build fingerprints (latest per surface)

| Surface | Fingerprint |
|---|---|
| `AIDEN_MCP_BUILD` | `v4.1-mcp.2` |
| `AIDEN_SUBAGENT_BUILD` | `v4.1-subagent.2` |
| `AIDEN_VOICE_CLI_BUILD` | `v4.1-voice-cli` |
| `AIDEN_CRON_BUILD` | `v4.1-cron` |
| `AIDEN_UI_BUILD` | `v4.1-tier3-essentials` |
| `AIDEN_SKILL_MINING_BUILD` | `v4.1-skill-mining` |
| `AIDEN_REPLY_FORMAT_BUILD` | `v4.1-reply-formatting` |
| `AIDEN_CROSS_PLATFORM_BUILD` | `v4.1-cross-platform` |
| `AIDEN_PRESHIP_BUILD` | `v4.1-preship-cleanup` |

### Tests

1561 passed · 39 skipped · 0 failed.

### Deferred to v4.1.1

10 test files marked `it.skip` / `describe.skip` with `TODO v4.1.1`:

- Plugin tests (pluginLoader, pluginPermissionStates, pluginsCommand,
  playSongLoop) — vitest ESM dynamic-import callback limit; production
  code works fine.
- `auth/claudeProRegistration` — hits a deprecated registration module.
- `cli/chatSession`, `cli/aidenCLI`, `cli/aidenCLI.moatBoot` — parallel
  load timing flakes; pass in isolation.
- `skills/mediaSearchSkill` — retired skill shape.
- `cli/doctorCommand` — deprecated harness.

Plus the v4.1-subagent wrapping pass deferred to `v4.1-subagent-cleanup`.

---

## v4.1.0 phase log (22 commits squashed into this release)

The original phase commits were preserved on `main`. Per-phase
detail below for the curious.

Channel coverage expansion. Telegram had been advertised in v3 docs
but never properly wired; v4.1 brings it back as a first-class
`ChannelAdapter` alongside the existing eight, with the same memory
isolation and gateway routing.

### Phase v4.1-cron — hardened cron (2026-05-09)

The legacy `core/cronManager.ts` was a per-job `setTimeout` chain
with last-writer-wins on `cron_jobs.json`. Two `aiden` processes
running concurrently could clobber each other's state, sleep
catch-up was uncapped (post-laptop-resume thundering herd risk),
and a single corrupted JSON byte left the user with no scheduled
jobs. This phase ports prior multi-agent systems' hard-won
hardenings into a clean-room v4 implementation while preserving
backward compat for every existing slash command + tool caller.

**Architecture: hybrid tick.** Per-job `setTimeout` for sub-
second precision (existing behaviour), PLUS a 60s heartbeat
that re-reads state under file lock + re-arms changed jobs.
Lock acquired non-blocking (retries=0); contended ticks log
"skipped: lock held" and increment the diagnostics counter.

**File lock.** `proper-lockfile` (already in node_modules,
promoted to direct dep) at `<state>.lock`. Whole-cron-state
granularity. Stale-lock detection via mtime + PID. Auto-release
on process exit. Multi-process clobber is now impossible — two
aiden CLIs racing each other queue at the lock.

**Adaptive grace window.** `min(period/2, 7200s)` floored at
120s — daily jobs catch up if missed by up to 2h, sub-hourly
jobs fast-forward quickly. **Skip-not-replay**: when overdue
beyond grace, advance `nextRun` to the next future occurrence
and skip THIS firing entirely. "One missed run lost; no
thundering-herd risk."

**Advance-before-execute** under lock (`cronExecute.ts`).
Persist the next-fire timestamp BEFORE dispatching the action.
Process death mid-action → restart sees the already-advanced
nextRun and waits — no double-fire. Hard-won lesson: "missing
one run is far better than firing dozens of times in a crash
loop."

**Inactivity timeout.** Per-fire wall-clock deadline (default
600s, env `AIDEN_CRON_TIMEOUT_MS`). `Promise.race` against the
action; on timeout, mark `last_status="timeout"` and SIGTERM
the spawned shell child (with SIGKILL backstop after 2s for
shells that ignore SIGTERM).

**State="error" + enabled=true** when next-fire un-computable.
Croner hiccup or malformed schedule → set state="error", keep
enabled=true so the user sees it in `/cron status`. Don't
silently disable.

**Empty-output → warn.** An action that returns ok=true with
ZERO output bytes is a soft failure. `last_status="warn"`.

**Schema migration v1 → v2 (auto, on first read).** v1 was a
bare array; v2 is `{ schemaVersion: 2, updatedAt, jobs: [...] }`.
First read detects the array shape, in-memory migrates,
prints one stderr line: `v4.1-cron: migrated cron_jobs.json
schema v1 → v2`. On-disk rewrite happens lazily on next mutation.

**Auto-repair on JSON corruption.** Strict parse → trailing-
comma strip retry → rename to `.bak.<ts>` + start empty +
stderr warning. A single corrupt byte never wipes the user's
job registry silently.

**Symlink-aware atomicWrite.** `fs.realpath` resolution before
rename catches the edge case where `cron_jobs.json` is symlinked
to a network share — naive rename would have detached the link.

**`last_delivery_error` field added.** Separate from `lastError`,
tracks errors that happened AFTER the agent step (e.g.
delivery to a channel). Future-proofs the schema for the
delivery layer without a second migration.

**Pause/resume semantics.** `pauseJob(id, reason?)` records
`pausedAt` + `pausedReason`. `resumeJob` clears both AND
recomputes `nextRun` from now — don't carry forward stale
next-run after a long pause.

**No retry on failure.** Honored prior systems' rejection of
retries: recurring jobs naturally retry on schedule, one-shot
retries hide bugs. The dispatch's preliminary "exponential
backoff, max 3" was overridden by recon evidence.

**Public surface preserved** via `core/cronManager.ts` shim:
all existing v3 callers (cli/v4/commands/cron.ts,
core/toolRegistry.ts) keep working without source change.
Sync wrappers + an in-memory cache make `listJobs()`,
`getJob()`, `createJob()`, `pauseJob()`, etc. callable
synchronously while the new async variants
(`listJobsAsync`, `createJobAsync`, etc.) provide
up-to-the-millisecond accuracy for new code.

**New CLI surface**: `aiden cron status | list | run <id>`
(parity with mcp / subagent / voice). Distinct from `/cron`
slash command for scripting + non-interactive sanity checks.
Slash-command `/cron status` extended INLINE (no separate
`/cron diagnostics`) with: fingerprint, schema version, tick
interval, fire timeout, heartbeat state, skipped-tick count,
fires-since-boot count, lock state, last 5 fires.

**`defaultRunAction` rewritten.** Old code reached into v3
`core/toolRegistry::executeTool('shell_exec', ...)`; v3 module
import is too heavy for a CLI fanout (60s+ stalls on slim CLI
runtime). Now uses `child_process.exec` directly with
AbortSignal-driven SIGTERM/SIGKILL teardown. Faster, lighter,
honours cancellation cleanly.

**Build fingerprint** `AIDEN_CRON_BUILD = 'v4.1-cron'`
exposed in `aiden cron status` and the heartbeat tracker.

**Smoke v4.1-cron.ts (offline)** — 28 checks (A–R):
A lockfile non-blocking acquire, B v1→v2 migration,
C auto-repair on corrupt JSON, D symlink-aware rename,
E grace-window math, F skip-not-replay verdicts, G heartbeat
re-arms, H heartbeat skip on lock-held, I advance-before-
execute, J timeout enforcement, K empty-output → warn,
L state="error" + enabled=true, M pause records pausedAt +
pausedReason, N resume recomputes nextRun, O lastDeliveryError
field present, P NO retry on failure, Q build fingerprint,
R attribution sweep clean.

**Smoke v4.1-cron-runtime.ts (built artifact)** —
8 checks: R0 build mtime, R1 status + fingerprint, R2 list,
R3 live trigger end-to-end, R4 status fields rendered, R5
bogus action exit, R6 lock path resolved, R7 v1 bare-array
migration on cold start.

**Verification**: 407 checks across 20 smokes, all green
(371 prior + 36 new — 28 offline + 8 runtime).

### Phase v4.1-voice-cli — voice mode in CLI (2026-05-09)

Voice input + voice output in the Aiden REPL. Reuses the v4.1-3
Whisper STT chain (Groq → OpenAI → local) + the existing 4-provider
TTS chain (VoxCPM → Edge TTS → ElevenLabs → SAPI), with a new
streaming wrapper for sentence-by-sentence playback.

**Piece 0 — pre-fixes that had to land first**:

- **`core/voice/audio.ts` Windows playback.** Old code hard-coded
  `Start-Sleep -Seconds 10`, cutting off any TTS reply > 10 s. Now
  polls `MediaPlayer.NaturalDuration` (up to 5s wait for the async
  `Open` to populate it), then sleeps the actual duration capped at
  5 minutes. Fallback to 10s when NaturalDuration never resolves
  (codec issues, streaming sources).

- **`core/voice/tts.ts` Edge TTS escaping.** Inline-escape pattern
  was fragile for text with both `'` and `"` plus backticks /
  `${...}` (which break the JS template literal generating the
  Python script). Replaced with a UTF-8 text file the Python script
  reads — zero escaping concerns. Both file paths + voice id pass
  through `JSON.stringify` (JSON ⊂ Python string syntax).

**New module surface**:

- `core/v4/voice/audioStream.ts` (~370 LOC) — lazy-loaded mic
  capture with two-tier fallback. Tier 1: `decibri` (Rust/cpal via
  napi-rs, prebuilt Win/mac/Linux). Tier 2: `node-record-lpcm16` +
  `sox` shell-out. Both as `optionalDependencies` so install never
  fails on prebuild misses. Emits 16-kHz / mono / int16 PCM frames
  with per-frame RMS for VAD. Idle 5-min auto-close mirrors
  `playwrightBridge`. `computeRms` + `computePeakRms` helpers
  exposed.

- `core/v4/voice/cliVoice.ts` (~430 LOC) — PTT + continuous-mode
  state machines. Tuned VAD constants: `SILENCE_RMS_THRESHOLD=200`,
  `SILENCE_DURATION_SECONDS=3.0`, `MIN_SPEECH_DURATION_SECONDS=0.3`
  (mic-click filter), `DIP_TOLERANCE_SECONDS=0.3` (natural micro-
  pauses), `PEAK_RMS_REJECT_THRESHOLD=400` (rejects "no speech"
  recordings whose mean RMS is dragged down by silence),
  `MAX_WAIT_NO_SPEECH_SECONDS=15.0`. Continuous mode auto-stops
  after `CONTINUOUS_NO_SPEECH_LIMIT=3` consecutive silent cycles.
  Hallucination filter — same patterns as v4.1-3 Telegram voice
  (`thank you`, `subscribe`, `subtitles by`, `amara.org`, etc.).
  `_ttsPlaying` flag + 0.3 s post-TTS sleep prevents the live mic
  from feedback-looping on the agent's spoken reply. Pure
  orchestrator — `audioFactory` + `transcribeFn` injected for tests.

- `core/v4/voice/ttsStream.ts` (~210 LOC) — sentence-buffer
  streaming wrapper. `SENTENCE_BOUNDARY_RE` matches `.!?:;。！？`
  followed by whitespace (decimal-safe — `3.14` doesn't trigger).
  `<think>...</think>` strip mid-stream handles tags split across
  delta boundaries. `AbortSignal` + sequential dispatch chain —
  cancellation halts new synth calls, in-flight playback settles
  in the background.

- `core/v4/voice/diagnostics.ts` — `AIDEN_VOICE_CLI_BUILD =
  'v4.1-voice-cli'`, `readVoiceConfig()` env reader, `collectVoice
  Diagnostics()` for status / doctor output.

- `cli/v4/voicePromptApi.ts` — wraps `ChatPromptApi` with raw-mode
  spacebar toggle. Hard refuses activation when `!process.stdin.
  isTTY` (the MCP-stdio invariant — raw mode would corrupt JSON-RPC
  frames). Toggle model: Space starts, Space again stops, Esc
  cancels. Stdin keypress doesn't emit keyup events on Node, so
  hold-Space PTT is unreliable; toggle is the deterministic UX.

- `cli/v4/voiceCli.ts` — `aiden voice <action>` Commander
  subcommand. Three actions: `doctor` (mic + TTS chain
  diagnostics, no mic open), `tts "<text>"` (one-shot synth+play,
  real provider call), `transcribe <file>` (one-shot STT against
  any audio file).

- `cli/v4/commands/voice.ts` — `/voice` slash command. Subcommands:
  `on | off | toggle | status | mode push|continuous |
  provider <name> | voice <id>`. Persists state to user's
  `.aiden/.env` via atomic tmp+rename pattern (mirrors `/channel`).

- `cli/v4/display.ts` — new `voiceIndicator(state, rms?)` helper.
  RMS-driven block bar (`▌▌▌▌`) at 12 chars wide, 0..1500 RMS
  range. States: `idle | listening | recording | transcribing |
  speaking`.

**Locked decisions** (per dispatch):
- PTT: Space toggle (Space starts, Space/Esc stops)
- Mic: decibri primary + node-record-lpcm16 + sox fallback
- TTS streaming: yes, sentence-buffer pattern
- CLI surface: `aiden voice {doctor | tts <text> | transcribe <file>}`
- MCP exposure: **DEFERRED** — voice tools NOT exposed via MCP this
  phase (R6 in runtime smoke verifies this)
- Continuous mode: off by default
- Audible beeps: off by default (`AIDEN_VOICE_BEEPS=1` to enable)
- TTS voice: pin `en-US-AriaNeural` default

**Smoke v4.1-voice-cli.ts (offline)** — 24 checks: A audioStream RMS
math, B PTT state machine, C continuous-loop 3-cycle stop,
D hallucination filter, E sustained-speech filter (mic-click reject),
F peak-RMS reject of silent recording, G sentence-boundary split
(decimal-safe), H `<think>` strip across chunks, I AbortSignal
cancellation, J TTY guard, K diagnostics fields + voice indicator,
L env config persistence, M build fingerprint, N attribution sweep.

**Smoke v4.1-voice-cli-runtime.ts (built artifact)** — 7 checks:
R0 mtime freshness, R1 `voice doctor` exit 0 + fingerprint,
R2 mic-backend + TTS-providers blocks rendered, R3 `voice tts`
graceful, R4 `voice transcribe` graceful, R5 bogus action exits
non-zero, **R6 voice tools NOT exposed via MCP** (the MCP
isolation invariant the dispatch locked).

**Build fingerprint** `AIDEN_VOICE_CLI_BUILD = 'v4.1-voice-cli'`
surfaced in `aiden voice doctor`, `/voice status`, and the per-
session config snapshot.

**Verification**: 371 checks across 18 smokes, all green
(340 prior + 31 new — 24 offline + 7 runtime).

**Deferred to v4.1-voice-cli.1**: chatSession integration
(VoicePromptApi swap + agent-turn TTS hook). The infrastructure
ships; wiring it into the live REPL needs additional plumbing
(promptApi swap conditional on `/voice on` state, mid-turn TTS
streaming hook, signal handler hygiene for Ctrl+C). Standalone
smokes (offline + runtime) verify the orchestrator + CLI surface
without REPL coupling, so the REPL integration is a focused
follow-up.

### Phase v4.1-subagent.2 — wire real fanout factory into MCP serve (2026-05-08)

Confirmed via logs: prior MCP boots produced the `mcp launched
build=v4.1-mcp.2` line but ZERO `subagent_fanout: wired` lines.
That's the smoking gun — `cli/v4/commands/mcp.ts::buildMcpRuntime`
registered `subagent_fanout` only via `registerReadOnlyTools` (the
v4.1-subagent stub from `tools/v4/index.ts`), and never replaced
it with a real factory. The CLI path has `buildAgentRuntime` doing
the replacement; MCP didn't. Calls from Claude Desktop hit the
stub and returned "no providers configured" instantly.

**Fix.** `buildMcpRuntime` now calls `wireSubagentFanout` after
`registerAllTools` + env load. The wire function:

  1. Loads `config.yaml` (defaults to `groq` /
     `llama-3.3-70b-versatile` when missing — matches CLI default).
  2. Constructs `CredentialResolver` + `RuntimeResolver` and
     resolves the active adapter. Soft-fail: when credentials are
     missing, leave the stub in place (the `mcp status` provider-
     keys block tells the user what to fix).
  3. When the active provider is `groq`/`together` chat-completions,
     wraps the resolved adapter in a `FallbackAdapter` so subagent
     rotation gets a real multi-slot list. Slot construction is
     inlined as `buildMcpFallbackSlots` (mirror of
     `buildAgentFallbackSlots` in `aidenCLI.ts`) to avoid a load-
     time module cycle.
  4. Calls `registry.register(makeSubagentFanoutTool({...}))` with
     real `runChild` / `resolveProviders` / `resolveActiveModel` /
     `aggregatorAdapter` closures — same shape as `buildAgentRuntime`.

`runChild` mirrors the CLI version: fresh `AidenAgent` per child,
shared `paths`/`skillLoader`/`memoryManager`, own cloned
`FallbackAdapter` (rate-limit state isolated), filtered tool
surface (`mutates: false` default; `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1`
opt-in), recursive fanout disallowed (depth=1), lean child system
prompt (no full SOUL.md — same v4.1-subagent.1 lesson).

`approvalEngine` intentionally undefined: N children competing for
one stdin REPL deadlocks under MCP. (No human at the REPL anyway.)

Logs the wired-line on every MCP boot:
`[subagent] subagent_fanout: wired (replaces stub) [mcp serve]
{ providerId, modelId, fallback }` — visible in
`<localAppData>/aiden/logs/aiden-mcp.log`. Spawning clients
(Claude Desktop, Cursor) capture the stderr stream too.

**Smoke v4.1-subagent.2-mcp.ts (NEW, post-build).** Spawns
`aiden mcp serve` as a child, drives JSON-RPC over stdio
(initialize → notifications/initialized → tools/list →
tools/call). Sections:
- M0. dist artifact fresher than every subagent + mcp source
- M1. server responds to `initialize` within 30s
- M2. `tools/list` includes `subagent_fanout` (count 24)
- M3. **the missing log line is present on this boot** —
  `[subagent] subagent_fanout: wired (replaces stub) [mcp serve]`
  — the exact signature absent from prior boots
- M4. `tools/call subagent_fanout` returns a real result, no
  "no providers configured" / "not wired" — gated behind
  `AIDEN_SUBAGENT_LIVE_SMOKE=1` (it actually hits providers)

This smoke closes the contract gap that let v4.1-subagent.1 ship
without exercising the MCP code path. Future fanout regressions on
the MCP side fail loud at M3 the moment they're built.

**Build fingerprint** bumped to `AIDEN_SUBAGENT_BUILD = 'v4.1-subagent.2'`.

**Verification.** 340 checks across 16 smokes, all green
(336 prior + 4 new from M0-M3, M4 gated).

**Side benefit.** Every provider-using tool exposed via MCP
(`web_search`, `fetch_url`, `deep_research`, `subagent_fanout`,
…) now has a real, working provider adapter. Claude Desktop /
Cursor / Claude Code users get the full Aiden surface out of box,
not a degraded read-only view.

### Phase v4.1-mcp.2 — auto-load .env in MCP serve mode (2026-05-08)

When Claude Desktop / Cursor / Claude Code spawn `aiden mcp serve`
over stdio, they pass an EMPTY env block by default. Without an
explicit `env: {...}` per-server entry in their config JSON, the
spawned aiden process has no `GROQ_API_KEY`, `GEMINI_API_KEY`, etc.
Provider-using tools (`subagent_fanout`, `web_search`, `fetch_url`,
…) failed with "no providers configured — run aiden setup first".
CLI fanout worked because it inherited the user's shell env; MCP
didn't.

**Fix.** `cli/v4/commands/mcp.ts::buildMcpRuntime` now eagerly loads
`.env` from a small list of well-known locations BEFORE the registry
is built (so tool factories that read env at registration time see
live values):

  1. `<aiden_install_dir>/.env` — resolved via `resolveAidenInstallDir`,
     which walks up from `__dirname` looking for the `aiden-runtime`
     `package.json`. Project-local convenience for dev installs.
  2. `paths.envFile` — per-user, `~/.aiden/.env` (or platform-equivalent).

Both use `loadAidenEnvFile`'s fill-only semantics — any key already
in `process.env` (the user's shell, Windows User env) wins; file
values fill the gaps. Source attribution preserved via the existing
`envSources.ts` `EnvSource` map (`'preset'` vs `'aiden-env'`).

**`mcp status` extended.** New "provider keys" block lists every
key in `KNOWN_PROVIDER_KEYS` (groq, gemini, together, openrouter,
anthropic, openai, cerebras, nvidia, cohere) with a checkbox + source
tag (`(.env)` / `(preset)` / `(unset)`). **Values are NEVER logged
or printed** — only presence + source. Helps users diagnose
"why doesn't web_search work via Claude Desktop?" without exposing
secrets in logs.

**Logger.** `loadMcpEnvSources` returns a structured report (paths
attempted, keys applied per file). The mcp-stdio logger writes one
`mcp env: loaded <path>` line per attempt to file + stderr. Stdout
stays untouched (protocol channel sacred).

**Smoke v4.1-mcp.ts — Section N added** (5 checks):
- N1. `resolveAidenInstallDir` finds the package root
- N2. `loadMcpEnvSources` reads `aidenHomeEnv`, applies missing keys
- N3. fill-only — pre-existing `process.env` wins over file value
- N4. missing file → `exists: false`, no throw
- N5. `describeProviderKeys` returns presence/source only — never
  surfaces values (verified by absence of `value` / `apiKey` fields
  on returned records)

**Smoke v4.1-mcp-runtime.ts** updated: R1 now also asserts the
`provider keys: detected: N/M` line is present in `mcp status`
output, AND scans for accidental key-shaped strings (`AIza…` Google
prefix, `sk-…` OpenAI prefix) — neither must appear in stdout. R3
launch-line fingerprint bumped to `v4.1-mcp.2`.

**Build fingerprint** bumped to `AIDEN_MCP_BUILD = 'v4.1-mcp.2'`.

**Verification:** 336 checks across 15 smokes, all green (331
prior + 5 from Section N). Manual `node dist/cli/v4/aidenCLI.js
mcp status` confirms 5/9 keys detected from `.env` with no value
leakage.

**Side benefit.** This fix benefits ALL MCP-spawned tools, not
just subagent_fanout. Web search, file ops, every provider-
dependent tool now works out-of-box when Aiden is added to Claude
Desktop without users manually copying keys into the client config
JSON.

### Phase v4.1-subagent.1 — wire fanout into buildAgentRuntime (2026-05-08)

The 995deeff commit exposed `subagent_fanout` via MCP but left the
`execute()` path as a stub. Real calls failed with "tool not wired"
errors. Stub tools in production MCP surface = worse than not
shipping. This patch finishes the wiring.

**Wiring**

`cli/v4/aidenCLI.ts::buildAgentRuntime` now re-registers
`subagent_fanout` after `bootLogger` is declared, replacing the
stub from `registerReadOnlyTools`. The factory closure captures:
- `resolveActiveModel: () => ({ providerId, modelId })` — same
  `activeModelInfo` pattern used by Telegram in v4.1-4.1
- `aggregatorAdapter: adapter` — parent's adapter handles aggregator
  calls for vote / pick-best / combine merges
- `resolveProviders` — when adapter is `FallbackAdapter`, every
  key-present slot becomes a `ProviderOption`. Otherwise the active
  (providerId, modelId) is the single option. Round-robin runs over
  whichever list is bigger.
- `runChild` — builds a fresh `AidenAgent` per child, sharing the
  parent's registry / skillLoader / paths / memoryManager but with:
  * own `ToolContext` (no approval engine — N children deadlocking
    on one stdin REPL is the obvious failure mode)
  * own cloned `FallbackAdapter` (mutable rate-limit state isolated)
  * filtered tool surface (`mutates: false` only by default,
    `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1` opt-in)
  * `subagent_fanout` itself REMOVED from the child surface (depth=1)
  * NO promptBuilder — children get a brief `roleLine + Goal` system
    prompt instead of the parent's 5KB+ SOUL.md + skills inventory.
    Hard-learned: full prompt makes "say hi" take 38s of token
    generation. Lean prompt brings n=2 trivial fanout to ~11s.
    Parents pass the genuine context children need via
    `query` / `tasks[].context`.

**CLI live mode**

`cli/v4/commands/fanout.ts` now actually executes when called
without `--dry-run`. Lazy-loads `buildAgentRuntime`, extracts the
wired tool from the registry, dispatches one fanout call, prints
the merged output. Boot overhead is ~30-40s (skills + plugins +
provider resolution); the fanout itself runs in a few seconds.

**Smoke v4.1-subagent (offline) — Section J added**

Three new checks against the stub → wired replacement pattern:
- J1. stub registered after `registerAllTools`
- J2. stub.execute fails with "no providers configured" (confirms
  identity — its `resolveProviders` returns `[]`)
- J3. after `registry.register(makeSubagentFanoutTool({...real}))`,
  execute() runs the wired callbacks (no stub error)

**Smoke v4.1-subagent.1-runtime (NEW)**

R0-R3 always run: build mtime, fingerprint `v4.1-subagent.1`, MCP
exposure (24 tools), dry-run regression. R4-R8 (live providers)
gated behind `AIDEN_SUBAGENT_LIVE_SMOKE=1`. Reason: when Claude
Desktop's aiden MCP server is running concurrently, a fresh
`aiden fanout` CLI invocation contends with the running MCP
processes for the SQLite session DB and bundled-skills directory;
on Windows this stalls `buildAgentRuntime`. Manual live test
proved the wiring works end-to-end (~11s fanout, both children
returned non-empty text, real Groq + Together responses).

**Build fingerprint** bumped to `AIDEN_SUBAGENT_BUILD = 'v4.1-subagent.1'`.

**Verification**: 331 checks across 15 smokes, all green.

### Phase v4.1-subagent — parallel agent fanout (2026-05-08)

Spawn N parallel agent children against the same problem (ensemble
mode) or a partitioned task list (partition mode), then merge results
via a configurable strategy. Was a v3 feature (`spawn` / `spawn_subagent`
/ `swarm`) dropped in v4 for being "complexity without proportional
value" — three tool names, illusory isolation (same-process empty
history), illusory diversity (all N hit the same provider via the
global router), leaky cancellation (flag-only, in-flight HTTP calls
still completed). v4 ports the concepts cleanroom with the v3
lessons baked in.

**One tool name, two modes via a `mode` param:**
- `mode: 'ensemble'` — every child gets the same `query`. Use for
  multi-perspective research, provider-diverse fact-checking.
- `mode: 'partition'` — each child gets a different goal from
  `tasks[]`. Use for analyzing N independent inputs in parallel.

**Four merge strategies with explicit cost shapes** so the calling
LLM picks knowingly: `'all'` (raw N, FREE), `'vote'` (judge picks
one verbatim, +1 call), `'pick-best'` (judge picks one with
reasoning, +1 call), `'combine'` (LLM synthesizes one unified
answer, +1 call).

**Hard cap N=5** (default 3). Beyond that latency variance dominates
and provider RPM caps fire before the fanout completes. Per-child
timeout 90s default (`AIDEN_SUBAGENT_TIMEOUT_MS` override), outer
wall-clock cap 5× per-child timeout, fresh `max_iterations=20` per
child (no v3-style budget halving — that's what starved nested
spawns).

**Cancellation propagates to the network call.** Each child gets an
`AbortController.signal` derived from a parent signal + per-child
timeout; aborts cascade into the provider HTTP via the standard
`fetch` abort plumbing. v3's flag-only cancellation leaked tokens
because in-flight HTTP requests still completed in the background.

**Provider rotation built into the API from day one.** N children
round-robin across configured *providers* (not slots within one
provider). Single-provider fanout proceeds with a logged warning —
diversity reduces to temperature variation. v3's "N samples from
the same provider" was `temperature` with extra steps.

**Aggregator** uses parent's active model by default; env
`AIDEN_SUBAGENT_AGGREGATOR_MODEL=provider:model` overrides for
cost control.

**State isolation per child:**
- own session ID (UUID), own `AidenAgent` instance, own `ToolContext`
- own **cloned `FallbackAdapter`** — slot configs shared, mutable
  rate-limit state (slotState, cooldownUntil, requestCount,
  activeSlotId) reset. Adapters are stateless by spec, but
  FallbackAdapter is the documented exception; `.clone()` respects
  the invariant.
- shared (read-only) from parent: tool registry, skill loader,
  paths, memoryManager
- approval engine left undefined for child contexts (force `mode:
  'off'`) — N children competing for one stdin REPL would deadlock

**Mutating tools default-excluded from child surfaces.** Opt-in via
`AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1` (mirrors the MCP env pattern
shipped in v4.1-mcp). Predictable, env-driven.

**MCP exposure** — `subagent_fanout` is the 24th exposed tool (was
23 since v4.1-mcp). Marked `mutates: false` because the tool
itself only spends LLM tokens; child tool calls happen in isolated
contexts under the env gate.

**Browser mutex primitive shipped, integration deferred.**
`pwAcquire` / `withPwLock` / `pwQueueDepth` exposed from
`core/playwrightBridge.ts`. The 8 production browser tool wrappers
(browserClick, browserNavigate, etc.) are NOT yet wrapped — that's
parked as **v4.1-SUBAGENT-CLEANUP**: "Wire withPwLock into all 8
browser tool wrappers, add concurrent-browser-claim regression
smoke." Justification: regression risk vs. gain. The dispatch's
smoke verifies the primitive (queue, grant, release-on-throw)
directly. The collision case requires N parallel children using
the browser simultaneously — until live fanout flushes that out,
serializing the existing stable code is high-risk-low-gain. The
primitive being correct guarantees the wrapping works when it ships.

**The "Self-reports are not verified facts" warning** baked into
the tool's description — hard-learned lesson from prior multi-agent
systems: parents over-trust child summaries. The schema text tells
the calling LLM that children's claims about side-effects (file
writes, command runs, tool successes) MUST be verified
independently before the parent acts on them.

**Surface** — three CLI/REPL entry points sharing the same
orchestrator:
- Tool: `subagent_fanout` (callable from agent loop + MCP)
- CLI: `aiden subagent <action>` (status, tools — diagnostics)
- CLI: `aiden fanout "<query>" --n=3 --merge=combine [--dry-run]`
  (one-shot; `--dry-run` uses synthetic stubs for the runtime smoke)
- Build fingerprint `AIDEN_SUBAGENT_BUILD = 'v4.1-subagent'`
  surfaced in `aiden subagent status`

**Smoke v4.1-subagent:** 25 checks (offline) covering orchestrator
(spawn, abort cascade, timeout, FallbackAdapter clone), all four
merge strategies + env override, provider rotation (multi/single),
mutex queue/grant/release-on-throw, env gate for mutating tools,
schema validation, MCP exposure (count 23→24), build fingerprint,
attribution sweep.

**Smoke v4.1-subagent-runtime:** 6 checks against the BUILT artifact
(per the policy locked in at v4.1-mcp.1) — build mtime freshness
guard, status, tools, mcp tools count==24, fanout dry-run end-to-
end, unknown action exits non-zero.

**Regression** — v4.1 sweep: **324 checks across 14 smokes**, all
green (293 prior + 31 new).

### Phase v4.1-4.2 — telegram delivery-split coalesce + outbound dedup + failure-path caption preservation (2026-05-08)

Patch fixing the v4.1-4.1 live-test symptom: a single photo upload
produced TWO replies — the first an apology about being unable to
see images, the second the correct vision-described answer.

**Root cause** — Telegram delivery split. Some clients split a
single "send caption + photo" action into two updates: a text-only
message + a photo-with-matching-caption message, arriving ~1 ms
apart in the same poll batch. Both updates have distinct
`message_id` values, so the per-message dispatch dedup from
v4.1-3.1 correctly treated them as separate inbound messages.
Both got dispatched to the agent. The text message (orphaned
caption) had no image context, so the agent volunteered "I cannot
see images". Then the photo's vision pipeline finished and the
agent replied again with the correct description.

The fix is a SECOND layer of dedup keyed not on `message_id` but
on `(chat_id, normalized_text, time_window)` — coalesce on
receipt.

**Three layers ship together**

(a) **Coalesce-on-receipt** (the actual fix). New per-chat slot
`recentPhotoCaptions: Map<chatId, { caption, ts }>`. At the very
top of `handlePhotoMessage` and `handleDocumentMessage` (BEFORE
any await), the caption is recorded synchronously. The text
fall-through in `handleIncoming` (both DM and group paths) checks
the slot before dispatching: if a recent photo with matching
normalized caption is found, the text dispatch is suppressed.
Window: `TELEGRAM_PHOTO_COALESCE_MS` env (default 500 ms).

The timing works because Node's microtask scheduling lets the
photo handler's sync prelude run before the text handler's
microtask resumes — text arrives first, hits its first await
(`routeCommand` for "what image is this" is a sync-return Promise
which still queues a microtask), pauses, then the photo's
`handleIncoming` enters and `handlePhotoMessage`'s sync prelude
runs. By the time text's microtask resumes, the caption is in the
slot. **No setTimeout, no added latency to non-split text messages.**

(b) **Per-message outbound delivery dedup**. New
`repliedMessageIds` FIFO at the start of `deliverAgentReply` —
same shape as `recentMessageIds` from v4.1-3.1, but tracks
"already replied" rather than "already dispatched". Belt-and-
suspenders against any future regression that could double-fire
within process; logs `duplicate delivery suppressed` if it ever
triggers. The `deliverAgentReply` signature gained an optional
`msgIdForDedup` parameter; all media handlers now pass
`msg.message_id`.

(c) **Caption preservation on failure paths**. When vision /
extraction fails AND the user supplied a caption, the previous
implementation dropped the caption and only smuggled the failure
directive to the agent. Fix in three sites — `handlePhotoMessage`
failure path, `handleDocumentMessage` image-as-doc failure path,
`handleDocumentMessage` PDF-extraction failure path:

```ts
const baseAnnotation = `[The user sent a photo but description failed: ${reason}. ...]`
const annotation = caption ? `${baseAnnotation}\n\n${caption}` : baseAnnotation
```

The agent now sees what the user wanted to ask about even when
the media pipeline fails.

**Refactor**

`deliverAgentReply` signature added optional fourth parameter
`msgIdForDedup?: number`. All seven media-handler call sites
updated to pass `msg.message_id`. The text fall-through (both DM
and group) also passes it. The legacy `/clear` slash-command
internal call doesn't pass anything — that's intentional, dedup
only applies to user-inbound traffic.

**Build fingerprint** bumped to `v4.1-4.2`.

**New smoke `scripts/smoke-v4.1-4.2.ts` (7 checks, section H)**

- H1: photo + paired text-only with matching caption → ONE
  gateway call (photo wins, text suppressed). Suppression log
  fires. **The load-bearing assertion that catches this regression.**
- H2: photo + text-only with DIFFERENT text → TWO gateway calls
  (no false positive on the coalesce window).
- H3: text-only with no photo → ONE gateway call, no suppression.
- H4: photo on chatA + text on chatB with same content → TWO
  calls (per-chat isolation).
- H5: outbound dedup — direct double-invoke of
  `handlePhotoMessage` → second short-circuits at
  `deliverAgentReply` with `duplicate delivery suppressed` log.
- H6: failure-path caption preservation — agent annotation
  contains BOTH the failure directive AND the caption.
- H7: build fingerprint sanity.

**Smoke regressions fixed**

- `smoke-v4.1-1.ts:11` — attribution-sweep regex tightened with
  word boundaries so legitimate English words like "synchronously"
  don't false-positive.
- `smoke-v4.1-4.1.ts:E1` — fingerprint check relaxed to series
  pattern so it accepts v4.1-4.1, v4.1-4.2, v4.1-4.X without
  further edits.

**Verification**

- `scripts/smoke-v4.1-4.2.ts`: 7/7 green.
- All prior smokes still pass:
  smoke-v4.1-1 (38) + 1.1 (46) + 1.2 (23) + 1.3 (21) + 2 (37) +
  2.1 (8) + 3 (40) + 4 (38) + 4.1 (16) + this phase (7) =
  **274 self-smoke checks across the v4.1 sprint**.
- `tsc --noEmit` clean.
- Zero `console.*` in any code path.
- 100% Aiden attribution preserved across all touched files.

**Live test guidance**

After `npm run build` + restart:

```
1. Send photo with caption "what's in this image?"
2. Expect:
   - inbound update (msgId N) hasText:true            ← text update arrives
   - inbound update (msgId N+1) hasPhoto:true         ← photo arrives 1ms later
   - photo handler entered (msgId N+1)
   - text suppressed: matches recent photo caption    ← coalesce fires
   - downloading photo file
   - image analyzed { provider: "gemini", ... }
   - ONE outbound reply describing the image
3. NOT expect: two replies, "I cannot see images" preceding the description
```

If the suppression log doesn't fire and you still get two replies,
open `aiden.log` and check the time delta between the text
`inbound update` and the photo's `text suppressed` log line. If
delta > 500 ms (slow client), bump `TELEGRAM_PHOTO_COALESCE_MS`
in `.env`.

### Phase v4.1-4.1 — vision chain unification + active-model wiring (2026-05-08)

Patch fixing two bugs surfaced by v4.1-4's live test: photo
descriptions failed and the agent had to apologize. Root causes
were independent but landed together:

**Root cause 1 — active-model wire missing**

`cli/v4/aidenCLI.ts` constructs the Telegram adapter via
`channelManager.register(new TelegramAdapter())` with no options.
The `TelegramAdapterOptions.activeModelInfo` callback added in
v4.1-4 was never plumbed from CLI scope. Photo handler called
`this.activeModelInfo() ?? {}`, got an empty object, fell into
`'text'` mode, then handed off to a vision chain that didn't have
the right keys.

**Fix**: register site captures `providerId` + `modelId` from the
same scope `gateway.setProcessor` already uses, plus
`contextWindow` from `findModel(...)?.contextLength`. Two-line
change at the registration site + one new import.

**Root cause 2 — vision chain ignored authed providers**

`core/visionAnalyze.ts` only knew Anthropic / OpenAI / Ollama
llava. The user has GROQ_API_KEY / GEMINI_API_KEY /
OPENROUTER_API_KEY / TOGETHER_API_KEY all wired for chat — none of
which the vision path attempted. All three legacy providers
failed → "all providers exhausted" → photo description failed →
apology directive smuggled to agent → live-test failure.

**Fix**: extended chain to seven providers, free first:

```
1. Gemini       gemini-2.5-flash                                (GEMINI_API_KEY)
2. Groq         meta-llama/llama-4-maverick-17b-128e-instruct   (GROQ_API_KEY)
3. OpenRouter   meta-llama/llama-3.2-11b-vision-instruct:free   (OPENROUTER_API_KEY)
4. Together     meta-llama/Llama-Vision-Free                    (TOGETHER_API_KEY)
5. Anthropic    claude-3-5-sonnet-20241022                      (ANTHROPIC_API_KEY)
6. OpenAI       gpt-4o                                          (OPENAI_API_KEY)
7. Ollama       llava                                           (local, no key)
```

Each provider checks its env key first; missing key → skip without
network call. Failures (HTTP errors, timeouts, empty responses)
log warn at the channel-side logger and fall through. Three of the
four new providers serve OpenAI-compatible vision shapes (Groq,
OpenRouter, Together) so they share an internal helper. Gemini
gets its own helper (native `generateContent` with `inline_data`
parts). Anthropic + OpenAI + Ollama keep their existing shapes.

**Refactor**

`analyzeImage()` now accepts an optional `httpClient` parameter
(`VisionHttpClient` interface — minimal `post`/`get` surface).
Production wraps `axios` as before. The Phase-4.1 smoke injects
a recording fake to verify chain order + per-provider request
shapes without touching the network.

**Build fingerprint** bumped to `v4.1-4.1`.

**New smoke `scripts/smoke-v4.1-4.1.ts` (16 checks across 6 sections)**

- A: chain order — Gemini wins when all keys present; falls through
  on key-missing AND on HTTP failure; Anthropic fires only after
  free providers fail; all-exhausted throws.
- B: per-provider request shapes — Gemini's `inline_data`,
  OpenAI-compat `image_url(data:base64)`, Anthropic's
  `source.base64 + media_type`; OpenRouter and Together hit their
  documented endpoints with the documented model ids.
- C: missing-key short-circuits without a network call (only
  Ollama gets attempted because it's keyless).
- D: `TelegramAdapter.activeModelInfo` closure picks up runtime
  changes (`/model` switch); aidenCLI source asserts the
  registration-site wire.
- E: `TELEGRAM_ADAPTER_BUILD === 'v4.1-4.1'`.
- F: 100% Aiden attribution scan on all touched files.

**Smoke regressions fixed**

- `smoke-v4.1-1.1.ts:10b` — registration-site regex relaxed to
  match the multi-line constructor (now passing options).
- `smoke-v4.1-3.ts:G1a` — fingerprint format pattern already
  matched `v4.1-4.1`; no change needed.
- `smoke-v4.1-4.ts:I1` — assertion relaxed to "v4.1-4 series"
  pattern so v4.1-4, v4.1-4.1, v4.1-4.X all pass without further
  edits.

**Verification**

- `scripts/smoke-v4.1-4.1.ts`: 16/16 green.
- All prior smokes still pass:
  smoke-v4.1-1 (38) + 1.1 (46) + 1.2 (23) + 1.3 (21) + 2 (37) +
  2.1 (8) + 3 (40) + 4 (38) + this phase (16) = **267 self-smoke
  checks across the v4.1 sprint**.
- `tsc --noEmit` clean.
- Zero `console.*` in any code path.
- 100% Aiden attribution: case-insensitive scan returns zero on
  every file in this commit.

**Live test guidance**

After `npm run build` + restart, send a photo. Expect:

```
inbound update { hasPhoto: true, ... }
photo handler entered { isGroup: false, fileSize, ... }
downloading photo file { ... }
image analyzed { provider: "gemini", modelUsed: "gemini-2.5-flash", durationMs, descChars }
```

(or `provider: "groq"`, `"openrouter"`, etc. depending on key
availability and rate-limit state). Agent reply describes the
image instead of apologizing.

### Phase v4.1-4 — Telegram file uploads (PDF + image) (2026-05-08)

Inbound photos and documents for the Telegram channel. Reuses
`core/visionAnalyze.ts` (already shipped multi-provider vision
chain) and `core/fileIngestion.ts` (`pdf-parse`-backed PDF
extractor). New channel-side adapters carry the size caps,
mode-decision routing, and result shapes the Telegram adapter
needs. Same "smuggle into agent turn" pattern as voice — the
agent paraphrases naturally; no bot-side echo by default.

**Photos — model-aware routing**

The active model's `supportsVision` flag in
`providers/v4/modelCatalog.ts` decides:

- **`'native'`** — vision-capable model. The local cache path is
  smuggled into the user turn with a directive telling the agent
  loop to attach the pixels on the request:
  `[The user sent a photo. The local cache path is "...". The
  active model supports vision — attach the photo on the user turn.]`
- **`'text'`** — text-only model OR catalog lookup miss. The
  auxiliary vision chain (Anthropic claude-3-5-sonnet → OpenAI
  gpt-4o → Ollama llava) pre-analyzes the image and the
  description gets prepended:
  `[The user sent a photo. Description: ...]`

Lookup miss defaults to `'text'` — the auxiliary chain has its own
provider keys and works regardless of which model the user
selected for the agent loop.

**PDFs — pre-extract, token-budget, smuggle**

Inbound PDFs are extracted locally via `pdf-parse`, truncated to
`min(50K chars, (modelContextWindow - 8K) * 4 chars/token)`, and
spliced into the user turn:

```
[The user sent a PDF "<filename>". Extracted text:
<truncated content>
Note: PDF truncated to fit context. Original was N chars.]
```

The agent always sees content on the same turn — no defer-to-tool
friction. Scanned-image PDFs (no text layer) produce an empty
extraction and an apology directive instead.

**Image-as-document** (PNG / JPG / GIF / WEBP sent as a Telegram
file rather than via the photo flow) routes through the same
photo-vision pipeline so behaviour is identical regardless of how
the user attached the image.

**Modules**

- `core/visionAnalyze.ts` — surgical edit. Added optional `Logger`
  parameter to `analyzeImage(source, prompt, logger?)` defaulting
  to `noopLogger()` so the existing `vision_analyze` tool wrapper
  in `core/toolRegistry.ts` keeps working unchanged. Diagnostics
  now route through the v4.1-1.3a Logger contract.
- `core/channels/photo-vision.ts` (new, ~210 LOC) — channel-side
  photo adapter. 25 MB precheck, mode decision via
  `MODEL_CATALOG.findModel().supportsVision`, text-mode pre-analysis
  via `analyzeImage`, `PhotoResult` shape that the Telegram adapter
  branches on.
- `core/channels/pdf-extract.ts` (new, ~190 LOC) — channel-side
  PDF adapter. 20 MB precheck (matches Telegram getFile cap),
  truncation budget calculation, sentence-boundary slicing on the
  trailing 1 KB of the budget so the agent never sees mid-word
  truncation.
- `core/channels/telegram.ts` — `handlePhotoMessage` +
  `handleDocumentMessage` mirroring the voice handler shape;
  defensive secondary subscriptions `bot.on('photo')` +
  `bot.on('document')`; document MIME whitelist
  (pdf/png/jpg/jpeg/gif/webp); cache layout
  `<aiden_root>/cache/{photos,documents}/`; sanitized filename
  preservation in the document cache (`doc_<uuid12>_<name>`); cache
  janitor extended to sweep all three media subdirs on startup.
  Build fingerprint bumped to `v4.1-4`.
- `cli/v4/commands/channel.ts` — new `/channel telegram media
  status | enable | disable` subcommand. Atomic `.env` writes via
  the existing `upsertEnv` helper. Voice retains its own
  `/channel telegram voice` subcommand so operators can disable
  one without the other.
- `docs/channels/telegram.md` — photos + documents sections.

**Configuration — all optional, works out of the box**

Reuses existing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
Ollama; no new credentials required. Optional knob:

- `TELEGRAM_MEDIA_ENABLED` (default `true`) — master switch for
  photos + documents. Voice retains `TELEGRAM_VOICE_ENABLED`
  separately.

**New smoke `scripts/smoke-v4.1-4.ts` (38 checks across 9 sections)**

A: photo-vision unit (size cap, native/text mode, throw handling).
B: pdf-extract unit (size cap, extraction, truncation budget, empty
   text). C: visionAnalyze surgical edit (Logger wired, zero
   console.*). D: photo routing through gates (DM + group). E:
   document routing (PDF + image-as-doc + reject). F: cache janitor
   sweeping photos + documents subdirs. G: `/channel telegram media`
   CLI. H: real-event dispatch with `bot.on('photo')` and
   `bot.on('document')` defensive subs. I: build fingerprint
   `v4.1-4` + 100%-Aiden-attribution scan across all touched files.

**Verification**

- `scripts/smoke-v4.1-4.ts`: 38/38 green.
- All prior smokes still pass:
  smoke-v4.1-1 (38) + 1.1 (46) + 1.2 (23) + 1.3 (21) + 2 (37) +
  2.1 (8) + 3 (40) + this phase (38) = **251 self-smoke checks
  across the v4.1 sprint**.
- `tsc --noEmit` clean.
- Zero `console.*` in any code path.
- 100% Aiden attribution: case-insensitive cross-reference scan
  returns zero matches on every file in this commit.

### Phase v4.1-3.2 — allowed_updates defense + liveness logs + build fingerprint (2026-05-08)

Preventive patch on the heels of v4.1-3.1's live-test passing. Voice
worked once the user ran `npm run build` and restarted — the prior
silent-failure had been **stale `dist/` build**, not a code bug.
This phase adds three layers of defense so build-staleness is
diagnosable in seconds (one `grep` of the live log) and the
adapter's polling stack matches the defaults documented by the
Telegram Bot API for robust long-poll deployments.

**Three layers**

1. **`allowed_updates` defense.** Polling params now explicitly
   include `allowed_updates: []` (Telegram spec: empty list = "all
   default update types"). Matters because Telegram's getUpdates docs
   warn the field is **sticky across calls** — if any prior
   interaction with this bot's API token set a restrictive list (a
   stray webhook config, a debug script), that filter persists
   silently across restarts. Operators who need exotic update kinds
   like `chat_member` can override via `TELEGRAM_ALLOWED_UPDATES`
   (CSV); unknown values are dropped against a whitelist of
   Telegram's documented update types.

2. **Liveness logs that survive a stale-binary scenario.** Three
   new info logs anchored at startup-critical points:
   - `polling launched` fires AFTER client construction, BEFORE
     `getMe`. Carries `{ fingerprint, interval, timeout,
     allowedUpdates }`. If this doesn't appear in the log,
     `start()` failed before polling launched.
   - `polling getMe ok` fires after `getMe` succeeds. If
     "launched" appears but "getMe ok" doesn't, getMe is hanging
     (auth fail / network / DNS).
   - `polling first inbound` is a sentinel — fires once per
     adapter lifecycle on the first message dispatched, regardless
     of content type. If the first two appear but this never does,
     polling is alive in the SDK sense but no messages are reaching
     us — likely a server-side filter, sticky `allowed_updates`,
     or a Telegram throttle.

3. **`TELEGRAM_ADAPTER_BUILD` fingerprint constant.** Bumped per
   phase. Surfaced in the `polling launched` log AND in
   `getDiagnostics()` (so `/channel telegram status` can publish
   it later). Live-test workflow going forward:

   ```
   user: npm run build
   user: restart aiden
   user: tail aiden.log | grep "polling launched"
        → { fingerprint: "v4.1-3.2", ... }
   user: confirms fingerprint == expected phase before testing
   ```

   Today's fingerprint: `v4.1-3.2`. The smoke statically asserts
   the format `v4.1-X[.Y]+`.

**Refactor**

`TelegramAdapterOptions.clientFactory` (test seam): a function that
constructs the bot client. Production leaves it unset and we build
a real `TelegramBotApi`; smokes inject a fake `EventEmitter`-backed
client so Section G can drive `start()` end-to-end (including the
allowed_updates wiring + liveness-log ordering) without a real
polling loop or network round-trip.

**New smoke section G (9 checks)**

- `G1a` — `TELEGRAM_ADAPTER_BUILD` matches the `v4.1-X[.Y]+` regex.
- `G1b` — source asserts `allowed_updates` is wired into the polling
  params construction (catches future regressions where someone
  drops the line).
- `G1c` — source asserts the fingerprint is referenced inside the
  "polling launched" log.
- `G2a` — `start()` invokes `clientFactory` with
  `polling.params.allowed_updates: []` by default.
- `G2b` — "polling launched" log fires with the expected ctx
  fields (fingerprint + interval + timeout + allowedUpdates).
- `G2c` — "polling launched" fires **before** "polling getMe ok"
  in the record stream.
- `G2d` — `getDiagnostics()` surfaces `buildFingerprint` +
  `pollingParams` for the CLI.
- `G2e` — `TELEGRAM_ALLOWED_UPDATES=message,callback_query,bogus_type,chat_member`
  yields `['message','callback_query','chat_member']` (bogus
  dropped against the whitelist).
- `G3` — "polling first inbound" sentinel fires exactly once when
  two messages arrive back-to-back.

**Going-forward policy**

Every phase from v4.1-3.2 onward bumps `TELEGRAM_ADAPTER_BUILD` and
the smoke's expected-fingerprint check. User runs `npm run build`,
restarts, greps the live log for `polling launched`, confirms
`fingerprint == expected phase`. If mismatch → stale binary, run
build again. Saves the multi-hour silent-failure debugging loop
v4.1-3 surfaced.

**Verification**

- `scripts/smoke-v4.1-3.ts`: 40/40 green (was 31, added 9 in section G).
- All prior smokes still pass:
  smoke-v4.1-1 (38) + 1.1 (46) + 1.2 (23) + 1.3 (21) + 2 (37) +
  2.1 (8) + this phase (40) = **213 self-smoke checks across the
  v4.1 sprint**.
- `tsc --noEmit` clean.
- Zero `console.*` in any code path.

### Phase v4.1-3.1 — voice path instrumentation + defensive subscriptions (2026-05-08)

Patch fixing the bug surfaced by the v4.1-3 live test: voice DMs to
the bot were silently dropped — `/channel telegram status` showed
`lastMessageAt` updating (so the adapter received the update from
Telegram) but no `whisper.*`, no `voice.*`, no error log, no agent
reply. Pure black hole.

**Root cause analysis**

`/channel telegram status` updating + zero downstream logs proved
that `handleIncoming`'s opening line (`lastMessageAt = Date.now()`)
ran but everything after silently bailed. The voice path between
`lastMessageAt` and the first explicit log call was an observability
desert — five distinct early-return sites with no `logInfo` calls,
including the `if (!text && !caption && !hasVoice && !hasAudio)
return` guard that drops on unrecognized message shapes.

The smoke didn't catch this because every voice check called
`handleIncoming` directly with a hand-built voice payload, bypassing
the actual `bot.on('message')` event-dispatch path. **Same shape of
contract gap as Phase v4.1-2.1's "smoke stubbed the integration seam
that turned out to be the bug."**

**Fix — five layered changes**

1. **Shape fingerprint at the dispatch boundary.** New info log at
   the top of `handleIncoming`: `chatType, hasText, hasCaption,
   hasVoice, hasAudio, hasPhoto, hasDocument, hasVideoNote, hasSticker,
   isReply, isBot, messageId`. Pure shape — no payload contents. The
   live log now answers "what fields did NTBA actually populate?"
   immediately on every inbound update.

2. **Voice handler entry log.** New info log at the top of
   `handleVoiceMessage`: `isAudio, isGroup, fileSize, hasCaption,
   chatId`. If this fires, dispatch made it through every gate; if
   it doesn't fire, the silent drop is upstream.

3. **Download starting log.** New info log at the top of
   `downloadVoiceToCache`: `fileIdPrefix, ext, outPath`. Distinguishes
   "hung mid-download" from "never tried."

4. **Defensive secondary subscriptions.** New `bot.on('voice', ...)`
   and `bot.on('audio', ...)` registered alongside the primary
   `bot.on('message', ...)`. NTBA emits both for media attachments,
   but the secondaries make the bot resilient if a future lib version
   ever stops firing 'message' for some media type. Idempotency
   enforced by a 256-entry FIFO of `${chat_id}:${message_id}` keys
   (`markMessageSeen`) so the same payload from both events is
   processed exactly once.

5. **Soft-relax the empty-message guard.** When `handleIncoming` hits
   `!text && !caption && !hasVoice && !hasAudio`, it now logs
   `dropped: unrecognized message shape` with the message's field
   keys before returning. So a future Telegram update kind we don't
   handle (`video_note`, `document` with audio MIME, anything new)
   shows up loudly in the log instead of being silently swallowed.

**Refactor**

Extracted the message-event wiring out of `start()` into a new
`protected wireMessageHandlers()` method. The smoke can now drive
the same code path with a stub `EventEmitter`-backed bot — no real
polling loop required. This is what closes the contract gap.

**New smoke section F**

`scripts/smoke-v4.1-3.ts` Section F (4 checks):

- `F1` — fake `EventEmitter` bot fires `'message'` with a voice
  payload → end-to-end through real `bot.on()` wiring →
  `handleIncoming` → `transcribeFn` → smuggled annotation lands
  on `gateway.routeMessage`.
- `F2` — fake bot fires `'voice'` only (no `'message'`) → defensive
  secondary subscription catches it → same end-to-end success.
- `F2b` — fake bot fires both `'message'` AND `'voice'` for the same
  payload (NTBA's normal path) → dedup ensures exactly one transcribe
  call.
- `F3` — fake bot fires `'message'` carrying only `video_note` →
  drop logged with shape keys, no transcribe, no agent call.

**Verification**

- `scripts/smoke-v4.1-3.ts`: 31/31 green (was 27, added 4 in section F).
- All prior smokes still pass:
  smoke-v4.1-1 (38) + 1.1 (46) + 1.2 (23) + 1.3 (21) + 2 (37) +
  2.1 (8) + this phase (31) = **204 self-smoke checks across the
  v4.1 sprint**.
- `tsc --noEmit` clean.
- Zero `console.*` in any code path (only in legacy comment strings).

**Live test guidance**

After restart, send a voice DM. The log should now carry, in order:

1. `inbound update { hasVoice: true, ... }` — proves dispatch reached us.
2. `voice handler entered { ... }` — proves we passed every gate.
3. `downloading voice file { fileIdPrefix: ..., outPath: ... }`
4. `whisper.stt.groq whisper transcribed { snippet, durationMs, confidence }`

If voice now flows through to a reply, success. If it stops at a
specific log line, that line pinpoints the gate where it's dying —
e.g. "voice handler entered" but no "downloading voice file" means
the size cap or `isVoiceEnabled` rejected it; "downloading voice
file" but no "whisper.stt..." means `getFileStream` is hanging or
returning empty.

### Phase v4.1-3 — Telegram voice notes via Whisper chain (2026-05-08)

Inbound voice messages and audio files for the Telegram channel.
Reuses the existing `core/voice/stt.ts` Whisper provider chain (Groq
→ OpenAI → local Whisper.cpp) with a thin channel-side adapter layer
that handles the pieces specific to a messaging UX: 25 MB size cap,
Whisper-hallucination filter, confidence-based echo, and the
"smuggle the transcript into the agent's user turn" pattern.

**UX — hybrid silent/echo, smuggle into agent turn**

- Confident transcript (`avg_logprob` ≥ −0.5): silent. The agent
  receives `[The user sent a voice message. Transcript: "X"]` as the
  user turn and answers naturally; no echo.
- Low-confidence transcript: bot first sends `🎤 _heard:_ "X"`, then
  the agent answers. User can correct if needed.
- Failure / hallucination: agent sees a directive annotation —
  `[The user sent a voice message but transcription failed: <reason>.
  Apologize briefly and ask them to type the message instead.]` — and
  composes the apology in its own voice.
- Voice + caption: transcript and caption concatenated on a single
  user turn so the agent sees both.

**Gates run BEFORE getFile()** — saves bandwidth on dropped messages.
Order: allowlist → rate-limit → command-route (text only) → pause →
user-allow → mention → download → transcribe. Voice in groups is
gated by either a `@bot_username` mention in the caption (via
`caption_entities`) or a reply-to-bot.

**Modules**

- `core/voice/stt.ts` — surgical edit. Switched Groq + OpenAI to
  `response_format: 'verbose_json'`, added `meanAvgLogprob` helper
  to surface segment-level confidence on `SttResult.confidence`,
  replaced all four `console.*` calls with the v4.1-1.3a `Logger`
  contract (defaults to `noopLogger` so legacy callers stay quiet).
- `core/channels/whisper-transcribe.ts` (new, ~170 LOC) — channel-
  side adapter. Owns the 25 MB precheck, the hallucination regex
  (`thank you for watching` / `subtitles by` / `amara.org` /
  `sous-titrage` / `¡subtítulos por` / empty), and the
  `TranscriptionResult` shape that maps `confidence` → `avgLogprob`.
- `core/channels/telegram.ts` — voice/audio path in
  `handleIncoming`, `handleVoiceMessage` orchestrator, NTBA
  `getFileStream` → cache-write helper, voice diagnostics accessor.
  Cache lives at `<aiden_root>/cache/audio/audio_<uuid12>.{ogg,mp3}`.
- `cli/v4/commands/channel.ts` — new `/channel telegram voice
  status | enable | disable` subcommand. Atomic `.env` writes via
  the existing `upsertEnv` helper.

**Cache janitor — startup only, no timer**

If the cache dir is over 500 MB at adapter start, files older than
7 days get unlinked. No background timer in v4.1-3; deferred to
v4.2's TTL system. The smoke verifies both the cleanup-on-trigger
path AND the leave-alone-when-under-threshold path.

**Configuration — all optional, works out of the box**

Reuses existing `GROQ_API_KEY` / `OPENAI_API_KEY`; no new credentials
required. Optional knobs:

- `TELEGRAM_VOICE_ENABLED` (default `true`)
- `TELEGRAM_VOICE_CONFIDENCE_THRESHOLD` (default `-0.5`)
- `TELEGRAM_VOICE_LANGUAGE` (default unset = auto-detect; set to
  `hi` / `mr` etc. if Whisper auto-detect drifts on Indic input)

**New smoke**

`scripts/smoke-v4.1-3.ts` (27 checks across 5 sections — A: whisper-
transcribe module in isolation; B: stt.ts verbose_json wiring static
audit; C: TelegramAdapter voice routing through every gate;
D: cache janitor on/under threshold; E: `/channel telegram voice`
CLI subcommand). All checks green. The transcribe function is
injected via a new `TelegramAdapterOptions.transcribe` test seam so
the smoke runs offline — no real Groq calls.

**Verification**

- `scripts/smoke-v4.1-3.ts`: 27/27 green.
- All prior smokes still pass:
  smoke-v4.1-1 (38) + 1.1 (46) + 1.2 (23) + 1.3 (21) + 2 (37) +
  2.1 (8) + this phase (27) = **200 self-smoke checks across the
  v4.1 sprint**.
- Vitest baseline holds at 19 failed / 1571 passed / 10 skipped —
  no new failures intersect with telegram / voice / whisper /
  channel / stt code paths.
- `tsc --noEmit` clean.

### Phase v4.1-2.1 — wire gateway processor in CLI boot (2026-05-08)

Patch fixing the bug surfaced by the v4.1-2 live test: every Telegram
inbound message was hitting the friendly fallback "Something went
wrong. Try again." because `gateway.routeMessage` had no processor
registered.

**Root cause**

Phase v4.1-1.1 moved channel-adapter hosting into the CLI process so
`aiden serve` is no longer required for Telegram to work. But the
gateway-processor wiring stayed exclusively in `api/server.ts:6116`
— so when the CLI hosts the adapter, every inbound message threw
`No message processor registered`.

**Why prior smokes missed it**

`smoke-v4.1-1.ts` and `smoke-v4.1-2.ts` both stub `gateway.routeMessage`
directly to capture payloads, bypassing the processor codepath
entirely. The smokes verified "did the adapter call routeMessage with
the right shape" but not "does routeMessage actually run end-to-end
against a real registered processor."

**Fix**

`cli/v4/aidenCLI.ts` `buildAgentRuntime` now calls `gateway.setProcessor`
right after the agent is constructed, with a closure that:
- Resolves a `SessionStore` session per `(channel, channelId)`,
  caching the gateway → store sessionId mapping in-memory.
- Loads past user/assistant turns via `store.getMessages` and appends
  the new inbound as a user message.
- Runs one `agent.runConversation()` turn against that history.
- Persists the new tail via `sessionManager.recordTurn` so the next
  inbound resumes seamlessly.

Errors route through the v4.1-1.3a Logger contract (no console.*).
The same pattern as the API server's processor (also goes through
`agent` → answer), but invokes the agent directly instead of an
HTTP hop through Express.

**New smoke**

`scripts/smoke-v4.1-2.1.ts` (8 checks) plugs the contract gap:
- A1: confirms the original bug signature — unregistered processor
  throws `"No message processor registered"`.
- A2/A3: with a wired stub processor, `gateway.routeMessage` returns
  the closure's reply and the closure was actually invoked.
- B1/B2: end-to-end DM through the REAL gateway (no mocks of
  `routeMessage`), stubbed agent's reply lands back in the chat
  via `sendMessage`.
- C1-C3: static wiring check on `cli/v4/aidenCLI.ts` — confirms
  `gateway.setProcessor`, `agent.runConversation`, and
  `sessionManager.recordTurn` are all present in the source.

**Verified**

All prior smokes still green (230 unit checks across the v4.1
surface); typecheck + build clean; vitest baseline holds at
17 failed / 1552 passed (Phase 30 baseline).

### Phase v4.1-2 — Telegram groups + mentions + admin controls (2026-05-08)

Unlocks the group surface for the Telegram channel, with safe defaults
(mention-only, per-user rate limits, owner-only admin commands, prompt-
injection wrap) so a bot dropped into a noisy chat can't burn quota or
leak memory across rooms.

**Added**

- `core/channels/telegram-rate-limit.ts` — sliding-window per-user
  throttle. Default 5 messages / 60 s (env-tunable). Single keyspace
  across DMs and all groups so a spammer can't dodge by hopping
  rooms. Stale buckets pruned every 5 minutes.
- `core/channels/telegram-groups.ts` — persistent per-group state
  (`paused`, `allowedUsers`, cached title, `lastMessageAt`). Persists
  to `<aidenRoot>/state/telegram-groups.json` with atomic writes
  and 1-second debounced flushes. Loaded once at adapter start.
- `core/channels/telegram-commands.ts` — slash-command router with
  admin gate. `/help`, `/status`, `/clear`, `/pause`, `/resume`,
  `/allowusers`. Owner = `TELEGRAM_OWNER_ID`; optional escalation
  via `TELEGRAM_ADMIN_USERS` (CSV) or — when
  `TELEGRAM_TRUST_GROUP_ADMINS=true` — Telegram-side group admins.
  Non-admin admin-command attempts are silent-ignored (don't leak
  the admin list).
- Group routing in `core/channels/telegram.ts` — allowlist gate
  (`TELEGRAM_ALLOWED_GROUPS`), mention-only by default
  (override via `TELEGRAM_GROUPS_RESPOND_ALL=true`), reply-to-bot
  accepted as address. Slash commands route BEFORE the pause gate
  so `/resume` works when the group is paused.
- Prompt-injection defence-in-depth — group messages are wrapped in
  a `<message from="..." group="...">...</message>` envelope before
  reaching the agent. The model sees user content as quoted user
  payload, not as a system override; XML attributes are escaped to
  prevent envelope-closing tricks.
- `/channel telegram allowlist {list,add,remove}` and
  `/channel telegram groups {list,pause,resume}` slash commands —
  manage groups from inside the REPL without leaving the chat.
- Docs (`docs/channels/telegram.md`) — full group setup, env knobs,
  admin commands, persistence behaviour.

**Changed**

- The Phase 1 group refusal stub (`replyToGroup`) is retired.
- `TelegramAdapter.handleIncoming` rebuilt for the group path —
  rate-limit → observe → command-route → pause-gate → user-allowlist
  → mention-gate → strip-mention → wrap → deliver. Per-group memory
  isolation comes for free from the gateway's `(channel, channelId)`
  session keying.

**Verified**

- `smoke-v4.1-2.ts`: **37/37 ✓** — rate limiter, group store,
  command router, adapter routing (allowlist / mention / reply /
  rate-limit / pause / resume / per-group isolation / injection
  wrap), CLI subcommands, hygiene sweep (zero console.*, 100%
  Aiden attribution).
- All prior smokes still pass: 35 + 57 + 38 + 46 + 23 + 21 = 220
  + 37 (this phase) = **257 self-smoke checks across the v4.1
  surface**.
- vitest baseline: **16 failed / 1553 passed** — 1 better than the
  Phase 30 baseline (the help-test consolidation fix from v4.1-1.1
  carries through).

### Phase v4.1-1.3a — clean-room logger foundation + REPL fix (2026-05-08)

Replaced direct `console.*` writes with a unified `Logger` contract
across the channel layer. The CLI's chat REPL is now sacred: in
`cli-interactive` mode the boot logger has zero stdout sinks, so a
misbehaving module cannot corrupt the chat prompt. Diagnostics route
to `<aidenRoot>/logs/aiden.log`; warnings + errors also surface on
stderr (visible to the user, separate from chat stdout).

**Added**

- `core/v4/logger/` — interface (`Logger`), root impl (`CoreLogger`),
  factory (`createBootLogger`), 5 sinks (`File`, `Stderr`,
  `StdoutJson`, `Null`, `Memory`, `Multi`). Mode-aware factory
  picks the right composition per `AidenMode`:
  - `cli-interactive` — file + stderr (warn+); zero stdout.
  - `cli-headless` — file + stderr (warn+); stdout free for tool output.
  - `serve` — NDJSON stdout for log aggregators + file mirror.
  - `test` — `NullSink` by default; `withMemory: true` exposes
    a `MemorySink` for assertions.

**Changed**

- `core/gateway.ts` — singleton gains `attachLogger()`; route /
  register / deliver events route through the injected logger.
  Pre-attach calls drop silently via `noopLogger`.
- `core/channels/manager.ts` — accepts `{ logger }` constructor option
  and exposes `attachLogger()` for retroactive injection. On
  `register(adapter)` the manager calls `adapter.attachLogger(child)`
  with a scoped sub-logger (e.g. `channels.telegram`).
- All 9 channel adapters (`discord`, `slack`, `whatsapp`, `email`,
  `webhook`, `twilio`, `imessage`, `signal`, `telegram`) — every
  `console.*` replaced with `this.log.*`. Adapters default to
  `noopLogger` so unattached construction is silent.
- `cli/v4/aidenCLI.ts` — wires `createBootLogger({ mode:
  'cli-interactive' })`; passes scoped child loggers to gateway +
  ChannelManager. Removed the per-module `createFileLogger` for
  Telegram in favour of the unified system.
- `api/server.ts` — same wiring, but `mode: 'serve'` so daemon logs
  emit as NDJSON to stdout (systemd / docker friendly) with file
  mirror.

**Verified**

- 4 self-smokes total green (38 + 46 + 23 + 21 = 128 checks).
- vitest baseline holds at 17 failed / 1552 passed (no regressions).
- Live boot: stdout post-prompt is empty; the only chatter is a
  legitimate stderr warn (Telegram 409 Conflict) which the new logger
  routes correctly without touching the chat prompt.

**Deferred to v4.1-1.3b / v4.1-1.3c**

- ~85 remaining files in `core/`, `providers/`, `cli/v4/`, `api/`
  with `console.*` calls (rarely-fired error paths + boot-time-only
  status; not REPL pollution sources).
- ESLint rule banning bare `console.*` outside the allow-list.

### Phase v4.1-1 — Telegram adapter foundation (2026-05-08)

**Added**

- `core/channels/telegram.ts` — `TelegramAdapter` implementing the
  shared `ChannelAdapter` contract. Long-poll mode, DM-only, plain
  text in / Markdown out, 4 096-char chunked replies preferring
  newline / space split points. Optional `TELEGRAM_ALLOWED_CHATS`
  allowlist. Per-chat memory isolation hangs off the gateway's
  existing `(channel, channelId)` session keying.
- In-chat slash commands routed before the agent loop:
  `/help` / `/start`, `/status`, `/clear`. The bot also publishes
  these via `setMyCommands` so they appear in Telegram's `/`
  autocomplete menu.
- Token redaction — every error message the adapter emits is run
  through a scrubber that replaces the bot token with `[redacted]`
  before reaching the console. Defends against the single biggest
  credential-leak risk on this surface.
- Boot-card `channels` pill in the CLI Environment block — counts
  channel adapters whose credential env var is present in the
  process. Honest naming: "configured", not "active", because the
  CLI process doesn't actually run the channel manager (that lives
  in the API server).
- `docs/channels/telegram.md` walkthrough covering BotFather setup,
  env-var configuration, per-chat memory behaviour, rate limits,
  and troubleshooting.

**Changed**

- `api/server.ts` — replaced the legacy 50-line raw-fetch Telegram
  startup block with a single `channelManager.register(new
  TelegramAdapter())`. Behaviour parity preserved via a back-compat
  bridge that promotes a YAML-configured `telegram.botToken` into
  `process.env.TELEGRAM_BOT_TOKEN` if the env var isn't already set,
  so users who configured Telegram via the dashboard before this
  migration keep working.
- README badges + status line: 8 channels → 9.

**Deferred to Phase 2**

- Group / supergroup messages (current behaviour: one-line refusal,
  no spam).
- Voice notes, photos, file uploads, inline mode, callback queries.
- Webhook mode (long-poll-only for now).
- Live config reload from the dashboard's `/settings/telegram`
  endpoint — config still saves to YAML but requires a server
  restart to take effect.

**Dependencies**

- `node-telegram-bot-api` `0.67.0` (pinned, no `^` / `~`).
- `@types/node-telegram-bot-api` `0.64.14` (pinned, dev-only).

---

## v4.0.2 — 2026-05-07 · UX patch (setup wizard + explore mode)

First-impression bug fix release. A user reinstalling Aiden from
scratch saw the boot card with a placeholder model name and got a
"provider chatgpt-plus rate limited" error on their first chat
because the resolver auto-picked a provider that wasn't actually
authed. Phase 30.2 + 30.2.1 rebuild the fresh-user path so the
wizard fires reliably, the boot card never lies, and a user who
fat-fingers their key three times has five recoverable paths
instead of a dead-end exit.

### Fixed

- **Fresh-user setup wizard now auto-triggers** when no provider
  is configured. New `core/v4/firstRun/providerDetection.ts`
  module probes env vars, OAuth tokens at `<aiden-home>/auth/`,
  Ollama on `localhost:11434`, and inline `providers.<id>.apiKey`
  in `config.yaml` — all in under 100 ms. The boot path fires the
  wizard if any of: nothing detected, configured provider has no
  matching credentials, or `config.yaml` is fresh.
- **Boot card no longer shows a placeholder model** when no
  provider is authed. `Display.statusPillsRow` now accepts an
  optional `providerOk` flag; when false the model pill renders
  "not configured" with a muted dot instead of the
  DEFAULT_CONFIG fallback ("gpt-5.3-codex" was the v4.0.1 surprise).

### Added

- **Wizard recovery menu** after 3 failed key-validation attempts.
  Replaces the prior dead-end `throw new Error('3 attempts')`
  with five recoverable paths:
    - `[1]` Try a different provider — loops back to the picker
    - `[2]` Get a key from `<provider URL>` — opens the browser
      (Windows `cmd /c start ""`, macOS `open`, Linux `xdg-open`)
      and re-prompts for 3 fresh attempts
    - `[3]` Save without validation — writes config; key tested
      on first chat
    - `[4]` Skip — explore Aiden first (REPL boots without a
      provider; chat is gated, slash commands work)
    - `[5]` Exit (try again later) — clean exit
  Same menu fires when the OAuth confirm prompt is declined or
  when Ollama is unreachable.
- **Explore mode** — wizard returns one of three statuses:
  `'configured' | 'skipped' | 'exited'`. On `'skipped'` the boot
  path uses a `NullAdapter` (`providers/v4/nullAdapter.ts`) so
  `AidenAgent` constructs cleanly; `ChatSession.runAgentTurn`
  short-circuits any non-slash input with a friendly redirect
  to `/setup`. `/help`, `/skills`, `/providers`, `/tools`,
  `/setup`, `/auth`, `/quit` all work with no provider authed.
- **`/setup` slash command** to re-launch the wizard from inside
  an active REPL. After saving, prompts the user to restart Aiden
  so the new provider is picked up (hot-swap is v4.1).
- **`install.ps1` `[0/4]` step** detects existing installations
  in `$env:APPDATA\aiden`, `$env:LOCALAPPDATA\aiden`, and
  `npm list -g aiden-runtime`. Offers `[1]` Fresh install (wipes
  config + npm uninstalls), `[2]` Update only (npm install -g
  upgrades in place), or `[3]` Cancel. Non-interactive sessions
  default to update-only (the safer non-destructive path).
- **`install.ps1` honest progress feedback** during npm install.
  Uses `Write-Progress` with `-PercentComplete -1` (indeterminate
  spinner) and updates the Status line on each visible npm output
  line. Parses `added N packages` for a real count. Zero fake
  percentages; `-Completed` clears the bar at exit.

### Changed

- **Groq is now the recommended default provider** (replacing
  Together AI). Free tier, fastest signup, no surprise charges
  for first-time users. Provider list reordered to surface free
  tiers first:
    1. Groq (free, fast)
    2. Google Gemini (free)
    3. OpenRouter (free credits)
    4. NVIDIA NIM (free)
    5. Ollama (offline)
    6. Anthropic (paid)
    7. OpenAI (paid)
    8. Together AI (paid)
    9. Claude Pro subscription
    10. ChatGPT Plus subscription
- **Plain-English provider descriptions.** "TPM cap" →
  "limited messages per minute"; "tier 1 paid" → "best for
  complex tasks"; "Ollama (Local, no internet)" → "fully
  offline, no key needed (requires Ollama install)". After
  the provider is picked, subsequent prompts (model picker,
  API-key input) use a short label ("Groq") instead of
  restating the full description.
- **`isFreshInstall`-only wizard gate replaced** with the
  multi-signal `detectAvailableProviders` check. Closes the
  scenario where a stale `chatgpt-plus` config + missing
  OAuth token file would silently reach the resolver and
  surface as a confusing rate-limit error on the user's
  first chat.

### Test impact

- 4 wizard test files updated for new provider order, new
  `status` field, and the recovery-menu replacing the
  3-attempt throw: `setupWizard.test.ts`,
  `setupWizard.validation.test.ts`, `setupWizardOAuth.test.ts`,
  `commands.test.ts`.
- New self-smokes: `scripts/smoke-30.2.ts` (35 unit checks),
  `scripts/smoke-30.2.1.ts` (57 unit checks),
  `scripts/smoke-30.2-live.ts` (6 live boot checks against a
  tempdir `AIDEN_HOME`).
- vitest baseline unchanged: 17 failed / 1552 passed (same as
  Phase 30 diagnosis — pre-existing test-runner / content drift,
  documented in `docs/sprint/_internal/ci-diagnosis.md`).

### Files

- New: `core/v4/firstRun/providerDetection.ts`,
  `providers/v4/nullAdapter.ts`, `cli/v4/commands/setup.ts`,
  `installer/aiden-releases-install.ps1`.
- Edited: `cli/v4/aidenCLI.ts`, `cli/v4/setupWizard.ts`,
  `cli/v4/chatSession.ts`, `cli/v4/display.ts`,
  `cli/v4/commands/index.ts`.

---

## v4.0.1 — 2026-05-07 · security patch

Security patch covering 15 Dependabot alerts (10 high, 5 medium, 0
critical) plus the secret-scanning audit done in tandem.

### Dependency bumps

- **axios** `^1.13.5` → `^1.15.2` — fixes prototype pollution gadgets
  in HTTP adapter (high) and invisible JSON tampering via `parseReviver`
  (medium).
- **multer** `^1.4.5-lts.2` → `^2.1.1` — fixes 6 separate DoS CVEs
  (uncontrolled recursion, incomplete cleanup, resource exhaustion,
  unhandled exception × 2, memory leak from unclosed streams). All
  high. Major version bump verified against Aiden's call sites
  (`api/server.ts:445-467` — `diskStorage` + standard `fileFilter`,
  no API changes needed).
- **@types/multer** `^1.4.12` → `^2.0.0` — match runtime.

### Transitive overrides

`package.json` `overrides` block to force-resolve vulnerable
transitives without waiting for upstream packages to bump:

- `basic-ftp` → `^5.3.1` (high — DoS via unbounded multiline buffer)
- `ip-address` → `^10.1.1` (medium — XSS in HTML-emitting methods)
- `semver` → `^7.5.2` (high — RegEx DoS)
- `postcss` → `^8.5.10` (medium — XSS in CSS Stringify)
- `hono` → `^4.12.16` (medium — bodyLimit bypass + JSX HTML injection)
- `minimatch` → `^9.0.9` (pin: v10 changed default-export to
  named-only, broke `permissionSystem.ts` and `toolRegistry.ts`).

### Source changes

- `core/permissionSystem.ts` and `core/toolRegistry.ts` switched from
  `import minimatch from 'minimatch'` to
  `import { minimatch } from 'minimatch'` for forward-compat with
  minimatch v9+ and v10+ (named export is stable across both).
- `package.json` `build:cli` and `build:api` scripts add
  `--external:@aws-sdk/client-s3` so esbuild ignores the optional
  unzipper transitive that's only required when fetching ZIPs from
  S3 (Aiden doesn't).

### Secret-scanning resolutions

- Alert #1, #2 (Google API Keys in WhatsApp web cache files) — `wont_fix`.
  Keys are Google's own (Firebase / Maps) embedded in WhatsApp's web
  client; cached by Chromium service worker via `whatsapp-web.js`.
  Cache directory removed from main; only reachable via `v3.11-final`
  tag history.
- Alert #3 (Tenor API key in `skills/gif-search/SKILL.md`) — `revoked`.
  Key was already removed from current `main` in v3 commit `56b56b29`;
  v4.0.0 npm tarball does not contain the leaked key. Key rotated in
  Google Cloud Console.
- Alert #4 (`native-modules/ssh2/test/fixtures/id_rsa`) — `used_in_tests`.
  Public test fixture from upstream `ssh2` library; not exploitable.

### Test infrastructure

- `tests/v4/license/publishConfig.test.ts` updated to match Phase
  28.4.1's prepublishOnly contract (typecheck + build, no test —
  tests run in CI on tag push and manually via `npm test`).

---

## v4.0.0 — 2026-05-07 · "REWRITE"

A from-scratch rewrite of Aiden's core. Every provider adapter, prompt
builder, OAuth flow, and agent loop has been rewritten under full
Aiden copyright (no dual attribution). Visual polish lands as a
sectioned, neofetch-style boot card.

### Core rewrite

- 🧠 **Single-loop agent** (`core/v4/aidenAgent.ts`) — sequential tool
  dispatch, 90-turn cap with caution at 70 % and warning at 90 %,
  empty-response retry guard (cap 1), skill-enforcement tracker
  (cap 2), URL-provenance tracker (cap 2), memory dirty-bit
  invalidation, post-loop honesty enforcement, SkillTeacher tier-3
  propose / tier-4 auto.
- 🔌 **Provider rewrite** — `providers/v4/` adapters for Anthropic
  (`/v1/messages`), OpenAI Chat Completions, OpenAI Responses (Codex
  backend), and Ollama prompt-tools, all clean-room with full Aiden
  copyright. Wire-format parity with the upstream APIs (system block
  arrays, `mcp_` tool prefix on OAuth, identity sanitisation,
  three-stage SSE recovery, `claude-cli` user agent).
- 🛡 **Provider fallback** — 6-slot self-healing chain
  (`together → together-fallback → groq × 4`) with cooldown +
  least-used selection. Sub-second slot advancement on rate-limit.
- 🔒 **OAuth subscriptions** — Claude Pro PKCE copy-paste flow and
  ChatGPT Plus device-code flow route to subscription quota instead
  of pay-as-you-go. Per-provider tokens stored at
  `<aiden-home>/auth/<provider>.json`.
- 🧱 **Prompt builder rewrite** — 8-slot fixed composition (SOUL.md →
  personality → memory → user → skills → llama-hint → budget →
  environment) with consistent rule glyphs and frame-deduped
  identity blocks.

### New features

- 🕒 **Cron scheduler** — `/cron add|list|pause|resume|delete|run`
  with the `croner` engine, atomic state writes, output capture, and
  5/6-field cron + `@daily`/`@hourly` shortcodes.
- 🤖 **Inline JSON tool-call recovery** — open-source models (Llama,
  NVIDIA-Llama, Qwen) sometimes emit raw JSON in answer text instead
  of using the tool slot. The chat-completions adapter detects these,
  validates the name against the request's tool list, and dispatches
  as a proper tool call. Code-fenced examples are left alone.
- 🎨 **Neofetch boot card** — banner + tagline + four status pills
  (core / mode / model / memory) + Environment + Capabilities
  two-column block + parchment credits footer + bottom prompt hint.
  Auto-detects OS (Windows 11 / macOS Sonoma / Linux distro) and
  shell (`PowerShell + WSL2` / `bash` / `zsh` / …).
- 🎙 **Spinner phrases** — 20-entry rotating pool (Thinking · Brewing
  · Cogitating · Brain yakka · Conjuring · …) sampled once per turn.
- 🪶 **Env-gated polish** — `AIDEN_UI_ICONS=1` for emoji tool-row
  icons, `AIDEN_UI_TIMESTAMPS=1` for HH:MM:SS line prefix.
- 📋 **Per-turn rule separator** — single muted rule between turns,
  `▲` user prompt prefix, `┃ Aiden` single-line assistant header
  (parity between streaming and non-streaming).

### Tools and skills

- 🧰 **42 built-in tools across 11 categories** — web (6), files (7),
  browser via Playwright (10), sessions (2), skills (4), memory (3),
  process (5), system (3), terminal (1), code (1), MCP (1).
- 📚 **68 bundled skills** — clean SKILL.md format, manifest-driven
  restore, security pre-write scan, opt-in skill-teacher proposals.

### Channel adapters

- 📡 **8 channels working**: Discord, Slack, WhatsApp, Email
  (IMAP+SMTP), Webhook, Twilio SMS, iMessage (macOS), Signal. Single
  agent loop, multiple front doors.

### Plugins

- 🔌 **3 bundled plugins**: Chrome DevTools Protocol bridge
  (`aiden-plugin-cdp-browser`), Claude Pro OAuth, ChatGPT Plus
  OAuth. Plugin loader with permission-state machine.

### Security moat (10 modules)

- ✅ Tiered approval engine (safe / caution / dangerous)
- ✅ Dangerous-command pattern classifier
- ✅ Honesty enforcement (post-loop scan + rewrite)
- ✅ Memory guard (rejects unverified writes)
- ✅ Planner-guard tool narrowing
- ✅ SSRF-safe URL fetcher
- ✅ Tirith pre-write secret/PII scanner
- ✅ Skill-teacher tier-3 propose / tier-4 auto
- ✅ Pro-license gate
- ✅ Provider-chain glue

### Breaking changes from v3.x

- `aiden-os` npm package renamed to `aiden-runtime`. Existing global
  installs need `npm uninstall -g aiden-os && npm install -g aiden-runtime`.
- Slash commands consolidated. v3 commands like `/switch`, `/budget`,
  `/memory`, `/profile`, `/permissions` are gone — use `/model`,
  `/usage`, `/identity` respectively. See `/help` for the v4 list.
- Subagent fanout removed (was a parallel-fanout branch in v3). v4
  is single-loop only; subagent support deferred.
- Skill registry install changed — auto-fetch from external repos
  held pending license review. Skills install via `/skills install
  <local-path-or-url>` only at v4.0.

---

## v3.13.0 — 2026-04-27

**Community & Ecosystem**
- 📦 **Public skill registry** — `aiden install <skill>` pulls skills from the community registry at [skills.taracod.com](https://skills.taracod.com). Browse with `/skills registry <query>`. Publish your own with `/publish <skill>`.

**Intelligence**
- 🧠 **Deep GEPA — failure learning** — Aiden now learns from failures, not just successes. When you say "that's wrong" or type `/failed`, it analyzes the full exchange trace, writes a permanent lesson to `LESSONS.md`, and degrades the responsible skill's confidence score. Skills that fail 3+ times are automatically deprecated.
- 👤 **Honcho user modeling** — Aiden maintains a structured profile of you across sessions: identity, projects, goals, preferences, relationships, and skills. Built automatically from distilled session facts. Only the relevant slice is injected per query (zero prompt bloat). View and edit with `/profile`.

**Security**
- 🐳 **Docker sandbox backend** — opt-in sandboxed execution for `shell_exec` and `run_python` tools. Set `AIDEN_SANDBOX_MODE=auto` in `.env` or toggle live with `/sandbox auto|strict|off`. Containers run with `--network=none --memory=512m --cpus=1 --read-only --tmpfs /tmp`. Requires Docker Desktop.
- 🔒 **GitHub CI/CD** — automated TypeScript type-check + full build on every PR to main. CODEOWNERS enforces owner review on `api/server.ts`, `core/agentLoop.ts`, `core/toolRegistry.ts`, `SOUL.md`, and `cloudflare-worker/`. Security scan detects accidentally committed API keys.
- 💝 **Sponsor button** — support Aiden development via [Razorpay](https://razorpay.me/@taracod).

---

## v3.12.0 — 2026-04-26

**Memory**
- 🧠 **Post-task skill writer (GEPA-lite)** — after every multi-step success, Aiden writes a new skill encoding what it just learned
- 🗄️ **Session-end memory distillation** — 5–15 durable facts extracted at end of each session and stored in the user profile

**Agent loop**
- ⚡ **Progressive token budget** — tool names loaded immediately; full schemas pulled on demand; significantly reduces context overhead
- 🔀 **Real parallel subagents** — each subagent gets isolated context; results merged via a dedicated LLM synthesis pass
- 💬 **Streaming verbs** — "Pondering…", "Hunting…", "Reasoning…" shown in real time during long operations

**Skills & tools**
- ⏰ **Real scheduler** — `remind me in N minutes` actually waits the correct duration via OS timer
- 🌐 **Path C-lite browser chain** — YouTube / Google / DDG / Bing search; clicks first result automatically
- 🔄 **Electron auto-updater** — background download + restart prompt; `/refresh` to force-check
- 🤝 **Identity honesty** — Aiden is transparent about which inference provider is answering
- 🔁 **Capacity fallback** — auto-switches provider on 503 / rate-limit without user intervention

---

## v3.7.1 — 2026-04-21

**Patch release.** Four desktop stability fixes identified after v3.7.0 shipped.

### Bug Fixes

- **fix(desktop):** BrowserWindow URL changed from `localhost:3000` to
  `127.0.0.1:3000` — Windows 11 22H2+ resolves `localhost` to IPv6 `::1` while
  the dashboard server binds IPv4 only, causing a black screen on every launch
- **fix(desktop):** Port 3000 is now freed before `startDashboard()` — a stale
  dashboard process from a previous session held the port, crashing the app with
  `EADDRINUSE` on the second launch
- **fix(desktop):** API server spawn `cwd` changed from `USER_DATA` (AppData) to
  the DevOS repo root — skills, `.env`, and `SOUL.md` were resolved relative to
  AppData instead of the project directory, resulting in 0 skills loaded in
  Electron mode
- **fix(dashboard):** Static assets (CSS / JS / fonts) now copied into the
  Next.js standalone tree via a `postbuild` npm hook — the standalone server
  served HTML but every `/_next/static/*` request returned 404

---

## v3.7.0 — 2026-04-18

**The Desktop-Primary release.** Desktop app is now the primary Aiden experience.
The `aiden tui` launcher shortcut is removed pending a proper single-command
terminal launcher in v3.8. TUI usage is documented via `npm start` +
`npm run cli`.

### Changes

- **Desktop app promoted to primary** — `aiden pc` launches the full Electron UI;
  `aiden` / `aiden help` shows updated help pointing to `aiden pc`
- **`aiden tui` shortcut removed** — the ELECTRON_RUN_AS_NODE node-mode branch
  is stripped from `electron/main.js`; TUI launch instructions added to README
  and `aiden help` output
- **README: Running Aiden section** — documents desktop and TUI launch paths,
  including `npm start` + `npm run cli` workflow

---

## v3.6.0 — 2026-04-18

**The Scale release.** Aiden is now feature-competitive with leading AI agents:
9 communication channels, 52 shipping skills across 12 categories, voice as a
first-class tool namespace, 4 new core tools, Windows shell wedges, a native MCP
client, and a frictionless one-liner install — all local, private, and free to
self-host.

### Headlines

- **Voice as first-class tools** — `voice.speak`, `voice.transcribe`,
  `voice.clone`, `voice.design` wired as agent tools; VoxCPM2 voice synthesis
  and cloning; full waterfall fallback chain
- **4 new core tools** — `clarify` (multi-choice mid-task clarification), `todo`
  (per-session task lists + `/todo` CLI), `cronjob` (scheduled tasks + `/cron`
  CLI), `vision_analyze` (image analysis via provider vision APIs)
- **5 new channel adapters** — WhatsApp, Signal, SMS/Twilio, iMessage, Email →
  9 total communication surfaces
- **32 new skills** across 6 categories (productivity, developer workflow,
  research, creative, media/gaming, agent bridge) → **52 shipping skills total**
- **One-liner install** — `iwr https://aiden.taracod.com/install.ps1 -useb | iex`;
  single-word `aiden` launcher on PATH; winget + scoop manifests ready
- **Windows shell wedges** — `/cmd`, `/ps`, `/wsl` as first-class tools and
  agent tools
- **Native MCP client** — register, manage, and invoke MCP servers + `/mcp` CLI
- **Electron auto-updates** — silent background download + restart prompt;
  `/refresh` force-check command
- **Community contribution ready** — 56 SKILL.md files licensed Apache-2.0;
  CONTRIBUTING.md, CLA, skill template, and migration manifest all prepared for
  aiden-skills public repo launch
- **Self-testing harness** — 148/148 passing across 17 suites (13 new suites
  added this sprint)

### New features

**Voice Tools (VoxCPM2)**
- `voice.speak(text, opts?)` — TTS with provider waterfall (VoxCPM2 → ElevenLabs
  → Edge TTS → Windows SAPI) as agent tool (`feat(prompt-21)`)
- `voice.transcribe(audioPath)` — STT via Groq → OpenAI → local Whisper.cpp
  as agent tool (`feat(prompt-21)`)
- `voice.clone(sourceAudio, text)` — voice cloning via VoxCPM2 fine-tuning
  (`feat(prompt-21)`)
- `voice.design(prompt)` — generative voice design from text description
  (`feat(prompt-21)`)
- `/voice on|off|status` CLI; `VOXCPM_SETUP.md` setup guide (`docs(prompt-21)`)

**New Core Tools**
- `clarify` — structured mid-task clarification: agent presents N choices, waits
  for user selection, resumes (`feat(tools)`)
- `todo` — per-session task list: add, check, list, clear — agent tool + `/todo`
  CLI (`feat(tools)`)
- `cronjob` — first-class scheduled tasks: create, list, pause, delete — agent
  tool + `/cron` CLI (`feat(tools)`)
- `vision_analyze` — image analysis via GPT-4o Vision, Claude Vision, Gemini
  Vision (`feat(tools)`)
- Aiden SDK extended: `aiden.clarify`, `aiden.todo`, `aiden.cron`,
  `aiden.vision` namespaces (`feat(sdk)`)

**Skills — Wave 2 (32 new skills)**

*Productivity (7):* Obsidian vault search/write, Notion database CRUD, Google
Workspace (Docs/Sheets/Gmail), Linear issue tracker, OCR + document parsing,
Nano PDF reader, Excalidraw diagram generation

*Developer Workflow (8):* Jupyter notebook execution, Docker container
management, GitHub auth/issues/PRs/repo management, AI-assisted debugging,
TDD workflow automation

*Research (4):* arXiv paper search, YouTube content analysis, blog watcher,
research paper writing assistant

*Creative (4):* Architecture diagrams (C4/Mermaid), ASCII art generator, Stable
Diffusion image generation, p5.js creative coding

*Media / Gaming / Social / Smart-Home (6):* GIF search (Tenor), song recognition
(SongSee), Minecraft server management, Pokémon automation, OpenHUE smart
lighting, X (Twitter) posting

*Agent Bridge (3):* Claude Code integration, OpenAI Codex bridge, OpenCode
bridge — delegate sub-tasks to other coding agents

**Channel Adapters — Wave 2 (5 new)**
- **WhatsApp** — web client bridge + optional Business API; allowlist +
  inbound/outbound (`feat(channels)`)
- **Signal** — signal-cli REST bridge; relay + allowlist (`feat(channels)`)
- **SMS/Twilio** — inbound webhook + outbound API; 160-char chunking +
  allowlist (`feat(channels)`)
- **iMessage** — BlueBubbles REST bridge; WebSocket inbound + allowlist
  (`feat(channels)`)
- **Email** — IMAP polling + SMTP replies; loop prevention + sender allowlist
  (`feat(channels)`)
- `ChannelManager` extended to 9 adapters; `ChannelStatus` shape expanded
  (`feat(channels)`)

**Install Experience**
- Single-word `aiden` launcher — shim for CMD + Bash; no `npx` required
  (`feat(install)`)
- PowerShell one-liner — downloads and runs installer in one command
  (`feat(install)`)
- `/install.ps1` route added to Cloudflare Worker (`feat(install)`)
- winget manifest — `Taracod.Aiden` package; installer + locale manifests;
  submission-ready (`feat(packaging)`)
- Scoop manifest — `taracod` bucket + `aiden.json`; bucket instructions
  (`feat(packaging)`)
- README expanded with all 4 install paths (`docs`)

**Windows Shell Wedges**
- `/cmd`, `/ps` (PowerShell), `/wsl` — CLI commands + agent tools
  (`feat(shell)`)
- `aiden.shell` SDK namespace with wedge-specific methods (`feat(sdk)`)

**Native MCP Client**
- Register and manage MCP servers via `~/.aiden/mcp.json` (`feat(mcp)`)
- `/mcp list|add|remove|call` CLI (`feat(mcp)`)
- MCP tools injected into agent registry at session start (`feat(mcp)`)
- `aiden.mcp` SDK namespace for programmatic server calls (`feat(sdk)`)

**Electron Auto-Updates**
- Background download on startup; prompts to restart when ready (`feat(update)`)
- `/refresh` — force-check for updates (`feat(update)`)
- IPC wiring between main and renderer for update state (`feat(update)`)

**Community Skills Foundation**
- Apache-2.0 applied to all 56 SKILL.md files (52 shipping + 4 infrastructure)
  (`chore(skills)`)
- `CONTRIBUTING.md` — guide for `aiden-skills` community repo (`docs`)
- `SKILL_TEMPLATE.md` — canonical template for skill authors (`feat(skills)`)
- CLA text + PR bot config prep (`chore`)
- `skills-manifest.json` — repo migration map (`docs`)

### Fixes

- `fix(skills)` — remove hardcoded Tenor API key from `gif-search/SKILL.md`;
  replaced with `$env:TENOR_API_KEY` / `os.environ.get("TENOR_API_KEY")`
- `fix(test)` — prompt_17 voice test aligns with public SDK (`voice.speak` not
  internal `synthesize`)
- `fix(skills)` — cleanup 17 blocked + 9 duplicate skills; harden skill
  auto-generation pipeline

### Internal

- **Testing:** 13 new audit suites added (`prompt_14` through `prompt_23`,
  `prompt_r2`, `prompt_r3`); 148/148 total passing across 17 suites
- **Docs:** `VOXCPM_SETUP.md`, `GATE_v3.6.0.md` launch gate report,
  skills migration manifest
- **Chore:** Version bumped to 3.6.0 across `package.json`, `cli/aiden.ts`,
  `README.md`, `packaging/`, `cloudflare-worker/landing.js`; `.wrangler/`
  added to `.gitignore`

---

## v3.5.0 — 2026-04-18

**The ▲IDEN release.** Aiden matures from v3.1.0's foundation into a full-featured AI OS with 60+ new commands, a complete visual rebrand, a mature architecture competitive with the best agents on the market, and a self-testing reliability harness.

### Headlines

- **▲IDEN visual rebrand** — orange triangle mark, boxed panels, cohesive theme system across TUI and dashboard
- **New `▲ run` tool** — compound tasks execute in a single LLM call via injected Aiden SDK (beats plain-stdlib sandbox patterns)
- **New `▲ spawn` subagent primitive** — isolated context, inherited provider chain, iteration budget sharing
- **New `▲ swarm` parallel subagents** with vote/merge/best voting strategies
- **New `▲ search` hybrid session search** — BM25 full-text + semantic memory weighted merge (0.6 semantic / 0.4 FTS)
- **Multi-goal decomposition** — no more half-answers when users ask multiple things
- **Private mode** — `/private` suppresses memory writes for sensitive turns
- **Prompt caching infrastructure** — 40% faster turns on Anthropic with cache breakpoints on SOUL + standing orders + tools
- **LESSONS.md moat surfaced** — `/lessons` browser + `/teach` for manual rule authoring
- **Provider reliability** — exponential backoff recovery (30s→5min), HTTP keepalive, fast-path expansion for 60%+ of messages
- **Self-testing harness** — 34 zero-cost audits across 4 suites via `npm run test:audit`

### New commands (60+)

**Session management:** `/log` `/save` `/rerun` `/name` `/stack` `/halt` `/yolo` `/attach` `/changelog` `/export` `/fork` `/checkpoint` `/reset` `/history` `/sessions`

**Aiden-exclusive intelligence:** `/lessons` `/teach` `/rewind` `/pin` `/focus` `/explore` `/pulse` `/diff` `/trust` `/timeline` `/garden` `/decision` `/private` `/primary` `/quick` `/async` `/compact`

**Delegation & search:** `/spawn` `/swarm` `/search` `/run`

**Developer tools:** `/kit` `/tools` (category-grouped with icons) `/skills` (13 subcommands: search, install, list, check, update, audit, remove, publish, export, import, source, stats, recommend) `/security` `/debug` `/budget` `/analytics`

**UI & config:** `/theme` `/persona` `/detail` `/depth` `/provider` `/providers` `/models` `/model` `/workspace` `/recipes`

### New features

**▲IDEN Visual System**
- Unified theme tokens — orange `#FF6B35` accent, triangle `▲` mark, shared across TUI and dashboard (`feat(theme)`)
- `▲IDEN` banner — orange block wordmark, capability flex, live status dots (`feat(tui)`)
- Boxed panel renderer — `/tools` with category tables, accent borders, icon groups (`feat(tui)`)
- Live status bar — provider · model · context % · elapsed · async count (`feat(tui)`)
- Fuzzy tab-completion + `/help <command>` detail cards + `/help` search (`feat(tui)`)
- Triangle pulse spinner, animated ✓/✗, update-available check in banner (`feat(tui)`)

**▲ run / ▲ spawn / ▲ swarm / ▲ search**
- `▲ run` sandbox with full Aiden SDK injected — `aiden.web`, `aiden.file`, `aiden.shell`, `aiden.browser`, `aiden.screen`, `aiden.memory`, `aiden.system`, `aiden.git`, `aiden.data` (`feat(run)`)
- `/run` CLI command, example scripts library, `/run help [namespace]` SDK reference (`feat(run)`)
- `▲ spawn` — isolated subagent with empty history, inherited provider chain, `floor(remaining/2)` budget cap (`feat(spawn+swarm)`)
- `▲ swarm` — N parallel spawns via `Promise.allSettled`, vote/merge/best aggregation strategies (`feat(spawn+swarm)`)
- `▲ search` — BM25 (k1=1.5 b=0.75) index over `workspace/sessions` + `workspace/memory`, hybrid scoring with semantic memory at 0.6 weight (`feat(search)`)

**Orchestration & Delegation**
- Multi-agent parallel execution — independent plan steps run simultaneously (`feat`)
- Multi-goal intent decomposition — planner lists all goals, validator catches misses, numbered output (`feat`)
- Slash commands mirrored as agent tools — unified CLI + agent surfaces (`feat`)
- Fuzzy tool name auto-repair — silent recovery from LLM hallucinated tool names (`feat`)
- Async background tasks — run prompts without blocking, notify on completion (`feat`)
- Iteration budget — pressure warnings at 70% and 90% usage (`feat`)
- Interruptible execution — stop button cancels in-flight API calls and tool runs (`feat`)

**Speed & Reliability**
- HTTP keepalive per provider — eliminates cold-connect latency on every call (`feat(speed)`)
- Prompt caching — Anthropic cache breakpoints on SOUL + standing orders + tools list (`feat(speed)`)
- Fast-path expanded to 60%+ of messages; Ollama demoted to true-fallback (`feat(speed)`)
- Stream-first responses — first token appears immediately, blank wait eliminated (`feat`)
- Greeting fast-path surfaces memory — continuity from turn 1 without full agent loop (`feat`)
- Session resume — `--continue` and `--resume` flags restore previous context (`feat`)
- Token-based preflight compression — auto-compress at 50% context usage (`feat`)

**Provider & Routing**
- Configurable primary provider + `/api/providers/state` endpoint + `/primary` CLI (`feat(router)`)
- Universal custom providers — any OpenAI-compatible endpoint registers as a provider (`feat`)
- BOA provider — multi-cloud API gateway with full endpoint mapping (`feat`)
- Exponential backoff recovery — 30s→5min half-open retry for failed providers (`fix(router)`)
- JSON repair fallback — recover non-JSON planner responses instead of retrying (`fix(planner)`)

**Memory & Knowledge**
- `LESSONS.md` — permanent failure rules, auto-appended, injected every session (`feat`)
- `/lessons` browser with search + `/teach` for manual rule authoring (`feat(lessons)`)
- Private mode — per-turn and per-session memory opacity toggle (`feat`)
- `/garden` memory layer explorer — inspect what Aiden knows and from where (`feat(tui)`)
- Session lineage — track parent/child relationships across compressions (`feat`)
- Compaction protection — SOUL, rules, and goals survive context reset (`feat`)
- YouTube transcript ingestion — extract and store in Knowledge Base (`feat`)

**Platform & Integrations**
- Telegram bot integration — chat with Aiden from your phone (`feat`)
- Calendar and Gmail tools — iCal event reading + email foundation (`feat`)
- OpenAI-compatible API endpoint — VS Code, Cursor, and JetBrains extensions can treat Aiden as a local model (`feat`)
- Cross-channel dispatch — start on Telegram, continue on desktop (`feat`)
- Unified gateway — single router for all channels (`feat`)
- Plugin system — community extensions with tool and hook registration (`feat`)
- Formal callback system — typed events for all platforms (`feat`)
- Import from ChatGPT and OpenClaw — migrate conversation history (`feat`)
- Recipe engine — YAML workflow definitions with typed params and retry (`feat`)
- Conversation export — download as Markdown or JSON (`feat`)
- AgentShield — security scanner for skills, configs, and identity (`feat`)
- Browser profile isolation — agent cannot access user cookies (`feat`)
- Shell command allowlist — unknown commands blocked by default (`feat`)
- Expanded skill injection defense — structural validation + 25 new patterns (`feat`)
- Live debug panel with log buffer and system health (`feat`)

**Skills Lifecycle**
- Full 13-subcommand lifecycle: search, install, list, check, update, audit, remove, publish, export, import, source, stats, recommend (`feat(skills)`)
- `▲IDEN` Skill Store — tabular browse, detail cards, orange source badges (`feat(tui)`)
- Skills manager in dashboard — view, enable/disable, delete (`feat`)

**Dashboard**
- Usage dashboard — cost and tool analytics in Settings (`feat`)
- Session history in sidebar — see past conversations (`feat`)
- Thinking indicator — shows planning/executing/reasoning stages (`feat`)
- One-command release script — `npm run release <version>` (`feat`)
- Auto-detect timezone during onboarding (`feat`)
- Graceful degradation — friendly message when all providers down (`feat`)
- Auxiliary LLM client — cheap model for side tasks (memory, dreams, compression) (`feat`)
- 15 instant actions — open apps, play music, volume control, screenshot, timer, system control (`feat`)

### Fixes

- `fix(panel)` — unified panel width: title, body, and borders all align
- `fix(router)` — add BOA endpoint to all `ENDPOINTS` maps in server.ts
- `fix(api)` — `/api/config/primary` accepts both `name` and `provider` fields
- `fix(chat)` — status fast-path bypasses agent loop for session/system status queries
- `fix(tools)` — introspection category + classifier routes self-queries to slash-mirror tools
- `fix(fastpath)` — greeting preamble wired; bypasses planner for instant response
- `fix(help)` — rename agent-pane label in help panels; tag unimplemented commands
- `fix(skills)` — `/skills recommend` works with no args, infers from history
- `fix(skills)` — Source column shows origin (aiden/community/local), not approval state
- `fix(rewind)` — `/rewind` alone undoes last exchange, no mark required
- `fix` — planner rotation now walks full provider chain (groq→gemini→openrouter→boa)
- `fix` — BOA provider base URL + model selection corrected
- `fix` — TUI connection match with `api/server.ts` chat endpoint format
- `fix` — TUI unicode rendering, empty greeting, `/model` alias
- `fix` — 7 test failures resolved: missing routes, debug log format, tool registry
- `fix` — exclude current process from node kill in release script
- `fix` — React.* type refs replaced with direct named imports in page.tsx
- `fix` — stale SkillsView reference replaced with SkillsManager in CHANNEL_CONFIG

### Internal

- **Testing:** Added 26 automated zero-cost audits across 3 suites (`prompt_11`, `prompt_12`, `prompt_13`) covering aidenSdk, runSandbox, toolRegistry, spawnManager, swarmManager, sessionSearch, hybridSearch
- **Docs:** `SESSION_RULES.md` — working rules for Claude Code on Aiden; `CLAUDE.md`, `.graphifyignore`, `workspace-templates/`
- **Chore:** Gitignore cleanup — `dist/`, `dist-bundle/`, `.claude/worktrees/`, `config/hardware.json` untracked from index; runtime source sync

---

**Total: 102 commits since v3.1.0.**

Full commit list: [v3.1.0...v3.5.0](https://github.com/taracodlabs/aiden/compare/v3.1.0...v3.5.0)
