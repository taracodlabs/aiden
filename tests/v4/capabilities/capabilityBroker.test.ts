/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CapabilityBroker,
  type CapabilityBrokerJobAuthority,
} from '../../../core/v4/capabilities/broker';
import {
  CapabilityPermissionAuthority,
  type CapabilityGrant,
} from '../../../core/v4/capabilities/permissionAuthority';
import {
  capabilityIdentity,
  type CapabilityBrokerRequestMessage,
  type CapabilityManifest,
} from '../../../packages/capability-sdk/src';

const workspaceRoot = path.resolve('C:/workspace');
const manifest: CapabilityManifest = {
  manifestVersion: 1,
  id: 'dev.taracod.workspace-summary',
  version: '1.0.0',
  displayName: 'Workspace summary',
  runtime: { kind: 'node', protocolVersion: 1 },
  entrypoint: 'index.js',
  tools: [{
    name: 'workspace_summary', description: 'Summarize files.', mutates: false,
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  }],
  permissions: [
    { kind: 'filesystem.read', scope: { paths: ['src/**/*', 'package.json'] } },
    { kind: 'filesystem.write', scope: { paths: ['out/**/*'] } },
  ],
  effects: [{ tool: 'workspace_summary', kind: 'filesystem.write', approval: 'required', reversible: true }],
  secretSlots: [],
  compatibility: { aiden: '>=4.20.0 <5', node: '>=20 <21 || >=22 <23', os: ['win32'], architectures: ['x64'] },
  limits: { runtimeMs: 5_000, maxMessageBytes: 32_768, maxTotalOutputBytes: 262_144, maxBrokerRequests: 8, maxEvidenceClaims: 4 },
  digest: `sha256:${'a'.repeat(64)}`,
};
const identity = capabilityIdentity(manifest);
const linkage = {
  jobId: 'job_1', attemptId: 'attempt_1', generation: 3, fenceToken: 'fence_3', producer: 'capability-test',
};

function request(overrides: Partial<CapabilityBrokerRequestMessage> = {}): CapabilityBrokerRequestMessage {
  return {
    type: 'BROKER_REQUEST', sequence: 1, invocationId: 'inv_1', identity,
    requestId: 'request_1', operation: 'filesystem.read', resource: 'src/index.ts', arguments: {},
    ...overrides,
  };
}

function authority(): CapabilityBrokerJobAuthority {
  return {
    getJob: () => ({ id: linkage.jobId, status: 'running', activeAttemptId: linkage.attemptId }),
    getAttempt: () => ({
      id: linkage.attemptId, jobId: linkage.jobId, status: 'running', generation: linkage.generation,
      fenceToken: linkage.fenceToken, leaseExpiresAt: Date.now() + 60_000,
    }),
  };
}

function broker(options: {
  grants?: CapabilityGrant[];
  execute?: ReturnType<typeof vi.fn>;
  jobAuthority?: CapabilityBrokerJobAuthority;
} = {}) {
  const grants = options.grants ?? [
    {
      grantId: 'grant_read', identity, ownerId: 'owner_1', workspaceId: 'workspace_1',
      permission: 'filesystem.read' as const, scope: { paths: ['src/**/*', 'package.json'] }, grantedAt: 1,
    },
    {
      grantId: 'grant_write', identity, ownerId: 'owner_1', workspaceId: 'workspace_1',
      permission: 'filesystem.write' as const, scope: { paths: ['out/**/*'] }, grantedAt: 1,
    },
  ];
  const execute = options.execute ?? vi.fn(async (call: { id: string; name: string; arguments: Record<string, unknown> }) => ({
    id: call.id, name: call.name, result: { success: true, path: call.arguments.path, content: 'ok' },
  }));
  return {
    execute,
    instance: new CapabilityBroker({
      invocationId: 'inv_1', identity, manifest, ownerId: 'owner_1', workspaceId: 'workspace_1',
      workspaceRoot, linkage, jobAuthority: options.jobAuthority ?? authority(),
      permissionAuthority: new CapabilityPermissionAuthority({ grants: { list: () => grants } }),
      executeTool: execute,
      listEvidence: () => [],
    }),
  };
}

