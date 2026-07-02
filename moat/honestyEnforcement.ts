/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/honestyEnforcement.ts — Aiden v4.7.0 (Phase 2.3 — outcome-based verifier)
 *
 * The regex-based natural-language claim scanner (deleted in Phase 2.2)
 * has been replaced with a deterministic outcome recorder that consumes
 * `toolCallTrace` structurally. Two failure modes are recorded:
 *
 *   1. mutation_errored  — a tool tagged `mutates: true` (in the
 *      registry, stamped onto trace entries at dispatch time via
 *      `handlerMutates`) returned an `error` envelope. Path is
 *      extracted from `result.path` when present.
 *
 *   2. memory_unverified — a memory_* tool's result carries
 *      `verified === false` (per Phase 9 MemoryGuard). This was
 *      the v3 C20/C21 lying surface and remains the only memory-
 *      specific check the verifier performs.
 *
 * Modes:
 *   off      — bypass entirely. No events recorded.
 *   detect   — Record events; never user-visible. `findings` populated;
 *              no `footer`.
 *   enforce  — DEFAULT. Record events + append a short footer to the
 *              assistant reply summarising the unverified outcomes.
 *              The footer is APPEND-ONLY — the assistant's text is
 *              never rewritten. (This is the key behaviour change vs
 *              v4.6.x — append-only, never an in-place edit.)
 *
 * What the verifier intentionally does NOT do (delta vs the deleted
 * scanner):
 *   - It does not look at the assistant's natural-language text at all.
 *     There's no regex matching of English verbs to tool names.
 *   - It does not emit `no_tool_call` findings. The previous "model
 *     claimed X but no tool fired" failure mode is gone — that was
 *     the false-refusal class. We only record OUTCOMES that ran.
 *   - It does not mutate `loopResult.messages`. The caller appends
 *     the footer to its own `finalContent` string variable.
 */

import type { ProviderAdapter, Message } from '../providers/v4/types';

export type HonestyMode = 'off' | 'detect' | 'enforce';

export interface HonestyFinding {
  /** Short label for the unverified outcome (tool name or claim). */
  claim: string;
  /** Tool name(s) whose outcome triggered this finding. */
  expectedTool: string | string[];
  /** True = outcome verified. False = unverified / errored. */
  found: boolean;
  /** Per-finding confidence 0–1. */
  confidence: number;
  /** Why we flagged this. */
  reason?:
    | 'no_tool_call'
    | 'memory_verified_false'
    | 'tool_errored'
    // v4.11 Slice 1 — per-tool verifier failure surfaced for all tools.
    | 'verifier_failed'
    // v4.13 Gap 1 — mutating tool succeeded but with weak evidence.
    | 'verifier_low_signal'
    // v4.11 Slice 2 — structured success claim contradicted by tool evidence.
    | 'claim_contradicted';
}

export interface HonestyResult {
  passed: boolean;
  findings: HonestyFinding[];
  /** Aggregate confidence — average of per-finding confidence. */
  confidence: number;
  originalResponse: string;
  /**
   * v4.7.0 Phase 2.3 — append-only footer summarising unverified
   * outcomes. Populated only when `mode === 'enforce'` AND
   * `findings.length > 0`. The caller is expected to concatenate
   * this to `finalContent` (NOT to rewrite the assistant's text).
   * Replaces the prior `correctedResponse` field that triggered
   * in-place rewrites — the failure mode this verifier was built
   * to eliminate.
   */
  footer?: string;
}

/**
 * v4.7.0 Phase 2.3 — structured event recorded for each unverified
 * tool outcome. Translated to a `HonestyFinding` for back-compat
 * with the existing call site.
 *
 * `path` (when present) is extracted from `result.path` for any
 * tool whose result envelope carries it (file_write, file_patch,
 * file_delete, file_move, file_copy, etc.).
 */
export type HonestyEvent =
  | { kind: 'mutation_errored'; tool: string; reason: string; path?: string }
  | { kind: 'memory_unverified'; tool: string; reason: string }
  // v4.11 Slice 1 — the per-tool verifier (verifier.ts) classified this
  // result as a failure (shell non-zero exit, file-write unconfirmed,
  // typed success:false, etc.). Surfaced for ALL tools, not just memory.
  //
  | { kind: 'tool_unverified'; tool: string; reason: string }
  // v4.13 Gap 1 — the verifier said ok:true but with weak evidence
  // (`low_signal` / `no_progress`). v1 suppressed these entirely because
  // they fire on benign read-only successes (reading an empty file, short
  // web result) and would cry wolf. The Gap-1 narrowing: surface them for
  // MUTATING tools only (handlerMutates === true) — a side-effecting tool
  // whose evidence is weak is exactly the honesty gap worth telling the
  // user about; benign reads stay quiet.
  | { kind: 'tool_low_signal'; tool: string; reason: string }
  // v4.11 Slice 2 — a structured success claim emitted via a ui-event
  // (ui_test_result{failed:0}, ui_task_done{status:'success'}) is
  // contradicted by a shell_exec failure (verifier !ok) in the same turn.
  // Structured-vs-structured; turn-scoped; no prose parsing.
  | { kind: 'claim_contradicted'; tool: string; reason: string };

