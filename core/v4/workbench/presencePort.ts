/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type Database from 'better-sqlite3';

import type { EditionAuthority } from '../commercial/edition';
import type { PresenceAuthority } from '../presence/presenceAuthority';
import { reconcileDurablePresence } from '../presence/sourceProjection';
import type { AttentionPreferences, PresenceBriefing, PresenceItem, PresenceSnapshot, ProposedJob } from '../presence/types';
import type { EnqueueResult, TaskEnqueuer } from './bridgeServer';

export interface WorkbenchPresencePort {
  snapshot(): PresenceSnapshot;
  briefing(briefingId: string): PresenceBriefing;
  preferences(): AttentionPreferences;
  updatePreferences(input: Partial<Omit<AttentionPreferences, 'workspaceId' | 'ownerId' | 'version'>>): AttentionPreferences;
  explain(itemId: string): ReturnType<PresenceAuthority['explain']>;
  snooze(input: { itemId: string; expectedVersion: number; until: number }): PresenceItem;
  dismiss(input: { itemId: string; expectedVersion: number; reason?: string }): PresenceItem;
  feedback(input: { itemId: string; kind: 'helpful' | 'not_helpful' | 'too_frequent' | 'wrong_priority' }): { accepted: true; eventId: string };
  propose(input: { itemId: string; prompt: string; goal: string; expiresAt?: number | null }): ProposedJob;
  proposals(): ProposedJob[];
  acceptProposal(input: { proposalId: string; expectedVersion: number; sessionId?: string }): ProposedJob;
}

export function createWorkbenchPresencePort(options: {
  db: Database.Database;
  authority: PresenceAuthority;
  edition: EditionAuthority;
  enqueue?: TaskEnqueuer;
  workspaceId?: string | null;
  ownerId?: string | null;
  onFeedback?: (input: {
    item: PresenceItem;
    kind: 'helpful' | 'not_helpful' | 'too_frequent' | 'wrong_priority';
    eventId: string;
  }) => void;
  revalidateProposal?: (proposal: ProposedJob, item: PresenceItem) => { ok: boolean; reason?: string };
}): WorkbenchPresencePort {
  const scope = options.workspaceId === undefined && options.ownerId === undefined
    ? undefined
    : { workspaceId: options.workspaceId ?? null, ownerId: options.ownerId ?? null };
  const reconcile = (): void => {
    if (!options.edition.can('presence.active')) return;
    reconcileDurablePresence({ db: options.db, authority: options.authority });
  };
  const scopedItem = (itemId: string): PresenceItem => {
    const item = options.authority.get(itemId);
    if (!item) throw new Error('Presence item not found');
    if (scope && (item.workspaceId !== scope.workspaceId || item.ownerId !== scope.ownerId)) {
      throw new Error('Presence item is outside the active Workbench scope');
    }
    return item;
  };
  return {
    snapshot() {
      reconcile();
      return options.authority.snapshot(scope);
    },
    briefing(briefingId) {
      reconcile();
      return options.authority.startupBriefing({ briefingId, ...scope });
    },
    preferences() { return options.authority.getPreferences(scope); },
    updatePreferences(input) { return options.authority.setPreferences({ ...input, ...scope }); },
    explain(itemId) {
      reconcile();
      scopedItem(itemId);
      return options.authority.explain(itemId);
    },
    snooze(input) { scopedItem(input.itemId); return options.authority.snooze(input); },
    dismiss(input) { scopedItem(input.itemId); return options.authority.dismiss(input); },
    feedback(input) {
      const item = scopedItem(input.itemId);
      const result = options.authority.feedback(input);
      try { options.onFeedback?.({ item, kind: input.kind, eventId: result.eventId }); }
      catch { /* Learning projection is contextual and cannot rewrite feedback truth. */ }
      return result;
    },
    propose(input) {
      if (!options.edition.can('presence.active')) throw new Error('Agentic Presence requires Aiden Pro');
      reconcile();
      scopedItem(input.itemId);
      return options.authority.propose({ ...input, ...scope });
    },
    proposals() { return options.authority.listProposals(scope); },
    acceptProposal(input) {
      if (!options.edition.can('presence.active')) throw new Error('Agentic Presence requires Aiden Pro');
      if (!options.enqueue) throw new Error('Workbench Job admission is unavailable');
      reconcile();
      return options.authority.acceptProposal({
        ...input,
        revalidate(proposal, item) {
          if (scope?.workspaceId !== undefined && proposal.workspaceId !== scope.workspaceId) {
            return { ok: false, reason: 'proposal workspace changed' };
          }
          if (scope?.ownerId !== undefined && proposal.ownerId !== scope.ownerId) {
            return { ok: false, reason: 'proposal owner changed' };
          }
          return options.revalidateProposal?.(proposal, item) ?? { ok: true };
        },
        enqueue(task): EnqueueResult {
          return options.enqueue!.enqueue(task);
        },
      });
    },
  };
}
