# Aiden v4.6 — Phase 1: Sub-Agent Design Spec

> **Status:** Design locked, implementation deferred to Phase 2.
> **Scope:** This document specifies the contract, schema, and lifecycle for
> single, synchronous, non-nested sub-agent spawning. Code lives in Phase 2.

## 1. Overview

Phase 1 introduces a single tool — `spawn_sub_agent` — that lets a parent
`AidenAgent` turn fan out exactly one focused child turn to handle a
delegated goal, then receive a structured result envelope back into its
own tool result slot. The child runs in the same process as the parent
on a worker thread (Node `worker_threads` or a `Promise`-isolated task —
implementation choice in Phase 2), with a fresh agent instance, an
intersected toolset, a freshly-built system prompt, and zero parent
conversation history. The child terminates on completion, on
`maxIterations`, on a wall-clock timeout, or on cooperative interrupt
from the parent.

**Phase 1 does NOT include:** batch (multi-task) spawning, nested
spawning (children that themselves spawn), per-spawn workspace
isolation, asynchronous "fire and forget" sub-agents, or a cross-agent
file-state coordination layer. Each of those is reserved for a later
phase (see §10).

## 2. Q-decisions locked

| # | Question | Decision |
|---|---|---|
| Q1 | Spawn surface | Tool call. Tool name: `spawn_sub_agent`. |
| Q2 | Child identity | Flat UUID `sessionId`. Lineage via `spawned_from_run_id` FK on `runs` (NOT a tree column). |
| Q3 | Budget model | Explicit `maxIterations` arg at spawn. Default 50. Clamp `[1, 200]`. |
| Q4 | Failure mode | Always a structured result envelope. Never throw out of the tool dispatch. |
| Q5 | Tool blocklist | Hard-coded `{spawn_sub_agent, clarify, memory, execute_code, send_message}`. Then intersected with parent's enabled toolsets. |
| Q6 | Persistence | Extend `runs` table with `spawned_from_run_id` + `spawned_from_session_id`. Do NOT overload `trigger_event_id`. |
| Q7 | Workspace | Child inherits parent's working directory. No isolation in Phase 1. |
| Q8 | Synchronicity | Synchronous only. Parent's tool call blocks until child terminates. Async work belongs in daemon triggers (v4.5). |
| Q9 | Coexistence with existing `subagent_fanout` | Existing `core/v4/subagent/` (v4.1.0, shipped v4.5.0) stays untouched in Phase 1. Phase 1 adds `spawn_sub_agent` as a separate, additive primitive. Phase 2 refactors `subagent_fanout` to call `spawn_sub_agent` N times internally. See §12. |
| Q10 | Worker isolation primitive | Promise-isolated task on the shared event loop. Cooperative cancellation via `AbortController` / `AbortSignal`, no `worker_threads`. Rationale: matches the v4.5 daemon dispatcher's existing concurrency model, matches the existing `core/v4/subagent/fanout.ts` `Promise.all` pattern, matches every module-level singleton's reentrancy assumptions, and avoids structured-clone IPC for state (e.g. `FallbackAdapter` is not structured-cloneable due to `Map` + callback refs). Trade-off accepted in §7.1. |
| Q11 | `FallbackAdapter` rate-limit isolation | Mirror the existing `FallbackAdapter.clone()` factory pattern verbatim (`core/v4/providerFallback.ts:578`). Per child: fresh `slotState` / `cooldownUntil` / `activeSlotId` / `requestCount`; shared by reference: `slots` (immutable), `cooldownMs`, `clock`, `onRateLimit`, `onFallback`. Rationale: clean (zero TODO/FIXME), documented trade-off, microsecond cost per spawn, production-proven since v4.1.0. Phase 2 implementation comments MUST preserve the existing docstring's deliberate-trade-off note so future maintainers don't "fix" the perceived duplication. |

## 3. Spawn API (TypeScript surface — Phase 2 implementation)

```ts
interface SubAgentSpec {
  goal: string;
  context?: string;
  toolsets?: string[];           // requested, will be intersected
  maxIterations?: number;        // default 50, clamp [1, 200]
  timeoutMs?: number;            // default 600_000
}

interface SubAgentResult {
  ok: boolean;
  status: 'completed' | 'failed' | 'timeout' | 'interrupted';
  summary: string | null;
  error: string | null;
  exitReason:
    | 'completed'
    | 'max_iterations'
    | 'timeout'
    | 'interrupted'
    | 'error';
  metrics: {
    apiCalls: number;
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
  };
  childRunId: string;
  childSessionId: string;
}
```

**Invariants the implementation must hold:**

- `ok === (status === 'completed' && exitReason !== 'error')`. The
  boolean is redundant with `status` but kept as a cheap branch the
  caller can use without exhaustive enum matching.
- `summary` is non-null iff the child produced a final assistant
  message. `summary !== null` does NOT imply `exitReason === 'completed'`
  — a child that hit `max_iterations` after producing a partial
  response gets `status: 'completed', exitReason: 'max_iterations',
  summary: '<partial>'`.
- `error` is non-null iff `status` is `failed`, `timeout`, or
  `interrupted`. For `completed`, `error` MUST be null.
- `metrics.durationMs` is wall-clock from spawn-call entry to envelope
  emission, NOT just the child's `run_conversation` time. Includes
  agent construction, timeout-cleanup, and result aggregation.
- `childRunId` and `childSessionId` are populated for EVERY status,
  including `failed` and `timeout`. The child `runs` row is inserted
  before the worker starts; if the worker never gets to first API call,
  the row still exists with `status='failed'` so the audit trail is
  intact.

## 4. Tool surface

The parent agent sees this in its tool catalog when `enabled_toolsets`
includes `delegation`:

```json
{
  "type": "function",
  "function": {
    "name": "spawn_sub_agent",
    "description": "Spawn a focused child agent to handle one delegated sub-task synchronously. The child runs with no access to your conversation history, an intersected toolset (cannot exceed your capabilities), and a fresh system prompt built from the goal + optional context. Returns a structured result envelope with the child's summary, metrics, and exit reason. Use this when a sub-task benefits from isolated context (e.g. exploring a separate codebase area, running a focused investigation, drafting an artifact without polluting your main turn). Do NOT use for long-running or scheduled work — use daemon triggers for that. Spawning is bounded: max 1 child at a time in Phase 1, no nested spawning, max 200 iterations per child. Each spawn pays full agent-startup cost (system prompt build, tool catalog ship) and roughly doubles token spend for that sub-task. Prefer inline work for anything you can answer in 1-3 of your own iterations. Spawn when isolation, focus, or a restricted toolset actually helps.",
    "parameters": {
      "type": "object",
      "required": ["goal"],
      "additionalProperties": false,
      "properties": {
        "goal": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4000,
          "description": "The single concrete task for the child. Phrase as an imperative outcome — what should be done, not how. The child cannot ask follow-up questions; if the goal is ambiguous, refine it before spawning."
        },
        "context": {
          "type": "string",
          "maxLength": 16000,
          "description": "Optional background the child needs but couldn't infer from the goal alone (file paths, prior findings, constraints). Plain text. The child does NOT see your conversation history; anything it needs must be here or discoverable via its toolset."
        },
        "toolsets": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Requested toolsets for the child. Will be intersected with your own enabled toolsets — the child cannot exceed your capabilities. Omit to let the child inherit your full intersected set (after blocklist removal)."
        },
        "maxIterations": {
          "type": "integer",
          "minimum": 1,
          "maximum": 200,
          "default": 50,
          "description": "Maximum tool-call iterations the child may run. Clamped to [1, 200]. Choose tight bounds for narrow tasks (5-15) and looser for exploration (50-100)."
        },
        "timeoutMs": {
          "type": "integer",
          "minimum": 1000,
          "maximum": 3600000,
          "default": 600000,
          "description": "Hard wall-clock timeout in milliseconds. Default 10 minutes. The child is signalled to interrupt on timeout; if it doesn't yield cooperatively, the worker leaks but the parent stays responsive."
        }
      }
    }
  }
}
```