describe('Capability broker authority', () => {
  it('routes an allowed read through the canonical ToolRegistry executor', async () => {
    const subject = broker();
    const result = await subject.instance.handle(request());
    expect(result).toMatchObject({ ok: true, requestId: 'request_1' });
    expect(subject.execute).toHaveBeenCalledWith({
      id: 'capability:inv_1:request_1',
      name: 'file_read',
      arguments: { path: path.join(workspaceRoot, 'src/index.ts') },
    });
  });

  it.each([
    ['outside workspace', request({ resource: '../forbidden.txt' }), /outside_workspace/],
    ['undeclared network', request({ operation: 'filesystem.read', resource: 'README.md' }), /declared_scope_denied/],
  ])('fails closed for %s', async (_name, brokerRequest, error) => {
    const subject = broker();
    await expect(subject.instance.handle(brokerRequest)).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied', message: expect.stringMatching(error) } });
    expect(subject.execute).not.toHaveBeenCalled();
  });

  it('does not treat commercial entitlement as an execution grant', async () => {
    const subject = broker({ grants: [] });
    await expect(subject.instance.handle(request())).resolves.toMatchObject({
      ok: false, error: { code: 'permission_denied', message: 'permission_not_granted' },
    });
    expect(subject.execute).not.toHaveBeenCalled();
  });

  it('routes writes through the canonical mutating tool and reports host Evidence only', async () => {
    const expectedToolCallId = `tool-call:sha256:${await import('node:crypto').then(({ createHash }) => createHash('sha256')
      .update(`${linkage.attemptId}\0${linkage.generation}\0capability:inv_1:request_write`).digest('hex'))}`;
    const evidence = [{
      evidenceId: 'evidence_host_1', attemptId: linkage.attemptId, generation: linkage.generation,
      effectId: `side_effect:${expectedToolCallId}`,
    }];
    const execute = vi.fn(async (call: { id: string; name: string }) => ({
      id: call.id, name: call.name, result: { success: true, verified: true },
    }));
    const subject = broker({ execute });
    subject.instance.setEvidenceReader(() => evidence);
    const result = await subject.instance.handle(request({
      requestId: 'request_write', operation: 'filesystem.write', resource: 'out/result.txt',
      arguments: { content: 'verified content' },
    }));
    expect(execute).toHaveBeenCalledWith({
      id: 'capability:inv_1:request_write', name: 'file_write',
      arguments: { path: path.join(workspaceRoot, 'out/result.txt'), content: 'verified content' },
    });
    expect(result).toMatchObject({
      ok: true,
      authority: {
        toolCallId: expect.stringMatching(/^tool-call:/),
        effectId: expect.stringMatching(/^side_effect:tool-call:/),
        evidenceIds: ['evidence_host_1'],
      },
    });
  });

  it('rejects stale generation or fence before any brokered effect', async () => {
    const stale: CapabilityBrokerJobAuthority = {
      getJob: () => ({ id: linkage.jobId, status: 'running', activeAttemptId: linkage.attemptId }),
      getAttempt: () => ({
        id: linkage.attemptId, jobId: linkage.jobId, status: 'running', generation: linkage.generation + 1,
        fenceToken: 'fence_4', leaseExpiresAt: Date.now() + 60_000,
      }),
    };
    const subject = broker({ jobAuthority: stale });
    await expect(subject.instance.handle(request({ operation: 'filesystem.write', resource: 'out/result.txt', arguments: { content: 'no' } })))
      .resolves.toMatchObject({ ok: false, error: { code: 'stale_authority' } });
    expect(subject.execute).not.toHaveBeenCalled();
  });

  it('replays an exact broker request idempotently and rejects changed arguments', async () => {
    const subject = broker();
    const first = await subject.instance.handle(request());
    expect(await subject.instance.handle(request())).toEqual(first);
    expect(subject.execute).toHaveBeenCalledTimes(1);
    await expect(subject.instance.handle(request({ arguments: { offset: 2 } }))).resolves.toMatchObject({
      ok: false, error: { code: 'request_conflict' },
    });
    expect(subject.execute).toHaveBeenCalledTimes(1);
  });
});
