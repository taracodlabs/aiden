/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Narrow A2A v1.0 JSON-RPC client adapter. The official SDK owns wire
 * encoding; local lifecycle and trust remain outside this module.
 */

import {
  AgentCard,
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';

import {
  digestA2aValue,
  normalizeA2aAgentCard,
  validateA2aEndpoint,
  type NormalizedA2aAgentCard,
} from './protocol';
import type {
  A2aRemoteArtifactInput,
  A2aRemoteClient,
  A2aRemoteTaskObservation,
} from './runtime';
import { SSRFProtection } from '../../../moat/ssrfProtection';

function stateOf(task: Task): A2aRemoteTaskObservation['state'] {
  return stateFromTaskState(task.status?.state);
}

function stateFromTaskState(state: TaskState | undefined): A2aRemoteTaskObservation['state'] {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED: return 'submitted';
    case TaskState.TASK_STATE_WORKING: return 'working';
    case TaskState.TASK_STATE_COMPLETED: return 'completed';
    case TaskState.TASK_STATE_FAILED:
    case TaskState.TASK_STATE_REJECTED: return 'failed';
    case TaskState.TASK_STATE_CANCELED: return 'cancelled';
    case TaskState.TASK_STATE_INPUT_REQUIRED:
    case TaskState.TASK_STATE_AUTH_REQUIRED: return 'input_required';
    default: return 'unknown';
  }
}

function safePartName(artifact: Artifact, part: Part, index: number): string {
  const preferred = part.filename || artifact.name || `${artifact.artifactId}.txt`;
  if (artifact.parts.length === 1) return preferred;
  const dot = preferred.lastIndexOf('.');
  return dot > 0
    ? `${preferred.slice(0, dot)}-${index + 1}${preferred.slice(dot)}`
    : `${preferred}-${index + 1}`;
}

function partArtifact(artifact: Artifact, part: Part, index: number): A2aRemoteArtifactInput {
  const content = part.content;
  if (!content) throw new Error('A2A artifact contains an empty part');
  let bytes: Buffer;
  let mediaType = part.mediaType || null;
  switch (content.$case) {
    case 'text':
      bytes = Buffer.from(content.value, 'utf8');
      mediaType ||= 'text/plain';
      break;
    case 'data':
      bytes = Buffer.from(JSON.stringify(content.value), 'utf8');
      mediaType ||= 'application/json';
      break;
    case 'raw':
      bytes = Buffer.from(content.value);
      break;
    case 'url':
      throw new Error('A2A URL artifacts are not fetched automatically');
  }
  return {
    artifactKey: artifact.parts.length === 1 ? artifact.artifactId : `${artifact.artifactId}:${index}`,
    name: safePartName(artifact, part, index),
    mediaType,
    bytes,
  };
}

interface A2aProjectionLimits {
  maxArtifacts: number;
  maxArtifactParts: number;
}

function artifactsOf(task: Task, limits: A2aProjectionLimits): A2aRemoteArtifactInput[] {
  if (task.artifacts.length > limits.maxArtifacts) {
    throw new Error(`A2A artifact count exceeds the bounded limit of ${limits.maxArtifacts}`);
  }
  const totalParts = task.artifacts.reduce((total, artifact) => total + artifact.parts.length, 0);
  if (totalParts > limits.maxArtifactParts) {
    throw new Error(`A2A artifact part count exceeds the bounded limit of ${limits.maxArtifactParts}`);
  }
  return task.artifacts.flatMap((artifact) => artifact.parts.map((part, index) => partArtifact(artifact, part, index)));
}

function observation(
  task: Task,
  messageId: string,
  source: string,
  limits: A2aProjectionLimits,
): A2aRemoteTaskObservation {
  const artifacts = artifactsOf(task, limits);
  return {
    remoteTaskId: task.id,
    contextId: task.contextId || null,
    messageId,
    state: stateOf(task),
    eventId: `a2a_${digestA2aValue({ source, taskId: task.id, status: task.status, artifacts: artifacts.map((item) => ({
      key: item.artifactKey,
      bytes: item.bytes.byteLength,
    })) }).slice(0, 40)}`,
    artifacts,
  };
}

function requireTask(result: Message | Task, messageId: string): Task {
  if ('status' in result && 'artifacts' in result) return result;
  throw new Error(`A2A message ${messageId} did not establish a queryable remote Task`);
}

export interface CreateSdkA2aRemoteClientOptions {
  fetchImpl?: typeof fetch;
  ssrfProtection?: Pick<SSRFProtection, 'check'>;
  /** Controlled local conformance fixtures only. */
  allowLoopbackHttp?: boolean;
  maxResponseBytes?: number;
  maxArtifacts?: number;
  maxArtifactParts?: number;
}

