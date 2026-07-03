/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * core/v4/aidenAgent.ts
 *
 * The single tool-calling loop. Every chat session in Aiden runs through
 * `AidenAgent.runConversation`. The architecture:
 *
 *   user message → provider → if tool_use:
 *                                dispatch each tool sequentially
 *                                append tool results to history
 *                                provider gets called again with the full
 *                                history including those results
 *                              else: stop, return assistant text
 *
 * The same LLM that requests tools sees the tool outputs in its own
 * context window before writing the final reply — that's the v4 fix for
 * v3's planner/responder split (where the responder hallucinated tool
 * outputs because it never saw them).
 *
 * Around that core loop, the agent integrates a stack of optional layers
 * any of which can be omitted in tests:
 *
 *   - PromptBuilder + PromptCaching + ContextCompressor + AuxiliaryClient
 *   - PlannerGuard (narrow tools), HonestyEnforcement (post-loop scan),
 *     SkillTeacher (propose + create skills)
 *   - SkillEnforcementTracker (skill_view / pre-arm + retry)
 *   - UrlProvenanceTracker (YouTube ledger + retry)
 *   - Empty-response retry (Codex-backend defensive)
 *   - Iteration-budget snippet (warn the model when running out of turns)
 *   - Fallback adapter (single-shot at-most-once)
 *   - Memory dirty-bit (refresh prompt after MEMORY.md/USER.md mutation)
 *
 * Helpers extracted to `core/v4/agent/`: `skillEnforcement.ts`,
 * `urlProvenance.ts`, `intentPreArm.ts`. Those modules predate this rewrite
 * and stay as-is.
 */

import type {
  Message,
  ToolSchema,
  ToolCallRequest,
  ToolCallResult,
  ProviderAdapter,
  ProviderCallOutput,
} from '../../providers/v4/types';
import type {
  PlannerGuard,
  PlannerGuardDecision,
} from '../../moat/plannerGuard';
import type {
  HonestyEnforcement,
  HonestyFinding,
  HonestyTraceEntry,
} from '../../moat/honestyEnforcement';
import type {
  SkillTeacher,
  SkillProposal,
  SkillProposalCallbacks,
} from '../../moat/skillTeacher';
import type { SkillMiner } from './skillMining/skillMiner';
import type { MinedCandidate } from './skillMining/candidateStore';
import type { PromptBuilder, PromptBuilderOptions } from './promptBuilder';
import type { ContextCompressor, CompressionResult } from './contextCompressor';
import type { AuxiliaryClient } from './auxiliaryClient';
import type { PromptCaching } from './promptCaching';
// v4.1.6 spike — Task Completion Engine (TCE) per-turn loop detector
// + recovery controller. Default ON as of v4.2 Phase 6 — set
// AIDEN_TCE=0 to disable. Zero
// behavioral change when unset. See core/v4/turnState.ts.
import { TurnState, type RecoveryDecision } from './turnState';
import {
  decideRecoveryAction,
  resolveRetryPolicyConfig,
  buildRetryAnnotation,
  type RetryAttemptNote,
  type RecoveryActionDecision,
} from './retryPolicy';
// v4.9.4 Slice 1 — tool-call/result protocol invariant + synthetic
// blocked-result helpers used at the surface + abort fill sites.
import {
  assertNoUnansweredToolCalls,
  fillRemainingAsBlocked,
  synthesizeBlockedToolResult,
} from './toolCallInvariant';
import { ModelMetadata } from './modelMetadata';
// v4.2 Phase 1 — per-tool result verifier. Same TCE gate as
// TurnState (default ON, opt-out via AIDEN_TCE=0); classification
// feeds the recovery controller.
import {
  buildDefaultRegistry,
  type VerificationResult,
} from './verifier';
// v4.2 Phase 2 — tool-failure WHY-classifier. Runs after the verifier
// when verification.ok === false. Records-only; Phase 3 will act.
import {
  buildDefaultClassifier,
  type ClassificationResult,
} from './failureClassifier';
// v4.2 Phase 3 — structured RecoveryReport. Built ONLY when the
// recovery controller's surface stage fires (tool_loop); enriches the
// existing surface card with summary + category breakdown + dominant
// guidance. Implicitly gated by TCE being enabled (surface only
// reachable when TurnState is enabled — default ON as of Phase 6).
import {
  buildRecoveryReport,
  enrichCardWithReport,
  extractGoal,
} from './recoveryReport';
// v4.6 Phase 3b — self-improvement loop. Durable cross-session
// failure ledger + recovery report writes. Loaded lazily inside the
// per-call branch so a missing singleton (test agents without a
// daemon DB) never blocks the agent loop.
import { buildFailureSignature } from './selfimprovement/signatureBuilder';
import { getRecoveryStore } from './selfimprovement/recoveryStore';
// v4.2 Phase 4 — checkpoint / restore. Lets the recovery controller
// roll conversation messages + TurnState internals back to before a
// looping tool started failing, so the model retries from a clean
// baseline. Hard-blocked on iterations containing mutating tools
// (never claim to undo executed side effects). All-no-op when
// TCE is opted out via AIDEN_TCE=0 — capture / mark / find /
// restore all short-circuit.
import { buildRollbackMessage } from './checkpoint';
// v4.11 — silently scrub hallucinated `<ui_NAME{...}</ui_NAME>` text
// emitted by weak instruct models. `shouldInjectUiEventsGuidance`
// (promptBuilder) gates the prompt off for known-weak IDs; this is
// the safety net for any model that slips past that gate.
import { stripLeakedUiMarkup, createStreamingUiLeakFilter } from './uiLeakSanitizer';
import type { MemorySnapshot } from './memoryProvider';
import {
  SkillEnforcementTracker,
  extractSkillViewRequiredTools,
  type SkillEnforcementMetrics,
} from './agent/skillEnforcement';
import {
  UrlProvenanceTracker,
  type UrlProvenanceMetrics,
} from './agent/urlProvenance';
import { preArmIntent } from './agent/intentPreArm';

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Run one tool call, return its result. The implementation lives in the
 * tool registry; tests pass mocks. The executor MUST NOT throw for
 * tool-level errors — return a `ToolCallResult` with `error` set instead.
 * The loop catches throws defensively so a buggy executor still keeps
 * the conversation alive.
 */
export type ToolExecutor = (call: ToolCallRequest) => Promise<ToolCallResult>;

/**
 * Phase v4.1.2 alive-core: identity / memory files that can flip the
 * system-prompt cache dirty bit. Replaces the older single-string
 * `'memory' | 'user' | 'both' | null` representation with a `Set` so
 * SOUL.md can join MEMORY.md / USER.md as a turn-time-refreshable file.
 */
export type MemoryFile = 'memory' | 'user' | 'soul';

/**
 * One-shot fallback. Activated at most once per `runConversation` when
 * the primary provider throws. Returning a new adapter swaps it in for
 * the rest of the turn; returning null re-throws.
 */
export interface FallbackStrategy {
  activate(error: Error, attempt: number): Promise<ProviderAdapter | null>;
}

export interface AidenAgentOptions {
  provider:                ProviderAdapter;
  toolExecutor:            ToolExecutor;
  tools:                   ToolSchema[];
  /**
   * v4.9.4 Slice 1 — test seam. Override TurnState construction so
   * regression tests can drive deterministic surface / cooldown /
   * rollback decisions without depending on TurnState's loop-detection
   * thresholds. Undefined in production → real `new TurnState()` is
   * used as before (zero behavioural change).
   */
  turnStateFactory?:       () => TurnState;
  /**
   * v4.5 Phase 7 — explicit per-instance session id. When set, the
   * agent reads it via the existing `this.sessionId` access path
   * (line 751–752) so v4.4 docker session reuse + v4.3 browser
   * observer + v4.2 TurnState all key correctly per session.
   *
   * Daemon-mode turns build this via `buildTriggerSessionId(...)`.
   * REPL turns leave it undefined → the existing 'session' fallback
   * remains the interactive-mode key. Setting it does NOT change
   * REPL behaviour for callers that don't pass it.
   */
  sessionId?:              string;
  /** Hard cap on iterations through the loop. Default 90. */
  maxTurns?:               number;
  /**
   * v4.12 BE.1 — per-session TOKEN cap (money-safety). When set, the loop
   * refuses to make a provider call that would push cumulative session tokens
   * past the cap (enforced BEFORE the call at the callProvider boundary), keeps
   * a summary reserve so the graceful finalization fits within budget, and
   * returns a partial + resume-handoff. Unset (undefined) = no cap = today's
   * behaviour, byte-identical.
   */
  sessionTokenCap?:        number;
  fallback?:               FallbackStrategy;
  /**
   * Phase v4.1.2-slice3 telemetry. Optional aggregator the caller
   * (aidenCLI) constructs and passes to subsystem trackers. Aiden
   * exposes the registry as a public field so `aiden doctor` can
   * fetch the snapshot via the same agent handle other diagnostic
   * paths use. Subsystems work fine if the registry is undefined.
   */
  subsystemHealthRegistry?: import('./subsystemHealth').SubsystemHealthRegistry;
  /**
   * Phase v4.1.2-slice4 telemetry. Optional read handle to the in-
   * process skill-outcome tracker. The caller (aidenCLI) composes
   * the tracker's `onTool` into the agent's `onToolCall` callback so
   * attribution happens automatically; this field is only the doctor-
   * facing READ surface. Undefined when the caller didn't wire a
   * tracker (standalone doctor invocation has no live state).
   */
  skillOutcomeTracker?:     import('./skillOutcomeTracker').SkillOutcomeTracker;
  /** Observability — fired before and after each tool call. */
  onToolCall?: (
    call:    ToolCallRequest,
    phase:   'before' | 'after',
    result?: ToolCallResult,
  ) => void;
  /**
   * Fires once at caution and once at warning. `kind` distinguishes the
   * iteration budget (turn/maxTurns) from the v4.12 BE.1 token budget
   * (usedTokens/capTokens). `kind` defaults to 'iterations' for back-compat.
   */
  onBudgetWarning?: (
    level:   'caution' | 'warning',
    current: number,
    max:     number,
    kind?:   'iterations' | 'tokens',
  ) => void;
  // ── Moat ─────────────────────────────────────────────────────────────
  plannerGuard?:           PlannerGuard;
  onPlannerGuardDecision?: (decision: PlannerGuardDecision) => void;
  honestyEnforcement?:     HonestyEnforcement;
  skillTeacher?:           SkillTeacher;
  skillTeacherCallbacks?:  SkillProposalCallbacks;
  /**
   * Phase v4.1-skill-mining — post-turn observer that stages a
   * candidate skill into `<aidenHome>/skills/learned/.candidates.json`
   * on a successful complex turn. Optional; when absent the loop
   * runs unchanged. Caller MUST gate on !isMcpServeMode().
   */
  skillMiner?:             SkillMiner;
  /** Notified when skillMiner queues a candidate (chatSession renders the post-turn cue). */
  onSkillCandidate?:       (candidate: MinedCandidate) => void;
  /** Resolves the verified flag from a tool result, used by Honesty. */
  resolveVerifiedFlag?:    (result: ToolCallResult) => boolean | undefined;
  /** Resolves a tool name to its toolset, used by SkillTeacher. */
  resolveToolset?:         (toolName: string) => string | undefined;
  /**
   * v4.2 Phase 4 — resolves a tool name to its `mutates` flag, used
   * by the checkpoint/restore subsystem to decide whether an
   * iteration is rollback-safe. The CLI wires this via the same
   * ToolRegistry reference as `resolveToolset`. Returns undefined
   * for unknown tools — the agent treats undefined as "potentially
   * mutating" only in the sense that it doesn't FLAG the checkpoint
   * (so unknown tools remain rollback-eligible). Plugin authors
   * should ensure their tools declare `mutates` honestly.
   */
  resolveMutates?:         (toolName: string) => boolean | undefined;
  /**
   * v4.8.0 — resolves a tool name to its `uiOnly` flag. When the
   * dispatch loop sees `true`, it skips execute / observability hooks /
   * iteration accounting and fires `onUiEvent` on the caller instead.
   * Undefined means "treat as a normal executable tool" (default).
   */
  resolveUiOnly?:          (toolName: string) => boolean | undefined;
  // ── Context layers ───────────────────────────────────────────────────
  promptBuilder?:          PromptBuilder;
  promptBuilderOptions?:   PromptBuilderOptions;
  contextCompressor?:      ContextCompressor;
  auxiliaryClient?:        AuxiliaryClient;
  promptCaching?:          PromptCaching;
  providerId?:             string;
  modelId?:                string;
  /** Append "you have N turns remaining" to the last tool result when
   *  remaining ≤ 30%. Default true. */
  iterationBudgetInjection?: boolean;
  onCompression?:          (event: CompressionResult) => void;
  /** Returns a fresh memory snapshot when the dirty bit triggers a refresh. */
  refreshMemorySnapshot?:  () => Promise<MemorySnapshot>;
  /** Diagnostic hook for the display layer when the prompt gets rebuilt. */
  onMemoryRefresh?:        (files: ReadonlyArray<MemoryFile>) => void;
  /**
   * v4.1.5 Issue K — pre-event for the memory-refresh phase. Fires BEFORE
   * `refreshMemorySnapshot()` reads the dirty files, so the display
   * layer can paint a `refreshing memory` verb on the activity
   * indicator during the I/O wait. `onMemoryRefresh` (existing) fires
   * AFTER the read; this fires BEFORE. Pairs as start/end.
   */
  onMemoryRefreshStart?:   () => void;
  /**
   * v4.1.5 Issue K — fires after the per-turn system prompt has been
   * assembled (`ensureSystemPrompt()` completes). Carries cardinality
   * metadata the display layer can surface in a status row or use
   * verbatim as an activity verb context (e.g. "preparing prompt:
   * 42 tools, 74 skills, 12 memory facts").
   */
  onPromptBuilt?:          (info: {
    tools:        number;
    skills:       number;
    memoryFacts:  number;
  }) => void;
  /**
   * v4.1.5 Issue K — fires just before the streaming HTTP request to
   * the provider opens. The display layer transitions the activity
   * indicator from local-prep verbs ("preparing prompt", "selecting
   * tools") to a network verb ("calling provider"); the long wait
   * for TTFT (time to first token, often 5–20s on large models) is
   * the gap the rest of Issue K's wave bar covers.
   */
  onProviderRequestStart?: (providerId: string) => void;
  /** Stage-0 intent pre-arm: look up a skill's `required_tools`. */
  lookupSkillRequiredTools?: (skillName: string) => Promise<string[] | null>;
}

