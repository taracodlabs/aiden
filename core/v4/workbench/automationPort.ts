/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type Database from 'better-sqlite3';

import type { EditionAuthority } from '../commercial/edition';
import type { TriggerBus } from '../daemon/triggerBus';
import { createAutomationAuthority } from '../automation/automationAuthority';
import { createAutomationControlAuthority } from '../automation/controlAuthority';
import { previewSchedule } from '../automation/schedule';
import type { AutomationRevisionSpec } from '../automation/types';

export interface WorkbenchAutomationSummary {
  automationId: string;
  name: string;
  enabled: boolean;
  revisionId: string;
  revisionNumber: number;
  action: AutomationRevisionSpec['action'];
  trigger: AutomationRevisionSpec['trigger'];
  policies: AutomationRevisionSpec['policies'];
  capabilities: readonly string[];
  nextFireAt: string | null;
  lastOccurrence: { occurrenceId: string; state: string; jobId: string | null; createdAt: number } | null;
}

export interface WorkbenchAutomationSnapshot {
  capability: { available: boolean; reason?: string };
  scheduler: { ready: boolean; dueBindings: number };
  automations: WorkbenchAutomationSummary[];
  history: WorkbenchAutomationOccurrence[];
  attention: Array<{ automationId: string; state: string; occurrenceId: string }>;
}

export interface WorkbenchAutomationOccurrence {
  occurrenceId: string;
  automationId: string;
  revisionId: string;
  triggerKind: string;
  scheduledFor: string | null;
  triggeredAt: number;
  admittedAt: number | null;
  jobId: string | null;
  attemptId: string | null;
  state: string;
  replayOfOccurrenceId: string | null;
  updatedAt: number;
  detail: {
    reason?: string;
    delivery?: { state: 'completed' | 'failed' | 'unknown'; detail?: string; updatedAt?: number };
  };
}

export interface WorkbenchAutomationPort {
  snapshot(): WorkbenchAutomationSnapshot;
  create(input: AutomationRevisionSpec & { name: string; createdBy: string }): WorkbenchAutomationSummary;
  revise(automationId: string, input: Omit<AutomationRevisionSpec, 'workspace'> & { createdBy: string }): WorkbenchAutomationSummary;
  setEnabled(automationId: string, enabled: boolean): WorkbenchAutomationSummary;
  runNow(automationId: string): { triggerEventId: number };
  replay(occurrenceId: string): { triggerEventId: number };
  preview(input: { expression: string; timezone: string; count?: number }): readonly string[];
}

