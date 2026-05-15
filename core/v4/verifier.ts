/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/verifier.ts — v4.2 Phase 1: Per-tool result verifier.
 *
 * After each tool dispatch, the verifier inspects the result and
 * classifies the outcome:
 *
 *   ok            — tool produced a usable, non-failed output
 *   failed        — tool errored, returned `success: false`, or matched
 *                   a known failure shape
 *   no_progress   — tool succeeded but produced no useful signal (empty
 *                   payload, identical hash to a recent call — Phase 3
 *                   wires the hash repeat detector)
 *   low_signal    — tool succeeded but with a short / vague response
 *                   that's informative but probably won't help the
 *                   model make progress
 *   unknown       — verifier couldn't classify with confidence
 *
 * Scope (Phase 1):
 * - Pure inspection of `(toolName, args, result)` — NO goal awareness
 *   (deferred to Phase 5 / task graph).
 * - Synchronous; runs in the agent's tool-dispatch loop between
 *   `onToolCall('after', result)` and `turnState.recordToolCall(...)`.
 * - Default fallback handles ~99% of Aiden tools that return the
 *   `{ success: boolean, error?: string, ...payload }` envelope.
 * - Built-in per-tool verifiers for 5 high-signal tools where the
 *   default envelope inspection isn't sufficient: `shell_exec`,
 *   `web_search`, `file_write`, `file_read`, `web_fetch`.
 * - Behind the `AIDEN_TCE=1` gate — same flag as TurnState. When
 *   disabled, the agent skips verifier construction entirely.
 *
 * Out of scope (deferred phases):
 * - Phase 2 — typed failure reason taxonomy (timeout / auth /
 *   hallucination / network — separate from per-tool verifier).
 * - Phase 3 — RecoveryReport (uses verifier output + Phase 2 classifier).
 * - Phase 4 — checkpoint/restore (uses Phase 3 state shape).
 * - Phase 5 — task-graph sub-step verification (extends VerifierFn
 *   signature with optional `subGoal` argument; backward-compatible).
 *
 * The design intentionally mirrors a layered-decision pattern from the
 * reference system's tool-guardrail module: a pure classifier function
 * driving a controller's threshold counters, with per-tool overrides
 * for the small set of tools where heuristic inspection is too coarse.
 */

import type { ToolCallResult } from '../../providers/v4/types';

// ── Public types ────────────────────────────────────────────────────────────

/** Outcome codes for a single verification. */
export type VerificationCode =
  | 'ok'
  | 'failed'
  | 'no_progress'
  | 'low_signal'
  | 'unknown';

/** Returned by every VerifierFn. */
export interface VerificationResult {
  /** Did the tool produce a usable, non-failed output? */
  ok:          boolean;
  /** 0.0–1.0 — how confident the verifier is in its classification. */
  confidence:  number;
  /** Machine-readable code. */
  code:        VerificationCode;
  /** Short human-readable reason; surfaced to diagnostics / future RecoveryReport. */
  reason?:     string;
  /** Optional model-facing nudge if !ok. Phase 1 records it; Phase 3 wires it into hint messages. */
  suggestion?: string;
}

/**
 * Pure function signature. Pure: no side effects, no async, no network.
 * Phase 5 extends with an optional `subGoal` argument; the registry
 * resolves verifiers by tool name only — backward-compatible.
 */
export type VerifierFn = (
  toolName: string,
  args:     unknown,
  result:   ToolCallResult,
) => VerificationResult;

/**
 * Per-tool override registry with a default-fallback resolver. Cheap
 * to construct; safe to keep instantiated even when AIDEN_TCE=0
 * because nothing runs unless `resolve(...)` is called by the agent
 * loop (which itself is gated).
 */
export class VerifierRegistry {
  private readonly overrides: Map<string, VerifierFn> = new Map();
  private readonly fallback:  VerifierFn;

  constructor(fallback: VerifierFn = defaultVerifier) {
    this.fallback = fallback;
  }

  register(toolName: string, fn: VerifierFn): void {
    this.overrides.set(toolName, fn);
  }

