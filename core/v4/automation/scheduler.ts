/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type Database from 'better-sqlite3';

import type { TriggerBus } from '../daemon/triggerBus';
import { computeOccurrenceKey } from './occurrenceKey';
import { nextScheduleInstants, previousScheduleInstant } from './schedule';
import type { AutomationRevisionSpec } from './types';

export interface AutomationScheduler {
  scanDue(now?: number): { scanned: number; emitted: number; duplicates: number; released: number };
}

type DueBinding = {
  binding_id: string;
  automation_id: string;
  revision_id: string;
  schedule_expression: string;
  timezone: string;
  next_fire_at: string;
  spec_json: string;
};

export function createAutomationScheduler(options: {
  db: Database.Database;
  triggerBus: TriggerBus;
  maxPerScan?: number;
  misfireGraceMs?: number;
}): AutomationScheduler {
  const { db, triggerBus } = options;
  const maxPerScan = options.maxPerScan ?? 100;
  const misfireGraceMs = options.misfireGraceMs ?? 60_000;
  if (!Number.isInteger(maxPerScan) || maxPerScan < 1 || maxPerScan > 1_000) {
    throw new Error('Automation scheduler maxPerScan must be between 1 and 1000');
  }
  return {
    scanDue(now = Date.now()) {
      return db.transaction(() => {
        db.prepare(
          `UPDATE automation_occurrences
              SET state = CASE
                WHEN job_id IN (SELECT id FROM tasks WHERE status = 'completed') THEN 'completed'
                WHEN job_id IN (SELECT id FROM tasks WHERE status = 'cancelled') THEN 'cancelled'
                WHEN job_id IN (SELECT id FROM tasks WHERE status IN ('failed','dead_letter')) THEN 'failed'
                WHEN job_id IN (SELECT id FROM tasks WHERE status = 'blocked') THEN 'blocked'
                WHEN job_id IN (SELECT id FROM tasks WHERE status = 'unknown') THEN 'unknown'
                ELSE state END,
                  updated_at = ?
            WHERE state IN ('admitted','waiting_approval','running','unknown') AND job_id IS NOT NULL`,
        ).run(now);
        const queued = db.prepare(
          `SELECT o.occurrence_id,o.occurrence_key,o.automation_id,o.revision_id,o.trigger_kind,
                  o.scheduled_for,o.source_identity,o.replay_of_occurrence_id
             FROM automation_occurrences o
            WHERE o.state = 'queued_overlap'
              AND NOT EXISTS (
                SELECT 1 FROM automation_occurrences p
                LEFT JOIN tasks t ON t.id = p.job_id
                WHERE p.automation_id = o.automation_id AND p.occurrence_id <> o.occurrence_id
                  AND (
                    p.created_at < o.created_at
                    OR (p.created_at = o.created_at AND p.trigger_event_id < o.trigger_event_id)
                  )
                  AND (p.state = 'queued_overlap' OR t.status IS NULL OR t.status NOT IN ('completed','cancelled','failed','dead_letter'))
              )
            ORDER BY o.created_at,o.trigger_event_id,o.occurrence_id LIMIT ?`,
        ).all(maxPerScan) as Array<{
          occurrence_id: string; occurrence_key: string; automation_id: string; revision_id: string;
          trigger_kind: string; scheduled_for: string | null; source_identity: string; replay_of_occurrence_id: string | null;
        }>;
        let released = 0;
        for (const occurrence of queued) {
          const event = triggerBus.insert({
            source: 'manual', sourceKey: occurrence.automation_id,
            idempotencyKey: `overlap-release:${occurrence.occurrence_key}`,
            payload: {
              automationId: occurrence.automation_id, revisionId: occurrence.revision_id,
              triggerKind: occurrence.trigger_kind, scheduledFor: occurrence.scheduled_for,
              sourceIdentity: occurrence.source_identity,
              ...(occurrence.replay_of_occurrence_id ? { replayOfOccurrenceId: occurrence.replay_of_occurrence_id } : {}),
              untrustedContent: false,
            },
          });
          if (event.inserted) released += 1;
        }
        const due = db.prepare(
          `SELECT b.*,r.spec_json
             FROM automation_trigger_bindings b
             JOIN automation_definitions d ON d.automation_id = b.automation_id
             JOIN automation_revisions r ON r.revision_id = b.revision_id
            WHERE b.enabled = 1 AND d.enabled = 1 AND b.trigger_kind = 'schedule'
              AND b.next_fire_at IS NOT NULL AND b.next_fire_at <= ?
            ORDER BY b.next_fire_at,b.binding_id
            LIMIT ?`,
        ).all(new Date(now).toISOString(), maxPerScan) as DueBinding[];
        let emitted = 0;
        let duplicates = 0;
        for (const binding of due) {
          const spec = JSON.parse(binding.spec_json) as AutomationRevisionSpec;
          if (spec.trigger.kind !== 'schedule') throw new Error('Schedule binding references a non-schedule revision');
          const dueInstants = planDueInstants({
            firstDue: binding.next_fire_at, now, expression: binding.schedule_expression,
            timezone: binding.timezone, policy: spec.policies.misfire, graceMs: misfireGraceMs,
          });
          for (const scheduledFor of dueInstants) {
            const sourceIdentity = `schedule:${scheduledFor}`;
            const occurrenceKey = computeOccurrenceKey({
              automationId: binding.automation_id, revisionId: binding.revision_id,
              triggerKind: 'schedule', scheduledFor, sourceIdentity,
            });
            const inserted = triggerBus.insert({
              source: 'schedule', sourceKey: binding.automation_id, idempotencyKey: occurrenceKey,
              payload: {
                automationId: binding.automation_id,
                revisionId: binding.revision_id,
                triggerKind: 'schedule', scheduledFor, sourceIdentity,
                untrustedContent: false,
              },
            });
            if (inserted.inserted) emitted += 1;
            else duplicates += 1;
          }
          const next = binding.schedule_expression.startsWith('oneshot:') ? null : nextScheduleInstants({
            expression: binding.schedule_expression,
            timezone: binding.timezone,
            after: new Date(now),
            count: 1,
          })[0];
          const updated = db.prepare(
            `UPDATE automation_trigger_bindings
                SET next_fire_at = ?,enabled = CASE WHEN ? IS NULL THEN 0 ELSE enabled END,last_scanned_at = ?,updated_at = ?
              WHERE binding_id = ? AND next_fire_at = ?`,
          ).run(next, next, now, now, binding.binding_id, binding.next_fire_at);
          if (updated.changes !== 1) throw new Error('Automation scheduler lost binding authority');
        }
        return { scanned: due.length, emitted, duplicates, released };
      }).immediate();
    },
  };
}

