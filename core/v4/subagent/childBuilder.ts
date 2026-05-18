/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/childBuilder.ts — v4.6 Phase 1.
 *
 * Constructs the child `AidenAgent` for one `spawn_sub_agent` call.
 * Mirrors the closure-capture shape of `cli/v4/daemonAgentBuilder.ts`
 * — shared deps captured at REPL bootstrap, fresh per-spawn state
 * built inline.
 *
 * Per the design doc §5 state-isolation matrix:
 *   - Conversation history, system prompt, TCE, file-op cache:
 *     ISOLATED (child gets fresh).
 *   - Toolset: intersection of (parent's enabled toolsets) ∩
 *     (spec.toolsets or parent's full set) MINUS the hard blocklist.
 *   - Provider + model + credentials: INHERITED (same adapter).
 *   - FallbackAdapter rate-limit state: CLONED per child (when the
 *     adapter exposes `clone()`) so a child's 429 doesn't poison
 *     the parent's quota tracking.
 *   - ApprovalEngine: fresh instance with auto-deny callbacks
 *     (child cannot prompt the user).
 *   - plannerGuard / honestyEnforcement / skillTeacher / skillMiner:
 *     OMITTED (focused worker config, matching daemon agent shape).
 *   - Working directory / sandbox / runtimeToggles: shared via the
 *     process-level singletons read on each tool dispatch.
 */

import type { ApprovalCallbacks } from '../../../moat/approvalEngine';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { AidenAgent } from '../aidenAgent';
import type { AidenAgentOptions, ToolExecutor } from '../aidenAgent';
import type { ToolRegistry, ToolContext } from '../toolRegistry';
import type { ProviderAdapter, Message, ToolSchema } from '../../../providers/v4/types';

// ── Hard-coded blocklist (Q5 from design doc §2) ────────────────────────────

/**
 * Tools children must NEVER receive, even if the parent's enabled toolsets
 * cover them and the spec explicitly requests them. Filtered post-intersection.
 *
 * Each entry's rationale, in order:
 *   - `spawn_sub_agent` — no recursive spawning (depth cap = 1 in Phase 1)
 *   - `clarify`         — child cannot prompt the user
 *   - `memory`          — no writes to shared MEMORY.md / USER.md
 *   - `execute_code`    — children reason step-by-step, not write scripts
 *   - `send_message`    — no cross-platform side effects from a child
 */
export const SUBAGENT_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'spawn_sub_agent',
  'clarify',
  'memory',
  'execute_code',
  'send_message',
]);

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Shared deps the spawn-tool factory captures at REPL bootstrap. Same
 * lifetime as the parent agent's tool registry.
 */
export interface ChildBuilderDeps {
  /** Parent's tool registry — child reads the same registry but builds
   *  its own executor with a different `ToolContext`. */
  toolRegistry: ToolRegistry;
  /**
   * The parent's tool context, minus the approval engine (the child
   * gets a fresh one). Provided as a base — the child builder
   * destructures and overrides `approvalEngine` + `sessionId`.
   */
  parentToolContext: ToolContext;
  /** Parent's provider adapter. If it exposes `clone()`, the child gets
   *  a clone with fresh mutable rate-limit state per Q11. */
  parentProvider: ProviderAdapter;
  /** Inherited from parent — used by the agent's system-prompt and
   *  prompt-caching layers (we don't wire prompt-caching for the
   *  child, but `providerId` is required by AidenAgentOptions). */
  parentProviderId: string;
  parentModelId: string;
  /** Inherited helpers for the agent loop's tool gating + verification. */
  resolveVerifiedFlag?: AidenAgentOptions['resolveVerifiedFlag'];
  resolveToolset?:      AidenAgentOptions['resolveToolset'];
  resolveMutates?:      AidenAgentOptions['resolveMutates'];
}

/** One spawn's parameters, validated by the tool wrapper. */
export interface ChildBuildInput {
  /** Stable per-spawn UUID — used as `sessionId` and embedded in `task_id`. */
  sessionId: string;
  /** Required imperative goal for the child. */
  goal: string;
  /** Optional plain-text background. */
  context?: string;
  /** Requested toolsets (intersected with parent's). Omit → parent's full set. */
  requestedToolsets?: string[];
  /** Clamped to [1, 200] before this function is called. */
  maxIterations: number;
}

/** Output of the builder — the agent plus the prebuilt history the
 *  caller hands to `agent.runConversation(history, { signal })`. */
export interface ChildBuildOutput {
  agent: AidenAgent;
  history: Message[];
}

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Build the child agent + initial history. Pure factory — no side
 * effects beyond constructing in-memory objects. The caller is
 * responsible for running `agent.runConversation(...)` and writing
 * the `runs` row.
 */
