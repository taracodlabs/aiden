/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * A2A is a read-only external adapter. JobEngine owns local truth; every
 * remote state and artifact is merely an observation until locally verified.
 */

import { createHash } from 'node:crypto';

import type { ArtifactStore } from '../daemon/artifactStore';
import type { JobEngine } from '../daemon/jobEngine';
import {
  DurableJobBudgetExceededError,
  executeDurableJob,
  type DurableJobDisposition,
  type DurableJobHandle,
} from '../daemon/jobLifecycle';
import type {
  ExternalCapabilitySnapshotRecord,
  ExternalIdentityRecord,
  RemoteArtifactRecord,
  RemoteTaskRecord,
} from '../external/externalAuthority';
import {
  A2A_JSONRPC_BINDING,
  A2A_PROTOCOL_VERSION,
  digestA2aValue,
  normalizeA2aAgentCard,
  type NormalizeA2aAgentCardOptions,
  type NormalizedA2aAgentCard,
} from './protocol';
import {
  buildBoundedReadOnlyPayload,
  validateRemoteArtifact,
  type BoundedReadOnlyPayload,
  type RemoteArtifactInput,
} from './security';
import { createA2aArtifactQuarantine, type A2aArtifactQuarantine } from './artifactQuarantine';
import {
  discoverSdkA2aAgentCard,
  type DiscoverSdkA2aAgentCardOptions,
} from './sdkClient';

export interface A2aRemoteArtifactInput extends RemoteArtifactInput {}

export interface A2aRemoteTaskObservation {
  remoteTaskId: string;
  contextId: string | null;
  messageId: string | null;
  state: 'submitted' | 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  eventId: string;
  artifacts: A2aRemoteArtifactInput[];
}

export interface A2aRemoteClient {
  sendReadOnly(input: {
    messageId: string;
    skillId: string;
    payload: BoundedReadOnlyPayload;
    signal?: AbortSignal;
  }): Promise<A2aRemoteTaskObservation>;
  /** Optional v1.0 streaming surface. Local authority processes each event in order. */
  sendReadOnlyStream?(input: {
    messageId: string;
    skillId: string;
    payload: BoundedReadOnlyPayload;
    signal?: AbortSignal;
  }): AsyncIterable<A2aRemoteTaskObservation>;
  getTask(input: {
    remoteTaskId: string;
    contextId?: string | null;
    messageId?: string | null;
    signal?: AbortSignal;
  }): Promise<A2aRemoteTaskObservation>;
  cancelTask(input: {
    remoteTaskId: string;
    contextId?: string | null;
    messageId?: string | null;
    reason: string;
    signal?: AbortSignal;
  }): Promise<A2aRemoteTaskObservation>;
}

export interface A2aVerificationResult {
  ok: boolean;
  verificationId: string;
  evidenceIds: string[];
}

export type A2aVerifier = (input: {
  remoteTask: RemoteTaskRecord;
  artifacts: RemoteArtifactRecord[];
}) => A2aVerificationResult | Promise<A2aVerificationResult>;

export interface A2aRuntimeOptions {
  engine: JobEngine;
  ownerId: string;
  /** Current daemon identity used for restart recovery Attempts. */
  instanceId?: string;
  clientFactory: (card: NormalizedA2aAgentCard) => A2aRemoteClient | Promise<A2aRemoteClient>;
  quarantine?: A2aArtifactQuarantine;
  /** Network policy for v1.0 Agent Card discovery. */
  agentCardDiscovery?: Omit<DiscoverSdkA2aAgentCardOptions, 'allowLoopbackHttp'>;
  /** Controlled local conformance fixtures only. */
  allowLoopbackHttp?: boolean;
}

export interface DiscoveredA2aAgent extends ExternalIdentityRecord {
  card: NormalizedA2aAgentCard;
  capabilitySnapshot: ExternalCapabilitySnapshotRecord;
}

export interface DelegateReadOnlyInput {
  parentJobId: string;
  sessionId: string;
  instanceId: string;
  externalIdentityId: string;
  skillId: string;
  objective: string;
  data: unknown;
  idempotencyKey: string;
  requestedCapabilities?: string[];
  maxInputBytes?: number;
  maxArtifactBytes?: number;
  /** Total bytes accepted from all remote artifacts for this delegation. */
  maxOutputBytes?: number;
  /** Maximum durable status observations accepted from one remote stream. */
  maxStreamEvents?: number;
  maxRuntimeMs?: number;
  verify: A2aVerifier;
}

