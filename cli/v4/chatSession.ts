/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/chatSession.ts — Aiden v4.0.0 (Phase 14c)
 *
 * Interactive chat REPL. Replaces the Phase 1 stub. Drives an `AidenAgent`
 * end-to-end:
 *
 *   1. Boots a (or resumes an existing) `SessionRecord`.
 *   2. Renders the boxed startup card (per AGENTS.md "v4 CLI UX" spec).
 *   3. Reads user input — slash commands route through the registry,
 *      everything else feeds into `AidenAgent.runConversation()`.
 *   4. Persists each turn via `SessionManager.recordTurn()`.
 *   5. Re-renders the status line after every turn.
 *
 */

import type { AidenAgent } from '../../core/v4/aidenAgent';
import { buildTurnRuntimeContext } from '../../core/v4/turnRuntimeContext';
import { computeTaskFinalization } from '../../core/v4/taskVerification';
// v4.1.5+ Path A: env-var-gated loop trace logger. Captures tool-call
// sequence + system prompt + memory hashes when a turn shows loop
// symptoms (10+ calls OR 5+ consecutive same-name). Default off via
// `AIDEN_DEBUG_LOOP=1` env-var. Zero overhead when disabled.
import { LoopTracer } from '../../core/v4/loopTrace';
import type { Display } from './display';
import { summarizeChannelState, verbForActivity } from './display';
// v4.10 Slice 10.7a — REPL-sacred defense-in-depth flag. Wired here so
// any future stdout/stderr sink that wants to honor the
// "user-is-typing" invariant can check isReplActive(). Pairs with the
// StderrSink removal from cli-interactive in core/v4/logger/factory.ts.
import { markReplActive, markReplInactive } from '../../core/v4/logger/factory';
// v4.1.4 Part 1.6 — per-turn token progress bar. Fed by `onProgress`
// events from the streaming adapter; hidden when the adapter doesn't
// emit progress (honest degradation).
import { createProgressBar } from './display/progressBar';
import type { TelegramAdapter } from '../../core/channels/telegram';
import type {
  CommandRegistry,
  ChatSessionLike,
  SlashCommand,
} from './commandRegistry';
import { uiIconsEnabled, isNoUiMode } from './uiBuild';
import {
  shouldAutoSummarize,
  memoryGrewBetween,
  SESSION_SUMMARY_MIN_TURNS,
} from './sessionSummaryGate';
import aidenPrompt, { type SlashCommandLite } from './aidenPrompt';
import { runConfirm } from './confirmPrompt';
import { renderGreeter } from './greeter';
import { appendHistory, loadRecent } from './historyStore';
import type { CliCallbacks } from './callbacks';
import type { SessionManager } from '../../core/v4/sessionManager';
import type { ContextCompressor } from '../../core/v4/contextCompressor';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type { ApprovalEngine } from '../../moat/approvalEngine';
import type { McpClient } from '../../core/v4/mcpClient';
import type { SkinEngine } from './skinEngine';
import type { ToolRegistry } from '../../core/v4/toolRegistry';
import type { SkillLoader } from '../../core/v4/skillLoader';
import type { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import type { ConfigManager } from '../../core/v4/config';
import type { PersonalityManager } from '../../core/v4/personality';
import type { PluginLoader } from '../../core/v4/plugins/pluginLoader';
import { ModelMetadata } from '../../core/v4/modelMetadata';
import type { Message } from '../../providers/v4/types';
// v4.1.3-prebump: classify provider errors so the catch path can show
// a tailored action hint (e.g. groq 413 → "switch to chatgpt-plus")
// instead of the generic "/model or aiden doctor" line.
import {
  classifyProviderError,
  suggestForErrorClass,
} from '../../providers/v4/errors';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';
import {
  distillSession,
  type SessionExitPath,
  type SessionDistillation,
} from '../../core/v4/sessionDistiller';
import { renderSessionEndCard } from './display/sessionEndCard';
import { VERSION as AIDEN_VERSION } from '../../core/version';
import { writeDistillation } from '../../core/v4/distillationStore';
import { extractCandidates } from '../../core/v4/promotionCandidates';
import {
  promptForApproval,
  writeApprovedDurableFacts,
  readExistingDurableFactsBody,
} from './promotionPrompt';
import path from 'node:path';
import {
  enableBracketedPaste,
  disableBracketedPaste,
  decidePasteBootAction,
  stripPasteMarkers,
  stripAllPasteMarkers,
  isCompletePaste,
  hasPasteMarkers,
} from './bracketedPaste';
import { compressPaste } from './pasteCompression';
import { installPasteInterceptor, expandPasteLabels } from './pasteIntercept';
// v4.9.0 Slice 1a — theme hot-reload watcher.
import { startThemeWatcher, stopThemeWatcher } from '../../core/v4/theme/themeWatcher';
import { expand, hasInterpolation, countSpans } from './shellInterpolation';
import { installResizeGuard } from './resizeGuard';
// v4.10 Slice 10.2b — shared event taxonomy. UI tool name → (category, kind).
import { categorizeEvent } from '../../core/v4/daemon/eventCategories';
import { captureArtifactFromTrace } from '../../core/v4/daemon/artifactStore';
// v4.12.1 Pillar 4 Slice 2a — type-next-while-busy.
import { DuringTurnInput, type BusyEnterMode } from './duringTurnInput';
import { attachTurnInputListener } from './turnInputListener';
import { requestTurnCancel } from './frame/interruptControls';

/**
 * v4.10 Slice 10.2 / 10.2b — extracted onUiEvent factory. Builds the
 * per-turn closure that chatSession.runAgentTurn passes to the agent's
 * runConversation. Production calls this from inline at the dispatch
 * site (no shortcut); the integration test in
 * tests/v4/cli/chatSessionUiPersist.test.ts drives THIS helper with
 * controlled stubs to assert the persistence wire fires. Same
 * mock-blindness fix shape as Slice 10.1b's createBootMemoryManager:
 * test the real construction code path, not a hand-rolled equivalent.
 *
 * Three side effects (in order):
 *   1. stopIndicator() — kill the "provider calling" spinner so the
 *      painted ui row lands cleanly below it.
 *   2. display.renderUiEvent(name, args) — TTY-gated render.
 *   3. runStore.emitEventRich(...) — durable persistence with the
 *      Slice-10.2b (category, kind, name) taxonomy. Gated on runStore
 *      + runId being present. try/catch so a DB fault never breaks
 *      dispatch.
 *
 * Non-TTY note: renderUiEvent early-returns when !out.isTTY but the
 * persistence step still runs. Matches v4.9.3 Slice 1b discipline
 * (render off, persistence on).
 */
export interface OnUiEventDeps {
  display:            { renderUiEvent(name: string, args: Record<string, unknown>): void };
  /**
   * Slice 10.2b — the handler now writes the rich-shape row via
   * emitEventRich so trace_query can filter on category/kind/name.
   * Legacy emitEvent stays on the RunStore interface for non-UI
   * callers; this helper opts into the new path.
   */
  runStore:           { emitEventRich(opts: import('../../core/v4/daemon/runStore').EmitEventOptions): number } | undefined;
  runId:              number | null;
  /** Slice 10.2b — REPL session id, threaded through so the rich row
   *  gets session_id populated without the writer having to JOIN
   *  back to runs on every call. */
  sessionId?:         string | null;
  stopIndicatorOnce:  () => void;
  /**
   * v4.13 Gap 1 — collector for the model's own ui_task_done declaration
   * (its `status` payload). The verify-before-done gate reads the LAST
   * declaration at turn end: a model-declared failure finalizes the task
   * row as `failed` honestly instead of letting a clean finishReason
   * upgrade it to completed. Optional — render + persistence unchanged
   * when absent.
   */
  onTaskDone?:        (args: Record<string, unknown>) => void;
}
export function createOnUiEventHandler(
  deps: OnUiEventDeps,
): (name: string, args: Record<string, unknown>) => void {
  return (name, args) => {
    if (name === 'ui_task_done' && deps.onTaskDone) {
      try { deps.onTaskDone(args); } catch { /* collector must never break dispatch */ }
    }
    deps.stopIndicatorOnce();
    deps.display.renderUiEvent(name, args);
    if (deps.runStore && deps.runId !== null) {
      try {
        // Slice 10.2b — map the UI tool name through the shared
        // categoriser so daemon and REPL emitters share one taxonomy
        // source. `source='repl'` distinguishes this from daemon-fired
        // emissions of the same kind.
        const tags = categorizeEvent(name);
        deps.runStore.emitEventRich({
          runId:     deps.runId,
          category:  tags.category,
          kind:      tags.kind,
          name,
          sessionId: deps.sessionId ?? null,
          payload:   args,
          visibility:'model',
          source:    'repl',
        });
      } catch { /* persistence faults must never break dispatch */ }
    }
  };
}

/**
 * Phase v4.1.2 session-summary-followup: parse the auxiliary client's
 * JSON-array response into a clean `string[]` of bullets. Defensive —
 * tries direct JSON.parse first, then a fenced-code-block strip, then
 * a "first [...] block" extraction. Returns null when nothing usable
 * comes out so the caller can retry once with a stricter prompt.
 *
 * Exported for unit tests.
 */
export function parseSessionBulletsResponse(raw: string): string[] | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const tryParseArray = (s: string): string[] | null => {
    try {
      const parsed = JSON.parse(s);
      if (!Array.isArray(parsed)) return null;
      const strings = parsed
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
      return strings.length > 0 ? strings : null;
    } catch {
      return null;
    }
  };

  // 1. Try the response as-is.
  const direct = tryParseArray(raw.trim());
  if (direct) return direct;

  // 2. Strip Markdown code fences if present (```json ... ``` or ``` ... ```).
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    const inFence = tryParseArray(fenceMatch[1].trim());
    if (inFence) return inFence;
  }

  // 3. Extract the first balanced [...] block from anywhere in the text.
  const bracketStart = raw.indexOf('[');
  const bracketEnd   = raw.lastIndexOf(']');
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    const slice = raw.slice(bracketStart, bracketEnd + 1);
    const extracted = tryParseArray(slice);
    if (extracted) return extracted;
  }

  return null;
}

/**
 * Tier-3.1 helper: render a slash-command label honouring the
 * `AIDEN_UI_ICONS` opt-in. Default OFF — emoji icons are gated to
 * keep the dropdown ASCII-clean for terminals without good emoji
 * support. `AIDEN_UI_ICONS=1` recovers the previous icon column.
 */
export function renderCommandLabel(cmd: SlashCommand): string {
  return cmd.icon && uiIconsEnabled()
    ? `${cmd.icon} /${cmd.name}`
    : `/${cmd.name}`;
}

// Phase v4.1.2-version-display: AIDEN_VERSION is now imported at the
// top of the file from `core/version.ts` (the canonical build-injected
// source). The previous package.json runtime-require IIFE that lived
// here was replaced — single source of truth, no JSON resolution
// wobble. The version is surfaced on the boot card status pills row
// so users see what they're running without invoking `aiden --version`.

/** Lightweight readline / inquirer abstraction so tests can swap in stubs. */
export interface ChatPromptApi {
  /**
   * Reads a free-form line of user input. Returns the raw string.
   *
   * `opts.suggestionsDisabled` (v4.9.2 Slice 3): when true, the call
   * MUST route through a plain inquirer input — no ghost-text from
   * the outer chat history, no slash-command dropdown. Confirmation
   * prompts pass this; outer chat read loops do not.
   */
  readLine(
    prompt: string,
    opts?: { suggestionsDisabled?: boolean },
  ): Promise<string>;
  /** Slash-command dropdown: returns the selected `/name` string,
   *  or `null` to cancel and fall back to free-form input. */
  selectSlashCommand(
    source: (input: string | undefined) => Promise<
      Array<{ name: string; value: string; description?: string }>
    >,
  ): Promise<string | null>;
}

export interface ChatSessionOptions {
  agent: AidenAgent;
  display: Display;
  commandRegistry: CommandRegistry;
  callbacks: CliCallbacks;
  sessionManager: SessionManager;
  compressor?: ContextCompressor;
  auxiliaryClient?: AuxiliaryClient;
  approvalEngine: ApprovalEngine;
  mcpClient?: McpClient;
  skin: SkinEngine;
  toolRegistry: ToolRegistry;
  skillLoader: SkillLoader;
  resolver: RuntimeResolver;
  config: ConfigManager;
  /**
   * Phase v4.1.2 session-summary-followup: needed so the auto-summary
   * on /quit can bypass the main agent loop and write MEMORY.md
   * deterministically via the existing tool + guard.
   */
  memoryManager?: import('../../core/v4/memoryManager').MemoryManager;
  memoryGuard?:   import('../../moat/memoryGuard').MemoryGuard;

  /** Provider/model the session boots with. */
  initialProviderId: string;
  initialModelId: string;
  /**
   * v4.1.3-prebump — which providerBootSelector precedence case
   * produced (initialProviderId, initialModelId). Surfaced in the
   * boot card so users can tell whether they're on a persisted
   * choice, an auto-pick, or the legacy hardcoded fallback.
   */
  initialBootSource?:
    | 'cli-flag'
    | 'persisted-config'
    | 'auto-priority'
    | 'cli-flag-partial'
    | 'config-partial'
    | 'hardcoded-fallback';

  /** Phase 16b.1: optional FallbackAdapter for /providers diagnostics. */
  fallbackAdapter?: import('../../core/v4/providerFallback').FallbackAdapter | null;

  /** Phase 16b.3: resolved Aiden user-data paths (forwarded to /identity). */
  paths?: import('../../core/v4/paths').AidenPaths;

  /** Phase 16b.4: personality overlay manager (forwarded to /personality + /debug-prompt). */
  personalityManager?: PersonalityManager;

  /** Phase 17 Task 5: forwarded to /plugins commands. */
  pluginLoader?: PluginLoader;

  /** Optional: resume an existing session id. */
  resumeSessionId?: string;
  /** Pre-loaded history when resuming. */
  resumeHistory?: Message[];

  /** YOLO mode override — flips approvalEngine to 'off' at boot. */
  yoloMode?: boolean;

  /** Optional injected prompt API (for tests). */
  promptApi?: ChatPromptApi;

  /** Optional injected metadata helper (for tests). */
  modelMetadata?: ModelMetadata;

  /** Disable SIGINT handler — tests don't want their runner to get killed. */
  installSignalHandler?: boolean;

  /**
   * Optional cap on REPL iterations. Tests pass a small integer so
   * `run()` returns; production omits and the loop is unbounded.
   */
  maxIterations?: number;

  /**
   * Phase 30.2.1 — explore mode. True when the setup wizard returned
   * status 'skipped' (recovery option [4] or wizard cancellation), so
   * the agent's adapter is a `NullAdapter`. Slash commands run normally;
   * any non-slash input is intercepted by `runAgentTurn` and surfaces
   * the friendly "no provider configured" message instead of calling
   * the agent loop.
   *
   * The boot card also keys off this flag — `providerOk` is passed as
   * `false` so the model pill renders "not configured" instead of a
   * stale model id from DEFAULT_CONFIG.
   */
  unconfigured?: boolean;

  /**
   * Phase v4.1-1.1 — live ChannelManager hosted by the CLI process.
   * Threaded through to /channel slash commands so they can list,
   * add, remove, and inspect adapters without HTTP-hopping to a
   * separate API server.
   */
  channelManager?: import('../../core/channels/manager').ChannelManager;

  /**
   * v4.12 /commands slice — change Aiden's working directory. aidenCLI wires
   * this to `process.chdir()` + live tool-executor `ctx.cwd` patch + sandbox
   * config invalidation, so `/home <path>` actually takes effect. Absent in
   * contexts that can't change cwd.
   */
  setWorkingDir?: (absPath: string) => void;

  /**
   * v4.12 PM.1 — background-process registry. Reaped (cleanup → tree-kill all
   * tracked spawns) on session-end / signal shutdown so nothing is orphaned.
   */
  processRegistry?: import('../../core/v4/processRegistry').ProcessRegistry;

  /**
   * v4.6 Phase 2Q-B — REPL parent-run wiring.
   *
   * When supplied, each REPL turn inserts a `runs` row (status:
   * 'running') before dispatching `agent.runConversation(...)` and
   * updates it to 'completed' / 'failed' / 'interrupted' on return.
   *
   * The mutable `replParentRunRef` is shared with the spawn /
   * fanout tool factories in `cli/v4/aidenCLI.ts`: each factory's
   * `resolveParentRunId` / `resolveParentSessionId` callback reads
   * the ref's current value at dispatch time, so children spawned
   * mid-turn get `spawned_from_run_id` populated to the live REPL
   * parent row's id (instead of the NULL we shipped pre-2Q-B).
   *
   * All three fields are OPTIONAL — tests / test stubs that don't
   * wire a daemon DB skip the persistence path entirely. The runStore
   * write itself is best-effort; a write failure logs a warning and
   * the REPL continues — never blocks user-facing turns.
   */
  replRunStore?:    import('../../core/v4/daemon/runStore').RunStore;
  replInstanceId?:  string;
  /**
   * v4.10 Slice 10.8 — durable Task-lite store. Optional for tests +
   * for any caller that opts out of the task substrate (daemon-only
   * runtimes, headless harnesses). When wired, `runAgentTurn` auto-
   * creates a task per user message, transitions status on
   * success/failure, and appends emitted run_event ids to traceIds.
   */
  replTaskStore?:   import('../../core/v4/daemon/taskStore').TaskStore;
  /**
   * v4.11 — artifact registry. When wired, `runAgentTurn` captures files
   * this turn produced (successful, verifier-ok file-producing tools) from
   * the toolCallTrace, with provenance back to the run + task. Optional,
   * same as replTaskStore.
   */
  replArtifactStore?: import('../../core/v4/daemon/artifactStore').ArtifactStore;
  /**
   * v4.10 Slice 10.2c — `chatSessionId` is the long-lived REPL session
   * id, written ONCE during run() init (after resumeSessionId resolves)
   * and never cleared between turns. Read surfaces like /trace recent
   * and trace_query need this — the turn-scoped `sessionId` field
   * above gets nulled on turn completion and breaks between-turn reads.
   */
  replParentRunRef?: {
    runId:         number | null;
    sessionId:     string | null;
    chatSessionId: string | null;
  };
}

