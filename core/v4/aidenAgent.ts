/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * Portions adapted from NousResearch/hermes-agent (MIT).
 * Original copyright (c) NousResearch.
 */
/**
 * core/v4/aidenAgent.ts — Aiden v4.0.0
 *
 * THE single tool-calling loop. Replaces planner+responder.
 *
 * Status: PHASE 2 — loop core implementation. Provider adapters land in Phase 3,
 *   tool execution in Phase 6+, prompt builder in Phase 12.
 *
 * Upstream provenance (run_agent.py line refs):
 *   - AIAgent class                                L873
 *   - AIAgent.run_conversation()                   L10382
 *   - AIAgent._execute_tool_calls_sequential()     L9779
 *   - AIAgent._execute_tool_calls_concurrent()     L9400 (deferred to v4.1)
 *   - AIAgent._handle_max_iterations()             L10191
 *   - IterationBudget class                        L271
 *   - Fallback chain wiring                        L1558+
 *
 * Why this file is the architectural fix for fabrication:
 *   v3 split intent→plan→execute→respond across two LLMs. The responder
 *   never saw raw tool outputs and routinely hallucinated them. Here, ONE
 *   LLM drives the loop: tool results are appended to its own message
 *   history before its next call, so the LLM that writes the final response
 *   literally has the tool outputs in its context window.
 */

import {
  Message,
  ToolSchema,
  ToolCallRequest,
  ToolCallResult,
  ProviderAdapter,
  ProviderCallOutput,
  StreamEvent,
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
  SkillProposalCallbacks,
  SkillTeacherTraceEntry,
} from '../../moat/skillTeacher';
import type { PromptBuilder, PromptBuilderOptions } from './promptBuilder';
import type { ContextCompressor, CompressionResult } from './contextCompressor';
import type { AuxiliaryClient } from './auxiliaryClient';
import type { PromptCaching } from './promptCaching';
import type { MemorySnapshot } from './memoryProvider';
import {
  SkillEnforcementTracker,
  extractSkillViewRequiredTools,
  type SkillEnforcementMetrics,
} from './agent/skillEnforcement';

/**
 * Tool executor — runs a single tool call and returns the result.
 *
 * Implementation lives in the tool registry (Phase 6+). For Phase 2 tests,
 * this is mocked. The executor MUST NOT throw for tool-level errors; instead
 * return a `ToolCallResult` with `error` populated. The loop catches throws
 * defensively and converts them to error results so the model can recover.
 */
export type ToolExecutor = (call: ToolCallRequest) => Promise<ToolCallResult>;

/**
 * One-shot fallback strategy. Called once per conversation when the primary
 * provider throws. Returning a new adapter swaps it in for the rest of the
 * turn; returning null propagates the error. v4 Phase 2 supports one
 * activation per `runConversation`. Multi-step chains land in a later phase.
 */
export interface FallbackStrategy {
  activate(error: Error, attempt: number): Promise<ProviderAdapter | null>;
}

