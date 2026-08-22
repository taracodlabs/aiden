/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ToolCallRequest, ToolCallResult } from '../../../providers/v4/types';
import {
  asJsonValue,
  type CapabilityBrokerRequestMessage,
  type CapabilityBrokerResultMessage,
  type CapabilityIdentity,
  type CapabilityManifest,
  type CapabilityPermissionKind,
  type JsonValue,
} from '../../../packages/capability-sdk/src';
import type { CapabilityPermissionAuthority } from './permissionAuthority';

const TERMINAL_JOBS = new Set([
  'cancelled', 'completed', 'failed', 'dead_letter', 'completed_unverified',
  'verification_failed', 'abandoned',
]);
const TERMINAL_ATTEMPTS = new Set([
  'succeeded', 'completed', 'failed', 'cancelled', 'timed_out', 'crashed',
  'unknown', 'interrupted',
]);

export interface CapabilityBrokerJobAuthority {
  getJob(jobId: string): { id: string; status: string; activeAttemptId: string | null } | null;
  getAttempt(attemptId: string): {
    id: string;
    jobId: string | null;
    status: string;
    generation: number;
    fenceToken: string | null;
    leaseExpiresAt: number | null;
  } | null;
}

export interface CapabilityBrokerEvidence {
  evidenceId: string;
  attemptId: string;
  generation: number;
  effectId?: string | null;
}

export type CapabilityBrokerToolExecutor = (call: ToolCallRequest) => Promise<ToolCallResult>;

type Linkage = {
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  producer: string;
};

type CachedResponse = { digest: string; response: CapabilityBrokerResultMessage };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function sameIdentity(left: CapabilityIdentity, right: CapabilityIdentity): boolean {
  return left.capabilityId === right.capabilityId
    && left.version === right.version
    && left.manifestVersion === right.manifestVersion
    && left.protocolVersion === right.protocolVersion
    && left.digest === right.digest;
}

function durableToolCallId(linkage: Linkage, modelCallId: string): string {
  return `tool-call:sha256:${createHash('sha256')
    .update(`${linkage.attemptId}\0${linkage.generation}\0${modelCallId}`)
    .digest('hex')}`;
}

function responseBase(request: CapabilityBrokerRequestMessage): Omit<CapabilityBrokerResultMessage, 'ok'> {
  return {
    type: 'BROKER_RESULT', sequence: request.sequence, invocationId: request.invocationId,
    identity: request.identity, requestId: request.requestId,
  };
}

function failure(
  request: CapabilityBrokerRequestMessage,
  code: string,
  message: string,
): CapabilityBrokerResultMessage {
  return { ...responseBase(request), ok: false, error: { code, message } };
}

function resolveWorkspaceResource(root: string, resource: string): string {
  if (!resource || resource.includes('\0')) throw new Error('resource is empty or invalid');
  return path.isAbsolute(resource) ? path.resolve(resource) : path.resolve(root, resource);
}

function operationPermission(operation: CapabilityBrokerRequestMessage['operation']): CapabilityPermissionKind {
  switch (operation) {
    case 'filesystem.read':
    case 'filesystem.list': return 'filesystem.read';
    case 'filesystem.write': return 'filesystem.write';
    case 'artifact.create': return 'artifact.create';
  }
}

function toolFor(request: CapabilityBrokerRequestMessage, resource: string): ToolCallRequest | null {
  const id = `capability:${request.invocationId}:${request.requestId}`;
  switch (request.operation) {
    case 'filesystem.read': {
      const args: Record<string, unknown> = { path: resource };
      if (Number.isSafeInteger(request.arguments.offset) && Number(request.arguments.offset) >= 0) args.offset = request.arguments.offset;
      if (Number.isSafeInteger(request.arguments.limit) && Number(request.arguments.limit) > 0) args.limit = request.arguments.limit;
      return { id, name: 'file_read', arguments: args };
    }
    case 'filesystem.list':
      return { id, name: 'file_list', arguments: { path: resource } };
    case 'filesystem.write':
      if (typeof request.arguments.content !== 'string') return null;
      return { id, name: 'file_write', arguments: { path: resource, content: request.arguments.content } };
    case 'artifact.create':
      return null;
  }
}

/**
 * Host-owned authority for capability requests. Capability code cannot reach a
 * filesystem, ToolRegistry, JobEngine, or approval object directly; every
 * useful operation is re-admitted here against exact immutable and Attempt
 * identity before it enters the canonical tool executor.
 */
export class CapabilityBroker {
  private readonly completed = new Map<string, CachedResponse>();
  private readonly toolCallRefs = new Set<string>();
  private readonly effectRefs = new Set<string>();
  private readonly evidenceRefs = new Set<string>();
  private requestCount = 0;
  private evidenceReader: () => CapabilityBrokerEvidence[];

  constructor(private readonly options: {
    invocationId: string;
    identity: CapabilityIdentity;
    manifest: CapabilityManifest;
    ownerId: string;
    workspaceId: string;
    workspaceRoot: string;
    linkage: Linkage;
    jobAuthority: CapabilityBrokerJobAuthority;
    permissionAuthority: CapabilityPermissionAuthority;
    executeTool: CapabilityBrokerToolExecutor;
    listEvidence?: () => CapabilityBrokerEvidence[];
  }) {
    this.evidenceReader = options.listEvidence ?? (() => []);
  }