const STATUS_BAR_WIDTH = 10;

/**
 * Phase v4.1.2-memory-AB: hard cap on the session distillation
 * auxiliary call. Default 4000 ms — comfortable headroom for
 * chatgpt-plus (typical ~1-2s), generous for groq (typical <1s).
 * Override via `AIDEN_SUMMARY_TIMEOUT_MS` env var for power users.
 * Above this we abandon the LLM half (still write a deterministic-
 * only distillation so the session isn't lost) and exit honestly.
 */
/**
 * v4.1.3-essentials distillation-fix: bumped 4000 → 12000ms in
 * lockstep with `sessionDistiller.DEFAULT_TIMEOUT_MS`. Same
 * rationale — chatgpt-plus Codex cold-start latency for 800-token
 * summaries regularly exceeds 4s, killing the distillation +
 * promotion-prompt path. Env override `AIDEN_SUMMARY_TIMEOUT_MS`
 * still respected.
 */
const SUMMARY_TIMEOUT_MS_DEFAULT = 12_000;

// v4.11 Slice 1 — streaming delta coalescer (logic layer). The first
// delta of each stream segment paints immediately (TTFT untouched);
// subsequent deltas batch until STREAM_COALESCE_MS elapses OR
// STREAM_COALESCE_MAX_CHARS accumulate, then flush as one streamPartial
// write. Cuts ~124 per-token writes on a fast provider to ~15-25
// flushes. Tunable here. The render layer (streamPartial /
// tryRerenderInPlace) is intentionally NOT touched.
const STREAM_COALESCE_MS = 33;
const STREAM_COALESCE_MAX_CHARS = 256;

function resolveSummaryTimeoutMs(): number {
  const raw = process.env.AIDEN_SUMMARY_TIMEOUT_MS;
  if (!raw) return SUMMARY_TIMEOUT_MS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SUMMARY_TIMEOUT_MS_DEFAULT;
}

/**
 * v4.1.3-prebump: map a providerBootSelector precedence-case label to
 * a human-readable hint rendered under the boot card's status pills.
 *
 * Returns `null` for the explicit-selection cases (`cli-flag`, with-or-
 * without -partial) where the source isn't surprising. Annotates the
 * persisted-config / auto-priority / hardcoded-fallback paths so users
 * understand "why this provider, why now".
 *
 * Pure helper — exported for unit testing.
 */
export function bootSourceLabel(
  source:
    | 'cli-flag'
    | 'persisted-config'
    | 'auto-priority'
    | 'cli-flag-partial'
    | 'config-partial'
    | 'hardcoded-fallback'
    | undefined,
): string | null {
  switch (source) {
    case 'persisted-config':
      return '(persisted from prior session — /model to change)';
    case 'config-partial':
      return '(partial config + auto-resolved companion)';
    case 'auto-priority':
      return '(auto-picked — first authed provider)';
    case 'hardcoded-fallback':
      return '(no authed providers — using legacy default)';
    case 'cli-flag':
    case 'cli-flag-partial':
      // Explicit CLI override — user knows why; no annotation.
      return null;
    default:
      return null;
  }
}

export class ChatSession implements ChatSessionLike {
  history: Message[] = [];
  private sessionId: string | null = null;
  private currentProviderId: string;
  private currentModelId: string;
  private totalUsage = { inputTokens: 0, outputTokens: 0 };
  private startedAt = Date.now();
  private queuedSystemPrompts: string[] = [];
  private modelMetadata: ModelMetadata;
  /**
   * Phase 22 Task 4: status-bar right-most segment state. `'ready'`
   * when idle; `'generating'` while a turn is in flight (rendered as
   * `⏵ <duration>`). `'exec'` / `'approve'` / `'retry'` are wired up
   * in Group C as /doctor + approval boxing lands; the field is
   * here so the status formatter can render them today.
   */
  private statusState: StatusState = { kind: 'ready' };

  // Phase 23.6 — v3-style turn-footer state.  Tracks the most-recent
  // turn's elapsed ms (rendered in the trailing footer) and the
  // provider used last turn (so a switch surfaces as `groq ──→ together`).
  private lastTurnElapsedMs = 0;
  // v4.8.0 Slice 7 — status-footer telemetry. turnCount increments on
  // every completed turn (success OR failure paths); lastTurnOutcome
  // maps result.finishReason to a colour-kind hint for the state dot.
  private turnCount = 0;
  private lastTurnOutcome: 'ok' | 'warn' | 'error' | 'muted' = 'ok';
  private lastFooterProvider: string | null = null;

  /**
   * Phase v4.1.2-memory-AB:
   * Accumulated tool-call trace across every `runConversation` call
   * in this ChatSession instance. Fed to the session distiller at
   * exit to derive deterministic fields (files_touched, tools_used).
   * Reset only when ChatSession itself is re-instantiated.
   */
  private sessionToolTrace: HonestyTraceEntry[] = [];

  /**
   * Phase v4.1.2-memory-AB:
   * Idempotency flag. Set ONLY after a successful summary write
   * (verified-on-disk via MemoryGuard). A failed or timed-out attempt
   * leaves this `false` so the next exit path retries — matches the
   * "honest by design / best-effort, log clearly" stance.
   * Scoped to ChatSession instance lifetime (no DB persistence).
   */
  private summarized = false;

  /**
   * v4.10 Slice 10.9 — one-shot guard for the streaming-disabled
   * disclosure. Flipped to true the first time runAgentTurn observes
   * `display.streaming: false` in config; subsequent turns within
   * the same session skip the warning so the user sees it exactly
   * once per launch. Matches the Slice 10.7 `/channel telegram
   * remove` shell-env-hint pattern: surface state Aiden can't
   * silently fix for the user.
   */
  private streamingDisabledWarned = false;

  /**
   * Phase v4.1.2-memory-D:
   * Last successful distillation, cached so the promotion-prompt flow
   * (`/quit` path only — SIGINT/SIGTERM skip) can extract candidates
   * without re-driving the auxiliary LLM. Mirrors `summarized` —
   * populated alongside it after a verified write.
   */
  private lastDistillation: SessionDistillation | null = null;
  /**
   * Absolute path the most recent distillation JSON was written to.
   * Captured at write-time and surfaced in the session-end card so the
   * user has a concrete artifact to inspect or feed to recall_session.
   * Null when the write failed or no distillation has been produced.
   */
  private lastDistillationPath: string | null = null;

  /**
   * v4.11 Slice 3 — mid-turn cancel state.
   *
   * `currentAbortController`: per-turn AbortController. Non-null ONLY
   * while a turn is in flight (`runAgentTurn` constructs at entry,
   * clears in finally). Read by the SIGINT dispatcher to decide
   * between "abort the active turn" vs "graceful shutdown the REPL".
   *
   * `lastInterruptAt`: timestamp of the most recent first-press Ctrl+C
   * during an active turn. Used to drive the two-press force-exit
   * window (default 2s). Reset to 0 on turn settle and on window
   * expiry so a stale first-press doesn't fast-path the next turn.
   *
   * `activeTurnId` / `nextTurnId`: monotonic per-turn id stamped on
   * callback closures so late stream/tool events from a cancelled
   * turn drop silently instead of painting into the next turn.
   * R1 Tier-1 mitigation per the Phase A audit. Flat fields by design
   * — the full TurnState refactor is a separate slice.
   *
   * `FORCE_EXIT_WINDOW_MS`: the window during which a second Ctrl+C
   * is interpreted as "force exit the REPL" rather than "cancel a
   * second turn". 2000ms matches the audit's A6.2 default.
   */
  private currentAbortController: AbortController | null = null;
  private lastInterruptAt = 0;
  private activeTurnId:   number | null = null;
  private nextTurnId      = 0;

  /**
   * v4.12.1 Pillar 4 Slice 2a — the during-turn input controller: owns the
   * type-next queue + the busy-Enter mode. Fed by the raw-mode keypress
   * listener attached for the duration of each turn.
   */
  private readonly duringTurnInput = new DuringTurnInput();

  // ── Slice 2a public surface for /busy + /queue commands ──────────────────
  setBusyMode(mode: BusyEnterMode): void { this.duringTurnInput.setMode(mode); }
  getBusyMode(): BusyEnterMode { return this.duringTurnInput.getMode(); }
  listQueue(): string[] { return this.duringTurnInput.peek(); }
  clearQueue(): number { return this.duringTurnInput.clear(); }
  queueCount(): number { return this.duringTurnInput.count(); }

  /**
   * v4.11 Slice B — bounded per-turn history snapshot stack for /undo.
   * A copy of `history` is pushed at the start of each turn (capped at
   * UNDO_MAX_SNAPSHOTS, oldest dropped). In-memory only.
   */
  private static readonly UNDO_MAX_SNAPSHOTS = 20;
  private undoStack: Message[][] = [];
  private static readonly FORCE_EXIT_WINDOW_MS = 2000;

  constructor(private opts: ChatSessionOptions) {
    this.currentProviderId = opts.initialProviderId;
    this.currentModelId = opts.initialModelId;
    this.modelMetadata = opts.modelMetadata ?? new ModelMetadata();
    // ★ SH.1 — yoloMode reflects the user's --yolo flag → user-initiated, so it
    // still applies after the engine is frozen at boot.
    if (opts.yoloMode) opts.approvalEngine.setMode('off', { userInitiated: true });
    if (opts.resumeHistory) this.history = [...opts.resumeHistory];
  }

  // ── ChatSessionLike API ────────────────────────────────────────────
  setHistory(messages: Message[]): void {
    this.history = messages;
  }
  clearHistory(): void {
    this.history = [];
    // v4.11 Slice B — a full wipe invalidates the per-turn undo stack;
    // resurrecting pre-clear turns via /undo would be surprising.
    this.undoStack = [];
  }
  /**
   * v4.11 Slice B — restore the history captured before the most recent
   * turn (in-memory only). Returns false when there's nothing to undo.
   * The persisted session (`SessionManager.recordTurn`) is intentionally
   * NOT reverted — resuming a saved session restores full history.
   */
  undoLastTurn(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    this.history = snapshot;
    return true;
  }
  /**
   * v4.11 Slice C — recover the last turn's user prompt, then revert to
   * before that turn (reusing the /undo snapshot stack). Returns the
   * prompt text for the caller to re-dispatch, or null when there is no
   * prior turn (empty stack) or the last prompt is unrecoverable
   * (non-string / empty content). Memory writes are NOT reverted — same
   * in-memory-only contract as /undo.
   */
  retryLastTurn(): string | null {
    if (this.undoStack.length === 0) return null;
    // The most recent user message is the last turn's prompt (each turn
    // adds exactly one role:'user' message at its start).
    const lastUser = [...this.history]
      .reverse()
      .find((m) => m.role === 'user' && typeof m.content === 'string');
    if (!lastUser || typeof lastUser.content !== 'string' || lastUser.content.length === 0) {
      return null;
    }
    const input = lastUser.content;
    this.undoLastTurn();
    return input;
  }
  getCurrentProvider(): string {
    return this.currentProviderId;
  }
  getCurrentModel(): string {
    return this.currentModelId;
  }
  getSessionId(): string | undefined {
    return this.sessionId ?? undefined;
  }
  getTotalUsage(): { inputTokens: number; outputTokens: number } {
    return this.totalUsage;
  }
  async setProvider(providerId: string, modelId: string): Promise<void> {
    // Phase 21 #5 reopen: forward `paths` so RuntimeResolver can hit the
    // Phase 18 OAuth fast-path (entry.oauth.providerId → tokenStore at
    // <aiden-home>/auth/<id>.json). Without paths the resolver skips the
    // fast-path and falls through to the legacy auth.json credential
    // path, which throws the user-reported "No credentials found for
    // apiMode='codex_responses' at .../auth.json" error even after a
    // successful /auth login.
    const adapter = await this.opts.resolver.resolve({
      providerId,
      modelId,
      paths: this.opts.paths,
    });
    this.opts.agent.setProvider(adapter);
    // Phase v4.1.2-bug2: keep the prompt's Runtime slot in lockstep
    // with the routed provider. Without this, the agent's adapter
    // swaps correctly but its system prompt keeps self-describing as
    // the boot-time provider/model for the rest of the session.
    this.opts.agent.setActiveModel(providerId, modelId);
    this.currentProviderId = providerId;
    this.currentModelId = modelId;
  }

