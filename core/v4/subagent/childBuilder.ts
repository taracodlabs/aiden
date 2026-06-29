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
import { HonestyEnforcement } from '../../../moat/honestyEnforcement';
import { AidenAgent } from '../aidenAgent';
import type { AidenAgentOptions, ToolExecutor } from '../aidenAgent';
import type { ToolRegistry, ToolContext } from '../toolRegistry';
import type { ProviderAdapter, Message, ToolSchema, ToolCallRequest, ToolCallResult } from '../../../providers/v4/types';
import { FallbackAdapter } from '../providerFallback';
import type { RunStore } from '../daemon/runStore';
// v4.10 Slice 10.2b — shared event taxonomy.
import { categorizeEvent } from '../daemon/eventCategories';
import type { Logger } from '../logger/logger';

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
  /** v4.8.0 — resolves uiOnly flag for the dispatch-loop bypass. */
  resolveUiOnly?:       AidenAgentOptions['resolveUiOnly'];
  /**
   * v4.6 Phase 1 observability — when supplied, the child agent's
   * `onToolCall` is wired to emit `tool_call_started` /
   * `tool_call_completed` events to this run store under the
   * `childRunId` row (next field). Optional so pure unit tests of
   * `buildChildAgent` can construct without persistence wiring.
   */
  runStore?:    RunStore;
  /** Pre-created child run row id, used as the run_events key. */
  childRunId?:  number;
  /** Optional logger; emits per-tool-call info lines when present. */
  logger?:      Logger;
  /**
   * v4.11 toolset grouping — the parent agent's resolved profile
   * toolset list. When supplied, the child inherits the SAME profile
   * narrowing the parent uses (then applies the blocklist + any
   * `requestedToolsets` intersection on top). Mirrors the audit
   * invariant "subagent children inherit parent profile + blocklist".
   *
   * Shape:
   *   - `undefined`         — child inherits every toolset the
   *                           registry knows (pre-v4.11 behaviour;
   *                           used when parent's profile is `full`
   *                           or when childBuilder is called without
   *                           profile context, e.g. unit tests).
   *   - `readonly string[]` — child's base toolset list is exactly
   *                           this set (a parent on `minimal` only
   *                           ever spawns children seeing the
   *                           minimal toolsets).
   *
   * The existing `requestedToolsets` filter still runs on top —
   * `chosenToolsets = parentResolved ∩ requestedToolsets`, with the
   * zero-tools fallback recovering to `parentResolved` (NOT to the
   * full registry surface, which would silently widen the catalog
   * past the parent's profile).
   */
  parentProfileToolsets?: readonly string[];
  /**
   * v4.11 — toolsets to strip from the child catalog regardless of the
   * include set above. Set to `['ui']` by the REPL when the parent runs
   * a known-weak model (core/v4/modelCapability.ts:isWeakModel) so the
   * child — which shares the parent's display — can't leak ui_* markup.
   * Applied uniformly even when `parentProfileToolsets` is undefined
   * (the `full` profile), via getSchemas' excludeToolsets param.
   */
  parentExcludeToolsets?: readonly string[];
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
  /**
   * v4.6 Phase 2P — optional per-spawn provider override. When set,
   * `buildChildAgent` resolves the named providerId against the
   * parent's `FallbackAdapter.getProviderIds()` pool and clones with
   * a slot subset. Unknown names throw `ProviderNotFoundError` which
   * the caller (`spawnSubAgent`) converts to a failed envelope.
   */
  providerOverride?: string;
}

/**
 * v4.6 Phase 2P — error thrown by `buildChildAgent` when
 * `input.providerOverride` doesn't match any provider in the
 * parent's pool. Caught by `spawnSubAgent` and converted to a
 * `status: 'failed', exitReason: 'provider_not_found'` envelope
 * with the failing name + the list of valid alternatives.
 */
