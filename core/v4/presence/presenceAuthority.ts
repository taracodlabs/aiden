/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { digestPresenceObservation, normalizePresenceObservation } from './observationProjector';
import {
  evaluateAttentionPolicy,
  validateAttentionPreferenceClock,
  validateAttentionTimezone,
} from './attentionPolicy';
import type {
  AttentionPreferences,
  PresenceBriefing,
  PresenceEnqueueResult,
  PresenceItem,
  PresenceObservation,
  PresenceSnapshot,
  PresenceState,
  ProposedJob,
} from './types';

interface PresenceRow {
  presence_id: string; dedupe_key: string; source_kind: PresenceItem['sourceKind']; source_identity: string;
  source_revision: string; source_digest: string; initiator: PresenceItem['initiator'];
  workspace_id: string | null; owner_id: string | null; job_id: string | null; automation_id: string | null;
  category: PresenceItem['category']; priority: number; state: PresenceState; title: string; summary: string;
  reason_code: string; reason_text: string; recommended_action: string | null; payload_json: string;
  untrusted_external: number; occurrence_count: number; state_version: number;
  first_observed_at: number; last_observed_at: number; snoozed_until: number | null; expires_at: number | null;
  dismissed_at: number | null; resolved_at: number | null; terminal_at: number | null;
  created_at: number; updated_at: number;
}

interface ProposalRow {
  proposal_id: string; presence_id: string; source_digest: string; workspace_id: string | null; owner_id: string | null;
  prompt: string; goal: string; state: ProposedJob['state']; state_version: number; invalidation_reason: string | null;
  job_id: string | null; attempt_id: string | null; run_id: number | null; trigger_event_id: number | null;
  created_at: number; updated_at: number; accepted_at: number | null; expires_at: number | null;
}

interface PreferenceRow {
  workspace_id: string | null; owner_id: string | null; timezone: string; quiet_start: string | null;
  quiet_end: string | null; max_interruptions: number; interruption_window_ms: number; cooldown_ms: number;
  notification_consent: number; allowed_delivery_classes_json: string; default_snooze_ms: number;
  state_version: number;
}

const json = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function itemFromRow(row: PresenceRow): PresenceItem {
  return {
    id: row.presence_id, sourceKind: row.source_kind, sourceIdentity: row.source_identity,
    sourceRevision: row.source_revision, sourceDigest: row.source_digest, initiator: row.initiator,
    workspaceId: row.workspace_id, ownerId: row.owner_id, jobId: row.job_id, automationId: row.automation_id,
    category: row.category, priority: row.priority, state: row.state, title: row.title, summary: row.summary,
    reasonCode: row.reason_code, reason: row.reason_text, recommendedAction: row.recommended_action,
    payload: json<Record<string, unknown>>(row.payload_json, {}), untrustedExternal: row.untrusted_external === 1,
    occurrenceCount: row.occurrence_count, version: row.state_version,
    firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at,
    snoozedUntil: row.snoozed_until, expiresAt: row.expires_at, dismissedAt: row.dismissed_at,
    resolvedAt: row.resolved_at, terminalAt: row.terminal_at,
  };
}

function proposalFromRow(row: ProposalRow): ProposedJob {
  return {
    id: row.proposal_id, itemId: row.presence_id, sourceDigest: row.source_digest,
    workspaceId: row.workspace_id, ownerId: row.owner_id, prompt: row.prompt, goal: row.goal,
    state: row.state, version: row.state_version, invalidationReason: row.invalidation_reason,
    jobId: row.job_id, attemptId: row.attempt_id, runId: row.run_id, triggerEventId: row.trigger_event_id,
    createdAt: row.created_at, updatedAt: row.updated_at, acceptedAt: row.accepted_at, expiresAt: row.expires_at,
  };
}

