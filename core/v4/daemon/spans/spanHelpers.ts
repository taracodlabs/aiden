/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/spans/spanHelpers.ts — v4.9.0 Slice 5.
 *
 * `withSpan` is the ergonomic primitive every Slice 6+ caller will use
 * to instrument a unit of work: tool dispatch, hook firing, LLM call,
 * subagent fanout, etc. Each call:
 *
 *   1. Forks a child `ExecutionContext` via `childSpan(parent)` so the
 *      new `span_id` is set and `parent_span_id` chains to the parent.
 *   2. Opens a row in `spans` via `openSpan(db, ...)`.
 *   3. Calls `fn(childCtx)` inside a `runWithContext(childCtx, ...)`
 *      frame so any nested `withSpan` or `requireContext()` reaches
 *      the new ambient context.
 *   4. On success: closes the span with `status='ok'`.
 *   5. On thrown error: closes with `status='error'` + `error_class` +
 *      `error_message`, then rethrows so the caller's catch chain
 *      still runs.
 *
 * If the caller has no ambient context, `withSpan` falls back to
 * "no-op the span" — logs a warning via the supplied logger callback
 * but still runs `fn` with whatever ctx (or undefined) the caller had.
 * This matches the project rule "no instrumentation primitive throws
 * because context is missing" — Slice 5 must not turn a missing-context
 * scenario into a 500.
 */

import { createHash } from 'node:crypto';
import type { Db } from '../db/connection';
import {
  childSpan,
  currentContext,
  runWithContext,
  reportMissingContext,
  type ExecutionContext,
} from '../../identity';
import { openSpan, closeSpan, type SpanKind } from './spanStore';

/** Side-effect class derived from ToolHandler metadata. */
export type SideEffectClass = 'read' | 'write' | 'mutating' | 'destructive';