  /** Skill slash command activation hook (Phase 14c). */
  queueSystemPrompt(content: string): void {
    if (content && content.trim()) this.queuedSystemPrompts.push(content);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  async run(): Promise<void> {
    // 1. Resolve session id if not preloaded.
    if (this.opts.resumeSessionId) {
      this.sessionId = this.opts.resumeSessionId;
    } else {
      const newSession = this.opts.sessionManager.startSession({
        providerId: this.currentProviderId,
        modelId: this.currentModelId,
      });
      this.sessionId = newSession.id;
    }

    // v4.10 Slice 10.2c — publish the long-lived session id to the
    // shared ref so read surfaces (the `/trace recent` slash + the
    // model-facing `trace_query` tool) can resolve "this conversation"
    // between turns. Distinct from the turn-scoped `sessionId` field
    // on the same ref, which is set+cleared per turn. Set once here
    // and never cleared — the REPL process exits before this becomes
    // stale.
    if (this.opts.replParentRunRef) {
      this.opts.replParentRunRef.chatSessionId = this.sessionId;
    }

    // 2. Boxed startup card.
    await this.renderStartupCard();

    // 3. Optional SIGINT / SIGTERM handlers.
    //
    // Phase v4.1.2-memory-AB: SIGINT used to do `process.exit(0)` directly,
    // bypassing session_summary + the new distillation file. The Ctrl-C
    // path is the most common premature exit, so it's now hooked too.
    // Both signals route to the same async-with-timeout helper; on
    // timeout (default 4s, override AIDEN_SUMMARY_TIMEOUT_MS) the exit
    // proceeds anyway with a dim log line — honest about the skip.
    let sigintHandler: (() => Promise<void>) | null = null;
    let sigtermHandler: (() => Promise<void>) | null = null;
    let exitHandler: (() => void) | null = null;
    if (this.opts.installSignalHandler !== false) {
      // v4.11 Slice 3 — graceful-shutdown helper extracted so the new
      // SIGINT dispatcher can call it on the "second press" branch
      // without duplicating the existing pre-flight + summary
      // pipeline. Preserves the exact pre-Slice-3 SIGTERM behaviour
      // (SIGTERM still routes here directly — no two-press semantics
      // for SIGTERM, which has no human-typing context to disambiguate).
      const gracefulShutdown = async (sig: SessionExitPath): Promise<void> => {
        // v4.12.1 Slice 2a — a force-exit discards any type-next queue; the
        // user is bailing out, so don't run queued messages after they leave.
        try { this.duringTurnInput.clear(); } catch { /* best-effort */ }
        this.opts.display.write('\n');
        this.opts.display.dim(`Got ${sig.toUpperCase()} — saving session before exit…`);
        // v4.10 Slice 10.7 — stop channel adapters BEFORE the
        // summary-write so their pollers don't keep the event loop
        // alive past process.exit and leave their local locks stale.
        // The /quit path already invokes channelManager.stopAll()
        // (aidenCLI.ts buildAgentRuntime teardown); this is the
        // symmetric SIGINT/SIGTERM cleanup. Hard 1s cap so a hung
        // adapter doesn't delay the user's Ctrl+C exit (YAGNI on a
        // configurable timeout per Phase B Q3).
        if (this.opts.channelManager) {
          const stopPromise = this.opts.channelManager.stopAll().catch(() => undefined);
          const timeout = new Promise<void>((res) => setTimeout(res, 1000).unref?.());
          await Promise.race([stopPromise, timeout]);
        }
        // v4.12 PM.1 — reap background processes so a spawned dev server / build
        // isn't orphaned when the session exits (tree-kill all tracked spawns).
        try { this.opts.processRegistry?.cleanup(); } catch { /* best-effort reap */ }
        try {
          await this.maybeAutoSummarizeWithTimeout(sig);
        } catch (err) {
          this.opts.display.warn(
            `Session summary skipped on ${sig}: ${(err as Error).message}`,
          );
        }
        // v4.1.3-repl-polish: render session-end card before farewell when
        // a distillation was written this session. Pass the on-disk path
        // so the card surfaces the artifact location to the user.
        if (this.lastDistillation) {
          for (const line of renderSessionEndCard(
            this.lastDistillation,
            (t, k) => this.opts.display.applyColors(t, k),
            this.lastDistillationPath,
          )) {
            this.opts.display.write(line + '\n');
          }
        }
        this.opts.display.dim('Goodbye.');
        process.exit(0);
      };
      // v4.11 Slice 3 — two-press SIGINT dispatcher (Phase A audit A6.2).
      //
      // State machine:
      //   1. No active turn (composer idle)        → graceful shutdown
      //      (preserves pre-Slice-3 behaviour exactly so the v4.10.0
      //      muscle memory still applies at the prompt).
      //   2. Active turn AND first press           → abort the live
      //      AbortController + dim hint exposing the second-press
      //      escape hatch. REPL stays alive; the agent loop sees
      //      signal.aborted at its next iteration / pre-tool / mid-
      //      fetch boundary and returns finishReason='interrupted'.
      //   3. Active turn AND second press within
      //      FORCE_EXIT_WINDOW_MS of the first        → graceful
      //      shutdown. We honour the user's "I really mean it"
      //      gesture; session_summary still runs with its existing
      //      1s adapter-stop + 4s summary caps.
      //   4. Active turn AND second press AFTER the window expires
      //      → treat as a fresh first press (the previous turn must
      //      have settled and started a new one; the lastInterruptAt
      //      reset in runAgentTurn's finally already covers this,
      //      but the window check is the belt-and-braces guard).
      //
      // SIGTERM keeps the legacy direct-to-graceful path — operators
      // and supervisors expect immediate termination, not a two-press
      // dance.
      sigintHandler = async () => {
        const now      = Date.now();
        const ctrl     = this.currentAbortController;
        const hasTurn  = ctrl !== null;
        const inWindow = now - this.lastInterruptAt
                       < ChatSession.FORCE_EXIT_WINDOW_MS;

        if (!hasTurn) {
          await gracefulShutdown('sigint');
          return;
        }
        if (inWindow) {
          // Second press inside the window — user really wants out.
          await gracefulShutdown('sigint');
          return;
        }
        // First press during an active turn — abort, surface the
        // escape hatch, stay alive. The agent's catch will route
        // the resulting AbortError to finishReason='interrupted'.
        this.lastInterruptAt = now;
        try {
          ctrl?.abort();
          // v4.12.1 Slice 2b — a hard interrupt supersedes any pending steer,
          // so a stale nudge never lands on the next unrelated turn.
          this.duringTurnInput.clearSteer();
        } catch { /* defensive — abort() can't throw, but cheap insurance */ }
        try {
          this.opts.display.dim(
            'Interrupting turn — press Ctrl+C again within 2s to force-quit.',
          );
        } catch { /* dim() should never throw; defensive */ }
      };
      sigtermHandler = async () => { await gracefulShutdown('sigterm'); };
      process.on('SIGINT',  sigintHandler);
      process.on('SIGTERM', sigtermHandler);

      // Last-resort safety net: synchronous-only hook, so we can't run
      // the auxiliary call here. Just log when we exited without
      // summarizing so the user knows where to look for missing data.
      exitHandler = () => {
        if (!this.summarized) {
          // Best-effort one-liner — stderr because stdout may be torn
          // down already.
          try {
            process.stderr.write(
              '[aiden] process exiting without session summary — ' +
              'distillation file not written for this session.\n',
            );
          } catch { /* nothing to do */ }
        }
      };
      process.on('exit', exitHandler);
    }

    // 4. Main loop.
    // Tier-3.1.1: feed the new aidenPrompt with live slash commands +
    // recent history so ghost-text + dropdown work out of the box.
    // The legacy inquirer path runs when `--no-ui` (AIDEN_NO_UI=1) is
    // set or when a caller injects its own `promptApi`.
    const promptApi =
      this.opts.promptApi ??
      createDefaultPromptApi({
        commands:     this.opts.commandRegistry.list(),
        loadHistory:  () => loadRecent(500),
      });
    const max = this.opts.maxIterations ?? Number.POSITIVE_INFINITY;
    let iter = 0;
    // Phase 16: enable bracketed paste for the duration of the REPL when
    // a real TTY is attached. Disabled in `finally` below so the user's
    // shell doesn't inherit the mode after we exit.
    //
    // v4.12.1 — ROOT FIX for the frame-renderer paste-marker leak. Bracketed
    // paste exists ONLY to feed the stdin interceptor (`[paste #N]` labels +
    // anti-auto-submit) on the legacy/inquirer path — the interceptor taps
    // `stdin.emit('data')`. The frame renderer reads stdin via Ink's
    // `stdin.read()` on the `'readable'` event, which BYPASSES that tap, so it
    // can neither use bracketed paste nor be cleaned by the interceptor — and
    // Ink strips the leading ESC, delivering a bare `[200~` that no ESC-keyed
    // strip can catch. Ink already hands a paste to useInput atomically, so the
    // frame path never needed bracketed paste. Therefore: enable it ONLY in
    // legacy mode; in frame mode actively DISABLE it (`\x1b[?2004l`) at boot so
    // the terminal never wraps a paste → Ink gets plain text → nothing to strip.
    const stdout = process.stdout;
    // Frame module is best-effort (matches the pauseFrame/resumeFrame requires
    // below): if it can't load, fall back to legacy behaviour (bracketed paste
    // enabled). Never throw out of REPL boot over a renderer probe.
    let frameModeOn = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      frameModeOn = (require('./frame') as typeof import('./frame')).isFrameModeRequested();
    } catch { /* frame module unavailable → treat as legacy */ }
    const pasteBootAction = decidePasteBootAction({
      isTty:        !!stdout?.isTTY,
      hasPromptApi: !!this.opts.promptApi,
      frameMode:    frameModeOn,
    });
    // legacy TTY → enable (feeds the interceptor); frame TTY → actively disable
    // so the terminal never wraps a paste (markers never generated → Ink gets
    // plain text → nothing to strip); non-TTY / promptApi → leave it alone.
    let pasteEnabled = false;
    if (pasteBootAction === 'enable') {
      pasteEnabled = enableBracketedPaste(stdout);
    } else if (pasteBootAction === 'disable') {
      disableBracketedPaste(stdout);
    }
    // Tier-3.1a: install stdin pre-tap so bracketed paste payloads are
    // captured and replaced with `[paste #N: …]` labels BEFORE inquirer
    // sees them. Without this, modern @inquirer/prompts treats internal
    // `\n` as Enter and auto-submits the first line of a multi-line paste.
    // Tier-3.1c: install regardless of TTY status. Bracketed-paste
    // sequences can arrive on a piped stdin too (CI harnesses, the
    // runtime smoke), and the interceptor's wrap is a no-op on
    // non-paste data — there's no cost to installing always. The
    // promptApi opt-out remains so callers that supply their own
    // input plumbing aren't surprised.
    const restorePasteInterceptor =
      this.opts.promptApi
        ? (): void => { /* test prompt API: no interceptor */ }
        : installPasteInterceptor(process.stdin);

    // v4.9.0 Slice 1a — start the theme hot-reload watcher. Honours
    // `~/.aiden/theme.yaml` if it exists; otherwise no-op until the
    // user creates one. Disposed in the `finally` block alongside
    // the paste interceptor.
    if (this.opts.paths && !this.opts.promptApi) {
      try {
        startThemeWatcher(require('node:path').join(this.opts.paths.root, 'theme.yaml'));
      } catch { /* watcher start failure must not crash REPL */ }
    }

    // Tier-3-essentials: hard-clear the screen on terminal resize so
    // dropdown re-renders + previous prompt frames don't ghost into
    // the new viewport. No-op on non-TTY / MCP serve mode.
    //
    // v4.1.4 reply-quality polish: also drop the per-chunk stream row
    // counter so a mid-stream resize doesn't try to erase rows that
    // the hard-clear already removed. See `resetStreamFrameForResize`
    // in display.ts for the rationale.
    const restoreResizeGuard = this.opts.promptApi
      ? (): void => { /* test prompt API: skip */ }
      : installResizeGuard({
          onCleared: () => {
            try {
              (this.opts.display as { resetStreamFrameForResize?: () => void })
                .resetStreamFrameForResize?.();
            } catch { /* defensive — never break the resize listener */ }
          },
        });
    // v4.10 Slice 10.7a — mark the REPL active for the entire chat
    // loop lifetime. The flag is read by any sink / writer that wants
    // to defer TTY writes while the prompt is up (defense-in-depth
    // on top of the StderrSink removal from cli-interactive mode).
    markReplActive();
    try {
      while (iter < max) {
        iter += 1;
        // Phase 26.2.3 — turn boundary rule. The boot card already ends
        // with a rule + blank, so suppress on the very first iteration.
        if (iter > 1) this.opts.display.printTurnSeparator();
        let input: string;
        // v4.12.1 Slice 2a — idle boundary: run a message the user queued
        // WHILE the previous turn was busy before blocking on fresh input.
        // Echo it so a queued message never fires invisibly.
        const queuedNext = this.duringTurnInput.dequeue();
        if (queuedNext !== null) {
          try { this.opts.display.dim(`▸ running queued: ${queuedNext}`); } catch { /* defensive */ }
          input = queuedNext;
          // Fall through to the slash/agent dispatch below with this input.
        } else
        try {
          input = await this.readUserInput(promptApi);
        } catch (err) {
          const msg = (err as Error)?.message ?? '';
          if (msg.includes('User force closed') || msg.includes('SIGINT')) break;
          this.opts.display.printError(
            msg || 'input error',
            'Try again or run `aiden doctor`.',
          );
          continue;
        }
        if (!input || !input.trim()) continue;

        if (input.trim().startsWith('/')) {
          const result = await this.opts.commandRegistry.execute(input.trim(), {
            display: this.opts.display,
            session: this,
            resolver: this.opts.resolver,
            toolRegistry: this.opts.toolRegistry,
            sessionManager: this.opts.sessionManager,
            skillLoader: this.opts.skillLoader,
            config: this.opts.config,
            compressor: this.opts.compressor,
            approvalEngine: this.opts.approvalEngine,
            skin: this.opts.skin,
            mcpClient: this.opts.mcpClient,
            auxiliaryClient: this.opts.auxiliaryClient,
            fallbackAdapter: this.opts.fallbackAdapter ?? null,
            paths: this.opts.paths,
            personalityManager: this.opts.personalityManager,
            agent: this.opts.agent,
            pluginLoader: this.opts.pluginLoader,
            channelManager: this.opts.channelManager,
            // v4.12 /commands slice — /home working-directory change seam.
            setWorkingDir: this.opts.setWorkingDir,
            // v4.9.2 Slice 3 — UX-rebuilt confirmation primitive.
            // The stdin/keypress mechanics worked correctly all along;
            // users simply couldn't see the prompt was open. The
            // extracted `runConfirm` helper now owns the canonical
            // y/N hint, the warn-tinted '?' glyph, the
            // suggestionsDisabled flag (so confirmations skip ghost-
            // match against outer chat history), and the per-input
            // honest cancellation message.
            //
            // Phase 17.1 anchor: the previous primitive read
            // `this.opts.promptApi?` (undefined → silently returned
            // false → "Grant cancelled" before user could type) —
            // fixed by routing through the resolved local `promptApi`.
            // That fix stands; Slice 3 adds the UX layer on top.
            confirm: (msg: string) => runConfirm(msg, promptApi, this.opts.display),
            // Phase 18: raw text prompt for /auth login OAuth code paste.
            prompt: (msg: string) => promptApi.readLine(msg),
          });
          if (result.exit) {
            // Phase v4.1.2 alive-core / Phase v4.1.2-memory-AB:
            // auto-trigger session distillation on /quit when the
            // session was substantive (≥3 user turns). SIGINT and
            // SIGTERM now also hit this path via their own handlers
            // above; the in-memory `summarized` flag prevents double-
            // writes. The /quit path tags exit_path='quit' so the
            // distillation file records which exit class fired.
            await this.maybeAutoSummarizeWithTimeout('quit');
            // Phase v4.1.2-memory-D: promotion prompt — only on /quit,
            // NEVER from signal handlers (async stdin in a signal
            // handler context is unsafe). Distillation files from
            // SIGINT-exited sessions stay on disk; their candidates
            // surface on the next `/quit` only if the conversation
            // is resumed in the same process (not today's behavior),
            // otherwise they're skipped — documented in commit.
            await this.maybeRunPromotion(promptApi);
            // v4.1.3-repl-polish: session-end card before farewell.
            if (this.lastDistillation) {
              for (const line of renderSessionEndCard(
                this.lastDistillation,
                (t, k) => this.opts.display.applyColors(t, k),
                this.lastDistillationPath,
              )) {
                this.opts.display.write(line + '\n');
              }
            }
            // v4.12 PM.1 — /quit is session-end: reap background spawns too.
            try { this.opts.processRegistry?.cleanup(); } catch { /* best-effort reap */ }
            break;
          }
          if (result.clearHistory) this.history = [];
          // v4.11 Slice C — /retry re-dispatch. The command already
          // reverted the last turn and handed back its prompt; run it as
          // a normal fresh turn (with the same bottom rule the direct
          // chat path emits below).
          if (typeof result.rerun === 'string' && result.rerun.length > 0) {
            this.opts.display.write(`  ${this.opts.display.rule()}\n`);
            await this.runAgentTurn(result.rerun);
          }
          // Phase 23.6 — v3 doesn't print a status footer after slash
          // commands; the footer belongs to agent turns only.
          continue;
        }

        // v4.9.0 pre-ship UI: BOTTOM rule of the prompt zone. The TOP
        // rule fires at `printTurnSeparator()` above (iter > 1). This
        // bottom rule fires only when actual content goes to the LLM —
        // slash commands + empty input + /quit all `continue` above and
        // never reach this line, matching the task's edge-case spec.
        this.opts.display.write(`  ${this.opts.display.rule()}\n`);
        await this.runAgentTurn(input);
      }
    } finally {
      // v4.10 Slice 10.7a — REPL no longer active; any subsequent
      // logger writes (e.g. SIGINT cleanup paths) can use stderr
      // freely. Paired with markReplActive above; idempotent if the
      // REPL exited before reaching the loop.
      markReplInactive();
      if (sigintHandler)  process.off('SIGINT',  sigintHandler);
      if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
      if (exitHandler)    process.off('exit',    exitHandler);
      if (pasteEnabled) disableBracketedPaste(stdout);
      restorePasteInterceptor();
      try { stopThemeWatcher(); } catch { /* defensive */ }
      restoreResizeGuard();
    }
  }

  // ── Inner: a single agent turn ─────────────────────────────────────
  /**
   * Phase v4.1.2 alive-core (refined v4.1.2-followup-2): auto-trigger
   * `session_summary` on /quit when the session was substantive
   * (≥3 user turns). The synthetic prompt forces the model to call
   * the tool — prose-only responses are not acceptable.
   *
   * Every non-success path is logged explicitly so users always know
   * what happened:
   *   - threshold-skip → log: "session too short, skipping summary"
   *   - unconfigured-skip → log: "no provider, skipping summary"
   *   - tool-not-called (model returned prose) → log a clear warning
   *   - tool-errored (throw) → log the error verbatim
   *   - tool-succeeded → log the absolute MEMORY.md path
   *
   * Post-run verification: compare MEMORY.md size+mtime before vs
   * after the synthetic turn. If unchanged, the model didn't actually
   * fire the tool and the user gets a "run /session-summary manually
   * next time" hint.
   *
   * SIGINT and crash paths skip this method entirely because the
   * signal handler does process.exit(0) before this slash-command
   * branch runs.
   */
  /**
   * Phase v4.1.2-memory-AB: combined Phase A (reliable session-end
   * firing) + Phase B (structured distillation) entry point.
   *
   * Drives one auxiliary-LLM call, produces a SessionDistillation,
   * writes the distillation JSON to <paths.root>/distillations/, AND
   * writes the bullets-only summary to MEMORY.md via the existing
   * sessionSummaryTool — both artifacts populated from the single
   * LLM call (no extra cost over the previous Path D).
   *
   * Idempotency: `this.summarized` is set to true ONLY on full
   * success (MEMORY.md write verified). Failed or timed-out attempts
   * leave the flag false so the next exit path retries. Lightweight
   * in-memory flag pattern — clears on normal completion, only set
   * after a fully verified write.
   *
   * Timeout: SUMMARY_TIMEOUT_MS_DEFAULT (4s) override via env var.
   * On timeout the LLM result is treated as empty → distillation
   * file written with `partial: true` + deterministic fields only;
   * MEMORY.md not updated (no bullets to write).
   *
   * Honest logging: every skip / timeout / partial path produces a
   * user-visible dim or warn line. No silent drops.
   */
  private async maybeAutoSummarizeWithTimeout(
    exitPath: SessionExitPath,
  ): Promise<void> {
    // Idempotency check first — cheapest possible bail.
    if (this.summarized) {
      this.opts.display.dim(
        `Session already summarized; skipping ${exitPath} re-fire.`,
      );
      return;
    }

    const userTurns = this.history.filter((m) => m.role === 'user').length;
    const memoryPath = this.opts.paths?.memoryMd;

    const gate = shouldAutoSummarize({
      userTurns,
      unconfigured: !!this.opts.unconfigured,
      memoryPath,
    });
    if (gate.fire === false) {
      switch (gate.reason) {
        case 'short':
          this.opts.display.dim(
            `Skipping session summary — only ${userTurns} user turn(s), need ${SESSION_SUMMARY_MIN_TURNS}+.`,
          );
          return;
        case 'unconfigured':
          this.opts.display.dim(
            'Skipping session summary — no provider configured.',
          );
          return;
        case 'no-paths':
          this.opts.display.dim(
            'Skipping session summary — no aiden paths wired (test mode?).',
          );
          return;
      }
    }

    if (!this.opts.auxiliaryClient || !this.opts.memoryGuard || !this.opts.memoryManager) {
      this.opts.display.warn(
        'Skipping session summary — auxiliary client / memory plumbing not wired ' +
        '(this is normal in test mode; real CLI sessions get all three).',
      );
      return;
    }

    const timeoutMs = resolveSummaryTimeoutMs();
    const memoryPathSafe = memoryPath!;
    this.opts.display.dim(
      `Generating session distillation via auxiliary client (timeout ${timeoutMs}ms)…`,
    );

    // Snapshot MEMORY.md state to detect post-write whether the write
    // actually advanced the file — preserves the verify-on-disk check
    // from the pre-AB path.
    const before = await this.snapshotMemoryStat(memoryPathSafe);

    // Single auxiliary call → SessionDistillation. distillSession
    // owns its own internal timeout, so we don't need an outer race
    // here; the deterministic fields populate regardless of LLM
    // outcome (so even a full timeout produces a useful artifact).
    let dist: SessionDistillation;
    try {
      dist = await distillSession({
        sessionId:        this.sessionId ?? `unbound-${Date.now()}`,
        startedAt:        new Date(this.startedAt).toISOString(),
        exitPath,
        userTurns,
        messages:         this.history,
        toolTrace:        this.sessionToolTrace,
        auxiliaryClient:  this.opts.auxiliaryClient,
        timeoutMs,
        // v4.1.3-essentials distillation-fix: route the new
        // diagnostic signal to a dim line so the user can see WHICH
        // of the three failure classes fired (timeout / call-fail /
        // unparseable JSON). Before this hook, all three converged
        // on a silent `partial:true` and the downstream "no bullets"
        // warning didn't distinguish them.
        onDiagnostic: (msg) => {
          this.opts.display.dim(`[distill] ${msg}`);
        },
      });
    } catch (err) {
      this.opts.display.warn(
        `Session distillation failed: ${(err as Error).message}. ` +
        `MEMORY.md unchanged at: ${memoryPathSafe}`,
      );
      return;
    }

    // Persist the distillation JSON. Failures are recorded into the
    // slice3 subsystem health surface (when the agent wires one) and
    // logged here; they don't block the MEMORY.md write.
    if (this.opts.paths?.root) {
      const dir = path.join(this.opts.paths.root, 'distillations');
      try {
        const file = await writeDistillation(dir, dist);
        this.lastDistillationPath = file;
        this.opts.display.dim(
          `Session distillation${dist.partial ? ' (partial)' : ''} saved to ${file}`,
        );
      } catch (err) {
        this.opts.display.warn(
          `Distillation write failed: ${(err as Error).message}. ` +
          `(Continuing to MEMORY.md update.)`,
        );
      }
    }

    // Update MEMORY.md `## Recent sessions` via the existing tool — no
    // change to its on-disk shape (back-compat per slice's hard
    // constraint). Skip when bullets are empty (full LLM timeout) —
    // a zero-bullet entry would just be noise in MEMORY.md.
    if (dist.bullets.length === 0) {
      this.opts.display.warn(
        `Session summary skipped MEMORY.md update — auxiliary returned no bullets ` +
        `(distillation file may still have deterministic fields).`,
      );
      return;
    }

    try {
      const { sessionSummaryTool } = await import(
        '../../tools/v4/memory/sessionSummary'
      );
      const result = await sessionSummaryTool.execute(
        { bullets: dist.bullets, trigger: 'auto-quit' },
        {
          cwd:         process.cwd(),
          paths:       this.opts.paths!,
          memory:      this.opts.memoryManager,
          memoryGuard: this.opts.memoryGuard,
        } as Parameters<typeof sessionSummaryTool.execute>[1],
      ) as { success: boolean; error?: string };

      if (!result.success) {
        this.opts.display.warn(
          `Session summary failed: ${result.error ?? 'unknown error'}. ` +
          `MEMORY.md may be unchanged at: ${memoryPathSafe}`,
        );
        return;
      }
    } catch (err) {
      this.opts.display.warn(
        `Session summary failed during write: ${(err as Error).message}. ` +
        `MEMORY.md unchanged at: ${memoryPathSafe}`,
      );
      return;
    }

    const after = await this.snapshotMemoryStat(memoryPathSafe);
    if (memoryGrewBetween(before, after)) {
      this.opts.display.dim(`Session summary saved to ${memoryPathSafe}`);
      // Mark summarized ONLY after both writes verified — partial
      // states leave the flag false so the next exit path retries.
      this.summarized = true;
      // Phase v4.1.2-memory-D: cache the distillation for the promotion
      // flow. The /quit handler (and only /quit) consults this to build
      // candidates without re-driving the auxiliary LLM.
      this.lastDistillation = dist;
    } else {
      this.opts.display.warn(
        `Session summary write completed but MEMORY.md size+mtime did not advance. ` +
        `Check ${memoryPathSafe} manually.`,
      );
    }
  }