export interface A2aDelegationResult {
  childJobId: string;
  remoteTask: RemoteTaskRecord;
  artifacts: RemoteArtifactRecord[];
}

interface ProcessedObservation {
  remoteTask: RemoteTaskRecord;
  artifacts: RemoteArtifactRecord[];
  disposition: DurableJobDisposition;
  observedOutputBytes: number;
}

function digest(value: unknown): string {
  return digestA2aValue(value);
}

function remoteState(state: A2aRemoteTaskObservation['state']):
  'working' | 'input_required' | 'completed_observed' | 'failed_observed' | 'cancelled_observed' | 'unknown' | null {
  switch (state) {
    case 'submitted': return null;
    case 'working': return 'working';
    case 'input_required': return 'input_required';
    case 'completed': return 'completed_observed';
    case 'failed': return 'failed_observed';
    case 'cancelled': return 'cancelled_observed';
    default: return 'unknown';
  }
}

function authority(handle: DurableJobHandle) {
  return {
    localAttemptId: handle.attemptId,
    localGeneration: handle.generation,
    localFenceToken: handle.fenceToken,
  };
}

function dispositionFor(state: RemoteTaskRecord['state'], verified: boolean): DurableJobDisposition {
  if (verified) return {
    status: 'completed',
    outcome: 'verified',
    finishReason: 'A2A result independently verified',
    evidence: { localVerification: true },
  };
  if (state === 'failed_observed' || state === 'rejected') return {
    status: 'blocked', outcome: 'remote_failure_observed', finishReason: 'Remote A2A task reported failure; local goal remains unverified',
    evidence: { remoteState: state, authoritativeCompletion: false },
  };
  if (state === 'cancelled_observed') return {
    status: 'cancelled', outcome: 'cancelled', finishReason: 'Remote A2A task cancelled',
    evidence: { remoteState: state, authoritativeCompletion: false },
  };
  if (state === 'completed_observed') return {
    status: 'blocked', outcome: 'unverified_remote_completion',
    finishReason: 'Remote completion did not pass local verification',
    evidence: { remoteState: state, authoritativeCompletion: false },
  };
  if (state === 'input_required') return {
    status: 'blocked', outcome: 'remote_input_required',
    finishReason: 'Remote A2A task requires input',
    evidence: { remoteState: state, authoritativeCompletion: false },
  };
  return {
    status: 'unknown', outcome: 'remote_outcome_unknown',
    finishReason: 'Remote A2A task remains nonterminal or unavailable',
    evidence: { remoteState: state, authoritativeCompletion: false },
  };
}

