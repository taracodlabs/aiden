/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/toolRegistry.ts — Aiden v4.0.0
 *
 * Central tool registry. The agent loop sees tools through two surfaces:
 *
 *   1. `getSchemas()` — array of `ToolSchema` advertised to the LLM.
 *   2. `buildExecutor()` — the `(call) => Promise<ToolCallResult>` function
 *      `AidenAgent` invokes when the model emits tool calls.
 *
 * Wrappers in `tools/v4/<toolset>/` register themselves here at boot via
 * `tools/v4/index.ts::registerReadOnlyTools()` (Phase 7) and
 * `registerWriteTools()` (Phase 8).
 *
 * The registry is intentionally dumb: no validation logic, no policy
 * enforcement, no scheduling. Those concerns live in `AidenAgent`,
 * Phase 9's approval engine, and individual tool wrappers.
 *
 * per-call dispatch. Aiden adds a typed `ToolHandler` shape and per-tool
 * risk metadata (`category`, `mutates`) so Phase 9 can gate tool calls
 * without scanning the wrapper bodies.
 *
 * Status: PHASE 8.
 */

import { resolve as resolvePath } from 'node:path';

import type {
  ToolSchema,
  ToolCallRequest,
  ToolCallResult,
  ToolActivityTiming,
  ToolActivityUpdate,
  ToolTerminalClassification,
  ToolApprovalDecision,
} from '../../providers/v4/types';
// v4.11 perf — wire the legacy v3 responseCache into the v4 hot path.
// Cache is keyed by (tool name, arguments hash); has its own per-tool
// TTL table + NO_CACHE_TOOLS deny list internally, so the v4 wire
// just adds the get/set bookend around handler.execute.
import { responseCache } from '../responseCache';
import type { AidenPaths } from './paths';
import type { SessionManager } from './sessionManager';
import type { MemoryManager } from './memoryManager';
import type { ProcessRegistry } from './processRegistry';
import type { ApprovalEngine, ApprovalRequest } from '../../moat/approvalEngine';
import {
  fileSnapshot,
  snapshotTargetsForTool,
  resourceIdForPath,
  type SnapshotSink,
} from './fsSnapshot';
import type { SnapshotObservation } from './temporalEvidence';
import type { SSRFProtection } from '../../moat/ssrfProtection';
import type { TirithScanner } from '../../moat/tirithScanner';
import type { MemoryGuard } from '../../moat/memoryGuard';
import { analyzeCommandIntent, isReadOnlyCommand } from '../../moat/dangerousPatterns';
import { classifyBrowserAction } from './browserState';
import { currentBrowserLeaseStore } from './browser/browserLeaseScope';
import { pwBrowserStatus, pwDialogPendingTier } from '../playwrightBridge';
import type { SkillLoader } from './skillLoader';
import type { BundledManifest } from './skillBundledManifest';
import {
  currentDurableToolCallId,
  currentJobExecutionContext,
  ensureRepositoryExecutionBinding,
  executeWithDurableToolCall,
  prepareDurableToolCall,
  recordDurableToolApproval,
  type PreparedDurableToolCall,
} from './daemon/jobExecutionContext';
import { DurableJobHostDetachedError } from './daemon/jobLifecycle';
import type { AutomationApprovalContinuationRuntime } from './automation/approvalContinuation';
import type { AutomationApprovalContinuationAuthority } from './automation/approvalContinuation';
import { DockerCancellationUnverifiedError } from './dockerSession';
import { describeToolEffect, type DurableEffectDescriptor } from './effectContract';
import {
  normalizeExecutionPlan,
  type ActionAuthority,
  type PolicySnapshotInput,
} from './actionAuthority';
import {
  fileChangePlanForTool,
  projectSafeChangeResult,
  type ChangeIntentRecord,
  type ChangeRecord,
  type FileChangePlan,
} from './codebase/safeChangeAuthority';
import {
  structuredValidationPlanForShell,
  type StructuredValidationRun,
  type ValidationEnvironment,
} from './codebase/structuredValidationAuthority';
import { getRawValidationOutput } from './codebase/validationOutput';
import {
  projectCommittedRepositoryChange,
  projectCompletedRepositoryValidation,
} from './codebase/runtimePlanProjection';
import { isWithin } from './sandboxFs';

/**
 * Risk profile for a tool. Used by the Phase 9 approval engine to decide
 * whether a call needs user confirmation. Read-only tools (`read`,
 * `network`, `browser` queries) just run; `write` and `execute` will be
 * gated in Phase 9.
 */
export type ToolCategory = 'read' | 'write' | 'execute' | 'network' | 'browser';

/**
 * v4.6 Phase 1 — execution context a tool is permitted in.
 *
 *   - 'repl'   — interactive CLI sessions and any agent constructed
 *                from a REPL parent (including v4.6 sub-agents whose
 *                parent is the REPL agent).
 *   - 'daemon' — agents constructed by `cli/v4/daemonAgentBuilder.ts`
 *                in response to trigger events (file/webhook/email/
 *                schedule). No interactive UI; runs autonomously.
 *
 * Tools self-declare via `ToolHandler.contexts`. When the field is
 * undefined, the tool is visible in BOTH contexts (the existing
 * pre-v4.6 behaviour — keeps backward compatibility for all tools
 * registered before this field existed).
 *
 * `getSchemas(filterToolsets, context)` filters by context when
 * provided. REPL agent passes `'repl'`; daemon agent passes
 * `'daemon'`. Tools whose `contexts` array does NOT include the
 * caller's context are excluded.
 */
export type ExecutionContext = 'repl' | 'daemon';

export interface ToolContext {
  /** Current working directory (for relative paths in file tools). */
  cwd: string;
  /** Optional immutable repository view for snapshot-aware read-only file tools. */
  repositoryInspection?: {
    snapshotId: string;
    rootPath: string;
    authority: import('./codebase/repositorySnapshotAuthority').RepositorySnapshotAuthority;
  };
  /** Optional source-fenced mutation authority for Codebase Mode file tools. */
  repositoryChange?: {
    baseSnapshotId: string;
    rootPath: string;
    authority: import('./codebase/safeChangeAuthority').SafeChangeAuthority;
  };
  /** Optional snapshot-bound test/build recording over the existing shell authority. */
  repositoryValidation?: {
    baseSnapshotId: string;
    rootPath: string;
    authority: import('./codebase/structuredValidationAuthority').StructuredValidationAuthority;
    environment?: ValidationEnvironment;
  };
  /** Aiden user-data paths. Sessions, memory, skills, logs all live here. */
  paths: AidenPaths;
  /**
   * Turn-scoped abort signal, delivered per call by the dispatch (from the
   * agent's `_currentSignal`). A long-running tool that spawns a child (today:
   * shell_exec) reads this to reap its process TREE on interrupt instead of
   * leaving it running. Absent → no cancellation (short tools ignore it).
   */
  signal?: AbortSignal;
  /**
   * v4.4 Phase 3 — opaque session identifier used by the docker
   * sandbox to cache one long-lived container per session and reuse
   * it across tool calls. When unset, falls back to the literal
   * `'default'` (single container per process — fine for CLI one-offs
   * and tests). The agent populates this from its own session id.
   */
  sessionId?: string;
  /** Session manager for the `session_search` / `session_list` tools. */
  sessions?: SessionManager;
  /** Memory manager — currently unused (memory loads via prompt snapshot)
   *  but plumbed through so Phase 9 memory-write tools can hook in. */
  memory?: MemoryManager;
  /** Process registry shared across `process_*` tools (Phase 8). */
  processes?: ProcessRegistry;
  /** Which terminal backend `shell_exec` should route to. Phase 9
   *  populates this from session/policy; defaults to `'local'`. */
  terminalBackend?: 'local' | 'docker';
  /** Override the default Docker image for the docker backend.
   *  Phase 8 default is `node:22-alpine`. */
  dockerImage?: string;
  /** Phase 9: approval engine. When present, every `mutates: true`
   *  handler is gated through it before `execute` runs. */
  approvalEngine?: ApprovalEngine;
  /** Durable exact-action approval authority for an admitted Job. */
  actionAuthority?: ActionAuthority;
  /** Script-step checkpoint used only by durable Automation approval waits. */
  automationApprovalContinuation?: AutomationApprovalContinuationRuntime;
  /** Durable store used by the Automation ScriptSpec adapter to resume the
   * exact approval-bound step after a host restart. */
  automationApprovalContinuations?: AutomationApprovalContinuationAuthority;
  /** Immutable inputs used to snapshot policy for each final action. */
  policySnapshot?: PolicySnapshotInput;
  /** Phase 9: SSRF check for any tool whose category is `network`. */
  ssrfProtection?: SSRFProtection;
  /** Phase 9: content scanner. `shell_exec` runs commands through it
   *  before dispatching. */
  tirithScanner?: TirithScanner;
  /** Phase 9: memory write verification. Memory tool wrappers call
   *  through this. */
  memoryGuard?: MemoryGuard;
  /** Phase 10: skill loader for `skills_list` / `skill_view`. */
  skillLoader?: SkillLoader;
  /** Phase 10: bundled manifest for `skills_list` userModified flag
   *  and for `skill_manage` writes to track user-modification state. */
  skillManifest?: BundledManifest;
  /** Optional structured logger. Wrappers call this for diagnostic output. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * v4.11 — interactive clarify callback for the `clarify` tool. Present
   * only in the REPL context (wired at boot from CliCallbacks.promptClarify,
   * which reuses the readLine/prompt path the approval flow uses). The
   * tool calls this to ask the user a question and await a free-text or
   * menu answer; it returns `null` when the user cancels. Absent in
   * headless/daemon contexts so the tool degrades to "unavailable,
   * proceed" instead of hanging.
   */
  clarify?: (question: string, options?: string[]) => Promise<string | null>;
  /**
   * P1B-2B shadow filesystem capture. When present, the execution gate takes a
   * FAIL-SAFE pre/post snapshot around exact-target file tools and hands the
   * finished pair here. Absent ⇒ zero capture, zero I/O. NON-AUTHORITATIVE: a
   * snapshot never affects the command whether it succeeds or fails.
   */
  snapshotSink?: SnapshotSink;
  /** Per-attempt discriminator for the snapshot pair (runtime retries reuse the
   *  same call.id). Defaults to 1. */
  attempt?: number;
}