function planDueInstants(input: {
  firstDue: string;
  now: number;
  expression: string;
  timezone: string;
  policy: AutomationRevisionSpec['policies']['misfire'];
  graceMs: number;
}): string[] {
  const firstMs = Date.parse(input.firstDue);
  if (!Number.isFinite(firstMs) || firstMs > input.now) return [];
  const age = input.now - firstMs;
  if (input.policy.kind === 'skip') return age <= input.graceMs ? [input.firstDue] : [];
  const maxAge = input.policy.maxAgeMs;
  if (input.policy.kind === 'run_once') {
    const latest = latestDue(input);
    return maxAge !== undefined && input.now - Date.parse(latest) > maxAge ? [] : [latest];
  }
  const cap = Math.min(input.policy.maxOccurrences, 100);
  const cutoff = maxAge === undefined ? firstMs : Math.max(firstMs, input.now - maxAge);
  if (input.expression.startsWith('oneshot:')) {
    return firstMs >= cutoff && firstMs <= input.now ? [input.firstDue] : [];
  }
  if (input.expression.startsWith('interval:')) {
    const interval = Number.parseInt(input.expression.slice('interval:'.length), 10);
    const firstIndex = Math.max(0, Math.ceil((cutoff - firstMs) / interval));
    const out: string[] = [];
    for (let index = firstIndex; index < firstIndex + cap; index += 1) {
      const instant = firstMs + index * interval;
      if (instant > input.now) break;
      out.push(new Date(instant).toISOString());
    }
    return out;
  }
  const anchor = new Date(cutoff - 1);
  return nextScheduleInstants({
    expression: input.expression, timezone: input.timezone, after: anchor, count: cap,
  }).filter((instant) => Date.parse(instant) >= firstMs && Date.parse(instant) <= input.now);
}

function latestDue(input: { firstDue: string; now: number; expression: string; timezone: string }): string {
  const firstMs = Date.parse(input.firstDue);
  if (input.expression.startsWith('interval:')) {
    const interval = Number.parseInt(input.expression.slice('interval:'.length), 10);
    return new Date(firstMs + Math.floor((input.now - firstMs) / interval) * interval).toISOString();
  }
  if (input.expression.startsWith('oneshot:')) return input.firstDue;
  return previousScheduleInstant({
    expression: input.expression, timezone: input.timezone, before: new Date(input.now + 1),
  }) ?? input.firstDue;
}
