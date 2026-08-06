import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const bootstrap = require(path.join(repoRoot, 'bin', 'aiden-bootstrap.cjs'));
let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

function fixture(): { packageRoot: string; home: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'aiden-bootstrap-choice-'));
  const packageRoot = path.join(root, 'node_modules', 'aiden-runtime');
  const home = path.join(root, 'home');
  mkdirSync(path.join(packageRoot, 'dist', 'cli', 'v4'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'dist', 'core'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'aiden-runtime', version: '4.19.0' }));
  writeFileSync(path.join(packageRoot, 'dist', 'core', 'version.js'), '');
  writeFileSync(path.join(packageRoot, 'dist', 'cli', 'v4', 'aidenCLI.js'), "if(process.send)process.send({type:'aiden-bootstrap-ready'});");
  writeFileSync(path.join(packageRoot, 'bin', 'aiden-updater.cjs'), '');
  return { packageRoot, home };
}

function ttyPair() {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value: boolean) => { stdin.isRaw = value; };
  const stdout = new PassThrough() as PassThrough & { isTTY: boolean };
  stdout.isTTY = true;
  return { stdin, stdout };
}

async function registry(): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      'dist-tags': { latest: '4.19.1' },
      versions: { '4.19.0': {}, '4.19.1': {} },
    }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing registry address');
  return `http://127.0.0.1:${address.port}/aiden-runtime`;
}

describe.skipIf(![20, 22].includes(Number.parseInt(process.versions.node.split('.')[0], 10)))(
  'bootstrap update choice persistence',
  () => {
  it.each([
    { key: 'l', field: 'remindAfter' },
    { key: 's', field: 'skippedVersion' },
  ])('persists $field outside the npm package and starts the current runtime', async ({ key, field }) => {
    const { packageRoot, home } = fixture();
    const io = ttyPair();
    const registryUrl = await registry();
    const run = bootstrap.runBootstrap({
      packageRoot,
      args: [],
      env: {
        ...process.env,
        AIDEN_HOME: home,
        AIDEN_UPDATE_REGISTRY_URL: registryUrl,
      },
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: new PassThrough(),
      cwd: home,
    });
    io.stdin.write(key);
    await expect(run).resolves.toBe(0);
    const state = JSON.parse(readFileSync(path.join(home, '.update_check.json'), 'utf8'));
    if (field === 'remindAfter') expect(state.remindAfter).toBeGreaterThan(Date.now());
    else expect(state.skippedVersion).toBe('4.19.1');
    expect(path.dirname(path.join(home, '.update_check.json'))).toBe(home);
  });
  },
);