**Required:** `goal`. **Optional:** everything else.

The parent's LLM is told (via the description) the three things it must
know: (a) the child has no history of this conversation, (b) the result
is structured not free-form, (c) this is synchronous — async needs the
daemon. Everything else is enforced server-side.

## 5. State isolation rules

| Subsystem | Inherited | Isolated | Notes |
|---|---|---|---|
| Conversation history | ❌ | ✅ | Child starts with goal + context only. No parent messages. |
| System prompt | ❌ | ✅ | Freshly built per-spawn. Includes only goal, context, role indicator ("sub-agent"), and depth marker. No SOUL.md, no parent identity context. |
| Toolset | partial | partial | Intersect of (parent's enabled toolsets) ∩ (requested toolsets or parent's) MINUS blocklist (see §4 Q5). Child can never gain a capability the parent lacks. |
| MCP servers | ✅ | — | MCP connections inherit by default (Phase 1). A `inherit_mcp` knob is deferred to Phase 2 if it becomes necessary. |
| Provider + model | ✅ | — | Child uses the parent's provider + model. Per-spawn override is deferred to Phase 2. |
| API key / credentials | ✅ | — | Inherited from parent's agent context. No separate credential pool. |
| Working directory | ✅ | — | Per Q7: child inherits parent's `cwd`. Workspace isolation is Phase 2. |
| **v4.4 execution sandbox** | ✅ | — | Child runs under the parent's `AIDEN_SANDBOX` state. If parent is sandbox-on, child is sandbox-on. Risk-tier classification continues to apply to the child's tool calls. |
| **v4.5 daemon approval policy** | ✅ | — | If the spawn happens during a daemon-fired turn, the child inherits the parent's `daemonApproval` policy (`safe-only` / `caution-ok` / `dangerous-ok`). Interactive `clarify` is blocked anyway (see Q5), so caution/dangerous prompts auto-deny in the child without TUI fallback. |
| **v4.2 TCE (turn-by-turn continuous evaluation)** | ❌ | ✅ | Child gets its own TCE history. Parent's failure-category counters are not visible to the child, and child failures do not bump the parent's counters. The two agents are independently evaluated. |
| Token budget | ❌ | ✅ | Child has its own `maxIterations` (from spawn arg). Parent's `maxTokensPerFire` (daemon-mode) does NOT bound the child directly — it bounds the PARENT, which means a spawn near the parent's budget edge will be reflected when the child's tokens roll up into the parent total (see §6). |
| Cost rollup | rollup | — | Child's `tokensIn + tokensOut` and estimated cost roll INTO the parent's session totals when the spawn returns. Per-layer additive. |
| File-op cache (`task_id` namespace) | ❌ | ✅ | Child gets a fresh `task_id` (`subagent-<run_id>-<rand>`). File reads/writes don't cross the namespace. Parent-vs-child file conflict detection deferred to Phase 2. |
| **`moat/approvalEngine.ts`** (ApprovalEngine instance + session-scoped allowlist) | ❌ | ✅ | Fresh `new ApprovalEngine(mode)` per agent — verified at `cli/v4/aidenCLI.ts:1092` (REPL) and `cli/v4/daemonAgentBuilder.ts:113` (per daemon turn). The session-scoped allowlist (`approve-once` decisions, `approve-session` grants) lives on the instance and never leaks across agents. Child gets a fresh engine constructed with auto-deny callbacks; the parent's interactive callbacks (REPL TUI prompts) are NOT passed in, since the child cannot prompt the user. Concurrent approval requests cannot occur within one parent's turn (the agent loop's tool dispatch is sequential), and across parent+child the engines are independent — no mutex is needed because there is no shared mutable approval state. |
| **`core/v4/browserState.ts`** (v4.3 browser depth observer) | ❌ | ✅ | Observer is keyed by `sessionId`. Fresh child `sessionId` ⇒ fresh observer slot ⇒ implicit isolation. Parent's browser state is not visible to the child and vice versa. |
| **`core/v4/dockerSession.ts`** (v4.4 per-`sessionId` docker session cache) | partial | partial | Cache slot is per-`sessionId` so the child gets a clean entry (isolated). The underlying docker daemon socket and pulled images are process-level (shared). Implication: child containers don't inherit parent container state, but spinning up a new container in the child does not re-pull images. |
| **`core/v4/skillLoader.ts`** (skill registry) | ✅ (read-only) | — | Skill registry is a filesystem-backed process-level singleton. Child reads the same registry; child does NOT write to it. If a skill is dynamically loaded by the child, it becomes visible to the parent's later turns (intentional — skills are user-installed artifacts, not per-turn state). |
| **`core/v4/toolRegistry.ts`** (registry **instance**, distinct from toolset intersection above) | ✅ (read-only) | — | The registry object itself is shared — the child reads the same `ToolDef[]` the parent compiled. The TOOLSET intersection rule (row above) filters which tool NAMES the child sees; this row clarifies the underlying registry instance is not cloned. No child mutation of the registry permitted. |
| **`core/v4/memoryManager.ts`** (memory snapshot) | ✅ (read-only) | — | The `memory` tool is in the Q5 blocklist so the child cannot WRITE. The manager INSTANCE is shared so the child can READ parent's MEMORY.md / durable facts — matches the existing `core/v4/subagent/fanout.ts` precedent ("Shared (read-only) across children: memoryManager"). |
| **`core/v4/plugins/pluginPermissions.ts`** (`.granted-permissions.json` consumers) | ✅ | — | Child inherits the parent process's granted-permissions state. A plugin granted `browser/subprocess/network` for the parent is granted for the child (same process, same registry). No per-child re-grant flow in Phase 1. |
| **`core/v4/suggestionEngine.ts`** (`firedSlots` Set + catalog) | ✅ (process-level singleton) | — | Verified at `core/v4/suggestionEngine.ts:253-255` — the `SuggestionEngine` is a process-level singleton accessed via `getSuggestionEngine()`. The `firedSlots: Set<SuggestionSlot>` (line 168) lives inside the singleton's closure and is shared across ALL agents in the process. Implication: child agents draw from the SAME suggestion budget the parent does. If `spawn_sub_agent` is in a suggestion-firing toolset, child suggestions deplete the shared budget. Phase 1 accepts this as the singleton's current semantics; per-agent budget masking is a Phase 2+ knob if real-world use surfaces a need. |
| **`core/v4/runtimeToggles.ts`** (live-flip slash command state: `/sandbox`, `/tce`, `/browser-depth`, `/suggestions`, `/planner-guard`) | ✅ | — | Toggles are process-level singletons. Child sees whatever the parent has flipped. If the parent flips `/sandbox on` MID-spawn, the change is visible to the child on its next tool dispatch (read-on-each-call). No snapshot-at-spawn-time semantics in Phase 1. v4.6 Phase 2M added `/planner-guard` (default OFF) — opt-in keyword-based tool narrowing for small local models that get overwhelmed by 50+ tool schemas; smart models (GPT-5.5, Claude Sonnet 4.5+, Opus) leave it off and select tools fine from the full catalog. |
| **`core/updateChecker.ts`** (update-check cache + skip-version persistence) | N/A | — | Update checker only runs at boot and on `/update`. A sub-agent never boots and never runs the `/update` slash command — there is no execution path from a child into the update checker. Listed for completeness; no design surface. |
| **Provider rate-limit pools** (`FallbackAdapter` mutable state, per `core/v4/subagent/fanout.ts` precedent) | partial | partial | Resolver and credential set inherit (shared read-only); rate-limit / cooldown state is cloned per child via the existing `FallbackAdapter` clone pattern. This isolates per-child rate-limit bookkeeping so a child hitting a 429 does not collapse the parent's quota tracking. Implementation MUST mirror the existing v4.1-subagent clone pattern in Phase 2. |

## 6. Lifecycle state machine

```
              ┌─────────┐
              │ created │       row inserted, child not yet started
              └────┬────┘
                   │ worker.start()
                   ▼
              ┌─────────┐
              │ running │       child.runConversation() in worker
              └────┬────┘
       ┌───────────┼───────────┬──────────────┐
       │           │           │              │
       ▼           ▼           ▼              ▼
  ┌─────────┐ ┌────────┐ ┌──────────┐ ┌─────────────┐
  │completed│ │ failed │ │ timeout  │ │ interrupted │
  └─────────┘ └────────┘ └──────────┘ └─────────────┘
```

**Transitions:**

- `created → running`: worker begins. Row's `started_at` is set on creation; `running` is the in-memory state, not a DB enum (the DB tracks `status` with terminal values + `running`).
- `running → completed`: child's `runConversation()` returned a result with `finishReason` other than abort/timeout. `exitReason` is `completed` (natural stop) or `max_iterations` (iteration cap hit but result produced).
- `running → failed`: child threw, child's first API call never completed and timeout fired with `apiCalls === 0` (treated as failure not timeout), or child returned without producing a summary.
- `running → timeout`: child exceeded `timeoutMs`. The implementation MUST:
  1. Signal the child's interrupt flag (cooperative; child's loop checks it between tool calls).
  2. Wait at most `INTERRUPT_GRACE_MS` (Phase 2 default: 500ms) for the worker to yield.
  3. If still running, mark the row `timeout` and shutdown the worker handle WITHOUT awaiting (Node `worker_threads.terminate()` is the only hard kill; in a Promise-isolated implementation the worker leaks).
  4. Emit the result envelope from the PARENT's thread, not the worker. The worker may still be running; the parent does not block on it.