  /**
   * Phase v4.1.2-memory-D: promotion-prompt flow.
   *
   * Called from the `/quit` path ONLY (NOT from SIGINT/SIGTERM
   * handlers — async stdin can't be safely driven from a signal
   * handler context). Builds candidates from `this.history` +
   * `this.lastDistillation`, dedups against the existing
   * `## Durable facts` section in MEMORY.md, prompts the user,
   * persists approved selections.
   *
   * Gates (any false → silent no-op):
   *   - this.summarized              (need a fresh distillation)
   *   - this.lastDistillation        (set alongside summarized)
   *   - this.opts.memoryManager      (real CLI sessions only)
   *   - this.opts.memoryGuard        (real CLI sessions only)
   *
   * UX rules per Phase D's Q5 first-run experience:
   *   - 0 candidates AND 0 totalBeforeDedup → completely silent
   *   - 0 candidates AFTER dedup, but some were dropped → dim line
   *     "N candidates already in durable facts — nothing new to promote"
   *   - >0 candidates → prompt for approval, write approved
   */
  private async maybeRunPromotion(api: ChatPromptApi): Promise<void> {
    if (!this.summarized || !this.lastDistillation) return;
    if (!this.opts.memoryManager || !this.opts.memoryGuard) return;

    let existingBody: string;
    try {
      existingBody = await readExistingDurableFactsBody(this.opts.memoryManager);
    } catch (err) {
      this.opts.display.warn(
        `Could not read existing durable facts: ${(err as Error).message}. ` +
        `Promotion skipped.`,
      );
      return;
    }

    const built = extractCandidates(
      this.history,
      this.lastDistillation,
      existingBody,
    );

    // Silent on truly empty sessions; reward the user on "all already saved".
    if (built.candidates.length === 0) {
      if (built.totalBeforeDedup === 0) {
        return; // no signals + no distillation gold to promote — silent
      }
      if (built.dedupedAgainstExisting > 0) {
        this.opts.display.dim(
          `${built.dedupedAgainstExisting} candidate${built.dedupedAgainstExisting === 1 ? '' : 's'} ` +
          `already in durable facts — nothing new to promote.`,
        );
      }
      return;
    }

    let approved;
    try {
      approved = await promptForApproval(api, this.opts.display, built.candidates);
    } catch (err) {
      // The prompt API throwing is rare (broken stdin, etc.) — log
      // and skip; no auto-write on error per "opt-in by design".
      this.opts.display.warn(
        `Promotion prompt failed: ${(err as Error).message}. ` +
        `Nothing was written to durable facts.`,
      );
      return;
    }
    if (approved.length === 0) return;     // user replied skip / none / unparseable

    try {
      const result = await writeApprovedDurableFacts(
        this.opts.memoryManager,
        this.opts.memoryGuard,
        approved,
      );
      if (result.ok && result.verified) {
        this.opts.display.dim(
          `Promoted ${approved.length} fact${approved.length === 1 ? '' : 's'} ` +
          `to MEMORY.md \`## Durable facts\`.`,
        );
      } else {
        this.opts.display.warn(
          `Durable-facts write completed but did not verify: ` +
          `${result.reason ?? 'unknown'}. Inspect MEMORY.md manually.`,
        );
      }
    } catch (err) {
      this.opts.display.warn(
        `Durable-facts write failed: ${(err as Error).message}. ` +
        `MEMORY.md may be unchanged.`,
      );
    }
  }

  /**
   * Phase v4.1.2 session-summary-followup: ask the auxiliary client
   * for a JSON array of 5 session-summary bullets. One retry on
   * malformed output with a stricter "JSON only" reminder, then we
   * surface the failure honestly via the caller's warn() log.
   *
   * Returns `null` when both attempts fail to yield a valid array.
   */
  private async requestSessionBulletsFromAuxiliary(): Promise<string[] | null> {
    const aux = this.opts.auxiliaryClient!;
    const transcript = this.buildSessionTranscriptForSummary();

    const promptStrict = (extraNote: string): string =>
      [
        'Summarize this session in EXACTLY 5 short bullets. Focus on:',
        '- what we worked on',
        '- decisions made',
        '- files / commits changed',
        '- problems solved',
        '- open items',
        '',
        'Respond with ONLY a JSON array of 5 strings. No prose. No explanation. ' +
          'No code fences. No leading or trailing text.',
        '',
        'Example: ["Shipped v4.1.1 to npm", "Diagnosed OAuth bug", "Patched tool schema", "Added doctor --providers", "Queued auxiliary fallback"]',
        '',
        extraNote,
        '',
        'Session transcript:',
        transcript,
      ].filter((s) => s.length > 0).join('\n');

    const attempt = async (note: string): Promise<string[] | null> => {
      const res = await aux.call({
        purpose:   'session_summary',
        prompt:    promptStrict(note),
        maxTokens: 800,
        timeoutMs: 30_000,
      });
      return parseSessionBulletsResponse(res.content);
    };

    const first = await attempt('');
    if (first) return first;
    const second = await attempt(
      'STRICT: Your previous response was not parseable. Return ONLY the JSON array, nothing else.',
    );
    return second;
  }

  /**
   * Compress recent history into a transcript blob the auxiliary
   * client can summarise. Caps to the last 30 messages so the
   * auxiliary prompt stays under typical small-model context limits;
   * the auxiliary's `maxTokens: 800` output budget bounds the cost.
   */
  private buildSessionTranscriptForSummary(): string {
    const recent = this.history.slice(-30);
    const lines: string[] = [];
    for (const m of recent) {
      const role = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'AIDEN' : m.role.toUpperCase();
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      // Truncate any single message to 800 chars so a giant paste
      // doesn't blow the prompt budget.
      const trimmed = content.length > 800 ? `${content.slice(0, 800)}…` : content;
      lines.push(`${role}: ${trimmed}`);
    }
    return lines.join('\n\n');
  }

  /**
   * Read MEMORY.md size + mtime for the pre/post-write comparison in
   * `maybeAutoSummarize`. Missing file is normalised to zeros so the
   * "did MEMORY.md grow" comparison is well-defined even on fresh installs.
   */
  private async snapshotMemoryStat(p: string): Promise<{ size: number; mtime: number }> {
    try {
      const { promises: fsPromises } = await import('node:fs');
      const stat = await fsPromises.stat(p);
      return { size: stat.size, mtime: stat.mtimeMs };
    } catch {
      return { size: 0, mtime: 0 };
    }
  }

