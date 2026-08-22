import { describe, expect, it } from 'vitest';

import {
  evaluateAttentionPolicy,
  isAttentionQuietHours,
  PRESENCE_CATEGORY_PRIORITY,
} from '../../../core/v4/presence/attentionPolicy';
import type { AttentionPreferences, PresenceItem } from '../../../core/v4/presence/types';

const preferences: AttentionPreferences = {
  workspaceId: null, ownerId: null, timezone: 'UTC', quietStart: null, quietEnd: null,
  maxInterruptions: 2, interruptionWindowMs: 3_600_000, cooldownMs: 60_000,
  notificationConsent: false, allowedDeliveryClasses: [], defaultSnoozeMs: 3_600_000, version: 1,
};

const item = (id: string, category: PresenceItem['category'], priority = PRESENCE_CATEGORY_PRIORITY[category]): PresenceItem => ({
  id, sourceKind: 'job', sourceIdentity: id, sourceRevision: '1', sourceDigest: id,
  initiator: 'SYSTEM', workspaceId: null, ownerId: null, jobId: id, automationId: null,
  category, priority, state: 'active', title: id, summary: id, reasonCode: category,
  reason: category, recommendedAction: null, payload: {}, untrustedExternal: false,
  occurrenceCount: 1, version: 1, firstObservedAt: 1, lastObservedAt: 1,
  snoozedUntil: null, expiresAt: null, dismissedAt: null, resolvedAt: null, terminalAt: null,
});

describe('deterministic Attention policy', () => {
  it('orders approvals, uncertain effects and takeover ahead of review and information', () => {
    const result = evaluateAttentionPolicy({
      items: [item('info', 'information'), item('review', 'ready_review'), item('browser', 'browser_takeover'), item('effect', 'unknown_effect'), item('approval', 'approval_required')],
      preferences, now: 10, interruptionCount: 0, lastInterruptionAt: null,
    });
    expect(result.needsYou.map((entry) => entry.id)).toEqual(['approval', 'effect', 'browser']);
    expect(result.reviewWhenReady.map((entry) => entry.id)).toEqual(['review', 'info']);
    expect(result.interruptions[0]?.id).toBe('approval');
  });

  it('honors cross-midnight quiet hours with an IANA timezone and DST-safe formatter', () => {
    const quiet = { ...preferences, timezone: 'America/New_York', quietStart: '22:00', quietEnd: '07:00' };
    expect(isAttentionQuietHours(Date.parse('2026-08-22T06:00:00Z'), quiet)).toBe(true);
    expect(isAttentionQuietHours(Date.parse('2026-08-22T16:00:00Z'), quiet)).toBe(false);
  });

  it('suppresses interruption when the durable budget or cooldown is exhausted without hiding the inbox item', () => {
    const budget = evaluateAttentionPolicy({
      items: [item('approval', 'approval_required')], preferences, now: 100_000,
      interruptionCount: 2, lastInterruptionAt: 1,
    });
    const cooldown = evaluateAttentionPolicy({
      items: [item('approval', 'approval_required')], preferences, now: 100_000,
      interruptionCount: 0, lastInterruptionAt: 99_999,
    });
    expect(budget.interruptions).toEqual([]);
    expect(cooldown.interruptions).toEqual([]);
    expect(budget.needsYou).toHaveLength(1);
    expect(cooldown.needsYou).toHaveLength(1);
  });

  it('never treats snoozed, dismissed, expired or suppressed items as interruptible', () => {
    const states = ['snoozed', 'dismissed', 'expired', 'suppressed'] as const;
    const result = evaluateAttentionPolicy({
      items: states.map((state) => ({ ...item(state, 'approval_required'), state })),
      preferences, now: 10, interruptionCount: 0, lastInterruptionAt: null,
    });
    expect(result.needsYou).toEqual([]);
    expect(result.interruptions).toEqual([]);
  });
});