export function createWorkbenchAutomationPort(options: {
  db: Database.Database;
  triggerBus: TriggerBus;
  edition: EditionAuthority;
  ownerId?: string;
  workspaceId?: string | null;
  /** Host-owned workspace root. Client automation payloads cannot override it. */
  workspaceRoot?: string;
}): WorkbenchAutomationPort {
  const { db } = options;
  const authority = createAutomationAuthority({ db });
  const control = createAutomationControlAuthority({ db, triggerBus: options.triggerBus });
  const requireCapability = (): void => {
    if (!options.edition.can('automation.create')) throw new Error('Reliable Automations require Aiden Pro');
  };
  const project = (automationId: string): WorkbenchAutomationSummary => {
    const row = db.prepare(
      `SELECT d.automation_id,d.name,d.enabled,d.current_revision_id,
              r.revision_number,r.spec_json,b.next_fire_at
         FROM automation_definitions d
         JOIN automation_revisions r ON r.revision_id = d.current_revision_id
         LEFT JOIN automation_trigger_bindings b ON b.revision_id = r.revision_id AND b.enabled = 1
        WHERE d.automation_id = ?`,
    ).get(automationId) as {
      automation_id: string; name: string; enabled: number; current_revision_id: string;
      revision_number: number; spec_json: string; next_fire_at: string | null;
    } | undefined;
    if (!row) throw new Error(`Automation not found: ${automationId}`);
    const occurrence = db.prepare(
      `SELECT occurrence_id,state,job_id,created_at FROM automation_occurrences
        WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(automationId) as { occurrence_id: string; state: string; job_id: string | null; created_at: number } | undefined;
    const spec = JSON.parse(row.spec_json) as AutomationRevisionSpec;
    return {
      automationId: row.automation_id, name: row.name, enabled: row.enabled === 1,
      revisionId: row.current_revision_id, revisionNumber: row.revision_number,
      action: spec.action, trigger: spec.trigger, policies: spec.policies,
      capabilities: [...spec.capabilities], nextFireAt: row.next_fire_at,
      lastOccurrence: occurrence ? {
        occurrenceId: occurrence.occurrence_id, state: occurrence.state,
        jobId: occurrence.job_id, createdAt: occurrence.created_at,
      } : null,
    };
  };
  return {
    snapshot() {
      const available = options.edition.can('automation.create');
      const ids = db.prepare('SELECT automation_id FROM automation_definitions ORDER BY updated_at DESC LIMIT 500')
        .all() as Array<{ automation_id: string }>;
      const due = db.prepare(
        `SELECT COUNT(*) AS count FROM automation_trigger_bindings b
          JOIN automation_definitions d ON d.automation_id = b.automation_id
         WHERE b.enabled = 1 AND d.enabled = 1 AND b.next_fire_at IS NOT NULL AND b.next_fire_at <= ?`,
      ).get(new Date().toISOString()) as { count: number };
      const attention = db.prepare(
        `SELECT automation_id,state,occurrence_id FROM automation_occurrences
          WHERE state IN ('waiting_approval','blocked','unknown','failed')
          ORDER BY updated_at DESC LIMIT 100`,
      ).all() as Array<{ automation_id: string; state: string; occurrence_id: string }>;
      const history = db.prepare(
        `SELECT occurrence_id,automation_id,revision_id,trigger_kind,scheduled_for,
                triggered_at,admitted_at,job_id,attempt_id,state,replay_of_occurrence_id,updated_at,detail_json
           FROM automation_occurrences
          ORDER BY triggered_at DESC,occurrence_id DESC LIMIT 200`,
      ).all() as Array<{
        occurrence_id: string; automation_id: string; revision_id: string; trigger_kind: string;
        scheduled_for: string | null; triggered_at: number; admitted_at: number | null;
        job_id: string | null; attempt_id: string | null; state: string;
        replay_of_occurrence_id: string | null; updated_at: number;
        detail_json: string;
      }>;
      return {
        capability: available ? { available: true } : { available: false, reason: 'Reliable Automations require Aiden Pro' },
        scheduler: { ready: true, dueBindings: due.count },
        automations: ids.map((row) => project(row.automation_id)),
        history: history.map((row) => ({
          occurrenceId: row.occurrence_id, automationId: row.automation_id,
          revisionId: row.revision_id, triggerKind: row.trigger_kind,
          scheduledFor: row.scheduled_for, triggeredAt: row.triggered_at,
          admittedAt: row.admitted_at, jobId: row.job_id, attemptId: row.attempt_id,
          state: row.state, replayOfOccurrenceId: row.replay_of_occurrence_id,
          updatedAt: row.updated_at,
          detail: (() => {
            try { return JSON.parse(row.detail_json) as WorkbenchAutomationOccurrence['detail']; }
            catch { return {}; }
          })(),
        })),
        attention: attention.map((row) => ({ automationId: row.automation_id, state: row.state, occurrenceId: row.occurrence_id })),
      };
    },
    create(input) {
      requireCapability();
      const created = authority.create({
        ...input,
        workspace: { rootPath: options.workspaceRoot ?? process.cwd() },
        ownerId: options.ownerId ?? input.createdBy,
        workspaceId: options.workspaceId ?? null,
        commercialContext: 'pro',
      });
      return project(created.definition.id);
    },
    revise(automationId, input) {
      requireCapability();
      const { createdBy, ...spec } = input;
      authority.revise(automationId, {
        ...spec,
        workspace: { rootPath: options.workspaceRoot ?? process.cwd() },
      }, { createdBy });
      return project(automationId);
    },
    setEnabled(automationId, enabled) {
      requireCapability(); authority.setEnabled(automationId, enabled); return project(automationId);
    },
    runNow(automationId) {
      requireCapability(); const result = control.runNow(automationId); return { triggerEventId: result.triggerEventId };
    },
    replay(occurrenceId) {
      requireCapability(); const result = control.replay(occurrenceId); return { triggerEventId: result.triggerEventId };
    },
    preview(input) {
      requireCapability(); return previewSchedule({ ...input, count: input.count ?? 5 }).instants;
    },
  };
}
