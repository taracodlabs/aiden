/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

import type { TriggerBus } from '../daemon/triggerBus';
import type { AutomationRevisionSpec } from './types';

function nonce(): string {
  return randomBytes(12).toString('hex');
}

export interface AutomationControlAuthority {
  runNow(automationId: string, now?: number): { triggerEventId: number; sourceIdentity: string };
  replay(occurrenceId: string, now?: number): { triggerEventId: number; sourceIdentity: string };
  emitBound(input: { bindingId: string; providerEventId: string; payload: Record<string, unknown> }): {
    triggerEventId: number; inserted: boolean;
  };
}

export function createAutomationControlAuthority(options: {
  db: Database.Database;
  triggerBus: TriggerBus;
}): AutomationControlAuthority {
  const { db, triggerBus } = options;
  const current = (automationId: string) => {
    const row = db.prepare(
      `SELECT d.automation_id,d.current_revision_id,d.enabled,r.spec_json
         FROM automation_definitions d
         JOIN automation_revisions r ON r.revision_id = d.current_revision_id
        WHERE d.automation_id = ?`,
    ).get(automationId) as {
      automation_id: string; current_revision_id: string; enabled: number; spec_json: string;
    } | undefined;
    if (!row) throw new Error(`Automation not found: ${automationId}`);
    if (row.enabled !== 1) throw new Error('Automation is disabled');
    return row;
  };
  return {
    runNow(automationId, now = Date.now()) {
      const row = current(automationId);
      const sourceIdentity = `manual:${new Date(now).toISOString()}:${nonce()}`;
      const event = triggerBus.insert({
        source: 'manual', sourceKey: automationId, idempotencyKey: sourceIdentity,
        payload: {
          automationId, revisionId: row.current_revision_id, triggerKind: 'manual',
          sourceIdentity, untrustedContent: false,
        },
      });
      return { triggerEventId: event.id, sourceIdentity };
    },
    replay(occurrenceId, now = Date.now()) {
      const original = db.prepare(
        `SELECT o.automation_id,o.revision_id,o.state
           FROM automation_occurrences o WHERE o.occurrence_id = ?`,
      ).get(occurrenceId) as { automation_id: string; revision_id: string; state: string } | undefined;
      if (!original) throw new Error(`Automation occurrence not found: ${occurrenceId}`);
      if (original.state === 'unknown') throw new Error('Unknown-effect occurrences cannot be replayed before reconciliation');
      const sourceIdentity = `replay:${occurrenceId}:${new Date(now).toISOString()}:${nonce()}`;
      const event = triggerBus.insert({
        source: 'manual', sourceKey: original.automation_id, idempotencyKey: sourceIdentity,
        payload: {
          automationId: original.automation_id, revisionId: original.revision_id,
          triggerKind: 'manual', sourceIdentity, replayOfOccurrenceId: occurrenceId,
          untrustedContent: false,
        },
      });
      return { triggerEventId: event.id, sourceIdentity };
    },
    emitBound(input) {
      const providerEventId = input.providerEventId.trim();
      if (!providerEventId || providerEventId.length > 2_048 || /[\u0000-\u001f\u007f]/.test(providerEventId)) {
        throw new Error('Automation provider event identity is invalid');
      }
      let triggerPayload: Record<string, unknown>;
      try {
        const serialized = JSON.stringify(input.payload);
        if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) throw new Error('payload exceeds limit');
        triggerPayload = JSON.parse(serialized) as Record<string, unknown>;
      } catch {
        throw new Error('Automation trigger payload is invalid or exceeds 1000000 bytes');
      }
      const bindings = db.prepare(
        `SELECT b.binding_id,b.automation_id,b.revision_id,b.trigger_kind,b.enabled,d.enabled AS definition_enabled,r.spec_json
           FROM automation_trigger_bindings b
           JOIN automation_definitions d ON d.automation_id = b.automation_id
           JOIN automation_revisions r ON r.revision_id = b.revision_id
          WHERE b.binding_id = ? OR b.source_key = ?`,
      ).all(input.bindingId, input.bindingId) as Array<{
        binding_id: string; automation_id: string; revision_id: string; trigger_kind: string;
        enabled: number; definition_enabled: number; spec_json: string;
      }>;
      const binding = bindings.find((candidate) => candidate.binding_id === input.bindingId)
        ?? (bindings.length === 1 ? bindings[0] : undefined);
      if (bindings.length > 1 && !bindings.some((candidate) => candidate.binding_id === input.bindingId)) {
        throw new Error('Automation trigger source matches multiple bindings; use the exact binding identity');
      }
      if (!binding || binding.enabled !== 1 || binding.definition_enabled !== 1) {
        throw new Error('Automation trigger binding is unavailable');
      }
      JSON.parse(binding.spec_json) as AutomationRevisionSpec;
      const sourceIdentity = `${binding.binding_id}:${providerEventId}`;
      const source = binding.trigger_kind === 'webhook' ? 'webhook'
        : binding.trigger_kind === 'file' ? 'file'
        : 'manual';
      const event = triggerBus.insert({
        source, sourceKey: binding.automation_id,
        idempotencyKey: sourceIdentity,
        payload: {
          automationId: binding.automation_id, revisionId: binding.revision_id,
          triggerKind: binding.trigger_kind, sourceIdentity,
          triggerPayload, untrustedContent: true,
        },
      });
      return { triggerEventId: event.id, inserted: event.inserted };
    },
  };
}
