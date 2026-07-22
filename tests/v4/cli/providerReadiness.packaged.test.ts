import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { spawnAidenTerm, type AidenTerm } from '../harness/aidenTerm';

const packageRoot = process.env.AIDEN_PACKAGED_READINESS_ROOT;
const suite = packageRoot ? describe : describe.skip;
let server: http.Server | null = null;
const sockets = new Set<Socket>();
let term: AidenTerm | null = null;

afterEach(async () => {
  term?.kill();
  term = null;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function startProvider() {
  let calls = 0;
  let userTurns = 0;
  server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'custom-default' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    calls += 1;
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as {
      stream?: boolean;
      tool_choice?: unknown;
      tools?: Array<{ function?: { name?: string } }>;
      messages?: Array<{ role?: string; content?: string }>;
    };
    const replay = body.messages?.some((message) => message.role === 'tool');
    const requiresReadinessTool = body.tools?.some(
      (tool) => tool.function?.name === 'runtime_readiness_probe',
    ) && !replay;
    let message: Record<string, unknown>;
    let finishReason = 'stop';
    if (requiresReadinessTool) {
      finishReason = 'tool_calls';
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'packaged-probe',
          type: 'function',
          function: { name: 'runtime_readiness_probe', arguments: '{"marker":"ready"}' },
        }],
      };
    } else {
      const isRealTurn = body.messages?.some((message) =>
        message.role === 'user' && /PACKAGED (FIRST|SECOND)/.test(message.content ?? ''),
      );
      if (isRealTurn) userTurns += 1;
      const content = replay
        ? 'Probe cycle complete.'
        : isRealTurn
          ? `PACKAGED ${userTurns === 1 ? 'FIRST' : 'SECOND'}`
          : 'READY';
      message = { role: 'assistant', content };
    }
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (finishReason === 'tool_calls') {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: message.tool_calls }, finish_reason: null }] })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: message.content }, finish_reason: null }] })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls: () => calls };
}

suite('packaged provider readiness lifecycle', () => {
  it('sets up, answers, restarts, and answers again through the installed artifact', async () => {
    const root = path.resolve(packageRoot!);
    const entry = path.join(root, 'dist', 'cli', 'v4', 'aidenCLI.js');
    const setupModule = require(path.join(root, 'dist', 'cli', 'v4', 'setupWizard.js')) as any;
    const readinessModule = require(path.join(root, 'dist', 'providers', 'v4', 'providerReadiness.js')) as any;
    const pathsModule = require(path.join(root, 'dist', 'core', 'v4', 'paths.js')) as any;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-packaged-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-packaged-cwd-'));
    const fixture = await startProvider();
    const paths = pathsModule.resolveAidenPaths({ rootOverride: home });
    const customIndex = setupModule.PROVIDERS.findIndex(
      (provider: { id: string }) => provider.id === 'custom_openai',
    ) + 1;
    const choices = [customIndex];
    const inputs = ['custom-default', fixture.baseUrl, 'fixture-credential'];
    const prompts = {
      choose: async () => choices.shift(),
      input: async () => inputs.shift(),
      confirm: async () => false,
    };
    const setup = await setupModule.runSetupWizard({
      paths,
      prompts,
      readinessVerifier: readinessModule.runRuntimeReadinessTransaction,
      skipCuratedStep: true,
    });
    expect(setup.readiness?.state).toBe('complete');
    expect(setup.readiness?.plainCompletionStatus).toBe('verified');
    expect(setup.readiness?.toolCallStatus).toBe('verified');
    const setupCalls = fixture.calls();

    const env = {
      CUSTOM_OPENAI_API_KEY: '',
      AIDEN_NO_UPDATE_CHECK: '1',
    };
    term = await spawnAidenTerm({ entry, aidenHome: home, cwd, env });
    await term.waitForPrompt({ timeoutMs: 30_000 });
    term.typeLine('Reply with exactly: PACKAGED FIRST');
    await term.waitFor(() => fixture.calls() >= setupCalls + 1, {
      timeoutMs: 30_000,
      label: 'first packaged provider call',
    });
    await term.waitFor((plain) => plain.includes('PACKAGED FIRST'), {
      timeoutMs: 30_000,
      label: 'first packaged response',
    });
    await term.waitForPrompt({ timeoutMs: 30_000 });
    await term.quit({ timeoutMs: 30_000 });
    term = null;

    term = await spawnAidenTerm({ entry, aidenHome: home, cwd, env });
    await term.waitForPrompt({ timeoutMs: 30_000 });
    term.typeLine('Reply with exactly: PACKAGED SECOND');
    await term.waitFor(() => fixture.calls() >= setupCalls + 2, {
      timeoutMs: 30_000,
      label: 'second packaged provider call',
    });
    await term.waitFor((plain) => plain.includes('PACKAGED SECOND'), {
      timeoutMs: 30_000,
      label: 'second packaged response',
    });
    expect(fixture.calls()).toBe(setupCalls + 2);
    await term.quit({ timeoutMs: 30_000 });
    term = null;
  }, 120_000);
});
