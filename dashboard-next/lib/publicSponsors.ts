/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export const SPONSOR_URL = 'https://razorpay.me/@whitelotus9625';

export interface PublicSponsor {
  displayName: string;
  avatarUrl?: string;
  profileUrl?: string;
  tier?: 'Founding Sponsor' | 'Gold Sponsor' | 'Supporter';
  message?: string;
}

/** Only explicitly approved public identities belong here. Payment records are
 * intentionally not a data source for this surface. */
export const PUBLIC_SPONSORS: readonly PublicSponsor[] = [];
