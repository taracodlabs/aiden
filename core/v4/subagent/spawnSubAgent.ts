/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/spawnSubAgent.ts — v4.6 Phase 1.
 *
 * Public spawn primitive. Synchronously runs one child agent to handle
 * a delegated sub-task, returns a structured `SubAgentResult` envelope.
 * NEVER throws — every error path produces an envelope with the
 * appropriate `status` + `error` fields so the parent's LLM can
 * reason about the failure.
 *
 * Contract per `docs/v4.6/phase-1-design.md` §3, §6, §8.
 *
 *   - Single child (Phase 1; batch is Phase 2 via subagent_fanout
 *     refactor)
 *   - Synchronous: the parent's tool dispatch awaits this Promise
 *   - Cooperative cancellation: parent's AbortSignal cascades to
 *     child via a linked AbortController
 *   - Wall-clock timeout: hard cap via setTimeout → child interrupt
 *   - Persistence: writes a `runs` row with `spawned_from_run_id` +
 *     `spawned_from_session_id` linking back to the parent
 */

import { randomUUID } from 'node:crypto';
import { buildChildAgent, ProviderNotFoundError } from './childBuilder';
import type { ChildBuilderDeps } from './childBuilder';
// v4.12.1 Pillar 3 — evidence-required subagent reports. The child's own
// tool trace is run through the SAME verify-before-done gate the REPL/daemon
// use, and its concrete handles are re-checked against reality on the parent
// side ("no handle, no trust"). Reuses the evidence envelope; no parallel
// verdict system.
import type { TaskEvidence } from '../taskVerification';
import { deriveSubagentEvidence, type ProofHandle } from './evidenceRecheck';
import { emitPillarEvent } from '../pillarEvents';
// v4.9.0 Slice 7 — fork ExecutionContext into the child agent.
import { currentContext, runWithContext, childSpan } from '../identity';
import type { RunStore } from '../daemon/runStore';
import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';

// ── Public types (per design doc §3) ─────────────────────────────────────

/** Spec the spawn tool's JSON schema validates before calling us. */
export interface SubAgentSpec {
  goal: string;
  context?: string;
  toolsets?: string[];
  /** Will be clamped to [1, 200] by the tool wrapper; defaults to 50. */
  maxIterations?: number;
  /** Defaults to 600_000ms (10 min); minimum 1_000ms. */
  timeoutMs?: number;
  /**
   * v4.6 Phase 2P (per design doc §12.2) — optional per-spawn
   * provider override. When supplied, must name a provider available
   * in the parent's resolved provider pool (validated against
   * `FallbackAdapter.getProviderIds()`). When omitted, child inherits
   * the parent's active provider — Phase 1 default, unchanged.
   *
   * Validation is fail-loud: an unknown name produces a `status:
   * 'failed'`, `exitReason: 'provider_not_found'` envelope with a
   * persisted runs row (observable via `aiden runs show`). Silent
   * fallback would collapse fanout's rotation diversity, so we
   * surface the misconfiguration instead of papering over it.
   *
   * Most direct callers should OMIT this field. Primarily exists
   * for `subagent_fanout`'s Phase 2 refactor (Dispatch 2Q), where
   * the rotation layer needs explicit provider selection per child.
   */
  provider?: string;
}

