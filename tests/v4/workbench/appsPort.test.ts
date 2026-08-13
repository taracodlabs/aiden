/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createIntegrationRuntime } from '../../../core/v4/integrations/runtime';
import { MachineBoundSecretBackend } from '../../../core/v4/integrations/secretAuthority';
import { createWorkbenchAppsPort } from '../../../core/v4/workbench/appsPort';

let db: Database.Database;
let root: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'aiden-workbench-apps-'));
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  await rm(root, { recursive: true, force: true });
});

describe('Workbench Apps authority port', () => {
  it('projects safe account metadata and supports connect, health, reconnect and revoke', async () => {
    const runtime = createIntegrationRuntime({
      db,
      rootDir: root,
      includeFake: true,
      scope: { ownerId: 'owner-a', workspaceId: 'workspace-a' },
      secretBackend: new MachineBoundSecretBackend(root),
    });
    const port = createWorkbenchAppsPort(runtime);

    const empty = await port.snapshot();
    expect(empty.toolkits).toContainEqual({ providerId: 'fake', toolkitId: 'projects', label: 'Projects' });
    expect(empty.accounts).toEqual([]);

    const connection = await port.connect({ providerId: 'fake', toolkitId: 'projects', label: 'Personal' });
    const connected = await port.complete(connection.connectionId);
    expect(connected).toMatchObject({ toolkitId: 'projects', label: 'Personal', health: 'healthy' });

    const snapshot = await port.snapshot();
    expect(snapshot.accounts).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/secretHandle|hostedAuthRef|providerAccountRef|apiKey|accessToken|refreshToken/i);
    expect((await port.refresh(connected.accountId)).health).toBe('healthy');

    const reconnect = await port.reconnect(connected.accountId);
    expect(reconnect.connectionId).toMatch(/^fake-connection-/);
    expect((await port.disconnect(connected.accountId)).health).toBe('revoked');
    await expect(port.refresh(connected.accountId)).rejects.toThrow(/not actionable|revoked/i);

    const restored = await port.complete(reconnect.connectionId);
    expect(restored).toMatchObject({
      accountId: connected.accountId,
      toolkitId: 'projects',
      label: 'Personal',
      status: 'active',
      health: 'healthy',
    });
    const afterReconnect = await port.snapshot();
    expect(afterReconnect.accounts.filter((account) => account.accountId === connected.accountId)).toHaveLength(1);
    expect(afterReconnect.accounts).toHaveLength(1);
  });

  it('cannot operate on a foreign workspace account', async () => {
    const runtime = createIntegrationRuntime({
      db,
      rootDir: root,
      includeFake: true,
      scope: { ownerId: 'owner-a', workspaceId: 'workspace-a' },
      secretBackend: new MachineBoundSecretBackend(root),
    });
    const port = createWorkbenchAppsPort(runtime);
    const foreign = runtime.accounts.create({
      providerId: 'fake', toolkitId: 'projects', ownerId: 'owner-b', workspaceId: 'workspace-b',
      label: 'Foreign', providerAccountRef: 'foreign-ref', scopes: [],
    });
    await expect(port.reconnect(foreign.accountId)).rejects.toThrow(/outside the current workspace/i);
    await expect(port.disconnect(foreign.accountId)).rejects.toThrow(/not available/i);
  });
});
