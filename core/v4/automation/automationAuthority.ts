/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';

import type {
  AutomationDefinitionRecord,
  AutomationRevisionRecord,
  AutomationRevisionSpec,
} from './types';
import { nextScheduleInstants } from './schedule';
import { validateScriptSpec } from './scriptSpec';
import { validateExactActionArguments } from '../integrations/tools';
import type { AutomationDeliveryTargetSpec } from './types';

const SENSITIVE_KEY = /(?:password|passphrase|secret|api[_-]?key|token|authorization|cookie)/i;
const ACTION_KINDS = new Set(['prompt', 'script', 'delivery']);
const TRIGGER_KINDS = new Set(['schedule', 'webhook', 'app_event', 'file', 'manual']);
const OVERLAP_POLICIES = new Set(['skip', 'queue', 'cancel_previous']);
const MISFIRE_POLICIES = new Set(['skip', 'run_once', 'catch_up']);

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function assertNoEmbeddedCredential(value: unknown, path = 'revision', depth = 0): void {
  if (depth > 10) throw new Error('Automation revision is too deeply nested');
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEmbeddedCredential(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`Automation credentials must use a SecretHandle or ConnectedAccount reference (${path}.${key})`);
    assertNoEmbeddedCredential(nested, `${path}.${key}`, depth + 1);
  }
}

