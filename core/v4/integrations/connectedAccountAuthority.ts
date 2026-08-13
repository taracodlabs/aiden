/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import type {
  ConnectedAccountHealth,
  ConnectedAccountRecord,
  ConnectedAccountStatus,
} from './types';

interface AccountRow {
  account_id: string;
  provider_id: string;
  toolkit_id: string;
  owner_id: string;
  workspace_id: string;
  label: string;
  provider_account_ref: string;
  provider_user_ref: string | null;
  secret_handle: string | null;
  hosted_auth_ref: string | null;
  status: ConnectedAccountStatus;
  health: ConnectedAccountHealth;
  scopes_json: string;
  created_at: number;
  updated_at: number;
  last_checked_at: number | null;
  revoked_at: number | null;
}

export class ConnectedAccountSelectionError extends Error {
  readonly candidates: Array<{ accountId: string; label: string }>;

  constructor(message: string, candidates: Array<{ accountId: string; label: string }> = []) {
    super(message);
    this.name = 'ConnectedAccountSelectionError';
    this.candidates = candidates;
  }
}

function accountId(): string {
  return `account_${randomBytes(18).toString('base64url')}`;
}

const TERMINAL_ESCAPE_RE = /\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g; // eslint-disable-line no-control-regex
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/g; // eslint-disable-line no-control-regex
const SAFE_IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function safeIdentity(value: string, label: string, maximum = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || !SAFE_IDENTITY_RE.test(value)) {
    throw new ConnectedAccountSelectionError(`Connected account ${label} is invalid`);
  }
  return value;
}

function safeReference(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048
      || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new ConnectedAccountSelectionError(`Connected account ${label} is invalid`);
  }
  return value;
}

function safeLabel(value: string, fallback: string): string {
  const normalized = value
    .replace(TERMINAL_ESCAPE_RE, '')
    .replace(CONTROL_CHARACTER_RE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...(normalized || fallback)].slice(0, 120).join('');
}

function safeScopes(values: string[]): string[] {
  return [...new Set(values.slice(0, 100)
    .map((value) => safeLabel(value, '').slice(0, 256))
    .filter(Boolean))].sort();
}

function decode(row: AccountRow): ConnectedAccountRecord {
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes_json);
    if (Array.isArray(parsed)) scopes = parsed.filter((scope): scope is string => typeof scope === 'string');
  } catch { /* invalid legacy metadata degrades to no scopes */ }
  return {
    accountId: row.account_id,
    providerId: row.provider_id,
    toolkitId: row.toolkit_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    label: safeLabel(row.label, row.toolkit_id),
    providerAccountRef: row.provider_account_ref,
    providerUserRef: row.provider_user_ref,
    secretHandle: row.secret_handle,
    hostedAuthRef: row.hosted_auth_ref,
    status: row.status,
    health: row.health,
    scopes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at,
    revokedAt: row.revoked_at,
  };
}

export class ConnectedAccountAuthority {
  constructor(private readonly options: { db: Db }) {}

