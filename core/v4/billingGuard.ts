/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/billingGuard.ts — the paid-fallback invariant.
 *
 * When a selected provider fails to resolve at boot (expired OAuth, missing
 * key, removed provider), the resilience path looks for another provider that
 * works. That convenience must never quietly move the user onto a per-token
 * PAID provider they didn't choose — the exact consent violation this guard
 * exists to close. A user who signed in with a flat-fee subscription, on token
 * expiry, must not be silently billed against a pay-as-you-go API key sitting
 * in their environment.
 *
 * The rule: landing on a `paid` (per-token) provider is the only guarded
 * transition. `local` / `free` / `subscription` destinations never produce a
 * surprise per-token bill, so they are always allowed. A `paid` destination is
 * allowed only when the user is already on a paid tier (no new cost class) or
 * has recorded explicit consent for that destination.
 */

export type BillingTier = 'local' | 'free' | 'subscription' | 'paid';
export type PaidFallbackConsent = 'explicit' | 'absent';

const TIER_RANK: Record<BillingTier, number> = {
  local: 0,
  free: 1,
  subscription: 2,
  paid: 3,
};

/** Cheapest→dearest ordinal, so fallback candidates can be tried in cost order. */
export function billingTierRank(tier: BillingTier): number {
  return TIER_RANK[tier];
}

/**
 * May a provider failure fall back to `candidateTier` (with `candidateConsent`
 * recorded for that destination), given the user was on `fromTier`?
 *
 * Only escalation onto a per-token `paid` provider is gated. Everything cheaper
 * or same-cost is always allowed.
 */
export function fallbackAllowed(
  fromTier: BillingTier,
  candidateTier: BillingTier,
  candidateConsent: PaidFallbackConsent,
): boolean {
  // Local / free / subscription destinations can never produce a surprise
  // per-token bill — always allowed as a fallback.
  if (candidateTier !== 'paid') return true;
  // Destination is a per-token paid provider. Allowed only when the user is
  // already paying per token (paid → paid, no new cost class) or has recorded
  // explicit consent for this destination.
  if (fromTier === 'paid') return true;
  return candidateConsent === 'explicit';
}
