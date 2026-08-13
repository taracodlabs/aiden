/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import { IntegrationProviderError, type IntegrationActionDescriptor } from './types';

interface SchemaRow {
  provider_id: string;
  toolkit_id: string;
  action_id: string;
  schema_version: string;
  provider_action_version: string;
  operation: 'read' | 'mutation';
  risk: 'safe' | 'caution' | 'dangerous';
  schema_digest: string;
  input_schema_json: string;
  output_schema_json: string | null;
  discovered_at: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function schemaDigest(action: IntegrationActionDescriptor): string {
  return createHash('sha256').update(JSON.stringify(canonical({
    operation: action.operation,
    risk: action.risk,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema ?? null,
  }))).digest('hex');
}

function decode(row: SchemaRow): IntegrationActionDescriptor {
  return {
    providerId: row.provider_id,
    toolkitId: row.toolkit_id,
    actionId: row.action_id,
    label: row.action_id,
    description: row.action_id,
    schemaVersion: row.schema_version,
    providerActionVersion: row.provider_action_version,
    operation: row.operation,
    risk: row.risk,
    inputSchema: JSON.parse(row.input_schema_json) as Record<string, unknown>,
    ...(row.output_schema_json ? { outputSchema: JSON.parse(row.output_schema_json) as Record<string, unknown> } : {}),
    supportsIdempotency: row.operation === 'mutation',
    supportsReadback: row.operation === 'mutation',
    supportsReconciliation: row.operation === 'mutation',
  };
}

export class IntegrationActionSchemaAuthority {
  constructor(private readonly options: { db: Db }) {}

  pin(action: IntegrationActionDescriptor, now = Date.now()): IntegrationActionDescriptor {
    const digest = schemaDigest(action);
    const existing = this.options.db.prepare(
      `SELECT * FROM integration_action_schemas
       WHERE provider_id=? AND toolkit_id=? AND action_id=?
         AND schema_version=? AND provider_action_version=?`,
    ).get(
      action.providerId, action.toolkitId, action.actionId,
      action.schemaVersion, action.providerActionVersion,
    ) as SchemaRow | undefined;
    if (existing && existing.schema_digest !== digest) {
      throw new IntegrationProviderError(
        'schema_drift',
        'Provider action schema drift occurred without a new version; execution is blocked',
      );
    }
    if (!existing) {
      this.options.db.prepare(
        `INSERT INTO integration_action_schemas
           (provider_id,toolkit_id,action_id,schema_version,provider_action_version,
            operation,risk,schema_digest,input_schema_json,output_schema_json,discovered_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        action.providerId, action.toolkitId, action.actionId, action.schemaVersion,
        action.providerActionVersion, action.operation, action.risk, digest,
        JSON.stringify(canonical(action.inputSchema)),
        action.outputSchema ? JSON.stringify(canonical(action.outputSchema)) : null,
        now,
      );
    }
    return { ...action };
  }

  requireExact(identity: Pick<IntegrationActionDescriptor,
    'providerId' | 'toolkitId' | 'actionId' | 'schemaVersion' | 'providerActionVersion'>): IntegrationActionDescriptor {
    const row = this.options.db.prepare(
      `SELECT * FROM integration_action_schemas
       WHERE provider_id=? AND toolkit_id=? AND action_id=?
         AND schema_version=? AND provider_action_version=?`,
    ).get(
      identity.providerId, identity.toolkitId, identity.actionId,
      identity.schemaVersion, identity.providerActionVersion,
    ) as SchemaRow | undefined;
    if (!row) {
      throw new IntegrationProviderError(
        'schema_drift',
        'The exact provider action version is not pinned; rediscover it before execution',
      );
    }
    return decode(row);
  }

  list(input: { providerId: string; toolkitId?: string }): IntegrationActionDescriptor[] {
    const rows = input.toolkitId
      ? this.options.db.prepare(
        'SELECT * FROM integration_action_schemas WHERE provider_id=? AND toolkit_id=? ORDER BY action_id,discovered_at DESC',
      ).all(input.providerId, input.toolkitId)
      : this.options.db.prepare(
        'SELECT * FROM integration_action_schemas WHERE provider_id=? ORDER BY toolkit_id,action_id,discovered_at DESC',
      ).all(input.providerId);
    return (rows as SchemaRow[]).map(decode);
  }
}