export interface AidenAgentResult {
  finalContent:        string;
  messages:            Message[];
  turnCount:           number;
  toolCallCount:       number;
  fallbackActivated:   boolean;
  finishReason:        'stop' | 'budget_exhausted' | 'error' | 'tool_loop' | 'interrupted';
  totalUsage:          { inputTokens: number; outputTokens: number };
  toolCallTrace:       HonestyTraceEntry[];
  honestyFindings?:    HonestyFinding[];
  skillCreated?:       string;
  /**
   * v4.1.6 Polish 2 — when SkillTeacher's `observeTurn` returns a
   * non-null proposal AND its tier requires user confirmation,
   * the proposal is returned here instead of being handled inline
   * during `runConversation`. Inline handling caused the inquirer
   * modal ("Save this as a reusable skill?") to fire BEFORE the
   * user saw the agent's reply on screen — visually it looked like
   * a mid-turn interruption. chatSession now renders the reply
   * first, then awaits the prompt + creation via
   * `callbacks.handleSkillProposal` post-render.
   *
   * Undefined when:
   *   - SkillTeacher is `tier: 'off'` (no proposal generated)
   *   - SkillTeacher is `tier: 'tier_4_auto'` (handled inline, no prompt needed)
   *   - observeTurn returned null (heuristics didn't fire)
   *   - the SkillTeacher block itself threw (silently swallowed by the
   *     existing try/catch so the turn doesn't break over a teacher fault)
   */
  skillProposal?:      SkillProposal;
  compressionEvents:   number;
  auxiliaryUsage:      Record<string, { inputTokens: number; outputTokens: number; calls: number }>;
  skillEnforcement:    { recovered: number; failed: number; armed: number; preArmed: number };
  urlProvenance:       { recovered: number; failed: number; blocked: number };
  emptyResponse:       { detected: number; retried: number; recovered: number };
  /**
   * v4.1.6 spike (TCE): populated when `finishReason === 'tool_loop'`.
   * Carries the structured-failure payload the chat layer renders as
   * a capability-card-style surface. Undefined on all other terminal
   * paths.
   */
  toolLoopCard?: {
    title:          string;
    canStill:       string[];
    cannotReliably: string[];
    fix:            string;
  };
  /**
   * v4.12 BE.1 — populated when `finishReason === 'budget_exhausted'` due to the
   * TOKEN cap (not the iteration cap). Lossy-but-recoverable money-safety
   * handoff: what got done, what remains, and how to resume.
   */
  resumeHandoff?: {
    partial_work: string;
    next_steps:   string;
    resume:       string;
  };
}

export interface RunConversationOptions {
  stream?:           boolean;
  /**
   * v4.12 BE.1 — tokens already spent in THIS session before this run (from
   * sessionStore totals). The per-session token cap enforces on
   * `sessionTokensSoFar + this-run usage`. Default 0 → cap is per-run.
   */
  sessionTokensSoFar?: number;
  onDelta?:          (text: string) => void;
  onFirstDelta?:     () => void;
  onToolCallStart?:  (call: ToolCallRequest) => void;
  /**
   * v4.1.4 Part 1.6 — incremental output-token progress callback.
   * Fires whenever the streaming adapter emits a `progress` event
   * (Anthropic running counter; other adapters opt-in over time).
   * Use this to drive a per-turn token progress bar. Bar stays
   * hidden when the adapter never emits — honest degradation.
   */
  onProgress?:       (outputTokens: number, maxTokens?: number) => void;
  /**
   * v4.6 prep — cooperative-cancellation primitive. When provided,
   * the loop checks `signal.aborted` between iterations and before
   * each tool dispatch, and forwards it to the provider HTTP layer
   * so in-flight fetches are cancelled. Omit for "no abort possible"
   * (today's behaviour, preserved for all existing callers).
   *
   * On abort, the turn yields with `finishReason: 'interrupted'`
   * and `finalContent: ''` (delta-accumulation on abort is deferred
   * to a future phase — see docs/v4.6/phase-1-design.md §11.0).
   */
  signal?:           AbortSignal;
  /**
   * v4.8.0 — fired when the dispatch loop encounters a `uiOnly` tool
   * call. Carries the tool name and the raw model-provided arguments;
   * the caller (display layer) interprets them as a render signal
   * (e.g. `ui_task_update`, `ui_toast`). Never fires for executable
   * tools. Synchronous, best-effort — handler exceptions are swallowed
   * by the dispatch branch so a bad listener cannot break the turn.
   */
  onUiEvent?:        (name: string, args: Record<string, unknown>) => void;
  /**
   * v4.12.1 Pillar 4 Slice 2b — mid-turn STEER pull. Called by the loop at the
   * safe boundary (end of the loop body, after the tool batch, before the next
   * provider call — history is balanced there). Returns a user nudge to inject
   * as tool-stream CONTEXT for the next iteration, or null. The loop never owns
   * the buffer (mirrors `signal`/`onUiEvent`); chatSession's controller does,
   * and clears it on interrupt. Injected as context, NEVER as an out-of-order
   * `role:'user'` message.
   */
  drainSteer?:       () => string | null;
  /**
   * v4.11 Slice 4 — optional per-turn `TurnRuntimeContext`. When
   * provided, the loop exposes it via `agent.getCurrentTurnContext()`
   * so the spawn / fanout tool facades can route through the
   * `SubagentCoordinator` (with the parent's signal + cost
   * accumulator + trace emitter wired in). Cleared in the loop's
   * finally before return so a stray between-turn tool dispatch
   * sees `undefined`. Daemon agents + unit tests omit this; the
   * legacy `parentAgent.getCurrentSignal()` path stays as the
   * back-compat surface for callers that don't speak the new
   * context shape yet.
   */
  turnContext?:      import('./turnRuntimeContext').TurnRuntimeContext;
}

interface EmptyResponseMetrics {
  detected:   number;
  retried:    number;
  recovered:  number;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS    = 90;
const CAUTION_FRACTION     = 0.7;
const WARNING_FRACTION     = 0.9;
// v4.12 BE.1 — token-budget tuning.
const TOKEN_CAUTION_FRACTION = 0.8;   // warn at 80% of the token cap
const TOKEN_WARNING_FRACTION = 0.9;   // warn at 90%
const SUMMARY_RESERVE_FRACTION = 0.05; // hold back ≥5% of the cap for the toolless summary
const MIN_SUMMARY_RESERVE = 2_000;     // …but at least this many tokens
const SUMMARY_OUTPUT_ALLOWANCE = 1_000; // assumed output size of the toolless summary
const BUDGET_INJECT_FRAC   = 0.3;
const EMPTY_RETRY_CAP      = 1;
const EMPTY_RETRY_NOTE =
  '[System note: your previous turn returned empty content with no tool calls. ' +
  'Either call a tool or write a real reply — silent turns are not acceptable.]';

// ── Class ────────────────────────────────────────────────────────────────

export class AidenAgent {
  private provider: ProviderAdapter;

  private readonly toolExecutor:                ToolExecutor;
  private readonly tools:                       ToolSchema[];
  // v4.9.4 Slice 1 — TurnState test seam (undefined in production).
  private readonly turnStateFactory?:           () => TurnState;
  private readonly maxTurns:                    number;
  private readonly sessionTokenCap?:            number;
  // v4.12 BE.1 — stateless token estimator for the budget check (getLimits +
  // estimateMessageTokens/estimateToolTokens). No per-model state carried.
  private readonly modelMetadata = new ModelMetadata();
  private readonly fallback?:                   FallbackStrategy;
  private readonly onToolCall?:                 AidenAgentOptions['onToolCall'];
  private readonly onBudgetWarning?:            AidenAgentOptions['onBudgetWarning'];
  private readonly plannerGuard?:               PlannerGuard;
  private readonly onPlannerGuardDecision?:     AidenAgentOptions['onPlannerGuardDecision'];
  private readonly honestyEnforcement?:         HonestyEnforcement;
  private readonly skillTeacher?:               SkillTeacher;
  private readonly skillTeacherCallbacks?:      SkillProposalCallbacks;
  private readonly skillMiner?:                 SkillMiner;
  private readonly onSkillCandidate?:           AidenAgentOptions['onSkillCandidate'];
  private skillMinerTurnIdx                  =  0;
  private readonly resolveVerifiedFlag?:        AidenAgentOptions['resolveVerifiedFlag'];
  private readonly resolveToolset?:             AidenAgentOptions['resolveToolset'];
  private readonly resolveMutates?:             AidenAgentOptions['resolveMutates'];
  private readonly resolveUiOnly?:              AidenAgentOptions['resolveUiOnly'];
  private readonly promptBuilder?:              PromptBuilder;
  private          promptBuilderOptions?:       PromptBuilderOptions;
  private readonly contextCompressor?:          ContextCompressor;
  private readonly auxiliaryClient?:            AuxiliaryClient;
  private readonly promptCaching?:              PromptCaching;
  private readonly providerId:                  string;
  private readonly modelId:                     string;
  private readonly iterationBudgetInjection:    boolean;
  private readonly onCompression?:              AidenAgentOptions['onCompression'];
  private readonly refreshMemorySnapshot?:      AidenAgentOptions['refreshMemorySnapshot'];
  private readonly onMemoryRefresh?:            AidenAgentOptions['onMemoryRefresh'];
  // v4.1.5 Issue K — pre/post lifecycle hooks for activity-indicator
  // verb mutation during the pre-first-token gap.
  private readonly onMemoryRefreshStart?:       AidenAgentOptions['onMemoryRefreshStart'];
  private readonly onPromptBuilt?:              AidenAgentOptions['onPromptBuilt'];
  private readonly onProviderRequestStart?:     AidenAgentOptions['onProviderRequestStart'];
  private readonly lookupSkillRequiredTools?:   AidenAgentOptions['lookupSkillRequiredTools'];