export interface AidenAgentOptions {
  provider: ProviderAdapter;
  toolExecutor: ToolExecutor;
  tools: ToolSchema[];
  /** Hard cap on assistant turns. Default is 90. */
  maxTurns?: number;
  fallback?: FallbackStrategy;
  /** Observability hook — invoked before and after each tool call. */
  onToolCall?: (
    call: ToolCallRequest,
    phase: 'before' | 'after',
    result?: ToolCallResult,
  ) => void;
  /** Fired once when crossing 70% of budget (caution) and once at 90% (warning). */
  onBudgetWarning?: (
    level: 'caution' | 'warning',
    turn: number,
    max: number,
  ) => void;
  /** Phase 12: pre-loop tool subset classifier (Aiden moat). */
  plannerGuard?: PlannerGuard;
  /** Phase 12: fired with the PlannerGuard decision before the loop runs. */
  onPlannerGuardDecision?: (decision: PlannerGuardDecision) => void;
  /** Phase 12: post-loop trace verifier (Aiden moat). */
  honestyEnforcement?: HonestyEnforcement;
  /** Phase 12: skill workflow proposer (Aiden moat). */
  skillTeacher?: SkillTeacher;
  /** Phase 12: callbacks the SkillTeacher uses when proposing. */
  skillTeacherCallbacks?: SkillProposalCallbacks;
  /** Phase 12: per-tool verification flag lookup. Allows the loop to feed
   *  Honesty's verified-flag check (memory tools) without coupling the
   *  registry to Honesty. The function receives the just-completed tool
   *  call's result and returns true/false/undefined. */
  resolveVerifiedFlag?: (result: ToolCallResult) => boolean | undefined;
  /** Phase 12: lookup function for tool→toolset mapping (used by
   *  SkillTeacher to compute toolset diversity for proposals). */
  resolveToolset?: (toolName: string) => string | undefined;
  // ── Phase 13: Context layers ───────────────────────────────────────
  /** Phase 13: assembles slot-ordered system prompt at session start. */
  promptBuilder?: PromptBuilder;
  /** Phase 13: options passed to PromptBuilder.build() — frozen for the session. */
  promptBuilderOptions?: PromptBuilderOptions;
  /** Phase 13: auto-summarises conversation when context utilisation crosses threshold. */
  contextCompressor?: ContextCompressor;
  /** Phase 13: cheap-LLM router. Surfaced on the result for /usage diagnostics. */
  auxiliaryClient?: AuxiliaryClient;
  /** Phase 13: anthropic prefix-cache marker manager. */
  promptCaching?: PromptCaching;
  /** Phase 13: providerId for compression + caching lookups. Defaults to ''. */
  providerId?: string;
  /** Phase 13: modelId for compression lookup. Defaults to ''. */
  modelId?: string;
  /** Phase 13: append "you have N turns remaining" snippet to last tool result when remaining ≤ 30%. Default true. */
  iterationBudgetInjection?: boolean;
  /** Phase 13: fired each time the compressor runs successfully. */
  onCompression?: (event: CompressionResult) => void;
  /**
   * Phase 16d: callback that returns a fresh `MemorySnapshot` when the
   * cached system prompt has been invalidated by `markMemoryDirty()`.
   * Wired by `aidenCLI.ts` to `memoryManager.loadSnapshot()`. When unset,
   * the agent keeps the original frozen snapshot semantics — the dirty
   * bit is ignored.
   *
   * Strategy: only the turn after a memory write pays the rebuild cost;
   * every other turn still hits the prefix cache cleanly.
   */
  refreshMemorySnapshot?: () => Promise<MemorySnapshot>;
  /**
   * Phase 16d: fired when the agent rebuilds the cached system prompt
   * after a memory mutation. Lets the display layer show "memory refreshed"
   * diagnostics without coupling to the underlying mutation event.
   */
  onMemoryRefresh?: (file: 'memory' | 'user' | 'both') => void;
}

export interface AidenAgentResult {
  finalContent: string;
  /** Full conversation including assistant tool_calls and tool results. */
  messages: Message[];
  turnCount: number;
  toolCallCount: number;
  fallbackActivated: boolean;
  finishReason: 'stop' | 'budget_exhausted' | 'error';
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Phase 12: every tool call this turn, in order, with verified flag
   *  filled by `resolveVerifiedFlag` (when wired). Always present, even
   *  if the moat layers are not configured. */
  toolCallTrace: HonestyTraceEntry[];
  /** Phase 12: populated when HonestyEnforcement detected failed claims. */
  honestyFindings?: HonestyFinding[];
  /** Phase 12: name of the skill SkillTeacher created this turn (if any). */
  skillCreated?: string;
  /** Phase 13: number of times ContextCompressor fired during this conversation. */
  compressionEvents: number;
  /** Phase 13: AuxiliaryClient.getUsage() snapshot at end of run. */
  auxiliaryUsage: Record<string, { inputTokens: number; outputTokens: number; calls: number }>;
  /**
   * Phase 23.1: cumulative skill-enforcement counters across the agent's
   * lifetime (process-scoped). `recovered` = corrective retry produced
   * the missing tool call; `failed` = retry cap exceeded and the turn
   * ended with honest failure; `armed` = skills_view returned a non-empty
   * required_tools at least once. Always present, all zeroes when no
   * required-tool skill ever fired.
   */
  skillEnforcement: { recovered: number; failed: number; armed: number };
}