/**
 * One tool. `schema` is what the LLM sees; `execute` is what runs.
 *
 * `execute` MAY throw — the registry's executor wraps thrown errors into
 * a `ToolCallResult.error` so the loop never crashes from a bad tool. But
 * wrappers SHOULD prefer returning a structured `{ error: ... }` object
 * (or rethrowing with a clear message) over silently absorbing failures.
 */
export interface ToolInteraction {
  mode: 'exclusive_modal';
  decision: string;
  cancellation?: 'cancelled';
  /** Forward-compatible metadata for plugin-defined interaction facts. */
  [key: string]: unknown;
}

/** Shared generic predicate for tools that exclusively own interactive input. */
export function isExclusiveToolInteraction(
  interaction: ToolInteraction | undefined,
): boolean {
  return interaction?.mode === 'exclusive_modal';
}

export interface ToolHandler {
  schema: ToolSchema;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
  category: ToolCategory;
  /** True for any tool that mutates state (disk, processes, network writes). */
  mutates: boolean;
  /** Fail-closed validation that runs before hooks, approval, persistence or execution. */
  validateArguments?: (args: Readonly<Record<string, unknown>>) => string | null;
  /** Group label — `web`, `files`, `browser`, `sessions`, `skills`, etc. */
  toolset?: string;
  /**
   * Resolves a path argument into the durable capability namespace before the
   * generic Job resource gate evaluates it. Snapshot-bound tools use this to
   * bind repository-relative input to their assigned snapshot root.
   */
  resolveCapabilityPath?: (argument: string, value: string, context: ToolContext) => string;
  /** Runtime-only interaction metadata; never included in provider schemas. */
  interaction?: ToolInteraction;
  /**
   * v4.4 Phase 1 — per-tool risk tier. Optional for backward compat.
   * Tools without an explicit annotation default via
   * `inferDefaultRiskTier(mutates)` from `core/v4/sandboxConfig.ts`:
   * `mutates: true → 'caution'`, `mutates: false → 'safe'`.
   *
   * Phase 5 ApprovalEngine integration treats this as a FLOOR —
   * DANGEROUS_PATTERNS can escalate (e.g. shell_exec annotated
   * `dangerous` matches `rm -rf` → still `dangerous`; shell_exec
   * annotated `caution` matches `rm -rf` → escalates to `dangerous`)
   * but never demote below the annotation.
   *
   *   - `safe`      — read-only, no side effects, low information disclosure
   *   - `caution`   — mutates filesystem in user-scoped paths or minor state
   *   - `dangerous` — arbitrary shell, irreversible state, self-modification
   */
  riskTier?: import('./sandboxConfig').RiskTier;
  /**
   * v4.10 Slice 10.6 — fine-grained effects metadata. Layered on top
   * of `category × riskTier × mutates` (the existing 3-axis taxonomy
   * remains the source of truth for gate logic). Effects describe
   * WHAT the tool touches; the approval-prompt renderer surfaces them
   * as an "Effects:" line so users can see WHY a tool is gated, not
   * just THAT it is.
   *
   * Tags are optional. Slice 10.6 ships the schema field + render
   * path; tagging the 67+ existing tools is deferred to a follow-up
   * (10.6b). Tools without `effects` show no "Effects:" line — the
   * prompt UX degrades gracefully.
   *
   * Shape lives in `moat/approvalEngine.ts` as `ToolEffects`; the
   * dispatch threads it through to `ApprovalRequest.effects` at
   * the `checkApproval` call site below.
   */
  effects?: import('../../moat/approvalEngine').ToolEffects;
  /** Durable mutation semantics used by the canonical ToolCall/Effect authority. */
  effectContract?: import('./effectContract').ToolEffectContract;
  /**
   * v4.6 Phase 1 — the execution contexts in which this tool is
   * visible to the LLM. Default behaviour (when the field is
   * undefined): visible in both `repl` and `daemon` — matches every
   * tool registered pre-v4.6.
   *
   * Tools that should only appear to interactive (REPL) agents tag
   * `['repl']`. Tools that should only appear to daemon-fired
   * agents tag `['daemon']`. The v4.6 sub-agent primitive itself
   * (`spawn_sub_agent`) is `['repl']` per Q6 (daemon-fired turns
   * must not initiate sub-agent spawns in Phase 1).
   *
   * The filter is applied in `getSchemas(filterToolsets, context)`.
   * `register()` itself ignores the field — every tool stays in the
   * registry; the field only narrows what each AidenAgent sees.
   */
  contexts?: ExecutionContext[];
  /**
   * v4.8.0 — when true, this tool is a UI-only signal channel: the
   * dispatch loop skips execution, skips iteration accounting, skips
   * observability hooks, and instead fires onUiEvent on the caller.
   * Used by ui_task_update, ui_task_done, etc. Always pair with
   * `mutates: false`.
   */
  uiOnly?: boolean;
  /**
   * v4.4 Phase 4 — produce a preview of what `execute` would do
   * WITHOUT performing any side effects. Called when AIDEN_DRYRUN=1
   * (via the `withDryRun` HOC in `core/v4/dryRun.ts`) OR when the
   * ApprovalEngine surfaces a dangerous-tier preview before
   * prompting the user.
   *
   * MUST be pure: no disk writes, no shell, no network. Read-only
   * stat/exists checks are allowed and encouraged for enriching the
   * preview (e.g. file_write detecting overwrite-vs-create).
   *
   * Tools without a `buildPreview` get a generic envelope from
   * `genericPreview` — the dry-run coverage sentinel test ensures
   * every `mutates: true` tool registered in `tools/v4/index.ts`
   * defines a real preview before ship.
   */
  buildPreview?(
    args:    Record<string, unknown>,
    context: ToolContext,
  ): Promise<import('./dryRun').WouldExecute> | import('./dryRun').WouldExecute;
}

function jsTypeOf(v: unknown): string {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}

/**
 * Content-level guard for tool arguments. JSON that PARSES can still carry
 * garbage semantics — plan prose dropped into a field the schema declares an
 * `array` / `object`, or a value outside a declared `enum`. `parseToolArgs`
 * (the provider adapters) only checks that the JSON is well-formed; nothing
 * checks the CONTENTS against the declared shape, so a structured field
 * silently receives prose.
 *
 * Returns an honest, model-actionable message for the FIRST violation, or null
 * when the args satisfy the declared shapes. It NEVER guesses a repair, and is
 * conservative by construction — it fires only on unambiguous mismatches:
 *   - a field declared `array`  that received a non-array
 *   - a field declared `object` that received a non-object
 *   - a value outside a declared `enum`
 * String / number / boolean fields are left alone (free text and coercion are
 * legitimate there), so a well-formed call never trips it.
 */
