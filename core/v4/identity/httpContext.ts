/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/httpContext.ts — v4.9.0 Slice 7.
 *
 * Inject outbound HTTP headers carrying ExecutionContext correlation
 * data so downstream services + log aggregators can stitch the call
 * back to its originating run/trace/span. Emits both:
 *
 *   - W3C-standard `traceparent` (32-hex/16-hex/sampled)
 *   - `X-Aiden-*` companion headers for fine-grained run/incarnation
 *     correlation that doesn't fit in `traceparent`
 *
 * `injectContextHeaders` is pure — it does not read ambient context
 * itself. Callers pass an explicit ctx (either current or one they
 * forked). Outside a `runWithContext` frame, callers can pass
 * `currentContext()` and receive the same headers, or short-circuit
 * to skip header injection entirely.
 */

import { emitTraceparent, stripPrefix } from './traceparent';
import { newRequestId } from './ids';
import type { ExecutionContext } from './executionContext';
import { reportMissingContext } from './enforcement';

/**
 * Headers Aiden adds to outbound requests when an ExecutionContext
 * is active. Caller-supplied headers in the merge target win on key
 * collision so a tool that needs to override (e.g. `User-Agent`) can.
 */
export function injectContextHeaders(
  ctx:     ExecutionContext,
  headers: Record<string, string> = {},
): Record<string, string> {
  const traceparent = (() => {
    try { return emitTraceparent(stripPrefix(ctx.traceId, 'trc_'), stripPrefix(ctx.spanId, 'spn_'), true); }
    catch { return undefined; }
  })();
  const out: Record<string, string> = {};
  if (traceparent)         out['traceparent']      = traceparent;
  out['X-Request-Id']      = ctx.requestId ?? newRequestId();
  out['X-Aiden-Run-Id']    = ctx.runId;
  out['X-Aiden-Trace-Id']  = ctx.traceId;
  out['X-Aiden-Span-Id']   = ctx.spanId;
  // Caller-supplied headers win on collision.
  return { ...out, ...headers };
}

/**
 * Convenience: pass-through helper when the caller may or may not
 * have a context. Returns the original headers unchanged when ctx
 * is undefined (no trace propagation outside a context frame).
 */
export function maybeInjectContextHeaders(
  ctx:     ExecutionContext | undefined,
  headers: Record<string, string> = {},
): Record<string, string> {
  if (ctx) return injectContextHeaders(ctx, headers);
  // v4.9.0 Slice 8 — report missing-context on the outbound HTTP path.
  // 'silent' / 'warn' degrade to pass-through (no trace propagation
  // outside a context frame); 'strict' throws via the enforcement.
  reportMissingContext('http_outbound', 'maybeInjectContextHeaders');
  return headers;
}