/** Stable input fingerprint — sha256 hex, first 16 chars. */
export function shortInputFingerprint(args: Record<string, unknown>): string {
  const canon = canonicaliseForHash(args);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

function canonicaliseForHash(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(canonicaliseForHash);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonicaliseForHash((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

// v4.9.0 Slice 8 — map SpanKind → EnforcementKind so the enforcement
// layer's per-kind config buckets line up with the span taxonomy.
function spanKindToEnforcementKind(k: SpanKind):
  'tool' | 'llm' | 'http_outbound' | 'subprocess' | 'memory_write' | 'hook' {
  switch (k) {
    case 'llm':        return 'llm';
    case 'tool':       return 'tool';
    case 'hook':       return 'hook';
    case 'memory':     return 'memory_write';
    case 'http':       return 'http_outbound';
    case 'subprocess': return 'subprocess';
    case 'subagent':
    case 'other':
    default:           return 'tool';
  }
}

export interface WithSpanOptions {
  kind:        SpanKind;
  name:        string;
  attrs?:      Record<string, unknown>;
  /** Optional run / attempt linkage. */
  runId?:      number;
  attemptId?:  string;
  /**
   * Logger callback used to surface the no-context degraded path. The
   * caller is expected to wire its own structured logger here; if
   * omitted, the warning is silently dropped.
   */
  warn?:       (msg: string) => void;
}

/**
 * Run `fn` inside an instrumented child span. See file header for the
 * detailed semantics; the short version is: opens a span, runs the fn
 * with that ctx installed, closes the span, rethrows on error.
 */
export async function withSpan<T>(
  db:    Db,
  opts:  WithSpanOptions,
  fn:    (childCtx: ExecutionContext) => Promise<T>,
): Promise<T> {
  const parent = currentContext();
  if (!parent) {
    // v4.9.0 Slice 8 — enforcement (counter + strict-throw) is
    // additive to the original warn contract. Pass `warn: undefined`
    // so the enforcement layer doesn't double-log; spanHelpers owns
    // the opts.warn invocation below.
    reportMissingContext(spanKindToEnforcementKind(opts.kind), `${opts.kind}/${opts.name}`);
    if (opts.warn) {
      try { opts.warn(`[span] withSpan(${opts.kind}/${opts.name}) — no ambient context, dropping span`); }
      catch { /* logger may not be wired yet — ignore */ }
    }
    // Build a minimal stand-in ctx so the inner fn still gets a value
    // shaped like ExecutionContext (callers may read `.runId` etc.).
    return fn({
      daemonId:      '',
      incarnationId: '',
      runId:         '',
      traceId:       '',
      spanId:        '',
      source:        'unknown',
      attempt:       0,
    });
  }
  const child = childSpan(parent);
  openSpan(db, {
    ctx:       child,
    kind:      opts.kind,
    name:      opts.name,
    attrs:     opts.attrs,
    runId:     opts.runId,
    attemptId: opts.attemptId,
  });
  try {
    const out = await runWithContext(child, () => fn(child));
    closeSpan(db, { spanId: child.spanId, status: 'ok' });
    return out;
  } catch (err) {
    const eClass = err instanceof Error ? err.name : 'NonError';
    const eMsg   = err instanceof Error ? err.message : String(err);
    closeSpan(db, {
      spanId:       child.spanId,
      status:       'error',
      errorClass:   eClass,
      errorMessage: eMsg,
    });
    throw err;
  }
}

// v4.9.0 Slice 6 — ergonomic helpers for the two highest-volume span
// kinds (tool dispatch + LLM call) so wiring sites can express intent
// in one line. Both delegate to `withSpan` after shaping kind/name/attrs.

export interface ToolSpanOptions {
  toolName:         string;
  inputFingerprint: string;
  sideEffectClass:  SideEffectClass;
  attemptNumber?:   number;
  runId?:           number;
  attemptId?:       string;
  warn?:            (msg: string) => void;
}

/**
 * Wrap a tool execution. The span carries `kind:'tool'`, `name:<toolName>`,
 * and attrs `{ input_fingerprint, side_effect_class, attempt_number }`.
 * If no ambient ExecutionContext is active, this no-ops the span
 * (project rule: instrumentation primitives never throw because
 * context is missing) and still runs `fn`.
 */
export async function withToolSpan<T>(
  db:   Db,
  opts: ToolSpanOptions,
  fn:   (childCtx: ExecutionContext) => Promise<T>,
): Promise<T> {
  return withSpan(
    db,
    {
      kind:      'tool',
      name:      opts.toolName,
      attrs:     {
        input_fingerprint: opts.inputFingerprint,
        side_effect_class: opts.sideEffectClass,
        attempt_number:    opts.attemptNumber ?? 1,
      },
      runId:     opts.runId,
      attemptId: opts.attemptId,
      warn:      opts.warn,
    },
    fn,
  );
}

export interface LlmSpanOptions {
  model:    string;
  provider: string;
  runId?:   number;
  attemptId?: string;
  warn?:    (msg: string) => void;
}

/**
 * Wrap an LLM provider call. The span carries `kind:'llm'`,
 * `name:<model>`. Tokens / finish-reason / cost are unknown at
 * open-time, so the `fn` receives a `patchAttrs(attrs)` callback to
 * back-fill them after the response lands. The patch is applied via
 * `closeSpan({attrsPatch})` on the success path.
 */
export async function withLlmSpan<T>(
  db:   Db,
  opts: LlmSpanOptions,
  fn:   (
    childCtx:    ExecutionContext,
    patchAttrs:  (attrs: Record<string, unknown>) => void,
  ) => Promise<T>,
): Promise<T> {
  const parent = currentContext();
  if (!parent) {
    // v4.9.0 Slice 8 — enforcement (counter + strict-throw).
    reportMissingContext('llm', `llm/${opts.model}`);
    if (opts.warn) {
      try { opts.warn(`[span] withLlmSpan(${opts.model}) — no ambient context, dropping span`); }
      catch { /* noop */ }
    }
    // Stand-in ctx, no-op patch.
    return fn(
      { daemonId:'', incarnationId:'', runId:'', traceId:'', spanId:'',
        source:'unknown', attempt:0 },
      () => { /* noop */ },
    );
  }
  const child = childSpan(parent);
  const initialAttrs: Record<string, unknown> = {
    model:    opts.model,
    provider: opts.provider,
  };
  openSpan(db, {
    ctx:       child,
    kind:      'llm',
    name:      opts.model,
    attrs:     initialAttrs,
    runId:     opts.runId,
    attemptId: opts.attemptId,
  });
  let patched: Record<string, unknown> | null = null;
  const patchAttrs = (attrs: Record<string, unknown>): void => {
    patched = { ...(patched ?? {}), ...attrs };
  };
  try {
    const out = await runWithContext(child, () => fn(child, patchAttrs));
    closeSpan(db, {
      spanId:     child.spanId,
      status:     'ok',
      attrsPatch: patched ?? undefined,
    });
    return out;
  } catch (err) {
    const eClass = err instanceof Error ? err.name : 'NonError';
    const eMsg   = err instanceof Error ? err.message : String(err);
    closeSpan(db, {
      spanId:       child.spanId,
      status:       'error',
      errorClass:   eClass,
      errorMessage: eMsg,
      attrsPatch:   patched ?? undefined,
    });
    throw err;
  }
}

export interface HookSpanOptions {
  hookName:   string;
  timeoutMs?: number;
  warn?:      (msg: string) => void;
}

/**
 * Wrap a hook execution with a 5s timeout (configurable). The hook
 * system isn't wired yet (Slice 9 work), but this helper is the seam
 * Slice 9 will call from. Returns `null` on timeout, error, or
 * missing-context degraded path so callers can safely continue.
 */
export async function runHookWithSpan<T>(
  db:   Db,
  opts: HookSpanOptions,
  fn:   (childCtx: ExecutionContext) => Promise<T>,
): Promise<T | null> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const parent = currentContext();
  if (!parent) {
    // v4.9.0 Slice 8 — enforcement (counter + strict-throw).
    reportMissingContext('hook', `hook/${opts.hookName}`);
    if (opts.warn) {
      try { opts.warn(`[span] runHookWithSpan(${opts.hookName}) — no ambient context, dropping span`); }
      catch { /* noop */ }
    }
    try { return await fn({ daemonId:'', incarnationId:'', runId:'', traceId:'', spanId:'', source:'unknown', attempt:0 }); }
    catch { return null; }
  }
  const child = childSpan(parent);
  openSpan(db, { ctx: child, kind: 'hook', name: opts.hookName });
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HookTimeoutError(opts.hookName, timeoutMs)), timeoutMs);
    });
    const work = runWithContext(child, () => fn(child));
    const out = await Promise.race([work, timeoutPromise]);
    if (timer) clearTimeout(timer);
    closeSpan(db, { spanId: child.spanId, status: 'ok' });
    return out as T;
  } catch (err) {
    if (timer) clearTimeout(timer);
    const isTimeout = err instanceof HookTimeoutError;
    closeSpan(db, {
      spanId:       child.spanId,
      status:       'error',
      errorClass:   isTimeout ? 'HookTimeout' : (err instanceof Error ? err.name : 'NonError'),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

class HookTimeoutError extends Error {
  constructor(hookName: string, ms: number) {
    super(`hook '${hookName}' timed out after ${ms}ms`);
    this.name = 'HookTimeout';
  }
}
