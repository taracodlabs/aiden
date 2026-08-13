/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  ConnectedAccountAuthority,
  ConnectedAccountSelectionError,
} from '../../../core/v4/integrations/connectedAccountAuthority';
import { FakeIntegrationProvider } from '../../../core/v4/integrations/fakeProvider';
import { IntegrationProviderRegistry } from '../../../core/v4/integrations/providerRegistry';
import {
  SecretAuthority,
  type SecretBackend,
} from '../../../core/v4/integrations/secretAuthority';

class TestSecretBackend implements SecretBackend {
  readonly id = 'test-protected';
  async protect(value: string): Promise<string> {
    return Buffer.from(`protected:${value}`, 'utf8').toString('base64');
  }
  async unprotect(value: string): Promise<string> {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!decoded.startsWith('protected:')) throw new Error('invalid protected value');
    return decoded.slice('protected:'.length);
  }
  health() {
    return { available: true, protectedByOs: true, detail: 'test boundary' };
  }
}

let db: Database.Database;
let root: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'aiden-integrations-'));
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  await rm(root, { recursive: true, force: true });
});

describe('integration secret authority', () => {
  it('stores only an opaque handle and protected bytes outside SQLite', async () => {
    const secrets = new SecretAuthority({ db, rootDir: root, backend: new TestSecretBackend() });
    const handle = await secrets.create({
      namespace: { workspaceId: 'workspace-a', ownerId: 'owner-a', providerId: 'fake', accountId: 'account-a' },
      label: 'access token',
      value: 'never-store-this-token',
    });

    expect(handle).toMatch(/^secret_/);
    expect(await secrets.resolve(handle, { workspaceId: 'workspace-a', ownerId: 'owner-a' }))
      .toBe('never-store-this-token');
    const dbDump = JSON.stringify(db.prepare('SELECT * FROM integration_secret_handles').all());
    expect(dbDump).not.toContain('never-store-this-token');
    const row = db.prepare('SELECT storage_ref FROM integration_secret_handles WHERE secret_handle=?')
      .get(handle) as { storage_ref: string };
    expect(await readFile(path.join(root, row.storage_ref), 'utf8')).not.toContain('never-store-this-token');

    await secrets.replace(handle, 'replacement-token', { workspaceId: 'workspace-a', ownerId: 'owner-a' });
    expect(await secrets.resolve(handle, { workspaceId: 'workspace-a', ownerId: 'owner-a' }))
      .toBe('replacement-token');
    await secrets.revoke(handle, { workspaceId: 'workspace-a', ownerId: 'owner-a' });
    await expect(secrets.resolve(handle, { workspaceId: 'workspace-a', ownerId: 'owner-a' }))
      .rejects.toThrow(/revoked/i);
    await secrets.delete(handle, { workspaceId: 'workspace-a', ownerId: 'owner-a' });
    expect(secrets.exists(handle)).toBe(false);
  });

  it('fences handles to their workspace and owner', async () => {
    const secrets = new SecretAuthority({ db, rootDir: root, backend: new TestSecretBackend() });
    const handle = await secrets.create({
      namespace: { workspaceId: 'workspace-a', ownerId: 'owner-a', providerId: 'fake' },
      label: 'credential', value: 'private',
    });
    await expect(secrets.resolve(handle, { workspaceId: 'workspace-b', ownerId: 'owner-a' }))
      .rejects.toThrow(/scope/i);
    await expect(secrets.resolve(handle, { workspaceId: 'workspace-a', ownerId: 'owner-b' }))
      .rejects.toThrow(/scope/i);
  });
});