  // ── Cross-call state ─────────────────────────────────────────────────
  /**
   * v4.6 Phase 1 — current per-turn AbortSignal, exposed to tools that need
   * to construct child signal chains (specifically `spawn_sub_agent`). Set
   * at the top of `runTurnLoop` from `runOptions.signal`, cleared before
   * the loop returns. Read via `getCurrentSignal()`. Per-agent-instance —
   * not shared across agents; a child agent has its own `_currentSignal`.
   */
  private _currentSignal: AbortSignal | undefined = undefined;
  /**
   * v4.11 Slice 4 — current per-turn `TurnRuntimeContext`. Same Flag 1
   * pattern as `_currentSignal`: set at the top of `runTurnLoop` from
   * `runOptions.turnContext`, cleared before the loop returns. Tools
   * read via `getCurrentTurnContext()` to access the parent's
   * costAccumulator, traceEmitter, and SubagentCoordinator-bound
   * signal. Undefined when the caller didn't construct a context
   * (back-compat for daemon agents + unit tests).
   */
  private _currentTurnContext: import('./turnRuntimeContext').TurnRuntimeContext | undefined = undefined;
  /** Cached system prompt — invalidated by setPersonalityOverlay/markMemoryDirty/explicit. */
  private cachedSystemPrompt:  string | null = null;
  private compressionEvents:    number        = 0;
  // Phase v4.1.2: tracks which identity / memory files need a system-
  // prompt rebuild on the next turn. Empty set = clean. Plain Set keeps
  // the membership-test path O(1) and avoids the combinatorial union
  // type the previous representation grew when SOUL.md joined the list.
  private memoryDirty:          Set<MemoryFile> = new Set();

  /**
   * Phase v4.1.2-slice3: public field so `aiden doctor` can read
   * subsystem-health snapshots via the live agent handle. Undefined
   * when the caller didn't wire a registry (subsystems then operate
   * without telemetry — back-compat).
   */
  public readonly subsystemHealthRegistry?: import('./subsystemHealth').SubsystemHealthRegistry;
  /**
   * Phase v4.1.2-slice4: optional read handle to the in-process
   * skill-outcome tracker. Doctor reads its snapshot() for the
   * "Skill outcomes" section. Composed into onToolCall by the caller
   * so attribution happens automatically.
   */
  public readonly skillOutcomeTracker?: import('./skillOutcomeTracker').SkillOutcomeTracker;

  /** Process-scoped tracker metrics for `/doctor`. */
  private readonly skillEnforcementMetrics: SkillEnforcementMetrics = {
    recovered: 0, failed: 0, armed: 0, preArmed: 0,
  };
  private readonly urlProvenanceMetrics: UrlProvenanceMetrics = {
    recovered: 0, failed: 0, blocked: 0,
  };
  private readonly emptyResponseMetrics: EmptyResponseMetrics = {
    detected: 0, retried: 0, recovered: 0,
  };

  constructor(opts: AidenAgentOptions) {
    this.provider                 = opts.provider;
    this.toolExecutor             = opts.toolExecutor;
    this.tools                    = opts.tools;
    this.turnStateFactory         = opts.turnStateFactory;
    this.maxTurns                 = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.sessionTokenCap          = opts.sessionTokenCap;
    this.fallback                 = opts.fallback;
    this.onToolCall               = opts.onToolCall;
    this.onBudgetWarning          = opts.onBudgetWarning;
    this.plannerGuard             = opts.plannerGuard;
    this.onPlannerGuardDecision   = opts.onPlannerGuardDecision;
    this.honestyEnforcement       = opts.honestyEnforcement;
    this.skillTeacher             = opts.skillTeacher;
    this.skillTeacherCallbacks    = opts.skillTeacherCallbacks;
    this.skillMiner               = opts.skillMiner;
    this.onSkillCandidate         = opts.onSkillCandidate;
    this.resolveVerifiedFlag      = opts.resolveVerifiedFlag;
    this.resolveToolset           = opts.resolveToolset;
    this.resolveMutates           = opts.resolveMutates;
    this.resolveUiOnly            = opts.resolveUiOnly;
    this.promptBuilder            = opts.promptBuilder;
    this.promptBuilderOptions     = opts.promptBuilderOptions;
    this.contextCompressor        = opts.contextCompressor;
    this.auxiliaryClient          = opts.auxiliaryClient;
    this.promptCaching            = opts.promptCaching;
    this.providerId               = opts.providerId ?? '';
    this.modelId                  = opts.modelId    ?? '';
    this.iterationBudgetInjection = opts.iterationBudgetInjection !== false;
    this.onCompression            = opts.onCompression;
    this.refreshMemorySnapshot    = opts.refreshMemorySnapshot;
    this.onMemoryRefresh          = opts.onMemoryRefresh;
    // v4.1.5 Issue K — phase hooks (all optional, fire defensively).
    this.onMemoryRefreshStart     = opts.onMemoryRefreshStart;
    this.onPromptBuilt            = opts.onPromptBuilt;
    this.onProviderRequestStart   = opts.onProviderRequestStart;
    this.lookupSkillRequiredTools = opts.lookupSkillRequiredTools;
    // v4.5 Phase 7 — explicit sessionId. Existing access path
    // `(this as { sessionId?: string }).sessionId` at line 751–752
    // already reads from `this.sessionId`; setting it here keys
    // docker / browser / TurnState per session for daemon-mode
    // turns. Interactive REPL callers don't pass this and continue
    // hitting the 'session' fallback.
    if (typeof opts.sessionId === 'string' && opts.sessionId.length > 0) {
      (this as { sessionId?: string }).sessionId = opts.sessionId;
    }
    // Phase v4.1.2-slice3: optional health registry (constructor-
    // injected per the slice3 decision tree — no singleton). When
    // wired, the caller already plumbed trackers into each subsystem
    // via their own constructors; we just hold the read handle.
    (this as { subsystemHealthRegistry?: import('./subsystemHealth').SubsystemHealthRegistry })
      .subsystemHealthRegistry = opts.subsystemHealthRegistry;
    // Phase v4.1.2-slice4: same pattern for the outcome tracker. The
    // caller composes the tracker into `onToolCall`; we just keep a
    // read handle for doctor.
    (this as { skillOutcomeTracker?: import('./skillOutcomeTracker').SkillOutcomeTracker })
      .skillOutcomeTracker = opts.skillOutcomeTracker;
  }

  // ── Public method surface ────────────────────────────────────────────

  setProvider(adapter: ProviderAdapter): void {
    this.provider = adapter;
  }

  /** Drop the cached system prompt so the next runConversation rebuilds it. */
  invalidateSystemPromptCache(): void {
    this.cachedSystemPrompt = null;
  }

  /**
   * Replace the personality overlay slot. Returns `true` when the value
   * actually changed (and the cache was invalidated), `false` otherwise.
   */
  setPersonalityOverlay(overlay: string | undefined): boolean {
    const current = this.promptBuilderOptions?.personalityOverlay;
    if (current === overlay) return false;
    this.promptBuilderOptions = {
      ...(this.promptBuilderOptions ?? ({} as PromptBuilderOptions)),
      personalityOverlay: overlay,
    };
    this.cachedSystemPrompt = null;
    return true;
  }

  /**
   * Phase v4.1.2-bug2: replace the active provider/model fed into the
   * `## Runtime` slot of the system prompt. Mirrors
   * `setPersonalityOverlay` shape — mutate the cached PromptBuilder
   * options + null the system-prompt cache so the next runConversation
   * rebuilds with fresh values. Returns `true` when at least one of
   * `providerId`/`modelId` actually changed; `false` is a no-op
   * (caller may skip downstream signalling).
   *
   * This is NOT a dirty-bit invalidation — provider/model are
   * in-memory field updates, not disk-backed reloads. The existing
   * MemoryFile dirty-bit (`memory|user|soul`) governs file reload
   * semantics and is intentionally not extended here.
   *
   * Called by chatSession.setProvider() after the adapter swap so the
   * prompt's self-description stays in lockstep with the routed
   * provider. Without this, `/model groq → chatgpt-plus` swaps the
   * adapter (real requests route correctly) but the prompt keeps
   * claiming "Provider: groq" for the rest of the session.
   */
  setActiveModel(providerId: string, modelId: string): boolean {
    const cur = this.promptBuilderOptions;
    if (cur?.providerId === providerId && cur?.modelId === modelId) return false;
    this.promptBuilderOptions = {
      ...(cur ?? ({} as PromptBuilderOptions)),
      providerId,
      modelId,
    };
    this.cachedSystemPrompt = null;
    return true;
  }

  /**
   * Build (or return the cached) system prompt without driving the
   * provider. Powers the `/debug-prompt` command. Returns `null` when no
   * `PromptBuilder` is wired.
   */
  async getSystemPromptForDebug(): Promise<string | null> {
    if (!this.promptBuilder || !this.promptBuilderOptions) return null;
    if (this.cachedSystemPrompt !== null) return this.cachedSystemPrompt;
    this.cachedSystemPrompt = await this.promptBuilder.build(this.promptBuilderOptions);
    return this.cachedSystemPrompt;
  }

  /**
   * Mark MEMORY.md / USER.md / SOUL.md as dirty. The next
   * `runConversation` will rebuild the prompt, fire `onMemoryRefresh`,
   * and clear the dirty set.
   *
   *   - 'memory' / 'user' refresh through `refreshMemorySnapshot` (the
   *     in-memory MEMORY.md / USER.md blobs need a re-read). No-op when
   *     no refresh callback is wired (frozen-snapshot semantics).
   *   - 'soul' just invalidates the prompt cache; SOUL.md is re-read
   *     from disk by `PromptBuilder.build()` on the next rebuild. No
   *     snapshot callback required, so this kind always takes effect.
   */
  markMemoryDirty(file: MemoryFile): void {
    if ((file === 'memory' || file === 'user') && !this.refreshMemorySnapshot) {
      return;
    }
    this.memoryDirty.add(file);
  }

  /**
   * Returns the set of dirty files as a stable-sorted readonly array.
   * Empty array = clean. (Phase v4.1.2: replaces the older
   * `'memory' | 'user' | 'both' | null` return type now that SOUL.md
   * joins the rotation — a Set scales without union-type explosion.)
   */
  getMemoryDirtyState(): ReadonlyArray<MemoryFile> {
    return [...this.memoryDirty].sort();
  }

  /** /doctor accessor for cumulative skill-enforcement counters. */
  getSkillEnforcementMetrics(): SkillEnforcementMetrics {
    return { ...this.skillEnforcementMetrics };
  }

  /** /doctor accessor for cumulative URL-provenance counters. */
  getUrlProvenanceMetrics(): UrlProvenanceMetrics {
    return { ...this.urlProvenanceMetrics };
  }

  /** /doctor accessor for cumulative empty-response counters. */
  getEmptyResponseMetrics(): EmptyResponseMetrics {
    return { ...this.emptyResponseMetrics };
  }

  /**
   * v4.6 Phase 1 — return the AbortSignal currently associated with this
   * agent's active `runTurnLoop`, or `undefined` if the agent is between
   * turns. Used by the `spawn_sub_agent` tool to construct a child signal
   * chain that cascades parent aborts to the child (Flag 1 pattern: tool
   * captures the parent agent reference at construction time and reads
   * the current signal from the instance at dispatch time).
   */
  getCurrentSignal(): AbortSignal | undefined {
    return this._currentSignal;
  }

  /**
   * v4.11 Slice 4 — return the live TurnRuntimeContext for the active
   * turn (or `undefined` if the agent is between turns / the caller
   * didn't pass one). Used by the spawn / fanout tool facades to
   * route through the SubagentCoordinator with the parent's signal,
   * costAccumulator, and traceEmitter wired in.
   */
  getCurrentTurnContext(): import('./turnRuntimeContext').TurnRuntimeContext | undefined {
    return this._currentTurnContext;
  }

  // ── Main entry: runConversation ──────────────────────────────────────