export function validateToolArgs(inputSchema: unknown, args: Record<string, unknown>): string | null {
  const props = (inputSchema as { properties?: Record<string, unknown> } | null | undefined)?.properties;
  if (!props || typeof props !== 'object') return null;
  for (const [key, rawSpec] of Object.entries(props)) {
    if (!(key in args)) continue;                         // absent field — not this guard's concern
    const value = args[key];
    if (value === undefined || value === null) continue;
    const spec = rawSpec as { type?: unknown; enum?: unknown[] };
    if (spec.type === 'array' && !Array.isArray(value)) {
      return `argument "${key}" must be an array (a list of items), but received a ${jsTypeOf(value)}. Emit the items as JSON, not prose.`;
    }
    if (spec.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      return `argument "${key}" must be an object, but received a ${jsTypeOf(value)}. Emit a JSON object, not prose.`;
    }
    if (Array.isArray(spec.enum) && spec.enum.length > 0 && !spec.enum.includes(value)) {
      return `argument "${key}" must be one of ${JSON.stringify(spec.enum)}, but received ${JSON.stringify(value)}.`;
    }
  }
  return null;
}

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    // Fail closed at the single registration chokepoint. `mutates` is a
    // compile-time-required field, but a runtime-loaded plugin whose compiled
    // JS dropped it (types are erased at runtime) reaches here with
    // `mutates === undefined`. Treat that as MUTATING, never read-only, so a
    // forgotten declaration can never bypass the approval gate at dispatch —
    // and so EVERY downstream reader (the gate, side-effect classifier,
    // resolveMutates, the parallel read-only hoister) sees the safe value.
    // A tool opts into the read fast-path by explicitly declaring `mutates:false`.
    const normalized: ToolHandler =
      typeof handler.mutates === 'boolean' ? handler : { ...handler, mutates: true };
    this.handlers.set(normalized.schema.name, normalized);
  }

  unregister(name: string): void {
    this.handlers.delete(name);
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** All registered tool names, in insertion order. */
  list(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Schemas to advertise to the LLM. Two optional filters, AND-combined:
   *
   *   - `filterToolsets`: include only handlers whose `toolset` matches
   *     one of the entries. Applied first (preserves pre-v4.6 behaviour
   *     when called with one argument).
   *   - `context` (v4.6 Phase 1): include only handlers whose
   *     `contexts` array contains this value, OR whose `contexts` is
   *     undefined (default = visible everywhere). Applied second.
   *
   * All filters default to "no filter" when omitted. Callers that
   * predate v4.6 pass one arg or none and continue working unchanged.
   * `excludeToolsets` (v4.11) removes the named toolsets from the result
   * even under the `full` (no include filter) profile.
   */
  getSchemas(filterToolsets?: string[], context?: ExecutionContext, excludeToolsets?: string[]): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const handler of this.handlers.values()) {
      // v4.11 — exclude filter wins over the include filter and handles
      // the `full` profile (filterToolsets undefined = ship everything)
      // uniformly: applied to every handler regardless of the include
      // decision. Used to strip the `ui` toolset from known-weak models
      // that leak ui_* markup (core/v4/modelCapability.ts:isWeakModel).
      if (excludeToolsets && excludeToolsets.length > 0 && handler.toolset) {
        if (excludeToolsets.includes(handler.toolset)) {
          continue;
        }
      }
      // v4.12 — MCP tools are explicitly user-added (via `/mcp add|import`
      // or config.yaml `mcp.servers`), not part of the static profile
      // taxonomy. They bypass the profile *include*-filter so they always
      // reach the model regardless of the active profile's toolset list —
      // otherwise they'd be registry-visible (`/mcp status`) but
      // model-invisible. The exclude filter above still applies (so
      // `excludeToolsets: ['mcp']` remains a working opt-out), as does the
      // context filter below.
      if (filterToolsets && filterToolsets.length > 0 && handler.toolset !== 'mcp') {
        if (!handler.toolset || !filterToolsets.includes(handler.toolset)) {
          continue;
        }
      }
      if (context !== undefined) {
        // contexts undefined → tool is visible in both REPL and daemon
        // (backward-compat default for every pre-v4.6 tool).
        if (handler.contexts !== undefined && !handler.contexts.includes(context)) {
          continue;
        }
      }
      out.push(handler.schema);
    }
    return out;
  }

  /** Filter handlers by risk category. */
  byCategory(cat: ToolCategory): ToolHandler[] {
    return [...this.handlers.values()].filter((h) => h.category === cat);
  }

  /**
   * Build the executor function `AidenAgent` consumes. Closes over
   * `context` so individual tool calls don't have to thread it manually.
   *
   * Errors are NEVER thrown out of the executor — they become
   * `{ error: '...' }` results so the model can read the failure and
   * recover. Two error shapes:
   *
   *   - Unknown tool          → `Tool "X" is not registered`.
   *   - Handler threw         → that error's message verbatim.
   */
  buildExecutor(
    baseContext: ToolContext,
  ): (
    call: ToolCallRequest,
    signal?: AbortSignal,
    onActivity?: (update: ToolActivityUpdate) => void,
  ) => Promise<ToolCallResult> {
    return async (
      call: ToolCallRequest,
      signal?: AbortSignal,
      onActivity?: (update: ToolActivityUpdate) => void,
    ): Promise<ToolCallResult> => {
      const timing: ToolActivityTiming = {
        dispatchStartedAt: Date.now(),
        executionAttempts: [],
      };
      let approvalDecision: ToolApprovalDecision | undefined;
      let durableApproval: {
        approvalId: string;
        toolCallId: string;
        actionDigest: string;
        policySnapshotId: string;
        effectId: string | null;
        riskTier: string;
      } | undefined;
      let preparedToolCall: PreparedDurableToolCall | null | undefined;
      let preparedRepositoryChange: { intent: ChangeIntentRecord; plan: FileChangePlan } | undefined;
      let committedRepositoryChange: { intent: ChangeIntentRecord; record: ChangeRecord } | undefined;
      let completedRepositoryValidation: StructuredValidationRun | undefined;
      let effectDescriptor: DurableEffectDescriptor | undefined;
      let approvalWaitId: string | null = null;
      const emit = (phase: ToolActivityUpdate['phase'], attempt?: number): void => {
        try { onActivity?.({ phase, at: Date.now(), attempt, timing }); } catch { /* observational */ }
      };
      const finish = (
        result: ToolCallResult,
        terminalClassification: ToolTerminalClassification,
      ): ToolCallResult => {
        timing.dispatchEndedAt = Date.now();
        timing.attemptCount = timing.executionAttempts.length;
        timing.approvalWaitMs = timing.approvalStartedAt !== undefined && timing.approvalEndedAt !== undefined
          ? Math.max(0, timing.approvalEndedAt - timing.approvalStartedAt)
          : 0;
        timing.executionDurationMs = timing.executionAttempts.reduce(
          (total, attemptTiming) => total + Math.max(0, (attemptTiming.endedAt ?? timing.dispatchEndedAt!) - attemptTiming.startedAt),
          0,
        );
        timing.terminalClassification = terminalClassification;
        emit('terminal');
        Object.defineProperty(result, 'activityTiming', {
          value: timing,
          writable: true,
          configurable: true,
          enumerable: false,
        });
        if (approvalDecision) {
          Object.defineProperty(result, 'approvalDecision', {
            value: approvalDecision,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
        return result;
      };
      const handler = this.handlers.get(call.name);
      if (!handler) {
        return finish({
          id: call.id,
          name: call.name,
          result: null,
          error: `Tool "${call.name}" is not registered`,
        }, 'failed');
      }

      const durableJobContext = currentJobExecutionContext();
      let context = baseContext;
      let repositoryChangeAutoBound = false;
      const needsRepositoryBinding =
        ((call.name === 'file_read' || call.name === 'file_list') && !baseContext.repositoryInspection)
        || (['file_write', 'file_patch', 'file_move', 'file_delete'].includes(call.name)
          && !baseContext.repositoryChange)
        || (call.name === 'shell_exec' && !baseContext.repositoryValidation);
      if (
        durableJobContext
        && needsRepositoryBinding
      ) {
        try {
          const repository = await ensureRepositoryExecutionBinding(durableJobContext);
          if (repository) {
            repositoryChangeAutoBound = baseContext.repositoryChange === undefined;
            context = {
              ...baseContext,
              repositoryInspection: baseContext.repositoryInspection ?? repository.inspection,
              repositoryChange: baseContext.repositoryChange ?? repository.change,
              repositoryValidation: baseContext.repositoryValidation ?? repository.validation,
            };
          }
        } catch (error) {
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: `Repository state could not be captured: ${error instanceof Error ? error.message : String(error)}`,
          }, 'blocked');
        }
      }

      let args = call.arguments ?? {};

      // ── Argument-shape guard — JSON that PARSES can still be garbage ───
      // A well-formed argument can carry prose where the schema declares a
      // structured field (array/object) or an enum value. Nothing else checks
      // the CONTENTS, so reject the clearest violations with an honest message
      // the model can act on — before approval, the cache, or execution trusts
      // it. Never guesses a repair.
      const argShapeError = validateToolArgs(handler.schema.inputSchema, args);
      if (argShapeError) {
        return finish({
          id: call.id,
          name: call.name,
          result: null,
          error: `Invalid arguments for ${call.name}: ${argShapeError}`,
        }, 'failed');
      }
      const handlerArgumentError = handler.validateArguments?.(args) ?? null;
      if (handlerArgumentError) {
        return finish({
          id: call.id,
          name: call.name,
          result: null,
          error: `Invalid arguments for ${call.name}: ${handlerArgumentError}`,
        }, 'blocked');
      }

      // Action-changing hooks run before policy evaluation and approval. The
      // returned arguments become the sole frozen input for every later gate.
      const preHookShim = sliceSpanShim();
      const preHookContext = _identityCurrentContext();
      if (preHookShim.db && preHookContext) {
        try {
          args = await preHookShim.runToolPreHooks({
            db: preHookShim.db,
            toolName: call.name,
            toolCallId: call.id,
            args,
            ctx: {
              runId: preHookContext.runId,
              traceId: preHookContext.traceId,
              spanId: preHookContext.spanId,
              parentSpanId: preHookContext.parentSpanId,
            },
          });
        } catch (error) {
          const message = error instanceof HookBlockedError
            ? (error.modelMessage ?? error.userMessage ?? error.message)
            : error instanceof Error ? error.message : String(error);
          return finish({ id: call.id, name: call.name, result: null, error: message }, 'blocked');
        }
      }
      args = freezeToolArguments(args);

      // ── Gate 1 — approval engine for mutating tools (runs FIRST) ───
      // Fail-open ORDERING fix: approval MUST precede the SSRF check and the
      // tirith scan (both moved below). An unapproved URL-bearing tool has to be
      // DENIED before ssrfProtection.check() resolves its DNS — otherwise a tool
      // the user never approved still touches the network. Approve first, THEN
      // probe/scan.
      // v4.14.6 — a verified read-only shell command (rg/grep/ls/cat/… with no
      // redirection, chaining, substitution, or dangerous pattern) is treated as
      // a read: it skips the approval gate exactly like file_read, so safe
      // searches never prompt. Writes, deletes, network, and anything the
      // classifier can't PROVE read-only still gate normally.
      const readOnlyShell =
        call.name === 'shell_exec' &&
        typeof args.command === 'string' &&
        isReadOnlyCommand(args.command);
      const shellIntent = call.name === 'shell_exec' && typeof args.command === 'string'
        ? analyzeCommandIntent(args.command, context.cwd ?? process.cwd())
        : undefined;
      // Fail closed: a tool must EXPLICITLY declare `mutates: false` to skip the
      // approval gate. An unknown / undeclared `mutates` (e.g. a dynamically
      // registered tool that never set it) is ASSUMED to mutate and is gated —
      // a forgotten declaration must not become a silent bypass.
      const assumeMutates = handler.mutates ?? true;
      const effectiveMutates = assumeMutates && !readOnlyShell;
      const preliminaryEffect = describeToolEffect(
        effectiveMutates ? handler : { ...handler, mutates: false },
        args,
        context.cwd ?? process.cwd(),
      );
      const resourceAuthority = durableJobContext?.engine.resources;
      if (durableJobContext && resourceAuthority) {
        if (!resourceAuthority.authorize({ jobId: durableJobContext.jobId, kind: 'tool', value: call.name })) {
          return finish({ id: call.id, name: call.name, result: null, error: 'Tool is outside this Job capability boundary' }, 'blocked');
        }
        for (const key of ['path', 'from', 'to', 'source', 'destination']) {
          const value = args[key];
          if (typeof value === 'string' && value.length > 0) {
            let capabilityPath: string;
            try {
              capabilityPath = handler.resolveCapabilityPath?.(key, value, context)
                ?? resolvePath(context.cwd ?? process.cwd(), value);
            } catch (error) {
              return finish({
                id: call.id,
                name: call.name,
                result: null,
                error: error instanceof Error ? error.message : 'Path is not valid for this Job capability',
              }, 'blocked');
            }
            if (!resourceAuthority.authorize({
              jobId: durableJobContext.jobId,
              kind: 'path',
              value: capabilityPath,
            })) {
              return finish({ id: call.id, name: call.name, result: null, error: 'Path is outside this Job capability boundary' }, 'blocked');
            }
          }
        }
        const pathList = Array.isArray(args.paths) ? args.paths : [];
        for (const value of pathList) {
          if (typeof value !== 'string' || value.length === 0) continue;
          let capabilityPath: string;
          try {
            capabilityPath = resolvePath(context.cwd ?? process.cwd(), value);
          } catch (error) {
            return finish({
              id: call.id,
              name: call.name,
              result: null,
              error: error instanceof Error ? error.message : 'Path is not valid for this Job capability',
            }, 'blocked');
          }
          if (!resourceAuthority.authorize({
            jobId: durableJobContext.jobId,
            kind: 'path',
            value: capabilityPath,
          })) {
            return finish({ id: call.id, name: call.name, result: null, error: 'Path is outside this Job capability boundary' }, 'blocked');
          }
        }
        if (
          effectiveMutates
          && !resourceAuthority.authorize({ jobId: durableJobContext.jobId, kind: 'effect', value: preliminaryEffect.kind })
        ) {
          return finish({ id: call.id, name: call.name, result: null, error: 'Effect is outside this Job capability boundary' }, 'blocked');
        }
        if (resourceAuthority.getBudgets(durableJobContext.jobId).some((budget) => budget.kind === 'tool_calls')) {
          const debit = resourceAuthority.debit({
            jobId: durableJobContext.jobId,
            attemptId: durableJobContext.attemptId,
            generation: durableJobContext.generation,
            fenceToken: durableJobContext.fenceToken,
            kind: 'tool_calls',
            amount: 1,
            certainty: 'confirmed',
            idempotencyKey: `tool-call:${call.id}`,
          });
          if (debit.exhausted) {
            return finish({ id: call.id, name: call.name, result: null, error: 'Tool-call budget exhausted' }, 'blocked');
          }
        }
      }
      let browserApprovalRequired = false;
      if (effectiveMutates && handler.category === 'browser') {
        if (call.name === 'browser_upload') {
          browserApprovalRequired = true;
        } else if (call.name === 'browser_dialog') {
          const action = String(args.action ?? '');
          browserApprovalRequired = (action === 'accept' || action === 'respond')
            && pwDialogPendingTier() !== null;
        } else {
          browserApprovalRequired = classifyBrowserAction(call.name, args, {
            attached: pwBrowserStatus().mode === 'attached',
            leaseStore: currentBrowserLeaseStore(),
          }) !== undefined;
        }
      }
      const approvalGated = effectiveMutates
        && (preliminaryEffect.approvalRequirement !== 'none' || browserApprovalRequired) && (
        context.approvalEngine !== undefined || (context.actionAuthority !== undefined && durableJobContext !== undefined)
      );
      effectDescriptor = preliminaryEffect;
      if (effectiveMutates && durableJobContext && context.repositoryChange) {
        try {
          if (context.repositoryChange.authority !== durableJobContext.engine.changes) {
            throw new Error('Repository change authority does not match the active Job');
          }
          const persistedToolCallId = currentDurableToolCallId(call.id) ?? call.id;
          const priorIntent = context.repositoryChange.authority.getIntentForToolCall(
            durableJobContext.attemptId,
            durableJobContext.generation,
            persistedToolCallId,
          );
          const plan = await fileChangePlanForTool(
            call.name,
            args,
            context.repositoryChange.rootPath,
            priorIntent?.operation,
          );
          const planBelongsToRepository = !plan || (
            isWithin(resolvePath(context.repositoryChange.rootPath, plan.path), context.repositoryChange.rootPath)
            && (!plan.destinationPath || isWithin(
              resolvePath(context.repositoryChange.rootPath, plan.destinationPath),
              context.repositoryChange.rootPath,
            ))
          );
          if (repositoryChangeAutoBound && !planBelongsToRepository) {
            context = { ...context, repositoryChange: undefined };
          }
          if (plan && context.repositoryChange) {
            const intent = await context.repositoryChange.authority.prepare({
              jobId: durableJobContext.jobId,
              attemptId: durableJobContext.attemptId,
              generation: durableJobContext.generation,
              fenceToken: durableJobContext.fenceToken,
              toolCallId: persistedToolCallId,
              baseSnapshotId: priorIntent?.state === 'committed'
                ? priorIntent.baseSnapshotId
                : context.repositoryChange.baseSnapshotId,
              plan,
              producer: durableJobContext.producer,
            });
            const priorRecord = context.repositoryChange.authority.getRecord(intent.intentId);
            if (priorRecord?.state === 'committed') {
              if (priorRecord.descendantSnapshotId) {
                context.repositoryChange.baseSnapshotId = priorRecord.descendantSnapshotId;
                durableJobContext.repository?.advance(priorRecord.descendantSnapshotId);
              }
              return finish({
                id: call.id,
                name: call.name,
                result: projectSafeChangeResult(priorRecord, intent),
              }, 'completed');
            }
            preparedRepositoryChange = { intent, plan };
            effectDescriptor = {
              ...effectDescriptor,
              target: intent.canonicalDestination
                ? `${intent.canonicalTarget} -> ${intent.canonicalDestination}`
                : intent.canonicalTarget,
              reconciliationData: {
                ...effectDescriptor.reconciliationData,
                path: intent.canonicalDestination ?? intent.canonicalTarget,
                sourcePath: intent.canonicalTarget,
                destinationPath: intent.canonicalDestination ?? undefined,
                expectedContentSha256: intent.plannedResultHash ?? undefined,
                expectedSize: intent.plannedResultSize ?? undefined,
              },
            };
          }
        } catch (error) {
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          }, 'blocked');
        }
      }
      if (preparedRepositoryChange && (!context.actionAuthority || !context.approvalEngine)) {
        return finish({
          id: call.id,
          name: call.name,
          result: null,
          error: 'Source-fenced repository changes require exact interactive approval',
        }, 'blocked');
      }
      if (effectiveMutates && durableJobContext) {
        try {
          preparedToolCall = prepareDurableToolCall({
            toolCallId: call.id,
            toolName: call.name,
            args,
            riskTier: shellIntent?.tier ?? handler.riskTier ?? 'caution',
            mutates: true,
            effect: effectDescriptor,
            approvalState: approvalGated ? 'pending' : 'not_required',
            allowExactMutationRecovery: context.automationApprovalContinuation !== undefined,
          });
          if (preparedRepositoryChange && preparedToolCall?.effectId) {
            context.repositoryChange!.authority.bindEffect({
              jobId: durableJobContext.jobId,
              attemptId: durableJobContext.attemptId,
              generation: durableJobContext.generation,
              fenceToken: durableJobContext.fenceToken,
              intentId: preparedRepositoryChange.intent.intentId,
              effectId: preparedToolCall.effectId,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return finish({ id: call.id, name: call.name, result: null, error: message }, 'blocked');
        }
      }
      if (
        effectiveMutates && durableJobContext &&
        (browserApprovalRequired || !effectDescriptor.trusted || effectDescriptor.approvalRequirement === 'always') &&
        !context.approvalEngine && !context.actionAuthority
      ) {
        try { recordDurableToolApproval({ prepared: preparedToolCall ?? null, state: 'blocked' }); } catch { /* durable conflict is reported below */ }
        return finish({
          id: call.id,
          name: call.name,
          result: null,
          error: browserApprovalRequired || effectDescriptor.trusted
            ? 'Interactive approval is required for this mutation'
            : 'Mutating tool has no trusted effect contract and cannot run unattended',
        }, 'blocked');
      }
      if (
        approvalGated
      ) {
        // Pre-classify shell_exec commands so smart-mode has a tier.
        let riskTier: 'safe' | 'caution' | 'dangerous' | undefined;
        let reason: string | undefined;
        if (call.name === 'shell_exec' && typeof args.command === 'string') {
          riskTier = shellIntent?.tier;
          reason = shellIntent?.reason;
        } else if (
          call.name === 'browser_click' || call.name === 'browser_type' ||
          call.name === 'browser_fill' || call.name === 'browser_navigate'
        ) {
          // v4.12 B5.2 — confirm-destructive (committing clicks).
          // v4.12 B5.3 — confirm external secret-bearing navigation (exfil guard;
          // local URLs are never flagged/blocked).
          // v4.12 B3.2a — when attached to the user's REAL browser, also confirm
          // ANY external navigation (conservative default for live sessions).
          const attached = pwBrowserStatus().mode === 'attached';
          const c = classifyBrowserAction(call.name, args, {
            attached,
            leaseStore: currentBrowserLeaseStore(),
          });
          if (c) {
            riskTier = c.tier;
            reason = c.reason;
          }
        } else if (call.name === 'browser_dialog') {
          // v4.12 B4.2a — accepting/responding to a DANGEROUS parked dialog is
          // confirm-gated (reuses the dialog's tier from classifyDialog).
          const act = String((args as Record<string, unknown>).action ?? '');
          if (act === 'accept' || act === 'respond') {
            const t = pwDialogPendingTier();
            if (t) { riskTier = t; reason = `Responding (${act}) to a ${t} dialog.`; }
          }
        } else if (call.name === 'browser_upload') {
          // v4.12 B4.2a — uploading local files to the page is always dangerous.
          riskTier = 'dangerous';
          reason = 'Uploading local file(s) to the page.';
        }
        // v4.4 Phase 4 — dangerous-tier auto-preview. Surface
        // "what would happen if you say yes" to the approval prompt.
        // Effective tier is the handler annotation (Phase 1 floor)
        // OR the classifier escalation above (whichever is higher).
        let preview: unknown;
        const effectiveTier = call.name === 'shell_exec'
          ? (riskTier ?? 'dangerous')
          : (riskTier === 'dangerous' || handler.riskTier === 'dangerous')
            ? 'dangerous' : (riskTier ?? handler.riskTier);
        if (effectiveTier === 'dangerous' && typeof handler.buildPreview === 'function') {
          try {
            preview = await handler.buildPreview(args, context);
          } catch {
            // Preview is best-effort. A bad preview never blocks
            // the underlying approval decision.
            preview = undefined;
          }
        }
        const approvalReq: ApprovalRequest = {
          toolName: call.name,
          category: handler.category,
          args,
          approvalRequirement: effectDescriptor.approvalRequirement,
          // v4.12.1 Pillar 2 — pass the EFFECTIVE tier (handler-declared floor
          // OR classifier escalation) so the autonomy gate + smart mode see a
          // tool's real risk (e.g. file_delete → 'dangerous' always asks),
          // not just classifier-flagged shell/browser tiers.
          riskTier: effectiveTier,
          reason,
          preview,
          // v4.10 Slice 10.6 — pass through fine-grained effects when
          // the tool declares them. The approval-prompt renderer
          // shows an "Effects:" line; tools without `effects` get
          // no extra line (graceful degradation).
          effects:  handler.effects,
        };
        const jobContext = durableJobContext;
        if (context.actionAuthority && jobContext) {
          const normalized = normalizeExecutionPlan({
            toolName: call.name,
            args,
            cwd: context.cwd ?? process.cwd(),
            mutates: assumeMutates,
            riskTier: effectiveTier ?? 'caution',
            policy: context.policySnapshot ?? {
              trustLevel: 'Assistant',
              autonomyPolicy: 'ask_for_mutations',
              approvalMode: 'smart',
              toolMetadataVersion: 'runtime',
              sandboxPolicy: { roots: [context.cwd ?? process.cwd()], deny: [] },
              networkPolicy: {},
              pluginGrants: [],
              mcpGrants: [],
              workspaceOverrides: {},
              jobOverrides: {},
            },
          });
          const persistedToolCallId = currentDurableToolCallId(call.id) ?? call.id;
          let record: ReturnType<ActionAuthority['request']>;
          try {
            const continuation = context.automationApprovalContinuation?.prepareApproval({
              toolCallId: persistedToolCallId,
              effectId: preparedToolCall?.effectId ?? null,
              normalized,
            });
            record = context.actionAuthority.request({
              jobId: jobContext.jobId,
              attemptId: jobContext.attemptId,
              generation: jobContext.generation,
              fenceToken: jobContext.fenceToken,
              toolCallId: persistedToolCallId,
              effectId: preparedToolCall?.effectId ?? null,
              toolName: call.name,
              riskTier: effectiveTier ?? 'caution',
              riskReasons: reason ? [reason] : [],
              normalized,
            });
            if (continuation) context.automationApprovalContinuation?.bindApproval(record);
          } catch (error) {
            try { recordDurableToolApproval({ prepared: preparedToolCall ?? null, state: 'blocked' }); } catch { /* binding failure remains authoritative */ }
            return finish({
              id: call.id,
              name: call.name,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            }, 'blocked');
          }
          if (context.approvalEngine && ['created', 'displayed'].includes(record.state)) {
            context.actionAuthority.markDisplayed(record.approvalId);
          }
          durableApproval = {
            approvalId: record.approvalId,
            toolCallId: persistedToolCallId,
            actionDigest: normalized.actionDigest,
            policySnapshotId: normalized.policySnapshot.policySnapshotId,
            riskTier: effectiveTier ?? 'caution',
            effectId: preparedToolCall?.effectId ?? null,
          };
          approvalReq.durableApprovalId = record.approvalId;
          if (preparedRepositoryChange && durableApproval.effectId) {
            context.repositoryChange!.authority.bindApproval({
              jobId: jobContext.jobId,
              attemptId: jobContext.attemptId,
              generation: jobContext.generation,
              fenceToken: jobContext.fenceToken,
              intentId: preparedRepositoryChange.intent.intentId,
              effectId: durableApproval.effectId,
              approvalId: durableApproval.approvalId,
              actionDigest: durableApproval.actionDigest,
            });
          }
          if (preparedToolCall?.recoveryDisposition === 'committed') {
            return finish({
              id: call.id,
              name: call.name,
              result: { recovered: true, status: 'already_completed' },
            }, 'completed');
          }
          if (preparedToolCall?.recoveryDisposition === 'unknown') {
            return finish({
              id: call.id,
              name: call.name,
              result: null,
              error: 'Prior mutating execution has an unknown outcome and requires reconciliation',
            }, 'unknown');
          }
        }
        if (!context.approvalEngine) {
          try {
            recordDurableToolApproval({
              prepared: preparedToolCall ?? null,
              state: 'blocked',
              approvalId: durableApproval?.approvalId,
              actionDigest: durableApproval?.actionDigest,
            });
          } catch { /* the approval error remains authoritative */ }
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: `Approval required: ${durableApproval?.approvalId ?? 'interactive approval channel unavailable'}`,
          }, 'blocked');
        }
        if (jobContext?.controlAuthority) {
          try {
            approvalWaitId = jobContext.controlAuthority.waits.create({
              jobId: jobContext.jobId,
              attemptId: jobContext.attemptId,
              generation: jobContext.generation,
              kind: 'approval',
              payloadRef: durableApproval?.approvalId ?? null,
              producer: jobContext.producer,
              idempotencyNamespace: `approval-wait:${jobContext.jobId}`,
              idempotencyKey: durableApproval?.approvalId ?? call.id,
            }).record.waitId;
          } catch (error) {
            return finish({
              id: call.id, name: call.name, result: null,
              error: `Approval wait could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
            }, 'blocked');
          }
        }
        timing.approvalStartedAt = Date.now();
        emit('awaiting_approval');
        let allowed: boolean;
        try {
          const engine = context.approvalEngine as ApprovalEngine & {
            checkApprovalDetailed?: (req: ApprovalRequest) => Promise<ToolApprovalDecision>;
          };
          if (typeof engine.checkApprovalDetailed === 'function') {
            approvalDecision = await engine.checkApprovalDetailed(approvalReq);
            allowed = approvalDecision.approved;
          } else {
            allowed = await engine.checkApproval(approvalReq);
            approvalDecision = {
              state: allowed ? 'approved' : 'denied',
              approved: allowed,
              ...(!allowed ? { reason: engine.explainDenial(approvalReq) } : {}),
            };
          }
        } catch (error) {
          if (error instanceof DurableJobHostDetachedError) throw error;
          timing.approvalEndedAt = Date.now();
          const message = error instanceof Error ? error.message : String(error);
          if (durableApproval && context.actionAuthority && jobContext) {
            try {
              context.actionAuthority.decide({
                approvalId: durableApproval.approvalId,
                jobId: jobContext.jobId,
                attemptId: jobContext.attemptId,
                generation: jobContext.generation,
                actionDigest: durableApproval.actionDigest,
                policySnapshotId: durableApproval.policySnapshotId,
                decision: 'cancelled',
                decidedBy: 'runtime',
                decisionChannel: 'interactive',
              });
            } catch { /* the original prompt failure remains authoritative */ }
          }
          const terminal = signal?.aborted
            ? 'cancelled'
            : /timed?\s*out|timeout/i.test(message) ? 'timed_out' : 'failed';
          if (approvalWaitId && jobContext?.controlAuthority) {
            jobContext.controlAuthority.waits.cancel({
              waitId: approvalWaitId, attemptId: jobContext.attemptId, generation: jobContext.generation,
              producer: jobContext.producer, idempotencyKey: `approval-prompt-ended:${call.id}`,
            });
          }
          try {
            recordDurableToolApproval({
              prepared: preparedToolCall ?? null,
              state: signal?.aborted ? 'interrupted' : terminal === 'timed_out' ? 'timed_out' : 'blocked',
              approvalId: durableApproval?.approvalId,
              actionDigest: durableApproval?.actionDigest,
            });
          } catch { /* the prompt failure remains authoritative */ }
          return finish({ id: call.id, name: call.name, result: null, error: message }, terminal);
        }
        timing.approvalEndedAt = Date.now();
        if (approvalWaitId && jobContext?.controlAuthority) {
          const waitResult = jobContext.controlAuthority.waits.resolve({
            waitId: approvalWaitId, attemptId: jobContext.attemptId, generation: jobContext.generation,
            producer: jobContext.producer, idempotencyKey: `approval-decision:${call.id}`,
            resolutionRef: `approval:${approvalDecision?.state ?? (allowed ? 'approved' : 'denied')}`,
          });
          if (allowed && !waitResult.applied && !waitResult.duplicate) {
            return finish({
              id: call.id, name: call.name, result: null,
              error: `Approval wait settlement rejected: ${waitResult.conflict ?? 'unknown'}`,
            }, 'blocked');
          }
        }
        if (durableApproval && context.actionAuthority && jobContext) {
          const currentApproval = context.actionAuthority.get?.(durableApproval.approvalId);
          if (!currentApproval || !['expired', 'invalidated'].includes(currentApproval.state)) {
            context.actionAuthority.decide({
              approvalId: durableApproval.approvalId,
              jobId: jobContext.jobId,
              attemptId: jobContext.attemptId,
              generation: jobContext.generation,
              actionDigest: durableApproval.actionDigest,
              policySnapshotId: durableApproval.policySnapshotId,
              decision: allowed
                ? 'approved'
                : approvalDecision?.state === 'interrupted' ? 'cancelled' : 'denied',
              decidedBy: 'user',
              decisionChannel: 'interactive',
              decisionScope: approvalDecision?.scope ?? 'once',
            });
          }
        }
        if (!allowed) {
          try {
            recordDurableToolApproval({
              prepared: preparedToolCall ?? null,
              state: approvalDecision?.state === 'interrupted'
                ? 'interrupted'
                : approvalDecision?.state === 'blocked' ? 'blocked' : 'denied',
              approvalId: durableApproval?.approvalId,
              actionDigest: durableApproval?.actionDigest,
            });
          } catch { /* the approval decision remains authoritative */ }
          if (approvalDecision?.state === 'interrupted') {
            return finish({
              id: call.id,
              name: call.name,
              result: null,
              error: `Approval interrupted before tool execution${approvalDecision.reason ? ` — ${approvalDecision.reason}` : '.'}`,
            }, 'cancelled');
          }
          if (approvalDecision?.state === 'blocked') {
            return finish({
              id: call.id,
              name: call.name,
              result: null,
              error: `Tool execution blocked by approval safety policy${approvalDecision.reason ? ` — ${approvalDecision.reason}` : '.'}`,
            }, 'blocked');
          }
          // Phase 6 — keep the "denied by approval engine" phrase (downstream
          // detectors match it) AND append the honest why + how-to-allow:
          // which gate fired (hard-block / autonomy-floor / manual-deny) and
          // the safe way forward.
          const why = approvalDecision?.reason ?? context.approvalEngine.explainDenial(approvalReq);
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: `Tool execution denied by approval engine — ${why}`,
          }, signal?.aborted ? 'cancelled' : 'denied');
        }
        try {
          recordDurableToolApproval({
            prepared: preparedToolCall ?? null,
            state: 'approved',
            approvalId: durableApproval?.approvalId,
            actionDigest: durableApproval?.actionDigest,
          });
        } catch (error) {
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          }, 'blocked');
        }
      }

      // ── Gate 2 — SSRF check for network tools (AFTER approval) ───
      // Only reached once the tool is approved, so a denied network tool never
      // resolves a hostname or opens a socket.
      if (handler.category === 'network' && context.ssrfProtection) {
        const url =
          typeof args.url === 'string'
            ? args.url
            : typeof args.query === 'string'
            ? args.query
            : '';
        if (url && /^https?:/i.test(url)) {
          const ssrf = await context.ssrfProtection.check(url);
          if (ssrf.blocked) {
            return finish({
              id: call.id,
              name: call.name,
              result: null,
              error: `URL blocked: ${ssrf.reason}`,
            }, 'blocked');
          }
        }
      }

      // ── Gate 3 — tirith scan for shell_exec (AFTER approval) ───
      if (call.name === 'shell_exec' && context.tirithScanner) {
        const command =
          typeof args.command === 'string' ? args.command : '';
        if (command) {
          const findings = context.tirithScanner.scanCommand(command);
          const dangerous = findings.find((f) => f.severity === 'dangerous');
          if (dangerous) {
            return finish({
              id: call.id,
              name: call.name,
              result: null,
              error: `Tirith blocked: ${dangerous.description}`,
            }, 'blocked');
          }
        }
      }

      // v4.11 perf — pre-execute responseCache lookup. responseCache
      // internally consults its NO_CACHE_TOOLS deny list and per-tool
      // TTL table; the v4 wire just forwards (name, args). A cache hit
      // short-circuits BEFORE the daemon span / hooks fire — those
      // surfaces are pre-flight observability for actual execution,
      // and a cache-hit is by definition not a fresh execution.
      // A cache hit is still a logical ToolCall. Bind that identity before
      // consulting the cache so verification and Evidence attach to the
      // current Job/Attempt rather than to an unpersisted model call.
      if (durableJobContext && preparedToolCall === undefined) {
        try {
          preparedToolCall = prepareDurableToolCall({
            toolCallId: call.id,
            toolName: call.name,
            args,
            riskTier: handler.riskTier ?? (effectiveMutates ? 'caution' : 'safe'),
            mutates: effectiveMutates,
            effect: effectDescriptor,
            approvalState: 'not_required',
          });
        } catch (error) {
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          }, 'failed');
        }
      }
      const _cached = responseCache.get(call.name, args);
      if (_cached !== null) {
        // The cache stores a serialised string. Tools that produce
        // structured objects had their output stringified at set-time
        // below; we keep the cached envelope shape (no JSON.parse) so
        // the consumer (aidenAgent dispatch) sees the same
        // ToolCallResult shape it would on a fresh run.
        try {
          const cachedResult = await executeWithDurableToolCall({
            toolCallId: call.id,
            toolName: call.name,
            args,
            riskTier: handler.riskTier ?? (effectiveMutates ? 'caution' : 'safe'),
            mutates: effectiveMutates,
            effect: effectDescriptor,
            prepared: preparedToolCall,
            captureFilesystemProof: false,
            execute: async () => _cached,
          });
          return finish({ id: call.id, name: call.name, result: cachedResult }, 'completed');
        } catch (error) {
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          }, preparedToolCall?.mutates ? 'unknown' : 'failed');
        }
      }
      // v4.9.0 Slice 6 — wrap the handler call in a tool span when the
      // daemon foundation is up AND an ExecutionContext is active. NOOP
      // outside daemon mode or outside a runWithContext frame. Lazy
      // require avoids pulling daemon code into the v4 core import
      // graph at module load (would break headless / cli-test imports
      // that don't open a DB).
      //
      // v4.9.0 Slice 12a Phase 3 — inside the tool span, fire
      // `tool.call.pre` + `tool.call.post` hooks via `runToolWithHooks`.
      // Mandatory pre-hook blocks surface as HookBlockedError, caught
      // by the outer try/catch and mapped to a structured error result.
      // Deliver the per-call turn signal to the tool. Spread a per-call context
      // only when a signal is present, so a normal call allocates nothing and a
      // child agent's own signal never leaks into the shared session context.
      const dispatch = async (a: Record<string, unknown>): Promise<unknown> =>
        executeWithDurableToolCall({
          toolCallId: call.id,
          toolName: call.name,
          args: a,
          riskTier: handler.riskTier ?? (handler.mutates === false ? 'safe' : 'caution'),
          mutates: effectiveMutates,
          effect: effectDescriptor,
          prepared: preparedToolCall,
          captureFilesystemProof: preparedRepositoryChange === undefined,
          execute: async () => {
            const jobContext = currentJobExecutionContext();
            if (
              effectiveMutates && jobContext
              && jobContext.engine.resources.getBudgets(jobContext.jobId).some((budget) => budget.kind === 'effects')
            ) {
              const debit = jobContext.engine.resources.debit({
                jobId: jobContext.jobId,
                attemptId: jobContext.attemptId,
                generation: jobContext.generation,
                fenceToken: jobContext.fenceToken,
                kind: 'effects',
                amount: 1,
                certainty: 'confirmed',
                idempotencyKey: `effect:${call.id}`,
              });
              if (debit.exhausted) throw new Error('Effect budget exhausted');
            }
            const interactive = isExclusiveToolInteraction(handler.interaction);
            let waitId: string | null = null;
            if (interactive && jobContext?.controlAuthority) {
              waitId = jobContext.controlAuthority.waits.create({
                jobId: jobContext.jobId, attemptId: jobContext.attemptId, generation: jobContext.generation,
                kind: handler.interaction?.decision === 'batch_approval' ? 'approval' : 'clarification',
                producer: jobContext.producer,
                idempotencyNamespace: `interaction-wait:${jobContext.jobId}`,
                idempotencyKey: `${jobContext.attemptId}:${call.id}`,
              }).record.waitId;
            }
            try {
              let value: unknown;
              if (preparedRepositoryChange && durableApproval?.effectId) {
                const record = await context.repositoryChange!.authority.execute({
                  jobId: jobContext!.jobId,
                  attemptId: jobContext!.attemptId,
                  generation: jobContext!.generation,
                  fenceToken: jobContext!.fenceToken,
                  intentId: preparedRepositoryChange.intent.intentId,
                  effectId: durableApproval.effectId,
                  approvalId: durableApproval.approvalId,
                  actionDigest: durableApproval.actionDigest,
                  plan: preparedRepositoryChange.plan,
                  producer: jobContext!.producer,
                  signal,
                });
                if (record.descendantSnapshotId) {
                  context.repositoryChange!.baseSnapshotId = record.descendantSnapshotId;
                  jobContext!.repository?.advance(record.descendantSnapshotId);
                }
                committedRepositoryChange = { intent: preparedRepositoryChange.intent, record };
                value = projectSafeChangeResult(record, preparedRepositoryChange.intent);
              } else {
                const validationContext = context.repositoryValidation;
                const validationPlan = call.name === 'shell_exec' && validationContext
                  ? structuredValidationPlanForShell(
                    String(a.command ?? ''),
                    resolvePath(context.cwd ?? process.cwd(), String(a.cwd ?? '.')),
                  )
                  : null;
                if (validationPlan && jobContext && preparedToolCall?.effectId) {
                  if (validationContext!.authority !== jobContext.engine.validation) {
                    throw new Error('Repository validation authority does not match the active Job');
                  }
                  const environment = validationContext!.environment ?? {
                    platform: process.platform,
                    architecture: process.arch,
                    nodeVersion: process.version,
                    npmVersion: process.env.npm_config_user_agent?.match(/\bnpm\/([^\s]+)/)?.[1] ?? 'unknown',
                    variables: {
                      CI: process.env.CI ?? '',
                      NODE_ENV: process.env.NODE_ENV ?? '',
                    },
                  };
                  const validationRun = validationContext!.authority.start({
                    jobId: jobContext.jobId,
                    attemptId: jobContext.attemptId,
                    generation: jobContext.generation,
                    fenceToken: jobContext.fenceToken,
                    repositorySnapshotId: validationContext!.baseSnapshotId,
                    toolCallId: preparedToolCall.toolCallId,
                    effectId: preparedToolCall.effectId,
                    plan: validationPlan,
                    environment,
                    producer: jobContext.producer,
                  });
                  value = await handler.execute(a, signal ? { ...context, signal } : context);
                  const result = value && typeof value === 'object'
                    ? value as Record<string, unknown> : {};
                  const rawOutput = getRawValidationOutput(value);
                  const completion = await validationContext!.authority.complete({
                    jobId: jobContext.jobId,
                    attemptId: jobContext.attemptId,
                    generation: jobContext.generation,
                    fenceToken: jobContext.fenceToken,
                    runId: validationRun.runId,
                    execution: {
                      exitCode: typeof result.exitCode === 'number' ? result.exitCode : result.success === true ? 0 : 1,
                      stdout: typeof result.stdout === 'string' ? result.stdout : '',
                      stderr: typeof result.stderr === 'string' ? result.stderr : '',
                      timedOut: result.timedOut === true,
                      cancelled: signal?.aborted === true,
                    },
                    ...(rawOutput ? { rawOutput } : {}),
                    producer: jobContext.producer,
                  });
                  completedRepositoryValidation = completion.run;
                  if (completion.run.resultingSnapshotId) {
                    validationContext!.baseSnapshotId = completion.run.resultingSnapshotId;
                    jobContext.repository?.advance(completion.run.resultingSnapshotId);
                  }
                } else {
                  value = await handler.execute(a, signal ? { ...context, signal } : context);
                }
              }
              if (waitId && jobContext?.controlAuthority) {
                const status = value && typeof value === 'object'
                  ? String((value as Record<string, unknown>).status ?? '') : '';
                if (status === 'cancelled' || status === 'interrupted') {
                  jobContext.controlAuthority.waits.cancel({
                    waitId, attemptId: jobContext.attemptId, generation: jobContext.generation,
                    producer: jobContext.producer, idempotencyKey: `interaction-cancelled:${call.id}`,
                  });
                } else {
                  jobContext.controlAuthority.waits.resolve({
                    waitId, attemptId: jobContext.attemptId, generation: jobContext.generation,
                    producer: jobContext.producer, idempotencyKey: `interaction-resolved:${call.id}`,
                    resolutionRef: `interaction:${status || 'completed'}`,
                  });
                }
              }
              return value;
            } catch (error) {
              if (waitId && jobContext?.controlAuthority) {
                jobContext.controlAuthority.waits.cancel({
                  waitId, attemptId: jobContext.attemptId, generation: jobContext.generation,
                  producer: jobContext.producer, idempotencyKey: `interaction-failed:${call.id}`,
                });
              }
              throw error;
            }
          },
        });

      // ── P1B-2B — FAIL-SAFE pre-state snapshot (shadow, non-authoritative) ──
      // Post-approval, pre-spawn. In its OWN try/catch, independent of the
      // handler try/catch below, so a capture fault can never reach the
      // command's error path. The budget inside fileSnapshot is a fail-safe
      // TIMEOUT: on any throw / hang / timeout / permission error it yields a
      // `SnapshotObservation.unknown` and the command spawns unchanged.
      const _snapTargets = context.snapshotSink ? snapshotTargetsForTool(call.name, args) : [];
      let _snapPre: Map<string, SnapshotObservation> | undefined;
      if (context.snapshotSink && _snapTargets.length > 0) {
        try {
          const obs = await Promise.all(_snapTargets.map((p) => fileSnapshot(p)));
          _snapPre = new Map(_snapTargets.map((p, i) => [p, obs[i]]));
        } catch {
          _snapPre = undefined; // capture fault → no pair; the command still runs
        }
      }

      // Claim execution of the exact approved action immediately before the
      // handler boundary. A changed digest, policy, Attempt, or ToolCall fails
      // closed and invalidates the durable Approval.
      if (durableApproval && context.actionAuthority) {
        const jobContext = currentJobExecutionContext();
        if (!jobContext) {
          return finish({ id: call.id, name: call.name, result: null, error: 'Durable approval lost its Job context' }, 'blocked');
        }
        const current = normalizeExecutionPlan({
          toolName: call.name,
          args,
          cwd: context.cwd ?? process.cwd(),
          mutates: assumeMutates,
          riskTier: durableApproval.riskTier,
          policy: context.policySnapshot ?? {
            trustLevel: 'Assistant',
            autonomyPolicy: 'ask_for_mutations',
            approvalMode: 'smart',
            toolMetadataVersion: 'runtime',
            sandboxPolicy: { roots: [context.cwd ?? process.cwd()], deny: [] },
            networkPolicy: {},
            pluginGrants: [],
            mcpGrants: [],
            workspaceOverrides: {},
            jobOverrides: {},
          },
        });
        const authorization = context.actionAuthority.authorizeExecution({
          approvalId: durableApproval.approvalId,
          jobId: jobContext.jobId,
          attemptId: jobContext.attemptId,
          generation: jobContext.generation,
          fenceToken: jobContext.fenceToken,
          toolCallId: durableApproval.toolCallId,
          effectId: durableApproval.effectId,
          actionDigest: current.actionDigest,
          policySnapshotId: current.policySnapshot.policySnapshotId,
        });
        if (!authorization.authorized) {
          try {
            recordDurableToolApproval({
              prepared: preparedToolCall ?? null,
              state: 'blocked',
              approvalId: durableApproval.approvalId,
              actionDigest: durableApproval.actionDigest,
            });
          } catch { /* authorization failure remains authoritative */ }
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: `Approved action rejected before execution: ${authorization.reason ?? 'binding conflict'}`,
          }, 'blocked');
        }
      }

      let result: unknown;
      const executionAttempt = {
        attempt: context.attempt ?? 1,
        startedAt: Date.now(),
      } as ToolActivityTiming['executionAttempts'][number];
      timing.executionAttempts.push(executionAttempt);
      emit('running', executionAttempt.attempt);
      try {
        const sliced = sliceSpanShim();
        if (sliced && sliced.db && sliced.hasContext()) {
          const sideEffect = sliced.classifySideEffect(handler);
          const inputFp    = sliced.fingerprint(args);
          result = await sliced.withToolSpan(
            sliced.db,
            { toolName: call.name, inputFingerprint: inputFp, sideEffectClass: sideEffect },
            async (childCtx) => {
              const hookOptions = {
                db:         sliced.db,
                toolName:   call.name,
                toolCallId: call.id,
                args,
                ctx: {
                  runId:        childCtx.runId,
                  traceId:      childCtx.traceId,
                  spanId:       childCtx.spanId,
                  parentSpanId: childCtx.parentSpanId,
                },
              };
              const raw = await dispatch(args);
              return sliced.runToolPostHooks(hookOptions, args, raw);
            },
          );
        } else {
          result = await dispatch(args);
        }
        const projectionContext = currentJobExecutionContext();
        if (projectionContext && (committedRepositoryChange || completedRepositoryValidation)) {
          try {
            if (committedRepositoryChange) {
              projectCommittedRepositoryChange({
                context: projectionContext,
                intent: committedRepositoryChange.intent,
                record: committedRepositoryChange.record,
              });
            }
            if (completedRepositoryValidation) {
              projectCompletedRepositoryValidation({
                context: projectionContext,
                run: completedRepositoryValidation,
              });
            }
          } catch (error) {
            projectionContext.engine.appendJobEvent({
              jobId: projectionContext.jobId,
              attemptId: projectionContext.attemptId,
              generation: projectionContext.generation,
              type: 'repository.plan_projection_failed',
              payload: { message: error instanceof Error ? error.message : String(error) },
              producer: projectionContext.producer,
              idempotencyKey: `repository-plan-projection-failed:${call.id}`,
            });
          }
        }
        executionAttempt.endedAt = Date.now();
        executionAttempt.terminalResult = 'completed';
        const inner = result as
          | { degraded?: unknown; degradedReason?: unknown }
          | null
          | undefined;
        const out: ToolCallResult = { id: call.id, name: call.name, result };
        if (typeof inner?.degraded === 'boolean' && inner.degraded) {
          out.degraded = true;
          if (typeof inner.degradedReason === 'string') {
            out.degradedReason = inner.degradedReason;
          }
        }
        // v4.11 perf — populate responseCache on success (non-degraded,
        // serialisable result). responseCache internally gates on its
        // NO_CACHE_TOOLS deny list + per-tool TTL table; if either says
        // skip, this call is a no-op. We stringify so the cache stores
        // a normalised string form — the get-side returns the same
        // shape so the consumer sees consistent ToolCallResult.result
        // whether cache hit or fresh execution.
        if (!out.degraded && out.result != null) {
          try {
            const serialised = typeof out.result === 'string'
              ? out.result
              : JSON.stringify(out.result);
            responseCache.set(call.name, args, serialised);
          } catch { /* serialisation failure: skip cache, never break the call */ }
        }
        // ── P1B-2B — FAIL-SAFE post-state snapshot (shadow, DEFERRED) ──────
        // Fire-and-forget AFTER the command's result already exists, so it adds
        // ZERO latency to the command path. Builds the pair and hands it to the
        // sink. Any fault is swallowed; nothing here can touch `out`.
        if (context.snapshotSink && _snapPre) {
          // Wrapped so even a SYNCHRONOUS throw from fileSnapshot (building the
          // array) is swallowed here and can never reach the handler catch below
          // — `out` is already computed; capture must not flip it to an error.
          try {
            const sink = context.snapshotSink;
            const pre = _snapPre;
            const attempt = context.attempt ?? 1;
            const targets = _snapTargets;
            void Promise.all(targets.map((p) => fileSnapshot(p).then((post) => ({ p, post }))))
              .then((posts) => {
                for (const { p, post } of posts) {
                  const preObs = pre.get(p);
                  if (!preObs) continue;
                  try { sink({ resource: resourceIdForPath(p), attempt, pre: preObs, post }); }
                  catch { /* a sink fault never matters */ }
                }
              })
              .catch(() => { /* post-capture fault → no pair */ });
          } catch { /* synchronous capture fault → no pair; `out` is untouched */ }
        }
        return finish(out, out.degraded ? 'degraded' : 'completed');
      } catch (err) {
        executionAttempt.endedAt ??= Date.now();
        executionAttempt.terminalResult = signal?.aborted ? 'cancelled' : 'failed';
        // v4.9.0 Slice 12a — hook blocks surface as a structured
        // rejection so the model gets the hook's `reason` / `model_message`
        // verbatim instead of a bare exception string.
        if (err instanceof HookBlockedError) {
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: err.modelMessage ?? err.message,
          }, 'blocked');
        }
        if (err instanceof DockerCancellationUnverifiedError) {
          return finish({
            id: call.id,
            name: call.name,
            result: null,
            error: 'Sandbox cancellation could not verify that the exact process stopped',
            cleanupUnverified: true,
          }, 'unknown');
        }
        const message = err instanceof Error ? err.message : String(err);
        const terminal = signal?.aborted
          ? 'cancelled'
          : preparedToolCall?.mutates ? 'unknown'
          : /timed?\s*out|timeout/i.test(message) ? 'timed_out' : 'failed';
        executionAttempt.terminalResult = terminal;
        return finish({ id: call.id, name: call.name, result: null, error: message }, terminal);
      }
    };
  }
}

// v4.9.0 Slice 6 — static imports for the span-shim bridge. Earlier
// attempts used lazy `require()` to keep daemon code out of the import
// graph when the test harness doesn't compile it; that path broke
// under vite-node which doesn't intercept CJS require for `.ts`
// targets. Static ESM imports work in both vitest + production builds.
import { getCurrentDaemonDb } from './daemon/bootstrap';
import { withToolSpan, shortInputFingerprint } from './daemon/spans/spanHelpers';
import { currentContext as _identityCurrentContext } from './identity';
import { runToolPostHooks, runToolPreHooks, HookBlockedError } from './hooks/toolHookGate';

function classifySideEffectForHandler(h: ToolHandler): 'read' | 'write' | 'mutating' | 'destructive' {
  if (h.riskTier === 'dangerous') return 'destructive';
  if (h.mutates === false)        return 'read';
  if (h.mutates === true)         return 'mutating';
  // Fail closed: an undeclared `mutates` is assumed to mutate, never treated as
  // a read. A tool must EXPLICITLY declare `mutates: false` to be classified
  // read-only — a forgotten declaration must not silently read as safe.
  return 'mutating';
}

function freezeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(args);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  };
  freeze(copy);
  return copy;
}

interface ToolSpanShim {
  db: import('./daemon/db/connection').Db | null;
  hasContext(): boolean;
  classifySideEffect(handler: ToolHandler): 'read' | 'write' | 'mutating' | 'destructive';
  fingerprint(args: Record<string, unknown>): string;
  withToolSpan: typeof withToolSpan;
  runToolPostHooks: typeof runToolPostHooks;
  runToolPreHooks: typeof runToolPreHooks;
}
const _toolSpanShim: ToolSpanShim = {
  get db()            { return getCurrentDaemonDb(); },
  hasContext:         () => _identityCurrentContext() !== undefined,
  classifySideEffect: classifySideEffectForHandler,
  fingerprint:        shortInputFingerprint,
  withToolSpan,
  runToolPostHooks,
  runToolPreHooks,
};
function sliceSpanShim(): ToolSpanShim { return _toolSpanShim; }