/**
 * v4.11 Slice 2 — a structured ui-event claim captured during the turn.
 * `args` is the raw tool-call arguments object (shape per the ui_* tool
 * schema in tools/v4/index.ts).
 */
export interface UiClaim {
  name: string;
  args: unknown;
}

/**
 * v4.11 Slice 2 — true when a ui-event encodes a SUCCESS assertion:
 * `ui_test_result` with `failed === 0`, or `ui_task_done` with
 * `status === 'success'`. Purely structural — no natural-language parsing.
 */
function isSuccessClaim(c: UiClaim): boolean {
  const a = (c.args ?? {}) as Record<string, unknown>;
  if (c.name === 'ui_test_result') return a.failed === 0;
  if (c.name === 'ui_task_done')   return a.status === 'success';
  return false;
}

/** v4.11 Slice 2 — human-readable summary of a success claim for the footer. */
function describeSuccessClaim(c: UiClaim): string {
  const a = (c.args ?? {}) as Record<string, unknown>;
  if (c.name === 'ui_test_result') {
    return `ui_test_result reported ${a.passed ?? '?'} passed / 0 failed`;
  }
  if (c.name === 'ui_task_done') return 'ui_task_done reported success';
  return 'reported success';
}

/**
 * Memory tools whose results carry the `verified` flag set by
 * MemoryGuard. The list is closed — adding a new memory_* tool
 * means extending this set.
 */
const MEMORY_TOOLS: ReadonlySet<string> = new Set([
  'memory_add',
  'memory_replace',
  'memory_remove',
]);

/** Shape of a single tool-call entry in the trace inspected by Honesty. */
export interface HonestyTraceEntry {
  name: string;
  /** Tool result. Memory tools' result objects carry `verified: boolean`. */
  result: unknown;
  /** True when MemoryGuard verified the write. Honesty-critical. */
  verified?: boolean;
  /** Set when the tool errored (would never satisfy a positive claim). */
  error?: string;
  /**
   * v4.7.0 Phase 2.3 — `handler.mutates` flag, stamped at dispatch
   * time so the verifier doesn't need a registry handle. Drives the
   * `mutation_errored` event: only mutating tools that errored produce
   * an unverified-outcome finding. Read-only tools that error are
   * surfaced to the user via the tool-trail row already; the
   * verifier deliberately stays quiet about them.
   */
  handlerMutates?: boolean;
  /**
   * v4.2 Phase 1 — per-tool verifier classification of this result.
   * Populated only when TCE is enabled (default ON as of v4.2
   * Phase 6; opt-out via `AIDEN_TCE=0`) and the verifier didn't throw.
   * Honesty itself does NOT consume this field; it's surfaced here so
   * downstream callers (chatSession, loopTrace, future RecoveryReport)
   * get the verification inline with the rest of the trace entry.
   *
   * Import-cycle note: declared as a structural type to avoid pulling
   * `core/v4/verifier` into a moat-layer module. Shape MUST stay in
   * lockstep with `VerificationResult` in core/v4/verifier.ts.
   */
  verification?: {
    ok:          boolean;
    confidence:  number;
    code:        'ok' | 'failed' | 'no_progress' | 'low_signal' | 'unknown';
    reason?:     string;
    suggestion?: string;
  };
  /**
   * v4.2 Phase 2 — failure classification (WHY the verifier said !ok).
   * Populated only when TCE is enabled (default ON; opt-out via
   * `AIDEN_TCE=0`) AND verification.ok === false.
   * Honesty itself does NOT consume this field; it surfaces here so
   * Phase 3's RecoveryReport can render structured guidance, and so
   * chatSession / loopTrace get a complete trace entry.
   *
   * Import-cycle note: declared structurally to avoid pulling
   * `core/v4/failureClassifier` into a moat-layer module. Shape MUST
   * stay in lockstep with `ClassificationResult` in
   * core/v4/failureClassifier.ts.
   */
  classification?: {
    // v4.3 Phase 5 added 'stale_ref' + 'manual_blocker'.
    // v4.4 Phase 5 added 'sandbox_violation'.
    // v4.5 Phase 5a added 'trigger_misconfigured' + 'trigger_quota'
    //                 + 'trigger_dead_lettered'.
    // Mirror stays in lockstep with `FailureCategory` in
    // core/v4/failureClassifier.ts.
    category:    'timeout' | 'auth' | 'hallucination' | 'network'
               | 'permission' | 'rate_limit' | 'invalid_input'
               | 'dependency_missing' | 'not_found'
               | 'stale_ref' | 'manual_blocker'
               | 'sandbox_violation'
               | 'trigger_misconfigured' | 'trigger_quota'
               | 'trigger_dead_lettered'
               | 'other';
    confidence:  number;
    reason?:     string;
    recoverable: boolean;
    recoveryHint?: {
      action: 'retry' | 'retry_with_backoff' | 'rotate_credential'
            | 'install_dependency' | 'request_user_action'
            | 'surface_to_user';
      detail?: string;
    };
    matchedPattern?: string;
  };
  /**
   * v4.13 Gap 2 — observable runtime-retry ledger. One note per policy
   * re-attempt the dispatch loop performed for this call (transient
   * classes only, bounded budgets). Declared structurally to avoid
   * pulling core/v4/retryPolicy into the moat layer; shape stays in
   * lockstep with `RetryAttemptNote` in core/v4/retryPolicy.ts.
   */
  retries?: Array<{
    attempt:   number;
    category:  string;
    reason?:   string;
    backoffMs: number;
  }>;
}