/** Result envelope per design doc §3, §8. */
export interface SubAgentResult {
  /**
   * v4.12.1 Pillar 3 — `ok` now means VERIFIED completion (`verdict ===
   * 'completed'`), NOT merely a clean loop exit. A child that cleanly
   * finishes but whose claimed side-effect fails verification is `ok: false`.
   */
  ok: boolean;
  status: 'completed' | 'failed' | 'timeout' | 'interrupted';
  summary: string | null;
  error: string | null;
  exitReason:
    | 'completed'
    | 'max_iterations'
    | 'timeout'
    | 'interrupted'
    | 'error'
    | 'provider_not_found';
  metrics: {
    apiCalls: number;
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
  };
  /** Child run row id — populated for EVERY status, including failed. */
  childRunId: string;
  /** Child sessionId (flat UUID, fresh per spawn). */
  childSessionId: string;
  // ── v4.12.1 Pillar 3 — evidence-required reporting ─────────────────────
  /**
   * The verify-before-done verdict over the child's own tool trace, after
   * the parent-side handle re-check. `null` for non-completed runs
   * (timeout/interrupted/failed), which never carried a verifiable claim.
   */
  verdict: 'completed' | 'completed_unverified' | 'verification_failed' | null;
  /** The child's evidence envelope (handles/failures), reusing TaskEvidence. */
  evidence: TaskEvidence | null;
  /**
   * True only when the child produced concrete proof handles that BACK its
   * claim AND those handles re-checked clean on the parent side. A prose-only
   * or handle-failing child is NOT verified.
   */
  verified: boolean;
  /**
   * True when the child performed no mutating work — a pure-reasoning answer.
   * Honest degrade: the parent treats it as ADVISORY, not verified-fact. Never
   * fake evidence for these.
   */
  reasoningOnly: boolean;
  /** The concrete proof handles that survived the parent-side re-check. */
  handles: ProofHandle[];
  /**
   * v4.12.1 Pillar 2 — mutating ops the child ESCALATED to the parent
   * (destructive / external / out-of-scope) instead of running them. Empty
   * for a child that only did in-scope work. The parent decides on these.
   */
  escalations: Array<{ tool: string; reason?: string }>;
}

/** Dependencies the spawn primitive needs to do its job. */
export interface SpawnSubAgentDeps extends ChildBuilderDeps {
  /** Persistence handle — sub-agent run row is inserted via this. */
  runStore: RunStore;
  /** Daemon instance id (or a REPL-sentinel) used as `runs.instance_id`. */
  instanceId: string;
  /**
   * v4.6 Phase 1 observability — optional logger for spawn-side
   * traces (parsed spec, child-build summary, completion).
   * Defaults to `noopLogger()` when omitted. Tests inject a
   * capturing logger; production wiring passes a bootLogger child.
   */
  logger?: Logger;
}

