/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createIntegrationRuntime, integrationLocalScope } from '../../../core/v4/integrations/runtime';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { BUILT_IN_PROFILES } from '../../../core/v4/toolProfiles';

let db: Database.Database;
let root: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'aiden-integration-runtime-'));
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  await rm(root, { recursive: true, force: true });
});

describe('integration production runtime', () => {
  it('registers optional Composio and app tools without loading the SDK or requiring configuration', async () => {
    const tools = new ToolRegistry();
    const clientFactory = vi.fn();
    const runtime = createIntegrationRuntime({ db, rootDir: root, toolRegistry: tools, clientFactory });
    expect(runtime.providers.list().map((provider) => provider.id)).toEqual(['composio']);
    expect(tools.getSchemas(undefined, 'repl').map((schema) => schema.name))
      .toEqual(expect.arrayContaining(['app_resolve', 'app_read', 'app_action']));
    expect(await runtime.actions.providerHealth({
      providerId: 'composio', ...runtime.scope,
    })).toMatchObject({ state: 'not_configured' });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('enables the deterministic provider only through an explicit runtime option', () => {
    const tools = new ToolRegistry();
    const runtime = createIntegrationRuntime({ db, rootDir: root, toolRegistry: tools, includeFake: true });
    expect(runtime.providers.list().map((provider) => provider.id)).toEqual(['composio', 'fake']);
  });

  it('uses one stable local workspace scope and includes apps in the standard profile', () => {
    expect(integrationLocalScope('C:\\Example\\Repo')).toEqual(integrationLocalScope('C:\\Example\\Repo'));
    expect(integrationLocalScope('C:\\Example\\Repo').workspaceId).toMatch(/^workspace_[a-f0-9]{32}$/);
    expect(BUILT_IN_PROFILES.standard.toolsets).toContain('apps');
    expect(BUILT_IN_PROFILES.minimal.toolsets).not.toContain('apps');
  });
});