function validateSpec(spec: AutomationRevisionSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('Automation revision is required');
  if (!spec.action || typeof spec.action !== 'object' || !ACTION_KINDS.has(spec.action.kind)) {
    throw new Error('Automation action kind is invalid');
  }
  if ((spec.action.kind === 'prompt' || spec.action.kind === 'delivery')
      && (!spec.action.prompt.trim() || spec.action.prompt.length > 100_000)) {
    throw new Error('Automation prompt is required and bounded to 100000 characters');
  }
  if (!spec.trigger || typeof spec.trigger !== 'object' || !TRIGGER_KINDS.has(spec.trigger.kind)) {
    throw new Error('Automation trigger kind is invalid');
  }
  if ('bindingId' in spec.trigger
      && (!spec.trigger.bindingId.trim() || spec.trigger.bindingId.length > 512
        || /[\u0000-\u001f\u007f]/.test(spec.trigger.bindingId))) {
    throw new Error('Automation trigger binding identity is invalid');
  }
  if (!spec.policies || typeof spec.policies !== 'object'
      || !OVERLAP_POLICIES.has(spec.policies.overlap)
      || !spec.policies.misfire || !MISFIRE_POLICIES.has(spec.policies.misfire.kind)
      || !spec.policies.retry) {
    throw new Error('Automation policies are invalid');
  }
  if (!Array.isArray(spec.capabilities) || !Array.isArray(spec.credentialRefs)) {
    throw new Error('Automation capabilities and credential references must be arrays');
  }
  assertNoEmbeddedCredential(spec);
  if (spec.trigger.kind === 'schedule') {
    if (!spec.trigger.expression.trim()) throw new Error('Schedule expression is required');
    if (!spec.trigger.timezone.trim()) throw new Error('IANA timezone is required');
  }
  if (spec.policies.retry.maxAttempts < 1 || spec.policies.retry.maxAttempts > 10) {
    throw new Error('Automation retry maxAttempts must be between 1 and 10');
  }
  if (!Number.isInteger(spec.policies.retry.maxAttempts)) {
    throw new Error('Automation retry maxAttempts must be an integer');
  }
  if (spec.capabilities.length > 100 || spec.credentialRefs.length > 100) {
    throw new Error('Automation capability and credential declarations are bounded to 100 entries');
  }
  for (const capability of spec.capabilities) {
    if (!capability.trim() || capability.length > 128 || /[\u0000-\u001f\u007f]/.test(capability)) {
      throw new Error('Automation capability declaration is invalid');
    }
  }
  for (const ref of spec.credentialRefs) {
    if (!ref.trim() || ref.length > 512 || /[\u0000-\u001f\u007f]/.test(ref)) {
      throw new Error('Automation credential reference is invalid');
    }
  }
  if (spec.workspace) {
    const root = spec.workspace.rootPath;
    if (!root || root.length > 4096 || /[\u0000-\u001f\u007f]/.test(root) || !path.isAbsolute(root)) {
      throw new Error('Automation workspace root must be an absolute local path');
    }
  }
  if ((spec.capabilities.some((capability) => capability.startsWith('repository.'))
      || (spec.action.kind === 'script' && spec.action.script.steps.some((step) => 'path' in step)))
      && !spec.workspace) {
    throw new Error('Repository automation requires an immutable workspace root');
  }
  if (spec.policies.misfire.kind === 'catch_up'
      && (!Number.isInteger(spec.policies.misfire.maxOccurrences)
        || spec.policies.misfire.maxOccurrences < 1 || spec.policies.misfire.maxOccurrences > 100)) {
    throw new Error('Automation catch-up must be bounded between 1 and 100 occurrences');
  }
  if ('maxAgeMs' in spec.policies.misfire && spec.policies.misfire.maxAgeMs !== undefined
      && (!Number.isFinite(spec.policies.misfire.maxAgeMs) || spec.policies.misfire.maxAgeMs < 0)) {
    throw new Error('Automation misfire maximum age must be a finite non-negative number');
  }
  if (spec.action.kind === 'script') {
    validateScriptSpec(spec.action.script);
    for (const step of spec.action.script.steps) {
      const allowed = step.kind === 'read_file' || step.kind === 'list_directory'
        ? spec.capabilities.includes('repository.read')
          || spec.capabilities.includes(`tool:${step.kind === 'read_file' ? 'file_read' : 'file_list'}`)
        : step.kind === 'write_file'
          ? spec.capabilities.includes('repository.write') || spec.capabilities.includes('tool:file_write')
          : spec.capabilities.includes('web.read') || spec.capabilities.includes('tool:fetch_url');
      if (!allowed) throw new Error(`Automation ScriptSpec step ${step.kind} exceeds its declared capabilities`);
    }
  }
  if (spec.budget) {
    const supported = new Set(['runtimeMs', 'modelCalls', 'inputTokens', 'outputTokens', 'toolCalls', 'externalCost', 'effects']);
    for (const [kind, limit] of Object.entries(spec.budget)) {
      if (!supported.has(kind)) throw new Error(`Automation budget ${kind} is unsupported`);
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        throw new Error(`Automation budget ${kind} must be a finite non-negative number`);
      }
    }
  }
  if (spec.approval && spec.approval.mode !== 'policy' && spec.approval.mode !== 'always') {
    throw new Error('Automation approval mode is invalid');
  }
  if (spec.delivery && !['on_success', 'on_failure', 'always'].includes(spec.delivery.mode)) {
    throw new Error('Automation delivery mode is invalid');
  }
  const validateDelivery = (delivery: AutomationDeliveryTargetSpec): void => {
    let inputBytes = 0;
    try { inputBytes = Buffer.byteLength(JSON.stringify(delivery.input), 'utf8'); }
    catch { throw new Error('Automation delivery input must be serializable'); }
    if (inputBytes > 64 * 1024) throw new Error('Automation delivery input exceeds 65536 bytes');
    const error = validateExactActionArguments({
      provider_id: delivery.providerId,
      toolkit_id: delivery.toolkitId,
      action_id: delivery.actionId,
      schema_version: delivery.schemaVersion,
      provider_action_version: delivery.providerActionVersion,
      account_id: delivery.destinationRef,
      input: delivery.input,
      request_id: 'automation-delivery-validation',
    });
    if (error) throw new Error(`Automation delivery is invalid: ${error}`);
    if (delivery.contentField !== undefined
        && (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(delivery.contentField))) {
      throw new Error('Automation delivery content field is invalid');
    }
  };
  if (spec.delivery) validateDelivery(spec.delivery);
  if (spec.action.kind === 'delivery') validateDelivery(spec.action.delivery);
  const deliveryRefs = [
    ...(spec.action.kind === 'delivery' ? [spec.action.delivery.destinationRef] : []),
    ...(spec.delivery ? [spec.delivery.destinationRef] : []),
  ];
  for (const destinationRef of deliveryRefs) {
    if (!spec.credentialRefs.includes(destinationRef)) {
      throw new Error('Automation delivery destination must be an approved credential or ConnectedAccount reference');
    }
  }
  if (deliveryRefs.length > 0
      && !spec.capabilities.includes('apps.use')
      && !spec.capabilities.includes('delivery.send')
      && !spec.capabilities.includes('tool:app_action')) {
    throw new Error('Automation delivery exceeds its declared capabilities');
  }
}