export interface DiscoverSdkA2aAgentCardOptions {
  fetchImpl?: typeof fetch;
  ssrfProtection?: Pick<SSRFProtection, 'check'>;
  /** Controlled local conformance fixtures only. */
  allowLoopbackHttp?: boolean;
  /** Defaults to the v1.0 well-known Agent Card path. */
  path?: string;
  maxCardBytes?: number;
  /** Extra endpoint origins explicitly approved by local configuration. */
  allowedEndpointOrigins?: string[];
}

function requirePositiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function boundedResponse(response: Response, maxResponseBytes: number): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let received = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        received += chunk.value.byteLength;
        if (received > maxResponseBytes) {
          await reader.cancel('A2A response exceeds the bounded response limit');
          controller.error(new Error('A2A response exceeds the bounded response limit'));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function messageRequest(input: {
  messageId: string;
  skillId: string;
  payload: { serialized: string };
}): SendMessageRequest {
  const parsed: unknown = JSON.parse(input.payload.serialized);
  return {
    tenant: '',
    message: {
      messageId: input.messageId,
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: 'data', value: parsed },
        metadata: { readOnly: true, skillId: input.skillId },
        filename: '',
        mediaType: 'application/json',
      }],
      metadata: { readOnly: true, skillId: input.skillId },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ['application/json', 'text/plain'],
      taskPushNotificationConfig: undefined,
      historyLength: 0,
      returnImmediately: true,
    },
    metadata: { readOnly: true },
  };
}

function createBoundedEndpointFetch(
  baseEndpoint: string,
  options: Pick<CreateSdkA2aRemoteClientOptions, 'fetchImpl' | 'ssrfProtection' | 'allowLoopbackHttp'>,
  maxResponseBytes: number,
): typeof fetch {
  const base = new URL(baseEndpoint);
  const fetchImpl = options.fetchImpl ?? fetch;
  const ssrf = options.ssrfProtection ?? new SSRFProtection();
  return async (input, init) => {
    const target = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input),
      base,
    );
    if (target.origin !== base.origin) throw new Error('A2A transport attempted cross-origin egress');
    const loopbackFixture = options.allowLoopbackHttp === true
      && target.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname.toLowerCase());
    if (!loopbackFixture) {
      const check = await ssrf.check(target.toString());
      if (check.blocked) throw new Error(`A2A endpoint blocked by network policy: ${check.reason ?? 'unsafe endpoint'}`);
    }
    const response = await fetchImpl(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('A2A transport redirect was blocked; endpoint changes require explicit review');
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      throw new Error('A2A response exceeds the bounded response limit');
    }
    return boundedResponse(response, maxResponseBytes);
  };
}

function createBoundedFetch(
  card: NormalizedA2aAgentCard,
  options: CreateSdkA2aRemoteClientOptions,
): typeof fetch {
  return createBoundedEndpointFetch(
    card.endpoint,
    options,
    requirePositiveLimit(options.maxResponseBytes ?? 8 * 1024 * 1024, 'A2A response byte limit'),
  );
}

/**
 * Fetch and normalize one v1.0 Agent Card through the official SDK resolver.
 * Discovery is bounded and manually redirected; the advertised transport
 * endpoint must remain within an origin explicitly approved by local config.
 */
export async function discoverSdkA2aAgentCard(
  baseUrl: string,
  options: DiscoverSdkA2aAgentCardOptions = {},
): Promise<NormalizedA2aAgentCard> {
  const validatedBase = validateA2aEndpoint(baseUrl, options.allowLoopbackHttp === true);
  const base = new URL(validatedBase);
  const maxCardBytes = requirePositiveLimit(options.maxCardBytes ?? 256 * 1024, 'A2A Agent Card byte limit');
  const resolver = new DefaultAgentCardResolver({
    ...(options.path ? { path: options.path } : {}),
    fetchImpl: createBoundedEndpointFetch(validatedBase, options, maxCardBytes),
    legacyCompat: { enabled: false },
  });
  const resolved = await resolver.resolve(validatedBase);
  const card = normalizeA2aAgentCard(AgentCard.toJSON(resolved), {
    allowLoopbackHttp: options.allowLoopbackHttp === true,
  });
  const allowedOrigins = new Set([
    base.origin,
    ...(options.allowedEndpointOrigins ?? []).map((endpoint) => new URL(
      validateA2aEndpoint(endpoint, options.allowLoopbackHttp === true),
    ).origin),
  ]);
  if (!allowedOrigins.has(new URL(card.endpoint).origin)) {
    throw new Error('A2A Agent Card advertised endpoint origin is not explicitly approved');
  }
  return card;
}

