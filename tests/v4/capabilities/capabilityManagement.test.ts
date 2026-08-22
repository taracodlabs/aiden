/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityInstaller } from '../../../core/v4/capabilities/installer';
import { CapabilityManagementAuthority } from '../../../core/v4/capabilities/management';
import { createCapabilityStore } from '../../../core/v4/capabilities/store';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';

let root = '';
let db: Database.Database;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-management-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

function subject() {
  const store = createCapabilityStore(db);
  const installer = new CapabilityInstaller({ aidenRoot: root, store, aidenVersion: '4.20.0', nodeVersion: '22.23.1' });
  return {
    store,
    authority: new CapabilityManagementAuthority({
      store,
      installer,
      processHost: {
        probe: () => ({ available: true, mechanism: 'docker' as const, image: 'node:test' }),
        run: async () => { throw new Error('not invoked by management health'); },
      },
      scopeId: 'workspace_1', ownerId: 'owner_1', workspaceId: 'workspace_1',
    }),
  };
}

describe('Capability management authority', () => {
  it('installs, reviews exact permissions, activates and projects one immutable version', async () => {
    const current = subject();
    const installed = await current.authority.install(path.resolve('capabilities/samples/workspace-summary'));
    expect(installed.idempotent).toBe(false);
    expect(() => current.authority.activate({
      capabilityId: installed.record.manifest.id,
      version: installed.record.manifest.version,
      acceptPermissions: false,
    })).toThrow(/permission review/i);
    current.authority.activate({
      capabilityId: installed.record.manifest.id,
      version: installed.record.manifest.version,
      acceptPermissions: true,
    });
    expect(current.authority.inspect(installed.record.manifest.id)).toMatchObject({
      active: { version: '1.0.0', enabled: true },
      requestedPermissions: [{ kind: 'filesystem.read' }],
      grantedPermissions: [{ permission: 'filesystem.read' }],
    });
    await expect(current.authority.test(installed.record.manifest.id)).resolves.toEqual({ healthy: true, reasons: [] });
  });

  it('keeps old grants version-bound when an update expands permissions and rolls back atomically', async () => {
    const current = subject();
    const v1 = await current.authority.install(path.resolve('capabilities/samples/workspace-summary'));
    current.authority.activate({ capabilityId: v1.record.manifest.id, version: '1.0.0', acceptPermissions: true });
    await expect(current.authority.test(v1.record.manifest.id)).resolves.toEqual({ healthy: true, reasons: [] });
    const source = path.join(root, 'v2-source');
    await fs.cp(path.resolve('capabilities/samples/workspace-summary'), source, { recursive: true });
    const manifestPath = path.join(source, 'capability.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, any>;
    manifest.version = '2.0.0';
    manifest.permissions.push({ kind: 'network.egress', scope: { hosts: ['example.invalid'] } });
    manifest.digest = '';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const { computeCapabilityPackageDigest } = await import('../../../core/v4/capabilities/installer');
    manifest.digest = await computeCapabilityPackageDigest(source);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const v2 = await current.authority.install(source);
    expect(() => current.authority.activate({ capabilityId: manifest.id, version: '2.0.0', acceptPermissions: false })).toThrow(/permission review/i);
    expect(current.store.getActive(manifest.id, 'workspace_1')?.version).toBe('1.0.0');
    expect(current.authority.inspect(manifest.id).rollbackTarget).toBeNull();
    current.authority.activate({ capabilityId: manifest.id, version: '2.0.0', acceptPermissions: true });
    expect(current.authority.inspect(manifest.id).rollbackTarget).toEqual({
      version: '1.0.0',
      digest: v1.record.manifest.digest,
    });
    expect(current.store.list({ identity: {
      capabilityId: manifest.id, version: '2.0.0', manifestVersion: 1, protocolVersion: 1, digest: v2.record.manifest.digest,
    }, ownerId: 'owner_1', workspaceId: 'workspace_1' })).toHaveLength(2);
    await fs.rm(path.join(v2.record.installPath, v2.record.manifest.entrypoint));
    await expect(current.authority.test(manifest.id)).resolves.toMatchObject({ healthy: false });
    expect(current.authority.rollback(manifest.id)).toMatchObject({ version: '1.0.0', digest: v1.record.manifest.digest });
    expect(current.authority.inspect(manifest.id).health).toMatchObject({ state: 'healthy' });
  });

  it('refuses active uninstall and removes only a disabled exact version', async () => {
    const current = subject();
    const installed = await current.authority.install(path.resolve('capabilities/samples/workspace-summary'));
    current.authority.activate({ capabilityId: installed.record.manifest.id, version: '1.0.0', acceptPermissions: true });
    await expect(current.authority.uninstall({ capabilityId: installed.record.manifest.id, version: '1.0.0' }))
      .rejects.toThrow(/disabled/i);
    current.authority.disable(installed.record.manifest.id);
    await expect(current.authority.uninstall({ capabilityId: installed.record.manifest.id, version: '1.0.0' })).resolves.toBe(true);
    await expect(fs.stat(installed.record.installPath)).rejects.toThrow();
    expect(current.authority.list()).toEqual([]);
  });
});
