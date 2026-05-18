/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/selfimprovement/signatureBuilder.test.ts — v4.6 Phase 3b.
 *
 * Pure-function tests for the signature builder. Each case asserts
 * the grouping semantics on a different axis (tool, category,
 * args-normalisation, volatile-key strip).
 */
import { describe, it, expect } from 'vitest';
import { buildFailureSignature } from '../../../core/v4/selfimprovement/signatureBuilder';

describe('buildFailureSignature — v4.6 Phase 3b', () => {
  it('1. tool + category only (no args) → `tool:category`', () => {
    const sig = buildFailureSignature({ toolName: 'file_read', category: 'not_found' });
    expect(sig.signature).toBe('file_read:not_found');
    expect(sig.argsHash).toBeUndefined();
  });

  it('2. same tool + same category + same args → same signature', () => {
    const a = buildFailureSignature({
      toolName: 'web_search', category: 'timeout',
      args: { q: 'recent ML papers', maxResults: 5 },
    });
    const b = buildFailureSignature({
      toolName: 'web_search', category: 'timeout',
      args: { q: 'recent ML papers', maxResults: 5 },
    });
    expect(a.signature).toBe(b.signature);
    expect(a.argsHash).toBe(b.argsHash);
    expect(a.argsHash).toMatch(/^[a-f0-9]{6}$/);
  });

  it('3. key ordering doesn\'t affect signature (deterministic stringify)', () => {
    const a = buildFailureSignature({
      toolName: 'web_search', category: 'timeout',
      args: { q: 'x', maxResults: 5 },
    });
    const b = buildFailureSignature({
      toolName: 'web_search', category: 'timeout',
      args: { maxResults: 5, q: 'x' },
    });
    expect(a.signature).toBe(b.signature);
  });

  it('4. different categories → different signatures', () => {
    const a = buildFailureSignature({
      toolName: 'file_read', category: 'not_found',
      args: { path: '/tmp/x' },
    });
    const b = buildFailureSignature({
      toolName: 'file_read', category: 'permission',
      args: { path: '/tmp/x' },
    });
    expect(a.signature).not.toBe(b.signature);
  });

  it('5. different tools → different signatures', () => {
    const a = buildFailureSignature({
      toolName: 'web_search', category: 'timeout', args: { q: 'x' },
    });
    const b = buildFailureSignature({
      toolName: 'file_read', category: 'timeout', args: { q: 'x' },
    });
    expect(a.signature).not.toBe(b.signature);
  });

  it('6. meaningfully different args → different argsHash', () => {
    const a = buildFailureSignature({
      toolName: 'file_read', category: 'not_found',
      args: { path: '/tmp/alpha' },
    });
    const b = buildFailureSignature({
      toolName: 'file_read', category: 'not_found',
      args: { path: '/tmp/beta' },
    });
    expect(a.signature).not.toBe(b.signature);
    expect(a.argsHash).not.toBe(b.argsHash);
  });

  it('7. volatile keys (timestamps, IDs) are stripped before hashing', () => {
    // Same logical args, different volatile fields → same signature.
    const a = buildFailureSignature({
      toolName: 'web_search', category: 'timeout',
      args: { q: 'hello', timestamp: 1_700_000_000_000, requestId: 'aaa' },
    });
    const b = buildFailureSignature({
      toolName: 'web_search', category: 'timeout',
      args: { q: 'hello', timestamp: 1_999_999_999_999, requestId: 'zzz' },
    });
    expect(a.signature).toBe(b.signature);
  });

  it('8. empty object args → no hash suffix (collapses to base)', () => {
    const sig = buildFailureSignature({
      toolName: 'web_search', category: 'timeout', args: {},
    });
    expect(sig.signature).toBe('web_search:timeout');
    expect(sig.argsHash).toBeUndefined();
  });

  it('9. all-volatile args → collapses to base signature', () => {
    // After stripping every key, the object is {} → no hash.
    const sig = buildFailureSignature({
      toolName: 'web_search', category: 'timeout',
      args: { timestamp: 1, requestId: 'a' },
    });
    expect(sig.signature).toBe('web_search:timeout');
  });

  it('10. null / undefined args distinguish from explicit args present', () => {
    const a = buildFailureSignature({ toolName: 'x', category: 'other' });
    const b = buildFailureSignature({ toolName: 'x', category: 'other', args: null });
    // null is a JSON value that the normalizer serialises to "null" — collapses to base.
    expect(a.signature).toBe(b.signature);
  });

  it('11. nested object args group identically across key order', () => {
    const a = buildFailureSignature({
      toolName: 'tool', category: 'network',
      args: { nested: { b: 2, a: 1 }, q: 'x' },
    });
    const b = buildFailureSignature({
      toolName: 'tool', category: 'network',
      args: { q: 'x', nested: { a: 1, b: 2 } },
    });
    expect(a.signature).toBe(b.signature);
  });

  it('12. argsHash is exactly 6 hex chars when present', () => {
    const sig = buildFailureSignature({
      toolName: 't', category: 'timeout', args: { x: 1 },
    });
    expect(sig.argsHash).toMatch(/^[a-f0-9]{6}$/);
  });
});
