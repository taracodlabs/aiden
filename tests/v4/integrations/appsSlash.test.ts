/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apps } from '../../../cli/v4/commands/apps';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createIntegrationRuntime } from '../../../core/v4/integrations/runtime';
import { MachineBoundSecretBackend } from '../../../core/v4/integrations/secretAuthority';

let db: Database.Database;
let root: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'aiden-apps-slash-'));
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  await rm(root, { recursive: true, force: true });
});

describe('/apps', () => {
  it('projects a truthful Apps landing from the shared runtime authority', async () => {
    const runtime = createIntegrationRuntime({
      db, rootDir: root, includeFake: true,
      secretBackend: new MachineBoundSecretBackend(root),
    });
    const output: string[] = [];
    const display = {
      info: vi.fn((value: string) => output.push(value)),
      write: vi.fn((value: string) => output.push(value)),
      dim: vi.fn((value: string) => output.push(value)),
      warn: vi.fn((value: string) => output.push(value)),
      printError: vi.fn((value: string) => output.push(value)),
    };
    await apps.handler({
      args: ['list'], rawArgs: 'list', display, integrationRuntime: runtime,
      registry: {} as never,
    } as never);
    expect(output.join('\n')).toContain('Aiden Apps');
    expect(output.join('\n')).toContain('Projects');
    expect(output.join('\n')).toContain('Not configured');
  });

  it('does not revoke an account when confirmation is denied', async () => {
    const runtime = createIntegrationRuntime({
      db, rootDir: root, includeFake: true,
      secretBackend: new MachineBoundSecretBackend(root),
    });
    const start = await runtime.actions.initiateConnection({
      providerId: 'fake', toolkitId: 'projects', ...runtime.scope, label: 'Personal',
    });
    const account = await runtime.actions.completeConnection({ connectionId: start.connectionId, ...runtime.scope });
    const display = {
      info: vi.fn(), write: vi.fn(), dim: vi.fn(), warn: vi.fn(), printError: vi.fn(),
    };
    await apps.handler({
      args: ['disconnect', account.accountId], rawArgs: `disconnect ${account.accountId}`,
      display, integrationRuntime: runtime, registry: {} as never,
      confirm: vi.fn(async () => false),
    } as never);
    expect(runtime.accounts.require(account.accountId).status).toBe('active');
    expect(display.dim).toHaveBeenCalledWith('Disconnect cancelled.');
  });
});