  private async runAgentTurn(userInput: string): Promise<void> {
    // v4.11 Slice B — snapshot pre-turn history for /undo (in-memory,
    // bounded). Captured before any mutation; `this.history` is only
    // reassigned at end-of-turn, so this copy is the true pre-turn state.
    this.undoStack.push([...this.history]);
    if (this.undoStack.length > ChatSession.UNDO_MAX_SNAPSHOTS) {
      this.undoStack.shift();
    }
    // v4.5 Phase 8b — daemon-scheduling intent check on the user's
    // initial message. Classifies regex hits like "every day at",
    // "watch this folder", "when an email arrives" — and queues a
    // tip to render at the END of the agent's response (so it
    // doesn't crowd the agent's actual reply). Engine handles
    // budget + dismissal.
    let _deferredTip: { slot: string; message: string } | null = null;
    // v4.11 Slice 1 — explicit streaming handoff boundary. When
    // frame mode is active the composer unmounts on submit (before
    // this function is called); pauseFrame is advisory here so the
    // boundary is grep-able and ready for the persistent-mount
    // model later slices switch to. resumeFrame fires in the finally
    // block below regardless of how the turn ended.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { isFrameModeRequested, pauseFrame } = require('./frame') as typeof import('./frame');
      if (isFrameModeRequested()) await pauseFrame();
    } catch { /* frame module is best-effort; never break a turn */ }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getSuggestionEngine } = require('../../core/v4/suggestionEngine');
      const t = getSuggestionEngine().checkInitialMessage(userInput);
      if (t) _deferredTip = t;
    } catch { /* defensive — never block a turn on a suggestion */ }

    // Phase 30.2.1 — explore mode: short-circuit BEFORE building the
    // turn-status spinner / agent call. The wizard skipped, so there's
    // no real provider to talk to. Print a friendly redirect to /setup
    // (or the env-var alternative) and return — REPL stays alive, user
    // can run slash commands or hit /quit.
    if (this.opts.unconfigured) {
      void userInput; // silence unused-arg warning when this branch fires
      this.opts.display.write('\n');
      this.opts.display.printError(
        'No AI provider configured yet.',
        'Run /setup to configure a provider, or set an API key environment variable (e.g. GROQ_API_KEY).',
      );
      this.opts.display.write('\n');
      return;
    }

    // v4.11 Slice 3 — mid-turn cancel plumbing (Phase A audit A6.1 + R1).
    //
    // (a) Mint a per-turn AbortController; expose it to the SIGINT
    //     dispatcher via the shared `currentAbortController` field.
    //     The signal threads through `agent.runConversation` →
    //     `RunConversationOptions.signal` → `_currentSignal` → loop
    //     iteration / pre-tool boundary checks → provider adapters'
    //     forwarded fetch signal. All of those checkpoints already
    //     existed in HEAD (v4.6 prep); this is the wake-up.
    //
    // (b) Mint a monotonic `turnId` and stamp it on every callback
    //     closure we hand to `runConversation`. R1 Tier-1 mitigation:
    //     a late stream/tool event from a CANCELLED turn arriving
    //     after the next turn starts will see `this.activeTurnId`
    //     advanced and silently no-op. Prevents stray paint /
    //     transcript mutation from the race window between abort
    //     and the underlying SSE reader's first dead-byte.
    //
    // The controller + turnId are cleared in the finally block at the
    // bottom of this method (success, error, AND abort paths). The
    // SIGINT dispatcher reads `currentAbortController` snapshotted at
    // press time so a turn that settles mid-keypress is safe — the
    // pre-snapshot reference is a no-op `.abort()` on a settled
    // controller per the WHATWG spec.
    const turnId    = ++this.nextTurnId;
    const turnAbort = new AbortController();
    this.currentAbortController = turnAbort;
    this.activeTurnId           = turnId;

    // v4.12.1 Pillar 4 Slice 2a — attach the during-turn keypress listener for
    // the life of this turn. Enter → queue (or cancel, per mode); esc → cancel
    // this turn but KEEP the queue; Ctrl+C → the existing two-press SIGINT
    // logic (raw mode suppresses the kernel signal, so we re-emit it). No-op on
    // a non-TTY. Detached in the finally below (all paths) so raw mode is
    // always restored.
    const detachTurnInput = attachTurnInputListener({
      cb: {
        onLine: (text) => {
          const act = this.duringTurnInput.onBusyEnter(text);
          if (act.action === 'queued') {
            try { this.opts.display.dim(`  ✓ queued (${act.count} pending) — runs after this turn`); } catch { /* defensive */ }
          } else if (act.action === 'steered') {
            // Slice 2b — buffered; lands after the current tool, next iteration.
            try { this.opts.display.dim(`  ◆ redirecting: ${act.text} — applies from the next step`); } catch { /* defensive */ }
          } else if (act.action === 'interrupt') {
            requestTurnCancel(this.currentAbortController);
          }
        },
        // esc cancels the turn AND drops any pending steer (a hard interrupt
        // supersedes a nudge — no stale steer leaks onto the next turn). The
        // queue is kept (Slice-2a decision).
        onEscape: () => { this.duringTurnInput.clearSteer(); requestTurnCancel(this.currentAbortController); },
        onCtrlC:  () => { try { (process as NodeJS.Process).emit('SIGINT'); } catch { /* defensive */ } },
        // Slice 2c — paint the live during-turn buffer so the user sees their
        // keystrokes (not blind), labelled with what Enter will do. Empty
        // buffer (initial, or the reset after submit/cancel) clears the row.
        onBufferChange: (buffer) => {
          try { this.opts.display.setComposer(buffer, this.duringTurnInput.getMode()); } catch { /* defensive */ }
        },
      },
    });
    // Helper: wrap a callback so it only fires for the live turn.
    // R1 guard — late events from a cancelled turn early-return.
    // `wrapTurnId` accepts (callback, undefined) and returns
    // undefined so the agent's optional-call site (`runOptions.onX?.()`)
    // stays untouched when streaming is disabled.
    const wrapTurnId = <Args extends unknown[]>(
      fn: ((...args: Args) => void) | undefined,
    ): ((...args: Args) => void) | undefined => {
      if (!fn) return undefined;
      return (...args: Args): void => {
        if (this.activeTurnId !== turnId) return;
        fn(...args);
      };
    };

    // Phase 22 Task 4: status bar reflects the live phase. Set on
    // entry, cleared in both success and error paths below.
    this.setStatusState({ kind: 'generating', sinceMs: Date.now() });
    // v4.8.1 Slice 2 hotfix #3 — removed the prior Tier-3.1a dim
    // rule between the user input echo and the agent reply. The dim
    // colour read as a near-blank row in live smoke, and stacked
    // with the indicator's erase-blank residue produced two visible
    // separator rows above `▎ Aiden`. With the rule gone, the layout
    // is:
    //   user input → [indicator paints, erases — 1 blank row] → ▎ Aiden
    // = exactly one blank row between user input and Aiden header,
    // matching the rhythm Shiva flagged in smoke.
    const turnStartedAt = Date.now();
    const userMsg: Message = { role: 'user', content: userInput };

    // Apply any queued system prompts (from skill slash commands) by
    // prepending them as system messages. Cleared after consumption.
    const newHistory: Message[] = [];
    for (const sysContent of this.queuedSystemPrompts) {
      newHistory.push({ role: 'system', content: sysContent });
    }
    this.queuedSystemPrompts = [];

    const turnStart = this.history.length;
    const baseHistory = newHistory.length > 0
      ? [...this.history, ...newHistory, userMsg]
      : [...this.history, userMsg];

    // v4.6 Phase 2Q-B — REPL parent-run row (best-effort).
    //
    // Insert a `runs` row tagged with this REPL session BEFORE the
    // agent loop dispatches. Capture the row id into the shared
    // `replParentRunRef` so any `spawn_sub_agent` / `subagent_fanout`
    // child this turn produces can link back via
    // `spawned_from_run_id`. The ref is cleared in the catch /
    // success paths below regardless of outcome.
    //
    // Defensive: a runStore write failure (locked DB, schema drift,
    // etc.) must NOT crash the REPL — every persistence call here is
    // wrapped in try/catch and reduces to a logged warning. The
    // user-facing turn still runs.
    let replRunId: number | null = null;
    const replRunStore       = this.opts.replRunStore;
    const replInstanceId     = this.opts.replInstanceId;
    const replParentRunRef   = this.opts.replParentRunRef;
    if (replRunStore && replInstanceId && this.sessionId) {
      try {
        replRunId = replRunStore.create({
          sessionId:  this.sessionId,
          instanceId: replInstanceId,
          status:     'running',
          startedAt:  turnStartedAt,
        });
        if (replParentRunRef) {
          replParentRunRef.runId     = replRunId;
          replParentRunRef.sessionId = this.sessionId;
        }
      } catch (err) {
        // Logged once per turn; the user's chat is not interrupted.
        // eslint-disable-next-line no-console
        console.warn('[runs] failed to write REPL parent-run row:',
          err instanceof Error ? err.message : String(err));
        replRunId = null;
      }
    }

    // v4.11 Slice 4 — build the per-turn TurnRuntimeContext now that
    // `replRunId` is resolved. The SubagentCoordinator reads this via
    // `agent.getCurrentTurnContext()` when a spawn / fanout tool
    // fires; threads the parent's AbortSignal + cost accumulator +
    // trace emitter through to every child run. Cleared in the
    // finally below regardless of how the turn ended.
    //
    // The trace emitter routes coordinator lifecycle events through
    // `runStore.emitEventRich` keyed on the PARENT's runId so
    // `aiden runs show` sees parent + children together. Failure to
    // persist must never break the turn — every emit is wrapped in
    // try/catch.
    const turnContext = buildTurnRuntimeContext({
      turnId,
      parentAgentId: 'repl-parent',
      signal:        turnAbort.signal,
      traceEmitter:  (event) => {
        if (!replRunStore || replRunId === null) return;
        try {
          replRunStore.emitEventRich({
            runId:      replRunId,
            category:   'subagent',
            kind:       event.eventType,
            name:       event.eventType,
            sessionId:  this.sessionId ?? null,
            payload:    event as unknown as Record<string, unknown>,
            visibility: 'system',
            source:     'subagent',
          });
        } catch { /* persistence faults must never break dispatch */ }
      },
    });

    // v4.10 Slice 10.8 — durable Task-lite creation, alongside the
    // per-turn run row. Auto-create per user-message turn (Phase B
    // Q2/Q5 — one Task per turn keeps the model adherence concern
    // out of the trigger path). Title = first 80 chars of user input
    // (taskStore caps it); goal = the full user input verbatim so
    // future tools (/adjust, future Memory promotion) can read the
    // original intent without parsing UI display rows. Best-effort —
    // any write failure logs once and the turn proceeds.
    let replTaskId: string | null = null;
    // v4.13 Gap 1 — last ui_task_done payload the model emitted this
    // turn (collected via the onUiEvent handler). Read by the verify-
    // before-done gate: a declared failure finalizes honestly as failed.
    let declaredTaskDone: Record<string, unknown> | null = null;
    const replTaskStore = this.opts.replTaskStore;
    if (replTaskStore && this.sessionId) {
      try {
        replTaskId = replTaskStore.create({
          title:     userInput,
          goal:      userInput,
          sessionId: this.sessionId,
          channelId: 'repl',
          status:    'active',
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[tasks] failed to write REPL task row:',
          err instanceof Error ? err.message : String(err));
        replTaskId = null;
      }
    }

    // Phase 16c: streaming gated on display.streaming config.
    // v4.1.4 Part 1.6: PRODUCTION DEFAULT FLIPPED FROM FALSE TO TRUE.
    // Streaming delivers the activity indicator, tool-row live tick,
    // and token progress bar that the user feedback ("after prompt i
    // just see output") was specifically asking for. Users who
    // explicitly set `display.streaming: false` in config still opt
    // out; the change affects only the default for users who never
    // touched the flag.
    //
    // Test-stub fallback (no ConfigManager) stays at `false` so
    // existing tests that depended on the non-streaming code path
    // don't have to be rewritten in this slice — they exercise the
    // batch-call path that production users on Ollama / non-streaming
    // adapters still hit naturally.
    const streamingEnabled =
      typeof this.opts.config?.getValue === 'function'
        ? this.opts.config.getValue<boolean>('display.streaming', true) === true
        : false;

    // v4.10 Slice 10.9 — perception-first disclosure when the user
    // has streaming disabled. Slice 10.9 Phase A audit caught that
    // pre-10.9 wizard installs baked `streaming: false` into
    // config.yaml; the resulting "Aiden feels slow" complaint last
    // sprint traced back to this. The DEFAULT_CONFIG flip ships in
    // Slice 10.9 too, but existing users with explicit `false` keep
    // their setting (Phase B Q1 — respect user config). This warning
    // is the consent surface: tell them once per session what's
    // happening + how to flip it. Same disclosure pattern as Slice
    // 10.7's /channel telegram remove shell-env hint.
    if (!streamingEnabled && !this.streamingDisabledWarned && this.opts.config) {
      this.streamingDisabledWarned = true;
      this.opts.display.dim(
        '(streaming is disabled; responses will appear only when complete — set display.streaming: true in config.yaml for live chunks)',
      );
    }

    // v4.1.4 reply-quality polish — Part 1.6. Activity indicator
    // replaces the prior single-shot spinner. Pause/resume hooks make
    // the indicator cooperate with tool rows: it pauses before each
    // tool row writes and resumes (with a tool-aware verb) in the
    // gap that follows, so the user always sees activity feedback
    // during model-thinking time — not just the pre-first-token gap.
    //
    // Initial verb is "thinking" (pre-tools phase). After each tool
    // completes, `verbForActivity(toolName, 'post-tool')` picks a
    // category-aware verb (reading / searching / analyzing / drafting).
    // When the first stream delta arrives OR the final agentTurn is
    // about to write, the indicator stops permanently.
    const indicator = this.opts.display.activityIndicator('thinking');
    let indicatorStopped = false;
    let streamingActive  = false;
    // v4.8.0 Phase 2.3 fix-2 — clear the ui-event flag at turn-start.
    // The existing reset sites in Display (streamPartial first-delta +
    // streamComplete) only fire on text-streaming turns; tool-only
    // turns leave the flag sticky. This is the authoritative reset.
    this.opts.display.resetUiTurnState();
    // v4.1.5 Issue O — track whether this turn had any tool calls so
    // we can emit a single muted rule between the tool trail and the
    // reply header. Set true when the first tool's `before` phase
    // fires (via the existing beforeFirstToolHook plumbing). Emitted
    // once per turn — `separatorEmitted` gates idempotency against
    // both streaming and non-streaming paths reaching the same hook.
    //
    // v4.1.5 Phase 1d (Q-OBV-b) — multi-tool separator regression:
    // the prior v4.1.5 Phase 1c emission point was the streaming
    // `onFirstDelta` callback, but that fires PER provider call
    // (the agent resets `firstDeltaFired` each callProvider
    // invocation), and on multi-tool turns where the model emits
    // no preamble in early iterations + no preamble in the final
    // reply iteration either, the relative ordering of "first
    // delta" vs "first tool" could leave the flag/idempotency
    // gate in an unexpected state. Definitive fix: tie emission
    // to the FIRST STREAM BYTE LANDING ON SCREEN, which only
    // happens once per turn regardless of how many provider
    // iterations occurred. `firstStreamByteSeen` is the new gate;
    // separator fires from inside `onDelta` BEFORE `streamPartial`
    // writes the agent header.
    let turnHadTools         = false;
    let separatorEmitted     = false;
    let firstStreamByteSeen  = false;

    // v4.1.5+ Path A: per-turn loop tracer (env-var gated, default off).
    // Captures tool-call sequence + assembled system prompt + memory
    // hashes + recent skills when a turn trips loop thresholds. The
    // `onLoopWarning` callback surfaces a one-line dim hint to the
    // user when consecutive-same-tool count crosses 8 — gives them a
    // chance to Ctrl+C before the agent burns more budget.
    const loopTracer = new LoopTracer({
      paths:      this.opts.paths!,
      providerId: this.currentProviderId,
      modelId:    this.currentModelId,
      onLoopWarning: (line: string) => {
        try { this.opts.display.dim(line); } catch { /* defensive */ }
      },
    });
    if (loopTracer.isEnabled()) {
      loopTracer.setHistory(baseHistory);
    }
    const emitToolReplySeparator = (): void => {
      if (separatorEmitted || !turnHadTools) return;
      separatorEmitted = true;
      // Same chrome pattern as the existing pre-turn rule (line ~1100)
      // and the post-reply rule (line ~1297): two-space indent + the
      // body-width muted rule + newline. The 2-space indent is the
      // legacy convention used by adjacent rules; the v4.1.5 frame
      // gutter (3) is consciously NOT applied here so all three rules
      // in a turn share one left edge.
      this.opts.display.write(`  ${this.opts.display.rule()}\n`);
    };
    const stopIndicatorOnce = (): void => {
      if (indicatorStopped) return;
      indicatorStopped = true;
      indicator.stop();
      // Clear the per-turn pause/resume hooks so they don't fire
      // against a stopped indicator on a subsequent turn. The next
      // turn re-registers fresh hooks.
      try {
        this.opts.callbacks.setActivityIndicatorHooks?.({});
      } catch { /* defensive */ }
      // v4.1.5 Issue K — also clear the phase-verb sink so lifecycle
      // events fired during async cleanup don't try to update a
      // stopped indicator.
      try {
        this.opts.callbacks.setPhaseVerbHook?.(undefined);
      } catch { /* defensive */ }
      // v4.1.5+ Path A — clear the loop-trace sink so subsequent
      // turns don't fire into a stale tracer. Note: this clears the
      // HOOK, not the tracer's accumulated state — finalize() still
      // runs at end-of-try below to write the snapshot if thresholds
      // tripped.
      try {
        this.opts.callbacks.setToolTraceHook?.({});
      } catch { /* defensive */ }
    };

    // v4.1.5 Issue K — wire the per-turn phase-verb sink. Each
    // AidenAgent lifecycle event (memory refresh start, prompt built,
    // provider request start) flows through CliCallbacks and lands
    // here as a verb string ("refreshing memory" / "preparing prompt"
    // / "calling provider"). The closure captures the per-turn
    // indicator handle so verb mutations stay scoped to this turn.
    this.opts.callbacks.setPhaseVerbHook?.((verb: string) => {
      if (indicatorStopped) return;
      indicator.setVerb(verb);
    });

    // v4.1.5+ Path A — wire the loop-trace sink. Fires for EVERY tool
    // call (including hidden ones) so the trace captures the full
    // agent loop. Defensive — when AIDEN_DEBUG_LOOP is unset, the
    // tracer's `startTool`/`endTool` short-circuit immediately.
    this.opts.callbacks.setToolTraceHook?.({
      before: (id: string, name: string) => loopTracer.startTool(id, name),
      after:  (id: string, name: string, args: unknown) => loopTracer.endTool(id, name, args),
    });

    // Phase 23.5 carried forward: stop the indicator the moment the
    // first tool row prints — the row itself is the activity surface
    // during a tool. Part 1.6 then resumes via `afterEachTool` so the
    // post-tool gap has its own indicator paint.
    //
    // v4.1.5 Issue O — also flip `turnHadTools = true` so the
    // separator emits before the reply header. Single hook captures
    // "any tool ran this turn" cleanly (it only fires for the FIRST
    // tool of the turn — subsequent tools don't re-trigger).
    this.opts.callbacks.setBeforeFirstToolHook?.(() => {
      turnHadTools = true;
      stopIndicatorOnce();
    });

    // Part 1.6: pause/resume hooks around every tool row. The
    // `beforeTool` hook fires before EACH tool row writes (not just
    // the first), so multi-tool sequences also keep the indicator
    // off the tool-row line. `afterEachTool` resumes with a verb
    // chosen from the just-completed tool's category — best guess
    // for "what the model is doing next". `lastToolName` is captured
    // for tests / observability; the verb decision happens inline.
    this.opts.callbacks.setActivityIndicatorHooks?.({
      beforeTool: () => {
        if (indicatorStopped) return;
        indicator.pause();
        // v4.1.4 Part 1.6: hide the progress bar while the tool row
        // owns the screen. The bar paints below the indicator, so
        // it'd otherwise sit between the tool row and any subsequent
        // stream output — visual clutter for tool-heavy turns. The
        // bar is per-turn, not per-stream-segment; once hidden it
        // stays hidden until the next turn's bar is created.
        progressBar?.hide();
      },
      afterEachTool: (toolName: string) => {
        if (indicatorStopped) return;
        indicator.resume(verbForActivity(toolName, 'post-tool'));
      },
    });

    // v4.1.4 Part 1.6: per-turn progress bar. Created lazily on the
    // first `onProgress` event from the streaming adapter so the bar
    // line doesn't paint until there's something to show. Adapters
    // that don't emit progress (Ollama, most OpenAI-compat) never
    // trigger creation — honest degradation, no fake estimates.
    let progressBar: ReturnType<typeof createProgressBar> | null = null;

    // v4.11 Slice 1 — per-turn delta coalescer (logic layer). Batches
    // subsequent deltas into one streamPartial write; the first delta of
    // each segment still paints immediately (see onDelta below).
    // `flushStreamDeltas` is the single sink that reaches the renderer —
    // every paint still goes through display.streamPartial unchanged.
    let coalesceBuf = '';
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let streamSegmentPainted = false;
    const flushStreamDeltas = (): void => {
      if (coalesceTimer !== null) { clearTimeout(coalesceTimer); coalesceTimer = null; }
      if (coalesceBuf.length === 0) return;
      const batch = coalesceBuf;
      coalesceBuf = '';
      progressBar?.hide();
      this.opts.display.streamPartial(batch);
    };

    try {
      const result = await this.opts.agent.runConversation(baseHistory, {
        stream: streamingEnabled,
        // v4.12 BE.1 — seed the per-session token cap with tokens already spent
        // this session, so the cap enforces across turns (not just this run).
        sessionTokensSoFar: this.sessionId
          ? (this.opts.sessionManager.getSessionTokens?.(this.sessionId) ?? 0)
          : 0,
        // v4.11 Slice 3 — wake the dead AbortSignal wire (Phase A
        // audit A6.1). All downstream consumers (between-iter check,
        // pre-tool check, callProvider forward into adapters) were
        // already wired in v4.6 prep; this single line is the
        // upstream-side trigger.
        signal: turnAbort.signal,
        // v4.12.1 Slice 2b — mid-turn steer pull. The loop drains this at its
        // safe boundary and injects the nudge as tool-stream context. The
        // controller owns the buffer; an interrupt clears it (below).
        drainSteer: () => this.duringTurnInput.drainSteer(),
        // v4.11 Slice 4 — expose the per-turn runtime context to
        // tools via `agent.getCurrentTurnContext()`. The spawn /
        // fanout facades read it to thread parent signal + cost
        // accumulator + trace emitter through to the coordinator.
        turnContext,
        onFirstDelta: streamingEnabled
          ? wrapTurnId(() => {
              stopIndicatorOnce();
              streamingActive = true;
              // v4.11 Slice 1 — a new stream segment is starting (this
              // fires per provider-call iteration). Flush any residual
              // from the prior segment and arm the immediate first paint
              // so each segment's first token lands without batching delay.
              flushStreamDeltas();
              streamSegmentPainted = false;
              // v4.1.5 Phase 1d (Q-OBV-b) — separator emission MOVED
              // out of onFirstDelta because that callback fires per
              // provider-call iteration (firstDeltaFired resets each
              // callProvider invocation). The separator-emit now
              // lives in onDelta below, gated by `firstStreamByteSeen`
              // which only flips once per turn.
            })
          : undefined,
        onDelta: streamingEnabled
          ? wrapTurnId((text: string) => {
              // v4.1.5 Phase 1d (Q-OBV-b) — definitive separator
              // emission point. This is the FIRST text byte landing
              // on screen this turn. Fires the muted rule BEFORE
              // streamPartial writes the `┃ Aiden` header so the
              // visual order is:
              //   ┊ tool rows...
              //   ────────────  ← separator
              //   ┃ Aiden
              //   {text}
              // Idempotent via `firstStreamByteSeen` + the
              // `separatorEmitted` flag inside emitToolReplySeparator.
              // No-op when no tool fired (turnHadTools=false).
              if (!firstStreamByteSeen) {
                firstStreamByteSeen = true;
                emitToolReplySeparator();
              }
              // v4.11 Slice 1 — first delta of the segment paints
              // immediately (TTFT untouched); subsequent deltas batch
              // until the timer or size threshold, then flush as one
              // streamPartial write. progressBar.hide() runs on every
              // paint path (here and in flushStreamDeltas) — the bar
              // lives ABOVE streamed text and repaints on the next
              // onProgress event.
              if (!streamSegmentPainted) {
                streamSegmentPainted = true;
                progressBar?.hide();
                this.opts.display.streamPartial(text);
              } else {
                coalesceBuf += text;
                if (coalesceBuf.length >= STREAM_COALESCE_MAX_CHARS) {
                  flushStreamDeltas();
                } else if (coalesceTimer === null) {
                  coalesceTimer = setTimeout(flushStreamDeltas, STREAM_COALESCE_MS);
                }
              }
            })
          : undefined,
        onToolCallStart: streamingEnabled
          ? wrapTurnId((call: import('../../providers/v4/types').ToolCallRequest) => {
              // v4.11 Slice 1 — segment boundary: flush buffered prose
              // before the tool indicator paints, preserving order.
              flushStreamDeltas();
              this.opts.display.streamToolIndicator(call.name);
            })
          : undefined,
        // v4.8.0 Phase 2.3 fix-2 — uiOnly events route to the display
        // layer. The Phase 2.1 dispatch branch in aidenAgent.ts skips
        // onToolCall('before'), which is what normally fires
        // beforeFirstToolHook → stopIndicatorOnce. Without this stop
        // call, the 250ms indicator tick walks up 2 lines and erases
        // our paint within a quarter-second. Stop the indicator here,
        // mirroring how a first regular tool call stops it. Phase 2.3
        // handles ui_task_update + ui_task_done; the other 5 event
        // names land in Phase 2.4 (renderer silent-ignores them).
        //
        // v4.10 Slice 10.2 — persistence: tee every ui_* emission into
        // run_events keyed on the current REPL turn's runId. Routed
        // through createOnUiEventHandler so the integration test
        // exercises the EXACT same code path production uses
        // (mock-blindness fix; see Slice 10.1b retrospective).
        // v4.11 Slice 3 — also turnId-guard the ui-event handler. A
        // late ui_task_update from a cancelled turn would otherwise
        // paint a trail row attributed to the wrong turn. The factory
        // returns a stateless closure; wrapping it preserves the
        // existing renderer + run_events tee semantics for live events.
        onUiEvent: wrapTurnId(createOnUiEventHandler({
          display:           this.opts.display,
          runStore:          replRunStore,
          runId:             replRunId,
          // v4.10 Slice 10.2b — pass the REPL session id so the rich
          // emit row gets session_id without the writer JOIN-ing to runs.
          sessionId:         this.sessionId ?? null,
          stopIndicatorOnce,
          // v4.13 Gap 1 — capture the model's own done-declaration for
          // the verify-before-done gate below (last one wins).
          onTaskDone:        (args) => { declaredTaskDone = args; },
        })),
        onProgress: streamingEnabled
          ? wrapTurnId((outputTokens: number, maxTokens?: number) => {
              if (indicatorStopped === false) return;
              // Lazy-create on first event. The indicator must already
              // be stopped (first delta arrived) so the bar paints on
              // its own line below where the indicator was. If the
              // indicator is still up, skip — the bar would land on
              // the indicator line and get clobbered by the next tick.
              if (!progressBar) {
                progressBar = createProgressBar(
                  process.stdout as NodeJS.WriteStream,
                  // Display exposes its skin via getter on the
                  // implementation; cast to any to avoid widening
                  // the public Display surface for one-shot use.
                  (this.opts.display as unknown as { skin: import('./skinEngine').SkinEngine }).skin,
                );
              }
              progressBar.update(outputTokens, maxTokens);
            })
          : undefined,
      });
      stopIndicatorOnce();
      // Hide the progress bar before any post-stream content
      // (statusFooter, the next prompt) lands on its line.
      progressBar?.hide();
      if (streamingActive) { flushStreamDeltas(); this.opts.display.streamComplete(); }

      this.history = result.messages;
      this.totalUsage.inputTokens += result.totalUsage.inputTokens;
      this.totalUsage.outputTokens += result.totalUsage.outputTokens;
      // v4.11 Slice 4 — roll subagent token spend into the parent
      // turn's totalUsage so the post-turn footer + session totals
      // reflect both parent and child cost. The coordinator pushed
      // per-child contributions into `turnContext.costAccumulator`
      // synchronously as children completed; reading it here (after
      // runConversation returned) is race-free because the agent
      // loop awaits every tool dispatch (including the spawn /
      // fanout facade calls) before returning.
      if (turnContext.costAccumulator.totalTokens > 0) {
        this.totalUsage.inputTokens  += turnContext.costAccumulator.inputTokens;
        this.totalUsage.outputTokens += turnContext.costAccumulator.outputTokens;
      }

      // v4.6 Phase 2Q-B — finalize the REPL parent-run row on success.
      // `finishReason` from the agent loop maps directly into our DB
      // status: `stop` → completed; `interrupted` / `tool_loop` →
      // surface as 'interrupted' so it's visible in `runs list`;
      // `budget_exhausted` / `error` → failed. Wrapped in try/catch
      // so even a runStore write failure here can't crash the REPL.
      if (replRunStore && replRunId !== null) {
        try {
          const dbStatus =
            result.finishReason === 'stop'        ? 'completed'  :
            result.finishReason === 'interrupted' ? 'interrupted':
            result.finishReason === 'tool_loop'   ? 'interrupted':
            'failed';
          replRunStore.setStatus(replRunId, dbStatus, {
            finishReason: result.finishReason,
            completedAt:  Date.now(),
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[runs] failed to finalize REPL parent-run row:',
            err instanceof Error ? err.message : String(err));
        }
      }
      // v4.13 Gap 1 — verify-before-done gate. The model narrates; the
      // runtime keeps score: a clean `stop` no longer completes the task
      // on prose. The row enters `pending_verification` (crash-honest:
      // a death mid-decision leaves "not yet verified", never a lying
      // `completed`), then the verdict policy decides over this turn's
      // verifier evidence:
      //   evidence-backed side effects   → completed (+ handles stored)
      //   claimed side effect, no proof  → verification_failed (surfaced)
      //   only weak/unverifiable claims  → completed_unverified (honest
      //                                    downgrade, surfaced)
      // A model-declared ui_task_done failure finalizes as `failed`
      // regardless of finishReason — a declared failure is never
      // upgraded. Non-`stop` finishes route to 'failed' as before.
      if (replTaskStore && replTaskId !== null) {
        try {
          // v4.13 Gap 4 — the REPL and the daemon runner share ONE
          // finalization policy (computeTaskFinalization): status +
          // evidence envelope + job-card, all landing in a single
          // finalize UPDATE. The REPL keeps its user-facing surfaces.
          const declaredStatus =
            declaredTaskDone && typeof (declaredTaskDone as Record<string, unknown>).status === 'string'
              ? String((declaredTaskDone as Record<string, unknown>).status)
              : null;
          const fin = computeTaskFinalization(
            {
              finishReason:   result.finishReason,
              toolCallTrace:  result.toolCallTrace,
              declaredStatus,
            },
            { approvalMode: this.opts.approvalEngine.getMode() },
          );
          if (result.finishReason === 'stop') {
            // Crash-honesty intermediate state (see Gap 1).
            replTaskStore.setStatus(replTaskId, 'pending_verification');
          }
          replTaskStore.finalizeVerification(replTaskId, fin.status, fin.evidence, fin.jobCard);
          if (result.finishReason === 'stop' && !(declaredStatus && declaredStatus !== 'success')) {
            if (fin.status === 'verification_failed') {
              const what = fin.evidence.failures
                .map((f) => `${f.tool} (${f.reason})`)
                .join(', ');
              this.opts.display.warn(
                `Task verification failed — side effect claimed without evidence: ${what}. ` +
                `See /tasks ${replTaskId}.`,
              );
            } else if (fin.status === 'completed_unverified') {
              this.opts.display.dim(
                `(task completed unverified — side effects lacked hard evidence; /tasks ${replTaskId})`,
              );
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[tasks] failed to finalize REPL task row:',
            err instanceof Error ? err.message : String(err));
        }
      }
      // Clear the shared ref so a subsequent turn (or stray
      // spawn/fanout dispatched between turns from a slash command
      // handler) doesn't see a stale parent id.
      if (replParentRunRef) {
        replParentRunRef.runId     = null;
        replParentRunRef.sessionId = null;
      }

      // Phase 16d: surface inline confirmations for verified memory writes.
      // We MUST gate on verified=true (the post-write read flag from
      // MemoryGuard) — HonestyEnforcement uses the same flag to catch
      // fabricated "I remembered X" claims, so showing it without the
      // verification would be the exact bug we just shipped a fix for.
      // Unverified writes get a quieter line so the user knows the model
      // tried but the round-trip didn't confirm.
      renderMemoryConfirmations(result.toolCallTrace, this.opts.display);

      // Phase v4.1.2-memory-AB: accumulate the turn's tool-call trace
      // so the session distiller can derive deterministic fields
      // (files_touched / tools_used) at exit.
      if (result.toolCallTrace && result.toolCallTrace.length > 0) {
        this.sessionToolTrace.push(...result.toolCallTrace);
      }

      // v4.11 — artifact registry capture. Register files this turn
      // produced (successful, verifier-ok file-producing tools) with
      // provenance back to the run + task. Reuses the already-walked
      // toolCallTrace; best-effort so a capture failure never breaks the
      // turn (same discipline as the per-turn task create).
      const artifactStore = this.opts.replArtifactStore;
      if (artifactStore && this.sessionId && result.toolCallTrace) {
        for (const t of result.toolCallTrace) {
          try {
            const a = captureArtifactFromTrace(t);
            if (!a) continue;
            const artifactId = artifactStore.create({
              path:      a.path,
              kind:      a.kind,
              tool:      t.name,
              action:    a.action,
              sessionId: this.sessionId,
              runId:     replRunId ?? null,
              taskId:    replTaskId ?? null,
              bytes:     a.bytes,
            });
            // Close the reserved tasks.artifactIds field.
            if (replTaskId && this.opts.replTaskStore) {
              this.opts.replTaskStore.appendArtifactId(replTaskId, artifactId);
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[artifacts] capture failed:',
              err instanceof Error ? err.message : String(err));
          }
        }
      }

      // v4.11 Slice 3 — surface an explicit "(turn interrupted)"
      // confirmation when the agent loop returned finishReason
      // ='interrupted'. Without this, a cancelled turn drops the user
      // back at a fresh prompt with no visible confirmation that the
      // press took effect — easily mistaken for "Ctrl+C did nothing"
      // and double-pressed into force-exit unintentionally. Dim so
      // it sits between the tool trail and the post-turn footer
      // without screaming. Skips when the model managed to emit
      // partial finalContent before abort (rare; the regular reply
      // path renders that content).
      if (result.finishReason === 'interrupted' && !result.finalContent) {
        emitToolReplySeparator();
        this.opts.display.dim('(turn interrupted)');
      }

      // v4.1.6 spike (TCE) — tool-loop terminal surface. When the
      // agent ended the turn via the recovery controller's surface
      // stage, render a structured-failure card instead of the
      // (empty) reply. Same chrome as auth / platform capability
      // cards — fits the established Aiden UX language for
      // "the action you wanted didn't happen, here's why and what
      // you can do." Surface BEFORE the tool→reply separator path
      // below because there's no agent reply to introduce.
      if (result.finishReason === 'tool_loop' && result.toolLoopCard) {
        // Emit the muted rule so the card visually separates from
        // the tool trail above it.
        emitToolReplySeparator();
        this.opts.display.capabilityCard(result.toolLoopCard);
      } else if (result.finalContent && !streamingActive) {
        // When streaming was active and emitted the final content
        // already, skip the markdown re-render — we'd otherwise
        // duplicate text.
        //
        // v4.1.5 Issue O — non-streaming reply path. Emit the muted
        // rule between the tool trail and the agent header before
        // the one-shot reply lands. Idempotent + tool-gated by
        // `emitToolReplySeparator`.
        emitToolReplySeparator();
        this.opts.display.write(this.opts.display.agentTurn(result.finalContent));
      }

      // v4.1.6 Polish 2 — post-render skill-proposal handler.
      // The agent loop now SKIPS the inquirer prompt when a
      // prompt callback is wired, surfacing the SkillProposal
      // here instead. We fire the prompt AFTER the agent reply
      // has rendered so the user sees the answer before being
      // asked "save this as a reusable skill?" — fixing the
      // v4.1.5 visual-smoke regression where the prompt fired
      // mid-turn and clobbered the reply.
      //
      // Wrapped in try/catch so a buggy proposal flow never
      // breaks the chat loop. A successful save surfaces a
      // dim confirmation line that fits the established
      // memory-confirmation chrome.
      if (result.skillProposal && this.opts.callbacks?.handleSkillProposal) {
        try {
          const saveResult = await this.opts.callbacks.handleSkillProposal(
            result.skillProposal,
          );
          if (saveResult?.created && saveResult.skillName) {
            this.opts.display.dim(
              `  ✓ Saved as skill: ${saveResult.skillName}`,
            );
          }
        } catch {
          /* defensive — never let proposal flow break the chat loop */
        }
      }

      if (this.sessionId) {
        // Only persist the new tail of messages — what got added this turn.
        const newSlice = this.history.slice(turnStart);
        this.opts.sessionManager.recordTurn(
          this.sessionId,
          newSlice,
          result.totalUsage,
        );
      }

      this.setStatusState({ kind: 'ready' });
      this.lastTurnElapsedMs = Date.now() - turnStartedAt;
      // v4.8.0 Slice 7 — record per-turn outcome for the status dot.
      this.turnCount += 1;
      this.lastTurnOutcome =
        result.finishReason === 'stop'             ? 'ok'    :
        result.finishReason === 'budget_exhausted' ? 'warn'  :
        result.finishReason === 'interrupted'      ? 'muted' : 'error';
      // v4.5 Phase 8b — surface a deferred daemon-scheduling tip
      // queued at turn start. Renders AFTER the agent's response per
      // Q-P8b-3(b) — the user reads the answer first, then sees the
      // ambient capability hint.
      if (_deferredTip) {
        try {
          this.opts.display.dim(_deferredTip.message);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { getSuggestionEngine } = require('../../core/v4/suggestionEngine');
          getSuggestionEngine().recordFired(_deferredTip.slot);
        } catch { /* defensive */ }
        _deferredTip = null;
      }
      // Tier-3.1a: dim full-width rule between the agent reply and the
      // post-turn status footer. v4.9.0 pre-ship UI: prepend a blank
      // line so the response zone gets breathing room above the rule
      // — matches the `\n\n` blank already below `▎ Aiden` header.
      this.opts.display.write(`\n  ${this.opts.display.rule()}\n`);
      this.renderStatusLine();
      // v4.1.5+ Path A — finalize the loop trace. No-op if the env
      // var is unset OR if the turn didn't trip any threshold. When
      // it DOES emit, the snapshot path goes to a dim status line so
      // the user (and any teammate they're sharing the log with)
      // knows where to grab the diagnostic file.
      try {
        const snapPath = await loopTracer.finalize();
        if (snapPath) {
          this.opts.display.dim(`[loop-trace] wrote ${snapPath}`);
        }
      } catch { /* defensive */ }
    } catch (err) {
      stopIndicatorOnce();
      // v4.1.4 Part 1.6: error path must also hide the progress bar
      // so it doesn't leak across the boundary into the error chrome
      // or the next prompt.
      progressBar?.hide();
      if (streamingActive) { flushStreamDeltas(); this.opts.display.streamComplete(); }
      // v4.11 Slice 3 — abort-aware early return. If the thrown error
      // is an AbortError (or the turn's signal aborted before the
      // agent's own catch could route it), this is a USER ACTION not
      // a system fault: skip the printError + capability-card chrome
      // and just dim "(turn interrupted)" + cycle the status back to
      // ready. Mirrors the success-path interrupted branch so a
      // throw-on-cancel vs return-on-cancel race ends up at the same
      // user-visible surface.
      const _abortHit =
        (err instanceof Error && err.name === 'AbortError') ||
        turnAbort.signal.aborted;
      if (_abortHit) {
        // v4.11 regression patch — stop the indicator BEFORE printing
        // the dim line so the setInterval can't paint a stray
        // "calling provider… (Ns)" line on top of our cancel
        // confirmation. The success-path interrupted branch already
        // had this implicit (stopIndicatorOnce fired right after
        // runConversation returned cleanly); the throw-path was the
        // gap. Idempotent — safe even if onFirstDelta already stopped.
        stopIndicatorOnce();
        this.opts.display.dim('(turn interrupted)');
        // Status footer still renders so the user sees the elapsed
        // pill — matches the success path's chrome.
        if (replParentRunRef) {
          replParentRunRef.runId     = null;
          replParentRunRef.sessionId = null;
        }
        if (replRunStore && replRunId !== null) {
          try {
            replRunStore.setStatus(replRunId, 'interrupted', {
              finishReason: 'interrupted',
              completedAt:  Date.now(),
            });
          } catch { /* persistence faults must not crash REPL */ }
        }
        if (replTaskStore && replTaskId !== null) {
          try { replTaskStore.setStatus(replTaskId, 'cancelled'); }
          catch { /* persistence faults must not crash REPL */ }
        }
        this.setStatusState({ kind: 'ready' });
        this.lastTurnElapsedMs = Date.now() - turnStartedAt;
        this.turnCount += 1;
        this.lastTurnOutcome = 'muted';
        this.opts.display.write(`\n  ${this.opts.display.rule()}\n`);
        this.renderStatusLine();
        return;
      }
      // v4.6 Phase 2Q-B — finalize REPL parent-run row on error.
      // Visible in `aiden runs list` as a failed top-level row so
      // operators can correlate a chat error with whatever children
      // it had already kicked off this turn.
      if (replRunStore && replRunId !== null) {
        try {
          replRunStore.setStatus(replRunId, 'failed', {
            finishReason: 'error',
            completedAt:  Date.now(),
          });
        } catch (e2) {
          // eslint-disable-next-line no-console
          console.warn('[runs] failed to mark REPL parent-run failed:',
            e2 instanceof Error ? e2.message : String(e2));
        }
      }
      // v4.10 Slice 10.8 — symmetric task-lite failure transition.
      // Thrown errors out of runConversation → task status='failed'.
      // /tasks listing surfaces this so the user can re-issue the
      // prompt with a fresh task or /adjust the goal.
      if (replTaskStore && replTaskId !== null) {
        try {
          replTaskStore.setStatus(replTaskId, 'failed');
        } catch (e3) {
          // eslint-disable-next-line no-console
          console.warn('[tasks] failed to mark REPL task failed:',
            e3 instanceof Error ? e3.message : String(e3));
        }
      }
      if (replParentRunRef) {
        replParentRunRef.runId     = null;
        replParentRunRef.sessionId = null;
      }
      const msg = (err as Error)?.message ?? String(err);
      // v4.1.3-prebump: classify the error so the suggestion below
      // points at the actual fix instead of the generic "/model or
      // doctor" line. 413 / 429 / auth get tailored hints; everything
      // else keeps the legacy fallback. Use the live providerId so
      // the user sees WHICH provider blew up (matters when fallback
      // adapters rotate slots mid-turn).
      const cls = classifyProviderError(err);
      const tailored = suggestForErrorClass(cls, this.currentProviderId);
      // v4.1.3-essentials: on `auth` class errors we have enough state
      // (which provider, what to run) to render a capability card —
      // structured "what auth's missing, what you can still do, how to
      // fix" is more useful than the bare message + one-line hint.
      // Other classes keep the printError single-line surface; their
      // hints are already specific.
      if (cls === 'auth') {
        const p = this.currentProviderId;
        this.opts.display.printError(msg);
        this.opts.display.capabilityCard({
          title: `${p} authentication required`,
          canStill: [
            'Continue chatting if a non-auth provider is configured (run `/model`)',
            'Run `/auth status` to see which providers are signed in',
            'Run `aiden doctor --providers` for a fuller liveness probe',
          ],
          cannotReliably: [
            `Call ${p} until credentials are refreshed`,
            'Trust any cached responses that depended on this provider',
          ],
          fix:
            `Run \`/auth login ${p}\` if it's an OAuth provider, or set the ` +
            `relevant API key env var. Then retry — no need to restart Aiden.`,
        });
      } else {
        this.opts.display.printError(
          msg,
          tailored
            ?? 'Run `/model` to switch providers or `aiden doctor` to diagnose.',
        );
      }
      this.setStatusState({ kind: 'ready' });
      this.lastTurnElapsedMs = Date.now() - turnStartedAt;
      // v4.8.0 Slice 7 — error path also bumps the turn counter and
      // records a red state-dot outcome for the next footer render.
      this.turnCount += 1;
      this.lastTurnOutcome = 'error';
      // v4.1.5+ Path A — finalize the loop trace on the error path
      // too. Loop patterns that ended in an error are exactly the
      // ones most worth capturing for diagnosis.
      try {
        const snapPath = await loopTracer.finalize();
        if (snapPath) {
          this.opts.display.dim(`[loop-trace] wrote ${snapPath}`);
        }
      } catch { /* defensive */ }
    } finally {
      // v4.11 Slice 3 — release the per-turn cancel handles. ORDER
      // MATTERS:
      //   1. Drop activeTurnId FIRST so any late callbacks already
      //      in flight (race window between abort and SSE reader's
      //      first dead byte) see a mismatch and silently no-op.
      //   2. Null the controller ref next — a stray Ctrl+C arriving
      //      between turns now sees `currentAbortController === null`
      //      and routes to graceful shutdown (the v4.10.0 behaviour
      //      at composer-idle).
      //   3. Reset the two-press timestamp so a previous turn's
      //      first-press doesn't fast-path force-exit on the next
      //      turn's first Ctrl+C.
      // Only clear when WE own the active slot — defensive against a
      // race where a nested runAgentTurn (impossible in production
      // today, cheap insurance for tests / future surfaces) re-armed.
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null;
      }
      if (this.currentAbortController === turnAbort) {
        this.currentAbortController = null;
      }
      this.lastInterruptAt = 0;
      // v4.12.1 Slice 2a — detach the during-turn listener + restore raw mode
      // on EVERY exit path (success / error / abort / throw).
      try { detachTurnInput(); } catch { /* defensive — never break turn teardown */ }
      // Slice 2c — clear the live composer so the row hands cleanly back to the
      // normal prompt (no stale typed text lingering on the owned row).
      try { this.opts.display.clearComposer(); } catch { /* defensive */ }

      // v4.11 Slice 1 — explicit streaming-handoff boundary, exit
      // side. Mirrors the pauseFrame at the top of runAgentTurn so
      // the legacy indicator gate releases regardless of how the
      // turn ended (success, error, throw).
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { isFrameModeRequested, resumeFrame } = require('./frame') as typeof import('./frame');
        if (isFrameModeRequested()) await resumeFrame();
      } catch { /* never break a turn on frame cleanup */ }
    }
  }

  // ── Startup card (Phase 26.2.4: neofetch-style sectioned) ──────────
  // Boot rhythm:
  //
  //     [AIDEN ASCII art in brand orange]
  //       Autonomous AI Engine                            (muted tagline)
  //
  //     ● core online    ● mode auto    ● model X    ● memory active
  //     ────────────────────────────────────────────────────────────
  //
  //     Environment                Capabilities
  //       OS         Windows 11      web         research · extract
  //       shell      PowerShell      browser     navigate · automate
  //       runtime    local-first     files       read · patch · organize
  //       tools      44 loaded       execution   shell · code · workflows
  //       skills     72 loaded       memory      persistent recall
  //
  //     ────────────────────────────────────────────────────────────
  //
  //     [scroll-shaped credits footer with ♥ + GitHub/Web/Contact]
  //
  //     ▲ Type your message · /help for commands · /skills to add more
  //
  // Width-responsive: side-by-side at ≥80 cols, stacked below; scroll
  // collapses to plain 4-line credits below 75 cols.
  async renderStartupCard(): Promise<void> {
    const display = this.opts.display;

    // Tier-3.1a: skip entirely on non-TTY so piped/scripted callers
    // don't get scrollback chatter on stdout.
    if (!process.stdout.isTTY) return;

    // Channel summary — observable, not banner-essential, but kept so
    // status pills aren't the only place a user sees telegram health.
    const cm = this.opts.channelManager;
    if (cm) {
      const adapterStatuses = cm.getStatus().map((s) => {
        const adapter = cm.get(s.name);
        const tg = adapter as (TelegramAdapter & {
          getBotUsername?: () => string | null;
          getState?:       () => 'inactive' | 'connecting' | 'active' | 'degraded' | 'conflict';
        }) | undefined;
        const botHandle =
          typeof tg?.getBotUsername === 'function' ? tg.getBotUsername() : null;
        const state =
          typeof tg?.getState === 'function' ? tg.getState() : undefined;
        return { id: s.name, healthy: s.healthy, botHandle, state };
      });
      void summarizeChannelState({ adapters: adapterStatuses });
    } else {
      void summarizeChannelState(null);
    }

    const cols = display.cols();
    const isNarrow = cols < 60;
    const showEnvCapBlock = cols >= 70;
    const version = AIDEN_VERSION;

    display.write('\n');

    if (isNarrow) {
      // Compact — single-line text logo + one-line capability summary.
      display.write(`  ${display.brand('AIDEN')}  ${display.muted(`v${version}`)}\n`);
      display.write(
        `  ${display.muted('Local AI · controls your computer · never forgets')}\n`,
      );
    } else {
      // Wide — full ASCII art + subtitle. Tier-3.1c: dropped the
      // tagline + sponsor lines from the top section because they
      // duplicate the credits already inside the scrollFooter at
      // the bottom of the boot card. Subtitle stays — it's the only
      // brand anchor between the ASCII art and the pills row.
      display.printBanner(version);
      display.write(`  ${display.muted('Autonomous AI Engine')}\n`);
      display.write('\n');
    }

    // Status pills.
    // Phase v4.1.2-version-display: append the running version as the
    // fifth pill so users see what they're on without invoking
    // `aiden --version`. Sourced from the build-injected core/version.ts.
    display.write(
      display.statusPillsRow({
        coreOnline:   true,
        mode:         'auto',
        model:        this.currentModelId,
        memoryActive: true,
        providerOk:   !this.opts.unconfigured,
        version:      AIDEN_VERSION,
      }) + '\n',
    );

    // v4.6 Phase 3A — operator kill-switch indicator. Lands ABOVE
    // the blank-line + provider-source annotation so an operator
    // who paused in a prior session sees the state immediately on
    // boot, alongside the standard status pills. Single dim
    // warning line; no special chrome — the message itself is the
    // visual signal.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getSpawnPause } = require('../../core/v4/subagent/spawnPause');
      const s = getSpawnPause().status();
      if (s.paused) {
        const reasonSuffix = s.reason ? ` · ${s.reason}` : '';
        const durationSuffix = typeof s.durationMs === 'number'
          ? ` · ${formatDuration(s.durationMs)}`
          : '';
        display.warn(`spawn-pause: ON${reasonSuffix}${durationSuffix} — use /spawn-pause off to resume`);
      }
    } catch {
      // Singleton not initialised (test stubs, etc.) — silently skip.
    }

    // v4.5 TUI polish — blank line so the status pills row doesn't
    // crowd the muted source annotation right beneath it.
    display.write('\n');

    // v4.1.3-prebump: dim source annotation under the pills row so the
    // user can see WHY this provider/model was chosen — closes the
    // information gap that made Case 3 (persisted-config) look like a
    // bug ("why is it still on groq when I auth'd chatgpt-plus?"). One
    // line, dim, only when the source is informative.
    const sourceLabel = bootSourceLabel(this.opts.initialBootSource);
    if (sourceLabel) {
      display.write(`  ${display.muted(sourceLabel)}\n`);
    }

    // Tier-3.1b: rule + environment/capabilities block + rule + scroll
    // + bottom prompt hint. Skipped at <70 cols to keep the narrow
    // boot card from wrapping into noise.
    display.write(`  ${display.rule()}\n`);

    if (showEnvCapBlock) {
      // Detect environment lazily (cheap on every boot — no caching
      // needed; tools/skills counts are already loaded by this point).
      const toolsCount = this.opts.toolRegistry.list().length;
      let skillsLoaded = 0;
      try {
        skillsLoaded = (await this.opts.skillLoader.list()).length;
      } catch {
        skillsLoaded = 0;
      }

      display.write('\n');
      // Pass sideBySideThreshold=120 so 70-119 cols stack vertically
      // (per the tier3.1b dispatch's width-tier policy) and only
      // ≥120 renders the full side-by-side block.
      display.write(
        display.twoColumnBlock(
          {
            title: 'Environment',
            rows:  [
              { key: 'OS',       value: detectOS() },
              { key: 'shell',    value: detectShell() },
              { key: 'runtime',  value: 'local-first' },
              { key: 'tools',    value: `${toolsCount} loaded` },
              { key: 'skills',   value: `${skillsLoaded} loaded` },
            ],
          },
          {
            title: 'Capabilities',
            rows:  [
              { key: 'web',       value: 'research · extract' },
              { key: 'browser',   value: 'navigate · automate' },
              { key: 'files',     value: 'read · patch · organize' },
              { key: 'execution', value: 'shell · code · workflows' },
              { key: 'memory',    value: 'persistent recall' },
            ],
          },
          // Tier-3.1c: lowered from 120 → 100 so wide-but-not-huge
          // terminals (laptop screens, default Windows Terminal) get
          // the side-by-side block instead of the stacked fallback.
          // Each column at ~38 chars + 4-char separator + 2-char
          // indent fits in 82 chars; 100 leaves 18 chars headroom.
          { sideBySideThreshold: 100 },
        ) + '\n',
      );
      display.write('\n');
      display.write(`  ${display.rule()}\n`);
      display.write('\n');
    }

    // Scroll footer (parchment at ≥80 cols, single-line credits below).
    display.write(display.scrollFooter() + '\n');

    // v4.5 update system — boxed three-option prompt rendered AFTER
    // the boot card / status pills (Q-U5b less-intrusive position),
    // BEFORE the bottomPromptHint. Fires only when:
    //   - update check came back with `updateAvailable && !skipped`
    //   - stdin is a TTY (non-interactive boots short-circuit to 'later')
    // 5-second timeout defaults to 'later' so a user away from
    // keyboard isn't held up. Skip-on-'n' writes the version to the
    // .update_check.json cache so subsequent boots stay quiet until
    // a newer release ships.
    try {
      // v4.9.1 — modal sits BELOW the welcome banner with a blank
      // separator. Prevents the box from visually overlapping the
      // boot card on first-paint (smoke-reported regression).
      display.write('\n');
      await this.maybeShowBootUpdatePrompt();
    } catch { /* never let the update prompt crash boot */ }

    // ONB1 slice 9 — one-time first-run hint banner. Renders below
    // the boot card on the very first session after a successful
    // setup; dismissed when the user sends their first message or
    // runs /dismiss. Lazy-required so test-harness sessions that
    // omit `paths` don't pay the fs cost.
    // v4.12 — true when the speaks-first onboarding intro fires this boot.
    // Hoisted to function scope so the greeter block below can suppress
    // itself: the intro OWNS the boot, so a contradictory "welcome back /
    // last session Nh ago" must not print under it (matters for the
    // upgrade cohort — existing greeter history + empty USER.md).
    let onboarded = false;
    try {
      if (this.opts.paths) {
        // v4.12 — speaks-first onboarding for a brand-new user (USER.md
        // empty + marker absent). When the intro fires, skip the
        // /walkthrough tip so the first screen stays uncluttered.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { renderOnboardingIntro } = require('./onboarding/speakFirst') as typeof import('./onboarding/speakFirst');
        onboarded = await renderOnboardingIntro({ paths: this.opts.paths, out: process.stdout });
        if (!onboarded) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { renderFirstRunHint } = require('./repl/firstRunHint') as typeof import('./repl/firstRunHint');
          await renderFirstRunHint({ paths: this.opts.paths, out: process.stdout });
        }
      }
    } catch { /* never let a missing marker crash boot */ }

    // v4.9.3 Slice 1b — boot greeter. Silent on first-ever launch (lets
    // renderFirstRunHint above own boot #1), silent when /greeter off,
    // silent when no offer wins. Lazy-required so test-harness sessions
    // without `paths` wired skip the fs cost. Internal errors are
    // already swallowed inside renderGreeter; outer try/catch is the
    // belt-and-braces guarantee against a boot-crash regression.
    //
    // v4.12 — skipped entirely when onboarding fired this boot: the intro
    // owns the moment, so a "welcome back / last session Nh ago" offer
    // (or any other greeter offer) must not print under "Hi — I'm Aiden".
    // Same spirit as the first-launch-silent path above.
    try {
      if (this.opts.paths && !onboarded) {
        await renderGreeter({
          paths:   this.opts.paths,
          version: AIDEN_VERSION,
          display: this.opts.display,
        });
      }
    } catch { /* never let the greeter crash boot */ }

    // v4.9.0 pre-ship UI: hint moved BEFORE the closing rule so the
    // rule sits adjacent to the active prompt (it becomes the visual
    // top of the prompt zone). New order: blank · hint · blank · rule.
    // Banner content ends with the hint; the rule below it brackets
    // the user-input zone together with the new bottom-rule emission
    // in the REPL loop.
    display.write('\n');
    display.write(display.bottomPromptHint() + '\n');
    display.write('\n');
    display.write(`  ${display.rule()}\n`);
  }

  /**
   * v4.5 update system — orchestrates the boot prompt. Lazy-imports
   * the update modules so non-boot code paths (e.g. test harness
   * sessions constructed without paths wired) don't pay the cost.
   */
  private async maybeShowBootUpdatePrompt(): Promise<void> {
    if (!this.opts.paths) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cu = require('../../core/v4/update/checkUpdate') as typeof import('../../core/v4/update/checkUpdate');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const md = require('../../core/v4/update/installMethodDetect') as typeof import('../../core/v4/update/installMethodDetect');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ss = require('../../core/v4/update/skipState') as typeof import('../../core/v4/update/skipState');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bp = require('./updateBootPrompt') as typeof import('./updateBootPrompt');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ei = require('../../core/v4/update/executeInstall') as typeof import('../../core/v4/update/executeInstall');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ver = require('../../core/version') as { VERSION: string };

    const status = await cu.checkForUpdate({ paths: this.opts.paths, installedVersion: ver.VERSION });
    if (!status.updateAvailable || !status.latest || status.skipped) return;

    const method = md.detectInstallMethod();
    const choice = await bp.showBootUpdatePrompt({
      status, method,
      display: { write: (s) => this.opts.display.write(s), dim: (s) => this.opts.display.dim(s) },
    });

    if (choice === 'install') {
      if (method.inProcessInstallSupported) {
        // v4.9.1 — drive a live progress bar off the executor's
        // phase callback. The bar degrades cleanly on non-TTY, NO_COLOR,
        // and dumb terminals — see cli/v4/ui/progressBar.ts.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pb = require('./ui/progressBar') as typeof import('./ui/progressBar');
        const bar = pb.startProgressBar({
          label:  `Installing aiden-runtime ${status.latest}...`,
          phases: ['spawning', 'resolving', 'downloading', 'extracting', 'verifying', 'installed'],
        });
        const result = await ei.executeInstall({
          packageSpec: `aiden-runtime@${status.latest}`,
          onPhase: (p) => { bar.setPhase(p); bar.setPercent(pb.npmInstallPhasePercent(p)); },
        });
        if (result.success) {
          bar.complete(`aiden-runtime ${result.installedVersion ?? status.latest} installed. Restart Aiden to apply: type /quit then re-run \`aiden\`.`);
        } else {
          bar.fail('Install failed.');
          this.opts.display.warn(result.error ?? 'Install failed (no error message).');
        }
      } else {
        this.opts.display.write(`To update, run:\n  ${method.updateCommand(status.latest)}\n`);
      }
    } else if (choice === 'skip') {
      await cu.updateCacheFile(this.opts.paths, (current) => ss.applySkip(current, status.latest!));
      this.opts.display.dim(`  skipped ${status.latest}. Boot prompt resumes when a newer version ships.`);
    }
    // 'later' = no-op; prompt fires again next session.
  }

  /** Phase 22 Task 4: state transitions for the right-most segment. */
  setStatusState(state: StatusState): void {
    this.statusState = state;
  }

  // ── Status line (Phase 23.6: v3 visual style port) ──────────────────
  // Render the post-turn footer with provider, model, ctx gauge, and
  // elapsed time.  Optionally precedes the footer with a `prev ──→ next`
  // provider-switch line when the active provider has changed since the
  // last turn (matches v3 cli/aiden.ts:730).
  renderStatusLine(): void {
    const display = this.opts.display;
    const provider = this.currentProviderId;
    const model = this.currentModelId;

    if (
      this.lastFooterProvider !== null &&
      this.lastFooterProvider !== provider
    ) {
      display.write(display.providerSwitchLine(this.lastFooterProvider, provider) + '\n');
    }
    this.lastFooterProvider = provider;

    let limits;
    try {
      limits = this.modelMetadata.getLimits(provider, model);
    } catch {
      limits = this.modelMetadata.getDefaults();
    }
    const usedTokens = this.modelMetadata.estimateMessageTokens(this.history);
    const maxTokens = limits.contextLength;

    // v4.8.0 Slice 7 hotfix — predictable 1-blank-line rhythm: one
    // blank above the footer (visual breath after the reply), one
    // blank below (before the next prompt).
    //
    // v4.10 Slice 10.3 — the footer's full-density tier was extended
    // with brand prefix (`Aiden v<X.Y>`), session uptime (sessionMs
    // re-enabled), and spelled-out `last <elapsed>` for the per-turn
    // timer. Mid (≥100) and narrow (<100) tiers unchanged.
    display.write(
      '\n' + display.statusFooter({
        provider,
        model,
        ctxUsed: usedTokens,
        ctxMax: maxTokens,
        elapsedMs: this.lastTurnElapsedMs,
        turnCount: this.turnCount,
        sessionMs: Date.now() - this.startedAt,
        state:     this.lastTurnOutcome,
      }) + '\n\n',
    );
  }

  // ── Input ──────────────────────────────────────────────────────────
  private async readUserInput(api: ChatPromptApi): Promise<string> {
    // Phase 23.6 — v3-style ▲ prompt in brand orange.  Inquirer's
    // default `input` prompt prepends a `?` glyph; we override it with
    // our own bare prefix so the result reads `▲ <user input>`.
    const promptText = this.opts.display.promptPrefix();

    let raw = await api.readLine(promptText);
    if (raw == null) return '';

    // Tier-3.1a: stdin pre-tap (pasteIntercept) already converted any
    // bracketed-paste payload into a `[paste #N: …]` label before
    // inquirer saw it. Swap the label back for the original here so
    // the agent receives full content. User-typed labels with unknown
    // ids are left untouched.
    raw = expandPasteLabels(raw);

    // Bracketed paste polish (Phase 16): if the terminal still sent
    // paste markers (interceptor disabled — non-TTY or test promptApi),
    // strip them and accept the entire payload as one message.
    if (hasPasteMarkers(raw)) {
      const stripped = stripPasteMarkers(raw).replace(/\r/g, '');
      if (isCompletePaste(raw)) return await this.maybeCompressVisiblePaste(stripped);
      // Unterminated paste — still return the stripped content so the user
      // doesn't see escape sequences in their prompt.
      raw = stripped;
    }

    // v4.12.1 — belt-and-braces: remove ANY residual bracketed-paste marker
    // (embedded / partial), so no path ever surfaces a literal [200~/[201~.
    raw = stripAllPasteMarkers(raw);
    raw = raw.replace(/\r/g, '');

    // Multi-line via leading """.
    if (raw.startsWith('"""')) {
      const inline = raw.slice(3);
      // Single-line `"""hello"""` shortcut.
      if (inline.endsWith('"""')) {
        return await this.maybeCompressVisiblePaste(inline.slice(0, -3));
      }
      const buffer: string[] = [inline];
      while (true) {
        const next = await api.readLine('… ');
        if (next == null) break;
        if (next.endsWith('"""')) {
          buffer.push(next.slice(0, -3));
          break;
        }
        buffer.push(next);
      }
      return await this.maybeCompressVisiblePaste(buffer.join('\n').trim());
    }

    // Paste detection: multiple lines arrived in a single chunk. The
    // interceptor + expandPasteLabels path already produced the original
    // text — no extra echo needed since the user saw the `[paste #N: …]`
    // label in the input buffer. Pass the original through unchanged.
    if (raw.includes('\n')) return raw;

    // Slash command: invoke the legacy autocomplete dropdown only
    // when --no-ui (AIDEN_NO_UI=1) is set. The new aidenPrompt
    // handles the dropdown inline as the user types, so re-opening
    // a second prompt here would double-prompt — once in
    // aidenPrompt, once in inq.search. Tier-3.1.1 routes everything
    // through aidenPrompt unless the legacy path is explicitly
    // requested.
    if (isNoUiMode() && raw.startsWith('/')) {
      const matches = this.opts.commandRegistry.filter(raw);
      if (matches.length > 1) {
        try {
          const picked = await api.selectSlashCommand(async (input) => {
            const filterStr = input ?? raw;
            return this.opts.commandRegistry
              .filter(filterStr)
              .map((cmd) => ({
                name: renderCommandLabel(cmd),
                value: `/${cmd.name}`,
                description: cmd.description,
              }));
          });
          if (picked) return picked;
        } catch {
          // search not available or cancelled — fall through to raw.
        }
      }
    }

    // Tier-3-essentials: inline shell interpolation. If the prompt
    // contains `{!cmd}` spans, run each in parallel (5s timeout per
    // span, 500-char output cap) and splice the output back in. The
    // rewritten prompt is what reaches the agent — visible feedback
    // is a single dim line so the user sees that the work happened.
    if (hasInterpolation(raw)) {
      const spans = countSpans(raw);
      this.opts.display.dim(`[shell] running ${spans} interpolation${spans === 1 ? '' : 's'}…`);
      try {
        raw = await expand(raw);
      } catch {
        // expand() never rejects, but defence-in-depth.
      }
    }

    return raw;
  }

  /**
   * Tier-3.1: when a paste is large (>5 lines OR >500 chars), echo a
   * compact `[paste #<id>: …]` label to the user and persist the
   * original to disk so `/show <id>` can recall it later. The agent
   * still receives the full original text — only the visible echo is
   * compressed.
   *
   * MCP serve mode never reaches this path (REPL doesn't run there),
   * so the display.write here is safe.
   */
  private async maybeCompressVisiblePaste(text: string): Promise<string> {
    try {
      const result = await compressPaste(text);
      if (result.compressed && result.label) {
        // Echo the label only — newline-terminated for cleanliness.
        this.opts.display.write(`  ${this.opts.display.muted(result.label)}\n`);
      }
    } catch {
      // Paste compression is a polish feature; if disk write fails we
      // silently fall through to the original text rather than crash
      // the prompt loop.
    }
    return text;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Boot-card "Try:" hint (Phase 22 Task 1). Two concrete first-task
 * examples picked so a fresh user can press Enter on the wizard, see
 * the boot card, and have something specific to type within seconds.
 */
export const BOOT_TRY_HINT = `Try: 'play me a popular song'  or  'list my Downloads'`;

/**
 * Phase 26.2.4 — host OS pretty name for the boot-card Environment
 * block. Best-effort:
 *   - win32 release ≥10.0.22000 → "Windows 11", else "Windows 10"
 *   - darwin major maps to known names (Sequoia/Sonoma/…)
 *   - linux reads /etc/os-release PRETTY_NAME when available
 *
 * Returns the platform string verbatim on unknown systems. Pure (apart
 * from one optional sync read of /etc/os-release on linux); cheap.
 */
export function detectOS(): string {
  const platform = process.platform;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const osMod = require('node:os') as typeof import('node:os');
  if (platform === 'win32') {
    const m = osMod.release().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (m && parseInt(m[3], 10) >= 22000) return 'Windows 11';
    return 'Windows 10';
  }
  if (platform === 'darwin') {
    const major = parseInt(osMod.release().split('.')[0] ?? '0', 10);
    const names: Record<number, string> = {
      24: 'Sequoia',
      23: 'Sonoma',
      22: 'Ventura',
      21: 'Monterey',
      20: 'Big Sur',
    };
    return names[major] ? `macOS ${names[major]}` : 'macOS';
  }
  if (platform === 'linux') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fsSync = require('node:fs') as typeof import('node:fs');
      const text = fsSync.readFileSync('/etc/os-release', 'utf8');
      const m = text.match(/^PRETTY_NAME="([^"]+)"/m);
      if (m) return m[1];
    } catch {
      /* ignore — fallback below */
    }
    return 'Linux';
  }
  return platform;
}