  async runConversation(
    history: Message[],
    options: RunConversationOptions = {},
  ): Promise<AidenAgentResult> {
    // 1. Refresh memory snapshot if the dirty bit was set since last turn.
    await this.refreshSystemPromptIfDirty();

    // 2. Build / reuse the cached system prompt.
    const systemPrompt = await this.ensureSystemPrompt();

    // 3. Reset PlannerGuard active toolsets per-conversation, then narrow.
    if (this.plannerGuard) {
      this.plannerGuard.resetActivation();
    }
    const lastUserContent = lastUserMessageContent(history);
    const narrowedTools   = await this.narrowTools(lastUserContent, history);

    // 4. Build per-call trackers, then Stage-0 intent pre-arm.
    //    The tracker's preArm() bumps `preArmed` itself; the loop just
    //    plumbs the SkillLoader-resolved required-tools list into it.
    const trackers = this.makeTrackers();
    if (lastUserContent && this.lookupSkillRequiredTools) {
      const decision = preArmIntent(lastUserContent);
      if (decision) {
        const required = await this.lookupSkillRequiredTools(decision.skill);
        if (required && required.length > 0) {
          trackers.skill.preArm(decision.skill, required);
        }
      }
    }

    // 5. Compose initial conversation, prepending the system prompt.
    let messages: Message[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...history]
      : [...history];

    // 6. Apply prompt-caching markers (helper no-ops for non-Anthropic).
    if (this.promptCaching) {
      messages = this.promptCaching.applyMarkers(messages, this.providerId);
    }

    // 7. Compression pass — call .compress() which itself short-circuits
    //    when below threshold (returns refused:true, original messages).
    //
    // v4.11 preflight retrofit:
    //   - Pass `narrowedTools` so the threshold check includes tool-schema
    //     tokens (principle #2 from preflight audit). The 68-tool catalog ~6-13K tokens was
    //     previously invisible to the trigger.
    //   - Fire `onCompression` on EVERY outcome (success, refused, error)
    //     so the chatSession callback can surface a dim status line.
    //     Pre-v4.11 the callback only fired on success and the error/
    //     refused paths silently shipped a stale-but-full context
    //     (principle #12 visible-abort from preflight audit).
    //   - The OUTER try/catch catches genuinely-thrown exceptions
    //     (network reset mid-summary, etc.); it now synthesises an
    //     error envelope + fires the callback so the user sees the
    //     abort rather than wondering why nothing happened.
    if (this.contextCompressor) {
      try {
        const result = await this.contextCompressor.compress(
          messages,
          this.providerId,
          this.modelId,
          narrowedTools,
        );
        if (!result.refused && !result.error) {
          messages = result.compressedMessages;
          this.compressionEvents += 1;
        }
        // Always surface to the callback — success, refused, AND error.
        // Pre-v4.11 fired only on success; the refused/error paths
        // dropped on the floor. chatSession's callbacks.ts:onCompression
        // already differentiates the three outcomes.
        this.onCompression?.(result);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.onCompression?.({
          compressedMessages:    messages,
          removedMessageCount:   0,
          summaryTokens:         0,
          preservedRecentCount:  messages.length,
          error:                 true,
          refused:               true,
          errorMessage:          `Compression threw: ${errorMessage}`,
          invariantViolation:    'auxiliary_threw',
        });
      }
    }

    // 8. Run the tool-calling loop.
    const loopResult = await this.runTurnLoop(
      messages,
      narrowedTools,
      trackers,
      options,
    );

    // 9. Honesty post-loop scan (only if loop ended with a normal stop).
    //
    // v4.7.0 Phase 2.3 — the verifier now records deterministic
    // outcome events from `toolCallTrace` (not regex over the
    // assistant's text). When `findings.length > 0` AND mode is
    // `enforce`, it returns an append-only `footer` we concatenate
    // to `finalContent`. The model's text is NEVER rewritten —
    // that was the v4.6.x failure mode this verifier replaces.
    let honestyFindings: HonestyFinding[] | undefined;
    let finalContent = loopResult.finalContent;
    if (this.honestyEnforcement && loopResult.finishReason === 'stop') {
      try {
        const scan = await this.honestyEnforcement.check(
          finalContent,
          loopResult.messages,
          loopResult.toolCallTrace,
          loopResult.uiClaims,
        );
        honestyFindings = scan.findings;
        if (scan.footer) {
          finalContent = `${finalContent}\n\n${scan.footer}`;
        }
      } catch {
        /* honesty failures must not break the turn */
      }
    }

    // 10. SkillTeacher post-loop observation + proposal.
    //
    // v4.1.6 Polish 2 — `handleProposal` previously ran INLINE here,
    // awaiting `callbacks.promptUser` (an inquirer modal) before
    // `runConversation` returned. That made the modal fire BEFORE
    // chatSession rendered the agent's reply on screen, so users
    // saw "Save this as a reusable skill?" pop up mid-turn — feels
    // like an interruption.
    //
    // New flow: agent ONLY observes here. When a proposal needs user
    // confirmation (tier_3_propose with a promptUser callback), the
    // proposal is surfaced in `AidenAgentResult.skillProposal` and
    // chatSession handles the prompt + create dance AFTER rendering
    // the reply. Tier_4_auto still runs inline (no prompt needed).
    let skillCreated:  string | undefined;
    let skillProposal: SkillProposal | undefined;
    if (this.skillTeacher) {
      try {
        const traceForTeacher = loopResult.toolCallTrace.map((entry, i) => ({
          name:    entry.name,
          args:    loopResult.fullTrace[i]?.args ?? {},
          result:  entry.result,
          error:   entry.error,
          toolset: this.resolveToolset?.(entry.name),
        }));
        const proposal = await this.skillTeacher.observeTurn(
          history,
          traceForTeacher,
          loopResult.finishReason !== 'stop',
        );
        if (proposal) {
          // Defer to chatSession only when there's a prompt callback
          // wired (tier_3_propose path). Otherwise run inline to
          // preserve tier_4_auto and tier_off behaviour.
          const hasPromptCallback =
            typeof this.skillTeacherCallbacks?.promptUser === 'function';
          if (hasPromptCallback) {
            // Surface the proposal back to chatSession; do NOT call
            // handleProposal here.
            skillProposal = proposal;
          } else {
            const result = await this.skillTeacher.handleProposal(
              proposal,
              this.skillTeacherCallbacks,
            );
            if (result.created && result.skillName) {
              skillCreated = result.skillName;
            }
          }
        }
      } catch {
        /* SkillTeacher failures must not break the turn */
      }
    }

    // 11. SkillMiner post-loop observation. Stages a candidate into
    //     `<aidenHome>/skills/learned/.candidates.json` for user
    //     review via `/skills review`. Complementary to SkillTeacher
    //     above (inline propose-and-write); the miner's queue is the
    //     deferred, audit-first path.
    if (this.skillMiner) {
      try {
        const turnIdx = this.skillMinerTurnIdx;
        this.skillMinerTurnIdx += 1;
        const traceForMiner = loopResult.toolCallTrace.map((entry, i) => ({
          name:    entry.name,
          args:    loopResult.fullTrace[i]?.args ?? {},
          result:  entry.result,
          error:   entry.error,
          toolset: this.resolveToolset?.(entry.name),
        }));
        const sessionId =
          (this as { sessionId?: string }).sessionId ?? 'session';
        const outcome = await this.skillMiner.observeTurn({
          trace:         traceForMiner,
          sessionId,
          sourceTurnIdx: turnIdx,
          finishReason:  loopResult.finishReason,
          history,
        });
        if (outcome.status === 'queued' && outcome.candidate && this.onSkillCandidate) {
          this.onSkillCandidate(outcome.candidate);
        }
      } catch {
        /* SkillMiner failures must not break the turn */
      }
    }

    return {
      finalContent,
      messages:           loopResult.messages,
      turnCount:          loopResult.turnCount,
      toolCallCount:      loopResult.toolCallCount,
      fallbackActivated:  loopResult.fallbackActivated,
      finishReason:       loopResult.finishReason,
      totalUsage:         loopResult.totalUsage,
      toolCallTrace:      loopResult.toolCallTrace,
      honestyFindings,
      skillCreated,
      // v4.1.6 Polish 2 — deferred to chatSession's post-render
      // handler when the SkillTeacher proposal needs user
      // confirmation. Undefined when no proposal, when tier auto-
      // handled inline, or when the teacher's observation faulted.
      skillProposal,
      compressionEvents:  this.compressionEvents,
      auxiliaryUsage:     this.auxiliaryClient?.getUsage() ?? {},
      skillEnforcement:   { ...this.skillEnforcementMetrics },
      urlProvenance:      { ...this.urlProvenanceMetrics },
      emptyResponse:      { ...this.emptyResponseMetrics },
      // v4.1.6 spike (TCE) — surfaced when TurnState hit the surface
      // threshold mid-turn. chatSession reads this to render the
      // structured-failure card; undefined on all other finishReasons.
      toolLoopCard:       loopResult.toolLoopCard,
      resumeHandoff:      loopResult.resumeHandoff,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async refreshSystemPromptIfDirty(): Promise<void> {
    if (this.memoryDirty.size === 0) return;
    if (!this.promptBuilder || !this.promptBuilderOptions) {
      this.memoryDirty.clear();
      return;
    }
    const dirtyFiles: ReadonlyArray<MemoryFile> = [...this.memoryDirty].sort();
    // 'soul' is satisfied by a cache invalidation alone — SOUL.md is
    // re-read by PromptBuilder.build() on the next rebuild. 'memory'
    // / 'user' need a snapshot refresh first.
    const needsSnapshot =
      this.memoryDirty.has('memory') || this.memoryDirty.has('user');
    if (needsSnapshot && this.refreshMemorySnapshot) {
      // v4.1.5 Issue K — fire BEFORE the file I/O so the display layer
      // can switch the activity verb to "refreshing memory" while the
      // read is in flight. Defensive try/catch so a misbehaving hook
      // never blocks the refresh.
      try { this.onMemoryRefreshStart?.(); } catch { /* defensive */ }
      let snapshot: MemorySnapshot;
      try {
        snapshot = await this.refreshMemorySnapshot();
      } catch {
        // Leave the dirty set as-is so the next turn retries. We don't
        // break this turn over a transient memory-read failure.
        return;
      }
      this.promptBuilderOptions = {
        ...this.promptBuilderOptions,
        memorySnapshot: snapshot,
      };
    }
    this.cachedSystemPrompt = null;
    this.onMemoryRefresh?.(dirtyFiles);
    this.memoryDirty.clear();
  }

  private async ensureSystemPrompt(): Promise<string | null> {
    if (!this.promptBuilder || !this.promptBuilderOptions) return null;
    if (this.cachedSystemPrompt !== null) return this.cachedSystemPrompt;
    this.cachedSystemPrompt = await this.promptBuilder.build(this.promptBuilderOptions);
    // v4.1.5 Issue K — fire AFTER the prompt has been assembled, with
    // cardinality so the display layer can surface "preparing prompt:
    // N tools, M skills" or similar. Only fires when the cache MISSED
    // (which is what made us actually build); cached returns skip the
    // hook because nothing was prepared this turn. Defensive try/catch.
    if (this.onPromptBuilt) {
      try {
        this.onPromptBuilt({
          tools:       this.tools.length,
          skills:      this.promptBuilderOptions.skillsList?.length ?? 0,
          memoryFacts: countMemoryFacts(this.promptBuilderOptions.memorySnapshot),
        });
      } catch { /* defensive */ }
    }
    return this.cachedSystemPrompt;
  }

  private async narrowTools(
    userMsg: string,
    history: Message[],
  ): Promise<ToolSchema[]> {
    if (!this.plannerGuard) return this.tools;
    // v4.6 Phase 2M — runtime toggle gates the keyword-based narrower.
    // Default OFF: smart models (GPT-5.5, Claude Sonnet 4.5+, Opus)
    // pick tools fine from the full catalog every turn, matching the
    // reference multi-agent system's pattern. Opt in via env
    // (AIDEN_PLANNER_GUARD=1) or `/planner-guard on` for small local
    // models that need help. The toggle is read on each call so a
    // mid-conversation flip takes effect on the next turn without
    // restarting the agent.
    //
    // Lazy `require` to avoid a hard import dependency in the agent
    // core — pure unit tests of AidenAgent that don't initialise the
    // runtime toggles singleton keep working (the lazy getter returns
    // an env-only fallback resolver per runtimeToggles.ts:213).
    const { getRuntimeToggles } = await import('./runtimeToggles');
    if (!getRuntimeToggles().isEnabled('planner_guard')) {
      return this.tools;
    }
    const decision = await this.plannerGuard.decide(userMsg, history);
    this.onPlannerGuardDecision?.(decision);
    const allowed = new Set(decision.selectedTools);
    return this.tools.filter((t) => allowed.has(t.name));
  }

  private makeTrackers(): {
    skill: SkillEnforcementTracker;
    url:   UrlProvenanceTracker;
  } {
    return {
      skill: new SkillEnforcementTracker(this.skillEnforcementMetrics),
      url:   new UrlProvenanceTracker(this.urlProvenanceMetrics),
    };
  }

  /**
   * The actual tool-calling loop. Returns a partial result the public
   * `runConversation` enriches with post-loop scan output.
   */
  private async runTurnLoop(
    initialMessages:  Message[],
    tools:            ToolSchema[],
    trackers:         { skill: SkillEnforcementTracker; url: UrlProvenanceTracker },
    runOptions:       RunConversationOptions,
  ): Promise<{
    finalContent:       string;
    messages:           Message[];
    turnCount:          number;
    toolCallCount:      number;
    fallbackActivated:  boolean;
    finishReason:       'stop' | 'budget_exhausted' | 'error' | 'tool_loop' | 'interrupted';
    totalUsage:         { inputTokens: number; outputTokens: number };
    toolCallTrace:      HonestyTraceEntry[];
    fullTrace:          Array<{ name: string; args: Record<string, unknown> }>;
    /**
     * v4.11 Slice 2 — structured ui-event claims emitted this turn
     * (ui_test_result, ui_task_done, …). Honesty cross-checks success
     * claims here against the verifier verdicts in toolCallTrace.
     */
    uiClaims:           Array<{ name: string; args: unknown }>;
    /** v4.1.6 spike (TCE) — populated when finishReason === 'tool_loop'. */
    toolLoopCard?:      AidenAgentResult['toolLoopCard'];
    /** v4.12 BE.1 — money-safety handoff when the token cap tripped. */
    resumeHandoff?:     AidenAgentResult['resumeHandoff'];
  }> {
    // v4.6 Phase 1 — expose the per-turn signal to tools via
    // `getCurrentSignal()`. Set at loop entry; cleared before the return
    // below. Tools that need the parent's signal (e.g. `spawn_sub_agent`
    // building a child cancellation chain) capture the agent reference at
    // construction time and read this field at dispatch time. If the loop
    // throws, the stale value persists until the next call's set —
    // acceptable because the only consumer is in-flight tool dispatch,
    // which can only run while the loop is mid-execution.
    this._currentSignal = runOptions.signal;
    // v4.11 Slice 4 — expose the turn context to tools. Same Flag 1
    // lifecycle as `_currentSignal`: set at loop entry, cleared in
    // the finally before return so a stray between-turn dispatch
    // (impossible today, cheap insurance) sees `undefined`.
    this._currentTurnContext = runOptions.turnContext;

    const messages: Message[]              = [...initialMessages];
    const toolCallTrace: HonestyTraceEntry[] = [];
    // v4.11 Slice 2 — structured ui-event claims emitted this turn, for
    // the post-loop honesty claim-contradiction check.
    const uiClaims: Array<{ name: string; args: unknown }> = [];
    // v4.6 Phase 3b — per-turn signature tracker for failure → success
    // transitions. Each entry records the signatureId + failure count
    // observed so far for a given signature THIS turn. When a verifier
    // later reports `ok` for a tool call whose signature has prior
    // failures, we record a recovery report. Keyed by signature string
    // (the canonical `tool:category[:hash]` form).
    const turnFailureTracker = new Map<string, {
      signatureId:    number;
      failedAttempts: number;
    }>();
    // Internal trace mirror that retains tool-call arguments — Honesty's
    // shape doesn't include args, but SkillTeacher needs them. Both live
    // off the same entry index.
    const fullTrace: Array<{ name: string; args: Record<string, unknown> }> = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    // v4.2 Phase 3 — turn start timestamp for RecoveryReport duration.
    // Captured here so any code path (early-return / error / surface)
    // can compute wallclock duration consistently.
    const turnStartedAt = Date.now();
    let   turnCount         = 0;
    let   toolCallCount     = 0;
    let   fallbackActivated = false;
    let   cautionFired      = false;
    let   warningFired      = false;
    let   tokenCautionFired = false; // v4.12 BE.1 — token warn-ladder (80/90%)
    let   tokenWarningFired = false;
    let   emptyRetriesUsed  = 0;
    let   finishReason: 'stop' | 'budget_exhausted' | 'error' | 'tool_loop' | 'interrupted' = 'stop';
    let   finalContent      = '';
    let   resumeHandoff: AidenAgentResult['resumeHandoff'];
    // v4.1.6 spike (TCE) — per-turn loop detection + recovery state.
    // Default ON as of v4.2 Phase 6 — set AIDEN_TCE=0 to disable.
    // When disabled, TurnState.recordToolCall short-circuits with
    // `{kind: 'allow'}` and the entire v4.2 recovery surface stays
    // dormant (zero behavioural change vs v4.1.6).
    // v4.9.4 Slice 1 — honor optional test-seam factory. Production
    // paths never pass turnStateFactory → falls through to real ctor.
    const turnState = this.turnStateFactory?.() ?? new TurnState();
    // v4.13 Gap 2 — retry-policy budgets resolved once per turn
    // (env-tunable, conservative defaults; AIDEN_RETRY_OFF=1 disables).
    const retryPolicyCfg = resolveRetryPolicyConfig();
    // v4.2 Phase 1 — per-tool verifier registry. Constructed
    // unconditionally (cheap, no side effects) but only used to
    // classify tool outcomes when TCE is enabled; verification args
    // are passed to TurnState only inside the gated branch below.
    const verifierRegistry = buildDefaultRegistry();
    // v4.2 Phase 2 — per-tool failure classifier. Same gating as
    // the verifier; only runs when verification.ok === false. Phase 2
    // records-only — Phase 3 wires recovery actions off the category.
    const failureClassifier = buildDefaultClassifier();
    let toolLoopCard: AidenAgentResult['toolLoopCard'] = undefined;

    // v4.11 perf — opt-in per-iteration timing. Zero-overhead when the
    // env var is unset (one `process.env` read per iteration entry).
    // Stderr bypasses any frame/display guards; format `[perf:...]`
    // greps cleanly out of the test runner / smoke logs.
    const _perfDiag = process.env.AIDEN_PERF_DIAG === '1';
    while (true) {
      const _iterStartedAt = _perfDiag ? Date.now() : 0;
      // v4.6 prep — between-iteration cooperative-cancellation check.
      // When the caller passed an AbortSignal that has aborted, exit
      // immediately with `finishReason: 'interrupted'`. Delta accumulation
      // on abort is deferred — finalContent stays '' in this prep dispatch
      // (see docs/v4.6/phase-1-design.md §11.0).
      if (runOptions.signal?.aborted) {
        finishReason = 'interrupted';
        finalContent = '';
        break;
      }
      // v4.1.6 spike — decrement cooldown counters once per iteration
      // so cooled-down tools eventually return to the schemas. No-op
      // when TCE is disabled.
      turnState.advanceIteration();

      if (turnCount >= this.maxTurns) {
        finishReason = 'budget_exhausted';
        break;
      }
      turnCount += 1;

      // Budget warnings — at the threshold turn, exactly once each.
      const cautionAt = Math.ceil(this.maxTurns * CAUTION_FRACTION);
      const warningAt = Math.ceil(this.maxTurns * WARNING_FRACTION);
      if (!cautionFired && turnCount >= cautionAt) {
        cautionFired = true;
        this.onBudgetWarning?.('caution', turnCount, this.maxTurns);
      }
      if (!warningFired && turnCount >= warningAt) {
        warningFired = true;
        this.onBudgetWarning?.('warning', turnCount, this.maxTurns);
      }

      // ── Provider call (stream or non-stream) ──────────────────────────
      //
      // v4.1.6 spike (TCE) — filter cooled-down tools out of the
      // schemas we send to the provider. The model literally cannot
      // see (and therefore cannot request) a cooled-down tool until
      // its cooldown counter decrements to zero via
      // `turnState.advanceIteration()`. No-op when TCE disabled
      // (`getCooledDownTools()` returns []).
      let effectiveTools: ToolSchema[] = tools;
      const cooledDown = turnState.getCooledDownTools();
      if (cooledDown.length > 0) {
        const cdSet = new Set(cooledDown);
        effectiveTools = tools.filter((t) => !cdSet.has(t.name));
      }

      // ── v4.12 BE.1 — per-session TOKEN cap (money-safety), enforced BEFORE
      // the provider call so spend never crosses the cap. Unset → no-op. ──
      if (this.sessionTokenCap && this.sessionTokenCap > 0) {
        const cap  = this.sessionTokenCap;
        const used = (runOptions.sessionTokensSoFar ?? 0) + totalUsage.inputTokens + totalUsage.outputTokens;
        // token warn-ladder (once each, before the limit)
        if (!tokenCautionFired && used >= cap * TOKEN_CAUTION_FRACTION) {
          tokenCautionFired = true;
          this.onBudgetWarning?.('caution', used, cap, 'tokens');
        }
        if (!tokenWarningFired && used >= cap * TOKEN_WARNING_FRACTION) {
          tokenWarningFired = true;
          this.onBudgetWarning?.('warning', used, cap, 'tokens');
        }
        // Would the NEXT normal call breach (cap − reserve)? maxOutputTokens is
        // the provider's hard output ceiling, so estNext is an UPPER bound.
        const reserve = Math.max(MIN_SUMMARY_RESERVE, Math.floor(cap * SUMMARY_RESERVE_FRACTION));
        const limits  = this.modelMetadata.getLimits(this.providerId ?? '', this.modelId ?? '');
        const estNext = this.modelMetadata.estimateMessageTokens(messages)
          + this.modelMetadata.estimateToolTokens(effectiveTools)
          + limits.maxOutputTokens;
        if (used + estNext > cap - reserve) {
          // ★ Money-safety: DO NOT make this call. Graceful finalization only —
          // no new side-effects, spend never exceeds the cap.
          finishReason = 'budget_exhausted';
          if (used + SUMMARY_OUTPUT_ALLOWANCE <= cap) {
            // reserve headroom → ONE toolless summary (tools:[] → no side-effects)
            const fin = await this.finalizeWithinBudget(messages, runOptions);
            if (fin) {
              if (fin.content) finalContent = fin.content;
              totalUsage.inputTokens  += fin.inputTokens;
              totalUsage.outputTokens += fin.outputTokens;
            }
          }
          // else: no headroom → keep the deterministic partial, ZERO further spend.
          if (!finalContent) {
            finalContent = 'Work paused — the session token budget was reached before the task finished.';
          }
          resumeHandoff = {
            partial_work: finalContent,
            next_steps:   'Task incomplete — the per-session token budget was reached; the work above is partial.',
            resume:       'Raise budget.session_token_cap (or use /budget), or start a fresh session, then re-send the request to continue.',
          };
          break;
        }
      }

      let output: ProviderCallOutput;
      const _llmStartedAt = _perfDiag ? Date.now() : 0;
      try {
        // v4.9.0 Slice 6 — wrap the provider call in an LLM span when
        // the daemon foundation is up AND a runWithContext frame is
        // active. NOOP otherwise. patchAttrs back-fills tokens +
        // finish_reason from the response after the call returns.
        const shim = llmSpanShim();
        if (shim && shim.db && shim.hasContext()) {
          output = await shim.withLlmSpan(
            shim.db,
            { model: this.modelId ?? 'unknown', provider: this.providerId ?? 'unknown' },
            async (_ctx, patchAttrs) => {
              const out = await this.callProvider(messages, effectiveTools, runOptions);
              patchAttrs({
                input_tokens:        out.usage?.inputTokens ?? 0,
                output_tokens:       out.usage?.outputTokens ?? 0,
                total_tokens:        (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0),
                cache_read_tokens:   out.usage?.cacheReadTokens ?? 0,
                cache_write_tokens:  out.usage?.cacheWriteTokens ?? 0,
                finish_reason:       out.finishReason,
              });
              return out;
            },
          );
        } else {
          output = await this.callProvider(messages, effectiveTools, runOptions);
        }
        if (_perfDiag) {
          const llmMs = Date.now() - _llmStartedAt;
          const tokIn = output.usage?.inputTokens ?? 0;
          const tokOut = output.usage?.outputTokens ?? 0;
          const nTools = output.toolCalls?.length ?? 0;
          process.stderr.write(
            `[perf:iter=${turnCount + 1} llm=${llmMs}ms tokens_in=${tokIn} tokens_out=${tokOut} toolCalls=${nTools}]\n`,
          );
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // v4.6 prep — external abort takes priority over fallback. An
        // AbortError surfaced from the adapter when input.signal aborted
        // is NOT a transient transport failure; surface it immediately
        // as `finishReason: 'interrupted'` so the calling spawn primitive
        // can route correctly. Detect via either the live signal flag or
        // the error name (covers both pre-fetch and mid-flight aborts).
        if (runOptions.signal?.aborted || error.name === 'AbortError') {
          finishReason = 'interrupted';
          finalContent = '';
          break;
        }
        if (this.fallback && !fallbackActivated) {
          const next = await this.fallback.activate(error, turnCount);
          if (next) {
            this.provider = next;
            fallbackActivated = true;
            // Retry the same turn with the new provider; don't burn budget.
            turnCount -= 1;
            continue;
          }
        }
        throw error;
      }

      totalUsage.inputTokens  += output.usage?.inputTokens  ?? 0;
      totalUsage.outputTokens += output.usage?.outputTokens ?? 0;

      // v4.2 Phase 4 — capture the state going INTO this iteration's
      // tool dispatch. MUST run BEFORE `messages.push(assistantMsg)`
      // so the checkpoint represents "the conversation before the
      // model decided to call this iteration's tools". If rollback
      // fires later, truncating `messages.length` to
      // `checkpoint.messages.length` drops the assistant tool_call
      // message together with its tool result messages — preserving
      // tool_call/tool_result pairing in the rolled-back state.
      //
      // Capturing AFTER the assistant push (the prior placement) was
      // a real bug: rollback would leave the assistant tool_call in
      // history without its tool results, producing strict-provider
      // 400 errors of the form "No tool output found for function
      // call <id>". Tests in tests/v4/core/checkpoint-integration
      // assert the post-rollback messages array contains zero orphan
      // assistant tool_calls — this position is part of the contract.
      //
      // No-op when TCE is disabled (AIDEN_TCE=0) or checkpointDepth=0.
      turnState.captureCheckpoint(messages, turnCount);

      // ── Append assistant message ──────────────────────────────────────
      const assistantMsg: Message = output.toolCalls.length > 0
        ? { role: 'assistant', content: output.content ?? '', toolCalls: output.toolCalls }
        : { role: 'assistant', content: output.content ?? '' };
      messages.push(assistantMsg);

      // ── Empty-response guard (cap=1 per turn) ─────────────────────────
      const isEmpty = (output.content ?? '').length === 0 && output.toolCalls.length === 0;
      if (isEmpty) {
        this.emptyResponseMetrics.detected += 1;
        if (emptyRetriesUsed < EMPTY_RETRY_CAP) {
          emptyRetriesUsed += 1;
          this.emptyResponseMetrics.retried += 1;
          messages.push({ role: 'system', content: EMPTY_RETRY_NOTE });
          continue;
        }
        // Cap exceeded — accept the empty response and stop.
        finalContent = '';
        finishReason = 'stop';
        break;
      }
      if (emptyRetriesUsed > 0) {
        this.emptyResponseMetrics.recovered += 1;
        emptyRetriesUsed = 0;
      }

      // ── Skill-enforcement: record each tool call (skill_view result
      //    handled after dispatch when we have its body) ────────────────
      for (const tc of output.toolCalls) {
        trackers.skill.recordToolCall(tc.name);
      }

      // ── No tool calls → terminal turn (with skill-retry chance) ──────
      if (output.toolCalls.length === 0) {
        const verdict = trackers.skill.evaluateOnFinal();
        if (verdict.kind === 'incomplete-can-retry') {
          trackers.skill.incrementRetry();
          messages.push({
            role:    'system',
            content: trackers.skill.buildCorrectiveMessage(verdict.missing),
          });
          continue;
        }
        // 'no-skill-armed', 'satisfied', 'incomplete-cap-exceeded' all end
        // the loop. Tracker handles its own recovered/failed counters.
        // v4.11 — strip hallucinated `<ui_NAME{...}</ui_NAME>` text
        // emissions from weak instruct models BEFORE finalContent
        // lands in the archived/persisted record. Streaming display
        // is cleaned separately via the per-call delta filter (below).
        finalContent = stripLeakedUiMarkup(output.content ?? '');
        finishReason = 'stop';
        break;
      }

      // ── URL provenance pre-check on outgoing open_url calls ──────────
      let provenanceRetry = false;
      for (const tc of output.toolCalls) {
        const v = trackers.url.checkOpenUrl(tc.name, tc.arguments);
        if (v.kind === 'block-can-retry') {
          // Drop the tool-using assistant turn we just appended; inject
          // a corrective system note so the model knows to retry with a
          // candidate it actually saw.
          trackers.url.incrementRetry();
          messages.pop();
          messages.push({
            role:    'system',
            content: trackers.url.buildCorrectiveMessage(v.videoId),
          });
          provenanceRetry = true;
          break;
        }
        if (v.kind === 'pass') {
          trackers.url.recordRecovery();
        }
      }
      if (provenanceRetry) {
        // Don't count this against the iteration budget.
        turnCount -= 1;
        continue;
      }

      // ── Dispatch tools sequentially ──────────────────────────────────
      const turnToolMessages: Message[] = [];
      // v4.1.6 spike (TCE) — set when TurnState surfaces a tool_loop
      // mid-batch. The agent stops dispatching remaining calls in the
      // batch and breaks out of the outer iteration loop cleanly.
      let surfaceDecision: RecoveryDecision | null = null;
      // v4.2 Phase 4 — set when TurnState's recovery controller asks
      // for a rollback. The agent loop truncates messages + restores
      // TurnState internals + pushes a corrective system message,
      // then continues the outer iteration loop from a clean baseline.
      let rollbackDecision: RecoveryDecision | null = null;
      // v4.11 perf — pre-execute consecutive read-only tool calls in
      // parallel. The for-of loop below stays sequential (it threads
      // verifier / classifier / TurnState updates that depend on each
      // prior call's outcome); we only hoist the NETWORK/IO portion
      // (handler.execute) out for batches of pure-read tools so they
      // run concurrently instead of serialized.
      //
      // Read-only classification: `resolveMutates(name) !== true` AND
      // not a uiOnly signal (those have their own branch below).
      // Maximal consecutive batches preserve any read-after-write
      // ordering the model may have intended (we never reorder across
      // a mutating call).
      //
      // Results land in `preComputedResults` keyed by call.id. The
      // for-of loop checks this map at the toolExecutor dispatch site
      // and uses the pre-computed result when available, falling
      // through to live execution otherwise (mutating calls always,
      // single-call read-only batches that we don't bother batching).
      //
      // Errors caught per-call so one failure doesn't abort the
      // Promise.all — each cell of the batch returns a synthesized
      // error ToolCallResult that the downstream verifier path
      // handles identically to a live-execution error.
      const preComputedResults = new Map<string, ToolCallResult>();
      {
        const toolCalls = output.toolCalls;
        const isReadOnly = (name: string): boolean =>
          this.resolveMutates?.(name) !== true &&
          this.resolveUiOnly?.(name) !== true;
        let i = 0;
        while (i < toolCalls.length) {
          if (!isReadOnly(toolCalls[i].name)) { i += 1; continue; }
          // Find the maximal consecutive read-only batch starting at i.
          let j = i;
          while (j < toolCalls.length && isReadOnly(toolCalls[j].name)) j += 1;
          const batch = toolCalls.slice(i, j);
          // Skip the parallel path for solo batches — no benefit, and
          // keeps the live-execution path on the sequential loop where
          // its existing timing instrumentation can still observe it.
          if (batch.length > 1) {
            const batchResults = await Promise.all(
              batch.map((c) =>
                this.toolExecutor(c).catch((err: unknown): ToolCallResult => ({
                  id:     c.id,
                  name:   c.name,
                  result: null,
                  error:  err instanceof Error ? err.message : String(err),
                })),
              ),
            );
            for (let k = 0; k < batch.length; k += 1) {
              preComputedResults.set(batch[k].id, batchResults[k]);
            }
          }
          i = j;
        }
      }
      // v4.9.4 Slice 1 — `.entries()` so the surface + abort fill sites
      // can slice from `callIndex + 1` to compute the un-dispatched tail.
      for (const [callIndex, call] of output.toolCalls.entries()) {
        // v4.6 prep — pre-tool-call cooperative-cancellation check.
        // If the caller aborted between the model emitting tool calls
        // and us dispatching them, skip the remaining calls in this
        // batch. We set finishReason here; the outer-while break is
        // handled after the for-of exits.
        if (runOptions.signal?.aborted) {
          // v4.9.4 Slice 1 — fill synthetic results so the assistant's
          // toolCalls[] is balanced before we break. `call` (the one we
          // were ABOUT to dispatch) gets variant='interrupted'; every
          // remaining call gets variant='skipped'. Both with reason
          // 'cancelled'. CRITICAL: also push turnToolMessages into the
          // history NOW — the outer `if (finishReason === 'interrupted')`
          // break (post-for-of) exits before reaching the line 1599
          // bulk-push. Without this explicit push the synthetic results
          // we just collected get discarded.
          turnToolMessages.push(synthesizeBlockedToolResult(call, 'cancelled', { variant: 'interrupted' }));
          fillRemainingAsBlocked(turnToolMessages, output.toolCalls, callIndex + 1, 'cancelled', 'skipped');
          messages.push(...turnToolMessages);
          finishReason = 'interrupted';
          finalContent = '';
          break;
        }
        // v4.8.0 — uiOnly tools are signal channels, not executable
        // tools. The model calls them to communicate render-time
        // state. Dispatch loop skips execute / iteration / mutation
        // marking / verifier / trace / observability hooks and fires
        // onUiEvent on the caller. A '(no output)' tool_result is
        // pushed to satisfy the provider protocol (every tool_call_id
        // needs a matching tool_result). Listener exceptions are
        // swallowed so a bad UI handler cannot break the turn.
        if (this.resolveUiOnly?.(call.name) === true) {
          turnToolMessages.push({
            role:       'tool',
            toolCallId: call.id,
            content:    '(no output)',
          });
          try {
            runOptions.onUiEvent?.(call.name, call.arguments);
          } catch {
            // defensive — UI listener faults must never break dispatch
          }
          // v4.11 Slice 2 — record the structured ui-event claim so the
          // post-loop honesty check can cross-reference success claims
          // (ui_test_result{failed:0}, ui_task_done{status:'success'})
          // against the verifier verdicts in toolCallTrace.
          uiClaims.push({ name: call.name, args: call.arguments });
          continue;
        }
        this.onToolCall?.(call, 'before');
        // v4.2 Phase 4 — mark any active checkpoints as containing a
        // mutating call BEFORE dispatch. Done pre-dispatch (not post)
        // so that even if the tool throws / errors / produces a
        // partial side effect, the mutation flag is set — rollback
        // safety errs on the side of "this iteration mutated state".
        // The mutability resolver is wired from the CLI's tool
        // registry (`resolveMutates`); unknown tools return undefined,
        // which we treat as non-mutating (leave the flag alone).
        // Plugin authors should declare `mutates` honestly on their
        // tool handlers — this is the structural enforcement point.
        if (turnState.isEnabled() && this.resolveMutates?.(call.name) === true) {
          turnState.markMutationOnLiveCheckpoint(call.name);
        }
        let result: ToolCallResult;
        // v4.11 perf — use the pre-computed result from the parallel
        // batch above when available; falls through to live execution
        // for mutating calls + solo read-only batches. The error
        // shape from the batch matches what live execution would
        // produce, so the verifier / classifier paths below are
        // indifferent to the source.
        const _preComputed = preComputedResults.get(call.id);
        // v4.2 Phase 1 — verifier classification. The registry resolves
        // a per-tool verifier or falls back to the heuristic default.
        // Synchronous + pure; no network, no side effects.
        let verification: VerificationResult | undefined;
        let classification: ClassificationResult | null = null;
        // ── v4.13 Gap 2 — failure-class retry policy at the dispatch
        // choke point. Execute → verify → classify, then ask the policy
        // (core/v4/retryPolicy.ts) what to do. Only transient classes on
        // non-mutating tools runtime-retry (bounded backoff, per-class +
        // per-turn budgets); every retry is OBSERVABLE — recorded on the
        // trace entry and annotated on the model-visible tool message.
        // The TurnState repeat ladder stays the outer circuit breaker:
        // each superseded failed attempt is recorded into its counters
        // BEFORE re-attempting, and any non-allow ladder decision stops
        // the retry loop immediately (the two never fight).
        const retryNotes: RetryAttemptNote[] = [];
        const pendingRetryHints: string[] = [];
        let finalPolicyDecision: RecoveryActionDecision | null = null;
        let preRecordedRecovery: RecoveryDecision | null = null;
        let attemptNo = 0;
        for (;;) {
          attemptNo += 1;
          const _toolStartedAt = _perfDiag ? Date.now() : 0;
          if (attemptNo === 1 && _preComputed) {
            result = _preComputed;
          } else {
            try {
              result = await this.toolExecutor(call);
            } catch (err) {
              result = {
                id:     call.id,
                name:   call.name,
                result: null,
                error:  err instanceof Error ? err.message : String(err),
              };
            }
          }
          if (_perfDiag) {
            const toolMs = Date.now() - _toolStartedAt;
            const ok = result.error == null;
            const src = attemptNo === 1 && _preComputed ? 'parallel' : 'live';
            process.stderr.write(
              `[perf:iter=${turnCount + 1} tool=${call.name} ms=${toolMs} src=${src} ok=${ok} attempt=${attemptNo}]\n`,
            );
          }
          // v4.11 Slice 1 (verifier→honesty bridge) — compute the
          // per-tool verification ALWAYS (pure/synchronous) so the
          // post-loop honesty footer reflects real outcomes independent
          // of whether TCE/recovery is active.
          try {
            verification = verifierRegistry.resolve(call.name)(
              call.name, call.arguments, result,
            );
          } catch {
            // Defensive — a buggy verifier never breaks the agent loop.
            verification = undefined;
          }
          classification = null;
          if (turnState.isEnabled() && verification && !verification.ok) {
            try {
              classification = failureClassifier.classify(
                verification, call.name, call.arguments, result,
              );
            } catch {
              // Defensive — a buggy classifier never breaks the loop.
              classification = null;
            }
          }
          // Verifier-ok / unclassified / TCE-off → this attempt is final.
          if (!classification) break;
          const decision = decideRecoveryAction(
            classification.category,
            call.name,
            turnState.retryView(),
            retryPolicyCfg,
            { toolMutates: this.resolveMutates?.(call.name) ?? false },
          );
          finalPolicyDecision = decision;
          // One-shot flags: repair-once is marked on FIRST sight of the
          // class (the decision above already consulted the pre-mark
          // state); clarify-once marks when the directive is issued.
          if (classification.category === 'invalid_input') {
            turnState.markRepairAttempted(`${call.name}:invalid_input`);
          }
          if (decision.action === 'clarify') turnState.markClarifyAdvised();
          if (decision.action !== 'retry' && decision.action !== 'retry_with_backoff') break;
          if (this._currentSignal?.aborted) break;
          // Breaker feed — the superseded failed attempt counts toward
          // the ladder's signature counters before we re-attempt.
          const rec = turnState.recordToolCall(
            call.name, call.arguments, verification, classification,
          );
          if (rec.kind === 'hint') {
            if (rec.hintMessage) pendingRetryHints.push(rec.hintMessage);
          } else if (rec.kind !== 'allow') {
            // Ladder says stop (cooldown/rollback/surface) — the breaker
            // wins over the policy. This failed attempt is final and has
            // ALREADY been recorded; reuse the decision below.
            preRecordedRecovery = rec;
            break;
          }
          turnState.recordPolicyRetry(classification.category);
          retryNotes.push({
            attempt:   attemptNo,
            category:  classification.category,
            reason:    classification.reason,
            backoffMs: decision.backoffMs ?? 0,
          });
          await sleepWithSignal(decision.backoffMs ?? 0, this._currentSignal);
          if (this._currentSignal?.aborted) break;
        }
        toolCallCount += 1;
        if (turnState.isEnabled()) {
          if (verification && !verification.ok && classification) {
            // v4.6 Phase 3b — write-through to the durable failure
            // ledger. Best-effort: a null/missing store (test agents
            // without a daemon DB wired) silently no-ops. The
            // signature builder is pure + cheap.
            if (classification) {
              try {
                const store = getRecoveryStore();
                if (store) {
                  const sig = buildFailureSignature({
                    toolName: call.name,
                    category: classification.category,
                    args:     call.arguments,
                  });
                  const signatureId = store.recordFailureOccurrence({
                    signature: sig.signature,
                    toolName:  call.name,
                    category:  classification.category,
                    argsHash:  sig.argsHash,
                  });
                  if (signatureId > 0) {
                    const existing = turnFailureTracker.get(sig.signature);
                    turnFailureTracker.set(sig.signature, {
                      signatureId,
                      failedAttempts: (existing?.failedAttempts ?? 0) + 1,
                    });
                  }
                }
              } catch {
                // Defensive — persistence failure must never break the loop.
              }
            }
          } else if (verification && verification.ok) {
            // v4.6 Phase 3b — failure → success transition detection.
            // We don't know the failure CATEGORY for this successful
            // call (the verifier said ok, so classify() wasn't run),
            // but the per-turn tracker remembers every signature seen
            // failing this turn. Walk the tracker; if any entry's
            // signature starts with `<call.name>:`, this tool now
            // succeeded — record a recovery and drop the entry so
            // subsequent successes don't double-count.
            try {
              const store = getRecoveryStore();
              if (store) {
                const matching: string[] = [];
                for (const sig of turnFailureTracker.keys()) {
                  if (sig.startsWith(`${call.name}:`)) matching.push(sig);
                }
                for (const sig of matching) {
                  const entry = turnFailureTracker.get(sig);
                  if (!entry) continue;
                  store.recordRecovery({
                    signatureId:        entry.signatureId,
                    sessionId:          (this as { sessionId?: string }).sessionId,
                    failedAttempts:     entry.failedAttempts,
                    successfulStrategy: 'in_turn_retry',
                    notes:              `${call.name} succeeded after ${entry.failedAttempts} prior failure(s) this turn`,
                  });
                  turnFailureTracker.delete(sig);
                }
              }
            } catch {
              // Defensive — recovery persistence failure must never break the loop.
            }
          }
        }
        toolCallTrace.push({
          name:     call.name,
          result:   result.result,
          error:    result.error,
          verified: this.resolveVerifiedFlag?.(result),
          // v4.7.0 Phase 2.3 — stamp the handler's `mutates` flag
          // at dispatch time so the post-loop honesty verifier can
          // distinguish mutating vs read-only failures without
          // needing a registry handle. Defaults to `false` for
          // unknown tools (the resolver returns undefined) — read-
          // only tools that error are surfaced via the tool-trail
          // row already; the verifier deliberately stays quiet
          // about them.
          handlerMutates: this.resolveMutates?.(call.name) ?? false,
          // v4.2 Phase 1 — verification surfaces alongside the trace
          // entry for downstream callers (chatSession, loopTrace,
          // future RecoveryReport). Undefined when TCE is off.
          verification,
          // v4.2 Phase 2 — classification surfaces alongside verification.
          // Undefined for verifier-ok calls (classifier skips them) and
          // when TCE is off.
          classification: classification ?? undefined,
          // v4.13 Gap 2 — observable retry ledger: one note per runtime
          // re-attempt (class, reason, backoff). Undefined when the call
          // went through on the first attempt.
          retries: retryNotes.length > 0 ? retryNotes : undefined,
        });
        fullTrace.push({ name: call.name, args: call.arguments });
        // URL ledger ingest — extracts ids from result body for next turn.
        trackers.url.recordToolResult(call.name, result.result);
        // skill_view result → arm the enforcement tracker if the skill
        // declares required_tools.
        const skillView = extractSkillViewRequiredTools(call.name, result.result);
        if (skillView) {
          trackers.skill.recordSkillView(skillView.skillName, skillView.requiredTools);
        }
        this.onToolCall?.(call, 'after', result);
        // v4.13 Gap 2 — the model SEES what the runtime did: retry
        // attempts, the failure class, and the chosen recovery action
        // are appended to the tool message (observable, never silent).
        const _finalOk = !(verification && !verification.ok);
        const _retryAnnotation = buildRetryAnnotation(
          retryNotes,
          _finalOk ? null : finalPolicyDecision,
          _finalOk,
        );
        const _baseContent = result.error
          ? `[error] ${result.error}`
          : stringifyToolResult(result.result);
        turnToolMessages.push({
          role:        'tool',
          toolCallId:  call.id,
          content:     _retryAnnotation ? `${_baseContent}\n${_retryAnnotation}` : _baseContent,
        });
        // Ladder hints raised DURING retry attempts still reach the
        // model as system messages (same pattern as the post-call hint).
        for (const h of pendingRetryHints) {
          turnToolMessages.push({ role: 'system', content: h });
        }
        // v4.1.6 spike (TCE) — after the tool result lands in the
        // message history, consult the recovery controller. Returns
        // `allow` immediately when TCE disabled (zero overhead).
        // v4.2 Phase 1 — pass the verifier outcome so TurnState's
        // consecFailed counter can fast-fail on demonstrably failing
        // tool calls before the slower signature/name counters fire.
        // v4.2 Phase 2 — also pass the classification so TurnState
        // records the WHY for Phase 3's RecoveryReport.
        // v4.13 Gap 2 — when the ladder interrupted the retry loop, the
        // final (failed) attempt was already recorded there; reuse that
        // decision instead of double-counting the same attempt.
        const recovery = preRecordedRecovery ?? turnState.recordToolCall(
          call.name, call.arguments, verification, classification,
        );
        if (recovery.kind === 'hint' && recovery.hintMessage) {
          // Stage 1: append a corrective system message so the model
          // sees it on the next provider call. Same pattern as the
          // existing skill-enforcement + URL-provenance correctives.
          turnToolMessages.push({
            role:    'system',
            content: recovery.hintMessage,
          });
        } else if (recovery.kind === 'cooldown_with_rollback' && recovery.rollback) {
          // v4.2 Phase 4 — controller asks us to roll back. Capture
          // the decision; we apply it AFTER the inner dispatch loop
          // exits so we don't leave partial turnToolMessages in a
          // half-state. Break out of dispatch immediately — no point
          // running more tools whose results we're about to drop.
          rollbackDecision = recovery;
          break;
        } else if (recovery.kind === 'cooldown' && recovery.cooldownMessage) {
          // Stage 2: cooldown has already been recorded internally
          // (next iteration's schema-filter step excludes this tool).
          // Inject a system message announcing the cooldown so the
          // model knows why the tool just disappeared from its menu.
          turnToolMessages.push({
            role:    'system',
            content: recovery.cooldownMessage,
          });
        } else if (recovery.kind === 'surface' && recovery.surfaceCard) {
          // Stage 3: structured failure. Stop dispatching the rest of
          // the batch — anything else is throwing good budget after bad.
          // The outer loop reads `surfaceDecision` below and exits cleanly.
          //
          // v4.9.4 Slice 1 — BEFORE breaking, fill synthetic blocked-
          // tool-result messages for every un-dispatched call in this
          // batch (slice from callIndex+1; the current call already had
          // its real result pushed at line ~1440 just above). Without
          // this fill, the assistant message at line ~1170 carries
          // tool_call_ids whose matching tool results never land in
          // history. The outer surfaceDecision branch (line ~1573)
          // pushes turnToolMessages into `messages` and breaks the
          // outer while loop, ending the turn — but the persisted
          // history carries the orphans. A resumed conversation (or
          // any second provider call in the same turn) then returns
          // 400 "No tool output found for function call <id>".
          fillRemainingAsBlocked(turnToolMessages, output.toolCalls, callIndex + 1, 'tool_loop_surface');
          surfaceDecision = recovery;
          break;
        }
      }

      // v4.6 prep — if the per-tool-call abort check fired inside the
      // for-of above, finishReason is now 'interrupted'. Break the outer
      // while immediately so we don't run another provider call. Done
      // here (post-for-of) rather than inside the for-of because the
      // inner `break` only exits the inner loop.
      if (finishReason === 'interrupted') {
        break;
      }

      // v4.2 Phase 4 — apply rollback if the controller asked for it.
      // Truncate messages to the captured snapshot length, restore
      // TurnState internals, then push a corrective system message
      // and continue the OUTER iteration loop. We deliberately drop
      // any partial `turnToolMessages` collected before the rollback
      // trigger — those are the noise we're trying to undo.
      //
      // Hard-block invariant: TurnState only emits
      // `cooldown_with_rollback` when the target checkpoint has
      // `containedMutations === false`, so we never get here for an
      // iteration that ran a mutating tool. The optional
      // `rollback.blockedBy` is empty in Phase 4 (kept on the type
      // for a Phase 5+ soft-rollback variant).
      if (rollbackDecision && rollbackDecision.rollback) {
        const { checkpoint, blockedBy } = rollbackDecision.rollback;
        // Truncate messages array to the captured length. The captured
        // items are immutable Message references; we keep them as-is
        // and just shorten the live array.
        messages.length = checkpoint.messages.length;
        // Restore TurnState mutable internals (stage / streaks /
        // cooledDownTools / arrays). The cooled-down tools map is
        // preserved as it was at checkpoint time — but the controller
        // already added the looping tool to `cooledDownTools` before
        // emitting the decision, so we need to RE-apply that cooldown
        // after restore to honour the cooldown intent.
        turnState.restoreInternalsFrom(checkpoint);
        // Re-cool the tool that triggered the rollback so the next
        // provider call sees the constrained schema.
        if (rollbackDecision.toolName) {
          turnState.reapplyCooldown(rollbackDecision.toolName);
        }
        // Inject corrective system message so the model sees what
        // happened and why the tool just disappeared from its menu.
        messages.push({
          role:    'system',
          content: buildRollbackMessage({
            iteration: checkpoint.iteration,
            toolName:  rollbackDecision.toolName,
            blockedBy,
          }),
        });
        // Continue the outer iteration loop from the restored
        // baseline. The next provider call gets the filtered tool
        // schema (cooldown applied) and the corrective message.
        continue;
      }

      // v4.1.6 spike (TCE) — terminal surface handling.
      if (surfaceDecision && surfaceDecision.kind === 'surface') {
        finishReason = 'tool_loop';
        // v4.2 Phase 3 — enrich the base surface card with a
        // structured RecoveryReport. Pure synthesis from TurnState's
        // diagnostic snapshot + first-user-message goal + duration.
        // Implicit gating: this branch is only reachable when
        // TurnState is enabled, so AIDEN_TCE=0 (opt-out) never
        // builds a report.
        if (surfaceDecision.surfaceCard) {
          const report = buildRecoveryReport({
            snapshot:   turnState.getDiagnosticSnapshot(),
            goal:       extractGoal(messages),
            exitReason: 'tool_loop',
            durationMs: Date.now() - turnStartedAt,
          });
          toolLoopCard = enrichCardWithReport(surfaceDecision.surfaceCard, report);
        } else {
          toolLoopCard = surfaceDecision.surfaceCard;
        }
        // Push the partial tool messages we collected so honesty +
        // history downstream see the full sequence including the
        // loop-trigger call. No final assistant message — the
        // tool_loop card IS the user-facing surface.
        messages.push(...turnToolMessages);
        finalContent = '';
        break;
      }

      // ── Iteration-budget injection on the LAST tool message ──────────
      if (this.iterationBudgetInjection && turnToolMessages.length > 0) {
        const remaining = this.maxTurns - turnCount;
        if (remaining / this.maxTurns <= BUDGET_INJECT_FRAC) {
          const last = turnToolMessages[turnToolMessages.length - 1];
          last.content = `${last.content}\n\n[iteration budget: ${remaining} of ${this.maxTurns} turns remaining]`;
        }
      }

      // ── v4.12.1 Pillar 4 Slice 2b — mid-turn STEER injection ─────────
      // THE safe boundary: the prior tool batch's results are all present
      // (history balanced), and the next provider call hasn't fired. Drain
      // any pending steer and surface it as CONTEXT — appended to the last
      // tool message (the budget-hint pattern), or a role:'system' note when
      // there are no tool messages this iteration (the TurnState-hint pattern).
      // NEVER a role:'user' message → role alternation / provider invariants
      // stay intact. Text-only turns break before reaching here, so there is
      // no half-finished iteration to corrupt.
      const steer = runOptions.drainSteer?.();
      if (steer && steer.trim().length > 0) {
        const note = `[user adjustment mid-turn — apply from here on: ${steer.trim()}]`;
        if (turnToolMessages.length > 0) {
          const last = turnToolMessages[turnToolMessages.length - 1];
          last.content = `${last.content}\n\n${note}`;
        } else {
          turnToolMessages.push({ role: 'system', content: note });
        }
      }

      messages.push(...turnToolMessages);
      // Loop continues — provider gets the tool results next iteration.
    }

    // v4.6 Phase 1 — clear the per-turn signal exposure before returning.
    // No-throw guarantee: if any prior code in this loop threw, the next
    // call's `this._currentSignal = runOptions.signal` at the top will
    // overwrite the stale value before any tool can read it.
    this._currentSignal = undefined;
    // v4.11 Slice 4 — pair-clear with `_currentSignal` so the same
    // between-turn invariant holds for the turn context.
    this._currentTurnContext = undefined;

    return {
      finalContent,
      messages,
      turnCount,
      toolCallCount,
      fallbackActivated,
      finishReason,
      totalUsage,
      toolCallTrace,
      fullTrace,
      uiClaims,
      toolLoopCard,
      resumeHandoff,
    };
  }

  /**
   * v4.12 BE.1 — one toolless final summary within the token budget. tools:[]
   * → the model cannot start new side-effects. Best-effort: on failure the
   * caller keeps a deterministic partial (no further spend).
   */
  private async finalizeWithinBudget(
    messages: Message[],
    runOptions: RunConversationOptions,
  ): Promise<{ content: string; inputTokens: number; outputTokens: number } | null> {
    try {
      const nudge: Message = {
        role: 'user',
        content:
          'You have reached the session token budget. Do NOT call any tools. Give a brief final summary of what you accomplished and what still remains.',
      };
      const out = await this.callProvider([...messages, nudge], [], runOptions);
      return {
        content: out.content ?? '',
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Drive the configured provider through one turn. Routes to streaming
   * if the caller opted in AND the adapter implements `callStream`;
   * otherwise plain `.call()`. Stream callbacks (`onDelta`,
   * `onFirstDelta`, `onToolCallStart`) are wired here so the surrounding
   * loop sees the same `ProviderCallOutput` regardless.
   */
  private async callProvider(
    messages:    Message[],
    tools:       ToolSchema[],
    runOptions:  RunConversationOptions,
  ): Promise<ProviderCallOutput> {
    // v4.9.4 Slice 1 — tool-call protocol preflight. Every assistant
    // toolCalls[] entry must have a matching {role:'tool', toolCallId}
    // BEFORE shipping to any provider. If this throws, a guard in
    // runTurnLoop is leaking orphan tool_call_ids — find the culprit,
    // don't catch this. The surface + abort fill sites above already
    // satisfy the invariant; preflight is the audit-loud safety net
    // for new guards added later (v4.10 rate-limit / cost-budget /
    // hook-deny). See core/v4/toolCallInvariant.ts.
    assertNoUnansweredToolCalls(messages);

    const wantStream = runOptions.stream === true && typeof this.provider.callStream === 'function';
    // v4.1.5 Issue K — fire just before the HTTP request opens, so the
    // display layer can transition the activity verb from local-prep
    // ("preparing prompt", "selecting tools") to a network verb
    // ("calling provider"). The wait for TTFT (time-to-first-token) is
    // the longest gap in most turns and is what the wave bar covers.
    // Fires for both streaming and non-streaming paths — caller may use
    // it to add a one-shot indicator on non-streaming providers too.
    // Defensive try/catch (a misbehaving hook must not block dispatch).
    try {
      this.onProviderRequestStart?.(this.providerId);
    } catch { /* defensive */ }
    // v4.9.0 Slice 7 — when an ExecutionContext is active, emit
    // outbound correlation headers (`traceparent`, `X-Aiden-*`). The
    // adapter merges them under its own auth headers so they can't
    // override security-relevant fields. No-context: headers omitted.
    const ambient = _llmCurrentContext();
    const outboundHeaders = ambient ? _injectContextHeaders(ambient) : undefined;
    if (!wantStream) {
      // v4.6 prep — forward the abort signal into the provider call so
      // an in-flight HTTP request can be cancelled mid-flight.
      return this.provider.call({ messages, tools, signal: runOptions.signal, headers: outboundHeaders });
    }

    let firstDeltaFired = false;
    let finalOutput: ProviderCallOutput | null = null;
    // v4.11 — per-call ui-leak filter. Live deltas get scrubbed
    // before reaching `runOptions.onDelta` so the display layer
    // never paints a hallucinated `<ui_NAME{…}</ui_NAME>` block.
    // The post-stream `finalContent` sanitiser at the loop's "no
    // tool calls → terminal turn" branch cleans the archived /
    // persisted output independently. Both paths are needed: the
    // adapter accumulates `output.content` from the raw deltas, so
    // cleaning the live stream alone doesn't clean the saved
    // record, and vice versa.
    const uiLeakFilter = createStreamingUiLeakFilter();
    const stream = (this.provider.callStream as NonNullable<ProviderAdapter['callStream']>)({
      messages,
      tools,
      stream: true,
      // v4.6 prep — also forward to streaming adapters; mid-stream
      // aborts cancel the underlying SSE read via the same signal.
      signal: runOptions.signal,
      headers: outboundHeaders,
    });
    for await (const evt of stream) {
      if (evt.type === 'delta') {
        if (!firstDeltaFired) {
          firstDeltaFired = true;
          runOptions.onFirstDelta?.();
        }
        const safe = uiLeakFilter.feed(evt.content);
        if (safe.length > 0) runOptions.onDelta?.(safe);
      } else if (evt.type === 'tool_call') {
        runOptions.onToolCallStart?.(evt.toolCall);
      } else if (evt.type === 'progress') {
        // v4.1.4 Part 1.6 — drive the per-turn token progress bar.
        // Defensive try/catch — a misbehaving display sink must not
        // tear down the stream consumer.
        try {
          runOptions.onProgress?.(evt.outputTokens, evt.maxTokens);
        } catch { /* progress sink errors don't block streaming */ }
      } else if (evt.type === 'done') {
        finalOutput = evt.output;
      }
    }
    // v4.11 — flush any buffered tail from the ui-leak filter.
    // (e.g. a delta that ended mid `<ui` partial gets held back; if
    // the stream ends without ever completing the tag, the held
    // content is real text and must be emitted.)
    const tail = uiLeakFilter.flush();
    if (tail.length > 0) runOptions.onDelta?.(tail);
    if (!finalOutput) {
      // v4.6 prep — if the stream consumer exited without a `done`
      // event because the signal was aborted mid-stream, surface a
      // synthetic AbortError so the outer catch routes it as
      // 'interrupted' rather than the misleading "closed without done"
      // generic error.
      if (runOptions.signal?.aborted) {
        const abortErr = new Error('Streaming provider aborted before done event');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      throw new Error('Streaming provider closed without a done event');
    }
    return finalOutput;
  }
}

// ── Free helpers ────────────────────────────────────────────────────────

/**
 * v4.1.5 Issue K — best-effort count of "memory facts" from a
 * MemorySnapshot. Counts markdown bullet-list lines (`- `) in both
 * MEMORY.md and USER.md. This is a fuzzy proxy — the agent stores
 * facts as bullets by convention but free-form prose can also carry
 * fact-like content. Surfaced verbatim to the display layer; treat as
 * "approximately N items in the persistent memory file" rather than
 * a precise inventory.
 */
/**
 * v4.13 Gap 2 — abort-aware backoff sleep for the retry loop. Resolves
 * early (never rejects) when the turn's AbortSignal fires so a user
 * cancel is never held hostage by a backoff timer.
 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function countMemoryFacts(snapshot: unknown): number {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const s = snapshot as { memoryMd?: string; userMd?: string };
  let count = 0;
  for (const md of [s.memoryMd, s.userMd]) {
    if (typeof md !== 'string' || md.length === 0) continue;
    for (const line of md.split('\n')) {
      if (line.trim().startsWith('- ')) count += 1;
    }
  }
  return count;
}

function lastUserMessageContent(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user') return m.content;
  }
  return '';
}

function stringifyToolResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// v4.9.0 Slice 6 — static imports for the LLM span bridge. Same
// reasoning as toolRegistry: vite-node doesn't intercept CJS require
// for `.ts` modules, so the lazy `require()` form returned null in
// tests. Static ESM imports work everywhere.
import { getCurrentDaemonDb as _getCurrentDaemonDb } from './daemon/bootstrap';
import { withLlmSpan as _withLlmSpan } from './daemon/spans/spanHelpers';
import { currentContext as _llmCurrentContext } from './identity';
// v4.9.0 Slice 7 — outbound trace propagation.
import { injectContextHeaders as _injectContextHeaders } from './identity';

interface LlmSpanShim {
  db: import('./daemon/db/connection').Db | null;
  hasContext(): boolean;
  withLlmSpan: typeof _withLlmSpan;
}
const _llmSpanShim: LlmSpanShim = {
  get db()      { return _getCurrentDaemonDb(); },
  hasContext:   () => _llmCurrentContext() !== undefined,
  withLlmSpan:  _withLlmSpan,
};
function llmSpanShim(): LlmSpanShim { return _llmSpanShim; }
