/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { createWorkbenchExternalProtocolsPort } from '../../../core/v4/workbench/externalProtocolsPort';
import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';

const TOKEN = 'external-protocol-token';
const reader = { listEventsScoped: () => [] };
let bridge: WorkbenchBridge | null = null;

afterEach(async () => {
  await bridge?.close();
  bridge = null;
});

function authority() {
  const identity = {
    externalIdentityId: 'external_a2a_1', displayName: 'Repository reader',
    canonicalEndpoint: 'https://agent.example.test/a2a', trustState: 'verified_key',
    observedIdentityKeyDigest: 'a'.repeat(64), trustedIdentityKeyDigest: 'a'.repeat(64),
    stateVersion: 2, firstObservedAt: 1, lastObservedAt: 2, verifiedAt: 2, revokedAt: null,
  };
  const task = {
    remoteTaskRecordId: 'remote_task_1', externalIdentityId: identity.externalIdentityId,
    localJobId: 'job_child_1', localAttemptId: 'attempt_1', localGeneration: 1,
    state: 'unknown', locallyVerified: false, remoteTaskId: 'remote-1',
    updatedAt: 3,
  };
  return {
    listIdentities: vi.fn(() => [identity]),
    latestCapabilities: vi.fn(() => ({
      protocolVersion: '1.0', capabilityDigest: 'b'.repeat(64),
      changeClass: 'same', reviewRequired: false,
    })),
    listRecoverableRemoteTasks: vi.fn(() => [task]),
    listRemoteArtifacts: vi.fn(() => [{
      remoteArtifactId: 'remote_artifact_1', declaredName: 'report.txt',
      quarantineState: 'quarantined', byteLength: 20,
    }]),
  };
}

function client() {
  return {
    list: () => [{
      config: { name: 'repo', type: 'http', http: { baseUrl: 'https://mcp.example.test', transport: 'streamable' } },
      status: 'ready', protocolVersion: '2025-11-25', externalIdentityId: 'external_mcp_1',
      externalTrustState: 'verified_endpoint', capabilityChangeClass: 'same',
      capabilityReviewRequired: false, mutationBlocked: false,
      capabilities: { resources: { subscribe: true } },
      tools: [{ rawName: 'read_file', effect: 'read_only' }, { rawName: 'write_file', effect: 'mutation' }],
    }],
  };
}

describe('Workbench external protocol projection', () => {
  it('projects exact MCP and A2A authority without granting mutation', () => {
    const port = createWorkbenchExternalProtocolsPort({
      mcpClient: client() as never,
      external: authority() as never,
      edition: buildEditionAuthority('pro'),
    });
    const snapshot = port.snapshot();

    expect(snapshot.entitlements).toEqual({ mcpExternal: true, a2aPreview: true });
    expect(snapshot.mcp.servers[0]).toMatchObject({
      name: 'repo', endpoint: 'https://mcp.example.test', transport: 'streamable',
      protocolVersion: '2025-11-25', trustState: 'verified_endpoint',
      readToolCount: 1, mutationToolCount: 1,
    });
    expect(snapshot.a2a).toMatchObject({ protocolVersion: '1.0', mutationEnabled: false });
    expect(snapshot.a2a.agents[0]).toMatchObject({ name: 'Repository reader', trustState: 'verified_key' });
    expect(snapshot.a2a.recoverableTasks[0]).toMatchObject({
      recordId: 'remote_task_1', localJobId: 'job_child_1', state: 'unknown', locallyVerified: false,
    });
    expect(snapshot.a2a.quarantinedArtifacts).toBe(1);
  });

  it('token-gates exact durable A2A cancellation and reconciliation without exposing delegation mutation', async () => {
    const runtime = {
      cancel: vi.fn(async (recordId: string, reason: string) => ({ remoteTaskRecordId: recordId, state: 'cancel_requested', reason })),
      reconcile: vi.fn(async (recordId: string) => ({ remoteTaskRecordId: recordId, state: 'cancelled_observed' })),
    };
    const externalProtocols = createWorkbenchExternalProtocolsPort({
      mcpClient: client() as never,
      external: authority() as never,
      edition: buildEditionAuthority('pro'),
      a2aRuntime: runtime as never,
    });
    bridge = await startWorkbenchBridge({ reader, externalProtocols, token: TOKEN, port: 0 });

    const denied = await fetch(`http://127.0.0.1:${bridge.port}/api/external-protocols`);
    expect(denied.status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/external-protocols`, {
      headers: { 'x-workbench-token': TOKEN },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain('remote_task_1');

    const deniedControl = await fetch(`http://127.0.0.1:${bridge.port}/api/external-protocols/a2a/tasks/remote_task_1/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'operator request' }),
    });
    expect(deniedControl.status).toBe(401);
    const cancelled = await fetch(`http://127.0.0.1:${bridge.port}/api/external-protocols/a2a/tasks/remote_task_1/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({ reason: 'operator request' }),
    });
    expect(cancelled.status).toBe(200);
    expect(runtime.cancel).toHaveBeenCalledWith('remote_task_1', 'operator request');

    const reconciled = await fetch(`http://127.0.0.1:${bridge.port}/api/external-protocols/a2a/tasks/remote_task_1/reconcile`, {
      method: 'POST', headers: { 'x-workbench-token': TOKEN },
    });
    expect(reconciled.status).toBe(200);
    expect(runtime.reconcile).toHaveBeenCalledWith('remote_task_1');

    const mutation = await fetch(`http://127.0.0.1:${bridge.port}/api/external-protocols/connect`, {
      method: 'POST', headers: { 'x-workbench-token': TOKEN },
    });
    expect(mutation.status).toBe(405);
  });
});
