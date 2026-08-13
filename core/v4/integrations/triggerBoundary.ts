/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import type { ConnectedAccountAuthority } from './connectedAccountAuthority';
import type { IntegrationTriggerEvent } from './types';

interface CursorRow { cursor_digest: string }

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid integration ${label}`);
  }
  return normalized;
}

/** Normalizes provider events and cursors only. Job admission belongs to a future authority. */
export class IntegrationTriggerBoundary {
  constructor(private readonly options: { db: Db; accounts: ConnectedAccountAuthority }) {}

  observe(input: {
    providerId: string;
    toolkitId: string;
    accountId: string;
    ownerId: string;
    workspaceId: string;
    triggerId: string;
    cursor: string;
    payload: unknown;
    observedAt?: number;
  }): { accepted: boolean; duplicate: boolean; event?: IntegrationTriggerEvent } {
    try {
      this.options.accounts.resolve({
        providerId: input.providerId,
        toolkitId: input.toolkitId,
        accountId: input.accountId,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
      });
    } catch {
      throw new Error('Integration trigger account identity is not actionable');
    }
    let payload: unknown;
    try {
      const serialized = JSON.stringify(input.payload);
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
        throw new Error('payload exceeds limit');
      }
      payload = JSON.parse(serialized) as unknown;
    } catch {
      throw new Error('Invalid integration trigger payload');
    }
    const triggerId = bounded(input.triggerId, 'trigger identity', 256);
    const cursor = bounded(input.cursor, 'cursor', 2_048);
    const cursorDigest = createHash('sha256').update(cursor).digest('hex');
    const prior = this.options.db.prepare(
      `SELECT cursor_digest FROM integration_trigger_cursors
       WHERE provider_id=? AND toolkit_id=? AND account_id=? AND trigger_id=?`,
    ).get(input.providerId, input.toolkitId, input.accountId, triggerId) as CursorRow | undefined;
    if (prior?.cursor_digest === cursorDigest) return { accepted: false, duplicate: true };
    const observedAt = input.observedAt ?? Date.now();
    this.options.db.prepare(
      `INSERT INTO integration_trigger_cursors
         (provider_id,toolkit_id,account_id,trigger_id,cursor,cursor_digest,observed_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(provider_id,toolkit_id,account_id,trigger_id) DO UPDATE SET
         cursor=excluded.cursor,cursor_digest=excluded.cursor_digest,
         observed_at=excluded.observed_at,updated_at=excluded.updated_at`,
    ).run(
      input.providerId, input.toolkitId, input.accountId, triggerId,
      cursor, cursorDigest, observedAt, observedAt,
    );
    return {
      accepted: true,
      duplicate: false,
      event: {
        providerId: input.providerId,
        toolkitId: input.toolkitId,
        accountId: input.accountId,
        triggerId,
        cursor,
        observedAt,
        payload,
        untrustedContent: true,
      },
    };
  }
}