/**
 * Phase 26.2.4 — best-effort shell name for the boot-card Environment
 * block. On Windows: "PowerShell + WSL2" when WSL_DISTRO_NAME is set,
 * else "PowerShell" when PSModulePath is present, else "cmd". On POSIX:
 * the basename of $SHELL, or "sh" as a last resort.
 */
export function detectShell(): string {
  if (process.platform === 'win32') {
    if (process.env.PSModulePath) {
      return process.env.WSL_DISTRO_NAME ? 'PowerShell + WSL2' : 'PowerShell';
    }
    return 'cmd';
  }
  const sh = process.env.SHELL ?? '';
  return sh.split('/').pop() || 'sh';
}

/**
 * Phase 22 Task 4 — discriminated union for the status bar's
 * right-most "current state" segment. Tagged so the formatter can
 * pick the glyph + colour without a string-match.
 *
 * - `ready`      idle, awaiting user input
 * - `generating` model is producing tokens; sinceMs starts the elapsed
 * - `exec`       a tool is executing (Group C wires this)
 * - `approve`    awaiting an approval prompt (Group C wires this)
 * - `retry`      rate-limited, retryUntilMs is the absolute deadline
 */
export type StatusState =
  | { kind: 'ready' }
  | { kind: 'generating'; sinceMs: number }
  | { kind: 'exec' }
  | { kind: 'approve' }
  | { kind: 'retry'; retryUntilMs: number };

