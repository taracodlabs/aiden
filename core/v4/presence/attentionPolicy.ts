/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { AttentionPreferences, PresenceCategory, PresenceItem, PresenceSnapshot } from './types';

export const PRESENCE_CATEGORY_PRIORITY: Readonly<Record<PresenceCategory, number>> = {
  approval_required: 100,
  unknown_effect: 95,
  browser_takeover: 90,
  verification_failure: 88,
  cleanup_uncertainty: 86,
  target_drift: 84,
  budget_attention: 82,
  unresolved_gate: 80,
  connection_blocker: 75,
  clarification: 72,
  automation_failure: 70,
  delivery_failure: 68,
  ready_review: 60,
  next_action: 40,
  information: 20,
};

function clockMinutes(now: number, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
  } catch { return null; }
}

function parseClock(value: string | null): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  if (hour! > 23 || minute! > 59) return null;
  return hour! * 60 + minute!;
}

export function isAttentionQuietHours(now: number, preferences: AttentionPreferences): boolean {
  const current = clockMinutes(now, preferences.timezone);
  const start = parseClock(preferences.quietStart);
  const end = parseClock(preferences.quietEnd);
  if (current === null || start === null || end === null || start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function ordered(items: readonly PresenceItem[]): PresenceItem[] {
  return [...items].sort((a, b) => b.priority - a.priority || b.lastObservedAt - a.lastObservedAt || a.id.localeCompare(b.id));
}

export function evaluateAttentionPolicy(input: {
  items: readonly PresenceItem[];
  preferences: AttentionPreferences;
  now: number;
  interruptionCount: number;
  lastInterruptionAt: number | null;
}): PresenceSnapshot {
  const active = input.items.filter((item) => item.state === 'active');
  const needsYou = ordered(active.filter((item) => item.priority >= 70 || [
    'approval_required', 'unknown_effect', 'browser_takeover', 'connection_blocker', 'automation_failure',
  ].includes(item.category)));
  const reviewWhenReady = ordered(active.filter((item) => !needsYou.includes(item)));
  const recentlyResolved = ordered(input.items.filter((item) =>
    item.state === 'resolved' && (item.resolvedAt ?? 0) >= input.now - 7 * 86_400_000));
  const quietHours = isAttentionQuietHours(input.now, input.preferences);
  const budgetAvailable = input.interruptionCount < input.preferences.maxInterruptions
    && (input.lastInterruptionAt === null || input.now - input.lastInterruptionAt >= input.preferences.cooldownMs);
  return {
    enabled: true,
    quietHours,
    interruptions: quietHours || !budgetAvailable ? [] : needsYou.slice(0, 1),
    needsYou,
    reviewWhenReady,
    recentlyResolved,
  };
}

export function validateAttentionPreferenceClock(value: string | null): boolean {
  return value === null || parseClock(value) !== null;
}

export function validateAttentionTimezone(timezone: string, now = Date.now()): boolean {
  return clockMinutes(now, timezone) !== null;
}