export function createA2aRuntime(options: A2aRuntimeOptions) {
  const { engine } = options;
  const quarantine = options.quarantine ?? createA2aArtifactQuarantine();
  const cards = new Map<string, NormalizedA2aAgentCard>();
  const instancesByJob = new Map<string, string>();

  const cardFor = (externalIdentityId: string, capabilitySnapshotId?: string): NormalizedA2aAgentCard => {
    const snapshot = capabilitySnapshotId
      ? engine.external.getCapabilities(capabilitySnapshotId)
      : engine.external.latestCapabilities(externalIdentityId);
    if (!snapshot || snapshot.externalIdentityId !== externalIdentityId) {
      throw new Error('Trusted A2A capability snapshot is unavailable');
    }
    const cached = cards.get(snapshot.capabilitySnapshotId);
    if (cached) return cached;
    const raw = snapshot?.capabilities.agentCard;
    if (!raw) throw new Error('Trusted A2A Agent Card is unavailable');
    const identity = engine.external.getIdentity(externalIdentityId);
    const card = normalizeA2aAgentCard(raw, {
      allowLoopbackHttp: options.allowLoopbackHttp === true,
      ...(identity?.trustState === 'verified_key' && identity.trustedIdentityKeyDigest
        ? { verifiedIdentityKeyDigest: identity.trustedIdentityKeyDigest }
        : {}),
    });
    cards.set(snapshot.capabilitySnapshotId, card);
    return card;
  };

  const ensureClaim = (handle: DurableJobHandle, objective: string) => {
    const existing = engine.proof.listClaims(handle.jobId).find((claim) => claim.required);
    return existing ?? engine.proof.createClaim({
      jobId: handle.jobId,
      attemptId: handle.attemptId,
      generation: handle.generation,
      category: 'contract',
      statement: `Locally verify the delegated A2A result: ${objective.slice(0, 512)}`,
      required: true,
      requiredEvidenceCategories: ['a2a.local_verification'],
    });
  };

  const recordArtifacts = (
    task: RemoteTaskRecord,
    handle: DurableJobHandle,
    observed: A2aRemoteArtifactInput[],
    maxArtifactBytes: number | undefined,
    maxOutputBytes: number,
  ): RemoteArtifactRecord[] => {
    const existing = new Map(engine.external.listRemoteArtifacts(task.remoteTaskRecordId)
      .map((artifact) => [artifact.remoteArtifactKey, artifact] as const));
    const validations = observed.map((artifact) => ({
      artifact,
      validation: validateRemoteArtifact(artifact, { maxBytes: maxArtifactBytes }),
    }));
    const existingBytes = [...existing.values()].reduce((total, artifact) => total + artifact.byteLength, 0);
    const newBytes = validations.reduce((total, item) => existing.has(item.validation.artifactKey)
      ? total : total + item.validation.byteLength, 0);
    const aggregateExceeded = existingBytes + newBytes > maxOutputBytes;
    return validations.map(({ artifact, validation }) => {
    const accepted = validation.accepted && !aggregateExceeded;
    const rejectionReason = aggregateExceeded && validation.accepted
      ? `aggregate remote artifact output exceeds ${maxOutputBytes} bytes`
      : 'reason' in validation ? validation.reason : null;
    const record = engine.external.recordRemoteArtifact({
      ...authority(handle),
      remoteTaskRecordId: task.remoteTaskRecordId,
      remoteArtifactKey: validation.artifactKey,
      declaredName: artifact.name,
      declaredMediaType: artifact.mediaType ?? null,
      detectedMediaType: accepted ? validation.detectedMediaType : null,
      byteLength: validation.byteLength,
      contentDigest: validation.contentDigest,
      quarantineState: accepted ? 'quarantined' : 'rejected',
      rejectionReason,
      metadata: accepted ? { untrustedText: validation.untrustedText } : {},
    });
    if (accepted) quarantine.put(record.remoteArtifactId, record.contentDigest, validation.bytes);
    return record;
  });
  };

  const processObservation = async (input: {
    task: RemoteTaskRecord;
    observation: A2aRemoteTaskObservation;
    handle: DurableJobHandle;
    objective: string;
    maxArtifactBytes?: number;
    maxOutputBytes: number;
    verify?: A2aVerifier;
  }): Promise<ProcessedObservation> => {
    let task = input.task;
    const identity = engine.external.getIdentity(task.externalIdentityId);
    if (!identity || !['verified_endpoint', 'verified_key'].includes(identity.trustState)) {
      task = engine.external.markRemoteIdentityChanged({
        ...authority(input.handle), remoteTaskRecordId: task.remoteTaskRecordId,
        expectedStateVersion: task.stateVersion,
        identityStateVersion: identity?.stateVersion ?? 0,
        identityKeyDigest: identity?.observedIdentityKeyDigest ?? null,
      });
      return {
        remoteTask: task,
        artifacts: engine.external.listRemoteArtifacts(task.remoteTaskRecordId),
        disposition: dispositionFor(task.state, false),
        observedOutputBytes: 0,
      };
    }
    recordArtifacts(task, input.handle, input.observation.artifacts, input.maxArtifactBytes, input.maxOutputBytes);
    const artifacts = engine.external.listRemoteArtifacts(task.remoteTaskRecordId);
    const observedOutputBytes = artifacts.reduce((total, artifact) => total + artifact.byteLength, 0);
    const mapped = remoteState(input.observation.state);
    if (mapped) {
      task = engine.external.observeRemoteState({
        ...authority(input.handle),
        remoteTaskRecordId: task.remoteTaskRecordId,
        expectedStateVersion: task.stateVersion,
        state: mapped,
        remoteEventId: input.observation.eventId,
        payloadDigest: digest({
          remoteTaskId: input.observation.remoteTaskId,
          contextId: input.observation.contextId,
          state: input.observation.state,
          artifacts: artifacts.map((artifact) => ({ id: artifact.remoteArtifactId, digest: artifact.contentDigest })),
        }),
      });
    }

    let verified = false;
    if (task.state === 'completed_observed') {
      const allSafe = artifacts.length > 0 && artifacts.every((artifact) => artifact.quarantineState === 'quarantined');
      const result = allSafe && input.verify
        ? await input.verify({ remoteTask: task, artifacts })
        : { ok: false, verificationId: 'a2a-local-validation-failed', evidenceIds: [] };
      const claim = ensureClaim(input.handle, input.objective);
      const evidence = engine.proof.recordEvidence({
        jobId: input.handle.jobId,
        attemptId: input.handle.attemptId,
        generation: input.handle.generation,
        fenceToken: input.handle.fenceToken,
        source: 'a2a.local_verification',
        producer: options.ownerId,
        observedAt: Date.now(),
        coverage: 'full',
        verificationResult: result.ok ? 'verified' : 'failed',
        payload: {
          externalIdentityId: task.externalIdentityId,
          capabilityDigest: task.capabilityDigest,
          remoteTaskRecordId: task.remoteTaskRecordId,
          remoteTaskId: task.remoteTaskId,
          requestDigest: task.requestDigest,
          artifactDigests: artifacts.map((artifact) => artifact.contentDigest),
          artifactValidationPassed: allSafe,
          verifierAccepted: result.ok,
        },
      });
      engine.proof.checkClaim({
        claimId: claim.claimId,
        attemptId: input.handle.attemptId,
        generation: input.handle.generation,
        evidenceIds: [evidence.evidenceId],
        state: result.ok ? 'verified' : 'failed',
      });
      if (result.ok) {
        task = engine.external.markLocallyVerified({
          ...authority(input.handle),
          remoteTaskRecordId: task.remoteTaskRecordId,
          expectedStateVersion: task.stateVersion,
          verificationId: result.verificationId,
          evidenceIds: [evidence.evidenceId],
        });
        verified = true;
      }
    }
    return { remoteTask: task, artifacts, disposition: dispositionFor(task.state, verified), observedOutputBytes };
  };

  const persistAgent = (card: NormalizedA2aAgentCard): DiscoveredA2aAgent => {
    const identity = engine.external.observeIdentity({
      kind: 'a2a', endpoint: card.endpoint, displayName: card.name,
      identityKeyDigest: card.identityKeyDigest,
    });
    const readCapabilities = card.skills.map((skill) => ({
      id: skill.id, inputModes: skill.inputModes, outputModes: skill.outputModes,
    }));
    const capabilities = {
      agentCard: card.raw,
      binding: card.binding,
      protocolVersion: card.protocolVersion,
      streaming: card.streaming,
      pushNotifications: card.pushNotifications,
      skills: readCapabilities,
      mutationEnabled: false,
    };
    const capabilitySnapshot = engine.external.recordCapabilities({
      externalIdentityId: identity.externalIdentityId,
      protocol: 'a2a',
      protocolVersion: A2A_PROTOCOL_VERSION,
      capabilityDigest: digest(capabilities),
      readCapabilityDigest: digest(readCapabilities),
      mutationCapabilityDigest: digest([]),
      capabilities,
      idempotencyKey: `a2a-agent-card:${card.cardDigest}`,
    });
    cards.set(capabilitySnapshot.capabilitySnapshotId, card);
    return { ...identity, card, capabilitySnapshot };
  };

  const discoverAgent = (
    value: unknown,
    normalizeOptions: NormalizeA2aAgentCardOptions = {},
  ): DiscoveredA2aAgent => persistAgent(normalizeA2aAgentCard(value, {
    allowLoopbackHttp: options.allowLoopbackHttp === true || normalizeOptions.allowLoopbackHttp === true,
    ...(normalizeOptions.verifiedIdentityKeyDigest
      ? { verifiedIdentityKeyDigest: normalizeOptions.verifiedIdentityKeyDigest }
      : {}),
  }));

  const discoverAgentFromUrl = async (baseUrl: string): Promise<DiscoveredA2aAgent> => {
    const card = await discoverSdkA2aAgentCard(baseUrl, {
      ...options.agentCardDiscovery,
      allowLoopbackHttp: options.allowLoopbackHttp === true,
    });
    return persistAgent(card);
  };

  const trustAgentEndpoint = (externalIdentityId: string): ExternalIdentityRecord => {
    const current = engine.external.getIdentity(externalIdentityId);
    if (!current || current.kind !== 'a2a') throw new Error('A2A external identity not found');
    const trusted = engine.external.setTrust({
      externalIdentityId,
      expectedStateVersion: current.stateVersion,
      to: current.observedIdentityKeyDigest ? 'verified_key' : 'verified_endpoint',
      ...(current.observedIdentityKeyDigest ? { expectedIdentityKeyDigest: current.observedIdentityKeyDigest } : {}),
    });
    const latest = engine.external.latestCapabilities(externalIdentityId);
    if (!latest) throw new Error('A2A capability snapshot not found');
    if (latest.reviewRequired) engine.external.acceptCapabilities({
      capabilitySnapshotId: latest.capabilitySnapshotId,
      expectedStateVersion: latest.stateVersion,
      acceptedBy: options.ownerId,
    });
    return trusted;
  };

  const delegateReadOnly = async (input: DelegateReadOnlyInput): Promise<A2aDelegationResult> => {
    const existing = engine.external.findRemoteTaskByIdempotency(input.externalIdentityId, input.idempotencyKey);
    if (existing) return {
      childJobId: existing.localJobId,
      remoteTask: existing,
      artifacts: engine.external.listRemoteArtifacts(existing.remoteTaskRecordId),
    };
    const identity = engine.external.getIdentity(input.externalIdentityId);
    if (!identity || !['verified_endpoint', 'verified_key'].includes(identity.trustState)) {
      throw new Error('A2A agent identity must be explicitly trusted');
    }
    const capability = engine.external.latestCapabilities(input.externalIdentityId);
    if (!capability || capability.reviewRequired || capability.acceptedAt === null) {
      throw new Error('A2A capability snapshot requires review');
    }
    const card = cardFor(input.externalIdentityId, capability.capabilitySnapshotId);
    if (!card.skills.some((skill) => skill.id === input.skillId)) throw new Error('Requested A2A skill is not advertised');
    const payload = buildBoundedReadOnlyPayload({
      objective: input.objective,
      data: input.data,
      requestedCapabilities: input.requestedCapabilities ?? ['read:structured-input'],
      maxBytes: input.maxInputBytes,
    });
    const maxOutputBytes = input.maxOutputBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('A2A output byte budget is invalid');
    const maxStreamEvents = input.maxStreamEvents ?? 10_000;
    if (!Number.isSafeInteger(maxStreamEvents) || maxStreamEvents < 1) {
      throw new Error('A2A stream event budget is invalid');
    }
    const requestDigest = digest({
      externalIdentityId: input.externalIdentityId,
      capabilityDigest: capability.capabilityDigest,
      skillId: input.skillId,
      payload: payload.serialized,
    });
    const admission = engine.submitJob({
      entryPoint: 'a2a',
      source: 'a2a.read_only',
      sessionId: input.sessionId,
      instanceId: input.instanceId,
      idempotencyNamespace: `a2a:${input.externalIdentityId}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: requestDigest,
      goal: input.objective,
      parentJobId: input.parentJobId,
      rootJobId: engine.getJob(input.parentJobId)?.rootJobId ?? input.parentJobId,
      childContract: {
        required: true,
        workerId: `a2a:${input.externalIdentityId}`,
        capabilities: payload.capabilities,
        allowedResources: { endpoint: card.endpoint, skillId: input.skillId, mutationAllowed: false },
        budget: {
          requests: 1, inputBytes: payload.byteLength,
          maxArtifactBytes: input.maxArtifactBytes ?? null, maxOutputBytes,
        },
      },
      resourcePolicy: {
        budgets: {
          tool_calls: 1,
          output_bytes: maxOutputBytes,
          ...(input.maxRuntimeMs ? { runtime_ms: input.maxRuntimeMs } : {}),
        },
        capabilities: { hosts: [new URL(card.endpoint).hostname], workers: [`a2a:${input.externalIdentityId}`] },
      },
    });
    const messageId = `a2a_message_${createHash('sha256').update(`${input.externalIdentityId}\0${input.idempotencyKey}\0${requestDigest}`).digest('hex').slice(0, 32)}`;
    instancesByJob.set(admission.jobId, input.instanceId);
    let execution;
    try {
      execution = await executeDurableJob<ProcessedObservation>({
      engine,
      ownerId: options.ownerId,
      admission: { existing: admission, source: 'a2a.read_only' },
      execute: async (handle) => {
        let task = engine.external.admitRemoteTask({
          ...authority(handle),
          localJobId: handle.jobId,
          parentJobId: input.parentJobId,
          externalIdentityId: input.externalIdentityId,
          capabilitySnapshotId: capability.capabilitySnapshotId,
          capabilityDigest: capability.capabilityDigest,
          protocolVersion: A2A_PROTOCOL_VERSION,
          binding: A2A_JSONRPC_BINDING,
          requestDigest,
          idempotencyKey: input.idempotencyKey,
        });
        task = engine.external.markRemoteSending({
          ...authority(handle), remoteTaskRecordId: task.remoteTaskRecordId,
          expectedStateVersion: task.stateVersion,
        });
        engine.resources.debit({
          jobId: handle.jobId, attemptId: handle.attemptId, generation: handle.generation,
          fenceToken: handle.fenceToken, kind: 'tool_calls', amount: 1, certainty: 'confirmed',
          idempotencyKey: `a2a-send:${task.remoteTaskRecordId}`, enforceLimit: true,
        });
        let observed: A2aRemoteTaskObservation;
        try {
          const client = await options.clientFactory(card);
          if (card.streaming && client.sendReadOnlyStream) {
            let processed: ProcessedObservation | null = null;
            let eventCount = 0;
            for await (const event of client.sendReadOnlyStream({
              messageId, skillId: input.skillId, payload, signal: handle.signal,
            })) {
              eventCount += 1;
              if (eventCount > maxStreamEvents) throw new Error('A2A status stream exceeded the bounded event limit');
              if (!event.remoteTaskId) throw new Error('A2A stream did not provide a remote Task identity');
              if (!task.remoteTaskId) {
                task = engine.external.bindRemoteIdentity({
                  ...authority(handle), remoteTaskRecordId: task.remoteTaskRecordId,
                  expectedStateVersion: task.stateVersion,
                  remoteTaskId: event.remoteTaskId,
                  remoteContextId: event.contextId,
                  remoteMessageId: event.messageId ?? messageId,
                });
              } else if (task.remoteTaskId !== event.remoteTaskId) {
                throw new Error('A2A stream changed its remote Task identity');
              }
              processed = await processObservation({
                task, observation: event, handle, objective: input.objective,
                maxArtifactBytes: input.maxArtifactBytes, maxOutputBytes, verify: input.verify,
              });
              task = processed.remoteTask;
              if (['verified', 'failed_observed', 'cancelled_observed', 'completed_observed'].includes(task.state)) break;
            }
            if (!processed) throw new Error('A2A status stream ended before establishing a remote Task');
            engine.resources.debit({
              jobId: handle.jobId, attemptId: handle.attemptId, generation: handle.generation,
              fenceToken: handle.fenceToken, kind: 'output_bytes', amount: processed.observedOutputBytes, certainty: 'confirmed',
              idempotencyKey: `a2a-output:${task.remoteTaskRecordId}`, enforceLimit: true,
            });
            return processed;
          }
          observed = await client.sendReadOnly({ messageId, skillId: input.skillId, payload, signal: handle.signal });
        } catch (error) {
          const latest = engine.external.getRemoteTask(task.remoteTaskRecordId);
          const localStatus = engine.getJob(handle.jobId)?.status;
          if ((localStatus === 'cancelling' || localStatus === 'cancelled') && latest) {
            return {
              remoteTask: latest,
              artifacts: engine.external.listRemoteArtifacts(latest.remoteTaskRecordId),
              disposition: dispositionFor(latest.state, latest.locallyVerified),
              observedOutputBytes: 0,
            };
          }
          task = engine.external.observeRemoteState({
            ...authority(handle), remoteTaskRecordId: task.remoteTaskRecordId,
            expectedStateVersion: task.stateVersion, state: 'unknown',
            remoteEventId: `send-unknown:${messageId}`,
            payloadDigest: digest({ errorClass: error instanceof Error ? error.name : 'Error' }),
          });
          return { remoteTask: task, artifacts: [], disposition: dispositionFor(task.state, false), observedOutputBytes: 0 };
        }
        if (!observed.remoteTaskId) throw new Error('A2A response did not provide a remote Task identity');
        task = engine.external.bindRemoteIdentity({
          ...authority(handle), remoteTaskRecordId: task.remoteTaskRecordId,
          expectedStateVersion: task.stateVersion,
          remoteTaskId: observed.remoteTaskId,
          remoteContextId: observed.contextId,
          remoteMessageId: observed.messageId ?? messageId,
        });
        const processed = await processObservation({
          task, observation: observed, handle, objective: input.objective,
          maxArtifactBytes: input.maxArtifactBytes, maxOutputBytes, verify: input.verify,
        });
        engine.resources.debit({
          jobId: handle.jobId, attemptId: handle.attemptId, generation: handle.generation,
          fenceToken: handle.fenceToken, kind: 'output_bytes', amount: processed.observedOutputBytes, certainty: 'confirmed',
          idempotencyKey: `a2a-output:${task.remoteTaskRecordId}`, enforceLimit: true,
        });
        return processed;
      },
      finalize: (value) => value.disposition,
      classifyError: (error) => error instanceof DurableJobBudgetExceededError
        ? {
            status: 'unknown',
            outcome: 'remote_runtime_budget_exhausted',
            finishReason: 'The remote execution deadline elapsed after network authority may have crossed the boundary',
            evidence: { errorClass: error.name },
          }
        : {
            status: 'failed',
            outcome: 'local_adapter_failure',
            finishReason: 'A2A local adapter failed',
            evidence: { errorClass: error instanceof Error ? error.name : 'Error' },
          },
      });
    } catch (error) {
      if (!(error instanceof DurableJobBudgetExceededError)) throw error;
      const timedOut = engine.external.findRemoteTaskByIdempotency(input.externalIdentityId, input.idempotencyKey);
      if (!timedOut) throw error;
      return {
        childJobId: timedOut.localJobId,
        remoteTask: timedOut,
        artifacts: engine.external.listRemoteArtifacts(timedOut.remoteTaskRecordId),
      };
    }
    return {
      childJobId: execution.jobId,
      remoteTask: execution.value.remoteTask,
      artifacts: execution.value.artifacts,
    };
  };

  const reconcile = async (remoteTaskRecordId: string, verify?: A2aVerifier): Promise<RemoteTaskRecord> => {
    const existing = engine.external.getRemoteTask(remoteTaskRecordId);
    if (!existing) throw new Error('RemoteTask not found');
    if (!existing.remoteTaskId) return existing;
    const previous = engine.getAttempt(existing.localAttemptId);
    if (!previous) throw new Error('RemoteTask local Attempt not found');
    const localJob = engine.getJob(existing.localJobId);
    if (localJob?.status === 'cancelled') {
      if (!previous.fenceToken || previous.generation !== existing.localGeneration) {
        throw new Error('Cancelled A2A reconciliation lineage is unavailable');
      }
      const card = cardFor(existing.externalIdentityId, existing.capabilitySnapshotId);
      const client = await options.clientFactory(card);
      const observed = await client.getTask({
        remoteTaskId: existing.remoteTaskId,
        contextId: existing.remoteContextId,
        messageId: existing.remoteMessageId,
      });
      const mapped = remoteState(observed.state) ?? 'unknown';
      return engine.external.observeRemoteState({
        localAttemptId: existing.localAttemptId,
        localGeneration: existing.localGeneration,
        localFenceToken: previous.fenceToken,
        remoteTaskRecordId,
        expectedStateVersion: existing.stateVersion,
        state: mapped,
        remoteEventId: observed.eventId,
        payloadDigest: digest({ remoteTaskId: observed.remoteTaskId, state: observed.state, cancelledLocalJob: true }),
      });
    }
    const execution = await executeDurableJob<ProcessedObservation>({
      engine,
      ownerId: options.ownerId,
      admission: {
        recovery: {
          jobId: existing.localJobId,
          recoveryOfAttemptId: previous.id,
          instanceId: options.instanceId ?? instancesByJob.get(existing.localJobId)
            ?? (() => { throw new Error('A2A reconciliation requires the current daemon instance identity'); })(),
          triggerReason: 'a2a_remote_reconciliation',
          eventIdempotencyKey: `a2a-recovery:${remoteTaskRecordId}:${previous.generation + 1}`,
          producer: 'a2a.reconciliation',
        },
        source: 'a2a.reconciliation',
      },
      execute: async (handle) => {
        let task = engine.external.rebindRemoteTask({
          ...authority(handle), localJobId: handle.jobId,
          remoteTaskRecordId, expectedStateVersion: existing.stateVersion,
        });
        const card = cardFor(task.externalIdentityId, task.capabilitySnapshotId);
        const client = await options.clientFactory(card);
        const observed = await client.getTask({
          remoteTaskId: task.remoteTaskId!, contextId: task.remoteContextId,
          messageId: task.remoteMessageId, signal: handle.signal,
        });
        return processObservation({
          task, observation: observed, handle,
          objective: engine.getJob(handle.jobId)?.goal ?? 'Reconcile A2A task', verify,
          maxOutputBytes: engine.resources.getBudgets(handle.jobId)
            .find((budget) => budget.kind === 'output_bytes')?.limit ?? 4 * 1024 * 1024,
        });
      },
      finalize: (value) => value.disposition,
      classifyError: (error) => ({
        status: 'unknown', outcome: 'reconciliation_unavailable',
        finishReason: 'Remote A2A reconciliation did not establish final truth',
        evidence: { errorClass: error instanceof Error ? error.name : 'Error' },
      }),
    });
    return execution.value.remoteTask;
  };

  const cancel = async (remoteTaskRecordId: string, reason: string): Promise<RemoteTaskRecord> => {
    let task = engine.external.getRemoteTask(remoteTaskRecordId);
    if (!task) throw new Error('RemoteTask not found');
    if (!task.remoteTaskId) throw new Error('RemoteTask has no queryable remote identity');
    const attempt = engine.getAttempt(task.localAttemptId);
    if (!attempt?.fenceToken || attempt.generation !== task.localGeneration) {
      throw new Error('RemoteTask cancellation lineage is unavailable');
    }
    const cancelled = engine.cancelJob({
      jobId: task.localJobId,
      reason,
      producer: 'a2a.cancel',
      eventIdempotencyKey: `a2a-local-cancel:${remoteTaskRecordId}`,
    });
    if (!cancelled.applied && !cancelled.duplicate && cancelled.conflict !== 'terminal_state') {
      throw new Error(`Local A2A child Job cancellation failed: ${cancelled.conflict ?? 'unknown'}`);
    }
    task = engine.external.requestRemoteCancellation({
      localAttemptId: task.localAttemptId,
      localGeneration: task.localGeneration,
      localFenceToken: attempt.fenceToken,
      remoteTaskRecordId,
      expectedStateVersion: task.stateVersion,
    });
    const card = cardFor(task.externalIdentityId, task.capabilitySnapshotId);
    const client = await options.clientFactory(card);
    const observed = await client.cancelTask({
      remoteTaskId: task.remoteTaskId!, contextId: task.remoteContextId,
      messageId: task.remoteMessageId, reason,
    });
    const mapped = remoteState(observed.state) ?? 'unknown';
    return engine.external.observeRemoteState({
      localAttemptId: task.localAttemptId,
      localGeneration: task.localGeneration,
      localFenceToken: attempt.fenceToken,
      remoteTaskRecordId,
      expectedStateVersion: task.stateVersion,
      state: mapped,
      remoteEventId: observed.eventId,
      payloadDigest: digest({ remoteTaskId: observed.remoteTaskId, state: observed.state }),
    });
  };

  const releaseArtifact = (input: {
    remoteArtifactId: string;
    artifactStore: ArtifactStore;
    sessionId: string;
    runId?: number | null;
    taskId?: string | null;
  }): RemoteArtifactRecord => {
    const record = engine.external.getRemoteArtifact(input.remoteArtifactId);
    if (!record) throw new Error('Remote artifact not found');
    if (record.quarantineState !== 'quarantined') throw new Error('Remote artifact is not releasable');
    const remoteTask = engine.external.getRemoteTask(record.remoteTaskRecordId);
    if (!remoteTask) throw new Error('Remote artifact task lineage is unavailable');
    if (!remoteTask.locallyVerified || remoteTask.state !== 'verified' || remoteTask.evidenceIds.length === 0) {
      throw new Error('Remote artifact cannot be released until its RemoteTask is locally verified');
    }
    const bytes = quarantine.read(record.remoteArtifactId, record.contentDigest);
    const artifactId = input.artifactStore.createFromVerifiedContent({
      artifactId: `art_remote_${createHash('sha256').update(record.remoteArtifactId).digest('hex').slice(0, 24)}`,
      path: record.declaredName,
      kind: 'file',
      tool: 'a2a_remote_artifact',
      action: 'create',
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      taskId: input.taskId ?? remoteTask.localJobId,
      bytes,
      preview: null,
    });
    const released = engine.external.releaseRemoteArtifact({
      remoteArtifactId: record.remoteArtifactId,
      expectedStateVersion: record.stateVersion,
      artifactId,
    });
    quarantine.remove(record.remoteArtifactId, record.contentDigest);
    return released;
  };

  return {
    discoverAgent,
    discoverAgentFromUrl,
    trustAgentEndpoint,
    delegateReadOnly,
    reconcile,
    cancel,
    releaseArtifact,
  };
}