/**
 * Phase 16c: per-call options for `runConversation`. All fields are
 * optional — callers that don't pass anything get the existing
 * non-streaming behaviour. When `stream:true` and the active provider
 * adapter implements `callStream`, deltas flow through `onDelta` /
 * `onFirstDelta` / `onToolCallStart` as the SSE arrives. If the adapter
 * lacks `callStream` we silently fall back to the non-streaming path —
 * tool-call interleaving and trace structure remain identical.
 */
export interface RunConversationOptions {
  stream?: boolean;
  /** Fired once per delta event from the adapter. */
  onDelta?: (text: string) => void;
  /** Fired exactly once on the first delta of any turn. */
  onFirstDelta?: () => void;
  /**
   * Fired when the model first surfaces a tool call's name during a
   * streaming turn. The `arguments` object will be empty — use the
   * post-loop `toolCallTrace` for the parsed values.
   */
  onToolCallStart?: (call: ToolCallRequest) => void;
}

const DEFAULT_MAX_TURNS = 90;
const CAUTION_FRACTION = 0.7;
const WARNING_FRACTION = 0.9;

export class AidenAgent {
  private provider: ProviderAdapter;
  private readonly toolExecutor: ToolExecutor;
  private readonly tools: ToolSchema[];
  private readonly maxTurns: number;
  private readonly fallback?: FallbackStrategy;
  private readonly onToolCall?: AidenAgentOptions['onToolCall'];
  private readonly onBudgetWarning?: AidenAgentOptions['onBudgetWarning'];
  private readonly plannerGuard?: PlannerGuard;
  private readonly onPlannerGuardDecision?: AidenAgentOptions['onPlannerGuardDecision'];
  private readonly honestyEnforcement?: HonestyEnforcement;
  private readonly skillTeacher?: SkillTeacher;
  private readonly skillTeacherCallbacks?: SkillProposalCallbacks;
  private readonly resolveVerifiedFlag?: AidenAgentOptions['resolveVerifiedFlag'];
  private readonly resolveToolset?: AidenAgentOptions['resolveToolset'];
  // Phase 13
  private readonly promptBuilder?: PromptBuilder;
  private readonly promptBuilderOptions?: PromptBuilderOptions;
  private readonly contextCompressor?: ContextCompressor;
  private readonly auxiliaryClient?: AuxiliaryClient;
  private readonly promptCaching?: PromptCaching;
  private readonly providerId: string;
  private readonly modelId: string;
  private readonly iterationBudgetInjection: boolean;
  private readonly onCompression?: AidenAgentOptions['onCompression'];
  private readonly refreshMemorySnapshot?: AidenAgentOptions['refreshMemorySnapshot'];
  private readonly onMemoryRefresh?: AidenAgentOptions['onMemoryRefresh'];
  /** Cached system prompt — frozen after first build for session-long prefix cache. */
  private cachedSystemPrompt: string | null = null;
  private compressionEvents = 0;
  /**
   * Phase 23.1: process-scoped enforcement counters. Lives on the agent
   * (one per session) because they read from /doctor and would
   * vanish if scoped to a single user turn. Per-turn state lives on
   * the SkillEnforcementTracker constructed inside runConversation.
   */
  private readonly skillEnforcementMetrics: SkillEnforcementMetrics = {
    recovered: 0,
    failed: 0,
    armed: 0,
  };
  /**
   * Phase 16d: dirty bit set by `markMemoryDirty()`. The next
   * `runConversation` turn loads a fresh `MemorySnapshot` via
   * `refreshMemorySnapshot`, mutates `promptBuilderOptions.memorySnapshot`,
   * drops `cachedSystemPrompt`, and clears the bit. We track which file
   * (memory / user / both) so the rebuild diagnostic reflects what changed.
   */
  private memoryDirty: 'memory' | 'user' | 'both' | null = null;

