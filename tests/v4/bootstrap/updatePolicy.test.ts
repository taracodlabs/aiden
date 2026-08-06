import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const bootstrap = require(path.join(root, 'bin', 'aiden-bootstrap.cjs'));
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function registry(body: unknown, delayMs = 0): Promise<string> {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    }, delayMs);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return `http://127.0.0.1:${address.port}/aiden-runtime`;
}

function stateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'aiden-update-state-')), '.update_check.json');
}

describe('bootstrap update checks', () => {
  it('caches stable and beta tags and reuses a fresh result', async () => {
    const file = stateFile();
    const url = await registry({
      'dist-tags': { latest: '4.19.1', beta: '4.20.0-beta.1' },
      versions: { '4.19.1': {}, '4.20.0-beta.1': {} },
    });
    const first = await bootstrap.checkRegistry({
      stateFile: file,
      installed: '4.19.0',
      env: {},
      force: true,
      registryUrl: url,
      now: () => 10_000,
    });
    expect(first).toMatchObject({ checked: true, offline: false, candidate: '4.19.1' });
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written).toMatchObject({ installed: '4.19.0', latest: '4.19.1', beta: '4.20.0-beta.1' });

    const cached = await bootstrap.checkRegistry({
      stateFile: file,
      installed: '4.19.0',
      env: {},
      registryUrl: 'http://127.0.0.1:1/unreachable',
      now: () => 10_001,
    });
    expect(cached).toMatchObject({ checked: false, offline: false, candidate: '4.19.1' });
  });

  it('fails open for invalid JSON, offline, TLS-like, and timeout failures', async () => {
    const invalidUrl = await registry('{');
    const invalid = await bootstrap.checkRegistry({
      stateFile: stateFile(), installed: '4.19.0', env: {}, force: true, registryUrl: invalidUrl,
    });
    expect(invalid).toMatchObject({ candidate: null, offline: true });

    const offline = await bootstrap.checkRegistry({
      stateFile: stateFile(), installed: '4.19.0', env: {}, force: true,
      registryUrl: 'http://127.0.0.1:1/unreachable', timeoutMs: 100,
    });
    expect(offline).toMatchObject({ candidate: null, offline: true });

    const slowUrl = await registry({ 'dist-tags': { latest: '4.19.1' } }, 250);
    const started = Date.now();
    const timedOut = await bootstrap.checkRegistry({
      stateFile: stateFile(), installed: '4.19.0', env: {}, force: true,
      registryUrl: slowUrl, timeoutMs: 30,
    });
    expect(timedOut).toMatchObject({ candidate: null, offline: true });
    expect(Date.now() - started).toBeLessThan(200);

    const trickleServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => response.write(' '), 10);
      response.once('close', () => clearInterval(timer));
    });
    servers.push(trickleServer);
    await new Promise<void>((resolve) => trickleServer.listen(0, '127.0.0.1', resolve));
    const trickleAddress = trickleServer.address();
    if (!trickleAddress || typeof trickleAddress === 'string') throw new Error('missing trickle server address');
    const trickleStarted = Date.now();
    const trickled = await bootstrap.checkRegistry({
      stateFile: stateFile(), installed: '4.19.0', env: {}, force: true,
      registryUrl: `http://127.0.0.1:${trickleAddress.port}/aiden-runtime`, timeoutMs: 30,
    });
    expect(trickled).toMatchObject({ candidate: null, offline: true });
    expect(Date.now() - trickleStarted).toBeLessThan(200);

    const cachedFailureFile = stateFile();
    const firstFailure = await bootstrap.checkRegistry({
      stateFile: cachedFailureFile, installed: '4.19.0', env: {}, force: false,
      registryUrl: 'http://127.0.0.1:1/unreachable', timeoutMs: 30, now: () => 40_000,
    });
    expect(firstFailure).toMatchObject({ checked: true, offline: true });
    const cachedFailure = await bootstrap.checkRegistry({
      stateFile: cachedFailureFile, installed: '4.19.0', env: {}, force: false,
      registryUrl: 'http://127.0.0.1:1/unreachable', timeoutMs: 30, now: () => 40_001,
    });
    expect(cachedFailure).toMatchObject({ checked: false, offline: false, candidate: null });
  });

  it('honours disabled checks, cache expiry, corrupt state, skip, and remind-after', async () => {
    const disabledFile = stateFile();
    writeFileSync(disabledFile, JSON.stringify({ enabled: false, channel: 'stable' }));
    const disabled = await bootstrap.checkRegistry({
      stateFile: disabledFile, installed: '4.19.0', env: {}, force: true,
      registryUrl: 'http://127.0.0.1:1/unreachable',
    });
    expect(disabled).toMatchObject({ checked: false, candidate: null, offline: false });

    const corruptFile = stateFile();
    writeFileSync(corruptFile, '{', 'utf8');
    const url = await registry({ 'dist-tags': { latest: '4.19.1' } });
    const recovered = await bootstrap.checkRegistry({
      stateFile: corruptFile, installed: '4.19.0', env: {}, force: true, registryUrl: url,
    });
    expect(recovered.candidate).toBe('4.19.1');
    expect(() => JSON.parse(readFileSync(corruptFile, 'utf8'))).not.toThrow();

    const envDisabled = await bootstrap.checkRegistry({
      stateFile: stateFile(), installed: '4.19.0', env: { AIDEN_UPDATE_CHANNEL: 'off' }, force: true,
      registryUrl: 'http://127.0.0.1:1/unreachable',
    });
    expect(envDisabled).toMatchObject({ checked: false, candidate: null, offline: false });
  });
});