export interface PresenceAuthority {
  observe(observation: PresenceObservation): { item: PresenceItem; created: boolean; stale: boolean };
  get(itemId: string): PresenceItem | null;
  list(scope?: { workspaceId?: string | null; ownerId?: string | null }): PresenceItem[];
  events(itemId: string): Array<{ eventId: string; type: string; fromState: string | null; toState: string | null; reason: Record<string, unknown>; createdAt: number }>;
  snapshot(scope?: { workspaceId?: string | null; ownerId?: string | null }): PresenceSnapshot;
  explain(itemId: string): { itemId: string; reason: string; reasonCode: string; source: { kind: string; identity: string; revision: string }; history: ReturnType<PresenceAuthority['events']> };
  snooze(input: { itemId: string; expectedVersion: number; until: number }): PresenceItem;
  dismiss(input: { itemId: string; expectedVersion: number; reason?: string }): PresenceItem;
  setPreferences(input: Partial<Omit<AttentionPreferences, 'version'>> & { workspaceId?: string | null; ownerId?: string | null }): AttentionPreferences;
  getPreferences(scope?: { workspaceId?: string | null; ownerId?: string | null }): AttentionPreferences;
  startupBriefing(input: { briefingId: string; workspaceId?: string | null; ownerId?: string | null }): PresenceBriefing;
  propose(input: { itemId: string; prompt: string; goal: string; workspaceId?: string | null; ownerId?: string | null; expiresAt?: number | null }): ProposedJob;
  getProposal(proposalId: string): ProposedJob | null;
  listProposals(scope?: { workspaceId?: string | null; ownerId?: string | null }): ProposedJob[];
  acceptProposal(input: {
    proposalId: string; expectedVersion: number; sessionId?: string;
    revalidate(proposal: ProposedJob, item: PresenceItem): { ok: boolean; reason?: string };
    enqueue(task: { message: string; sessionId?: string; idempotencyKey: string }): PresenceEnqueueResult;
  }): ProposedJob;
  feedback(input: { itemId: string; kind: 'helpful' | 'not_helpful' | 'too_frequent' | 'wrong_priority' }): { accepted: true; eventId: string };
}

