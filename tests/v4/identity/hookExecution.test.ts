/**
 * tests/v4/identity/hookExecution.test.ts — v4.9.0 Slice 7.
 */
import { describe, it, expect } from 'vitest';
import {
  executeHookWithBoundary,
  HookTimeoutError,
} from '../../../core/v4/identity/hookExecution';
import {
  newDaemonId,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
  type ExecutionContext,
} from '../../../core/v4/identity';

function mkCtx(): ExecutionContext {
  return {
    daemonId:      newDaemonId(),
    incarnationId: newIncarnationId(),
    runId:         newRunId(),
    traceId:       newTraceId(),
    spanId:        newSpanId(),
    source:        'cli',
    attempt:       0,
  };
}

describe('executeHookWithBoundary — Slice 7', () => {
  it('returns {outcome:ok, value} on success', async () => {
    const ctx = mkCtx();
    const r = await executeHookWithBoundary(ctx, { hookName: 'h', pluginId: 'p' }, async () => 42);
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') expect(r.value).toBe(42);
  });

  it('returns {outcome:error, error} on throw — does NOT rethrow', async () => {
    const ctx = mkCtx();
    const r = await executeHookWithBoundary(ctx, { hookName: 'h', pluginId: 'p' }, async () => {
      throw new TypeError('boom');
    });
    expect(r.outcome).toBe('error');
    if (r.outcome === 'error') {
      expect(r.error.name).toBe('TypeError');
      expect(r.error.message).toBe('boom');
    }
  });

  it('returns {outcome:timeout, error:HookTimeoutError} on timeout', async () => {
    const ctx = mkCtx();
    const r = await executeHookWithBoundary(
      ctx,
      { hookName: 'slow', pluginId: 'p', timeoutMs: 30 },
      () => new Promise<string>((res) => setTimeout(() => res('late'), 200)),
    );
    expect(r.outcome).toBe('timeout');
    if (r.outcome === 'timeout') {
      expect(r.error).toBeInstanceOf(HookTimeoutError);
      expect(r.error.message).toMatch(/timed out after 30ms/);
    }
  });

  it('non-Error throws are wrapped into Error', async () => {
    const ctx = mkCtx();
    const r = await executeHookWithBoundary(ctx, { hookName: 'h', pluginId: 'p' }, async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'just a string';
    });
    expect(r.outcome).toBe('error');
    if (r.outcome === 'error') expect(r.error.message).toBe('just a string');
  });

  it('default timeout = 5000ms; fast hook completes well under', async () => {
    const ctx = mkCtx();
    const r = await executeHookWithBoundary(ctx, { hookName: 'h', pluginId: 'p' }, async () => 'fast');
    expect(r.outcome).toBe('ok');
  });
});
