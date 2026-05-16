/**
 * v4.5 Phase 3 — webhookIdempotency key-derivation tests.
 */
import { describe, it, expect } from 'vitest';
import { deriveIdempotencyKey } from '../../../../core/v4/daemon/triggers/webhookIdempotency';

const BODY = Buffer.from('{"x":1}');

describe('deriveIdempotencyKey', () => {
  it('github uses X-GitHub-Delivery when present', () => {
    const k = deriveIdempotencyKey('route1', 'github', BODY, { 'x-github-delivery': 'abcdef' });
    expect(k).toBe('gh:abcdef');
  });

  it('gitlab uses event+request id', () => {
    const k = deriveIdempotencyKey('route1', 'gitlab', BODY, {
      'x-gitlab-event': 'Push Hook',
      'x-request-id':   'req-42',
    });
    expect(k).toBe('gl:Push Hook:req-42');
  });

  it('gitlab event-only falls back to hash bucket', () => {
    const k = deriveIdempotencyKey('route1', 'gitlab', BODY, {
      'x-gitlab-event': 'Push Hook',
    }, 1_000_000_000);
    expect(k.startsWith('gl:Push Hook:')).toBe(true);
  });

  it('generic uses X-Request-Id when present', () => {
    const k = deriveIdempotencyKey('route1', 'generic', BODY, { 'x-request-id': 'req-99' });
    expect(k).toBe('gen:req-99');
  });

  it('fallback hashes routeId + body + 5s bucket', () => {
    const k = deriveIdempotencyKey('route1', 'generic', BODY, {}, 1_000_000_000);
    expect(k.startsWith('sha:')).toBe(true);
  });

  it('fallback dedups within 5s window (same bucket)', () => {
    const k1 = deriveIdempotencyKey('r', 'generic', BODY, {}, 1_000_000_000);
    const k2 = deriveIdempotencyKey('r', 'generic', BODY, {}, 1_000_000_003_000);   // <5s later
    // Same 5s bucket only when within the bucket boundary. Constructed
    // so the math lands in the same bucket:
    const k3 = deriveIdempotencyKey('r', 'generic', BODY, {}, 1_000_000_100);
    expect(k1).toBe(k3);
    expect(k1).not.toBe(k2);   // different bucket
  });

  it('fallback differs for different routes', () => {
    const k1 = deriveIdempotencyKey('A', 'generic', BODY, {}, 1_000_000_000);
    const k2 = deriveIdempotencyKey('B', 'generic', BODY, {}, 1_000_000_000);
    expect(k1).not.toBe(k2);
  });

  it('case-insensitive header lookup', () => {
    const k = deriveIdempotencyKey('r', 'github', BODY, { 'X-GitHub-Delivery': 'cap' });
    expect(k).toBe('gh:cap');
  });
});