export function createPresenceAuthority(options: {
  db: Database.Database;
  enabled: boolean;
  now?: () => number;
  idFactory?: () => string;
}): PresenceAuthority {
  const now = options.now ?? Date.now;
  const nextId = options.idFactory ?? randomUUID;
  const row = (id: string) => options.db.prepare('SELECT * FROM presence_items WHERE presence_id = ?').get(id) as PresenceRow | undefined;
  const proposalRow = (id: string) => options.db.prepare('SELECT * FROM presence_proposed_jobs WHERE proposal_id = ?').get(id) as ProposalRow | undefined;
  const scopeValues = (scope?: { workspaceId?: string | null; ownerId?: string | null }) => [scope?.workspaceId ?? null, scope?.ownerId ?? null] as const;

  const appendEvent = (input: {
    itemId: string; type: string; fromState?: string | null; toState?: string | null;
    idempotencyKey: string; reason?: Record<string, unknown>; at?: number;
  }): string => {
    const eventId = `presence_event_${digest(`${input.itemId}:${input.idempotencyKey}`).slice(0, 32)}`;
    options.db.prepare(
      `INSERT OR IGNORE INTO presence_item_events
         (event_id,presence_id,event_type,from_state,to_state,reason_json,idempotency_key,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(eventId, input.itemId, input.type, input.fromState ?? null, input.toState ?? null,
      JSON.stringify(input.reason ?? {}), input.idempotencyKey, input.at ?? now());
    return eventId;
  };

  const refreshTemporalState = (scope?: { workspaceId?: string | null; ownerId?: string | null }): void => {
    const at = now();
    const [workspaceId, ownerId] = scopeValues(scope);
    const expired = (scope
      ? options.db.prepare(
        `SELECT presence_id,state FROM presence_items
          WHERE workspace_id IS ? AND owner_id IS ?
            AND ((state='snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?)
              OR (state IN ('active','snoozed') AND priority < 90 AND expires_at IS NOT NULL AND expires_at <= ?))`,
      ).all(workspaceId, ownerId, at, at)
      : options.db.prepare(
        `SELECT presence_id,state FROM presence_items
          WHERE (state='snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?)
             OR (state IN ('active','snoozed') AND priority < 90 AND expires_at IS NOT NULL AND expires_at <= ?)`,
      ).all(at, at)) as Array<{ presence_id: string; state: PresenceState }>;
    const tx = options.db.transaction(() => {
      for (const current of expired) {
        if (current.state === 'snoozed') {
          const item = row(current.presence_id);
          if (item?.expires_at !== null && item.expires_at <= at) {
            options.db.prepare(`UPDATE presence_items SET state='expired',terminal_at=?,updated_at=?,state_version=state_version+1 WHERE presence_id=? AND state='snoozed'`)
              .run(at, at, current.presence_id);
            appendEvent({ itemId: current.presence_id, type: 'expired', fromState: 'snoozed', toState: 'expired', idempotencyKey: `expired:${at}` });
          } else {
            options.db.prepare(`UPDATE presence_items SET state='active',snoozed_until=NULL,updated_at=?,state_version=state_version+1 WHERE presence_id=? AND state='snoozed'`)
              .run(at, current.presence_id);
            appendEvent({ itemId: current.presence_id, type: 'snooze_elapsed', fromState: 'snoozed', toState: 'active', idempotencyKey: `snooze-elapsed:${at}` });
          }
        } else {
          options.db.prepare(`UPDATE presence_items SET state='expired',terminal_at=?,updated_at=?,state_version=state_version+1 WHERE presence_id=? AND state='active'`)
            .run(at, at, current.presence_id);
          appendEvent({ itemId: current.presence_id, type: 'expired', fromState: 'active', toState: 'expired', idempotencyKey: `expired:${at}` });
        }
      }
    });
    tx.immediate();
  };

  const authority: PresenceAuthority = {
    observe(raw) {
      if (!options.enabled) throw new Error('Agentic Presence is not enabled for this edition');
      const observation = normalizePresenceObservation(raw);
      const sourceDigest = digestPresenceObservation(observation);
      const dedupeKey = digest(`${observation.workspaceId ?? ''}\0${observation.ownerId ?? ''}\0${observation.sourceKind}\0${observation.sourceIdentity}`);
      const id = `presence_${dedupeKey.slice(0, 32)}`;
      return options.db.transaction(() => {
        const existing = options.db.prepare('SELECT * FROM presence_items WHERE dedupe_key = ?').get(dedupeKey) as PresenceRow | undefined;
        const at = observation.observedAt;
        if (!existing) {
          const state: PresenceState = observation.active ? 'active' : 'resolved';
          options.db.prepare(
            `INSERT INTO presence_items (
               presence_id,dedupe_key,source_kind,source_identity,source_revision,source_digest,initiator,
               workspace_id,owner_id,job_id,automation_id,category,priority,state,title,summary,reason_code,
               reason_text,recommended_action,payload_json,untrusted_external,occurrence_count,state_version,
               first_observed_at,last_observed_at,snoozed_until,expires_at,dismissed_at,resolved_at,terminal_at,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?,?,?,?,?)`,
          ).run(
            id, dedupeKey, observation.sourceKind, observation.sourceIdentity, observation.sourceRevision, sourceDigest,
            observation.initiator, observation.workspaceId ?? null, observation.ownerId ?? null, observation.jobId ?? null,
            observation.automationId ?? null, observation.category, observation.priority, state, observation.title,
            observation.summary, observation.reasonCode, observation.reason, observation.recommendedAction ?? null,
            JSON.stringify(observation.payload ?? {}), observation.untrustedExternal ? 1 : 0, at, at, null,
            observation.expiresAt ?? null, null, observation.active ? null : at, observation.active ? null : at, at, at,
          );
          appendEvent({ itemId: id, type: observation.active ? 'created' : 'resolved', toState: state, idempotencyKey: `source:${observation.sourceRevision}`, at });
          return { item: itemFromRow(row(id)!), created: true, stale: false };
        }
        if (at < existing.last_observed_at || (existing.terminal_at !== null && at <= existing.terminal_at && observation.active)) {
          return { item: itemFromRow(existing), created: false, stale: true };
        }
        if (existing.source_revision === observation.sourceRevision && existing.source_digest === sourceDigest) {
          if (at > existing.last_observed_at) {
            options.db.prepare('UPDATE presence_items SET last_observed_at=?,updated_at=? WHERE presence_id=?').run(at, at, existing.presence_id);
          }
          return { item: itemFromRow(row(existing.presence_id)!), created: false, stale: false };
        }
        const fromState = existing.state;
        const materiallyChanged = observation.category !== existing.category
          || observation.reasonCode !== existing.reason_code
          || observation.priority > existing.priority
          || (observation.recommendedAction ?? null) !== existing.recommended_action;
        const targetState: PresenceState = observation.active
          ? (existing.state === 'dismissed' && !materiallyChanged ? 'dismissed'
            : existing.state === 'snoozed' && existing.snoozed_until !== null && existing.snoozed_until > now()
              && !(materiallyChanged && observation.priority >= 90) ? 'snoozed' : 'active')
          : 'resolved';
        options.db.prepare(
          `UPDATE presence_items SET source_revision=?,source_digest=?,initiator=?,workspace_id=?,owner_id=?,job_id=?,automation_id=?,
             category=?,priority=?,state=?,title=?,summary=?,reason_code=?,reason_text=?,recommended_action=?,payload_json=?,
             untrusted_external=?,occurrence_count=occurrence_count+1,state_version=state_version+1,last_observed_at=?,
             snoozed_until=CASE WHEN ?='snoozed' THEN snoozed_until ELSE NULL END,
             dismissed_at=CASE WHEN ?='dismissed' THEN dismissed_at ELSE NULL END,
             resolved_at=?,terminal_at=CASE WHEN ?='dismissed' THEN terminal_at ELSE ? END,expires_at=?,updated_at=? WHERE presence_id=?`,
        ).run(
          observation.sourceRevision, sourceDigest, observation.initiator, observation.workspaceId ?? null,
          observation.ownerId ?? null, observation.jobId ?? null, observation.automationId ?? null,
          observation.category, observation.priority, targetState, observation.title, observation.summary,
          observation.reasonCode, observation.reason, observation.recommendedAction ?? null,
          JSON.stringify(observation.payload ?? {}), observation.untrustedExternal ? 1 : 0, at, targetState,
          targetState, observation.active ? null : at, targetState, observation.active ? null : at,
          observation.expiresAt ?? null, at, existing.presence_id,
        );
        appendEvent({
          itemId: existing.presence_id, type: observation.active ? (fromState === 'resolved' ? 'reactivated' : 'updated') : 'resolved',
          fromState, toState: targetState, idempotencyKey: `source:${observation.sourceRevision}`, at,
          reason: { reasonCode: observation.reasonCode },
        });
        return { item: itemFromRow(row(existing.presence_id)!), created: false, stale: false };
      }).immediate();
    },

    get(itemId) {
      const found = row(itemId);
      if (!found) return null;
      refreshTemporalState({ workspaceId: found.workspace_id, ownerId: found.owner_id });
      const refreshed = row(itemId);
      return refreshed ? itemFromRow(refreshed) : null;
    },

    list(scope) {
      refreshTemporalState(scope);
      const [workspaceId, ownerId] = scopeValues(scope);
      const rows = scope
        ? options.db.prepare(
          `SELECT * FROM presence_items WHERE workspace_id IS ? AND owner_id IS ?
           ORDER BY priority DESC,last_observed_at DESC,presence_id`,
        ).all(workspaceId, ownerId)
        : options.db.prepare(
          'SELECT * FROM presence_items ORDER BY priority DESC,last_observed_at DESC,presence_id',
        ).all();
      return (rows as PresenceRow[]).map(itemFromRow);
    },

    events(itemId) {
      return (options.db.prepare(
        `SELECT event_id,event_type,from_state,to_state,reason_json,created_at
           FROM presence_item_events WHERE presence_id=? ORDER BY event_sequence`,
      ).all(itemId) as Array<{ event_id: string; event_type: string; from_state: string | null; to_state: string | null; reason_json: string; created_at: number }>).map((event) => ({
        eventId: event.event_id, type: event.event_type, fromState: event.from_state, toState: event.to_state,
        reason: json(event.reason_json, {}), createdAt: event.created_at,
      }));
    },

    snapshot(scope) {
      if (!options.enabled) return { enabled: false, quietHours: false, interruptions: [], needsYou: [], reviewWhenReady: [], recentlyResolved: [] };
      const all = authority.list(scope);
      const preferences = authority.getPreferences(scope);
      const windowStart = now() - preferences.interruptionWindowMs;
      const interrupted = ((scope ? options.db.prepare(
        `SELECT COUNT(*) AS count FROM presence_item_events e JOIN presence_items p ON p.presence_id=e.presence_id
          WHERE e.event_type='interrupted' AND e.created_at>=? AND p.workspace_id IS ? AND p.owner_id IS ?`,
      ).get(windowStart, scope.workspaceId ?? null, scope.ownerId ?? null) : options.db.prepare(
        `SELECT COUNT(*) AS count FROM presence_item_events WHERE event_type='interrupted' AND created_at>=?`,
      ).get(windowStart)) as { count: number }).count;
      const lastInterrupt = (scope ? options.db.prepare(
        `SELECT MAX(e.created_at) AS at FROM presence_item_events e JOIN presence_items p ON p.presence_id=e.presence_id
          WHERE e.event_type='interrupted' AND p.workspace_id IS ? AND p.owner_id IS ?`,
      ).get(scope.workspaceId ?? null, scope.ownerId ?? null) : options.db.prepare(
        `SELECT MAX(created_at) AS at FROM presence_item_events WHERE event_type='interrupted'`,
      ).get()) as { at: number | null };
      const projected = evaluateAttentionPolicy({
        items: all, preferences, now: now(), interruptionCount: interrupted,
        lastInterruptionAt: lastInterrupt.at,
      });
      for (const item of projected.interruptions) {
        const bucket = Math.floor(now() / Math.max(1, preferences.cooldownMs || 1));
        appendEvent({
          itemId: item.id, type: 'interrupted', fromState: item.state, toState: item.state,
          idempotencyKey: `interrupt:${bucket}`, reason: { policy: 'deterministic_attention', priority: item.priority },
        });
      }
      return projected;
    },

    explain(itemId) {
      const item = authority.get(itemId);
      if (!item) throw new Error('Presence item not found');
      return {
        itemId, reason: item.reason, reasonCode: item.reasonCode,
        source: { kind: item.sourceKind, identity: item.sourceIdentity, revision: item.sourceRevision },
        history: authority.events(itemId),
      };
    },

    snooze(input) {
      if (!Number.isFinite(input.until) || input.until <= now()) throw new Error('Snooze must end in the future');
      const current = row(input.itemId);
      if (!current) throw new Error('Presence item not found');
      const result = options.db.prepare(
        `UPDATE presence_items SET state='snoozed',snoozed_until=?,terminal_at=NULL,updated_at=?,state_version=state_version+1
          WHERE presence_id=? AND state_version=? AND state IN ('active','snoozed')`,
      ).run(input.until, now(), input.itemId, input.expectedVersion);
      if (result.changes !== 1) throw new Error('Presence item version conflict');
      appendEvent({ itemId: input.itemId, type: 'snoozed', fromState: current.state, toState: 'snoozed', idempotencyKey: `snooze:${input.expectedVersion}:${input.until}` });
      return itemFromRow(row(input.itemId)!);
    },

    dismiss(input) {
      const current = row(input.itemId);
      if (!current) throw new Error('Presence item not found');
      const at = now();
      const result = options.db.prepare(
        `UPDATE presence_items SET state='dismissed',dismissed_at=?,terminal_at=?,snoozed_until=NULL,updated_at=?,state_version=state_version+1
          WHERE presence_id=? AND state_version=? AND state IN ('active','snoozed')`,
      ).run(at, at, at, input.itemId, input.expectedVersion);
      if (result.changes !== 1) throw new Error('Presence item version conflict');
      appendEvent({ itemId: input.itemId, type: 'dismissed', fromState: current.state, toState: 'dismissed', idempotencyKey: `dismiss:${input.expectedVersion}`, reason: { reason: input.reason ?? null } });
      return itemFromRow(row(input.itemId)!);
    },

    setPreferences(input) {
      const workspaceId = input.workspaceId ?? null;
      const ownerId = input.ownerId ?? null;
      const current = authority.getPreferences({ workspaceId, ownerId });
      const at = now();
      const timezone = input.timezone ?? current.timezone;
      if (!validateAttentionTimezone(timezone, at)) throw new Error('Invalid IANA timezone');
      const quietStart = input.quietStart === undefined ? current.quietStart : input.quietStart;
      const quietEnd = input.quietEnd === undefined ? current.quietEnd : input.quietEnd;
      if (!validateAttentionPreferenceClock(quietStart) || !validateAttentionPreferenceClock(quietEnd)) {
        throw new Error('Quiet hours must use HH:MM');
      }
      const id = `attention_pref_${digest(`${workspaceId ?? ''}\0${ownerId ?? ''}`).slice(0, 24)}`;
      options.db.prepare(
        `INSERT INTO attention_preferences (
           preference_id,workspace_id,owner_id,timezone,quiet_start,quiet_end,max_interruptions,
           interruption_window_ms,cooldown_ms,notification_consent,allowed_delivery_classes_json,
           default_snooze_ms,state_version,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
         ON CONFLICT(workspace_id,owner_id) DO UPDATE SET
           timezone=excluded.timezone,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,
           max_interruptions=excluded.max_interruptions,interruption_window_ms=excluded.interruption_window_ms,
           cooldown_ms=excluded.cooldown_ms,notification_consent=excluded.notification_consent,
           allowed_delivery_classes_json=excluded.allowed_delivery_classes_json,default_snooze_ms=excluded.default_snooze_ms,
           state_version=attention_preferences.state_version+1,updated_at=excluded.updated_at`,
      ).run(id, workspaceId, ownerId, timezone, quietStart, quietEnd,
        input.maxInterruptions ?? current.maxInterruptions,
        input.interruptionWindowMs ?? current.interruptionWindowMs,
        input.cooldownMs ?? current.cooldownMs,
        (input.notificationConsent ?? current.notificationConsent) ? 1 : 0,
        JSON.stringify((input.allowedDeliveryClasses ?? current.allowedDeliveryClasses)
          .filter((value) => typeof value === 'string' && value.length > 0).slice(0, 20).map((value) => value.slice(0, 80))),
        input.defaultSnoozeMs ?? current.defaultSnoozeMs, at, at);
      return authority.getPreferences({ workspaceId, ownerId });
    },

    getPreferences(scope) {
      const [workspaceId, ownerId] = scopeValues(scope);
      const found = options.db.prepare(
        'SELECT * FROM attention_preferences WHERE workspace_id IS ? AND owner_id IS ?',
      ).get(workspaceId, ownerId) as PreferenceRow | undefined;
      return found ? {
        workspaceId: found.workspace_id, ownerId: found.owner_id, timezone: found.timezone,
        quietStart: found.quiet_start, quietEnd: found.quiet_end, maxInterruptions: found.max_interruptions,
        interruptionWindowMs: found.interruption_window_ms, cooldownMs: found.cooldown_ms,
        notificationConsent: found.notification_consent === 1,
        allowedDeliveryClasses: json<string[]>(found.allowed_delivery_classes_json, []),
        defaultSnoozeMs: found.default_snooze_ms,
        version: found.state_version,
      } : {
        workspaceId, ownerId, timezone: 'UTC', quietStart: null, quietEnd: null,
        maxInterruptions: 3, interruptionWindowMs: 3_600_000, cooldownMs: 300_000,
        notificationConsent: false, allowedDeliveryClasses: [], defaultSnoozeMs: 3_600_000, version: 0,
      };
    },

    startupBriefing(input) {
      const snapshot = authority.snapshot(input);
      const candidates = [...snapshot.needsYou, ...snapshot.reviewWhenReady, ...snapshot.recentlyResolved];
      const unseen = candidates.filter((item) => !options.db.prepare(
        'SELECT 1 FROM presence_item_events WHERE presence_id=? AND idempotency_key=?',
      ).get(item.id, `briefing:${input.briefingId}`));
      const tx = options.db.transaction(() => {
        for (const item of unseen) appendEvent({
          itemId: item.id, type: 'briefing_shown', fromState: item.state, toState: item.state,
          idempotencyKey: `briefing:${input.briefingId}`, reason: { briefingId: input.briefingId },
        });
      });
      tx.immediate();
      return {
        briefingId: input.briefingId,
        duplicate: unseen.length === 0 && candidates.length > 0,
        items: unseen,
        groups: {
          changed: unseen.filter((item) => item.state !== 'resolved' && ![
            'unresolved_gate', 'approval_required', 'unknown_effect', 'browser_takeover', 'connection_blocker',
            'automation_failure', 'budget_attention', 'ready_review', 'next_action',
          ].includes(item.category)),
          resolved: unseen.filter((item) => item.state === 'resolved'),
          blocked: unseen.filter((item) => item.state !== 'resolved' && [
            'unresolved_gate', 'approval_required', 'unknown_effect', 'browser_takeover', 'connection_blocker',
            'automation_failure', 'budget_attention',
          ].includes(item.category)),
          ready: unseen.filter((item) => item.state !== 'resolved' && item.category === 'ready_review'),
          next: unseen.filter((item) => item.state !== 'resolved' && item.category === 'next_action'),
        },
      };
    },

    propose(input) {
      if (!options.enabled) throw new Error('Agentic Presence is not enabled for this edition');
      const item = authority.get(input.itemId);
      if (!item || item.state !== 'active') throw new Error('Presence source is not currently actionable');
      const at = now();
      const prompt = String(input.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 4_000);
      const goal = String(input.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!prompt || !goal) throw new Error('Proposed Job requires a prompt and goal');
      const existing = options.db.prepare(
        `SELECT * FROM presence_proposed_jobs
          WHERE presence_id=? AND source_digest=? AND prompt=? AND goal=? AND state IN ('proposed','accepting','accepted')
          ORDER BY created_at DESC LIMIT 1`,
      ).get(item.id, item.sourceDigest, prompt, goal) as ProposalRow | undefined;
      if (existing) return proposalFromRow(existing);
      const proposalId = `proposal_${nextId().replace(/-/g, '')}`;
      options.db.prepare(
        `INSERT INTO presence_proposed_jobs (
           proposal_id,presence_id,source_digest,workspace_id,owner_id,prompt,goal,state,state_version,
           created_at,updated_at,expires_at
         ) VALUES (?,?,?,?,?,?,?,'proposed',1,?,?,?)`,
      ).run(proposalId, item.id, item.sourceDigest, input.workspaceId ?? item.workspaceId,
        input.ownerId ?? item.ownerId, prompt, goal, at, at, input.expiresAt ?? null);
      appendEvent({ itemId: item.id, type: 'job_proposed', fromState: item.state, toState: item.state, idempotencyKey: `proposal:${proposalId}`, reason: { proposalId } });
      return proposalFromRow(proposalRow(proposalId)!);
    },

    getProposal(proposalId) {
      const found = proposalRow(proposalId);
      return found ? proposalFromRow(found) : null;
    },

    listProposals(scope) {
      const [workspaceId, ownerId] = scopeValues(scope);
      const rows = (scope ? options.db.prepare(
        `SELECT * FROM presence_proposed_jobs WHERE workspace_id IS ? AND owner_id IS ?
          ORDER BY updated_at DESC,proposal_id`,
      ).all(workspaceId, ownerId) : options.db.prepare(
        'SELECT * FROM presence_proposed_jobs ORDER BY updated_at DESC,proposal_id',
      ).all()) as ProposalRow[];
      return rows.map(proposalFromRow);
    },

    acceptProposal(input) {
      if (!options.enabled) throw new Error('Agentic Presence is not enabled for this edition');
      const existing = authority.getProposal(input.proposalId);
      if (!existing) throw new Error('Proposed Job not found');
      if (existing.state === 'accepted') return existing;
      if (!['proposed', 'accepting'].includes(existing.state)) return existing;
      if (existing.version !== input.expectedVersion) throw new Error('Proposed Job version conflict');
      const item = authority.get(existing.itemId);
      const validation = item && item.state === 'active' && item.sourceDigest === existing.sourceDigest
        ? input.revalidate(existing, item)
        : { ok: false, reason: 'source is no longer current' };
      if (!validation.ok) {
        const at = now();
        options.db.prepare(
          `UPDATE presence_proposed_jobs SET state='invalidated',invalidation_reason=?,state_version=state_version+1,updated_at=?
            WHERE proposal_id=? AND state_version=?`,
        ).run(validation.reason ?? 'revalidation failed', at, existing.id, existing.version);
        return proposalFromRow(proposalRow(existing.id)!);
      }
      if (existing.expiresAt !== null && existing.expiresAt <= now()) {
        options.db.prepare(
          `UPDATE presence_proposed_jobs SET state='expired',invalidation_reason='proposal expired',state_version=state_version+1,updated_at=?
            WHERE proposal_id=? AND state_version=?`,
        ).run(now(), existing.id, existing.version);
        return proposalFromRow(proposalRow(existing.id)!);
      }
      const accepting = options.db.prepare(
        `UPDATE presence_proposed_jobs SET state='accepting',state_version=state_version+1,updated_at=?
          WHERE proposal_id=? AND state_version=? AND state IN ('proposed','accepting')`,
      ).run(now(), existing.id, existing.version);
      if (accepting.changes !== 1) throw new Error('Proposed Job version conflict');
      let admitted: PresenceEnqueueResult;
      try {
        admitted = input.enqueue({
          message: existing.prompt,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          idempotencyKey: `presence-proposal:${existing.id}`,
        });
      } catch (error) {
        options.db.prepare(
          `UPDATE presence_proposed_jobs SET state='proposed',state_version=state_version+1,updated_at=? WHERE proposal_id=? AND state='accepting'`,
        ).run(now(), existing.id);
        throw error;
      }
      if (!admitted.accepted || !admitted.jobId || !admitted.attemptId || admitted.runId === undefined) {
        options.db.prepare(
          `UPDATE presence_proposed_jobs SET state='proposed',state_version=state_version+1,updated_at=? WHERE proposal_id=? AND state='accepting'`,
        ).run(now(), existing.id);
        throw new Error('Ordinary Workbench Job admission rejected the proposal');
      }
      const at = now();
      options.db.prepare(
        `UPDATE presence_proposed_jobs SET state='accepted',job_id=?,attempt_id=?,run_id=?,trigger_event_id=?,
           accepted_at=?,updated_at=?,state_version=state_version+1 WHERE proposal_id=? AND state='accepting'`,
      ).run(admitted.jobId, admitted.attemptId, admitted.runId, admitted.triggerEventId ?? null, at, at, existing.id);
      appendEvent({ itemId: existing.itemId, type: 'proposal_accepted', idempotencyKey: `proposal-accepted:${existing.id}`, reason: { proposalId: existing.id, jobId: admitted.jobId } });
      return proposalFromRow(proposalRow(existing.id)!);
    },

    feedback(input) {
      const item = authority.get(input.itemId);
      if (!item) throw new Error('Presence item not found');
      const eventId = appendEvent({
        itemId: item.id, type: 'feedback', fromState: item.state, toState: item.state,
        idempotencyKey: `feedback:${input.kind}:${nextId()}`, reason: { kind: input.kind },
      });
      return { accepted: true, eventId };
    },
  };
  return authority;
}