/**
 * Read `result.path` when present (file_* tools' result envelopes
 * carry it). Returns undefined otherwise. Used only for cosmetic
 * footer detail — never affects pass/fail outcome.
 */
function extractPath(result: unknown): string | undefined {
  if (result && typeof result === 'object' && 'path' in result) {
    const p = (result as { path?: unknown }).path;
    if (typeof p === 'string') return p;
  }
  return undefined;
}

/**
 * Translate a `HonestyEvent` to the legacy `HonestyFinding` shape so
 * existing downstream consumers (chatSession, telemetry) keep working.
 * The fine-grained kind is preserved via `reason`.
 */
function toFinding(event: HonestyEvent): HonestyFinding {
  switch (event.kind) {
    case 'mutation_errored':
      return {
        claim:        event.tool,
        expectedTool: event.tool,
        found:        false,
        confidence:   1,
        reason:       'tool_errored',
      };
    case 'memory_unverified':
      return {
        claim:        event.tool,
        expectedTool: event.tool,
        found:        false,
        confidence:   1,
        reason:       'memory_verified_false',
      };
    case 'tool_unverified':
      return {
        claim:        event.tool,
        expectedTool: event.tool,
        found:        false,
        confidence:   1,
        reason:       'verifier_failed',
      };
    case 'tool_low_signal':
      return {
        claim:        event.tool,
        expectedTool: event.tool,
        found:        false,
        // Weak evidence, not proven failure — lower confidence than the
        // hard !ok kinds so downstream consumers can distinguish.
        confidence:   0.5,
        reason:       'verifier_low_signal',
      };
    case 'claim_contradicted':
      return {
        claim:        event.tool,
        expectedTool: event.tool,
        found:        false,
        confidence:   1,
        reason:       'claim_contradicted',
      };
  }
}

export class HonestyEnforcement {
  private mode: HonestyMode;

  constructor(
    mode: HonestyMode = 'enforce',
    private readonly llmAdapter?: ProviderAdapter,
    private readonly logger?: (
      level: 'info' | 'warn',
      msg: string,
    ) => void,
  ) {
    this.mode = mode;
  }

  setMode(mode: HonestyMode): void {
    this.mode = mode;
  }

  getMode(): HonestyMode {
    return this.mode;
  }

