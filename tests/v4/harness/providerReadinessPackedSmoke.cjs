#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  const packageRoot = path.resolve(process.argv[2] ?? '');
  if (!packageRoot) throw new Error('usage: providerReadinessPackedSmoke.cjs <installed-package-root>');

  const sockets = new Set();
  let calls = 0;
  let userTurns = 0;
  const server = http.createServer(async (request, response) => {
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
    const body = JSON.parse(raw);
    const replay = body.messages?.some((message) => message.role === 'tool');
    const requiresProbe = body.tools?.some(
      (tool) => tool.function?.name === 'runtime_readiness_probe',
    ) && !replay;
    const isRealTurn = body.messages?.some(
      (message) => message.role === 'user' && /PACKAGED (FIRST|SECOND)/.test(message.content ?? ''),
    );
    if (isRealTurn) userTurns += 1;
    const finishReason = requiresProbe ? 'tool_calls' : 'stop';
    const message = requiresProbe
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'packaged-probe',
            type: 'function',
            function: { name: 'runtime_readiness_probe', arguments: '{"marker":"ready"}' },
          }],
        }
      : {
          role: 'assistant',
          content: replay
            ? 'Probe cycle complete.'
            : isRealTurn
              ? `PACKAGED ${userTurns === 1 ? 'FIRST' : 'SECOND'}`
              : 'READY',
        };

    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = requiresProbe
      ? { tool_calls: message.tool_calls }
      : { content: message.content };
    response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-packed-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-packed-cwd-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const setupModule = require(path.join(packageRoot, 'dist', 'cli', 'v4', 'setupWizard.js'));
    const readinessModule = require(path.join(packageRoot, 'dist', 'providers', 'v4', 'providerReadiness.js'));
    const pathsModule = require(path.join(packageRoot, 'dist', 'core', 'v4', 'paths.js'));
    const paths = pathsModule.resolveAidenPaths({ rootOverride: home });
    const customIndex = setupModule.PROVIDERS.findIndex((provider) => provider.id === 'custom_openai') + 1;
    const choices = [customIndex];
    const inputs = ['custom-default', baseUrl, 'fixture-credential'];
    const setup = await setupModule.runSetupWizard({
      paths,
      prompts: {
        choose: async () => choices.shift(),
        input: async () => inputs.shift(),
        confirm: async () => false,
      },
      readinessVerifier: readinessModule.runRuntimeReadinessTransaction,
      skipCuratedStep: true,
    });
    assert.equal(setup.readiness?.state, 'complete');
    assert.equal(setup.readiness?.plainCompletionStatus, 'verified');
    assert.equal(setup.readiness?.toolCallStatus, 'verified');
    const setupCalls = calls;

    const entry = path.join(packageRoot, 'dist', 'cli', 'v4', 'aidenCLI.js');
    const run = (prompt) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, '-q', prompt], {
        cwd,
        env: {
          ...process.env,
          AIDEN_HOME: home,
          CUSTOM_OPENAI_API_KEY: '',
          AIDEN_NO_UPDATE_CHECK: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`packaged CLI exited ${code}: ${stderr}`));
      });
    });

    const first = await run('Reply with exactly: PACKAGED FIRST');
    assert.match(first.stdout, /PACKAGED FIRST/);
    const second = await run('Reply with exactly: PACKAGED SECOND');
    assert.match(second.stdout, /PACKAGED SECOND/);
    assert.equal(calls, setupCalls + 2);
    process.stdout.write(JSON.stringify({
      status: 'passed',
      setupCalls,
      firstResponse: 'PACKAGED FIRST',
      secondResponse: 'PACKAGED SECOND',
      totalCalls: calls,
    }) + '\n');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