/**
 * Format the status bar's right-most state segment text + colour kind.
 * Pure — `now` is injectable for tests.
 */
export function formatStatusState(
  state: StatusState,
  now: number = Date.now(),
): { text: string; colour: 'brand' | 'muted' | 'warn' } {
  switch (state.kind) {
    case 'generating': {
      const ms = Math.max(0, now - state.sinceMs);
      return { text: `⏵ ${formatDuration(ms)}`, colour: 'brand' };
    }
    case 'exec':
      return { text: '▶ exec', colour: 'brand' };
    case 'approve':
      return { text: '⊕ approve', colour: 'warn' };
    case 'retry': {
      const remainingMs = Math.max(0, state.retryUntilMs - now);
      const sec = Math.ceil(remainingMs / 1000);
      return { text: `⚠ retry ${sec}s`, colour: 'warn' };
    }
    case 'ready':
    default:
      return { text: 'ready', colour: 'muted' };
  }
}

/**
 * Render a 10-character progress bar coloured per the Phase 22 palette
 * — filled cells in brand orange, empty cells in soft cyan. Returns
 * the bar with surrounding `[` / `]` delimiters in muted.
 */
export function renderColouredProgressBar(
  used: number,
  max: number,
  width: number,
  display: Display,
): string {
  if (max <= 0) return display.muted('[' + '░'.repeat(width) + ']');
  const ratio = Math.max(0, Math.min(1, used / max));
  const filled = Math.round(ratio * width);
  return (
    display.muted('[') +
    display.brand('▓'.repeat(filled)) +
    display.muted('░'.repeat(width - filled)) +
    display.muted(']')
  );
}