/** Per-call context — parent identity + signal. */
export interface SpawnSubAgentCtx {
  /** Parent's AbortSignal (read via parentAgent.getCurrentSignal() at the
   *  tool wrapper) — when aborted, cascades to the child immediately. */
  signal?: AbortSignal;
  /** Parent's `runs.id` — written to child's `spawned_from_run_id`.
   *  Optional because Phase 1 spawn can be invoked from a REPL turn
   *  that may not have a row written yet; absent → NULL in DB. */
  parentRunId?: number;
  /** Parent's `runs.session_id` — written to child's `spawned_from_session_id`. */
  parentSessionId?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_ITERATIONS = 50;
const MIN_MAX_ITERATIONS = 1;
const MAX_MAX_ITERATIONS = 200;

// ── Implementation ────────────────────────────────────────────────────────

/**
 * Spawn one child agent. Always returns an envelope; never throws.
 *
 * Lifecycle (per §6 state machine):
 *
 *   1. Generate child sessionId (flat UUID).
 *   2. Insert `runs` row with `status: 'running'` + lineage columns.
 *   3. Build child agent (clones FallbackAdapter, intersects toolsets,
 *      filters blocklist, fresh ApprovalEngine with auto-deny).
 *   4. Construct linked AbortController: parent's signal feeds into
 *      it; a setTimeout on `timeoutMs` also aborts it.
 *   5. Run `child.runConversation(history, { signal: childCtrl.signal })`.
 *   6. On return / throw / timeout, classify into the envelope's
 *      status + exitReason and update the runs row's status.
 *   7. Clean up timer + signal listener.
 */
export async function spawnSubAgent(
  spec: SubAgentSpec,
  deps: SpawnSubAgentDeps,
  ctx: SpawnSubAgentCtx,
): Promise<SubAgentResult> {
  const startedAt = Date.now();

  // ── 1. Clamp inputs ─────────────────────────────────────────────────────
  const maxIterations = clamp(
    spec.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    MIN_MAX_ITERATIONS,
    MAX_MAX_ITERATIONS,
  );
  const timeoutMs = clamp(
    spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  // ── 2. Fresh sessionId + run row ────────────────────────────────────────
  const childSessionId = randomUUID();

  // Pre-create the child run row in 'running' state so the envelope
  // always carries a valid childRunId — even if buildChildAgent throws.
  let childRunId: number;
  try {
    childRunId = deps.runStore.create({
      sessionId:             childSessionId,
      instanceId:            deps.instanceId,
      status:                'running',
      startedAt,
      spawnedFromRunId:      ctx.parentRunId,
      spawnedFromSessionId:  ctx.parentSessionId,
    });
  } catch (err) {
    // Persistence failed before we even started — surface as failed
    // envelope with a synthetic id of '0' so the contract holds.
    return failureEnvelope({
      childRunId:     '0',
      childSessionId,
      error:          `Failed to create child run row: ${errorMessage(err)}`,
      durationMs:     Date.now() - startedAt,
    });
  }

  // ── 3. Build child agent ────────────────────────────────────────────────
  const logger = deps.logger ?? noopLogger();
  // v4.12.1 Pillar 2 — collect escalations the child raised to the parent
  // (destructive / external / out-of-scope ops it refused to run itself).
  const escalations: Array<{ tool: string; reason?: string }> = [];
  let agentBundle: ReturnType<typeof buildChildAgent>;
  try {
    agentBundle = buildChildAgent(
      {
        ...deps,
        // v4.6 Phase 1 observability — pass runStore + childRunId
        // through so childBuilder can wire onToolCall → run_events
        // for the child's tool dispatches. Both are optional in
        // ChildBuilderDeps so unit tests of buildChildAgent stay
        // dependency-light.
        runStore:    deps.runStore,
        childRunId,
        logger,
        // Pillar 2 — record every escalation, then forward to any caller sink.
        // Pillar 4 — also emit it as a live `subagent_escalation` event so the
        // glass dashboard sees the escalate-to-parent moment on the one stream.
        onEscalate: (e) => {
          escalations.push({ tool: e.tool, reason: e.reason });
          emitPillarEvent(
            { runStore: deps.runStore as unknown as { emitEventRich(o: Record<string, unknown>): number }, runId: Number(childRunId) },
            'subagent_escalation',
            { tool: e.tool, reason: e.reason ?? null, childRunId: String(childRunId) },
          );
          deps.onEscalate?.(e);
        },
      },
      {
        sessionId:         childSessionId,
        goal:              spec.goal,
        context:           spec.context,
        requestedToolsets: spec.toolsets,
        maxIterations,
        // v4.6 Phase 2P — per-spawn provider override (per design doc §12.2).
        providerOverride:  spec.provider,
      },
    );
  } catch (err) {
    // v4.6 Phase 2P — distinguish provider-not-found from other build
    // failures. ProviderNotFoundError carries the failing name + the
    // list of valid alternatives, surfaced verbatim to the LLM in the
    // envelope so it can pick a real provider next time. Other build
    // failures (constructor throws, registry issues, etc.) collapse
    // to the generic 'error' exitReason.
    if (err instanceof ProviderNotFoundError) {
      deps.runStore.setStatus(childRunId, 'failed', { finishReason: 'provider_not_found' });
      return {
        ok:             false,
        status:         'failed',
        summary:        null,
        error:          err.message,
        exitReason:     'provider_not_found',
        metrics:        { apiCalls: 0, durationMs: Date.now() - startedAt, tokensIn: 0, tokensOut: 0 },
        childRunId:     String(childRunId),
        childSessionId,
        verdict:        null,
        evidence:       null,
        verified:       false,
        reasoningOnly:  false,
        handles:        [],
        escalations:    [],
      };
    }
    deps.runStore.setStatus(childRunId, 'failed', { finishReason: 'error' });
    return failureEnvelope({
      childRunId:     String(childRunId),
      childSessionId,
      error:          `Failed to build child agent: ${errorMessage(err)}`,
      durationMs:     Date.now() - startedAt,
    });
  }

  // v4.6 Phase 1 observability — log the child's actual tool catalog
  // so we can see whether the toolsets-resolution path produced a
  // sensible set or stripped everything. The single most-load-bearing
  // diagnostic for the "child returned 0" class of bugs.
  const childToolNames = (agentBundle.agent as unknown as { tools: { name: string }[] }).tools.map((t) => t.name);
  logger.info('spawn_sub_agent child built', {
    childRunId:      String(childRunId),
    childSessionId,
    toolCount:       childToolNames.length,
    toolNames:       childToolNames,
    requestedToolsets: spec.toolsets ?? null,
    maxIterations,
    timeoutMs,
  });

  // ── 4. Linked AbortController ───────────────────────────────────────────
  // Two abort sources cascade into the child's signal:
  //   (a) parent signal aborts — child aborts.
  //   (b) timeoutMs elapses — child aborts.
  // Track which one fired so we can label the envelope as
  // 'interrupted' vs 'timeout' (the spec distinguishes them).
  const childCtrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    childCtrl.abort();
  }, timeoutMs);