export class ProviderNotFoundError extends Error {
  readonly requested: string;
  readonly available: string[];
  constructor(requested: string, available: string[], hint?: string) {
    const base = `spawn_sub_agent: provider "${requested}" not in parent's pool.`;
    const list = available.length > 0
      ? ` Available: ${available.join(', ')}.`
      : ' Parent has no FallbackAdapter pool (single-provider configuration).';
    super(`${base}${list}${hint ? ' ' + hint : ' Omit the provider field to inherit the parent\'s provider.'}`);
    this.name = 'ProviderNotFoundError';
    this.requested = requested;
    this.available = available;
  }
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
  //
  // v4.11 toolset grouping — when `deps.parentProfileToolsets` is
  // provided, the "parent's known set" is that profile's resolved
  // toolsets (NOT every toolset in the registry). This is what makes
  // children inherit the parent's profile narrowing — a `minimal`
  // parent spawns children that also only see `minimal` toolsets.
  // When the field is omitted (legacy callers, unit tests, the
  // `full` profile case), the original "every toolset the registry
  // knows" semantics apply unchanged.
  const allHandlers = deps.toolRegistry.list();
  const registryToolsetNames = new Set<string>();
  for (const name of allHandlers) {
    const handler = deps.toolRegistry.get(name);
    if (handler?.toolset) registryToolsetNames.add(handler.toolset);
  }
  const parentToolsetNames: Set<string> = deps.parentProfileToolsets
    ? new Set<string>(
        // Defensive: filter to toolsets that actually exist in the
        // registry. A typo in `agent.tool_profile_toolsets` shouldn't
        // crash spawn; it just means the child gets a smaller set.
        deps.parentProfileToolsets.filter((t) => registryToolsetNames.has(t)),
      )
    : registryToolsetNames;
  let chosenToolsets: string[] = input.requestedToolsets && input.requestedToolsets.length > 0
    ? input.requestedToolsets.filter((t) => parentToolsetNames.has(t))
    : [...parentToolsetNames];

  // v4.6 Phase 1 (Dispatch 2L) — zero-tools-bug fallback. When the
  // model passes `toolsets: [...]` with values that DON'T match any
  // real registry toolset (e.g. `["functions"]`, a name fabricated
  // from the OpenAI tool-use vocabulary, or `["file_operations"]`, a
  // skill name confused for a toolset), the strict filter strips all
  // entries → `chosenToolsets` is `[]` → child gets ZERO tools → it
  // hallucinates an answer rather than admit it can't do the work.
  //
  // Recover by inheriting the parent's set (profile-narrowed when
  // v4.11 grouping is wired, full-registry otherwise) — NEVER widen
  // past the parent's profile. Logs a warning so the operator sees
  // what the model asked for and what real names exist. Partial
  // intersections (some valid, some invalid) keep the valid subset
  // — that's the user's explicit narrowing intent, not a bug.
  if (
    input.requestedToolsets && input.requestedToolsets.length > 0 &&
    chosenToolsets.length === 0
  ) {
    deps.logger?.warn?.(
      'spawn_sub_agent: requested toolsets stripped to empty, falling back to full parent set',
      {
        requested:           input.requestedToolsets,
        validParentToolsets: [...parentToolsetNames],
      },
    );
    chosenToolsets = [...parentToolsetNames];
  }

  // Step 4b — pull the schemas for those toolsets.
  // v4.6 Phase 1 — pass 'repl' context: in Phase 1 spawn_sub_agent
  // is REPL-only (Q6), so children always spawn from a REPL parent.
  // Phase 3+ may extend the child builder to receive the parent's
  // context dynamically; for now, 'repl' is the only path.
  const candidateSchemas: ToolSchema[] = chosenToolsets.length > 0
    ? deps.toolRegistry.getSchemas(
        chosenToolsets,
        'repl',
        // v4.11 — parent-based weak-model strip (e.g. ['ui']).
        deps.parentExcludeToolsets ? [...deps.parentExcludeToolsets] : undefined,
      )
    : [];  // No matching toolsets means an empty child toolset.

  // Step 4c — strip the hard blocklist (with v4.6 Phase 2P legacy
  // env-flag escape hatch per design doc §12.4). Default: full
  // 5-name blocklist. When AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1 is
  // set in the environment, `execute_code` is removed from the
  // blocklist for THIS spawn — backward-compat preservation of any
  // user's existing v4.1.0 .env workflow. The other 4 names
  // (spawn_sub_agent, clarify, memory, send_message) remain
  // blocked regardless of the flag.
  const blocked = resolveBlocklist(deps.logger);
  const childTools: ToolSchema[] = candidateSchemas.filter(
    (t) => !blocked.has(t.name),
  );