  /**
   * v4.7.0 Phase 2.3 — record deterministic unverified outcomes from
   * the per-turn tool trace. Pure function; no I/O, no side effects.
   */
  recordOutcomes(trace: HonestyTraceEntry[], uiClaims: UiClaim[] = []): HonestyEvent[] {
    const events: HonestyEvent[] = [];
    for (const t of trace) {
      if (t.error && t.handlerMutates === true) {
        events.push({
          kind:   'mutation_errored',
          tool:   t.name,
          reason: t.error,
          path:   extractPath(t.result),
        });
        continue;
      }
      if (MEMORY_TOOLS.has(t.name) && t.verified === false) {
        events.push({
          kind:   'memory_unverified',
          tool:   t.name,
          reason: 'verification failed',
        });
        continue;
      }
      // v4.11 Slice 1 — consume the per-tool verifier verdict (verifier.ts),
      // surfacing genuine failures (!ok) for every tool — shell non-zero
      // exit, file-write success:false, etc. Reached only when the two
      // checks above didn't already flag this entry, so no double-counting.
      const v = t.verification;
      if (v && !v.ok) {
        events.push({
          kind:   'tool_unverified',
          tool:   t.name,
          reason: v.reason ?? v.code,
        });
        continue;
      }
      // v4.13 Gap 1 — weak-evidence successes on MUTATING tools surface
      // too (see the HonestyEvent comment for the read-only narrowing).
      if (
        v && v.ok &&
        (v.code === 'low_signal' || v.code === 'no_progress') &&
        t.handlerMutates === true
      ) {
        events.push({
          kind:   'tool_low_signal',
          tool:   t.name,
          reason: v.reason ?? v.code,
        });
      }
    }
    // v4.11 Slice 2 — structured claim-vs-evidence contradiction. When the
    // model asserts success via a ui-event (ui_test_result{failed:0} /
    // ui_task_done{status:'success'}) but a shell_exec FAILED this turn
    // (verifier !ok), the claim contradicts the evidence. Scoped to
    // shell_exec to keep false positives low (a read-only tool's
    // low-signal result is not a failure). Turn-scoped — no per-command
    // matching, no prose parsing.
    const successClaim = uiClaims.find(isSuccessClaim);
    if (successClaim) {
      const failedShell = trace.find(
        (t) => t.name === 'shell_exec' && !!t.verification && !t.verification.ok,
      );
      if (failedShell) {
        events.push({
          kind:   'claim_contradicted',
          tool:   successClaim.name,
          reason: `${describeSuccessClaim(successClaim)}, but shell_exec failed this turn (${failedShell.verification?.reason ?? 'non-zero exit'})`,
        });
      }
    }
    return events;
  }

  /**
   * v4.7.0 Phase 2.3 — render the append-only footer used in enforce
   * mode. Caller concatenates with a blank line; we own the lines
   * inside. Format: one summary line + one row per event.
   */
  buildFooter(events: HonestyEvent[]): string {
    const lines: string[] = [];
    lines.push(`⚠️ Verifier: ${events.length} tool outcome(s) not verified this turn.`);
    for (const e of events) {
      if (e.kind === 'mutation_errored') {
        const where = e.path ? ` (path: ${e.path})` : '';
        lines.push(`- ${e.tool}${where}: errored — ${e.reason}`);
      } else if (e.kind === 'tool_unverified') {
        lines.push(`- ${e.tool}: unverified — ${e.reason}`);
      } else if (e.kind === 'tool_low_signal') {
        lines.push(`- ${e.tool}: weak evidence — ${e.reason}`);
      } else if (e.kind === 'claim_contradicted') {
        lines.push(`- ${e.tool}: contradicts evidence — ${e.reason}`);
      } else {
        lines.push(`- ${e.tool}: not verified`);
      }
    }
    return lines.join('\n');
  }

  /**
   * v4.7.0 Phase 2.3 — entry point. Records outcome events from the
   * trace, converts to legacy `HonestyFinding[]` for downstream
   * consumers, and renders an append-only footer in enforce mode.
   *
   * NEVER rewrites `response`. The returned `footer` is what the
   * caller appends; the original text is preserved verbatim.
   *
   * Off mode short-circuits without touching the trace — minimal cost
   * for users who opt out.
   */
  async check(
    response: string,
    _messages: Message[],
    trace: HonestyTraceEntry[],
    uiClaims: UiClaim[] = [],
  ): Promise<HonestyResult> {
    if (this.mode === 'off') {
      return {
        passed:           true,
        findings:         [],
        confidence:       1,
        originalResponse: response,
      };
    }
    const events = this.recordOutcomes(trace, uiClaims);
    const findings = events.map(toFinding);
    const passed = findings.length === 0;
    let footer: string | undefined;
    if (this.mode === 'enforce' && !passed) {
      footer = this.buildFooter(events);
    }
    if (!passed) {
      this.logger?.(
        'info',
        `honesty: ${events.length} unverified outcome(s) this turn`,
      );
    }
    return {
      passed,
      findings,
      confidence:       1,
      originalResponse: response,
      footer,
    };
  }
}