- `running → interrupted`: parent received an interrupt (Ctrl-C, daemon shutdown, REPL cancel). Parent signals child the same way as the timeout path, but `exitReason` is `interrupted` and `error` reads "Parent interrupted — child did not finish in time."

**Idempotency:** the `runs` row is inserted exactly once at `created`.
Status transitions are single-writer (the parent thread); the worker
NEVER writes to its own `runs` row.

## 7. Cancellation

**Cooperative only.** Node has no thread-kill primitive equivalent to
Python's "you can't kill a thread either, but here's a flag" — and even
JS workers can't be interrupted mid-synchronous-code. Phase 1 ships
cancellation as a flag the child checks between tool calls:

```ts
// Inside the child's run loop (Phase 2 implementation)
for (let i = 0; i < maxIterations; i++) {
  if (this._interruptRequested) {
    return { finishReason: 'interrupted', summary: this._lastSummary };
  }
  // ... tool call ...
}
```

**The contract:**

- Parent flips `child._interruptRequested = true` on timeout OR parent
  interrupt.
- Parent waits at most `INTERRUPT_GRACE_MS` for the child to yield.
- Parent then proceeds to emit the result envelope. If the worker is
  still executing (stuck in a synchronous tool, blocked on slow I/O),
  it will continue to run until that operation completes; its eventual
  output is discarded. The parent's state is no longer waiting on it.

**Known limitations** (documented, accepted for Phase 1):

- A child stuck inside a synchronous tool call (e.g. a blocking `fs`
  read on a huge file) cannot be cancelled mid-call. The worker leaks
  until that call returns naturally.
- A child making a slow HTTP request to a provider will not respect the
  interrupt until that request completes or its own internal timeout
  fires. The parent does not block on this.
- The worker leak is bounded by the underlying I/O timeout (typically
  30s-120s) plus one iteration's worth of work. Cumulative leakage
  across a long parent session is a Phase 2 concern; Phase 1 ships with
  per-process leak count emitted via `dispatcher:invoked` payload for
  observability.

### 7.1 Prerequisite: AidenAgent abort plumbing

The cooperative-cancellation contract in §7 assumes that the child
agent's run loop checks an abort flag between iterations and yields
when set. **This infrastructure does not exist on `AidenAgent` today
and must be added before any `spawn_sub_agent` code is written.**

Audit findings (`AidenAgent` as of v4.5.0):

- `AidenAgent.runConversation(history, options)` signature at
  `core/v4/aidenAgent.ts:603` has NO `signal?: AbortSignal` parameter.
  Verified by full-file grep: zero occurrences of `AbortSignal`,
  `AbortController`, `interruptRequested`, or `cancel()` in the
  1,461-line file's instance code.
- `runTurnLoop` (line 664) has no per-iteration abort check.
- The tool dispatch path inside the loop has no `signal` propagation
  to individual tool calls.
- The provider HTTP layer (`FallbackAdapter` and the provider adapters
  it dispatches to) accepts a standard `fetch` `signal` parameter at
  the request boundary, but that signal is not connected to the agent
  loop today — it would be supplied externally, not derived from the
  loop's own state.
- The v4.5 daemon dispatcher has no abort path either (zero
  `abort|signal|interrupt|cancel|terminat` matches in
  `core/v4/daemon/dispatcher/dispatcher.ts`). Mid-flight trigger
  fires run to natural completion; cancellation is unsupported.

**Phase 2 implementation sequencing.** Before any sub-agent code is
written, a separate sub-dispatch lands the following agent-layer
prep patch:

1. Add `signal?: AbortSignal` to `AidenAgent.runConversation`'s
   options object (optional parameter; existing callers continue to
   work unchanged).