  resolve(toolName: string): VerifierFn {
    return this.overrides.get(toolName) ?? this.fallback;
  }

  /** Direct lookup for tests — returns true when a per-tool override is registered. */
  hasOverride(toolName: string): boolean {
    return this.overrides.has(toolName);
  }
}

// ── Default fallback verifier ──────────────────────────────────────────────

const SHORT_RESPONSE_THRESHOLD = 50;       // chars — below this, raw strings are flagged low_signal
const RAW_STRING_SCAN_WINDOW   = 500;      // chars — generic error keyword scan only looks at the head

/**
 * Heuristic default. Handles five result shapes in priority order:
 *
 *   1. Outer envelope error  → ToolCallResult.error set → failed (conf 1.0)
 *   2. Inner `success: false` → typed failure (conf 1.0)
 *   3. Inner `success: true`  → typed ok (conf 1.0)
 *   4. Raw string < 50 chars  → low_signal (conf 0.4, ok: true)
 *   5. Raw string with error keywords in first 500 chars → failed (conf 0.6)
 *
 * Anything else (typed object without `success`, non-empty string
 * without error keywords) is `ok` at conf 0.7 — the verifier doesn't
 * have enough signal to be more precise without a per-tool override.
 */
export const defaultVerifier: VerifierFn = (
  _toolName: string,
  _args:     unknown,
  result:    ToolCallResult,
): VerificationResult => {
  // 1. Outer envelope error — executor threw or wrapped a known failure.
  if (typeof result.error === 'string' && result.error.length > 0) {
    return {
      ok:         false,
      confidence: 1.0,
      code:       'failed',
      reason:     result.error,
    };
  }

  const inner = result.result;

  // 2 + 3. Typed `{ success: boolean }` envelope — the common Aiden shape.
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    const obj = inner as Record<string, unknown>;
    if (obj.success === false) {
      const reason =
        typeof obj.error === 'string' && obj.error.length > 0
          ? obj.error
          : 'tool returned success:false';
      return {
        ok:         false,
        confidence: 1.0,
        code:       'failed',
        reason,
      };
    }
    if (obj.success === true) {
      return { ok: true, confidence: 1.0, code: 'ok' };
    }
    // No `success` field — fall through to confidence-0.7 default.
    return { ok: true, confidence: 0.7, code: 'ok' };
  }

  // 4 + 5. Raw string payload (the webSearch / deepResearch / openUrl shape).
  if (typeof inner === 'string') {
    const trimmed = inner.trim();
    if (trimmed.length === 0) {
      return {
        ok:         true,
        confidence: 0.4,
        code:       'low_signal',
        reason:     'empty string result',
      };
    }
    if (trimmed.length < SHORT_RESPONSE_THRESHOLD) {
      return {
        ok:         true,
        confidence: 0.4,
        code:       'low_signal',
        reason:     `short result (${trimmed.length} chars)`,
      };
    }
    const head = trimmed.slice(0, RAW_STRING_SCAN_WINDOW).toLowerCase();
    if (
      head.startsWith('error') ||
      head.includes('"error"') ||
      head.includes('"failed"')
    ) {
      return {
        ok:         false,
        confidence: 0.6,
        code:       'failed',
        reason:     'error keywords detected in raw string head',
      };
    }
    return { ok: true, confidence: 0.7, code: 'ok' };
  }

  // null / undefined / array / number — no clear signal.
  if (inner === null || inner === undefined) {
    return {
      ok:         true,
      confidence: 0.5,
      code:       'unknown',
      reason:     'null result',
    };
  }
  return { ok: true, confidence: 0.5, code: 'unknown' };
};

// ── Built-in per-tool verifiers ────────────────────────────────────────────

/**
 * `shell_exec` — inspect `exitCode` directly. A successful exit with
 * empty stdout is suspicious (probe with no output) — surface as
 * `low_signal` rather than ok-with-high-confidence so the loop
 * controller can weight it.
 */
