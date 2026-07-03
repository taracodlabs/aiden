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

import type {
  ToolSchema,
  ToolCallRequest,
  ToolCallResult,
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
import type { ApprovalEngine } from '../../moat/approvalEngine';
import type { SSRFProtection } from '../../moat/ssrfProtection';
import type { TirithScanner } from '../../moat/tirithScanner';
import type { MemoryGuard } from '../../moat/memoryGuard';
import { classifyCommand } from '../../moat/dangerousPatterns';
import { classifyBrowserAction } from './browserState';
import { pwBrowserStatus, pwDialogPendingTier } from '../playwrightBridge';
import type { SkillLoader } from './skillLoader';
import type { BundledManifest } from './skillBundledManifest';

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
  /** Aiden user-data paths. Sessions, memory, skills, logs all live here. */
  paths: AidenPaths;
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
}

/**
 * One tool. `schema` is what the LLM sees; `execute` is what runs.
 *
 * `execute` MAY throw — the registry's executor wraps thrown errors into
 * a `ToolCallResult.error` so the loop never crashes from a bad tool. But
 * wrappers SHOULD prefer returning a structured `{ error: ... }` object
 * (or rethrowing with a clear message) over silently absorbing failures.
 */
export interface ToolHandler {
  schema: ToolSchema;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
  category: ToolCategory;
  /** True for any tool that mutates state (disk, processes, network writes). */
  mutates: boolean;
  /** Group label — `web`, `files`, `browser`, `sessions`, `skills`, etc. */
  toolset?: string;
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

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.handlers.set(handler.schema.name, handler);
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
    context: ToolContext,
  ): (call: ToolCallRequest) => Promise<ToolCallResult> {
    return async (call: ToolCallRequest): Promise<ToolCallResult> => {
      const handler = this.handlers.get(call.name);
      if (!handler) {
        return {
          id: call.id,
          name: call.name,
          result: null,
          error: `Tool "${call.name}" is not registered`,
        };
      }

      const args = call.arguments ?? {};

      // ── Phase 9 layer A: SSRF check for network tools ─────────
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
            return {
              id: call.id,
              name: call.name,
              result: null,
              error: `URL blocked: ${ssrf.reason}`,
            };
          }
        }
      }

      // ── Phase 9 layer B: tirith scan for shell_exec ───────────
      if (call.name === 'shell_exec' && context.tirithScanner) {
        const command =
          typeof args.command === 'string' ? args.command : '';
        if (command) {
          const findings = context.tirithScanner.scanCommand(command);
          const dangerous = findings.find((f) => f.severity === 'dangerous');
          if (dangerous) {
            return {
              id: call.id,
              name: call.name,
              result: null,
              error: `Tirith blocked: ${dangerous.description}`,
            };
          }
        }
      }

      // ── Phase 9 layer C: approval engine for mutating tools ───
      if (handler.mutates && context.approvalEngine) {
        // Pre-classify shell_exec commands so smart-mode has a tier.
        let riskTier: 'safe' | 'caution' | 'dangerous' | undefined;
        let reason: string | undefined;
        if (call.name === 'shell_exec' && typeof args.command === 'string') {
          const c = classifyCommand(args.command);
          riskTier = c.tier;
          reason = c.reason;
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
          const c = classifyBrowserAction(call.name, args, { attached });
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
        const effectiveTier = (riskTier === 'dangerous' || handler.riskTier === 'dangerous')
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
        const allowed = await context.approvalEngine.checkApproval({
          toolName: call.name,
          category: handler.category,
          args,
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
        });
        if (!allowed) {
          return {
            id: call.id,
            name: call.name,
            result: null,
            error: 'Tool execution denied by approval engine',
          };
        }
      }

      // v4.11 perf — pre-execute responseCache lookup. responseCache
      // internally consults its NO_CACHE_TOOLS deny list and per-tool
      // TTL table; the v4 wire just forwards (name, args). A cache hit
      // short-circuits BEFORE the daemon span / hooks fire — those
      // surfaces are pre-flight observability for actual execution,
      // and a cache-hit is by definition not a fresh execution.
      const _cached = responseCache.get(call.name, args);
      if (_cached !== null) {
        // The cache stores a serialised string. Tools that produce
        // structured objects had their output stringified at set-time
        // below; we keep the cached envelope shape (no JSON.parse) so
        // the consumer (aidenAgent dispatch) sees the same
        // ToolCallResult shape it would on a fresh run.
        return { id: call.id, name: call.name, result: _cached };
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
      const dispatch = async (a: Record<string, unknown>): Promise<unknown> =>
        handler.execute(a, context);
      let result: unknown;
      try {
        const sliced = sliceSpanShim();
        if (sliced && sliced.db && sliced.hasContext()) {
          const sideEffect = sliced.classifySideEffect(handler);
          const inputFp    = sliced.fingerprint(args);
          result = await sliced.withToolSpan(
            sliced.db,
            { toolName: call.name, inputFingerprint: inputFp, sideEffectClass: sideEffect },
            async (childCtx) => sliced.runToolWithHooks(
              {
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
              },
              dispatch,
            ),
          );
        } else {
          result = await dispatch(args);
        }
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
        return out;
      } catch (err) {
        // v4.9.0 Slice 12a — hook blocks surface as a structured
        // rejection so the model gets the hook's `reason` / `model_message`
        // verbatim instead of a bare exception string.
        if (err instanceof HookBlockedError) {
          return {
            id: call.id,
            name: call.name,
            result: null,
            error: err.modelMessage ?? err.message,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { id: call.id, name: call.name, result: null, error: message };
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
import { runToolWithHooks, HookBlockedError } from './hooks/toolHookGate';

function classifySideEffectForHandler(h: ToolHandler): 'read' | 'write' | 'mutating' | 'destructive' {
  if (h.riskTier === 'dangerous') return 'destructive';
  if (h.mutates === false)        return 'read';
  if (h.mutates === true)         return 'mutating';
  return 'read';
}

interface ToolSpanShim {
  db: import('./daemon/db/connection').Db | null;
  hasContext(): boolean;
  classifySideEffect(handler: ToolHandler): 'read' | 'write' | 'mutating' | 'destructive';
  fingerprint(args: Record<string, unknown>): string;
  withToolSpan: typeof withToolSpan;
  runToolWithHooks: typeof runToolWithHooks;
}
const _toolSpanShim: ToolSpanShim = {
  get db()            { return getCurrentDaemonDb(); },
  hasContext:         () => _identityCurrentContext() !== undefined,
  classifySideEffect: classifySideEffectForHandler,
  fingerprint:        shortInputFingerprint,
  withToolSpan,
  runToolWithHooks,
};
function sliceSpanShim(): ToolSpanShim { return _toolSpanShim; }