export interface StatusLineArgs {
  provider: string;
  model: string;
  usedTokens: number;
  maxTokens: number;
  turn: number;
  maxTurns: number;
  state: StatusState;
  display: Display;
  /** Test seam — defaults to Date.now(). */
  now?: number;
}

/**
 * Phase 22 Task 4 status bar: vertical-bar separators, soft-cyan
 * labels and separator, brand progress fill, semantic state colour.
 *
 *   <provider>:<model> │ ctx U/M [bar] N% │ budget T/MT │ <state>
 */
export function formatStatusLine(args: StatusLineArgs): string {
  const { provider, model, usedTokens, maxTokens, turn, maxTurns, state, display } = args;
  const ctxPercent = maxTokens > 0
    ? Math.min(100, Math.round((usedTokens / maxTokens) * 100))
    : 0;
  const bar = renderColouredProgressBar(usedTokens, maxTokens, STATUS_BAR_WIDTH, display);
  const sep = display.muted(' │ ');
  const ctxSegment =
    display.muted('ctx ') +
    `${formatTokens(usedTokens)}/${formatTokens(maxTokens)} ` +
    bar +
    ` ${ctxPercent}%`;
  const budgetSegment = display.muted('budget ') + `${turn}/${maxTurns}`;
  const stateInfo = formatStatusState(state, args.now);
  const stateSegment = display.paint(stateInfo.text, stateInfo.colour);
  return `${provider}:${model}${sep}${ctxSegment}${sep}${budgetSegment}${sep}${stateSegment}`;
}

export function renderProgressBar(used: number, max: number, width: number): string {
  if (max <= 0) return '[' + '░'.repeat(width) + ']';
  const ratio = Math.max(0, Math.min(1, used / max));
  const filled = Math.round(ratio * width);
  return '[' + '▓'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

interface DefaultPromptOpts {
  commands?:    SlashCommandLite[];
  loadHistory?: () => Promise<string[]>;
}

function createDefaultPromptApi(opts: DefaultPromptOpts = {}): ChatPromptApi {
  // Lazy-load @inquirer/prompts so test harnesses without a TTY don't break.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  // Phase 23.6 — v3 visual style.  Suppress inquirer's default `?` /
  // `✔` glyphs (controlled by theme.prefix) so our brand `▲` prompt
  // shows alone.  We pass per-status entries so the answered echo also
  // stays clean; `loading` is intentionally untouched (spinner state).
  const promptTheme = { prefix: { idle: '', done: '' } };

  // Tier-3.1.1: when `--no-ui` (AIDEN_NO_UI=1) is set, fall back to
  // the legacy inquirer prompt path. Otherwise use the new
  // aidenPrompt component (ghost text + slash dropdown + history nav).
  const useLegacyPrompt = isNoUiMode() || !opts.commands;

  // v4.11 Slice 1 — opt-in frame renderer.
  // When AIDEN_RENDERER=frame is set (or display.renderer === 'frame'
  // in config), readLine routes through the renderer-owned composer
  // (cli/v4/frame). Cursor + cell positioning is owned by Ink; the
  // legacy aidenPrompt path is untouched and stays the default.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const frameMod = require('./frame') as typeof import('./frame');
  const frameModeOn = frameMod.isFrameModeRequested();

  return {
    async readLine(prompt, readOpts) {
      try {
        // v4.9.2 Slice 3 — confirmation prompts (suggestionsDisabled)
        // always route through the legacy inquirer input path. No
        // ghost-text (would autocomplete from outer chat history —
        // wrong context for a y/n question), no slash dropdown
        // (irrelevant for confirmations). Inquirer's plain input is
        // the well-tested baseline for single-shot questions.
        if (readOpts?.suggestionsDisabled || useLegacyPrompt) {
          return (await inq.input({ message: prompt, theme: promptTheme })) ?? '';
        }
        // Fetch history just-in-time so each read sees the latest
        // (the user's previous turn was just appended).
        const history = opts.loadHistory ? await opts.loadHistory() : [];
        // v4.11 Slice 1 — frame-mode branch. Bypasses aidenPrompt
        // entirely; the renderer-owned composer captures input and
        // hands back the string on Enter. History prefetch above is
        // intentionally still done (ghost text / history nav land
        // here in later slices and the legacy fallback wants the
        // same warm-cache shape).
        if (frameModeOn) {
          const value = await frameMod.readLineFramed({ prompt: `${prompt} ` });
          const trimmed = (value ?? '').trim();
          if (trimmed.length > 0) {
            try { await appendHistory(trimmed); } catch { /* best-effort */ }
          }
          return value ?? '';
        }
        const value = await aidenPrompt({
          message:  prompt,
          commands: opts.commands ?? [],
          history,
          theme:    promptTheme as never,
        });
        const trimmed = (value ?? '').trim();
        // Append to disk history. Awaited so the write flushes before
        // the agent loop progresses — `/quit` exits the process and
        // a fire-and-forget write would race the exit. The latency
        // on a single appended line is negligible (~ms).
        if (trimmed.length > 0) {
          try { await appendHistory(trimmed); } catch { /* best-effort */ }
        }
        return value ?? '';
      } catch (err) {
        // Inquirer wraps Ctrl+C as ExitPromptError. Re-throw as plain Error
        // with a recognisable message so the REPL can break the loop.
        const m = (err as Error)?.message ?? '';
        throw new Error(m.includes('force closed') ? 'User force closed' : m);
      }
    },
    async selectSlashCommand(source) {
      // Tier-3.1.1: aidenPrompt handles the slash dropdown inline so
      // this hook is rarely invoked. The legacy path stays available
      // for `--no-ui` callers + any external promptApi shim that
      // doesn't wrap aidenPrompt directly.
      try {
        return (await inq.search({ message: '/', source, theme: promptTheme })) as string;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Phase 16d: render inline confirmation lines for memory mutations the agent
 * actually executed this turn. Gate strictly on `verified=true` (the post-
 * write read flag from MemoryGuard) so we never fabricate confirmations for
 * unverified or errored writes — the same flag HonestyEnforcement uses to
 * catch fake "I remembered X" claims.
 *
 * Exported for tests; called from the chat loop right after `runConversation`
 * returns.
 */
export function renderMemoryConfirmations(
  trace: HonestyTraceEntry[],
  display: { success(text: string): void; warn(text: string): void },
): void {
  for (const entry of trace) {
    if (
      entry.name !== 'memory_add' &&
      entry.name !== 'memory_replace' &&
      entry.name !== 'memory_remove'
    ) {
      continue;
    }
    const file = extractMemoryFile(entry.result);
    const target = file === 'user' ? 'user profile' : 'memory';
    const action =
      entry.name === 'memory_add'
        ? 'Saved to'
        : entry.name === 'memory_replace'
          ? 'Updated'
          : 'Removed from';
    if (entry.error) {
      display.warn(`memory write failed: ${entry.error}`);
      continue;
    }
    if (entry.verified === true) {
      display.success(`${action} ${target}.`);
    } else {
      // Tool ran without throwing but post-write verification didn't confirm.
      // Be honest: tell the user we tried but couldn't confirm, instead of
      // claiming success.
      display.warn(`${action.toLowerCase()} ${target} attempted but not verified.`);
    }
  }
}

/** Pull the `file` field out of a memory tool result, defaulting to 'memory'. */
function extractMemoryFile(result: unknown): 'memory' | 'user' {
  if (
    result &&
    typeof result === 'object' &&
    'file' in (result as Record<string, unknown>) &&
    (result as Record<string, unknown>).file === 'user'
  ) {
    return 'user';
  }
  return 'memory';
}
