/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCard,
  TaskState,
} from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
} from '@a2a-js/sdk/server';

import { createA2aRuntime } from '../../../core/v4/a2a/runtime';
import { createSdkA2aRemoteClient } from '../../../core/v4/a2a/sdkClient';
import { createA2aArtifactQuarantine } from '../../../core/v4/a2a/artifactQuarantine';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

async function writeWireResult(res: http.ServerResponse, result: unknown): Promise<void> {
  if (isAsyncIterable(result)) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for await (const event of result) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
    return;
  }
  const body = JSON.stringify(result);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

describe('A2A v1.0 controlled wire fixture', () => {
  const servers: http.Server[] = [];
  const roots: string[] = [];
  const databases: Database.Database[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    databases.splice(0).forEach((db) => db.close());
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  it('discovers, delegates, correlates, quarantines, and locally verifies through official JSON-RPC handlers', async () => {
    let wireHandler: JsonRpcTransportHandler | null = null;
    let cardJson: Record<string, unknown> | null = null;
    let executeCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        const body = JSON.stringify(cardJson);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (req.method !== 'POST' || !wireHandler) { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const requestedVersion = typeof req.headers['a2a-version'] === 'string'
          ? req.headers['a2a-version'] : '1.0';
        void wireHandler!.handle(Buffer.concat(chunks).toString('utf8'), new ServerCallContext({ requestedVersion }))
          .then((result) => writeWireResult(res, result))
          .catch((error) => {
            const body = JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failure' });
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(body);
          });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('A2A fixture did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const rawCard = {
      name: 'Controlled repository reader', description: 'Bounded read-only fixture.', version: '1.0.0',
      supportedInterfaces: [{ url: `${baseUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
      capabilities: { streaming: false, pushNotifications: false, extensions: [] },
      securitySchemes: {}, securityRequirements: [], defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'], signatures: [],
      skills: [{
        id: 'repository-analysis', name: 'Repository analysis', description: 'Analyze bounded facts.',
        tags: ['read-only'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'],
        securityRequirements: [],
      }],
    };
    const card = AgentCard.fromJSON(rawCard);
    cardJson = AgentCard.toJSON(card) as Record<string, unknown>;
    const executor: AgentExecutor = {
      async execute(context, eventBus) {
        executeCount += 1;
        eventBus.publish(AgentEvent.task({
          id: context.taskId,
          contextId: context.contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
          artifacts: [{
            artifactId: 'fixture-analysis', name: 'analysis.json', description: 'Controlled result',
            parts: [{
              content: { $case: 'data', value: { package: 'aiden-runtime', verifiedFixture: true } },
              metadata: {}, filename: 'analysis.json', mediaType: 'application/json',
            }],
            metadata: {}, extensions: [],
          }],
          history: [context.userMessage], metadata: {},
        }));
        eventBus.finished();
      },
      async cancelTask(_taskId, eventBus) { eventBus.finished(); },
    };
    wireHandler = new JsonRpcTransportHandler(new DefaultRequestHandler(card, new InMemoryTaskStore(), executor));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-a2a-interop-'));
    roots.push(root);
    const db = new Database(':memory:');
    databases.push(db);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO daemon_instances
      (instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES ('a2a-interop',1,'localhost',1,1,'4.20.0')`).run();
    const engine = createJobEngine({ db });
    const parentJobId = engine.submitJob({
      entryPoint: 'test', source: 'a2a-interop', sessionId: 'session-interop', instanceId: 'a2a-interop',
      idempotencyNamespace: 'a2a-interop-parent', idempotencyKey: 'parent', goal: 'Use the controlled reader.',
    }).jobId;
    const runtime = createA2aRuntime({
      engine,
      ownerId: 'a2a-interop-owner',
      instanceId: 'a2a-interop',
      allowLoopbackHttp: true,
      agentCardDiscovery: { fetchImpl: fetch, ssrfProtection: { check: async () => ({ blocked: false }) } },
      clientFactory: (normalized) => createSdkA2aRemoteClient(normalized, {
        fetchImpl: fetch, allowLoopbackHttp: true,
        ssrfProtection: { check: async () => ({ blocked: false }) },
      }),
      quarantine: createA2aArtifactQuarantine(path.join(root, 'quarantine')),
    });
    const discovered = await runtime.discoverAgentFromUrl(baseUrl);
    const trusted = runtime.trustAgentEndpoint(discovered.externalIdentityId);
    const delegated = await runtime.delegateReadOnly({
      parentJobId,
      sessionId: 'session-interop',
      instanceId: 'a2a-interop',
      externalIdentityId: trusted.externalIdentityId,
      skillId: 'repository-analysis',
      objective: 'Analyze sanitized package facts.',
      data: { package: 'aiden-runtime' },
      idempotencyKey: 'interop-delegation',
      verify: ({ artifacts }) => ({
        ok: artifacts.length === 1 && artifacts[0].detectedMediaType === 'application/json',
        verificationId: 'interop-local-verification',
        evidenceIds: [],
      }),
    });

    expect(executeCount).toBe(1);
    expect(delegated.remoteTask).toMatchObject({
      externalIdentityId: trusted.externalIdentityId,
      localJobId: delegated.childJobId,
      state: 'verified',
      locallyVerified: true,
    });
    expect(delegated.remoteTask.remoteTaskId).toBeTruthy();
    expect(delegated.artifacts).toHaveLength(1);
    expect(delegated.artifacts[0]).toMatchObject({ quarantineState: 'quarantined', detectedMediaType: 'application/json' });
    expect(engine.getJob(delegated.childJobId)).toMatchObject({ status: 'completed', parentJobId });

    const duplicate = await runtime.delegateReadOnly({
      parentJobId,
      sessionId: 'session-interop',
      instanceId: 'a2a-interop',
      externalIdentityId: trusted.externalIdentityId,
      skillId: 'repository-analysis',
      objective: 'Analyze sanitized package facts.',
      data: { package: 'aiden-runtime' },
      idempotencyKey: 'interop-delegation',
      verify: () => ({ ok: true, verificationId: 'must-not-run', evidenceIds: [] }),
    });
    expect(duplicate.remoteTask.remoteTaskRecordId).toBe(delegated.remoteTask.remoteTaskRecordId);
    expect(executeCount).toBe(1);
  });

  it('streams ordered task, artifact, and terminal status events through the official v1.0 binding', async () => {
    let wireHandler: JsonRpcTransportHandler | null = null;
    let cardJson: Record<string, unknown> | null = null;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        const body = JSON.stringify(cardJson);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (req.method !== 'POST' || !wireHandler) { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const requestedVersion = typeof req.headers['a2a-version'] === 'string'
          ? req.headers['a2a-version'] : '1.0';
        void wireHandler!.handle(Buffer.concat(chunks).toString('utf8'), new ServerCallContext({ requestedVersion }))
          .then((result) => writeWireResult(res, result))
          .catch((error) => {
            const body = JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failure' });
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(body);
          });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('A2A streaming fixture did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const card = AgentCard.fromJSON({
      name: 'Controlled streaming reader', description: 'Bounded streaming fixture.', version: '1.0.0',
      supportedInterfaces: [{ url: `${baseUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
      capabilities: { streaming: true, pushNotifications: false, extensions: [] },
      securitySchemes: {}, securityRequirements: [], defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'], signatures: [],
      skills: [{
        id: 'repository-analysis', name: 'Repository analysis', description: 'Analyze bounded facts.',
        tags: ['read-only'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'],
        securityRequirements: [],
      }],
    });
    cardJson = AgentCard.toJSON(card) as Record<string, unknown>;
    let executeCount = 0;
    let cancelCount = 0;
    const taskContexts = new Map<string, string>();
    let releaseHeldExecution: (() => void) | null = null;
    const executor: AgentExecutor = {
      async execute(context, eventBus) {
        executeCount += 1;
        taskContexts.set(context.taskId, context.contextId);
        const timestamp = new Date().toISOString();
        eventBus.publish(AgentEvent.task({
          id: context.taskId, contextId: context.contextId,
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp },
          artifacts: [], history: [context.userMessage], metadata: {},
        }));
        const requestData = context.userMessage.parts[0]?.content?.$case === 'data'
          ? context.userMessage.parts[0].content.value as Record<string, unknown>
          : {};
        const delegatedData = typeof requestData.data === 'object' && requestData.data !== null
          ? requestData.data as Record<string, unknown>
          : {};
        if (delegatedData.mode === 'hold') {
          await new Promise<void>((resolve) => { releaseHeldExecution = resolve; });
          return;
        }
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId: context.taskId, contextId: context.contextId,
          artifact: {
            artifactId: 'stream-analysis', name: 'stream-analysis.json', description: 'Controlled stream result',
            parts: [{
              content: { $case: 'data', value: { package: 'aiden-runtime', streamed: true } },
              metadata: {}, filename: 'stream-analysis.json', mediaType: 'application/json',
            }],
            metadata: {}, extensions: [],
          },
          append: false, lastChunk: true, metadata: {},
        }));
        eventBus.publish(AgentEvent.statusUpdate({
          taskId: context.taskId, contextId: context.contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
          metadata: {},
        }));
        eventBus.finished();
      },
      async cancelTask(taskId, eventBus) {
        cancelCount += 1;
        eventBus.publish(AgentEvent.statusUpdate({
          taskId, contextId: taskContexts.get(taskId) ?? '',
          status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
          metadata: {},
        }));
        eventBus.finished();
        releaseHeldExecution?.();
        releaseHeldExecution = null;
      },
    };
    wireHandler = new JsonRpcTransportHandler(new DefaultRequestHandler(card, new InMemoryTaskStore(), executor));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-a2a-stream-'));
    roots.push(root);
    const db = new Database(':memory:');
    databases.push(db);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO daemon_instances
      (instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES ('a2a-stream',1,'localhost',1,1,'4.20.0')`).run();
    const engine = createJobEngine({ db });
    const parentJobId = engine.submitJob({
      entryPoint: 'test', source: 'a2a-stream', sessionId: 'session-stream', instanceId: 'a2a-stream',
      idempotencyNamespace: 'a2a-stream-parent', idempotencyKey: 'parent', goal: 'Use the streaming reader.',
    }).jobId;
    const runtime = createA2aRuntime({
      engine, ownerId: 'a2a-stream-owner', instanceId: 'a2a-stream', allowLoopbackHttp: true,
      agentCardDiscovery: { fetchImpl: fetch, ssrfProtection: { check: async () => ({ blocked: false }) } },
      clientFactory: (normalized) => createSdkA2aRemoteClient(normalized, {
        fetchImpl: fetch, allowLoopbackHttp: true,
        ssrfProtection: { check: async () => ({ blocked: false }) },
      }),
      quarantine: createA2aArtifactQuarantine(path.join(root, 'quarantine')),
    });
    const discovered = await runtime.discoverAgentFromUrl(baseUrl);
    runtime.trustAgentEndpoint(discovered.externalIdentityId);
    const delegated = await runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-stream', instanceId: 'a2a-stream',
      externalIdentityId: discovered.externalIdentityId, skillId: 'repository-analysis',
      objective: 'Analyze streamed package facts.', data: {}, idempotencyKey: 'stream-delegation',
      verify: ({ artifacts }) => ({
        ok: artifacts.length === 1 && artifacts[0].detectedMediaType === 'application/json',
        verificationId: 'stream-local-verification', evidenceIds: [],
      }),
    });

    expect(delegated.remoteTask).toMatchObject({ state: 'verified', locallyVerified: true });
    expect(delegated.artifacts).toHaveLength(1);
    const events = engine.external.listRemoteTaskEvents(delegated.remoteTask.remoteTaskRecordId);
    expect(events.map((event) => event.taskState)).toEqual(expect.arrayContaining([
      'working', 'completed_observed', 'verified',
    ]));
    expect(new Set(events.map((event) => event.remoteEventId)).size).toBe(events.length);
    expect(engine.getJob(delegated.childJobId)?.status).toBe('completed');

    const pending = runtime.delegateReadOnly({
      parentJobId, sessionId: 'session-stream', instanceId: 'a2a-stream',
      externalIdentityId: discovered.externalIdentityId, skillId: 'repository-analysis',
      objective: 'Hold a read-only task until cancellation.', data: { mode: 'hold' },
      idempotencyKey: 'stream-cancel-delegation',
      verify: () => ({ ok: false, verificationId: 'cancelled-task-must-not-verify', evidenceIds: [] }),
    });
    const pendingResultPromise = Promise.allSettled([pending]);
    let held = engine.external.findRemoteTaskByIdempotency(discovered.externalIdentityId, 'stream-cancel-delegation');
    for (let attempt = 0; attempt < 100 && !held?.remoteTaskId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      held = engine.external.findRemoteTaskByIdempotency(discovered.externalIdentityId, 'stream-cancel-delegation');
    }
    expect(held?.remoteTaskId).toBeTruthy();
    const cancelled = await runtime.cancel(held!.remoteTaskRecordId, 'controlled fixture cancellation');
    const pendingResult = await pendingResultPromise;

    expect(cancelled.state).toBe('cancelled_observed');
    expect(executeCount).toBe(2);
    expect(cancelCount).toBe(1);
    expect(engine.getJob(held!.localJobId)?.status).toBe('cancelled');
    expect(engine.external.findRemoteTaskByIdempotency(
      discovered.externalIdentityId,
      'stream-cancel-delegation',
    )?.state).toBe('cancelled_observed');
    expect(pendingResult[0].status).toBe('rejected');
    if (pendingResult[0].status === 'rejected') {
      expect(String(pendingResult[0].reason)).not.toContain('Remote task state version conflict');
    }
  });
});
