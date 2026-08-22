/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ToolCallRequest, ToolCallResult, ToolSchema } from '../../../providers/v4/types';
import {
  asJsonValue,
  capabilityIdentity,
  type CapabilityIdentity,
  type CapabilityManifest,
  type JsonValue,
} from '../../../packages/capability-sdk/src';
import { currentJobExecutionContext } from '../daemon/jobExecutionContext';
import type { ToolRegistry } from '../toolRegistry';
import { CapabilityBroker } from './broker';
import {
  CapabilityPermissionAuthority,
  capabilityPermissionDigest,
} from './permissionAuthority';
import type { DockerCapabilityProcessHost, CapabilityProcessResult } from './processHost';
import type { CapabilityInvocationState, CapabilityStore } from './store';
import { CapabilityRecoveryAuthority, type CapabilityHostIdentity } from './recovery';
import { getProcessCreationTime } from '../util/spawnCommand';
import { computeCapabilityPackageDigest } from './installer';

export interface CapabilityProcessHostPort {
  probe(): { available: boolean; mechanism: 'docker'; reason?: string; image: string };
  run(input: Parameters<DockerCapabilityProcessHost['run']>[0]): Promise<CapabilityProcessResult>;
  removeInvocation?(invocationId: string): number;
}

export function capabilityToolName(identity: CapabilityIdentity, tool: string): string {
  const prefix = createHash('sha256')
    .update(`${identity.capabilityId}\0${identity.version}\0${identity.digest}`)
    .digest('hex').slice(0, 10);
  return `cap_${prefix}_${tool}`.slice(0, 64);
}

function terminalHealth(state: CapabilityProcessResult['state']): 'healthy' | 'degraded' | 'unavailable' {
  if (state === 'completed') return 'healthy';
  if (state === 'protocol_error') return 'degraded';
  return 'unavailable';
}

function terminalInvocationState(state: CapabilityProcessResult['state']): CapabilityInvocationState {
  return state;
}

function toolSchema(manifest: CapabilityManifest, tool: CapabilityManifest['tools'][number]): ToolSchema {
  const schema = tool.inputSchema as ToolSchema['inputSchema'];
  return {
    name: capabilityToolName(capabilityIdentity(manifest), tool.name),
    description: `${tool.description} (Capability: ${manifest.displayName} ${manifest.version})`,
    inputSchema: {
      type: 'object',
      properties: schema.properties ?? {},
      ...(schema.required ? { required: schema.required } : {}),
      ...(schema.additionalProperties === undefined ? {} : { additionalProperties: schema.additionalProperties }),
    },
  };
}

export class CapabilityRuntime {
  private readonly hostIdentity: CapabilityHostIdentity;

  constructor(private readonly options: {
    store: CapabilityStore;
    processHost: CapabilityProcessHostPort;
    canExecute: () => boolean;
    runtimePermissions?: readonly ('filesystem.read' | 'filesystem.write' | 'artifact.create')[];
    hostIdentity?: CapabilityHostIdentity;
    integrityVerifier?: (input: { installPath: string; digest: string }) => Promise<boolean>;
  }) {
    this.hostIdentity = options.hostIdentity ?? {
      instanceId: `cap_host_${randomUUID()}`,
      pid: process.pid,
      startTime: getProcessCreationTime(process.pid),
    };
  }

  reconcileInterruptedInvocations(): { recovered: number; live: number; failedCleanup: number } {
    if (!this.options.processHost.removeInvocation) {
      return { recovered: 0, live: this.options.store.listNonterminalInvocations().length, failedCleanup: 0 };
    }
    return new CapabilityRecoveryAuthority({
      store: this.options.store,
      processHost: { removeInvocation: (invocationId) => this.options.processHost.removeInvocation!(invocationId) },
      currentHost: this.hostIdentity,
    }).reconcile();
  }

  inspect(capabilityId: string, scopeId: string): {
    active: ReturnType<CapabilityStore['getActive']>;
    versions: ReturnType<CapabilityStore['listVersions']>;
    health: ReturnType<CapabilityStore['getHealth']> | null;
    sandbox: ReturnType<CapabilityProcessHostPort['probe']>;
  } {
    const active = this.options.store.getActive(capabilityId, scopeId);
    const version = active
      ? this.options.store.getVersion(capabilityId, active.version, active.digest)
      : null;
    return {
      active,
      versions: this.options.store.listVersions(capabilityId),
      health: version ? this.options.store.getHealth(capabilityIdentity(version.manifest)) : null,
      sandbox: this.options.processHost.probe(),
    };
  }