type DefinitionRow = {
  automation_id: string; name: string; enabled: number; current_revision_id: string;
  owner_id: string; workspace_id: string | null; commercial_context: string;
  created_by: string; created_at: number; updated_at: number;
};
type RevisionRow = {
  revision_id: string; automation_id: string; revision_number: number; spec_json: string;
  created_by: string; created_at: number;
};

function definition(row: DefinitionRow): AutomationDefinitionRecord {
  return {
    id: row.automation_id, name: row.name, enabled: row.enabled === 1,
    currentRevisionId: row.current_revision_id, ownerId: row.owner_id,
    workspaceId: row.workspace_id, commercialContext: row.commercial_context,
    createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function revision(row: RevisionRow): AutomationRevisionRecord {
  return {
    id: row.revision_id, automationId: row.automation_id, revisionNumber: row.revision_number,
    spec: JSON.parse(row.spec_json) as AutomationRevisionSpec,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

export interface AutomationAuthority {
  create(command: AutomationRevisionSpec & {
    name: string; createdBy: string; ownerId?: string; workspaceId?: string | null;
    commercialContext?: string; now?: number;
  }): {
    definition: AutomationDefinitionRecord; revision: AutomationRevisionRecord;
  };
  revise(automationId: string, spec: AutomationRevisionSpec, options: { createdBy: string; now?: number }): {
    definition: AutomationDefinitionRecord; revision: AutomationRevisionRecord;
  };
  get(automationId: string): AutomationDefinitionRecord | null;
  getRevision(revisionId: string): AutomationRevisionRecord | null;
  setEnabled(automationId: string, enabled: boolean, now?: number): AutomationDefinitionRecord;
}

export function createAutomationAuthority(options: { db: Database.Database }): AutomationAuthority {
  const { db } = options;
  const validateCredentialRefs = (refs: readonly string[], ownerId?: string, workspaceId?: string | null): void => {
    for (const ref of refs) {
      const row = db.prepare(
        `SELECT owner_id,workspace_id FROM integration_secret_handles WHERE secret_handle = ? AND status = 'active'
         UNION ALL
         SELECT owner_id,workspace_id FROM connected_accounts
          WHERE account_id = ? AND status = 'active' AND health = 'healthy'
         LIMIT 1`,
      ).get(ref, ref) as { owner_id: string | null; workspace_id: string | null } | undefined;
      if (!row) throw new Error(`Automation credential reference is missing or revoked: ${ref}`);
      if (ownerId && row.owner_id && row.owner_id !== ownerId) {
        throw new Error(`Automation credential reference belongs to another owner: ${ref}`);
      }
      if (workspaceId && row.workspace_id && row.workspace_id !== workspaceId) {
        throw new Error(`Automation credential reference belongs to another workspace: ${ref}`);
      }
    }
  };
  const insertBinding = (automationId: string, revisionId: string, spec: AutomationRevisionSpec, now: number): void => {
    if (spec.trigger.kind === 'manual') return;
    const nextFire = spec.trigger.kind === 'schedule' ? nextScheduleInstants({
      expression: spec.trigger.expression, timezone: spec.trigger.timezone, after: now, count: 1,
    })[0] : null;
    const sourceKey = 'bindingId' in spec.trigger ? spec.trigger.bindingId : automationId;
    db.prepare(
      `INSERT INTO automation_trigger_bindings (
         binding_id,automation_id,revision_id,trigger_kind,source_key,
         schedule_expression,timezone,next_fire_at,enabled,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
    ).run(
      id('automation_binding'), automationId, revisionId, spec.trigger.kind, sourceKey,
      spec.trigger.kind === 'schedule' ? spec.trigger.expression : null,
      spec.trigger.kind === 'schedule' ? spec.trigger.timezone : null,
      nextFire, now, now,
    );
  };
  const get = (automationId: string): AutomationDefinitionRecord | null => {
    const row = db.prepare('SELECT * FROM automation_definitions WHERE automation_id = ?').get(automationId) as DefinitionRow | undefined;
    return row ? definition(row) : null;
  };
  const getRevision = (revisionId: string): AutomationRevisionRecord | null => {
    const row = db.prepare('SELECT * FROM automation_revisions WHERE revision_id = ?').get(revisionId) as RevisionRow | undefined;
    return row ? revision(row) : null;
  };
  return {
    create(command) {
      if (!command.name.trim() || command.name.trim().length > 200) {
        throw new Error('Automation name is required and must not exceed 200 characters');
      }
      const spec: AutomationRevisionSpec = {
        action: command.action, trigger: command.trigger, policies: command.policies,
        capabilities: [...command.capabilities], credentialRefs: [...command.credentialRefs],
        ...(command.workspace ? { workspace: { rootPath: path.resolve(command.workspace.rootPath) } } : {}),
        ...(command.budget ? { budget: { ...command.budget } } : {}),
        ...(command.approval ? { approval: { ...command.approval } } : {}),
        ...(command.delivery ? { delivery: { ...command.delivery } } : {}),
      };
      validateSpec(spec);
      const ownerId = command.ownerId ?? command.createdBy;
      const workspaceId = command.workspaceId ?? null;
      validateCredentialRefs(spec.credentialRefs, ownerId, workspaceId);
      const now = command.now ?? Date.now();
      const automationId = id('automation');
      const revisionId = id('automation_revision');
      db.transaction(() => {
        db.prepare(
          `INSERT INTO automation_definitions
             (automation_id,name,enabled,current_revision_id,owner_id,workspace_id,commercial_context,created_by,created_at,updated_at)
           VALUES (?,?,1,?,?,?,?,?,?,?)`,
        ).run(
          automationId, command.name.trim(), revisionId, ownerId, workspaceId,
          command.commercialContext ?? 'pro', command.createdBy, now, now,
        );
        db.prepare(
          `INSERT INTO automation_revisions
             (revision_id,automation_id,revision_number,spec_json,created_by,created_at)
           VALUES (?,?,1,?,?,?)`,
        ).run(revisionId, automationId, JSON.stringify(spec), command.createdBy, now);
        insertBinding(automationId, revisionId, spec, now);
      }).immediate();
      return { definition: get(automationId)!, revision: getRevision(revisionId)! };
    },
    revise(automationId, spec, options2) {
      validateSpec(spec);
      const owner = get(automationId);
      if (!owner) throw new Error(`Automation not found: ${automationId}`);
      validateCredentialRefs(spec.credentialRefs, owner.ownerId, owner.workspaceId);
      const now = options2.now ?? Date.now();
      const revisionId = id('automation_revision');
      db.transaction(() => {
        const current = db.prepare(
          'SELECT COALESCE(MAX(revision_number),0) AS number FROM automation_revisions WHERE automation_id = ?',
        ).get(automationId) as { number: number };
        db.prepare(
          `INSERT INTO automation_revisions
             (revision_id,automation_id,revision_number,spec_json,created_by,created_at)
           VALUES (?,?,?,?,?,?)`,
        ).run(revisionId, automationId, current.number + 1, JSON.stringify(spec), options2.createdBy, now);
        db.prepare('UPDATE automation_trigger_bindings SET enabled = 0,updated_at = ? WHERE automation_id = ? AND enabled = 1')
          .run(now, automationId);
        insertBinding(automationId, revisionId, spec, now);
        db.prepare(
          'UPDATE automation_definitions SET current_revision_id = ?, updated_at = ? WHERE automation_id = ?',
        ).run(revisionId, now, automationId);
      }).immediate();
      return { definition: get(automationId)!, revision: getRevision(revisionId)! };
    },
    get,
    getRevision,
    setEnabled(automationId, enabled, now = Date.now()) {
      const result = db.prepare(
        'UPDATE automation_definitions SET enabled = ?, updated_at = ? WHERE automation_id = ?',
      ).run(enabled ? 1 : 0, now, automationId);
      if (result.changes !== 1) throw new Error(`Automation not found: ${automationId}`);
      return get(automationId)!;
    },
  };
}
