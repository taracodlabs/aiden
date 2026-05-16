/**
 * v4.5 Phase 3 — WebhookSpec parse tests.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWebhookSpec,
  DEFAULT_WEBHOOK_SPEC,
  INSECURE_NO_AUTH,
} from '../../../../core/v4/daemon/triggers/webhookSpec';

describe('parseWebhookSpec', () => {
  it('throws when name missing', () => {
    expect(() => parseWebhookSpec({ secret: 'x' })).toThrow(/name/i);
  });

  it('throws when secret missing', () => {
    expect(() => parseWebhookSpec({ name: 'r' })).toThrow(/secret/i);
  });

  it('fills defaults', () => {
    const s = parseWebhookSpec({ name: 'r', secret: 'k' });
    expect(s.hmacFormat).toBe(DEFAULT_WEBHOOK_SPEC.hmacFormat);
    expect(s.rateLimit.perMinute).toBe(30);
    expect(s.maxBodyBytes).toBe(1_048_576);
    expect(s.idempotencyTtlMs).toBe(60 * 60 * 1000);
    expect(s.deliverOnly).toBe(false);
    expect(s.publicBound).toBe(false);
  });

  it('honors valid hmacFormat values', () => {
    for (const f of ['github', 'gitlab', 'generic'] as const) {
      expect(parseWebhookSpec({ name: 'r', secret: 'k', hmacFormat: f }).hmacFormat).toBe(f);
    }
  });

  it('rejects junk hmacFormat → default', () => {
    expect(parseWebhookSpec({ name: 'r', secret: 'k', hmacFormat: 'bogus' }).hmacFormat).toBe('generic');
  });

  it('parses INSECURE_NO_AUTH sentinel as a literal secret', () => {
    const s = parseWebhookSpec({ name: 'r', secret: INSECURE_NO_AUTH });
    expect(s.secret).toBe(INSECURE_NO_AUTH);
  });

  it('round-trips through JSON', () => {
    const s = parseWebhookSpec(JSON.stringify({ name: 'r', secret: 'k' }));
    expect(s.name).toBe('r');
  });

  it('sanitizes negative rateLimit / maxBodyBytes to defaults', () => {
    const s = parseWebhookSpec({
      name: 'r', secret: 'k',
      rateLimit: { perMinute: -1 },
      maxBodyBytes: 0,
      idempotencyTtlMs: -5,
    });
    expect(s.rateLimit.perMinute).toBe(30);
    expect(s.maxBodyBytes).toBe(1_048_576);
    expect(s.idempotencyTtlMs).toBe(60 * 60 * 1000);
  });
});