  create(input: {
    providerId: string;
    toolkitId: string;
    ownerId: string;
    workspaceId: string;
    label: string;
    providerAccountRef: string;
    providerUserRef?: string | null;
    secretHandle?: string | null;
    hostedAuthRef?: string | null;
    scopes?: string[];
    status?: ConnectedAccountStatus;
    health?: ConnectedAccountHealth;
    now?: number;
  }): ConnectedAccountRecord {
    const id = accountId();
    const now = input.now ?? Date.now();
    const providerId = safeIdentity(input.providerId, 'provider identity', 64);
    const toolkitId = safeIdentity(input.toolkitId, 'toolkit identity');
    const ownerId = safeIdentity(input.ownerId, 'owner identity');
    const workspaceId = safeIdentity(input.workspaceId, 'workspace identity');
    const providerAccountRef = safeReference(input.providerAccountRef, 'provider reference');
    const providerUserRef = input.providerUserRef
      ? safeReference(input.providerUserRef, 'provider user reference') : null;
    const hostedAuthRef = input.hostedAuthRef
      ? safeReference(input.hostedAuthRef, 'hosted authorization reference') : null;
    this.options.db.prepare(
      `INSERT INTO connected_accounts
         (account_id,provider_id,toolkit_id,owner_id,workspace_id,label,provider_account_ref,provider_user_ref,
          secret_handle,hosted_auth_ref,status,health,scopes_json,created_at,updated_at,last_checked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, providerId, toolkitId, ownerId, workspaceId,
      safeLabel(input.label, toolkitId), providerAccountRef, providerUserRef,
      input.secretHandle ?? null, hostedAuthRef,
      input.status ?? 'active', input.health ?? 'healthy',
      JSON.stringify(safeScopes(input.scopes ?? [])), now, now, now,
    );
    return this.require(id);
  }

  get(id: string): ConnectedAccountRecord | null {
    const row = this.options.db.prepare('SELECT * FROM connected_accounts WHERE account_id=?')
      .get(id) as AccountRow | undefined;
    return row ? decode(row) : null;
  }

  require(id: string): ConnectedAccountRecord {
    const account = this.get(id);
    if (!account) throw new ConnectedAccountSelectionError('Connected account is not available');
    return account;
  }

  list(filter: {
    providerId?: string;
    toolkitId?: string;
    ownerId: string;
    workspaceId: string;
    includeRevoked?: boolean;
  }): ConnectedAccountRecord[] {
    const conditions = ['owner_id=?', 'workspace_id=?'];
    const params: unknown[] = [filter.ownerId, filter.workspaceId];
    if (filter.providerId) { conditions.push('provider_id=?'); params.push(filter.providerId); }
    if (filter.toolkitId) { conditions.push('toolkit_id=?'); params.push(filter.toolkitId); }
    if (!filter.includeRevoked) conditions.push("status<>'revoked'");
    return (this.options.db.prepare(
      `SELECT * FROM connected_accounts WHERE ${conditions.join(' AND ')}
       ORDER BY created_at, label COLLATE NOCASE, account_id`,
    ).all(...params) as AccountRow[]).map(decode);
  }

  resolve(input: {
    providerId: string;
    toolkitId: string;
    ownerId: string;
    workspaceId: string;
    accountId?: string;
  }): ConnectedAccountRecord {
    if (input.accountId) {
      const account = this.get(input.accountId);
      if (
        !account || account.providerId !== input.providerId || account.toolkitId !== input.toolkitId
        || account.ownerId !== input.ownerId || account.workspaceId !== input.workspaceId
      ) {
        throw new ConnectedAccountSelectionError('Connected account is not available in this scope');
      }
      this.assertActionable(account);
      return account;
    }
    const accounts = this.list(input).filter((account) => account.status === 'active' && account.health === 'healthy');
    if (accounts.length === 0) throw new ConnectedAccountSelectionError('No connected account is available');
    if (accounts.length !== 1) {
      throw new ConnectedAccountSelectionError(
        'More than one connected account is available; select an exact account',
        accounts.map(({ accountId, label }) => ({ accountId, label })),
      );
    }
    return accounts[0];
  }

  requireInScope(id: string, scope: { ownerId: string; workspaceId: string }): ConnectedAccountRecord {
    return this.requireScope(id, scope);
  }

  assertStillActionable(expected: ConnectedAccountRecord): ConnectedAccountRecord {
    const current = this.requireScope(expected.accountId, expected);
    if (
      current.providerId !== expected.providerId
      || current.toolkitId !== expected.toolkitId
      || current.providerAccountRef !== expected.providerAccountRef
      || current.updatedAt !== expected.updatedAt
    ) {
      throw new ConnectedAccountSelectionError('Connected account authority changed before dispatch');
    }
    this.assertActionable(current);
    return current;
  }

  reactivate(input: {
    accountId: string;
    ownerId: string;
    workspaceId: string;
    providerId: string;
    toolkitId: string;
    label: string;
    providerAccountRef: string;
    providerUserRef?: string | null;
    secretHandle?: string | null;
    hostedAuthRef?: string | null;
    scopes?: string[];
    now?: number;
  }): ConnectedAccountRecord {
    const current = this.requireScope(input.accountId, input);
    if (current.providerId !== input.providerId || current.toolkitId !== input.toolkitId) {
      throw new ConnectedAccountSelectionError('Reconnect does not match the connected app authority');
    }
    const now = input.now ?? Date.now();
    const providerAccountRef = safeReference(input.providerAccountRef, 'provider reference');
    const providerUserRef = input.providerUserRef
      ? safeReference(input.providerUserRef, 'provider user reference') : null;
    const hostedAuthRef = input.hostedAuthRef
      ? safeReference(input.hostedAuthRef, 'hosted authorization reference') : null;
    this.options.db.prepare(
      `UPDATE connected_accounts
       SET label=?,provider_account_ref=?,provider_user_ref=?,
           secret_handle=COALESCE(?,secret_handle),hosted_auth_ref=COALESCE(?,hosted_auth_ref),
           status='active',health='healthy',scopes_json=?,updated_at=?,last_checked_at=?,revoked_at=NULL
       WHERE account_id=?`,
    ).run(
      safeLabel(input.label, input.toolkitId), providerAccountRef, providerUserRef,
      input.secretHandle ?? null, hostedAuthRef,
      JSON.stringify(safeScopes(input.scopes ?? [])), now, now, input.accountId,
    );
    return this.require(input.accountId);
  }

  bindJob(input: {
    jobId: string;
    attemptId?: string;
    generation?: number;
    account: ConnectedAccountRecord;
    now?: number;
  }): void {
    const { account } = input;
    const now = input.now ?? Date.now();
    this.options.db.transaction(() => {
      this.options.db.prepare(
        `INSERT OR IGNORE INTO integration_job_account_bindings
           (job_id,provider_id,toolkit_id,account_id,owner_id,workspace_id,
            bound_attempt_id,bound_generation,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.jobId, account.providerId, account.toolkitId, account.accountId,
        account.ownerId, account.workspaceId, input.attemptId ?? null,
        input.generation ?? null, now,
      );
      const bound = this.options.db.prepare(
        `SELECT provider_id,account_id,owner_id,workspace_id FROM integration_job_account_bindings
         WHERE job_id=? AND toolkit_id=?`,
      ).get(input.jobId, account.toolkitId) as {
        provider_id: string; account_id: string; owner_id: string; workspace_id: string;
      } | undefined;
      if (
        !bound || bound.provider_id !== account.providerId || bound.account_id !== account.accountId
        || bound.owner_id !== account.ownerId || bound.workspace_id !== account.workspaceId
      ) {
        throw new ConnectedAccountSelectionError(
          'This Job is already bound to a different connected account for this app',
        );
      }
    }).immediate();
  }

  updateHealth(input: {
    accountId: string;
    ownerId: string;
    workspaceId: string;
    status: ConnectedAccountStatus;
    health: ConnectedAccountHealth;
    scopes?: string[];
    now?: number;
  }): ConnectedAccountRecord {
    this.requireScope(input.accountId, input);
    const now = input.now ?? Date.now();
    this.options.db.prepare(
      `UPDATE connected_accounts
       SET status=?,health=?,scopes_json=COALESCE(?,scopes_json),last_checked_at=?,updated_at=?
       WHERE account_id=?`,
    ).run(input.status, input.health, input.scopes ? JSON.stringify(safeScopes(input.scopes)) : null, now, now, input.accountId);
    return this.require(input.accountId);
  }

  revoke(id: string, scope: { ownerId: string; workspaceId: string }, now = Date.now()): ConnectedAccountRecord {
    this.requireScope(id, scope);
    this.options.db.prepare(
      `UPDATE connected_accounts
       SET status='revoked',health='revoked',secret_handle=NULL,hosted_auth_ref=NULL,
           revoked_at=?,updated_at=? WHERE account_id=?`,
    ).run(now, now, id);
    return this.require(id);
  }

  private requireScope(id: string, scope: { ownerId: string; workspaceId: string }): ConnectedAccountRecord {
    const account = this.require(id);
    if (account.ownerId !== scope.ownerId || account.workspaceId !== scope.workspaceId) {
      throw new ConnectedAccountSelectionError('Connected account is outside the requested scope');
    }
    return account;
  }

  private assertActionable(account: ConnectedAccountRecord): void {
    if (account.status === 'revoked') throw new ConnectedAccountSelectionError('Connected account is revoked');
    if (account.status === 'expired') throw new ConnectedAccountSelectionError('Connected account authentication is expired; reconnect required');
    if (account.status === 'connecting') throw new ConnectedAccountSelectionError('Connected account is still connecting');
    if (account.health === 'insufficient_scope') {
      throw new ConnectedAccountSelectionError('Connected account has insufficient access; reconnect required');
    }
    if (account.status !== 'active' || account.health !== 'healthy') {
      throw new ConnectedAccountSelectionError('Connected account is not actionable; check health or reconnect');
    }
  }
}
