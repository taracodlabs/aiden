/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Read-only Workbench projection over the canonical MCP client and shared
 * external identity/RemoteTask authority. Entitlement controls whether the
 * product surface is available; it never grants network or mutation authority.
 */
import type { EditionAuthority } from '../commercial/edition';
import type { ExternalAuthority } from '../external/externalAuthority';
import type { RemoteTaskRecord } from '../external/externalAuthority';
import { A2A_JSONRPC_BINDING, A2A_PROTOCOL_VERSION } from '../a2a/protocol';
import { MCP_PROTOCOL_VERSION } from '../mcp/protocol';
import type { McpClient } from '../mcpClient';

export interface WorkbenchExternalProtocolSnapshot {
  entitlements: { mcpExternal: boolean; a2aPreview: boolean };
  mcp: {
    canonicalProtocolVersion: string;
    servers: Array<{
      name: string;
      endpoint: string;
      transport: string;
      protocolVersion: string | null;
      status: string;
      identityId: string | null;
      trustState: string;
      authState: 'ready' | 'required' | 'unavailable';
      capabilityChange: string;
      reviewRequired: boolean;
      toolCount: number;
      readToolCount: number;
      mutationToolCount: number;
      mutationBlocked: boolean;
      resourcesAvailable: boolean;
    }>;
  };
  a2a: {
    protocolVersion: string;
    binding: string;
    mutationEnabled: false;
    agents: Array<{
      identityId: string;
      name: string;
      endpoint: string;
      trustState: string;
      identityKeyDigest: string | null;
      capabilityDigest: string | null;
      capabilityChange: string;
      reviewRequired: boolean;
    }>;
    recoverableTasks: Array<{
      recordId: string;
      identityId: string;
      localJobId: string;
      localAttemptId: string;
      generation: number;
      remoteTaskId: string | null;
      state: string;
      locallyVerified: boolean;
      updatedAt: number;
    }>;
    quarantinedArtifacts: number;
  };
}

export interface WorkbenchExternalProtocolsPort {
  snapshot(): WorkbenchExternalProtocolSnapshot;
  cancelRemoteTask(recordId: string, reason: string): Promise<RemoteTaskRecord>;
  reconcileRemoteTask(recordId: string): Promise<RemoteTaskRecord>;
}

export interface WorkbenchA2aControl {
  cancel(recordId: string, reason: string): Promise<RemoteTaskRecord>;
  reconcile(recordId: string): Promise<RemoteTaskRecord>;
}

export function createWorkbenchExternalProtocolsPort(input: {
  mcpClient?: Pick<McpClient, 'list'> | null;
  external: ExternalAuthority;
  edition: EditionAuthority;
  a2aRuntime?: WorkbenchA2aControl | null;
}): WorkbenchExternalProtocolsPort {
  const control = (): WorkbenchA2aControl => {
    if (!input.edition.can('a2a.preview')) throw new Error('A2A preview entitlement is unavailable');
    if (!input.a2aRuntime) throw new Error('A2A durable control is unavailable');
    return input.a2aRuntime;
  };
  return {
    snapshot() {
      const recoverableTasks = input.external.listRecoverableRemoteTasks();
      const artifactIds = new Set<string>();
      for (const task of recoverableTasks) {
        for (const artifact of input.external.listRemoteArtifacts(task.remoteTaskRecordId)) {
          if (artifact.quarantineState === 'quarantined') artifactIds.add(artifact.remoteArtifactId);
        }
      }
      return {
        entitlements: {
          mcpExternal: input.edition.can('mcp.external'),
          a2aPreview: input.edition.can('a2a.preview'),
        },
        mcp: {
          canonicalProtocolVersion: MCP_PROTOCOL_VERSION,
          servers: (input.mcpClient?.list() ?? []).map((server) => {
            const readToolCount = server.tools.filter((tool) => tool.effect === 'read_only').length;
            return {
              name: server.config.name,
              endpoint: server.config.type === 'http'
                ? server.config.http?.baseUrl ?? 'unavailable'
                : `${server.config.stdio?.command ?? 'stdio'} ${(server.config.stdio?.args ?? []).join(' ')}`.trim(),
              transport: server.config.type === 'http'
                ? server.config.http?.transport ?? 'streamable'
                : 'stdio',
              protocolVersion: server.protocolVersion ?? null,
              status: server.status,
              identityId: server.externalIdentityId ?? null,
              trustState: server.externalTrustState ?? 'unverified',
              authState: server.status === 'needs-auth'
                ? 'required' as const
                : server.status === 'ready' ? 'ready' as const : 'unavailable' as const,
              capabilityChange: server.capabilityChangeClass ?? 'unobserved',
              reviewRequired: server.capabilityReviewRequired === true,
              toolCount: server.tools.length,
              readToolCount,
              mutationToolCount: server.tools.length - readToolCount,
              mutationBlocked: server.mutationBlocked,
              resourcesAvailable: server.capabilities.resources !== undefined,
            };
          }),
        },
        a2a: {
          protocolVersion: A2A_PROTOCOL_VERSION,
          binding: A2A_JSONRPC_BINDING,
          mutationEnabled: false,
          agents: input.external.listIdentities('a2a').map((identity) => {
            const capabilities = input.external.latestCapabilities(identity.externalIdentityId);
            return {
              identityId: identity.externalIdentityId,
              name: identity.displayName,
              endpoint: identity.canonicalEndpoint,
              trustState: identity.trustState,
              identityKeyDigest: identity.observedIdentityKeyDigest,
              capabilityDigest: capabilities?.capabilityDigest ?? null,
              capabilityChange: capabilities?.changeClass ?? 'unobserved',
              reviewRequired: capabilities?.reviewRequired === true,
            };
          }),
          recoverableTasks: recoverableTasks.map((task) => ({
            recordId: task.remoteTaskRecordId,
            identityId: task.externalIdentityId,
            localJobId: task.localJobId,
            localAttemptId: task.localAttemptId,
            generation: task.localGeneration,
            remoteTaskId: task.remoteTaskId,
            state: task.state,
            locallyVerified: task.locallyVerified,
            updatedAt: task.updatedAt,
          })),
          quarantinedArtifacts: artifactIds.size,
        },
      };
    },
    async cancelRemoteTask(recordId, reason) {
      const normalizedRecordId = recordId.trim();
      const normalizedReason = reason.trim();
      if (!normalizedRecordId || normalizedRecordId.length > 512) throw new Error('RemoteTask identity is invalid');
      if (!normalizedReason || normalizedReason.length > 1_000) throw new Error('Cancellation reason is required');
      return control().cancel(normalizedRecordId, normalizedReason);
    },
    async reconcileRemoteTask(recordId) {
      const normalizedRecordId = recordId.trim();
      if (!normalizedRecordId || normalizedRecordId.length > 512) throw new Error('RemoteTask identity is invalid');
      return control().reconcile(normalizedRecordId);
    },
  };
}
