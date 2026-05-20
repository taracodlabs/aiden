/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/daemonAgentBuilder.ts — v4.5 Phase 7b.
 *
 * Builds the `AgentBuilder` closure the daemon dispatcher uses to
 * construct a fresh AidenAgent per claimed trigger event. Captures
 * the REPL's already-initialized provider resolver, tool registry,
 * auxiliary client, prompt builder, and memory manager — REPL and
 * daemon turns share these instances per Q-P7b-2(a). State that
 * MUST stay isolated (memoryDirty Set, cachedSystemPrompt) lives
 * on AidenAgent instances, and the closure creates a fresh agent
 * every time the dispatcher invokes it.
 *
 * Scope cuts deliberately deferred (per Phase 7b audit greenlight):
 *   - plannerGuard / honestyEnforcement / skillTeacher / skillMiner
 *     are NOT wired into daemon-mode agents. They add ~3 LLM calls
 *     per turn and the daemon's job is "act on the trigger," not
 *     "improve the agent." Opt-in per-trigger lands in v4.6 if
 *     real-world use surfaces a need.
 *   - REPL-only spinner hooks (onMemoryRefreshStart/onPromptBuilt/
 *     onProviderRequestStart) are omitted; daemon has no display
 *     surface.
 *   - skillTeacherCallbacks.promptUser is omitted; daemon has no
 *     operator to ask.
 *
 * Strategy B (closure capture) — chosen over Strategy A (full
 * factory refactor) to keep the REPL's existing agent construction
 * untouched. The risk of regression in the REPL path is minimised
 * because we don't rewrite ANY of the REPL's setup — the daemon
 * closure just constructs a SECOND lightweight agent on demand
 * from the same building blocks.
 */