describe('bootstrap update prompt', () => {
  function ttyPair() {
    const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (value: boolean) => { input.isRaw = value; };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    let text = '';
    output.on('data', (chunk) => { text += chunk.toString(); });
    return { input, output, text: () => text };
  }

  for (const [key, expected] of [['u', 'update'], ['U', 'update'], ['l', 'later'], ['L', 'later'], ['s', 'skip'], ['S', 'skip']] as const) {
    it(`accepts ${key} as ${expected}`, async () => {
      const pair = ttyPair();
      const choice = bootstrap.promptForUpdate({
        stdin: pair.input,
        stdout: pair.output,
        installed: '4.19.0',
        candidate: '4.19.1',
        timeoutMs: 1_000,
      });
      pair.input.write(key);
      pair.input.write('u');
      await expect(choice).resolves.toBe(expected);
      expect(pair.text().match(/A new Aiden update is available/g)).toHaveLength(1);
      expect(pair.input.listenerCount('data')).toBe(0);
      expect(pair.input.isRaw).toBe(false);
    });
  }

  it('defaults to later on Enter, closed input, timeout, and non-TTY use', async () => {
    const enter = ttyPair();
    const entered = bootstrap.promptForUpdate({ stdin: enter.input, stdout: enter.output, installed: '4.19.0', candidate: '4.19.1' });
    enter.input.write('\r');
    await expect(entered).resolves.toBe('later');

    const closed = ttyPair();
    const closedChoice = bootstrap.promptForUpdate({ stdin: closed.input, stdout: closed.output, installed: '4.19.0', candidate: '4.19.1', timeoutMs: 20 });
    closed.input.end();
    await expect(closedChoice).resolves.toBe('later');

    const nonTtyInput = new PassThrough() as PassThrough & { isTTY: boolean };
    nonTtyInput.isTTY = false;
    const nonTtyOutput = new PassThrough() as PassThrough & { isTTY: boolean };
    nonTtyOutput.isTTY = false;
    await expect(bootstrap.promptForUpdate({ stdin: nonTtyInput, stdout: nonTtyOutput, installed: '4.19.0', candidate: '4.19.1' })).resolves.toBe('later');
  });

  it('treats Ctrl+C as cancellation and restores terminal input', async () => {
    const pair = ttyPair();
    const choice = bootstrap.promptForUpdate({
      stdin: pair.input,
      stdout: pair.output,
      installed: '4.19.0',
      candidate: '4.19.1',
      timeoutMs: 1_000,
    });
    pair.input.write('\u0003');
    await expect(choice).resolves.toBe('cancel');
    expect(pair.input.isRaw).toBe(false);
    expect(pair.input.listenerCount('data')).toBe(0);
  });
});