  /** Narrow test/runtime seam used when the proof projection becomes available. */
  setEvidenceReader(reader: () => CapabilityBrokerEvidence[]): void {
    this.evidenceReader = reader;
  }

  authorityRefs(): { toolCallIds: string[]; effectIds: string[]; evidenceIds: string[] } {
    return {
      toolCallIds: [...this.toolCallRefs],
      effectIds: [...this.effectRefs],
      evidenceIds: [...this.evidenceRefs],
    };
  }

  authorityCurrent(): boolean {
    return this.currentAuthority();
  }

  private currentAuthority(): boolean {
    const { linkage } = this.options;
    const job = this.options.jobAuthority.getJob(linkage.jobId);
    const attempt = this.options.jobAuthority.getAttempt(linkage.attemptId);
    return !!job && !!attempt
      && job.id === linkage.jobId
      && job.activeAttemptId === linkage.attemptId
      && !TERMINAL_JOBS.has(job.status)
      && attempt.id === linkage.attemptId
      && attempt.jobId === linkage.jobId
      && attempt.generation === linkage.generation
      && attempt.fenceToken === linkage.fenceToken
      && !TERMINAL_ATTEMPTS.has(attempt.status)
      && (attempt.leaseExpiresAt === null || attempt.leaseExpiresAt > Date.now());
  }

  async handle(request: CapabilityBrokerRequestMessage): Promise<CapabilityBrokerResultMessage> {
    if (request.invocationId !== this.options.invocationId || !sameIdentity(request.identity, this.options.identity)) {
      return failure(request, 'identity_mismatch', 'Capability broker identity does not match the admitted invocation');
    }
    if (!/^request_[A-Za-z0-9_.:-]{1,120}$/u.test(request.requestId)) {
      return failure(request, 'invalid_request', 'Capability broker request identity is invalid');
    }
    const requestDigest = digest({ operation: request.operation, resource: request.resource, arguments: request.arguments });
    const previous = this.completed.get(request.requestId);
    if (previous) {
      return previous.digest === requestDigest
        ? previous.response
        : failure(request, 'request_conflict', 'Broker request identity was reused with different content');
    }
    if (this.requestCount >= this.options.manifest.limits.maxBrokerRequests) {
      return failure(request, 'request_limit', 'Capability broker request limit exceeded');
    }
    this.requestCount += 1;
    if (!this.currentAuthority()) return failure(request, 'stale_authority', 'Capability invocation no longer owns the current Job Attempt');

    let resource: string;
    try { resource = resolveWorkspaceResource(this.options.workspaceRoot, request.resource); }
    catch (error) { return failure(request, 'invalid_request', error instanceof Error ? error.message : String(error)); }
    const decision = this.options.permissionAuthority.authorize({
      identity: this.options.identity,
      manifest: this.options.manifest,
      ownerId: this.options.ownerId,
      workspaceId: this.options.workspaceId,
      workspaceRoot: this.options.workspaceRoot,
      permission: operationPermission(request.operation),
      resource,
    });
    if ('reason' in decision) return failure(request, 'permission_denied', decision.reason);
    const toolCall = toolFor(request, resource);
    if (!toolCall) return failure(request, 'unsupported_operation', 'Broker operation is not enabled by the v4.25 runtime');

    const persistedToolCallId = durableToolCallId(this.options.linkage, toolCall.id);
    const effectId = request.operation === 'filesystem.write' ? `side_effect:${persistedToolCallId}` : undefined;
    let toolResult: ToolCallResult;
    try {
      toolResult = await this.options.executeTool(toolCall);
    } catch (error) {
      return failure(request, 'tool_execution_failed', error instanceof Error ? error.message : String(error));
    }
    if (!this.currentAuthority()) {
      return failure(request, 'stale_authority', 'Capability result arrived after Job Attempt authority was lost');
    }
    if (toolResult.error) return failure(request, 'tool_denied', toolResult.error);
    const inner = toolResult.result && typeof toolResult.result === 'object'
      ? toolResult.result as Record<string, unknown> : null;
    if (inner?.success === false) {
      return failure(request, 'tool_failed', typeof inner.error === 'string' ? inner.error : 'Brokered tool failed');
    }
    let value: JsonValue;
    try { value = asJsonValue(toolResult.result ?? null); }
    catch { return failure(request, 'invalid_tool_result', 'Brokered tool returned a non-JSON result'); }
    const evidenceIds = this.evidenceReader()
      .filter((item) => item.attemptId === this.options.linkage.attemptId
        && item.generation === this.options.linkage.generation
        && (!effectId || item.effectId === effectId))
      .map((item) => item.evidenceId);
    const response: CapabilityBrokerResultMessage = {
      ...responseBase(request), ok: true, value,
      authority: { toolCallId: persistedToolCallId, ...(effectId ? { effectId } : {}), evidenceIds },
    };
    this.toolCallRefs.add(persistedToolCallId);
    if (effectId) this.effectRefs.add(effectId);
    for (const evidenceId of evidenceIds) this.evidenceRefs.add(evidenceId);
    this.completed.set(request.requestId, { digest: requestDigest, response });
    return response;
  }
}