import type { AgentBuilder } from '../../core/v4/daemon/dispatcher';
import { AidenAgent } from '../../core/v4/aidenAgent';
import type { AidenAgentOptions, ToolExecutor } from '../../core/v4/aidenAgent';
import type { ToolRegistry } from '../../core/v4/toolRegistry';
import type { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import type { ProviderAdapter } from '../../providers/v4/types';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type { PromptBuilder, PromptBuilderOptions } from '../../core/v4/promptBuilder';
import type { MemoryManager } from '../../core/v4/memoryManager';
import { ApprovalEngine } from '../../moat/approvalEngine';
import { HonestyEnforcement, type HonestyMode } from '../../moat/honestyEnforcement';
import type { AidenPaths } from '../../core/v4/paths';

// ── Public types ───────────────────────────────────────────────────────────

export interface BuildDaemonAgentBuilderInput {
  paths:                AidenPaths;
  /** Shared provider resolver — daemon hits the same rate-limit pool as REPL. */
  resolver:             RuntimeResolver;
  /** Fallback adapter to use when daemon-resolved model resolution fails. */
  fallbackAdapter:      ProviderAdapter;
  toolRegistry:         ToolRegistry;
  toolExecutor:         ToolExecutor;
  auxiliaryClient:      AuxiliaryClient;
  promptBuilder:        PromptBuilder;
  /** Snapshot the REPL built; daemon-side overrides only providerId/modelId. */
  promptBuilderOptions: PromptBuilderOptions;
  memoryManager:        MemoryManager;
  resolveVerifiedFlag:  AidenAgentOptions['resolveVerifiedFlag'];
  resolveToolset:       AidenAgentOptions['resolveToolset'];
  resolveMutates:       AidenAgentOptions['resolveMutates'];
  /** v4.8.0 — resolves uiOnly flag for the dispatch-loop bypass. */
  resolveUiOnly?:       AidenAgentOptions['resolveUiOnly'];
  /**
   * v4.7.0 Phase 2.4 — honesty-mode plumbed in from the REPL's config
   * resolution at boot, so daemon turns honour the same setting the
   * user picked for interactive sessions. Defaults to 'enforce' if the
   * caller omits.
   */
  honestyMode?:         HonestyMode;
  /** Max turns ceiling (mirrors REPL cap). */
  maxTurns?:            number;
  /** Log sink for the per-turn stdout audit line (Q-P7b-4b). */
  log?:                 (msg: string) => void;
}

// ── Implementation ─────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 90;

/**
 * Returns the AgentBuilder the daemon dispatcher consumes. The
 * returned closure is invoked once per trigger event the
 * dispatcher claims; each call constructs a fresh AidenAgent with
 * daemon-flavored options.
 */
export function buildDaemonAgentBuilder(
  deps: BuildDaemonAgentBuilderInput,
): AgentBuilder {
  const log = deps.log ?? ((msg) => process.stderr.write(msg + '\n'));
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;

  return async (input) => {
    const turnStartMs = Date.now();

    // Resolve a provider adapter for the chosen (provider, model)
    // pair. The resolver's resolve() returns an adapter wrapper;
    // the underlying connection pool is shared per Q-P7b-2(a).
    // If resolution fails (model not configured, OAuth expired),
    // fall back to the REPL's existing adapter so the daemon turn
    // still runs against SOMETHING usable.
    let adapter: ProviderAdapter;
    try {
      adapter = await deps.resolver.resolve({
        providerId: input.resolvedModel.provider,
        modelId:    input.resolvedModel.model,
        paths:      deps.paths,
      });
    } catch {
      adapter = deps.fallbackAdapter;
    }

    // Approval engine — fresh per turn so the session-scoped
    // allowlist doesn't bleed across daemon turns.
    const approvalEngine = new ApprovalEngine('smart');
    approvalEngine['callbacks'] = input.approvalCallbacks;

    // Per-turn promptBuilderOptions — same snapshot the REPL uses,
    // only the providerId/modelId fields overridden to reflect the
    // daemon's resolved model. The MemoryManager is shared (read-
    // only access via loadSnapshot()), so memory-dirty propagation
    // is the REPL agent's concern; daemon agent reads a fresh
    // snapshot on each `runConversation` call and discards.
    const pbOpts: PromptBuilderOptions = {
      ...deps.promptBuilderOptions,
      providerId: input.resolvedModel.provider,
      modelId:    input.resolvedModel.model,
    };

    const agent = new AidenAgent({
      provider:             adapter,
      // v4.6 Phase 1 — 'daemon' context filter excludes REPL-only
      // tools (`spawn_sub_agent` per Q6). Tools without an explicit
      // `contexts` field stay visible to both REPL and daemon.
      tools:                deps.toolRegistry.getSchemas(undefined, 'daemon'),
      toolExecutor:         deps.toolExecutor,
      maxTurns,
      auxiliaryClient:      deps.auxiliaryClient,
      // v4.5 Phase 7 — explicit sessionId option threads per-trigger
      // keying through to v4.4 docker session reuse + v4.3 browser
      // observer + v4.2 TurnState.
      sessionId:            input.sessionId,
      // Daemon mode wires the dispatcher's run_events hooks here.
      // No display-side onToolCall wrapping — the dispatcher's
      // emission is the only consumer.
      onToolCall:           input.hooks.onToolCall,
      onBudgetWarning:      input.hooks.onBudgetWarning,
      promptBuilder:        deps.promptBuilder,
      promptBuilderOptions: pbOpts,
      providerId:           input.resolvedModel.provider,
      modelId:              input.resolvedModel.model,
      resolveVerifiedFlag:  deps.resolveVerifiedFlag,
      resolveToolset:       deps.resolveToolset,
      resolveMutates:       deps.resolveMutates,
      resolveUiOnly:        deps.resolveUiOnly,
      // Memory snapshot refresh — daemon agent doesn't track dirty
      // bits because each instance is short-lived; we provide the
      // refresh callback so honestyEnforcement (and any future
      // consumer that needs a current memory snapshot) can rebuild.
      refreshMemorySnapshot: () => deps.memoryManager.loadSnapshot(),
      // v4.7.0 Phase 2.4 — HonestyEnforcement is now structural
      // (reads tool trace only, no natural-language scanning) and
      // cheap enough to run on autonomous daemon turns. Mode mirrors
      // the REPL's config-resolved value (default 'enforce'); the
      // footer appended in enforce mode is captured by the daemon
      // dispatcher's run_events and surfaced in the channel reply.
      honestyEnforcement: new HonestyEnforcement(deps.honestyMode ?? 'enforce'),
      // Scope cuts (Phase 7b, still deferred): no plannerGuard, no
      // skillTeacher, no skillMiner. These add LLM calls + state
      // that don't fit the daemon's "fire and act" pattern.
    });

    // Q-P7b-4(b) — minimal per-turn stdout line for tail-friendly
    // operator debugging. Fires on builder exit; the dispatcher's
    // `dispatcher:completed` run_event carries the same data in
    // structured form for sqlite queries.
    //
    // We attach this as a post-construct log via the abort signal's
    // 'abort' event; if the runner aborts the turn (budget watcher
    // tripped), the line still surfaces. The dispatcher emits its
    // own log; the goal here is a one-liner the operator can grep.
    //
    // Note: the actual finishReason + duration is the dispatcher's
    // job to log after runConversation returns — we don't have
    // that info here in the builder closure. Phase 7b ships the
    // "starting turn" line; "completed turn" is handled inside
    // realAgentRunner.ts.
    // Q-P7b-4(b) stdout one-liner. sessionId follows
    // `trigger:<source>:<sourceKey>:<hash>` so operators can grep by
    // source. Per-turn duration + finishReason are logged separately
    // by the dispatcher's realAgentRunner.ts when the turn completes.
    log(`[daemon-turn] starting sessionId=${input.sessionId} model=${input.resolvedModel.provider}/${input.resolvedModel.model} policy=${input.approvalPolicy}`);
    void turnStartMs;     // kept for symmetry; the dispatcher computes its own duration

    return agent;
  };
}