  registerActiveTools(input: {
    registry: ToolRegistry;
    scopeId: string;
    ownerId: string;
    workspaceId: string;
    workspaceRoot: string;
  }): string[] {
    const names: string[] = [];
    for (const active of this.options.store.listActive(input.scopeId).filter((item) => item.enabled)) {
      const installed = this.options.store.getVersion(active.capabilityId, active.version, active.digest);
      if (!installed || installed.uninstalledAt !== null) continue;
      const exactIdentity = capabilityIdentity(installed.manifest);
      for (const tool of installed.manifest.tools) {
        const schema = toolSchema(installed.manifest, tool);
        if (input.registry.get(schema.name)) throw new Error(`Capability tool adapter collision: ${schema.name}`);
        input.registry.register({
          schema,
          category: tool.mutates ? 'write' : 'read',
          // The adapter itself has no ambient effect authority. Mutations are
          // re-admitted as nested canonical tools by CapabilityBroker, so
          // declaring the adapter mutating would create a duplicate approval.
          mutates: false,
          riskTier: tool.mutates ? 'caution' : 'safe',
          toolset: 'capabilities',
          execute: async (args, context) => this.invoke({
            capabilityId: exactIdentity.capabilityId,
            version: exactIdentity.version,
            digest: exactIdentity.digest,
            tool: tool.name,
            input: asJsonValue(args),
            ownerId: input.ownerId,
            workspaceId: input.workspaceId,
            workspaceRoot: input.workspaceRoot,
            executeTool: input.registry.buildExecutor(context),
          }),
        });
        names.push(schema.name);
      }
    }
    return names;
  }