export const shellExecVerifier: VerifierFn = (_n, _a, result) => {
  if (typeof result.error === 'string' && result.error.length > 0) {
    return { ok: false, confidence: 1.0, code: 'failed', reason: result.error };
  }
  const inner = result.result as Record<string, unknown> | null;
  if (inner === null || typeof inner !== 'object') {
    return { ok: false, confidence: 0.5, code: 'unknown', reason: 'non-object shell_exec result' };
  }
  // Typed-failure envelope short-circuit — a wrapper returning
  // `{success: false}` without exitCode is still definitively failed.
  if (inner.success === false) {
    return {
      ok:         false,
      confidence: 1.0,
      code:       'failed',
      reason:     typeof inner.error === 'string' ? inner.error : 'success:false',
    };
  }
  const exitCode = typeof inner.exitCode === 'number' ? inner.exitCode : undefined;
  if (exitCode === undefined) {
    // Some wrappers omit exitCode on a successful run when the
    // underlying command was trivial (e.g. a noop). Trust the typed
    // success flag if present; otherwise we genuinely don't know.
    if (inner.success === true) {
      return { ok: true, confidence: 0.7, code: 'ok' };
    }
    return { ok: false, confidence: 0.5, code: 'unknown', reason: 'missing exitCode' };
  }
  if (exitCode !== 0) {
    return {
      ok:         false,
      confidence: 1.0,
      code:       'failed',
      reason:     `non-zero exit (${exitCode})`,
      suggestion: 'Inspect stderr and adjust the command — repeating the same invocation will not help.',
    };
  }
  const stdout = typeof inner.stdout === 'string' ? inner.stdout.trim() : '';
  if (stdout.length === 0) {
    return {
      ok:         true,
      confidence: 0.4,
      code:       'low_signal',
      reason:     'exit 0 with empty stdout',
    };
  }
  return { ok: true, confidence: 1.0, code: 'ok' };
};

/**
 * `web_search` — returns a raw string (synthesised answer). Short
 * responses are low-signal, not failures (often "no results found"
 * IS the answer). Generic error-keyword scan applies.
 */
export const webSearchVerifier: VerifierFn = (_n, _a, result) => {
  if (typeof result.error === 'string' && result.error.length > 0) {
    return { ok: false, confidence: 1.0, code: 'failed', reason: result.error };
  }
  const inner = result.result;
  if (typeof inner !== 'string') {
    // Some adapters might wrap the string in `{ success, result }`.
    return defaultVerifier(_n, _a, result);
  }
  const trimmed = inner.trim();
  if (trimmed.length === 0) {
    return {
      ok:         true,
      confidence: 0.4,
      code:       'low_signal',
      reason:     'empty web_search result',
      suggestion: 'Try a different query or use web_fetch with a known URL.',
    };
  }
  if (trimmed.length < SHORT_RESPONSE_THRESHOLD) {
    return {
      ok:         true,
      confidence: 0.4,
      code:       'low_signal',
      reason:     `short web_search result (${trimmed.length} chars)`,
    };
  }
  return { ok: true, confidence: 0.9, code: 'ok' };
};

/**
 * `file_write` — verify the write actually happened. We trust the
 * tool's `success` flag but additionally require `bytesWritten > 0`
 * when present (catches the "wrote 0 bytes" pathology).
 */
export const fileWriteVerifier: VerifierFn = (_n, _a, result) => {
  if (typeof result.error === 'string' && result.error.length > 0) {
    return { ok: false, confidence: 1.0, code: 'failed', reason: result.error };
  }
  const inner = result.result as Record<string, unknown> | null;
  if (inner === null || typeof inner !== 'object') {
    return { ok: false, confidence: 0.5, code: 'unknown', reason: 'non-object file_write result' };
  }
  if (inner.success === false) {
    return {
      ok:         false,
      confidence: 1.0,
      code:       'failed',
      reason:     typeof inner.error === 'string' ? inner.error : 'success:false',
    };
  }
  if (typeof inner.bytesWritten === 'number' && inner.bytesWritten === 0) {
    return {
      ok:         true,
      confidence: 0.4,
      code:       'low_signal',
      reason:     'wrote 0 bytes',
    };
  }
  return { ok: true, confidence: 1.0, code: 'ok' };
};