function streamObservation(
  event: StreamResponse,
  messageId: string,
  artifactParts: Map<string, Artifact>,
  sequence: number,
  limits: A2aProjectionLimits,
): A2aRemoteTaskObservation | null {
  const payload = event.payload;
  if (!payload) return null;
  if (payload.$case === 'task') return observation(payload.value, messageId, `stream-task-${sequence}`, limits);
  if (payload.$case === 'statusUpdate') {
    const value = payload.value;
    return {
      remoteTaskId: value.taskId,
      contextId: value.contextId || null,
      messageId,
      state: stateFromTaskState(value.status?.state),
      eventId: `a2a_${digestA2aValue({ source: 'stream-status', sequence, value }).slice(0, 40)}`,
      artifacts: [],
    };
  }
  if (payload.$case === 'artifactUpdate') {
    const value = payload.value;
    if (!value.artifact) throw new Error('A2A artifact update omitted its artifact');
    const prior = artifactParts.get(value.artifact.artifactId);
    const aggregate: Artifact = value.append && prior
      ? { ...value.artifact, parts: [...prior.parts, ...value.artifact.parts] }
      : value.artifact;
    const projectedParts = [...artifactParts.values()]
      .filter((artifact) => artifact.artifactId !== aggregate.artifactId)
      .reduce((total, artifact) => total + artifact.parts.length, aggregate.parts.length);
    if (artifactParts.size + (prior ? 0 : 1) > limits.maxArtifacts) {
      throw new Error(`A2A artifact count exceeds the bounded limit of ${limits.maxArtifacts}`);
    }
    if (projectedParts > limits.maxArtifactParts) {
      throw new Error(`A2A artifact part count exceeds the bounded limit of ${limits.maxArtifactParts}`);
    }
    artifactParts.set(aggregate.artifactId, aggregate);
    return {
      remoteTaskId: value.taskId,
      contextId: value.contextId || null,
      messageId,
      state: 'working',
      eventId: `a2a_${digestA2aValue({ source: 'stream-artifact', sequence, taskId: value.taskId, artifactId: aggregate.artifactId, lastChunk: value.lastChunk }).slice(0, 40)}`,
      artifacts: value.lastChunk ? aggregate.parts.map((part, index) => partArtifact(aggregate, part, index)) : [],
    };
  }
  // Transient protocol messages are not durable task truth.
  return null;
}

export async function createSdkA2aRemoteClient(
  card: NormalizedA2aAgentCard,
  options: CreateSdkA2aRemoteClientOptions = {},
): Promise<A2aRemoteClient> {
  const fetchImpl = createBoundedFetch(card, options);
  const limits: A2aProjectionLimits = {
    maxArtifacts: requirePositiveLimit(options.maxArtifacts ?? 128, 'A2A artifact count limit'),
    maxArtifactParts: requirePositiveLimit(options.maxArtifactParts ?? 512, 'A2A artifact part limit'),
  };
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({
      fetchImpl,
      legacyCompat: { enabled: false },
    })],
    preferredTransports: ['JSONRPC'],
    clientConfig: {
      polling: true,
      acceptedOutputModes: ['application/json', 'text/plain'],
    },
  });
  const client = await factory.createFromAgentCard(card.raw as unknown as AgentCard);

  return {
    async sendReadOnly(input) {
      const result = await client.sendMessage(messageRequest(input), { signal: input.signal });
      return observation(requireTask(result, input.messageId), input.messageId, 'send', limits);
    },
    async *sendReadOnlyStream(input) {
      const artifacts = new Map<string, Artifact>();
      let sequence = 0;
      for await (const event of client.sendMessageStream(messageRequest(input), { signal: input.signal })) {
        sequence += 1;
        const observed = streamObservation(event, input.messageId, artifacts, sequence, limits);
        if (observed) yield observed;
      }
    },
    async getTask(input) {
      const task = await client.getTask({ tenant: '', id: input.remoteTaskId, historyLength: 0 }, { signal: input.signal });
      return observation(task, input.messageId ?? '', 'get', limits);
    },
    async cancelTask(input) {
      const task = await client.cancelTask({ tenant: '', id: input.remoteTaskId, metadata: { reason: input.reason } }, {
        signal: input.signal,
      });
      return observation(task, input.messageId ?? '', 'cancel', limits);
    },
  };
}