  async invoke(command: {
    capabilityId: string;
    version: string;
    digest: string;
    tool: string;
    input: JsonValue;
    ownerId: string;
    workspaceId: string;
    workspaceRoot: string;
    executeTool: (call: ToolCallRequest) => Promise<ToolCallResult>;
  }): Promise<Record<string, unknown>> {
    if (!this.options.canExecute()) throw new Error('Capability SDK entitlement is required for execution');
    const context = currentJobExecutionContext();
    if (!context) throw new Error('Capability execution requires an active durable Job Attempt');
    const installed = this.options.store.getVersion(command.capabilityId, command.version, command.digest);
    if (!installed || installed.uninstalledAt !== null) throw new Error('Exact immutable capability version is not installed');
    const identity = capabilityIdentity(installed.manifest);
    const integrityVerified = await (this.options.integrityVerifier
      ?? (async (input) => computeCapabilityPackageDigest(input.installPath)
        .then((digest) => digest === input.digest)
        .catch(() => false)))({ installPath: installed.installPath, digest: identity.digest });
    if (!integrityVerified) {
      const prior = this.options.store.getHealth(identity);
      this.options.store.recordHealth({
        identity,
        state: 'unavailable',
        consecutiveFailures: (prior?.consecutiveFailures ?? 0) + 1,
        lastReason: 'immutable package digest mismatch',
        lastCheckedAt: Date.now(),
        lastInvocationId: prior?.lastInvocationId ?? null,
      });
      throw new Error('Capability immutable package digest no longer matches installed bytes');
    }
    const tool = installed.manifest.tools.find((candidate) => candidate.name === command.tool);
    if (!tool) throw new Error('Capability tool is not declared by the exact installed manifest');
    const active = this.options.store.getActive(command.capabilityId, command.workspaceId);
    if (!active?.enabled || active.version !== command.version || active.digest !== command.digest) {
      throw new Error('Exact capability version is not active for this workspace');
    }

    const grants = this.options.store.list({ identity, ownerId: command.ownerId, workspaceId: command.workspaceId });
    const runtimePermissions = this.options.runtimePermissions ?? ['filesystem.read', 'filesystem.write', 'artifact.create'];
    const permissionDigest = capabilityPermissionDigest({
      identity, ownerId: command.ownerId, workspaceId: command.workspaceId, grants, runtimePermissions,
    });
    const invocationId = `cap_inv_${randomUUID()}`;
    let receipt = this.options.store.createInvocation({
      invocationId, identity, toolName: command.tool,
      jobId: context.jobId, attemptId: context.attemptId, generation: context.generation,
      state: 'admitted', permissionDigest, effectRefs: [], evidenceRefs: [],
      startedAt: Date.now(), terminalAt: null, runtimeMs: null, exitCode: null, exitSignal: null,
      detail: null, fenceToken: context.fenceToken,
      hostInstanceId: this.hostIdentity.instanceId,
      hostPid: this.hostIdentity.pid,
      hostStartTime: this.hostIdentity.startTime,
    });
    receipt = this.options.store.transitionInvocation({
      invocationId, expectedStateVersion: receipt.stateVersion, state: 'starting', detail: 'docker boundary requested',
    });
    const permissionAuthority = new CapabilityPermissionAuthority({
      grants: this.options.store,
      runtimePermissions,
      jobResources: context.engine.resources,
      jobId: context.jobId,
    });
    const broker = new CapabilityBroker({
      invocationId, identity, manifest: installed.manifest,
      ownerId: command.ownerId, workspaceId: command.workspaceId, workspaceRoot: command.workspaceRoot,
      linkage: {
        jobId: context.jobId, attemptId: context.attemptId, generation: context.generation,
        fenceToken: context.fenceToken, producer: context.producer,
      },
      jobAuthority: context.engine,
      permissionAuthority,
      executeTool: command.executeTool,
      listEvidence: () => context.engine.proof.listEvidence(context.jobId),
    });
    receipt = this.options.store.transitionInvocation({
      invocationId, expectedStateVersion: receipt.stateVersion, state: 'running', detail: 'docker boundary active',
    });
    let result: CapabilityProcessResult;
    try {
      result = await this.options.processHost.run({
        manifest: installed.manifest, identity, invocationId, installPath: installed.installPath,
        tool: command.tool, value: command.input, broker,
        signal: context.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refs = broker.authorityRefs();
      const outcome: CapabilityInvocationState = refs.effectIds.length > 0
        ? 'unknown'
        : 'failed';
      receipt = this.options.store.transitionInvocation({
        invocationId, expectedStateVersion: receipt.stateVersion, state: outcome,
        terminalAt: Date.now(), runtimeMs: Date.now() - receipt.startedAt, detail: message,
        effectRefs: refs.effectIds,
        evidenceRefs: refs.evidenceIds,
      });
      const previous = this.options.store.getHealth(identity);
      this.options.store.recordHealth({
        identity, state: message.includes('SANDBOX_UNAVAILABLE') ? 'unavailable' : 'degraded',
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
        lastReason: message, lastCheckedAt: Date.now(), lastInvocationId: invocationId,
      });
      throw error;
    }

    const brokerRefs = broker.authorityRefs();
    if (result.state !== 'completed' && result.state !== 'unknown' && brokerRefs.effectIds.length > 0) {
      result = {
        ...result,
        state: 'unknown',
        output: undefined,
        error: result.error ?? 'Capability ended after a brokered mutation; effect reconciliation is required',
      };
    }

    if (!broker.authorityCurrent()) {
      result = {
        ...result,
        state: tool.mutates || broker.authorityRefs().effectIds.length > 0 ? 'unknown' : 'cancelled',
        output: undefined,
        error: 'Capability result arrived after durable Job Attempt authority was lost',
      };
    }

    const refs = broker.authorityRefs();
    for (const claim of result.claims) {
      context.engine.appendJobEvent({
        jobId: context.jobId, attemptId: context.attemptId, generation: context.generation,
        type: 'capability.claim_observed',
        payload: {
          invocationId, capabilityId: identity.capabilityId, claimId: claim.claimId,
          category: claim.category,
          statementDigest: createHash('sha256').update(claim.statement).digest('hex'),
          authoritative: false,
        },
        producer: context.producer,
        idempotencyKey: `capability-claim:${invocationId}:${claim.claimId}`,
      });
    }
    const terminal = terminalInvocationState(result.state);
    receipt = this.options.store.transitionInvocation({
      invocationId, expectedStateVersion: receipt.stateVersion, state: terminal,
      terminalAt: Date.now(), runtimeMs: result.runtimeMs, exitCode: result.exitCode,
      exitSignal: result.exitSignal, detail: result.error ?? null,
      effectRefs: refs.effectIds, evidenceRefs: refs.evidenceIds,
    });
    const previous = this.options.store.getHealth(identity);
    this.options.store.recordHealth({
      identity, state: terminalHealth(result.state),
      consecutiveFailures: result.state === 'completed' ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
      lastReason: result.error ?? null, lastCheckedAt: Date.now(), lastInvocationId: invocationId,
    });
    if (result.state !== 'completed') {
      return {
        success: false, status: result.state, error: result.error ?? `Capability invocation ${result.state}`,
        invocationId, identity, effectRefs: refs.effectIds, evidenceRefs: refs.evidenceIds,
      };
    }
    return {
      success: true, output: result.output ?? null, invocationId, identity,
      effectRefs: refs.effectIds, evidenceRefs: refs.evidenceIds,
    };
  }
}