export function buildChildAgent(
  deps: ChildBuilderDeps,
  input: ChildBuildInput,
): ChildBuildOutput {
  // ── 1. ApprovalEngine: fresh, auto-deny callbacks ────────────────────────
  // 'smart' mode: safe auto-allows, dangerous auto-denies, caution
  // calls promptUser which we wire to a synchronous deny — children
  // cannot interact with a TUI.
  const autoDenyCallbacks: ApprovalCallbacks = {
    promptUser: async () => 'deny',
  };
  const childApprovalEngine = new ApprovalEngine('smart', autoDenyCallbacks);

  // ── 2. ToolContext: parent's services + child approval engine + session ──
  const childToolContext: ToolContext = {
    ...deps.parentToolContext,
    sessionId:      input.sessionId,
    approvalEngine: childApprovalEngine,
  };

  // ── 3. Build the child's toolExecutor from the parent's registry ─────────
  // Same registry, different context. The registry stays read-only.
  const childToolExecutor: ToolExecutor = deps.toolRegistry.buildExecutor(childToolContext);

  // ── 4. Tool array: intersection + blocklist filter ───────────────────────
  // Step 4a — pick the parent's toolsets we care about.
  // If the spec named toolsets, intersect with the parent's known set.
  // Otherwise the child gets the parent's full enabled set (which on
  // REPL means every toolset the registry knows).
  const allHandlers = deps.toolRegistry.list();
  const parentToolsetNames = new Set<string>();
  for (const name of allHandlers) {
    const handler = deps.toolRegistry.get(name);
    if (handler?.toolset) parentToolsetNames.add(handler.toolset);
  }
  const chosenToolsets: string[] = input.requestedToolsets && input.requestedToolsets.length > 0
    ? input.requestedToolsets.filter((t) => parentToolsetNames.has(t))
    : [...parentToolsetNames];

  // Step 4b — pull the schemas for those toolsets.
  // v4.6 Phase 1 — pass 'repl' context: in Phase 1 spawn_sub_agent
  // is REPL-only (Q6), so children always spawn from a REPL parent.
  // Phase 3+ may extend the child builder to receive the parent's
  // context dynamically; for now, 'repl' is the only path.
  const candidateSchemas: ToolSchema[] = chosenToolsets.length > 0
    ? deps.toolRegistry.getSchemas(chosenToolsets, 'repl')
    : [];  // No matching toolsets means an empty child toolset.

  // Step 4c — strip the hard blocklist.
  const childTools: ToolSchema[] = candidateSchemas.filter(
    (t) => !SUBAGENT_BLOCKED_TOOL_NAMES.has(t.name),
  );

  // ── 5. Provider: clone FallbackAdapter rate-limit state if supported ─────
  // Per Q11 (verbatim mirror of providerFallback.ts:578 clone pattern).
  // Best-effort — if the adapter doesn't expose `clone()`, fall back to
  // sharing the parent's adapter. Phase 1 accepts that fallback case
  // means a child's 429 affects the parent's quota tracking; that's
  // explicit in the design-doc §5 row.
  const childProvider = adapterWithCloneOrSame(deps.parentProvider);

  // ── 6. Build the child agent ─────────────────────────────────────────────
  // Focused worker config: omit plannerGuard, honestyEnforcement,
  // skillTeacher, skillMiner, contextCompressor, promptCaching,
  // promptBuilder. Match the daemon agent's "act on the task, don't
  // self-improve" shape.
  const agent = new AidenAgent({
    provider:            childProvider,
    tools:               childTools,
    toolExecutor:        childToolExecutor,
    sessionId:           input.sessionId,
    maxTurns:            input.maxIterations,
    providerId:          deps.parentProviderId,
    modelId:             deps.parentModelId,
    resolveVerifiedFlag: deps.resolveVerifiedFlag,
    resolveToolset:      deps.resolveToolset,
    resolveMutates:      deps.resolveMutates,
    // iterationBudgetInjection inherits the default (true) — child
    // sees its own remaining-budget hint near the end of the run.
  });

  // ── 7. Initial history: fresh system prompt + the user-shaped goal ───────
  const systemContent = buildChildSystemPrompt(input.goal, input.context);
  const userContent = composeUserMessage(input.goal, input.context);
  const history: Message[] = [
    { role: 'system', content: systemContent },
    { role: 'user',   content: userContent },
  ];

  return { agent, history };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Best-effort clone for `FallbackAdapter`-shaped providers. If the
 * adapter exposes a `clone(): ProviderAdapter` method, call it.
 * Otherwise return the original adapter (shared mutable state).
 */
function adapterWithCloneOrSame(adapter: ProviderAdapter): ProviderAdapter {
  const maybeClone = (adapter as unknown as { clone?: () => ProviderAdapter }).clone;
  if (typeof maybeClone === 'function') {
    try {
      return maybeClone.call(adapter);
    } catch {
      // Defensive — a buggy clone should not break the spawn.
      return adapter;
    }
  }
  return adapter;
}

/**
 * Compose the child's system prompt. Intentionally minimal — no
 * SOUL.md, no parent identity, no MEMORY.md preamble. Goal-focused.
 */
function buildChildSystemPrompt(goal: string, context: string | undefined): string {
  const lines: string[] = [
    'You are a focused sub-agent dispatched to handle ONE concrete task.',
    'You have no memory of any prior conversation — only the goal and',
    'optional context below. You cannot ask the user follow-up questions',
    '(your `clarify` tool is disabled), you cannot spawn further sub-agents,',
    'and you cannot write to MEMORY.md.',
    '',
    'When the task is done, produce a single final assistant message',
    'summarising what you did and what you found. That summary is the',
    'ONLY output the parent agent will see — no tool traces, no',
    'intermediate reasoning. Make it self-contained, factual, and tight.',
    '',
    `## Goal`,
    goal.trim(),
  ];
  if (context && context.trim().length > 0) {
    lines.push('', '## Background context', context.trim());
  }
  return lines.join('\n');
}

/**
 * Compose the initial user message. Currently a stub repeat of the goal
 * — kept distinct from the system prompt so providers that prefer the
 * system role for instructions and the user role for the immediate
 * request both get a sensible payload. Context is included only in
 * the system prompt so the user message stays compact.
 */
function composeUserMessage(goal: string, _context: string | undefined): string {
  return goal.trim();
}