2. Thread the signal into `runTurnLoop` as a constructor / option
   field on the loop's internal state.
3. The loop checks `signal?.aborted` between iterations. If set, it
   short-circuits with a result whose `finishReason: 'interrupted'`
   (new enum value) and a `summary` of whatever has been emitted to
   that point.
4. Tool dispatch checks `signal?.aborted` BEFORE invoking each tool.
   If set, the tool call is skipped and the loop yields immediately.
5. The signal is passed through to the provider HTTP layer so an
   in-flight `fetch` is also cancelled (the provider adapters
   already understand `signal` per the standard `fetch` API).

**Load-bearing implications.**

- `AidenAgent.runConversation` gains new public-surface behaviour.
  Other callers — the v4.5 daemon `realAgentRunner`, the REPL turn
  loop, MCP server bridge, CLI commands — should remain unchanged
  unless they want to enable cancellation. The parameter is optional
  with a default of "no abort possible," matching today's behaviour.
- The new `finishReason: 'interrupted'` enum value must be added to
  the agent's result type. Callers exhaustive-switching on
  `finishReason` will need a case added; an audit pass of those
  call sites is part of the prep dispatch.
- The full v4.5 vitest suite (3,432 passing tests) MUST stay green
  through the prep dispatch. No behavioural change for callers that
  don't pass `signal`.
- The dispatcher does NOT need an abort path in Phase 1 — the parent
  agent that's the SPAWNER is the only thing that needs to propagate
  abort, and it does so by constructing its own `AbortController`
  per spawn and signalling on timeout or on its own external cancel.
  Dispatcher-level cancellation of trigger fires remains a separate
  Phase 3+ concern.

Without this prep patch, Phase 1's `INTERRUPT_GRACE_MS` wait, the
`status: 'interrupted'` envelope variant, and the timeout-signal
path all reduce to wishful thinking — the parent would set a flag
the child never reads.

## 8. Failure taxonomy

Every legal `(status, exitReason)` pair, with parent-LLM guidance:

| status | exitReason | Meaning | What parent's LLM should do |
|---|---|---|---|
| `completed` | `completed` | Child finished naturally, produced a summary. | Read `summary` and continue. This is the happy path. |
| `completed` | `max_iterations` | Child hit iteration cap but produced a partial summary. | Read `summary`; recognise it's incomplete. May spawn a continuation if needed, with a tighter goal scoped to the remaining work. |
| `failed` | `error` | Child threw or produced no summary. `error` describes why. | Treat as actionable error. If retryable (e.g. transient API failure), can re-spawn. If not (e.g. invalid goal), report up to user. |
| `timeout` | `timeout` | Wall-clock cap hit. May have a partial `summary`. | Surface the timeout — don't pretend the work completed. Either re-spawn with looser `timeoutMs` or break the task into smaller spawns. |
| `interrupted` | `interrupted` | Parent's own interrupt propagated. Child did not finish. | Do not retry automatically. The parent itself is being interrupted; complete the current turn cleanly. |

**Illegal pairs (must never appear in an envelope):**

- `completed` with `exitReason: 'error'` — contradiction.
- `failed` with `exitReason: 'completed'` — contradiction.
- `timeout` with `exitReason !== 'timeout'`.
- `interrupted` with `exitReason !== 'interrupted'`.
- Any status with `summary === null` AND `error === null` (the envelope
  must always carry at least one of summary or error).

**Illegal parent behaviour (must be enforced by the parent's LLM, not by
the envelope itself):**

- Same goal spawned 3+ times in one parent turn → parent should abort
  and surface to the user, not spawn a third time. The envelope cannot
  detect this on its own; the parent's reasoning loop is responsible.

**Retry budget.** At most ONE re-spawn per failed sub-task within the
same parent turn. If the re-spawn fails the same way, surface the
error envelope to the user; do not loop. The parent's LLM should
track sub-task identity (by `goal` string or by a stable task slot in
its own reasoning) and refuse a third attempt at the same sub-task in
one turn. A `failed` envelope followed by an immediate identical
re-spawn followed by another `failed` is the stop signal — not an
invitation to keep trying. This rule applies symmetrically to
`timeout` (one re-spawn with looser `timeoutMs` is permitted; a third
spawn at the same goal is not). `interrupted` envelopes are never
retried (parent itself is being cancelled). When `completed` arrives
with `exitReason: 'max_iterations'` and a partial summary, the
parent MAY spawn a continuation with a tighter, scoped goal — that
counts as a NEW sub-task (different `goal`), not a retry of the
same one.

## 9. Schema migration

The migration ships as `core/v4/daemon/db/schema/v6.sql`. Wired into
`migrations.ts` in Phase 2 via:

```ts
const V6_SQL = `<contents of v6.sql>`;
// MIGRATIONS array gets:
//   { version: 6, name: 'phase 6 — sub-agent lineage', sql: V6_SQL }
```

**SQL contents:**

```sql
-- v6: sub-agent lineage columns on runs.
--
-- Adds two nullable columns + an index. Phase 1 of v4.6 sub-agents
-- uses these to record parent→child relationships without overloading
-- the v4.5 trigger_event_id column (which means "this run was fired
-- by a daemon trigger event") with a second relationship type.
--
-- Both columns are NULL on top-level runs (REPL turns, daemon-fired
-- turns). Both are populated on sub-agent runs spawned via the v4.6
-- spawn_sub_agent tool.

ALTER TABLE runs ADD COLUMN spawned_from_run_id     INTEGER;
ALTER TABLE runs ADD COLUMN spawned_from_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_spawned_from
  ON runs(spawned_from_run_id)
  WHERE spawned_from_run_id IS NOT NULL;
```

**Notes on the schema:**

- `spawned_from_run_id` is `INTEGER` to match `runs.id INTEGER PRIMARY
  KEY AUTOINCREMENT`. (The original task brief listed `TEXT`; that
  would not have been a valid FK target. Type chosen to match existing
  parent column.)
- `spawned_from_session_id` is `TEXT` to match `runs.session_id TEXT
  NOT NULL`. Stored redundantly because session-scoped queries are
  common and joining through `runs.id → runs.session_id` per-row is
  needless overhead.
- **No FK constraint** is declared on either column. SQLite does not
  support `ALTER TABLE ADD COLUMN` with a `FOREIGN KEY` clause in a
  single statement — the column would need to be added during the
  initial `CREATE TABLE`. Adding it after the fact requires a table
  rebuild (`CREATE TABLE new, copy, drop old, rename`). The existing
  v4.5 schema accepts this limitation: future migrations that need
  FK on these columns can rebuild the table at that time. For Phase 1
  the partial index is sufficient — orphan rows are queryable and
  cleanable but not foreign-key-enforced.
- Partial index (`WHERE spawned_from_run_id IS NOT NULL`) is used
  because the vast majority of `runs` rows are top-level — partial
  indexing keeps the index small.

## 10. Open questions deferred to Phase 2+

