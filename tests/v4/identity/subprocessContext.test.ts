/**
 * tests/v4/identity/subprocessContext.test.ts — v4.9.0 Slice 7.
 */
import { describe, it, expect } from 'vitest';
import {
  spawnEnvWithContext,
  readContextFromEnv,
} from '../../../core/v4/identity/subprocessContext';
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
    attempt:       2,
    requestId:     'req_test',
    sessionId:     'sess-x',
    triggerId:     'trg_y',
    ...overrides,
  };
}

describe('subprocessContext — Slice 7', () => {
  it('spawnEnvWithContext stamps all 10 AIDEN_* env vars', () => {
    const ctx = mkCtx();
    const env = spawnEnvWithContext(ctx, {});
    expect(env.AIDEN_DAEMON_ID).toBe(ctx.daemonId);
    expect(env.AIDEN_INCARNATION_ID).toBe(ctx.incarnationId);
    expect(env.AIDEN_RUN_ID).toBe(ctx.runId);
    expect(env.AIDEN_TRACE_ID).toBe(ctx.traceId);
    expect(env.AIDEN_PARENT_SPAN_ID).toBe(ctx.spanId);
    expect(env.AIDEN_REQUEST_ID).toBe('req_test');
    expect(env.AIDEN_SESSION_ID).toBe('sess-x');
    expect(env.AIDEN_TRIGGER_ID).toBe('trg_y');
    expect(env.AIDEN_SOURCE).toBe('cli');
    expect(env.AIDEN_ATTEMPT).toBe('2');
  });

  it('AIDEN_* keys win over base env (security)', () => {
    const ctx = mkCtx();
    const env = spawnEnvWithContext(ctx, { AIDEN_RUN_ID: 'fakerun', AIDEN_DAEMON_ID: 'fakedmn' });
    expect(env.AIDEN_RUN_ID).toBe(ctx.runId);
    expect(env.AIDEN_DAEMON_ID).toBe(ctx.daemonId);
  });

  it('readContextFromEnv roundtrips with fresh spanId', () => {
    const ctx = mkCtx();
    const env = spawnEnvWithContext(ctx, {});
    const out = readContextFromEnv(env)!;
    expect(out.daemonId).toBe(ctx.daemonId);
    expect(out.incarnationId).toBe(ctx.incarnationId);
    expect(out.runId).toBe(ctx.runId);
    expect(out.traceId).toBe(ctx.traceId);
    // Child's spanId is FRESH; parent's spanId becomes parentSpanId.
    expect(out.spanId).not.toBe(ctx.spanId);
    expect(out.spanId).toMatch(/^spn_[0-9a-f]{32}$/);
    expect(out.parentSpanId).toBe(ctx.spanId);
    expect(out.requestId).toBe('req_test');
    expect(out.sessionId).toBe('sess-x');
    expect(out.triggerId).toBe('trg_y');
    expect(out.attempt).toBe(2);
    expect(out.source).toBe('cli');
  });

  it('returns null when any of the 3 required env vars are missing', () => {
    expect(readContextFromEnv({})).toBeNull();
    expect(readContextFromEnv({ AIDEN_DAEMON_ID: 'd' })).toBeNull();
    expect(readContextFromEnv({ AIDEN_DAEMON_ID: 'd', AIDEN_INCARNATION_ID: 'i' })).toBeNull();
  });

  it('source falls back to "subagent" on invalid env', () => {
    const ctx = mkCtx();
    const env = spawnEnvWithContext(ctx, {});
    env.AIDEN_SOURCE = 'not-a-source';
    const out = readContextFromEnv(env)!;
    expect(out.source).toBe('subagent');
  });

  it('attempt falls back to 1 on invalid value', () => {
    const ctx = mkCtx();
    const env = spawnEnvWithContext(ctx, {});
    env.AIDEN_ATTEMPT = 'NaN';
    const out = readContextFromEnv(env)!;
    expect(out.attempt).toBe(1);
  });

  it('empty optional env values are dropped (not stored as empty strings)', () => {
    const ctx = mkCtx({ requestId: undefined, sessionId: undefined, triggerId: undefined });
    const env = spawnEnvWithContext(ctx, {});
    const out = readContextFromEnv(env)!;
    expect(out.requestId).toBeUndefined();
    expect(out.sessionId).toBeUndefined();
    expect(out.triggerId).toBeUndefined();
  });
});
