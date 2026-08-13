/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import { PUBLIC_SPONSORS, SPONSOR_URL } from '../../../dashboard-next/lib/publicSponsors';

describe('public Workbench sponsors', () => {
  it('uses the reviewed external support destination', () => {
    expect(SPONSOR_URL).toBe('https://razorpay.me/@whitelotus9625');
  });

  it('permits only explicit public presentation fields', () => {
    const allowed = new Set(['displayName', 'avatarUrl', 'profileUrl', 'tier', 'message']);
    for (const sponsor of PUBLIC_SPONSORS) {
      expect(Object.keys(sponsor).every((key) => allowed.has(key))).toBe(true);
      expect(JSON.stringify(sponsor)).not.toMatch(/email|phone|transaction|payment|amount/i);
    }
  });
});
