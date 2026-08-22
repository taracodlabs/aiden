/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CapabilityPermissionAuthority,
  capabilityPermissionDiff,
  type CapabilityGrant,
} from '../../../core/v4/capabilities/permissionAuthority';
import type { CapabilityIdentity, CapabilityManifest } from '../../../packages/capability-sdk/src';

const root = path.resolve('C:/disposable/workspace');
const identity: CapabilityIdentity = {
  capabilityId: 'dev.taracod.workspace-summary', version: '1.0.0',
  manifestVersion: 1, protocolVersion: 1, digest: `sha256:${'1'.repeat(64)}`,
};
const manifest = {
  permissions: [{ kind: 'filesystem.read', scope: { paths: ['src/**', 'package.json'] } }],
} as CapabilityManifest;
const grant: CapabilityGrant = {
  grantId: 'grant_1', identity, ownerId: 'owner_1', workspaceId: 'workspace_1',
  permission: 'filesystem.read', scope: { paths: ['src/**', 'package.json'] },
  grantedAt: 1,
};

function authority(overrides: Partial<ConstructorParameters<typeof CapabilityPermissionAuthority>[0]> = {}) {
  return new CapabilityPermissionAuthority({
    runtimePermissions: ['filesystem.read', 'filesystem.write', 'artifact.create'],
    grants: { list: () => [grant] },
    ...overrides,
  });
}

describe('Capability permission authority', () => {
  it('default-denies undeclared and declared-but-ungranted permissions', () => {
    const auth = authority();
    expect(auth.authorize({
      identity, manifest, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      permission: 'filesystem.write', resource: path.join(root, 'src/new.ts'),
    })).toMatchObject({ allowed: false, reason: 'permission_not_declared' });

    expect(authority({ grants: { list: () => [] } }).authorize({
      identity, manifest, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      permission: 'filesystem.read', resource: path.join(root, 'src/index.ts'),
    })).toMatchObject({ allowed: false, reason: 'permission_not_granted' });
  });

  it('allows only the exact immutable identity, owner, workspace and path scope', () => {
    const auth = authority();
    expect(auth.authorize({
      identity, manifest, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      permission: 'filesystem.read', resource: path.join(root, 'src/index.ts'),
    })).toMatchObject({ allowed: true });
    expect(auth.authorize({
      identity: { ...identity, digest: `sha256:${'2'.repeat(64)}` }, manifest,
      ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      permission: 'filesystem.read', resource: path.join(root, 'src/index.ts'),
    })).toMatchObject({ allowed: false, reason: 'permission_not_granted' });
    expect(auth.authorize({
      identity, manifest, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      permission: 'filesystem.read', resource: path.resolve(root, '../forbidden.txt'),
    })).toMatchObject({ allowed: false, reason: 'outside_workspace' });
  });

  it('rejects a workspace path whose existing symlink or junction escapes the workspace', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-symlink-'));
    const workspace = path.join(parent, 'workspace');
    const outside = path.join(parent, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8');
    await fs.symlink(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const broadManifest = {
        ...manifest,
        permissions: [{ kind: 'filesystem.read', scope: { paths: ['**/*'] } }],
      } as CapabilityManifest;
      const broadGrant: CapabilityGrant = {
        ...grant,
        scope: { paths: ['**/*'] },
      };
      expect(authority({ grants: { list: () => [broadGrant] } }).authorize({
        identity,
        manifest: broadManifest,
        ownerId: 'owner_1',
        workspaceId: 'workspace_1',
        workspaceRoot: workspace,
        permission: 'filesystem.read',
        resource: path.join(workspace, 'linked', 'secret.txt'),
      })).toMatchObject({ allowed: false, reason: 'outside_workspace' });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('intersects grants with Job resources and runtime policy', () => {
    expect(authority({
      jobResources: { authorize: ({ kind, value }) => kind !== 'path' || !value.endsWith('blocked.ts') },
      jobId: 'job_1',
    }).authorize({
      identity, manifest, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      permission: 'filesystem.read', resource: path.join(root, 'src/blocked.ts'),
    })).toMatchObject({ allowed: false, reason: 'job_resource_denied' });

    const networkManifest = {
      ...manifest,
      permissions: [{ kind: 'network.egress', scope: { hosts: ['example.test'] } }],
    } as CapabilityManifest;
    const networkGrant = { ...grant, permission: 'network.egress', scope: { hosts: ['example.test'] } } as CapabilityGrant;
    expect(authority({ grants: { list: () => [networkGrant] } }).authorize({
      identity, manifest: networkManifest, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      permission: 'network.egress', resource: 'example.test',
    })).toMatchObject({ allowed: false, reason: 'runtime_policy_denied' });
  });

  it('computes permission expansion and never carries an old immutable grant to v2', () => {
    const v2 = {
      ...manifest,
      version: '2.0.0',
      digest: `sha256:${'3'.repeat(64)}`,
      permissions: [
        ...manifest.permissions,
        { kind: 'network.egress', scope: { hosts: ['api.example.test'] } },
      ],
    } as CapabilityManifest;
    expect(capabilityPermissionDiff(manifest, v2)).toEqual({
      added: [{ kind: 'network.egress', scope: { hosts: ['api.example.test'] } }],
      removed: [],
      unchanged: manifest.permissions,
    });
    expect(authority().authorize({
      identity: { ...identity, version: '2.0.0', digest: v2.digest }, manifest: v2,
      ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      permission: 'filesystem.read', resource: path.join(root, 'src/index.ts'),
    })).toMatchObject({ allowed: false, reason: 'permission_not_granted' });
  });
});