  let parentAbortHandler: (() => void) | null = null;
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      childCtrl.abort();
    } else {
      parentAbortHandler = () => childCtrl.abort();
      ctx.signal.addEventListener('abort', parentAbortHandler, { once: true });
    }
  }

  const cleanupAbortWiring = () => {
    clearTimeout(timer);
    if (parentAbortHandler && ctx.signal) {
      ctx.signal.removeEventListener('abort', parentAbortHandler);
    }
  };

  // ── 5. Run the child ─────────────────────────────────────────────────────
  // `child.runConversation` propagates the signal into the loop's
  // between-iteration + pre-tool-call abort checks via the prep
  // dispatch (commit fd62f96d).
  let summary: string | null = null;
  let error: string | null = null;
  let status: SubAgentResult['status'] = 'completed';
  let exitReason: SubAgentResult['exitReason'] = 'completed';
  let apiCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  // v4.12.1 Pillar 3 — the child's own tool trace, captured so its evidence
  // is scored + re-checked below instead of discarded.
  let childTrace: import('../../../moat/honestyEnforcement').HonestyTraceEntry[] = [];

  // v4.9.0 Slice 7 — fork an ExecutionContext for the child so its
  // tool/LLM spans chain off the parent's spanId. AsyncLocalStorage
  // is in-process; the child runs inside `runWithContext(childCtx, ...)`
  // so any `currentContext()` reads during the child's runConversation
  // see the child's chain (same traceId, fresh spanId, parentSpanId =
  // parent's spanId). Out-of-context callers (legacy paths) leave
  // the call exactly as it was pre-Slice-7.
  const parentCtx = currentContext();
  const runChild = async (): Promise<Awaited<ReturnType<typeof agentBundle.agent.runConversation>>> =>
    agentBundle.agent.runConversation(
      agentBundle.history,
      {
        signal:    childCtrl.signal,
        // v4.8.0 Phase 2.2 — uiOnly events from a subagent are
        // dropped. Subagents have no chat surface; the parent
        // assembles their summary. Stub stays a no-op forever.
        onUiEvent: () => { /* no-op: subagents do not render */ },
      },
    );

  try {
    const result = await (parentCtx
      ? runWithContext(childSpan({ ...parentCtx, source: 'subagent' }), runChild)
      : runChild());
    apiCalls = result.turnCount;       // one provider call per turn
    tokensIn = result.totalUsage.inputTokens;
    tokensOut = result.totalUsage.outputTokens;
    childTrace = result.toolCallTrace ?? [];   // capture for evidence scoring

    // Classify the result per design doc §8.
    if (result.finishReason === 'interrupted') {
      // Distinguish timeout from parent-interrupt by which source fired.
      if (timedOut) {
        status = 'timeout';
        exitReason = 'timeout';
        error = `Sub-agent timed out after ${timeoutMs}ms (maxIterations=${maxIterations})`;
      } else {
        status = 'interrupted';
        exitReason = 'interrupted';
        error = 'Parent interrupted — child did not finish in time';
      }
    } else if (result.finishReason === 'budget_exhausted') {
      // Hit maxIterations. If the model produced a partial final reply,
      // we ship it as a 'completed/max_iterations' (partial summary);
      // otherwise it's a failure.
      if (result.finalContent && result.finalContent.length > 0) {
        status = 'completed';
        exitReason = 'max_iterations';
        summary = result.finalContent;
      } else {
        status = 'failed';
        exitReason = 'error';
        error = `Sub-agent hit max_iterations (${maxIterations}) without producing a summary`;
      }
    } else if (result.finishReason === 'error') {
      status = 'failed';
      exitReason = 'error';
      error = 'Sub-agent loop reported an internal error';
    } else if (result.finishReason === 'tool_loop') {
      // TCE surfaced a tool loop — treat as a failure with structured
      // payload buried in error string (Phase 1 doesn't yet ship the
      // capability-card detail into the envelope).
      status = 'failed';
      exitReason = 'error';
      error = `Sub-agent detected a tool loop and stopped: ${result.toolLoopCard?.title ?? 'tool_loop'}`;
    } else {
      // 'stop' → natural completion.
      status = 'completed';
      exitReason = 'completed';
      summary = result.finalContent;
    }
  } catch (err) {
    // child.runConversation threw — typically only happens when the
    // provider call fails after exhausting fallback chain. Surface as
    // a failed envelope with the error string.
    status = 'failed';
    exitReason = 'error';
    error = `Sub-agent threw: ${errorMessage(err)}`;
  } finally {
    cleanupAbortWiring();
  }

  // ── 6. Update run row + emit envelope ────────────────────────────────────
  const dbStatus =
    status === 'completed'   ? 'completed'
    : status === 'interrupted' ? 'interrupted'
    : 'failed';
  deps.runStore.setStatus(childRunId, dbStatus, { finishReason: exitReason });

  const durationMs = Date.now() - startedAt;

  // ── v4.12.1 Pillar 3 — score the child's evidence, re-check its handles ──
  // For a completed run, run the child's OWN tool trace through the same
  // verify-before-done gate the REPL/daemon use (computeTaskFinalization),
  // then re-check each concrete handle against reality on the parent side.
  // A failed re-check downgrades the verdict to verification_failed — a
  // claimed artifact that isn't there is not a success.
  let verdict: SubAgentResult['verdict'] = null;
  let evidence: TaskEvidence | null = null;
  let verified = false;
  let reasoningOnly = false;
  let handles: ProofHandle[] = [];

  if (status === 'completed') {
    const ev = deriveSubagentEvidence(childTrace);
    verdict       = ev.verdict;
    evidence      = ev.evidence;
    verified      = ev.verified;
    reasoningOnly = ev.reasoningOnly;
    handles       = ev.handles;
  }

  // Pillar 3: `ok` now means VERIFIED completion, not a clean loop exit.
  const ok = verdict === 'completed';

  return {
    ok,
    status,
    summary,
    error,
    exitReason,
    metrics: {
      apiCalls,
      durationMs,
      tokensIn,
      tokensOut,
    },
    childRunId:     String(childRunId),
    childSessionId,
    verdict,
    evidence,
    verified,
    reasoningOnly,
    handles,
    escalations,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a failed envelope for pre-run errors (run-row creation,
 * agent construction). Always carries `summary: null`, `ok: false`,
 * `status: 'failed'`, `exitReason: 'error'`.
 */
function failureEnvelope(opts: {
  childRunId:     string;
  childSessionId: string;
  error:          string;
  durationMs:     number;
}): SubAgentResult {
  return {
    ok:             false,
    status:         'failed',
    summary:        null,
    error:          opts.error,
    exitReason:     'error',
    metrics: {
      apiCalls:    0,
      durationMs:  opts.durationMs,
      tokensIn:    0,
      tokensOut:   0,
    },
    childRunId:     opts.childRunId,
    childSessionId: opts.childSessionId,
    verdict:        null,
    evidence:       null,
    verified:       false,
    reasoningOnly:  false,
    handles:        [],
    escalations:    [],
  };
}
