/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createA2aRuntime, type A2aRemoteClient } from '../../../core/v4/a2a/runtime';
import { createA2aArtifactQuarantine } from '../../../core/v4/a2a/artifactQuarantine';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createArtifactStore } from '../../../core/v4/daemon/artifactStore';

const AGENT_CARD = {
  name: 'Repository Reader', description: 'Reads supplied structured facts.', version: '1.0.0',
  supportedInterfaces: [{
    url: 'https://reader.example.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '',
  }],
  capabilities: { streaming: true, pushNotifications: false, extensions: [] },
  securitySchemes: {}, securityRequirements: [], defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'], signatures: [],
  skills: [{
    id: 'repository-analysis', name: 'Repository analysis', description: 'Analyze bounded facts.',
    tags: ['read-only'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'],
    securityRequirements: [],
  }],
};

class FixtureClient implements A2aRemoteClient {
  sendCount = 0;
  getCount = 0;
  cancelCount = 0;
  state: 'working' | 'completed' | 'failed' | 'cancelled' = 'completed';
  async sendReadOnly(input: { messageId: string; signal?: AbortSignal }): Promise<ReturnType<A2aRemoteClient['getTask']> extends Promise<infer T> ? T : never> {
    this.sendCount += 1;
    return {
      remoteTaskId: 'remote-task-1', contextId: 'remote-context-1', messageId: input.messageId,
      state: this.state, eventId: `send-${this.sendCount}`,
      artifacts: this.state === 'completed' ? [{
        artifactKey: 'analysis-1', name: 'analysis.json', mediaType: 'application/json',
        bytes: Buffer.from('{"summary":"verified"}', 'utf8'),
      }] : [],
    };
  }
  async getTask(): Promise<Awaited<ReturnType<A2aRemoteClient['sendReadOnly']>>> {
    this.getCount += 1;
    return {
      remoteTaskId: 'remote-task-1', contextId: 'remote-context-1', messageId: 'message-1',
      state: this.state, eventId: `get-${this.getCount}`,
      artifacts: [],
    };
  }
  async cancelTask(): Promise<Awaited<ReturnType<A2aRemoteClient['sendReadOnly']>>> {
    this.cancelCount += 1;
    this.state = 'cancelled';
    return {
      remoteTaskId: 'remote-task-1', contextId: 'remote-context-1', messageId: 'message-1',
      state: 'cancelled', eventId: `cancel-${this.cancelCount}`, artifacts: [],
    };
  }
}

describe('read-only A2A child Job authority', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let parentJobId: string;
  let client: FixtureClient;
  let temporaryRoot: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO daemon_instances
      (instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES ('a2a-instance',1,'localhost',1,1,'4.20.0')`).run();
    engine = createJobEngine({ db });
    parentJobId = engine.submitJob({
      entryPoint: 'test', source: 'a2a-test', sessionId: 'session-a2a', instanceId: 'a2a-instance',
      idempotencyNamespace: 'a2a-parent', idempotencyKey: 'parent', goal: 'Use a remote reader.',
    }).jobId;
    client = new FixtureClient();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-a2a-runtime-'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function quarantine() {
    return createA2aArtifactQuarantine(path.join(temporaryRoot, 'quarantine'));
  }

  function setupRuntime() {
    const runtime = createA2aRuntime({
      engine, ownerId: 'a2a-runtime', clientFactory: async () => client, quarantine: quarantine(),
    });
    const discovered = runtime.discoverAgent(AGENT_CARD);
    const trusted = runtime.trustAgentEndpoint(discovered.externalIdentityId);
    return { runtime, agentId: trusted.externalIdentityId };
  }

  it('discovers and persists an Agent Card through bounded v1.0 URL discovery', async () => {
    const runtime = createA2aRuntime({
      engine,
      ownerId: 'a2a-runtime',
      clientFactory: async () => client,
      quarantine: quarantine(),
      agentCardDiscovery: {
        ssrfProtection: { check: async () => ({ blocked: false }) },
        fetchImpl: async () => new Response(JSON.stringify(AGENT_CARD), { status: 200 }),
      },
    });

    const discovered = await runtime.discoverAgentFromUrl('https://reader.example.test');

    expect(discovered).toMatchObject({
      kind: 'a2a',
      canonicalEndpoint: 'https://reader.example.test/a2a',
      trustState: 'unverified',
    });
    expect(engine.external.latestCapabilities(discovered.externalIdentityId)).toMatchObject({
      protocol: 'a2a',
      protocolVersion: '1.0',
      reviewRequired: true,
    });
  });

  it('creates one child Job and one RemoteTask, then completes only after local verification', async () => {
    const { runtime, agentId } = setupRuntime();
    const result = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Analyze package facts.', data: { name: 'aiden-runtime' },
      idempotencyKey: 'delegate-one',
      verify: ({ artifacts }) => ({
        ok: artifacts.some((artifact) => artifact.detectedMediaType === 'application/json'),
        verificationId: 'verify-a2a-1', evidenceIds: ['evidence-a2a-1'],
      }),
    });
    expect(result.remoteTask.state).toBe('verified');
    expect(engine.getJob(result.childJobId)).toMatchObject({ status: 'completed', parentJobId });
    expect(engine.getJob(parentJobId)?.status).toBe('queued');
    expect(client.sendCount).toBe(1);
    expect(engine.external.listRemoteTaskEvents(result.remoteTask.remoteTaskRecordId).map((event) => event.kind)).toEqual([
      'created', 'sent', 'accepted', 'artifact_observed', 'status_observed', 'verified', 'settled',
    ]);
    expect(engine.external.listRemoteTaskEvents(result.remoteTask.remoteTaskRecordId).map((event) => event.sequence))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);

    const duplicate = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Analyze package facts.', data: { name: 'aiden-runtime' },
      idempotencyKey: 'delegate-one', verify: () => ({ ok: true, verificationId: 'unused', evidenceIds: [] }),
    });
    expect(duplicate.childJobId).toBe(result.childJobId);
    expect(client.sendCount).toBe(1);
  });

  it('does not let a remote completion or claimed verification terminalize local truth', async () => {
    const { runtime, agentId } = setupRuntime();
    const result = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Analyze package facts.', data: {},
      idempotencyKey: 'delegate-unverified',
      verify: () => ({ ok: false, verificationId: 'verify-rejected', evidenceIds: [] }),
    });
    expect(result.remoteTask.state).toBe('completed_observed');
    expect(engine.getJob(result.childJobId)?.status).toBe('blocked');

    const artifactStore = createArtifactStore({ db, contentRoot: path.join(temporaryRoot, 'unverified-release') });
    await expect(Promise.resolve().then(() => runtime.releaseArtifact({
      remoteArtifactId: result.artifacts[0].remoteArtifactId,
      artifactStore,
      sessionId: 'session-a2a',
    }))).rejects.toThrow(/locally verified/i);
  });

  it('rejects aggregate remote output beyond the local budget before verification', async () => {
    const { runtime, agentId } = setupRuntime();
    let verifierCalled = false;
    client.sendReadOnly = async (input) => ({
      remoteTaskId: 'remote-budget-1', contextId: 'context-budget-1', messageId: input.messageId,
      state: 'completed', eventId: 'budget-completed', artifacts: [
        { artifactKey: 'budget-a', name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('a'.repeat(40)) },
        { artifactKey: 'budget-b', name: 'b.txt', mediaType: 'text/plain', bytes: Buffer.from('b'.repeat(40)) },
      ],
    });
    const result = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Bound remote output.', data: {},
      idempotencyKey: 'delegate-output-budget', maxArtifactBytes: 64, maxOutputBytes: 50,
      verify: () => { verifierCalled = true; return { ok: true, verificationId: 'must-not-run', evidenceIds: [] }; },
    });
    expect(verifierCalled).toBe(false);
    expect(result.remoteTask.state).toBe('completed_observed');
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every((artifact) => artifact.quarantineState === 'rejected')).toBe(true);
    expect(result.artifacts.every((artifact) => artifact.rejectionReason?.includes('aggregate'))).toBe(true);
    expect(engine.getJob(result.childJobId)?.status).toBe('blocked');
  });

  it('bounds runtime and records an uncertain outcome once send authority crossed the network boundary', async () => {
    const { runtime, agentId } = setupRuntime();
    client.sendReadOnly = async (input) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        input.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (input.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return {
        remoteTaskId: 'remote-too-late', contextId: null, messageId: input.messageId,
        state: 'working', eventId: 'too-late', artifacts: [],
      };
    };
    const started = Date.now();
    const result = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Stop at the local deadline.', data: {},
      idempotencyKey: 'delegate-runtime-budget', maxRuntimeMs: 25,
      verify: () => ({ ok: false, verificationId: 'unused', evidenceIds: [] }),
    });
    expect(Date.now() - started).toBeLessThan(200);
    expect(result.remoteTask.state).toBe('unknown');
    expect(engine.getJob(result.childJobId)?.status).toBe('unknown');
    expect(client.sendCount).toBe(0);
  });

  it('quarantines hostile output and releases only locally verified bytes into ArtifactStore', async () => {
    const { runtime, agentId } = setupRuntime();
    const accepted = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Create a safe result.', data: {},
      idempotencyKey: 'delegate-release',
      verify: ({ artifacts }) => ({ ok: artifacts.length === 1, verificationId: 'verify-release', evidenceIds: [] }),
    });
    const artifactStore = createArtifactStore({ db, contentRoot: path.join(temporaryRoot, 'released') });
    const released = runtime.releaseArtifact({
      remoteArtifactId: accepted.artifacts[0].remoteArtifactId,
      artifactStore,
      sessionId: 'session-a2a',
    });
    expect(released.quarantineState).toBe('released');
    const durable = artifactStore.get(released.artifactId!);
    expect(durable).toMatchObject({ taskId: accepted.childJobId, tool: 'a2a_remote_artifact' });
    expect(artifactStore.readContent(released.artifactId!)?.bytes.toString('utf8'))
      .toBe('{"summary":"verified"}');

    client.sendReadOnly = async (input) => ({
      remoteTaskId: 'remote-hostile-1', contextId: 'context-hostile-1', messageId: input.messageId,
      state: 'completed', eventId: 'hostile-completed', artifacts: [{
        artifactKey: 'hostile-exe', name: 'hostile.exe', mediaType: 'application/octet-stream',
        bytes: Buffer.from('MZhostile', 'utf8'),
      }],
    });
    const hostile = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Reject hostile output.', data: {},
      idempotencyKey: 'delegate-hostile',
      verify: () => ({ ok: true, verificationId: 'must-not-verify', evidenceIds: [] }),
    });
    expect(hostile.remoteTask.state).toBe('completed_observed');
    expect(hostile.artifacts).toEqual([expect.objectContaining({ quarantineState: 'rejected' })]);
    expect(engine.getJob(hostile.childJobId)?.status).toBe('blocked');
  });

  it.each([
    ['failed', 'failed_observed', 'blocked'],
    ['working', 'working', 'unknown'],
  ] as const)('maps remote %s to subordinate local truth', async (remote, taskState, jobState) => {
    const { runtime, agentId } = setupRuntime();
    client.state = remote;
    const result = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: `Observe remote ${remote}.`, data: {},
      idempotencyKey: `delegate-${remote}`,
      verify: () => ({ ok: true, verificationId: 'must-not-run', evidenceIds: [] }),
    });
    expect(result.remoteTask.state).toBe(taskState);
    expect(engine.getJob(result.childJobId)?.status).toBe(jobState);
  });

  it('requires explicit review for Agent Card skill drift and blocks verified-key rotation', async () => {
    const { runtime, agentId } = setupRuntime();
    const changedCard = {
      ...AGENT_CARD,
      skills: [...AGENT_CARD.skills, {
        ...AGENT_CARD.skills[0], id: 'new-read-skill', name: 'New read skill',
      }],
    };
    const drift = runtime.discoverAgent(changedCard);
    expect(drift.externalIdentityId).toBe(agentId);
    expect(drift.capabilitySnapshot).toMatchObject({ changeClass: 'read_only', reviewRequired: true });
    await expect(runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'new-read-skill', objective: 'Use drifted capability.', data: {},
      idempotencyKey: 'delegate-drifted', verify: () => ({ ok: true, verificationId: 'unused', evidenceIds: [] }),
    })).rejects.toThrow(/capability snapshot requires review/i);
    expect(client.sendCount).toBe(0);

    const signedRuntime = createA2aRuntime({
      engine, ownerId: 'a2a-signed-runtime', clientFactory: async () => client, quarantine: quarantine(),
    });
    const first = signedRuntime.discoverAgent(AGENT_CARD, { verifiedIdentityKeyDigest: 'a'.repeat(64) });
    signedRuntime.trustAgentEndpoint(first.externalIdentityId);
    const rotated = signedRuntime.discoverAgent(AGENT_CARD, { verifiedIdentityKeyDigest: 'b'.repeat(64) });
    expect(rotated.trustState).toBe('changed');
    await expect(signedRuntime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance',
      externalIdentityId: rotated.externalIdentityId, skillId: 'repository-analysis',
      objective: 'Reject rotated identity.', data: {}, idempotencyKey: 'delegate-rotated',
      verify: () => ({ ok: true, verificationId: 'unused', evidenceIds: [] }),
    })).rejects.toThrow(/explicitly trusted/i);
  });

  it('reconciles and cancels the same durable remote identity without resending', async () => {
    const { runtime, agentId } = setupRuntime();
    client.state = 'working';
    const pending = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Wait for repository facts.', data: {},
      idempotencyKey: 'delegate-pending', verify: () => ({ ok: false, verificationId: 'pending', evidenceIds: [] }),
    });
    expect(pending.remoteTask.state).toBe('working');
    expect(engine.getJob(pending.childJobId)?.status).toBe('unknown');

    client.state = 'completed';
    const reconciled = await runtime.reconcile(pending.remoteTask.remoteTaskRecordId);
    expect(reconciled.remoteTaskId).toBe('remote-task-1');
    expect(client.getCount).toBe(1);
    expect(client.sendCount).toBe(1);

    const cancelled = await runtime.cancel(pending.remoteTask.remoteTaskRecordId, 'user cancelled');
    expect(cancelled.state).toBe('cancelled_observed');
    expect(client.cancelCount).toBe(1);
    expect(client.sendCount).toBe(1);
  });

  it('preserves a remote completion observed during local cancellation without reviving the Job', async () => {
    const { runtime, agentId } = setupRuntime();
    client.state = 'working';
    const pending = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Read slowly.', data: {},
      idempotencyKey: 'delegate-cancel-race', verify: () => ({ ok: false, verificationId: 'unused', evidenceIds: [] }),
    });
    client.cancelTask = async () => {
      client.cancelCount += 1;
      return {
        remoteTaskId: 'remote-task-1', contextId: 'remote-context-1', messageId: 'message-1',
        state: 'completed', eventId: 'completed-during-cancel', artifacts: [],
      };
    };
    const observed = await runtime.cancel(pending.remoteTask.remoteTaskRecordId, 'user cancelled');
    expect(observed.state).toBe('completed_observed');
    expect(engine.getJob(pending.childJobId)?.status).toBe('cancelled');
    expect(engine.external.listRemoteTaskEvents(observed.remoteTaskRecordId).map((event) => event.kind)).toEqual([
      'created', 'sent', 'accepted', 'status_observed', 'cancel_requested', 'status_observed',
    ]);
  });

  it('persists ordered streaming status and artifact updates without replaying duplicate events', async () => {
    let streamSendCount = 0;
    const streamClient: A2aRemoteClient = {
      async sendReadOnly() { throw new Error('non-streaming send must not be selected'); },
      async *sendReadOnlyStream(input) {
        streamSendCount += 1;
        const working = {
          remoteTaskId: 'remote-stream-1', contextId: 'context-stream-1', messageId: input.messageId,
          state: 'working' as const, eventId: 'stream-working-1', artifacts: [],
        };
        yield working;
        yield working;
        yield {
          ...working,
          eventId: 'stream-artifact-1',
          artifacts: [{
            artifactKey: 'stream-analysis', name: 'stream-analysis.json', mediaType: 'application/json',
            bytes: Buffer.from('{"summary":"streamed"}', 'utf8'),
          }],
        };
        yield { ...working, state: 'completed' as const, eventId: 'stream-completed-1', artifacts: [] };
      },
      async getTask() { throw new Error('unexpected get'); },
      async cancelTask() { throw new Error('unexpected cancel'); },
    };
    const runtime = createA2aRuntime({
      engine, ownerId: 'a2a-runtime', clientFactory: async () => streamClient, quarantine: quarantine(),
    });
    const discovered = runtime.discoverAgent(AGENT_CARD);
    const trusted = runtime.trustAgentEndpoint(discovered.externalIdentityId);
    const result = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance',
      externalIdentityId: trusted.externalIdentityId, skillId: 'repository-analysis',
      objective: 'Analyze streamed facts.', data: {}, idempotencyKey: 'delegate-stream',
      verify: ({ artifacts }) => ({
        ok: artifacts.length === 1 && artifacts[0].declaredName === 'stream-analysis.json',
        verificationId: 'verify-stream', evidenceIds: [],
      }),
    });
    expect(streamSendCount).toBe(1);
    expect(result.remoteTask.state).toBe('verified');
    expect(result.artifacts).toHaveLength(1);
    const events = engine.external.listRemoteTaskEvents(result.remoteTask.remoteTaskRecordId);
    expect(events.filter((event) => event.remoteEventId === 'stream-working-1')).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual([
      'created', 'sent', 'accepted', 'status_observed', 'artifact_observed',
      'status_observed', 'status_observed', 'verified', 'settled',
    ]);
  });

  it('bounds streamed observations and preserves the remote outcome as unknown', async () => {
    const streamClient: A2aRemoteClient = {
      async sendReadOnly() { throw new Error('stream expected'); },
      async *sendReadOnlyStream(input) {
        for (let index = 1; index <= 3; index += 1) {
          yield {
            remoteTaskId: 'remote-bounded-stream', contextId: 'context-bounded-stream', messageId: input.messageId,
            state: 'working', eventId: `bounded-working-${index}`, artifacts: [],
          };
        }
        yield {
          remoteTaskId: 'remote-bounded-stream', contextId: 'context-bounded-stream', messageId: input.messageId,
          state: 'completed', eventId: 'bounded-completed', artifacts: [{
            artifactKey: 'bounded-result', name: 'bounded.json', mediaType: 'application/json',
            bytes: Buffer.from('{"ok":true}', 'utf8'),
          }],
        };
      },
      async getTask() { throw new Error('unexpected get'); },
      async cancelTask() { throw new Error('unexpected cancel'); },
    };
    const runtime = createA2aRuntime({
      engine, ownerId: 'a2a-bounded-runtime', clientFactory: async () => streamClient, quarantine: quarantine(),
    });
    const discovered = runtime.discoverAgent({
      ...AGENT_CARD,
      capabilities: { ...AGENT_CARD.capabilities, streaming: true },
    });
    const trusted = runtime.trustAgentEndpoint(discovered.externalIdentityId);
    let verifierCalled = false;
    const result = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance',
      externalIdentityId: trusted.externalIdentityId, skillId: 'repository-analysis',
      objective: 'Bound the status stream.', data: {}, idempotencyKey: 'delegate-bounded-stream',
      maxStreamEvents: 2,
      verify: () => { verifierCalled = true; return { ok: true, verificationId: 'unexpected', evidenceIds: [] }; },
    });

    expect(verifierCalled).toBe(false);
    expect(result.remoteTask.state).toBe('unknown');
    expect(engine.getJob(result.childJobId)?.status).toBe('unknown');
    expect(engine.external.listRemoteTaskEvents(result.remoteTask.remoteTaskRecordId)
      .filter((event) => event.kind === 'status_observed')).toHaveLength(2);
  });

  it('suppresses completion after an active verified identity rotates and records the identity boundary', async () => {
    let runtime: ReturnType<typeof createA2aRuntime>;
    const rotatingClient: A2aRemoteClient = {
      async sendReadOnly() { throw new Error('stream expected'); },
      async *sendReadOnlyStream(input) {
        yield {
          remoteTaskId: 'remote-rotation-1', contextId: 'context-rotation-1', messageId: input.messageId,
          state: 'working', eventId: 'rotation-working', artifacts: [],
        };
        runtime.discoverAgent(AGENT_CARD, { verifiedIdentityKeyDigest: 'b'.repeat(64) });
        yield {
          remoteTaskId: 'remote-rotation-1', contextId: 'context-rotation-1', messageId: input.messageId,
          state: 'completed', eventId: 'rotation-completed', artifacts: [{
            artifactKey: 'rotation-result', name: 'rotation.json', mediaType: 'application/json',
            bytes: Buffer.from('{"unsafeAfterRotation":true}', 'utf8'),
          }],
        };
      },
      async getTask() { throw new Error('unexpected get'); },
      async cancelTask() { throw new Error('unexpected cancel'); },
    };
    runtime = createA2aRuntime({
      engine, ownerId: 'a2a-rotation-runtime', clientFactory: async () => rotatingClient, quarantine: quarantine(),
    });
    const first = runtime.discoverAgent(AGENT_CARD, { verifiedIdentityKeyDigest: 'a'.repeat(64) });
    runtime.trustAgentEndpoint(first.externalIdentityId);
    let verifierCalled = false;
    const result = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: first.externalIdentityId,
      skillId: 'repository-analysis', objective: 'Reject rotated identity output.', data: {},
      idempotencyKey: 'delegate-active-rotation',
      verify: () => { verifierCalled = true; return { ok: true, verificationId: 'must-not-run', evidenceIds: [] }; },
    });
    expect(verifierCalled).toBe(false);
    expect(result.remoteTask.state).toBe('unknown');
    expect(engine.getJob(result.childJobId)?.status).toBe('unknown');
    expect(engine.external.listRemoteTaskEvents(result.remoteTask.remoteTaskRecordId).map((event) => event.kind))
      .toContain('identity_changed');
  });

  it('recovers a stream loss by querying the same remote Task without resending', async () => {
    let sendCount = 0;
    let getCount = 0;
    const reconnectingClient: A2aRemoteClient = {
      async sendReadOnly() { throw new Error('non-streaming send must not be selected'); },
      async *sendReadOnlyStream(input) {
        sendCount += 1;
        yield {
          remoteTaskId: 'remote-reconnect-1', contextId: 'context-reconnect-1', messageId: input.messageId,
          state: 'working', eventId: 'reconnect-working', artifacts: [],
        };
        throw new Error('stream disconnected');
      },
      async getTask() {
        getCount += 1;
        return {
          remoteTaskId: 'remote-reconnect-1', contextId: 'context-reconnect-1', messageId: 'message-reconnect-1',
          state: 'completed', eventId: 'reconnect-completed', artifacts: [{
            artifactKey: 'reconnect-result', name: 'reconnect.json', mediaType: 'application/json',
            bytes: Buffer.from('{"ok":true}', 'utf8'),
          }],
        };
      },
      async cancelTask() { throw new Error('unexpected cancel'); },
    };
    const firstRuntime = createA2aRuntime({
      engine, ownerId: 'a2a-runtime', clientFactory: async () => reconnectingClient, quarantine: quarantine(),
    });
    const discovered = firstRuntime.discoverAgent(AGENT_CARD);
    const trusted = firstRuntime.trustAgentEndpoint(discovered.externalIdentityId);
    const pending = await firstRuntime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance',
      externalIdentityId: trusted.externalIdentityId, skillId: 'repository-analysis',
      objective: 'Recover the same task.', data: {}, idempotencyKey: 'delegate-reconnect',
      verify: () => ({ ok: false, verificationId: 'unused', evidenceIds: [] }),
    });
    expect(pending.remoteTask.state).toBe('unknown');
    expect(engine.getJob(pending.childJobId)?.status).toBe('unknown');

    const restartedRuntime = createA2aRuntime({
      engine, ownerId: 'a2a-runtime-restarted', instanceId: 'a2a-instance',
      clientFactory: async () => reconnectingClient, quarantine: quarantine(),
    });
    const reconciled = await restartedRuntime.reconcile(
      pending.remoteTask.remoteTaskRecordId,
      ({ artifacts }) => ({
        ok: artifacts.length === 1, verificationId: 'verify-reconnected', evidenceIds: [],
      }),
    );
    expect(reconciled.state).toBe('verified');
    expect(sendCount).toBe(1);
    expect(getCount).toBe(1);
    expect(engine.external.listRemoteTaskEvents(reconciled.remoteTaskRecordId).map((event) => event.kind))
      .toContain('reconnected');
  });

  it('keeps local cancellation durable when the cancel response is lost and reconciles later', async () => {
    const { runtime, agentId } = setupRuntime();
    client.state = 'working';
    const pending = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-a2a', instanceId: 'a2a-instance', externalIdentityId: agentId,
      skillId: 'repository-analysis', objective: 'Cancel safely.', data: {},
      idempotencyKey: 'delegate-cancel-lost', verify: () => ({ ok: false, verificationId: 'unused', evidenceIds: [] }),
    });
    client.cancelTask = async () => {
      client.cancelCount += 1;
      throw new Error('cancel response lost');
    };
    await expect(runtime.cancel(pending.remoteTask.remoteTaskRecordId, 'user cancelled'))
      .rejects.toThrow(/response lost/i);
    const requested = engine.external.getRemoteTask(pending.remoteTask.remoteTaskRecordId)!;
    expect(requested).toMatchObject({ state: 'cancel_requested' });
    expect(requested.cancelRequestedAt).not.toBeNull();
    expect(engine.getJob(pending.childJobId)?.status).toBe('cancelled');

    client.state = 'cancelled';
    const reconciled = await runtime.reconcile(requested.remoteTaskRecordId);
    expect(reconciled.state).toBe('cancelled_observed');
    expect(engine.getJob(pending.childJobId)?.status).toBe('cancelled');
    expect(client.sendCount).toBe(1);
    expect(client.getCount).toBe(1);
  });
});