/**
 * `file_read` — verify content non-empty (a deliberately-empty file
 * is rare; usually means a path mismatch or stale read). Trusts the
 * tool's `success` flag.
 */
export const fileReadVerifier: VerifierFn = (_n, _a, result) => {
  if (typeof result.error === 'string' && result.error.length > 0) {
    return { ok: false, confidence: 1.0, code: 'failed', reason: result.error };
  }
  const inner = result.result as Record<string, unknown> | null;
  if (inner === null || typeof inner !== 'object') {
    return { ok: false, confidence: 0.5, code: 'unknown', reason: 'non-object file_read result' };
  }
  if (inner.success === false) {
    return {
      ok:         false,
      confidence: 1.0,
      code:       'failed',
      reason:     typeof inner.error === 'string' ? inner.error : 'success:false',
    };
  }
  const content = typeof inner.content === 'string' ? inner.content : '';
  if (content.length === 0) {
    return {
      ok:         true,
      confidence: 0.4,
      code:       'low_signal',
      reason:     'empty file content',
    };
  }
  return { ok: true, confidence: 1.0, code: 'ok' };
};

/**
 * `web_fetch` (and aliases) — verify the body is substantive. A
 * < 100 char fetch body is almost certainly a redirect / blank
 * page / soft-block; surface as low_signal.
 */
const WEB_FETCH_MIN_BODY = 100;

export const webFetchVerifier: VerifierFn = (_n, _a, result) => {
  if (typeof result.error === 'string' && result.error.length > 0) {
    return { ok: false, confidence: 1.0, code: 'failed', reason: result.error };
  }
  const inner = result.result;
  // Two shapes: typed `{ success, content/body }` or raw string.
  if (typeof inner === 'string') {
    if (inner.trim().length < WEB_FETCH_MIN_BODY) {
      return {
        ok:         true,
        confidence: 0.4,
        code:       'low_signal',
        reason:     `short body (${inner.trim().length} chars)`,
        suggestion: 'Try a different URL or check whether the page requires auth.',
      };
    }
    return { ok: true, confidence: 0.9, code: 'ok' };
  }
  if (inner !== null && typeof inner === 'object') {
    const obj = inner as Record<string, unknown>;
    if (obj.success === false) {
      return {
        ok:         false,
        confidence: 1.0,
        code:       'failed',
        reason:     typeof obj.error === 'string' ? obj.error : 'success:false',
      };
    }
    const body =
      typeof obj.content === 'string' ? obj.content :
      typeof obj.body    === 'string' ? obj.body    :
      typeof obj.text    === 'string' ? obj.text    : '';
    if (body.trim().length < WEB_FETCH_MIN_BODY) {
      return {
        ok:         true,
        confidence: 0.4,
        code:       'low_signal',
        reason:     `short body (${body.trim().length} chars)`,
      };
    }
    return { ok: true, confidence: 1.0, code: 'ok' };
  }
  return defaultVerifier(_n, _a, result);
};

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Builds a registry pre-wired with the 5 built-in per-tool verifiers.
 * The agent constructs one of these in `runConversation` when TCE is
 * enabled. Plugin authors can register their own via the returned
 * registry instance — Phase 1 doesn't expose a public registration
 * API, but the foundation is here.
 */
export function buildDefaultRegistry(): VerifierRegistry {
  const reg = new VerifierRegistry();
  reg.register('shell_exec', shellExecVerifier);
  reg.register('web_search', webSearchVerifier);
  reg.register('file_write', fileWriteVerifier);
  reg.register('file_read',  fileReadVerifier);
  reg.register('web_fetch',  webFetchVerifier);
  // Aliases — same verifier handles related shapes.
  reg.register('fetch_page', webFetchVerifier);
  reg.register('web_page',   webFetchVerifier);
  return reg;
}