  constructor(options: AidenAgentOptions) {
    this.provider = options.provider;
    this.toolExecutor = options.toolExecutor;
    this.tools = options.tools;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.fallback = options.fallback;
    this.onToolCall = options.onToolCall;
    this.onBudgetWarning = options.onBudgetWarning;
    this.plannerGuard = options.plannerGuard;
    this.onPlannerGuardDecision = options.onPlannerGuardDecision;
    this.honestyEnforcement = options.honestyEnforcement;
    this.skillTeacher = options.skillTeacher;
    this.skillTeacherCallbacks = options.skillTeacherCallbacks;
    this.resolveVerifiedFlag = options.resolveVerifiedFlag;
    this.resolveToolset = options.resolveToolset;
    // Phase 13
    this.promptBuilder = options.promptBuilder;
    this.promptBuilderOptions = options.promptBuilderOptions;
    this.contextCompressor = options.contextCompressor;
    this.auxiliaryClient = options.auxiliaryClient;
    this.promptCaching = options.promptCaching;
    this.providerId = options.providerId ?? '';
    this.modelId = options.modelId ?? '';
    this.iterationBudgetInjection = options.iterationBudgetInjection ?? true;
    this.onCompression = options.onCompression;
    this.refreshMemorySnapshot = options.refreshMemorySnapshot;
    this.onMemoryRefresh = options.onMemoryRefresh;
  }

  /**
   * Phase 16d: mark the cached memory snapshot dirty so the next
   * `runConversation` turn rebuilds the system prompt against fresh
   * MEMORY.md / USER.md content. Idempotent — subsequent calls escalate
   * single-file dirtiness to "both" but never clear the bit (only the
   * runConversation rebuild path resets it).
   *
   * Wired in `aidenCLI.ts`:
   *   memoryManager.onMutation((file) => agent.markMemoryDirty(file));
   *
   * No-op when `refreshMemorySnapshot` is not configured (Phase 12 callers
   * that don't pass a memory manager keep the frozen-snapshot semantics).
   */
  markMemoryDirty(file: 'memory' | 'user'): void {
    if (!this.refreshMemorySnapshot) return;
    if (this.memoryDirty === null) {
      this.memoryDirty = file;
    } else if (this.memoryDirty !== file) {
      this.memoryDirty = 'both';
    }
  }

  /** Phase 16d test/inspection accessor — returns the current dirty bit. */
  getMemoryDirtyState(): 'memory' | 'user' | 'both' | null {
    return this.memoryDirty;
  }

  /** Phase 14c: hot-swap the provider adapter (used by /model). */
  setProvider(adapter: ProviderAdapter): void {
    this.provider = adapter;
  }

  /**
   * Phase 16b.4: drop the cached system prompt so the next `runConversation`
   * rebuilds it. Used by `/personality` when the active overlay changes —
   * SOUL.md (slot 1) is identical, but slot 2 needs to swap. Also useful
   * after editing SOUL.md from outside the REPL.
   */
  invalidateSystemPromptCache(): void {
    this.cachedSystemPrompt = null;
  }

  /**
   * Phase 16b.4: replace the personality overlay used in slot 2 of the next
   * built prompt. Mutates `promptBuilderOptions` in place so the next
   * `runConversation` rebuild picks up the new body. Returns whether the
   * overlay actually changed (callers can skip cache invalidation when the
   * value is identical).
   */
  setPersonalityOverlay(overlay: string | undefined): boolean {
    if (!this.promptBuilderOptions) return false;
    const prev = this.promptBuilderOptions.personalityOverlay ?? '';
    const next = overlay ?? '';
    if (prev === next) return false;
    this.promptBuilderOptions.personalityOverlay = next;
    this.cachedSystemPrompt = null;
    return true;
  }

  /**
   * Phase 16b.4: returns the cached system prompt, building it on demand if
   * `promptBuilder` is wired and the cache is empty. Read-only accessor used
   * by the `/debug-prompt` slash command — does NOT trigger an LLM call.
   * Returns `null` when no prompt builder is wired (Phase 12 callers).
   */
  async getSystemPromptForDebug(): Promise<string | null> {
    if (!this.promptBuilder || !this.promptBuilderOptions) return null;
    if (this.cachedSystemPrompt === null) {
      this.cachedSystemPrompt = await this.promptBuilder.build(
        this.promptBuilderOptions,
      );
    }
    return this.cachedSystemPrompt;
  }

