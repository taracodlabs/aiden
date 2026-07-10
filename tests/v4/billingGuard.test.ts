import { describe, it, expect } from 'vitest';

import { fallbackAllowed, billingTierRank } from '../../core/v4/billingGuard';

/**
 * The paid-fallback invariant: a provider failure must never move the user
 * to a per-token PAID provider unless explicit consent is recorded for that
 * destination. Cheaper / same-cost destinations (local, free, subscription)
 * are always allowed, because none of them can produce a surprise per-token
 * bill. This is the guard that keeps a failed Claude subscription from
 * silently landing on a paid ANTHROPIC_API_KEY.
 */
describe('billing-tier fallback guard — no silent escalation to a per-token paid provider', () => {
  it('a failed subscription provider does NOT auto-select a paid provider (consent absent)', () => {
    expect(fallbackAllowed('subscription', 'paid', 'absent')).toBe(false);
  });

  it('a failed free provider does NOT auto-select a paid provider (consent absent)', () => {
    expect(fallbackAllowed('free', 'paid', 'absent')).toBe(false);
  });

  it('a failed subscription/free provider DOES fall to a free or local provider', () => {
    expect(fallbackAllowed('subscription', 'free', 'absent')).toBe(true);
    expect(fallbackAllowed('subscription', 'local', 'absent')).toBe(true);
    expect(fallbackAllowed('free', 'free', 'absent')).toBe(true);
    expect(fallbackAllowed('free', 'local', 'absent')).toBe(true);
  });

  it('explicit consent DOES allow the paid fallback (the careful-user case keeps working)', () => {
    expect(fallbackAllowed('subscription', 'paid', 'explicit')).toBe(true);
    expect(fallbackAllowed('free', 'paid', 'explicit')).toBe(true);
  });

  it('an already-paid user may fall to another paid provider (no new cost class)', () => {
    expect(fallbackAllowed('paid', 'paid', 'absent')).toBe(true);
  });

  it('ranks tiers cheapest→dearest so candidates can be tried in cost order', () => {
    expect(billingTierRank('local')).toBeLessThan(billingTierRank('free'));
    expect(billingTierRank('free')).toBeLessThan(billingTierRank('subscription'));
    expect(billingTierRank('subscription')).toBeLessThan(billingTierRank('paid'));
  });
});
