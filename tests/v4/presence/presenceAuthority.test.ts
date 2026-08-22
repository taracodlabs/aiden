import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createPresenceAuthority } from '../../../core/v4/presence/presenceAuthority';
import type { PresenceObservation } from '../../../core/v4/presence/types';

describe('durable Presence authority', () => {
  let db: Database.Database;
  let now = Date.parse('2026-08-22T10:00:00.000Z');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  const observation = (overrides: Partial<PresenceObservation> = {}): PresenceObservation => ({
    sourceKind: 'approval',
    sourceIdentity: 'approval_1',
    sourceRevision: 'created:1',
    initiator: 'USER',
    workspaceId: 'workspace_1',
    ownerId: 'owner_1',
    jobId: 'job_1',
    category: 'approval_required',
    title: 'Approval needed',
    summary: 'Review the exact file write.',
    reasonCode: 'approval_waiting',
    reason: 'A protected action is waiting for your decision.',
    recommendedAction: 'Review approval',
    priority: 100,
    active: true,
    observedAt: now,
    payload: { approvalId: 'approval_1', toolName: 'file_write', target: 'README.md' },
    ...overrides,
  });

  it('migrates the additive Presence schema and persists one stable item per source identity', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const first = authority.observe(observation());
    const duplicate = authority.observe(observation({ observedAt: now + 1_000 }));

    expect(duplicate.item.id).toBe(first.item.id);
    expect(duplicate.item.occurrenceCount).toBe(1);
    expect(authority.list({ workspaceId: 'workspace_1', ownerId: 'owner_1' })).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM presence_items').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM presence_item_events').get()).toEqual({ count: 1 });
  });

  it('updates recurrence in place while suppressing stale observations after resolution', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const first = authority.observe(observation());
    now += 5_000;
    const changed = authority.observe(observation({
      sourceRevision: 'displayed:2',
      observedAt: now,
      summary: 'The approval is still waiting.',
    }));
    expect(changed.item.id).toBe(first.item.id);
    expect(changed.item.occurrenceCount).toBe(2);

    now += 5_000;
    const resolved = authority.observe(observation({
      sourceRevision: 'approved:3', active: false, observedAt: now,
      summary: 'Approval resolved.', reasonCode: 'approval_resolved',
    }));
    expect(resolved.item.state).toBe('resolved');

    const stale = authority.observe(observation({
      sourceRevision: 'displayed:2', observedAt: now - 1,
    }));
    expect(stale.stale).toBe(true);
    expect(authority.get(first.item.id)?.state).toBe('resolved');
  });

  it('uses CAS for durable snooze and dismiss and preserves them across restart', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const item = authority.observe(observation()).item;
    const snoozed = authority.snooze({ itemId: item.id, expectedVersion: item.version, until: now + 60_000 });
    expect(snoozed.state).toBe('snoozed');
    expect(() => authority.dismiss({ itemId: item.id, expectedVersion: item.version })).toThrow(/version/i);

    const reopened = createPresenceAuthority({ db, enabled: true, now: () => now });
    expect(reopened.get(item.id)?.state).toBe('snoozed');
    now += 60_001;
    expect(reopened.list({ workspaceId: 'workspace_1', ownerId: 'owner_1' })[0]?.state).toBe('active');
    const current = reopened.get(item.id)!;
    expect(reopened.dismiss({ itemId: item.id, expectedVersion: current.version }).state).toBe('dismissed');
  });

  it('resolves through a snooze and rejects a concurrent stale dismiss version', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const item = authority.observe(observation()).item;
    const snoozed = authority.snooze({ itemId: item.id, expectedVersion: item.version, until: now + 60_000 });
    const resolved = authority.observe(observation({
      active: false, sourceRevision: 'denied:2', observedAt: now + 1,
      reasonCode: 'approval_resolved', summary: 'Approval denied.',
    })).item;
    expect(resolved.state).toBe('resolved');
    expect(() => authority.dismiss({ itemId: item.id, expectedVersion: snoozed.version })).toThrow(/version/i);
  });

  it('keeps an immaterially reobserved dismissal closed but resurfaces a materially escalated condition', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const item = authority.observe(observation()).item;
    const dismissed = authority.dismiss({ itemId: item.id, expectedVersion: item.version });
    const repeated = authority.observe(observation({
      sourceRevision: 'displayed:2', observedAt: now + 1, summary: 'Still waiting.',
    })).item;
    expect(repeated.state).toBe('dismissed');
    const escalated = authority.observe(observation({
      sourceRevision: 'uncertain:3', observedAt: now + 2, category: 'unknown_effect',
      reasonCode: 'effect_unknown', reason: 'The outcome is now uncertain.',
    })).item;
    expect(escalated.state).toBe('active');
    expect(escalated.version).toBeGreaterThan(dismissed.version);
  });

  it('keeps critical uncertainty discoverable across snooze escalation and item expiry', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const base = authority.observe(observation({
      category: 'next_action', reasonCode: 'safe_next_step', expiresAt: now + 1_000,
    })).item;
    authority.snooze({ itemId: base.id, expectedVersion: base.version, until: now + 60_000 });
    const escalated = authority.observe(observation({
      sourceRevision: 'unknown:2', observedAt: now + 10, category: 'unknown_effect',
      reasonCode: 'effect_unknown', reason: 'A consequential outcome is unknown.', expiresAt: now + 1_000,
    })).item;
    expect(escalated.state).toBe('active');
    now += 2_000;
    expect(authority.get(base.id)?.state).toBe('active');
  });

  it('handles clock rollback conservatively without expiring snoozes or reviving stale source state', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const item = authority.observe(observation()).item;
    authority.snooze({ itemId: item.id, expectedVersion: item.version, until: now + 60_000 });
    now -= 3_600_000;
    expect(authority.get(item.id)?.state).toBe('snoozed');
    expect(authority.observe(observation({ observedAt: now, sourceRevision: 'older:0' })).stale).toBe(true);
  });

  it('honors IANA quiet hours, cooldown and a durable interruption budget without hiding blockers', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    authority.setPreferences({
      workspaceId: 'workspace_1', ownerId: 'owner_1', timezone: 'Asia/Kolkata',
      quietStart: '00:00', quietEnd: '23:59', maxInterruptions: 1,
      interruptionWindowMs: 3_600_000, cooldownMs: 60_000,
    });
    authority.observe(observation());
    authority.observe(observation({
      sourceKind: 'effect', sourceIdentity: 'effect_1', sourceRevision: 'unknown:1',
      category: 'unknown_effect', reasonCode: 'effect_unknown', title: 'Outcome unknown',
      priority: 95, payload: { effectId: 'effect_1' }, observedAt: now + 1,
    }));

    const snapshot = authority.snapshot({ workspaceId: 'workspace_1', ownerId: 'owner_1' });
    expect(snapshot.quietHours).toBe(true);
    expect(snapshot.interruptions).toEqual([]);
    expect(snapshot.needsYou).toHaveLength(2);
  });

  it('persists scoped notification consent and bounded delivery preferences without secrets', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const saved = authority.setPreferences({
      workspaceId: 'workspace_1', ownerId: 'owner_1', timezone: 'Europe/Tallinn',
      notificationConsent: true, allowedDeliveryClasses: ['desktop', 'email'], defaultSnoozeMs: 900_000,
    });
    expect(saved).toMatchObject({
      notificationConsent: true, allowedDeliveryClasses: ['desktop', 'email'], defaultSnoozeMs: 900_000,
    });
    expect(createPresenceAuthority({ db, enabled: true, now: () => now })
      .getPreferences({ workspaceId: 'workspace_1', ownerId: 'owner_1' })).toEqual(saved);
  });

  it('deduplicates 100 observations within scope while isolating identical source identities across projects', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    for (let index = 0; index < 100; index += 1) {
      authority.observe(observation({ observedAt: now + index }));
    }
    const other = authority.observe(observation({ workspaceId: 'workspace_2', observedAt: now + 200 })).item;
    expect(authority.list({ workspaceId: 'workspace_1', ownerId: 'owner_1' })).toHaveLength(1);
    expect(authority.list({ workspaceId: 'workspace_2', ownerId: 'owner_1' })).toEqual([other]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM presence_items').get()).toEqual({ count: 2 });
  });

  it('consumes interruption budget durably while keeping the item in Needs you', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    authority.setPreferences({
      workspaceId: 'workspace_1', ownerId: 'owner_1', timezone: 'UTC',
      maxInterruptions: 1, interruptionWindowMs: 3_600_000, cooldownMs: 60_000,
    });
    authority.observe(observation());
    expect(authority.snapshot({ workspaceId: 'workspace_1', ownerId: 'owner_1' }).interruptions).toHaveLength(1);
    const second = authority.snapshot({ workspaceId: 'workspace_1', ownerId: 'owner_1' });
    expect(second.interruptions).toEqual([]);
    expect(second.needsYou).toHaveLength(1);
    expect(authority.events(authority.list({ workspaceId: 'workspace_1', ownerId: 'owner_1' })[0]!.id)
      .filter((event) => event.type === 'interrupted')).toHaveLength(1);
  });

  it('emits one restart-safe startup briefing and groups current changed, blocked, ready and resolved truth', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    authority.observe(observation());
    authority.observe(observation({
      sourceKind: 'job', sourceIdentity: 'job_ready', sourceRevision: 'completed_unverified:1',
      category: 'ready_review', reasonCode: 'review_ready', title: 'Review result', priority: 50,
      jobId: 'job_ready', observedAt: now + 1,
    }));
    const first = authority.startupBriefing({
      briefingId: 'workbench-start-1', workspaceId: 'workspace_1', ownerId: 'owner_1',
    });
    const replay = authority.startupBriefing({
      briefingId: 'workbench-start-1', workspaceId: 'workspace_1', ownerId: 'owner_1',
    });
    expect(first.items.map((item) => item.category)).toEqual(['approval_required', 'ready_review']);
    expect(first.groups.blocked).toHaveLength(1);
    expect(first.groups.ready).toHaveLength(1);
    expect(first.groups.resolved).toHaveLength(0);
    expect(replay.items).toEqual([]);
    expect(replay.duplicate).toBe(true);
  });

  it('keeps Presence failures isolated from Job truth and fails closed when entitlement is absent', () => {
    const disabled = createPresenceAuthority({ db, enabled: false, now: () => now });
    expect(disabled.snapshot({ workspaceId: 'workspace_1', ownerId: 'owner_1' })).toMatchObject({
      enabled: false, needsYou: [], reviewWhenReady: [], recentlyResolved: [],
    });
    expect(() => disabled.observe(observation())).toThrow(/not enabled/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
  });

  it('persists ProposedJob intent and admits only after explicit fresh revalidation through the supplied ordinary enqueuer', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const item = authority.observe(observation({
      sourceKind: 'continuity', sourceIdentity: 'checkpoint_1', sourceRevision: 'current:1',
      category: 'next_action', reasonCode: 'safe_next_step', title: 'Continue repository review', priority: 40,
      payload: { checkpointId: 'checkpoint_1' },
    })).item;
    const proposal = authority.propose({
      itemId: item.id,
      prompt: 'Continue the repository review from checkpoint_1.',
      goal: 'Continue repository review',
      workspaceId: 'workspace_1', ownerId: 'owner_1',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    const duplicateProposal = createPresenceAuthority({ db, enabled: true, now: () => now }).propose({
      itemId: item.id, prompt: 'Continue the repository review from checkpoint_1.',
      goal: 'Continue repository review', workspaceId: 'workspace_1', ownerId: 'owner_1',
    });
    expect(duplicateProposal.id).toBe(proposal.id);
    expect(authority.listProposals({ workspaceId: 'workspace_1', ownerId: 'owner_1' })).toHaveLength(1);

    const enqueue = vi.fn(() => ({
      accepted: true, jobId: 'job_new', attemptId: 'attempt_new', runId: 42, triggerEventId: 9,
    }));
    const accepted = authority.acceptProposal({
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      revalidate: () => ({ ok: true }),
      enqueue,
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      message: proposal.prompt,
      idempotencyKey: `presence-proposal:${proposal.id}`,
    }));
    expect(accepted).toMatchObject({ state: 'accepted', jobId: 'job_new', attemptId: 'attempt_new', runId: 42 });
    expect(authority.acceptProposal({
      proposalId: proposal.id,
      expectedVersion: accepted.version,
      revalidate: () => ({ ok: true }),
      enqueue,
    })).toMatchObject({ state: 'accepted', jobId: 'job_new' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('rejects stale proposals without admitting a Job', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const item = authority.observe(observation()).item;
    const proposal = authority.propose({ itemId: item.id, prompt: 'Do the next thing.', goal: 'Next thing' });
    const enqueue = vi.fn();
    const rejected = authority.acceptProposal({
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      revalidate: () => ({ ok: false, reason: 'source changed' }),
      enqueue,
    });
    expect(rejected).toMatchObject({ state: 'invalidated', invalidationReason: 'source changed' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('expires a proposal before admission and never invokes the ordinary enqueuer', () => {
    const authority = createPresenceAuthority({ db, enabled: true, now: () => now });
    const item = authority.observe(observation()).item;
    const proposal = authority.propose({ itemId: item.id, prompt: 'Review safely.', goal: 'Review', expiresAt: now + 1 });
    now += 2;
    const enqueue = vi.fn();
    expect(authority.acceptProposal({
      proposalId: proposal.id, expectedVersion: proposal.version, revalidate: () => ({ ok: true }), enqueue,
    }).state).toBe('expired');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