  async runConversation(
    initialMessages: Message[],
    runOpts: RunConversationOptions = {},
  ): Promise<AidenAgentResult> {
    // ── Phase 13: Build (or reuse cached) system prompt at session start ──
    // ── Phase 16d: if a memory mutation happened since last turn, drop the
    //    cache and reload MEMORY.md / USER.md before rebuild. Pays one
    //    cache-miss per memory write; idle turns still hit the prefix cache.
    let messages: Message[] = [...initialMessages];
    if (this.promptBuilder && this.promptBuilderOptions) {
      if (this.memoryDirty !== null && this.refreshMemorySnapshot) {
        try {
          const fresh = await this.refreshMemorySnapshot();
          this.promptBuilderOptions.memorySnapshot = fresh;
          this.cachedSystemPrompt = null;
          const which = this.memoryDirty;
          this.memoryDirty = null;
          try {
            this.onMemoryRefresh?.(which);
          } catch {
            // diagnostic callback must not break the loop
          }
        } catch {
          // Refresh failed (disk error?) — fall through to existing cache
          // rather than crash the turn. Dirty bit stays set so we retry
          // next turn. This' "tool responses always show
          // live state" fallback: if disk read fails, the agent still has
          // the tool result message from the mutation in its history.
        }
      }
      if (this.cachedSystemPrompt === null) {
        this.cachedSystemPrompt = await this.promptBuilder.build(
          this.promptBuilderOptions,
        );
      }
      // Prepend only if no leading system message already covers it. Tests
      // and integrations may pass their own; we don't want to double-stuff.
      const hasSys = messages.length > 0 && messages[0].role === 'system';
      if (!hasSys) {
        messages = [
          { role: 'system', content: this.cachedSystemPrompt },
          ...messages,
        ];
      }
    }

    let turnCount = 0;
    let toolCallCount = 0;
    let fallbackActivated = false;
    let finishReason: 'stop' | 'budget_exhausted' | 'error' = 'stop';
    let finalContent = '';

    // Phase 23.1: per-user-turn enforcement state. Tracker is fresh per
    // call to runConversation; metrics object is shared with the agent
    // instance so /doctor sees cumulative counts.
    const enforcement = new SkillEnforcementTracker(this.skillEnforcementMetrics);
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    const toolCallTrace: HonestyTraceEntry[] = [];

    // ── Phase 12 layer 1: PlannerGuard (pre-loop tool subset) ────────
    // Phase 16f Task 5: reset PlannerGuard.activeToolsets before each
    // user-turn decide() so a skill_view from a prior turn doesn't keep
    // forcing browser/web tools into unrelated next turns. The agent owns
    // the per-turn lifecycle; the planner stays stateless across turns.
    // Skills needing persistent toolset activation should re-fire
    // skill_view per turn (the metadata is in the system prompt).
    let activeTools: ToolSchema[] = this.tools;
    if (this.plannerGuard) {
      this.plannerGuard.resetActivation();
      const lastUser = lastUserMessage(initialMessages);
      const decision = await this.plannerGuard.decide(
        lastUser,
        initialMessages,
      );
      this.onPlannerGuardDecision?.(decision);
      const allowed = new Set(decision.selectedTools);
      // Only narrow if the guard actually returned something useful and
      // we have schemas to filter against.
      if (allowed.size > 0 && this.tools.length > 0) {
        const narrowed = this.tools.filter((t) => allowed.has(t.name));
        // Defensive: never strip everything (preserves the "narrow only"
        // contract). If filter accidentally empties, keep full list.
        if (narrowed.length > 0) activeTools = narrowed;
      }
    }

    const cautionThreshold = Math.floor(this.maxTurns * CAUTION_FRACTION);
    const warningThreshold = Math.floor(this.maxTurns * WARNING_FRACTION);
    let cautionFired = false;
    let warningFired = false;

    while (turnCount < this.maxTurns) {
      turnCount += 1;

      if (!cautionFired && turnCount >= cautionThreshold) {
        cautionFired = true;
        this.onBudgetWarning?.('caution', turnCount, this.maxTurns);
      }
      if (!warningFired && turnCount >= warningThreshold) {
        warningFired = true;
        this.onBudgetWarning?.('warning', turnCount, this.maxTurns);
      }

      // ── Phase 13: ContextCompressor pre-call check ──────────────
      if (this.contextCompressor && this.providerId && this.modelId) {
        const trigger = this.contextCompressor.shouldCompress(
          messages,
          this.providerId,
          this.modelId,
        );
        if (trigger.shouldCompress) {
          const result = await this.contextCompressor.compress(
            messages,
            this.providerId,
            this.modelId,
          );
          if (!result.refused && !result.error) {
            messages = result.compressedMessages;
            this.compressionEvents += 1;
            this.onCompression?.(result);
          }
        }
      }

      // ── Phase 13: PromptCaching markers (Anthropic only) ─────────
      const dispatchMessages = this.promptCaching && this.providerId
        ? this.promptCaching.applyMarkers(messages, this.providerId)
        : messages;

      let output: ProviderCallOutput;
      try {
        const wantStream =
          runOpts.stream === true && typeof this.provider.callStream === 'function';
        if (wantStream) {
          output = await this.runStreamingTurn(
            dispatchMessages,
            activeTools,
            runOpts,
          );
        } else {
          output = await this.provider.call({
            messages: dispatchMessages,
            tools: activeTools,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!fallbackActivated && this.fallback) {
          const swapped = await this.fallback.activate(error, turnCount);
          if (swapped) {
            this.provider = swapped;
            fallbackActivated = true;
            // Re-attempt this turn with the new provider. Decrement turn so
            // the swap doesn't count against the budget —
            // _activate_fallback semantics.
            turnCount -= 1;
            continue;
          }
        }
        finishReason = 'error';
        throw error;
      }

      totalUsage.inputTokens += output.usage.inputTokens;
      totalUsage.outputTokens += output.usage.outputTokens;

      const hasToolCalls = output.toolCalls && output.toolCalls.length > 0;

      // Append the assistant turn to history. Even content-only assistant
      // messages are appended so the conversation record is complete.
      const assistantMessage: Message = {
        role: 'assistant',
        content: output.content ?? '',
        ...(hasToolCalls ? { toolCalls: output.toolCalls } : {}),
      };
      messages.push(assistantMessage);

      // Termination: model says stop AND emitted no tool calls.
      // (If finishReason is 'tool_use' but toolCalls is empty, treat as stop —
      // a known provider quirk; logging hook can be wired later.)
      if (!hasToolCalls) {
        // Phase 23.1: skill-required-tool enforcement. Before letting
        // the turn end, check whether a skill_view armed a required
        // sequence and whether every required tool actually fired.
        // On incomplete-with-retries-available, drop the assistant
        // message we just appended (so transcripts don't carry the
        // confabulated summary), inject a corrective system message,
        // and continue the loop. Mirrors Hermes's incomplete-retry
        // mechanism (run_agent.py:12966-13022) with a different trigger.
        const verdict = enforcement.evaluateOnFinal();
        if (verdict.kind === 'incomplete-can-retry') {
          messages.pop(); // discard the fabricated final message
          messages.push({
            role: 'system',
            content: enforcement.buildCorrectiveMessage(verdict.missing),
          });
          enforcement.incrementRetry();
          continue;
        }
        if (verdict.kind === 'incomplete-cap-exceeded') {
          const honestPrefix =
            `[skill-enforcement] failed: required tools missing for ` +
            `\`${verdict.skillName}\` after ${verdict.cap} retries: ` +
            `[${verdict.missing.join(', ')}].\n\n`;
          finalContent = honestPrefix + (output.content ?? '');
          // Replace the trailing assistant message with the honest
          // version so transcripts and downstream callers see the
          // truthful summary, not the confabulated one.
          const lastIdx = messages.length - 1;
          if (
            lastIdx >= 0 &&
            messages[lastIdx].role === 'assistant'
          ) {
            messages[lastIdx] = { role: 'assistant', content: finalContent };
          }
          finishReason = 'stop';
          return await this.finalize({
            finalContent,
            messages,
            turnCount,
            toolCallCount,
            fallbackActivated,
            finishReason,
            totalUsage,
            toolCallTrace,
            aborted: false,
          });
        }
        finalContent = output.content ?? '';
        finishReason = 'stop';
        return await this.finalize({
          finalContent,
          messages,
          turnCount,
          toolCallCount,
          fallbackActivated,
          finishReason,
          totalUsage,
          toolCallTrace,
          aborted: false,
        });
      }

      // Dispatch tool calls sequentially. Parallel execution
      // is deferred to v4.1.
      const toolMessages: Message[] = [];
      for (const call of output.toolCalls) {
        toolCallCount += 1;
        this.onToolCall?.(call, 'before');

        let result: ToolCallResult;
        try {
          result = await this.toolExecutor(call);
        } catch (err) {
          // Tool throws don't crash the loop. The model sees the error in
          // its context and decides what to do —.
          const message = err instanceof Error ? err.message : String(err);
          result = { id: call.id, name: call.name, result: null, error: message };
        }

        this.onToolCall?.(call, 'after', result);

        // Phase 23.1: tracker sees every dispatch (regardless of error).
        // A failed tool still counts as "called" — the model's job was
        // to fire the tool; surfacing the error back through tool-result
        // history is a separate concern.
        enforcement.recordToolCall(call.name);
        // If skill_view returned a payload with required_tools, arm the
        // tracker now so the message-final boundary check has data.
        const armable = extractSkillViewRequiredTools(call.name, result.result);
        if (armable) {
          enforcement.recordSkillView(armable.skillName, armable.requiredTools);
        }

        // Phase 12: append to trace BEFORE tool message goes onto history.
        toolCallTrace.push({
          name: call.name,
          result: result.result,
          error: result.error,
          verified: this.resolveVerifiedFlag?.(result),
        });

        const toolContent = result.error
          ? `Error: ${result.error}`
          : typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);

        toolMessages.push({
          role: 'tool',
          toolCallId: call.id,
          content: toolContent,
        });
      }

      // ── Phase 13: Iteration budget injection ───────────────────
      // When ≤30% of budget remains, append a pressure note to the
      // last tool result so the LLM literally sees it on its next turn.
      if (this.iterationBudgetInjection && toolMessages.length > 0) {
        const remaining = this.maxTurns - turnCount;
        const remainingFraction = remaining / this.maxTurns;
        if (remainingFraction <= 0.3 && remaining >= 0) {
          const last = toolMessages[toolMessages.length - 1];
          const note =
            `\n\n[iteration budget: ${remaining} of ${this.maxTurns} turns remaining — wrap up soon]`;
          toolMessages[toolMessages.length - 1] = {
            ...last,
            content: last.content + note,
          };
        }
      }

      messages.push(...toolMessages);
    }

    // Budget exhausted — return partial result. The last assistant message
    // (if any) becomes the final content; otherwise empty string.
    finishReason = 'budget_exhausted';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.content) {
        finalContent = msg.content;
        break;
      }
    }
    return await this.finalize({
      finalContent,
      messages,
      turnCount,
      toolCallCount,
      fallbackActivated,
      finishReason,
      totalUsage,
      toolCallTrace,
      aborted: true,
    });
  }

  /**
   * Phase 16c: drive the active provider's `callStream` and surface
   * deltas through `runOpts` callbacks. Returns the assembled
   * `ProviderCallOutput` from the `done` event so the rest of
   * `runConversation` is unchanged.
   *
   * Mirrors Hermes's "buffer text + suppress on tool_call" semantics
   * (run_agent.py:6849-6873). Display layer is responsible for
   * rendering deltas in real time and switching modes when a
   * `tool_call` event fires; this method just relays.
   */
  private async runStreamingTurn(
    messages: Message[],
    tools: ToolSchema[],
    runOpts: RunConversationOptions,
  ): Promise<ProviderCallOutput> {
    const stream = this.provider.callStream!({ messages, tools, stream: true });
    let firstDeltaFired = false;
    let finalOutput: ProviderCallOutput | null = null;
    for await (const evt of stream as AsyncIterable<StreamEvent>) {
      if (evt.type === 'delta') {
        if (!firstDeltaFired) {
          firstDeltaFired = true;
          try {
            runOpts.onFirstDelta?.();
          } catch {
            // Display callbacks must never break the loop.
          }
        }
        try {
          runOpts.onDelta?.(evt.content);
        } catch {
          // Same as above — swallow callback errors.
        }
      } else if (evt.type === 'tool_call') {
        if (!firstDeltaFired) {
          firstDeltaFired = true;
          try {
            runOpts.onFirstDelta?.();
          } catch {
            // ignore
          }
        }
        try {
          runOpts.onToolCallStart?.(evt.toolCall);
        } catch {
          // ignore
        }
      } else if (evt.type === 'done') {
        finalOutput = evt.output;
      }
    }
    if (!finalOutput) {
      throw new Error(
        `Provider ${this.provider.apiMode} stream ended without a 'done' event`,
      );
    }
    return finalOutput;
  }

  /**
   * Phase 12: post-loop pass — runs HonestyEnforcement against the trace,
   * runs SkillTeacher observation, and assembles the final result.
   *
   * The two layers compose without coupling: Honesty runs first because it
   * may rewrite `finalContent` (which SkillTeacher does NOT inspect — it
   * only looks at the trace + user messages). Layer order matters and is
   * intentional.
   */
  private async finalize(args: {
    finalContent: string;
    messages: Message[];
    turnCount: number;
    toolCallCount: number;
    fallbackActivated: boolean;
    finishReason: 'stop' | 'budget_exhausted' | 'error';
    totalUsage: { inputTokens: number; outputTokens: number };
    toolCallTrace: HonestyTraceEntry[];
    aborted: boolean;
  }): Promise<AidenAgentResult> {
    let finalContent = args.finalContent;
    let honestyFindings: HonestyFinding[] | undefined;
    let skillCreated: string | undefined;

    // ── Phase 12 layer 2: HonestyEnforcement ──────────────────────
    if (this.honestyEnforcement && finalContent) {
      const honesty = await this.honestyEnforcement.check(
        finalContent,
        args.messages,
        args.toolCallTrace,
      );
      if (!honesty.passed) {
        if (honesty.correctedResponse) {
          finalContent = honesty.correctedResponse;
        }
        honestyFindings = honesty.findings;
      }
    }

    // ── Phase 12 layer 3: SkillTeacher observation ────────────────
    if (this.skillTeacher) {
      const teacherTrace: SkillTeacherTraceEntry[] = args.toolCallTrace.map(
        (t) => ({
          name: t.name,
          args: {},
          result: t.result,
          error: t.error,
          toolset: this.resolveToolset?.(t.name),
        }),
      );
      const proposal = await this.skillTeacher.observeTurn(
        args.messages,
        teacherTrace,
        args.aborted,
      );
      if (proposal) {
        const decision = await this.skillTeacher.handleProposal(
          proposal,
          this.skillTeacherCallbacks ?? {},
        );
        if (decision.created && decision.skillName) {
          skillCreated = decision.skillName;
        }
      }
    }

    return {
      finalContent,
      messages: args.messages,
      turnCount: args.turnCount,
      toolCallCount: args.toolCallCount,
      fallbackActivated: args.fallbackActivated,
      finishReason: args.finishReason,
      totalUsage: args.totalUsage,
      toolCallTrace: args.toolCallTrace,
      compressionEvents: this.compressionEvents,
      auxiliaryUsage: this.auxiliaryClient?.getUsage() ?? {},
      skillEnforcement: { ...this.skillEnforcementMetrics },
      ...(honestyFindings ? { honestyFindings } : {}),
      ...(skillCreated ? { skillCreated } : {}),
    };
  }

  /**
   * Phase 23.1: read-only snapshot of cumulative skill-enforcement
   * counters since this agent instance was constructed. /doctor reads
   * this; tests do too. Returns a copy so callers can't mutate the
   * internal counters.
   */
  getSkillEnforcementMetrics(): SkillEnforcementMetrics {
    return { ...this.skillEnforcementMetrics };
  }
}

function lastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user') return m.content;
  }
  return '';
}