  // ── 5. Provider: clone FallbackAdapter rate-limit state if supported ─────
  // Per Q11 (verbatim mirror of providerFallback.ts:578 clone pattern).
  // Best-effort — if the adapter doesn't expose `clone()`, fall back to
  // sharing the parent's adapter. Phase 1 accepts that fallback case
  // means a child's 429 affects the parent's quota tracking; that's
  // explicit in the design-doc §5 row.
  //
  // v4.6 Phase 2P — when `input.providerOverride` is supplied, resolve
  // it against the parent's FallbackAdapter slot pool. Fail-loud on
  // unknown names (`ProviderNotFoundError`) so fanout's diversity
  // invariant is preserved (silent fallback would collapse the
  // rotation). Single-provider parents (non-FallbackAdapter) reject
  // any override, since there's no pool to select from.
  const childProvider = resolveChildProvider(deps.parentProvider, input.providerOverride);

  // ── 6. Observability — onToolCall → run_events + log ─────────────────────
  // When deps.runStore + deps.childRunId are present (the production
  // path from spawnSubAgent.ts), wire an `onToolCall` callback that
  // mirrors the daemon dispatcher's audit shape (see
  // `core/v4/daemon/dispatcher/realAgentRunner.ts:367-382`). Per-call
  // start time is tracked in a Map keyed by tool_call_id so the
  // `durationMs` on completed events is per-tool, not per-turn.
  // Pure no-op when runStore is absent (unit tests of buildChildAgent).
  const onToolCall = buildOnToolCall(deps);