- **Phase 2 prep dispatch — AidenAgent abort plumbing.** Lands BEFORE
  any `spawn_sub_agent` code: adds `signal?: AbortSignal` to
  `AidenAgent.runConversation`, threads it through `runTurnLoop`,
  adds per-iteration + pre-tool-call abort checks, propagates the
  signal to the provider HTTP layer, and introduces the
  `finishReason: 'interrupted'` enum value. See §7.1 for the full
  prerequisite spec. Without this dispatch, §7's cancellation
  contract is unimplementable.
- **Batch spawn** (multi-task fan-out): the `tasks: [...]` shape from
  the reference design. Needs concurrency cap, per-task envelope
  aggregation, and the `wait(FIRST_COMPLETED)` polling primitive.
- **Nested spawning**: depth > 1 trees. Needs orchestrator vs leaf role
  flag, depth-aware blocklist (orchestrator re-adds `spawn_sub_agent`),
  global depth cap.
- **Per-spawn workspace isolation**: opt-in worktree per child, or
  per-child `cwd` override. Requires graceful inheritance fallback.
- **Per-spawn provider/model override**: cheaper / faster model for
  children. Needs separate credential pool resolution.
- **Cross-agent file-state coordination**: when a child writes a file
  the parent had previously read, surface a stale-paths reminder in
  the next parent turn's input. Probably ships as a `stalePaths:
  string[]` envelope field, not appended to the summary.
- **Sub-agent memory integration**: should sub-agent summaries flow
  into the parent's session distillation? Into a separate "## Sub-agent
  outputs" MEMORY.md section? Or stay purely in `runs` + `run_events`?
- **Hooks**: `subagent_start` and `subagent_stop` plugin hooks. Phase 1
  ships with `dispatcher:spawned` and `dispatcher:spawn_completed`
  emitted as `run_events` on the PARENT run — plugin hooks are Phase 3.
- **Operator kill-switch**: pause new spawns globally without killing
  in-flight children. Slash command (`/subagent pause`)? Daemon RPC?
  Probably both, but the surface is Phase 2.
- **Streaming child progress**: child's intermediate `tool_call_started`
  events visible to parent's UI before the child completes. Phase 1
  ships with no streaming — the parent sees nothing until the envelope
  returns. Phase 2 adds a `child_progress` event piped through the
  parent's `run_events`.
- **Idempotency on retry**: if the parent's turn is itself retried
  (e.g. via daemon retry matrix), should the previous spawn's result
  be replayed or re-spawned? Likely "re-spawn, with a new child
  run_id" — but the semantics need explicit documentation.
- **Verify `core/v4/plugins/pluginPermissions.ts` singleton vs
  per-context construction** before Phase 2 wiring. Flagged in
  Dispatch 2D-DOCFIX Task 2 audit — the §5 matrix row for
  `pluginPermissions` (line 179) was not fully verifiable via grep
  (no clear singleton pattern surfaced). Almost certainly fine
  because `.granted-permissions.json` is filesystem-backed and
  any consumer reads the same on-disk state regardless of in-memory
  structure, but worth a clean read of the module before the
  spawn primitive depends on it.
- **Per-agent suggestion budget masking** — `firedSlots` is a
  process-level singleton today (verified at
  `core/v4/suggestionEngine.ts:253-255`). Phase 1 ships with child
  agents drawing from the shared parent budget. If real-world use
  shows children silently depleting the parent's suggestion budget
  before the parent's own slots fire, add per-agent masking in
  Phase 2+ (e.g. a `withSuggestionScope(agentId, fn)` helper that
  swaps in a per-agent `firedSlots` Set for the duration of the
  agent's lifetime).

## 11. Test plan (Phase 5)

### 11.0 Prep-dispatch tests (AidenAgent abort plumbing — see §7.1)

These run BEFORE any sub-agent code is written. They guard the
agent-layer prerequisite:

- **Signature accepts `signal`** — `runConversation(history, { signal })`
  compiles and runs with a fresh `AbortController().signal`; same call
  with no `signal` field continues to work (backward-compatible).
- **Pre-iteration abort** — aborting the signal between the loop's
  iterations causes `runConversation` to return at the next checkpoint
  with `finishReason: 'interrupted'`. Partial assistant text streamed
  via `onDelta` before the abort is **dropped** from the result's
  `finalContent` in this prep dispatch (set to `''`); delta-accumulation
  on abort is deferred to a future phase as a known limitation.
- **Pre-tool-call abort** — aborting during the tool dispatch phase
  (between the model's tool call request and the actual tool
  invocation) skips the remaining queued tool calls in that iteration
  and yields with `finishReason: 'interrupted'`.
- **In-flight HTTP cancels** — aborting while the provider HTTP
  request is in flight surfaces the underlying fetch's
  `AbortError`; the loop catches it and yields with
  `finishReason: 'interrupted'`, not `finishReason: 'error'`.
- **Existing callers unaffected** — the full v4.5 vitest suite
  (3,432 passing) stays green with no edits to call sites that don't
  pass `signal`. Specifically: REPL turn loop, daemon
  `realAgentRunner`, MCP server bridge, CLI commands.
- **Exhaustive-switch audit** — every consumer of `finishReason`
  that exhaustive-switches gains an `interrupted` case (or a
  default that surfaces the value rather than throwing). The prep
  dispatch must include grep evidence of every such switch checked.

### 11.1 Sub-agent tests (Phase 5)

Phase 5 tests will cover, at minimum:

- **Spawn happy path** — parent calls `spawn_sub_agent` with a
  trivial goal; child stub-runner returns a summary; envelope arrives
  with `status: 'completed'`, `summary` populated, metrics non-zero.
- **Schema isolation** — child's tool calls produce `run_events` on
  the CHILD `runs` row, not the parent's. Parent's row's
  `spawned_from_run_id` is NULL; child's row's is the parent's id.
- **Tool blocklist enforcement** — child cannot invoke `spawn_sub_agent`
  (recursive), `clarify`, `memory`, `execute_code`, or `send_message`,
  even if explicitly requested in `toolsets`.
- **Toolset intersection** — child requesting toolsets not enabled on
  the parent gets the intersection. Requesting nothing yields parent's
  full enabled set minus blocklist.
- **maxIterations clamping** — values outside `[1, 200]` are clamped at
  the dispatch boundary, not just at SQL insert.
- **Timeout path** — child that exceeds `timeoutMs` produces
  `status: 'timeout'`, `exitReason: 'timeout'`, with the interrupt flag
  having been set on the child.
- **Cooperative interrupt** — child checks `_interruptRequested`
  between iterations and yields with `status: 'interrupted'` when set.
- **Failure envelope** — child throws → envelope has `ok: false`,
  `status: 'failed'`, `summary: null`, `error` populated. Parent's
  tool dispatch does NOT receive an exception.
- **Result envelope serialization** — envelope round-trips through
  JSON.stringify cleanly, no `undefined` fields, all `null`s explicit.
- **Token / cost rollup** — child's `tokensIn + tokensOut` reflected
  in the parent's session totals after spawn returns.
- **Conversation isolation** — child's system prompt does NOT contain
  parent's conversation history or SOUL.md content. Child agent has
  no access to parent's `messages` array.
- **Synchronous parent block** — parent's `run_conversation` await
  blocks until the envelope arrives; parent does not move to the next
  iteration mid-spawn.
- **No nested spawn** — child attempting to call `spawn_sub_agent` is
  rejected with a clear error envelope (`exitReason: 'error'`).
- **Migration idempotency** — running v6 migration on a database
  already at v6 is a no-op; running on a fresh v5 database adds the
  columns and the index.

Integration tests (Phase 5b) will additionally cover:

- File watcher trigger → daemon-fired turn → parent spawns sub-agent
  → child completes → envelope flows back → parent emits final
  response. Verifies daemon + sub-agent interaction with `daemonApproval`
  policy inheritance.
- REPL session → user prompts a task → parent spawns sub-agent →
  child blocks on approval (counterfactually, in case Phase 5 lifts
  some blocklist entries) → approval lock serialisation works.

Soak / load (Phase 5c, manual):

- 100 sequential parent turns, each spawning one child. Verify zero
  zombie `runs` rows in `running` state, parent memory does not grow,
  no worker leak count > 5.

## 12. Reconciliation with existing `core/v4/subagent/` (Q9)

### Existing surface

`core/v4/subagent/` shipped in v4.1.0 (commit `b51b3346`) and went
public yesterday with the v4.5.0 unfreeze of `origin`. It implements a
**parallel batch fan-out** as an LLM-callable tool named
`subagent_fanout`. Five source files:

| File | Role |
|---|---|
| `core/v4/subagent/fanout.ts` | `runFanout()` orchestrator — `Promise.all` over N children with per-child `AbortSignal` |
| `core/v4/subagent/budget.ts` | Defaults: 90s per-child timeout, 20 iterations per child, max-N=5, default-N=3 |
| `core/v4/subagent/merger.ts` | Four merge strategies: `all` / `vote` / `pick-best` / `combine` |
| `core/v4/subagent/providerRotation.ts` | Round-robin provider selection across N children for diversity |
| `core/v4/subagent/diagnostics.ts` | Build fingerprint `AIDEN_SUBAGENT_BUILD = 'v4.1-subagent.2'` + diagnostics envelope |

Wrapper at `tools/v4/subagent/subagentFanout.ts` exposes it as the
`subagent_fanout` LLM tool. CLI surface at `cli/v4/commands/fanout.ts`
provides a `/fanout` slash command. Test coverage of the orchestrator
is one schema-shape regression test (`tests/v4/subagent/subagentFanout.test.ts`,
64 lines) — no behavioural unit tests.

### Why Phase 1 is additive

The existing code is **wired, shipped, and recently public**.
Modifying its semantics in v4.6 Phase 1 carries three risks the team
does not want to take in a new arc's first phase:

1. **Public surface stability.** `subagent_fanout` is an LLM-callable
   tool name. The model has seen it in many prior sessions; changing
   what calling it does mid-arc invalidates that learned behaviour
   and breaks any third-party plugin / skill / cron that already
   references the tool name.
2. **Behavioural change without test coverage.** With one
   schema-shape regression test and no orchestrator-level tests,
   modifying `fanout.ts` / `merger.ts` / `providerRotation.ts` would
   change behaviour with no regression net underneath.
3. **Scope creep.** Phase 1 is the spawn-primitive contract.
   Refactoring an existing tool to call into that primitive is a
   refactor, not a contract definition.

### Phase 1 → Phase 2 plan

| Phase | Action | Outcome |
|---|---|---|
| **Phase 1 (this doc)** | Build `spawn_sub_agent` as a NEW additive tool. Do not touch `core/v4/subagent/*` files. Do not modify `tools/v4/subagent/subagentFanout.ts`. Do not deprecate. | Two tools coexist in v4.6 Phase 1 ship: `spawn_sub_agent` (new single-child primitive) and `subagent_fanout` (existing parallel batch). Model picks based on N. |
| **Phase 2** | Refactor `subagent_fanout` to call `spawn_sub_agent` N times under `Promise.all`. Migrate budget defaults, envelope semantics, blocklist mechanism, and DB persistence onto the new primitive. Add behavioural tests. | One spawn primitive. `subagent_fanout` becomes a thin wrapper around N×`spawn_sub_agent`. Existing tool name preserved; semantics quietly upgraded. |
| **Phase 3+** | Optionally add deprecation notice on `subagent_fanout` once the wrapper is stable. Recommend `spawn_sub_agent` for single-child cases in the tool description text. No removal in v4.6. | Single canonical primitive recommended; old tool name kept for compatibility. |

### Disposition of the eight Q-decisions vs existing code

For posterity, the conflict surface from Dispatch 1C-PRE:

| Q | Phase 1 (`spawn_sub_agent`) | Existing (`subagent_fanout`) | Phase 2 reconciliation |
|---|---|---|---|
| Q1 tool name | `spawn_sub_agent` | `subagent_fanout` | Both live. Phase 3+ may add description-text recommendation. |
| Q2 sessionId | flat UUID | flat UUID (`randomUUID()`) | Already aligned. |
| Q3 budget defaults | 50 iter / 600s | 20 iter / 90s | Phase 2 unifies; existing defaults may move toward Phase 1 numbers OR remain as the per-fanout-child override (decided in Phase 2 audit). |
| Q4 envelope vs throw | always envelope | throws on validation | Phase 2: wrapper catches; envelope semantics propagate up. |
| Q5 blocklist mechanism | hard-coded enum of 5 tool names | env-flag `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE` + caller-side schema filter | Phase 2: unify on hard-coded blocklist + intersection (Phase 1 model). |
| Q6 DB persistence | `spawned_from_run_id` + `spawned_from_session_id` on `runs` | in-memory only | Phase 2: existing tool gains persistence by going through the new primitive. |
| Q7 workspace | inherit parent's | inherit parent's | Already aligned. |
| Q8 sync only | N=1 sync | sync from parent's POV, N parallel inside | Phase 2: existing tool stays N≥1 but each child path goes through the N=1 primitive. |

### What Phase 1 explicitly does NOT do

- Does NOT modify any file under `core/v4/subagent/`.
- Does NOT modify `tools/v4/subagent/subagentFanout.ts`.
- Does NOT modify `cli/v4/aidenCLI.ts` `subagent_fanout` wiring (lines 1565-1725).
- Does NOT modify `cli/v4/commands/fanout.ts`.
- Does NOT close the existing test coverage gap (one schema-shape
  regression test remains the only test). This is acknowledged debt
  carried into Phase 2.
- Does NOT add deprecation warnings, slash-command nags, or
  description-text recommendations against `subagent_fanout`.

### 12.1 Layered architecture (Phase 2 target)

Phase 2 refactors `subagent_fanout` to layer over `spawn_sub_agent`.
The public schema, return shape, and description text the model
sees are **unchanged** — only internals are replaced. Pre-v4.6
file modules (`merger.ts`, `providerRotation.ts`, `diagnostics.ts`,
`budget.ts`) survive as **fanout-specific layers above the
primitive**; the orchestrator code in `fanout.ts` (the `runFanout`
function + the `spawnOne` helper) gets rewritten to delegate
per-child execution to `spawnSubAgent`.

```
subagent_fanout (tools/v4/subagent/subagentFanout.ts — tool wrapper)
   │
   │  unchanged public schema:
   │    mode, n, query, tasks, merge, timeoutMs
   │
   ▼
runFanout (core/v4/subagent/fanout.ts — orchestrator, REWRITTEN)
   │
   ├─ resolveBudget          (budget.ts — preserved)
   │     → per-child maxIterations + timeoutMs
   │     → outer wallClockCapMs (5× per-child)
   │
   ├─ rotateProviders        (providerRotation.ts — preserved)
   │     → assignments[i] = ProviderOption for child i
   │     → singleProviderWarning flag
   │
   ├─ outer wall-clock AbortController
   │     → setTimeout(cap) cascade to childCtrls
   │     → parentAbort cascade to wallController
   │
   ├─ Promise.all(N × spawnSubAgent(spec, deps, {
   │       signal:   wallController.signal,
   │       provider: assignments[i].providerId,  ← Phase 2a contract ext
   │   }))
   │
   ├─ mergeResults           (merger.ts — preserved)
   │     → strategy: 'all' | 'vote' | 'pick-best' | 'combine'
   │     → optional aggregator LLM pass
   │
   └─ buildDiagnostics       (diagnostics.ts — preserved)
         → build, launched/succeeded/failed counts
         → providerDistribution, singleProviderWarning

      ▼

spawn_sub_agent  (core/v4/subagent/spawnSubAgent.ts — Phase 1 primitive)
   │
   ├─ childBuilder           (childBuilder.ts)
   │     → fresh AidenAgent
   │     → intersected toolset minus blocklist
   │     → cloned FallbackAdapter rate-limit state
   │     → fresh ApprovalEngine with auto-deny callbacks
   │
   ├─ runConversation        (AidenAgent — abort-aware as of fd62f96d)
   │     → child runs to completion or cooperative interrupt
   │     → emits tool_call_started / _completed run_events
   │
   └─ envelope (per §3 schema)
         → status, exitReason, summary, error
         → metrics: apiCalls, durationMs, tokensIn, tokensOut
         → childRunId, childSessionId
```

**Responsibility split:**

| Layer | Responsibility |
|---|---|
| `subagent_fanout` tool wrapper | Validate model args, coerce to `FanoutOptions`, resolve providers + aggregator at call time, return structured `{success, merged, results, diagnostics}` envelope. |
| `runFanout` orchestrator | Sequencing — budget → rotation → outer wall-clock → fan out via primitive → merge → diagnostics. NEVER builds AidenAgents directly anymore. |
| `spawn_sub_agent` primitive | Construct one child, run it, return one envelope. Single point for `runs`-table persistence, observability, blocklist enforcement, rate-limit clone. |

### 12.2 Phase 2a — per-spawn provider override (contract extension)

The faithful refactor (Option B in the Dispatch 2N audit) requires
extending the Phase 1 spawn primitive with a per-spawn provider
override. This unlocks fanout's provider rotation as a layer over
the primitive without forking the child-build code path.

**Spec extension:**

```ts
interface SubAgentSpec {
  goal: string;
  context?: string;
  toolsets?: string[];
  maxIterations?: number;
  timeoutMs?: number;
  /**
   * v4.6 Phase 2a (deferred from §10) — optional per-spawn provider
   * override. When supplied, must name a provider available in the
   * parent's resolved provider pool. When omitted, child inherits
   * the parent's active provider (Phase 1 default — UNCHANGED).
   */
  provider?: string;
}
```

**Childbuilder behavior:**

- `spec.provider` omitted → use `deps.parentProvider` (current Phase 1
  behavior; zero regression for existing callers).
- `spec.provider` supplied → look it up in the parent's provider pool
  (via a new `resolveProviderById(id): ProviderAdapter | null` resolver
  on `ChildBuilderDeps`).
- Resolver returns `null` → **fail loud**, NOT silent fallback.
  Envelope returns `status: 'error'`, `exitReason: 'error'`,
  `error: 'spawn_sub_agent: provider "<name>" not in parent pool'`.
  Fanout's rotation depends on every assignment being honored
  exactly; silent fallback would collapse N children onto one
  provider and defeat the diversity invariant the rotation
  exists to enforce.

**Validation timing:**

- Validation happens inside `childBuilder` AFTER the run row is
  inserted (so the failure shows up as a persisted child row with
  `status='failed'` + an `error` payload, observable via
  `aiden runs show <id>`). The envelope is still well-formed —
  this is just one more `failureEnvelope(...)` path.

**Test cases (Phase 2P):**

- `provider` omitted → child uses parent's adapter (regression test).
- `provider` supplied + present in pool → child uses the resolved adapter.
- `provider` supplied + NOT in pool → envelope `status: 'error'`,
  child run row written with `status='failed'`.
- Fanout layer passes per-child providers → each child uses a
  distinct adapter (integration test against `runFanout`).
- **Legacy env flag honored:** `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1`
  set → child's blocklist drops `execute_code`, retains the other 4
  names (`spawn_sub_agent`, `clarify`, `memory`, `send_message`).
  Without the env flag → full 5-name blocklist applied as default.
  Existing fanout users with the flag in `.env` see no behaviour
  change. Implementation reads the env at `childBuilder` time so
  per-call boot-time `.env` mutations take effect; no per-process
  cache.

### 12.3 Phase 2b/2c — refactor + cleanup sequencing

**2P — Phase 2a contract extension** *(separate dispatch):*

- Add `provider?: string` to `SubAgentSpec` in `core/v4/subagent/spawnSubAgent.ts`.
- Add `resolveProviderById(id): ProviderAdapter | null` to `ChildBuilderDeps`.
- Wire validation + failure envelope in `childBuilder.ts`.
- New tests (4 cases above).
- REPL wiring in `cli/v4/aidenCLI.ts` supplies the resolver from the
  parent's FallbackAdapter's slot list (so REPL parent + fanout layer
  both reach the same provider pool).

**2Q — Refactor `runFanout`** *(separate dispatch, depends on 2P):*

- Inside `core/v4/subagent/fanout.ts`, replace `spawnOne(...)` calls
  with `spawnSubAgent(spec, deps, ctx)` calls.
- Each fanout child's `spec` carries:
  - `goal` (from per-child prompt — ensemble query or partition task.goal)
  - `maxIterations: budget.maxIterations` (preserves fanout's 20-iter default)
  - `timeoutMs: budget.perSubagentTimeoutMs` (preserves fanout's 90s default)
  - `provider: rotation.assignments[i].providerId` (the rotation pick)
- Each fanout child's `ctx` carries:
  - `signal: wallController.signal` (so outer wall-clock cap cascades)
  - `parentRunId` / `parentSessionId` (whatever the fanout layer is given)
- Map each `SubAgentResult` envelope → fanout's existing `SubagentResult`
  shape (small adapter; keeps merger.ts happy without changes).
- New behavioral tests (Dispatch 2N flagged this as the test-coverage
  gap): ensemble end-to-end, partition end-to-end, each merge strategy,
  singleProviderWarning trip, outer wall-clock cap, parent abort.
- **Runs-list filtering tests (per §12.4 hide-by-default decision):**
  - `aiden runs list` default → returns only top-level rows
    (`WHERE spawned_from_run_id IS NULL`); fanout children excluded.
  - `aiden runs list --include-children` → flat view, all rows
    visible including fanout children. Order preserved by `started_at`.
  - **Child-count badge** on parent row in default output:
    parent row carries `child_count` + `child_succeeded` aggregates
    populated by a `LEFT JOIN ... GROUP BY` on `spawned_from_run_id`.
    Format: `"Run #5 (fanout, 5 children, 4 succeeded)"`.
  - `aiden runs show <parent-id>` → parent detail + inline child
    summary list (one line per child: id, status, exitReason,
    durationMs, summary preview).
  - `aiden runs show <child-id>` direct access by ID → unchanged
    (already works in v4.6 Phase 1; just no longer dead-link in
    the default listing).
  - Top-level run that is NOT a fanout parent (REPL turn, daemon
    trigger fire) → badge absent, default output unchanged from
    Phase 1.

**2R — Cleanup** *(separate dispatch, depends on 2Q):*

- Delete `spawnOne(...)` (now unused).
- Delete any orphaned helpers in `fanout.ts` (the per-child agent
  construction code that `spawnOne` used — `_build_child_agent`-style
  internals).
- Verify no other module imports the deleted symbols.
- The four pre-v4.6 modules survive: `budget.ts`, `diagnostics.ts`,
  `merger.ts`, `providerRotation.ts` (all preserved as layers).
- `fanout.ts` shrinks from 328 LOC to ~150 LOC (delete ~180 LOC of
  duplicated agent-construction code).

### 12.4 Behavioral changes locked in

The Phase 2 refactor preserves the **public API** (model-facing
schema, tool name, return shape) but **changes some internals**.
Documenting these explicitly so 2Q's smoke test doesn't surprise
operators who relied on the v4.1.0 behaviour.

| Concern | Pre-Phase 2 (v4.1.0–v4.6 Phase 1) | Post-Phase 2 |
|---|---|---|
| **Persistence** | None — `runFanout` returned results in-memory; no `runs` row, no `run_events`. | Each fanout child writes a `runs` row via `spawn_sub_agent`'s primitive path. N children = N child rows linked to the parent's run row (when present) via `spawned_from_run_id`. Visible to `aiden runs list / show`. |
| **Observability** | `logger.info` on launch + complete; no per-tool-call event stream. | Per-tool-call `tool_call_started` / `tool_call_completed` run_events on each child's runs row (the Dispatch 2K wiring). `aiden trigger logs` / direct DB queries surface child behaviour. |
| **Tool blocklist with legacy escape hatch** | Env-flag `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE` + caller-side schema filter in `subagentFanout.ts`. | Hard-coded 5-name blocklist (`spawn_sub_agent`, `clarify`, `memory`, `execute_code`, `send_message`) enforced inside `childBuilder.ts` by default. **`AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1` is HONORED as a backward-compat escape hatch** — when set, `execute_code` is removed from the blocklist for that session; the other 4 names remain blocked. Zero-risk preservation of any user's existing `.env` workflow. May be removed in v4.7 if telemetry/feedback shows zero usage. Documented in release notes as a quiet preservation, not a feature. |
| **Budget defaults** | `runFanout` resolved budget via `resolveBudget()` — 20 iter / 90s per child / 5× wall-clock cap. | Fanout's `runFanout` STILL resolves budget the same way (`budget.ts` preserved) and STILL passes those values explicitly to `spawnSubAgent` as `maxIterations` / `timeoutMs`. The primitive's own defaults (50 iter / 600s) are NOT inherited — fanout's tighter snug defaults are preserved. |
| **`FallbackAdapter.clone()`** | Mentioned in `fanout.ts` docstring but never actually called in production (Dispatch 2D-PRE audit). Children shared mutable rate-limit state with the parent. | Each child gets a real `.clone()` via `spawnSubAgent`'s `childBuilder` (Dispatch 2E). Per-child 429 no longer collapses the parent's quota tracking. Genuine isolation, not aspirational. |
| **Wall-clock outer cap** | `runFanout` set `wallClockCapMs = 5 × perSubagentTimeoutMs` via outer AbortController. | Preserved — `runFanout` keeps the outer cap and passes `wallController.signal` to each `spawnSubAgent` call's `ctx.signal`. Cascade semantics from the primitive's cooperative-cancellation path. |
| **Provider rotation diversity** | `rotateProviders` returned `assignments[i] = ProviderOption` and `runFanout` built each child with that adapter. | Preserved via the Phase 2a contract extension — `spec.provider: assignments[i].providerId` per child. `singleProviderWarning` still fires when rotation collapses to one provider's slots. |
| **Merge strategies** | `mergeResults({ strategy: 'all' \| 'vote' \| 'pick-best' \| 'combine' })`. | Preserved — `merger.ts` untouched. Aggregator LLM passes still happen for `vote`/`pick-best`/`combine`. `'all'` (FREE option) returns raw N envelopes. |
| **Concurrency** | `Promise.all` over N children. | Same — `Promise.all` over N `spawnSubAgent` calls. |
| **Approval engine in child** | Children inherited parent's approval engine indirectly (toolExecutor was shared). | Each child gets a fresh `ApprovalEngine('smart')` with auto-deny `promptUser` callback (Dispatch 2E pattern). No interactive prompting in fanout children either. Mostly invisible — fanout children never reached interactive prompt path in practice. |

**Aiden `runs list` behavior (v4.6 → Phase 2).** Before Phase 2,
fanout children were in-memory only and invisible to `aiden runs
list`. Post-Phase 2 each fanout child writes its own runs row linked
via `spawned_from_run_id`. To prevent the default `runs list` output
from ballooning (5 fanout calls → 25 extra rows), **children are
hidden by default**. The parent run row shows a child-count badge
in default output, e.g.:

```
Run #5  (fanout, 5 children, 4 succeeded)
Run #6  (REPL turn)
Run #7  (trigger: file, 1 child)
```

Operator escape hatches when full detail is needed:

- `aiden runs list --include-children` — flat view, every child row visible alongside parents
- `aiden runs show <parent-id>` — parent detail PLUS each child's summary inlined
- `aiden runs show <child-id>` — direct access by ID (always works)

**Implementation note for Dispatch 2Q:** filter at the SQL layer
(`WHERE spawned_from_run_id IS NULL` in the default `listRecent`
query, lifted to `IS NULL OR include_children` when the flag is
set). Push the child-count badge in via a `LEFT JOIN ... GROUP BY`
on parent → child count + success count. Scales to thousands of
children without display-layer filtering overhead.

Recommend documenting the hide-by-default behaviour + escape hatches
in the v4.6 release notes ahead of ship — operators tail-following
`runs list` need to know children exist (the badge tells them) but
also need to know how to drill in.

---

**Implementation begins in Phase 2.** Phase 1 (this document + the
schema migration in `core/v4/daemon/db/schema/v6.sql`) is the locked
contract that Phase 2 implements against.
