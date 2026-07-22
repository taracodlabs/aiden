import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigManager } from '../../../core/v4/config';
import type { AidenPaths } from '../../../core/v4/paths';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';
import { RuntimeResolver } from '../../../providers/v4/runtimeResolver';
import { runRuntimeReadinessTransaction } from '../../../providers/v4/providerReadiness';
import { classifyReadinessError, type ProviderReadinessErrorCategory } from '../../../providers/v4/readinessErrors';

let server: Server | null = null;
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

function pathsFor(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'memories', 'MEMORY.md'),
    userMd: path.join(root, 'memories', 'USER.md'),
    skillsDir: path.join(root, 'skills'),
    sessionsDir: path.join(root, 'sessions'),
    pluginsDir: path.join(root, 'plugins'),
    logsDir: path.join(root, 'logs'),
    bundledManifest: path.join(root, '.bundled_manifest'),
    skillsBundleVersion: path.join(root, '.skills-bundle-version'),
  };
}

async function controlledProvider() {
  let calls = 0;
  server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    calls += 1;
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as {
      stream?: boolean;
      tool_choice?: unknown;
      messages?: Array<{ role?: string }>;
    };
    const replayed = body.messages?.some((message) => message.role === 'tool');
    const message = body.tool_choice === 'required' && !replayed
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'probe-call',
            type: 'function',
            function: { name: 'runtime_readiness_probe', arguments: '{"marker":"ready"}' },
          }],
        }
      : { role: 'assistant', content: replayed ? 'Probe cycle complete.' : `READY ${calls}` };
    const finishReason = replayed || body.tool_choice !== 'required' ? 'stop' : 'tool_calls';
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: message.content }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls: () => calls };
}

async function responseFixture(status: number, body: string) {
  server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

async function productionAdapter(baseUrl: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-readiness-error-'));
  const paths = pathsFor(root);
  await fs.writeFile(paths.envFile, 'CUSTOM_OPENAI_API_KEY=fixture-credential\n', 'utf8');
  const config = new ConfigManager(paths);
  await config.load();
  config.set('model.provider', 'custom_openai');
  config.set('model.modelId', 'provider-live-model');
  config.set('providers.custom_openai.baseUrl', baseUrl);
  config.set('providers.custom_openai.modelVerification', 'unverified');
  await config.save();
  await config.load();
  return new RuntimeResolver(new CredentialResolver(paths.authJson)).resolve({
    providerId: 'custom_openai',
    modelId: 'provider-live-model',
    config,
    paths,
  });
}

describe('provider readiness production path', () => {
  it('verifies, persists, restarts, and completes a second real response', async () => {
    const fixture = await controlledProvider();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-readiness-'));
    const paths = pathsFor(root);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(paths.envFile, 'CUSTOM_OPENAI_API_KEY=fixture-credential\n', 'utf8');

    const firstConfig = new ConfigManager(paths);
    await firstConfig.load();
    firstConfig.set('model.provider', 'custom_openai');
    firstConfig.set('model.modelId', 'provider-live-model');
    firstConfig.set('providers.custom_openai.baseUrl', fixture.baseUrl);
    firstConfig.set('providers.custom_openai.modelVerification', 'unverified');
    await firstConfig.save();
    await firstConfig.load();

    const firstResolver = new RuntimeResolver(new CredentialResolver(paths.authJson));
    const readiness = await runRuntimeReadinessTransaction({
      paths,
      config: firstConfig,
      resolver: firstResolver,
      providerId: 'custom_openai',
      modelId: 'provider-live-model',
      modelVerification: 'unverified',
    });
    expect(readiness.state).toBe('complete');
    expect(readiness.plainCompletionStatus).toBe('verified');
    expect(readiness.toolCallStatus).toBe('verified');
    expect(readiness.credentialSource).toBe('managed_environment');
    expect(fixture.calls()).toBe(4);

    const restartedConfig = new ConfigManager(paths);
    const persisted = await restartedConfig.load();
    expect(persisted.model).toEqual({ provider: 'custom_openai', modelId: 'provider-live-model' });
    expect(restartedConfig.get('providers.custom_openai.modelVerification')).toBe('verified');
    expect(restartedConfig.getValue('providers.custom_openai.readiness')).toMatchObject({ state: 'complete' });

    const restartedResolver = new RuntimeResolver(new CredentialResolver(paths.authJson));
    const adapter = await restartedResolver.resolve({
      providerId: persisted.model.provider,
      modelId: persisted.model.modelId,
      config: restartedConfig,
      paths,
    });
    const second = await adapter.call({
      messages: [{ role: 'user', content: 'Reply after restart.' }],
      tools: [],
    });
    expect(second.content).toBe('READY 5');
    expect(fixture.calls()).toBe(5);
  });

  const statusCases: Array<{
    status: number;
    body: string;
    stage?: 'model' | 'plain';
    expected: ProviderReadinessErrorCategory;
  }> = [
    { status: 401, body: '{"error":{"message":"rejected"}}', expected: 'credential_invalid' },
    { status: 403, body: '{"error":{"message":"forbidden"}}', expected: 'credential_forbidden' },
    { status: 404, body: '{"error":{"message":"model missing"}}', stage: 'model', expected: 'model_unavailable' },
    { status: 429, body: '{"error":{"message":"too many requests"}}', expected: 'rate_limited' },
    { status: 500, body: '{"error":{"message":"server failure"}}', expected: 'provider_unavailable' },
    { status: 503, body: '{"error":{"message":"temporarily unavailable"}}', expected: 'provider_unavailable' },
    { status: 200, body: '{not-json', expected: 'malformed_response' },
  ];

  for (const testCase of statusCases) {
    it(`classifies production response ${testCase.status} as ${testCase.expected}`, async () => {
      const baseUrl = await responseFixture(testCase.status, testCase.body);
      const adapter = await productionAdapter(baseUrl);
      let caught: unknown;
      try {
        await adapter.call({ messages: [{ role: 'user', content: 'probe' }], tools: [] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(classifyReadinessError(caught, testCase.stage ?? 'plain').category)
        .toBe(testCase.expected);
    });
  }
});
