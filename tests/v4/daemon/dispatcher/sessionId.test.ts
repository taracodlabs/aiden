/**
 * v4.5 Phase 5a — sessionId derivation tests.
 *
 * Covers:
 *   1. Stability across retries (same input → same id)
 *   2. Different idempotency keys → different ids (independence)
 *   3. parseTriggerSessionId round-trips
 */
import { describe, it, expect } from 'vitest';
import {
  buildTriggerSessionId,
  parseTriggerSessionId,
} from '../../../../core/v4/daemon/dispatcher/sessionId';

describe('buildTriggerSessionId', () => {
  it('is stable across retries (same idempotency key → same sessionId)', () => {
    const a = buildTriggerSessionId({ source: 'file', sourceKey: 'wat-1', idempotencyKey: '/tmp/foo.md' });
    const b = buildTriggerSessionId({ source: 'file', sourceKey: 'wat-1', idempotencyKey: '/tmp/foo.md' });
    expect(a).toBe(b);
    expect(a.startsWith('trigger:file:wat-1:')).toBe(true);
  });

  it('different idempotency keys produce different sessionIds', () => {
    const a = buildTriggerSessionId({ source: 'webhook', sourceKey: 'route-1', idempotencyKey: 'delivery-A' });
    const b = buildTriggerSessionId({ source: 'webhook', sourceKey: 'route-1', idempotencyKey: 'delivery-B' });
    expect(a).not.toBe(b);
  });

  it('null idempotency key falls back to the no-idem sentinel (still stable)', () => {
    const a = buildTriggerSessionId({ source: 'schedule', sourceKey: 'job-1', idempotencyKey: null });
    const b = buildTriggerSessionId({ source: 'schedule', sourceKey: 'job-1', idempotencyKey: null });
    expect(a).toBe(b);
    expect(a.startsWith('trigger:schedule:job-1:')).toBe(true);
  });

  it('different sources keep sessionIds disjoint even with same sourceKey/idemKey', () => {
    const a = buildTriggerSessionId({ source: 'file',  sourceKey: 'k', idempotencyKey: 'x' });
    const b = buildTriggerSessionId({ source: 'email', sourceKey: 'k', idempotencyKey: 'x' });
    expect(a).not.toBe(b);
  });
});

describe('parseTriggerSessionId', () => {
  it('round-trips a built sessionId', () => {
    const id = buildTriggerSessionId({ source: 'email', sourceKey: 't42', idempotencyKey: 'mid-abc' });
    const parsed = parseTriggerSessionId(id);
    expect(parsed).not.toBeNull();
    expect(parsed!.source).toBe('email');
    expect(parsed!.sourceKey).toBe('t42');
    expect(parsed!.idemHash.length).toBeGreaterThan(0);
  });

  it('returns null for non-trigger sessionIds (REPL, plain UUIDs)', () => {
    expect(parseTriggerSessionId('session')).toBeNull();
    expect(parseTriggerSessionId('51b8e7c1-7c6e-4b8e-a3ff-6f8e0c2ed1a4')).toBeNull();
    expect(parseTriggerSessionId('trigger:bogus')).toBeNull();
    expect(parseTriggerSessionId('trigger:file::')).toBeNull();
  });

  it('rejects unknown source labels', () => {
    expect(parseTriggerSessionId('trigger:bogus:k:hash')).toBeNull();
  });
});