  // ── 7. Build the child agent ─────────────────────────────────────────────
  // Focused worker config: omit plannerGuard, skillTeacher, skillMiner,
  // contextCompressor, promptCaching, promptBuilder. Match the daemon
  // agent's "act on the task, don't self-improve" shape.
  //
  // v4.7.0: HonestyEnforcement is now structural (reads tool trace only,
  // no natural-language scanning) and cheap enough to run in subagents.
  // Mode is 'detect' here — events are captured into the child's run
  // record but never produce user-visible output (subagents have no
  // chat surface; the parent assembles their summary).
  const childHonestyEnforcement = new HonestyEnforcement('detect');
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
    resolveUiOnly:       deps.resolveUiOnly,
    honestyEnforcement:  childHonestyEnforcement,
    onToolCall,
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
 * v4.6 Phase 2P — resolve the child's provider adapter.
 *
 * No override (Phase 1 behavior unchanged):
 *   - FallbackAdapter → clone with fresh mutable state, all slots.
 *   - Any other adapter shape with `clone()` → clone.
 *   - Adapter without `clone()` → reuse the parent's instance.
 *
 * Override supplied (Phase 2P):
 *   - Parent must be FallbackAdapter (only adapter type with a
 *     multi-provider pool). Otherwise throw `ProviderNotFoundError`.
 *   - Override must match one of `parent.getProviderIds()`. Otherwise
 *     throw `ProviderNotFoundError` listing the available pool.
 *   - On match: clone with slot-subset filter restricted to that
 *     provider's slots. Child rotates only within the chosen
 *     provider's slots; the diversity invariant fanout depends on
 *     is preserved.
 */
function resolveChildProvider(
  parent:   ProviderAdapter,
  override: string | undefined,
): ProviderAdapter {
  if (!override) {
    // ── No override path — Phase 1 clone semantics, unchanged. ────────
    const maybeClone = (parent as unknown as { clone?: () => ProviderAdapter }).clone;
    if (typeof maybeClone === 'function') {
      try { return maybeClone.call(parent); }
      catch { return parent; }
    }
    return parent;
  }
  // ── Override path — must be FallbackAdapter. ───────────────────────
  if (!(parent instanceof FallbackAdapter)) {
    throw new ProviderNotFoundError(
      override,
      [],
      'Parent agent uses a single-provider adapter; provider override is only available when parent is configured with FallbackAdapter (multi-provider pool).',
    );
  }
  const available = parent.getProviderIds();
  if (!available.includes(override)) {
    throw new ProviderNotFoundError(override, available);
  }
  return parent.clone({ providerId: override });
}

/**
 * v4.6 Phase 2P — resolve the effective tool blocklist for THIS
 * child build. Default is the full 5-name set
 * (`SUBAGENT_BLOCKED_TOOL_NAMES`). When
 * `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1` (or any truthy value) is
 * present in `process.env`, drop `execute_code` — preserves the
 * v4.1.0 fanout escape hatch for users with that flag in `.env`.
 * Other 4 names stay blocked regardless.
 *
 * Logs a one-line warning when the escape hatch is active so the
 * relaxation is visible in observability — silently relaxing a
 * security boundary is exactly the failure mode we want to avoid.
 */
function resolveBlocklist(logger?: Logger): ReadonlySet<string> {
  const raw = process.env.AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE;
  if (!raw) return SUBAGENT_BLOCKED_TOOL_NAMES;
  const flag = String(raw).trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes') {
    logger?.warn?.(
      'spawn_sub_agent: AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE escape hatch active; ' +
      'execute_code dropped from child blocklist (other 4 names still blocked)',
      { source: 'env', flag: raw },
    );
    const relaxed = new Set(SUBAGENT_BLOCKED_TOOL_NAMES);
    relaxed.delete('execute_code');
    return relaxed;
  }
  return SUBAGENT_BLOCKED_TOOL_NAMES;
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

/**
 * v4.6 Phase 1 — build the child agent's `onToolCall` callback. Emits
 * `tool_call_started` + `tool_call_completed` events to the child's
 * `runs` row via the supplied runStore, mirroring the daemon
 * dispatcher's audit shape. Also logs each call at info level so
 * users tailing aiden.log see what the child actually did.
 *
 * Returns `undefined` when persistence + logger are both absent —
 * the agent constructor accepts `undefined` for `onToolCall` and
 * dispatches without notifying.
 */
function buildOnToolCall(deps: ChildBuilderDeps):
  | ((call: ToolCallRequest, phase: 'before' | 'after', result?: ToolCallResult) => void)
  | undefined
{
  const { runStore, childRunId, logger } = deps;
  if (!runStore && !logger && childRunId === undefined) return undefined;

  // Per-call start time keyed by tool_call_id so `durationMs` on the
  // completed event reflects per-tool wall-clock, not per-turn.
  const callStarts = new Map<string, number>();

  return (call, phase, result) => {
    try {
      if (phase === 'before') {
        const startedAt = Date.now();
        callStarts.set(call.id, startedAt);
        const argsSummary = safeShortJson(call.arguments, 200);
        if (runStore && childRunId !== undefined) {
          // v4.10 Slice 10.2b — rich emission. Source='subagent' so
          // trace_query can filter to child-only events; toolCallId
          // links the started/completed pair.
          const tags = categorizeEvent('tool_call_started');
          runStore.emitEventRich({
            runId:      childRunId,
            category:   tags.category,
            kind:       tags.kind,
            name:       'tool_call_started',
            toolCallId: call.id ?? null,
            status:     'started',
            summary:    call.name,
            payload: {
              toolName: call.name,
              args:     argsSummary,
              ts:       startedAt,
            },
            visibility: 'system',
            source:     'subagent',
          });
        }
        if (logger) {
          logger.info('sub-agent tool call', {
            childRunId: childRunId ?? null,
            toolName:   call.name,
            args:       argsSummary,
          });
        }
        return;
      }
      // phase === 'after'
      const startedAt = callStarts.get(call.id) ?? Date.now();
      callStarts.delete(call.id);
      const durationMs = Date.now() - startedAt;
      if (runStore && childRunId !== undefined) {
        const tags = categorizeEvent('tool_call_completed');
        runStore.emitEventRich({
          runId:      childRunId,
          category:   tags.category,
          kind:       tags.kind,
          name:       'tool_call_completed',
          toolCallId: call.id ?? null,
          status:     result?.error ? 'failed' : 'ok',
          durationMs,
          summary:    `${call.name}${result?.error ? ' (failed)' : ''}`,
          payload: {
            toolName:  call.name,
            error:     result?.error ?? null,
            hasResult: result?.result !== undefined && result?.result !== null,
            durationMs,
          },
          visibility: 'system',
          source:     'subagent',
        });
      }
      if (logger) {
        logger.info('sub-agent tool result', {
          childRunId: childRunId ?? null,
          toolName:   call.name,
          ok:         !result?.error,
          durationMs,
        });
      }
    } catch {
      // Observability must never crash the agent loop.
    }
  };
}

/** JSON-stringify with a byte cap; returns the truncated string with an
 *  ellipsis when the payload exceeds `maxBytes`. */
function safeShortJson(value: unknown, maxBytes: number): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return '';
    return s.length > maxBytes ? s.slice(0, maxBytes) + '…' : s;
  } catch {
    return String(value).slice(0, maxBytes);
  }
}
