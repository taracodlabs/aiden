/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CapabilityInstaller } from '../../../core/v4/capabilities/installer';
import { CapabilityManagementAuthority } from '../../../core/v4/capabilities/management';
import { CapabilityRuntime } from '../../../core/v4/capabilities/runtime';
import { createCapabilityStore } from '../../../core/v4/capabilities/store';
import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';

let root = '';
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = ''; });

describe('Capability entitlement boundary', () => {
  it('gates execution dynamically while preserving inspect, disable and uninstall controls', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-entitlement-'));
    const db = new Database(':memory:');
    runMigrations(db);
    const store = createCapabilityStore(db);
    const installer = new CapabilityInstaller({ aidenRoot: root, store, aidenVersion: '4.20.0' });
    const processHost = {
      probe: () => ({ available: true, mechanism: 'docker' as const, image: 'node:test' }),
      run: async () => { throw new Error('execution must remain gated'); },
    };
    const management = new CapabilityManagementAuthority({
      store, installer, processHost,
      scopeId: 'workspace_1', ownerId: 'owner_1', workspaceId: 'workspace_1',
    });
    const installed = await management.install(path.resolve('capabilities/samples/workspace-summary'));
    management.activate({ capabilityId: installed.record.manifest.id, version: '1.0.0', acceptPermissions: true });
    let entitled = true;
    const runtime = new CapabilityRuntime({ store, processHost, canExecute: () => entitled });
    entitled = false;

    await expect(runtime.invoke({
      capabilityId: installed.record.manifest.id,
      version: installed.record.manifest.version,
      digest: installed.record.manifest.digest,
      tool: 'workspace_summary',
      input: { paths: [] },
      ownerId: 'owner_1',
      workspaceId: 'workspace_1',
      workspaceRoot: root,
      executeTool: async () => ({ result: null }),
    })).rejects.toThrow(/entitlement/i);
    expect(management.inspect(installed.record.manifest.id).active?.enabled).toBe(true);
    expect(management.disable(installed.record.manifest.id)?.enabled).toBe(false);
    await expect(management.uninstall({ capabilityId: installed.record.manifest.id, version: '1.0.0' })).resolves.toBe(true);
    expect(buildEditionAuthority('community').can('capability.sdk')).toBe(false);
    expect(buildEditionAuthority('pro').can('capability.sdk')).toBe(true);
    db.close();
  });
});
