/**
 * tests/v4/identity/httpContext.test.ts — v4.9.0 Slice 7.
 */
import { describe, it, expect } from 'vitest';
import {
  injectContextHeaders,
  maybeInjectContextHeaders,
} from '../../../core/v4/identity/httpContext';
import {
  newDaemonId,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
  type ExecutionContext,
} from '../../../core/v4/identity';

function mkCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    daemonId:      newDaemonId(),
    incarnationId: newIncarnationId(),
    runId:         newRunId(),
    traceId:       newTraceId(),
    spanId:        newSpanId(),
    source:        'cli',
    attempt:       0,
    ...overrides,
  };
}

describe('injectContextHeaders — Slice 7', () => {
  it('emits traceparent + 4 X-Aiden-* headers', () => {
    const ctx = mkCtx({ requestId: 'req_abc' });
    const out = injectContextHeaders(ctx);
    expect(out['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(out['X-Request-Id']).toBe('req_abc');
    expect(out['X-Aiden-Run-Id']).toBe(ctx.runId);
    expect(out['X-Aiden-Trace-Id']).toBe(ctx.traceId);
    expect(out['X-Aiden-Span-Id']).toBe(ctx.spanId);
  });

  it('generates a fresh requestId when ctx.requestId absent', () => {
    const ctx = mkCtx();
    const out = injectContextHeaders(ctx);
    expect(out['X-Request-Id']).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it('caller headers win on key collision', () => {
    const ctx = mkCtx({ requestId: 'req_a' });
    const out = injectContextHeaders(ctx, { 'X-Request-Id': 'req_user_override', 'User-Agent': 'mine' });
    expect(out['X-Request-Id']).toBe('req_user_override');
    expect(out['User-Agent']).toBe('mine');
  });

  it('traceparent embeds the right 32+16 hex extracted from typed IDs', () => {
    const ctx = mkCtx();
    const out = injectContextHeaders(ctx);
    const expectedTrace = ctx.traceId.slice('trc_'.length);
    expect(out['traceparent']!.split('-')[1]).toBe(expectedTrace);
  });

  it('maybeInjectContextHeaders is pass-through when ctx undefined', () => {
    const out = maybeInjectContextHeaders(undefined, { 'X-Tool': 'value' });
    expect(out).toEqual({ 'X-Tool': 'value' });
  });

  it('maybeInjectContextHeaders injects when ctx provided', () => {
    const ctx = mkCtx();
    const out = maybeInjectContextHeaders(ctx, { 'X-Tool': 'v' });
    expect(out['X-Tool']).toBe('v');
    expect(out['X-Aiden-Run-Id']).toBe(ctx.runId);
  });
});