describe('connected account authority', () => {
  it('persists multiple accounts and requires exact selection when ambiguous', () => {
    const accounts = new ConnectedAccountAuthority({ db });
    const first = accounts.create({
      providerId: 'fake', toolkitId: 'github', ownerId: 'owner-a', workspaceId: 'workspace-a',
      label: 'Personal', providerAccountRef: 'provider-account-1', scopes: ['repo:read'],
    });
    const second = accounts.create({
      providerId: 'fake', toolkitId: 'github', ownerId: 'owner-a', workspaceId: 'workspace-a',
      label: 'Work', providerAccountRef: 'provider-account-2', scopes: ['repo:read'],
    });
    expect(first.accountId).not.toBe(second.accountId);
    expect(accounts.list({ providerId: 'fake', toolkitId: 'github', ownerId: 'owner-a', workspaceId: 'workspace-a' }))
      .toHaveLength(2);
    expect(() => accounts.resolve({
      providerId: 'fake', toolkitId: 'github', ownerId: 'owner-a', workspaceId: 'workspace-a',
    })).toThrow(ConnectedAccountSelectionError);
    expect(accounts.resolve({
      providerId: 'fake', toolkitId: 'github', ownerId: 'owner-a', workspaceId: 'workspace-a',
      accountId: second.accountId,
    }).providerAccountRef).toBe('provider-account-2');
  });

  it('makes revoked and cross-workspace accounts unavailable', () => {
    const accounts = new ConnectedAccountAuthority({ db });
    const account = accounts.create({
      providerId: 'fake', toolkitId: 'gmail', ownerId: 'owner-a', workspaceId: 'workspace-a',
      label: 'Mail', providerAccountRef: 'provider-mail-1', scopes: ['mail:read'],
    });
    expect(() => accounts.resolve({
      providerId: 'fake', toolkitId: 'gmail', ownerId: 'owner-a', workspaceId: 'workspace-b',
      accountId: account.accountId,
    })).toThrow(/not available/i);
    accounts.revoke(account.accountId, { ownerId: 'owner-a', workspaceId: 'workspace-a' });
    expect(() => accounts.resolve({
      providerId: 'fake', toolkitId: 'gmail', ownerId: 'owner-a', workspaceId: 'workspace-a',
      accountId: account.accountId,
    })).toThrow(/revoked/i);
  });

  it('removes terminal control sequences from durable account labels', () => {
    const accounts = new ConnectedAccountAuthority({ db });
    const created = accounts.create({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-a', workspaceId: 'workspace-a',
      label: '\u001b[31mWork\u001b[0m\r\nInjected', providerAccountRef: 'provider-safe-label',
    });

    expect(created.label).toBe('Work Injected');
    expect(created.label).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(created.label).not.toContain('\u001b');
  });
});

describe('provider-neutral registry and deterministic provider', () => {
  it('registers by stable provider identity and rejects duplicates', () => {
    const registry = new IntegrationProviderRegistry();
    const provider = new FakeIntegrationProvider();
    registry.register(provider);
    expect(registry.require('fake').id).toBe('fake');
    expect(() => registry.register(new FakeIntegrationProvider())).toThrow(/already registered/i);
  });

  it('exposes bounded versioned actions and deterministic failure modes', async () => {
    const provider = new FakeIntegrationProvider();
    const actions = await provider.discoverActions({ toolkitId: 'projects', limit: 20 });
    expect(actions.actions.map((action) => action.actionId)).toEqual([
      'get_project', 'list_projects', 'create_note', 'update_note',
    ]);
    expect(actions.actions.every((action) => action.schemaVersion && action.providerActionVersion)).toBe(true);

    const connection = await provider.initiateConnection({ toolkitId: 'projects', ownerId: 'owner-a' });
    const completed = await provider.completeConnection({ connectionId: connection.connectionId });
    expect(completed.providerAccountRef).toMatch(/^fake-account-/);

    const read = await provider.execute({
      toolkitId: 'projects', actionId: 'list_projects', schemaVersion: '1',
      providerActionVersion: '2026-01-01', providerAccountRef: completed.providerAccountRef,
      input: {}, idempotencyKey: 'read-1',
    });
    expect(read.outcome).toBe('succeeded');

    provider.failNext('rate_limited');
    await expect(provider.execute({
      toolkitId: 'projects', actionId: 'list_projects', schemaVersion: '1',
      providerActionVersion: '2026-01-01', providerAccountRef: completed.providerAccountRef,
      input: {}, idempotencyKey: 'read-2',
    })).rejects.toMatchObject({ category: 'rate_limited' });
  });
});
