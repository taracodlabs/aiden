/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  CapabilityInstaller,
  computeCapabilityPackageDigest,
} from '../../../core/v4/capabilities/installer';
import { createCapabilityStore } from '../../../core/v4/capabilities/store';
import type { CapabilityManifest } from '../../../packages/capability-sdk/src';

let root = '';
let db: Database.Database;

async function sourcePackage(version: string, options: { network?: boolean; body?: string } = {}): Promise<string> {
  const dir = path.join(root, 'source', version.replace(/[^A-Za-z0-9.-]/g, '_'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.js'), options.body ?? 'process.stdin.resume();\n', 'utf8');
  const manifest = {
    manifestVersion: 1,
    id: 'dev.taracod.workspace-summary',
    version,
    displayName: 'Workspace summary',
    runtime: { kind: 'node', protocolVersion: 1 },
    entrypoint: 'index.js',
    tools: [{
      name: 'workspace_summary', description: 'Summarize granted files.', mutates: false,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      outputSchema: { type: 'object', additionalProperties: true },
    }],
    permissions: [
      { kind: 'filesystem.read', scope: { paths: ['**/*'] } },
      ...(options.network ? [{ kind: 'network.egress', scope: { hosts: ['api.example.test'] } }] : []),
    ],
    effects: [], secretSlots: [],
    compatibility: { aiden: '>=4.20.0 <5.0.0', node: '>=20 <21 || >=22 <23', os: ['win32', 'linux', 'darwin'], architectures: ['x64', 'arm64'] },
    limits: { runtimeMs: 5_000, maxMessageBytes: 32_768, maxTotalOutputBytes: 262_144, maxBrokerRequests: 32, maxEvidenceClaims: 16 },
    digest: `sha256:${'0'.repeat(64)}`,
  } as CapabilityManifest;
  await fs.writeFile(path.join(dir, 'capability.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  manifest.digest = await computeCapabilityPackageDigest(dir);
  await fs.writeFile(path.join(dir, 'capability.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-install-'));
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Capability immutable installation and activation', () => {
  it('keeps digest-bound sample package text byte-stable across checkouts', async () => {
    const attributes = await fs.readFile(path.resolve('.gitattributes'), 'utf8');
    expect(attributes).toContain('capabilities/samples/**/*.json text eol=lf');
    expect(attributes).toContain('capabilities/samples/**/*.js text eol=lf');
  });

  it('stages, verifies and atomically installs one immutable package', async () => {
    const source = await sourcePackage('1.0.0');
    const store = createCapabilityStore(db);
    const installer = new CapabilityInstaller({ aidenRoot: root, store, aidenVersion: '4.20.0' });
    const installed = await installer.install(source);
    expect(installed.idempotent).toBe(false);
    expect(installed.record.manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await fs.stat(installed.record.installPath)).toBeTruthy();
    expect(store.getActive('dev.taracod.workspace-summary', 'global')).toBeNull();

    const active = installer.activate({
      capabilityId: installed.record.manifest.id,
      version: installed.record.manifest.version,
      digest: installed.record.manifest.digest,
      scopeId: 'global', permissionReviewAccepted: true,
    });
    expect(active.digest).toBe(installed.record.manifest.digest);
    expect(store.getActive('dev.taracod.workspace-summary', 'global')?.digest).toBe(installed.record.manifest.digest);
    expect((await fs.readdir(path.join(root, 'capabilities', '.staging')))).toEqual([]);
  });

  it('keeps POSIX package directories movable while protecting installed file bytes', async () => {
    const source = await sourcePackage('1.0.0');
    const installer = new CapabilityInstaller({
      aidenRoot: root,
      store: createCapabilityStore(db),
      aidenVersion: '4.20.0',
    });

    const installed = await installer.install(source);

    if (process.platform !== 'win32') {
      const directoryMode = (await fs.stat(installed.record.installPath)).mode & 0o777;
      const entrypointMode = (await fs.stat(path.join(
        installed.record.installPath,
        installed.record.manifest.entrypoint,
      ))).mode & 0o777;
      expect(directoryMode & 0o200).toBe(0o200);
      expect(entrypointMode).toBe(0o444);
    }
    expect(await fs.readdir(path.join(root, 'capabilities', '.staging'))).toEqual([]);
  });

  it('is idempotent for exact bytes and rejects same id/version with changed bytes', async () => {
    const source = await sourcePackage('1.0.0');
    const installer = new CapabilityInstaller({ aidenRoot: root, store: createCapabilityStore(db), aidenVersion: '4.20.0' });
    const first = await installer.install(source);
    expect((await installer.install(source)).idempotent).toBe(true);

    const changed = await sourcePackage('1.0.0', { body: 'process.stdout.write("changed");\n' });
    await expect(installer.install(changed)).rejects.toThrow(/immutable|already installed/i);
    expect(installer.listVersions(first.record.manifest.id)).toHaveLength(1);
  });

  it('requires review for permission expansion and rolls back to exact v1 bytes', async () => {
    const store = createCapabilityStore(db);
    const installer = new CapabilityInstaller({ aidenRoot: root, store, aidenVersion: '4.20.0' });
    const v1 = await installer.install(await sourcePackage('1.0.0'));
    installer.activate({ capabilityId: v1.record.manifest.id, version: '1.0.0', digest: v1.record.manifest.digest, scopeId: 'workspace_1', permissionReviewAccepted: true });
    const v2 = await installer.install(await sourcePackage('2.0.0', { network: true }));
    const diff = installer.permissionDiff(v1.record.manifest.id, v2.record.manifest.version, v2.record.manifest.digest, 'workspace_1');
    expect(diff.added).toEqual([{ kind: 'network.egress', scope: { hosts: ['api.example.test'] } }]);
    expect(() => installer.activate({
      capabilityId: v2.record.manifest.id, version: '2.0.0', digest: v2.record.manifest.digest,
      scopeId: 'workspace_1', permissionReviewAccepted: false,
    })).toThrow(/permission review/i);
    expect(store.getActive(v1.record.manifest.id, 'workspace_1')?.version).toBe('1.0.0');

    installer.activate({ capabilityId: v2.record.manifest.id, version: '2.0.0', digest: v2.record.manifest.digest, scopeId: 'workspace_1', permissionReviewAccepted: true });
    const rolledBack = installer.rollback(v1.record.manifest.id, 'workspace_1');
    expect(rolledBack.version).toBe('1.0.0');
    expect(rolledBack.digest).toBe(v1.record.manifest.digest);
  });

  it('cleans incomplete staging and preserves the active pointer across a new store', async () => {
    const store = createCapabilityStore(db);
    const installer = new CapabilityInstaller({ aidenRoot: root, store, aidenVersion: '4.20.0' });
    const installed = await installer.install(await sourcePackage('1.0.0'));
    installer.activate({ capabilityId: installed.record.manifest.id, version: '1.0.0', digest: installed.record.manifest.digest, scopeId: 'global', permissionReviewAccepted: true });
    const partial = path.join(root, 'capabilities', '.staging', 'partial-crash');
    await fs.mkdir(partial, { recursive: true });
    await fs.writeFile(path.join(partial, 'partial'), 'not active');
    expect(await installer.cleanupStaging()).toBe(1);
    expect(createCapabilityStore(db).getActive(installed.record.manifest.id, 'global')?.digest).toBe(installed.record.manifest.digest);
  });

  it('can reinstall the exact immutable bytes after a disabled uninstall', async () => {
    const source = await sourcePackage('1.0.0');
    const store = createCapabilityStore(db);
    const installer = new CapabilityInstaller({ aidenRoot: root, store, aidenVersion: '4.20.0' });
    const first = await installer.install(source);
    installer.activate({
      capabilityId: first.record.manifest.id,
      version: first.record.manifest.version,
      digest: first.record.manifest.digest,
      scopeId: 'workspace_1',
      permissionReviewAccepted: true,
    });
    store.disable(first.record.manifest.id, 'workspace_1');
    expect(store.markUninstalled(first.record.manifest.id, first.record.manifest.version, first.record.manifest.digest)).toBe(true);
    await fs.rm(first.record.installPath, { recursive: true, force: true });

    const reinstalled = await installer.install(source);

    expect(reinstalled.idempotent).toBe(false);
    expect(reinstalled.record.uninstalledAt).toBeNull();
    expect(store.findVersion(first.record.manifest.id, '1.0.0')?.manifest.digest).toBe(first.record.manifest.digest);
    await expect(fs.stat(reinstalled.record.installPath)).resolves.toBeTruthy();
  });

  it('rejects forbidden package material, symlinks, digest drift and incompatible runtimes', async () => {
    const store = createCapabilityStore(db);
    const installer = new CapabilityInstaller({
      aidenRoot: root, store, aidenVersion: '4.20.0', nodeVersion: '22.23.1',
    });

    const forbidden = await sourcePackage('1.0.1');
    await fs.writeFile(path.join(forbidden, '.env'), 'TOKEN=must-not-install', 'utf8');
    await expect(installer.install(forbidden)).rejects.toThrow(/forbidden file/i);

    const linked = await sourcePackage('1.0.2');
    const outside = path.join(root, 'outside-link-target');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(linked, 'linked-host-directory'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(installer.install(linked)).rejects.toThrow(/symlink/i);

    const drifted = await sourcePackage('1.0.3');
    await fs.appendFile(path.join(drifted, 'index.js'), '// changed after signing\n', 'utf8');
    await expect(installer.install(drifted)).rejects.toThrow(/digest mismatch/i);

    const incompatible = await sourcePackage('1.0.4');
    const manifestPath = path.join(incompatible, 'capability.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as CapabilityManifest;
    manifest.compatibility.node = '>=20 <21';
    manifest.digest = '';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    manifest.digest = await computeCapabilityPackageDigest(incompatible);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await expect(installer.install(incompatible)).rejects.toThrow(/incompatible/i);

    expect(store.listVersions()).toEqual([]);
  });
});
