import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const currentNodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
const localNode22 = path.join(process.env.LOCALAPPDATA ?? '', 'node-v22.23.1-win-x64', 'node.exe');
const supportedNode = currentNodeMajor === 20 || currentNodeMajor === 22 ? process.execPath : localNode22;
const cleanup: string[] = [];
let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, output: () => string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`PTY timeout:\n${output().slice(-4_000)}`));
      }
    }, 25);
  });
}

describe.skipIf(process.platform !== 'win32')('bootstrap update ConPTY', () => {
  it.each(['4.18.0', '4.19.0'])(
    'updates v%s through the owning prefix, verifies, preserves data, and exits cleanly',
    async (previousVersion) => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiden update physical fixture '));
    cleanup.push(root);
    const prefix = path.join(root, 'prefix with spaces');
    const packageRoot = path.join(prefix, 'node_modules', 'aiden-runtime');
    const cliDir = path.join(packageRoot, 'dist', 'cli', 'v4');
    const coreDir = path.join(packageRoot, 'dist', 'core');
    const binDir = path.join(packageRoot, 'bin');
    const nativeDir = path.join(packageRoot, 'node_modules', 'better-sqlite3');
    const npmDir = path.join(root, 'fake npm with spaces');
    const npmCli = path.join(npmDir, 'npm-cli.js');
    const aidenHome = path.join(root, 'aiden-home');
    const tempRoot = path.join(root, 'temporary-updaters');
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    mkdirSync(npmDir, { recursive: true });
    mkdirSync(aidenHome, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'aiden-runtime', version: previousVersion }), 'utf8');
    writeFileSync(path.join(aidenHome, 'preserved-workspace-marker.txt'), 'preserve-me', 'utf8');
    writeFileSync(path.join(coreDir, 'version.js'), '', 'utf8');
    writeFileSync(path.join(cliDir, 'aidenCLI.js'), [
      "const manifest=require('../../../package.json');",
      "if(process.argv.includes('--version')){process.stdout.write(manifest.version+'\\n');}",
      "else{if(process.send)process.send({type:'aiden-bootstrap-ready'});process.stdout.write('MAIN_STARTED\\n');}",
    ].join(''), 'utf8');
    writeFileSync(path.join(nativeDir, 'index.js'), [
      'module.exports=class Database{',
      "constructor(_name){} prepare(){return {get(){return {ok:1}}}} close(){}",
      '};',
    ].join(''), 'utf8');
    writeFileSync(npmCli, [
      "const fs=require('node:fs');const path=require('node:path');",
      "const args=process.argv.slice(2);",
      "if(args[0]==='prefix'){process.stdout.write(process.env.FIXTURE_PREFIX+'\\n');process.exit(0);}",
      "if(args[0]==='root'){process.stdout.write(path.join(process.env.FIXTURE_PREFIX,'node_modules')+'\\n');process.exit(0);}",
      "if(args[0]==='install'){setTimeout(()=>{const file=path.join(process.env.FIXTURE_PACKAGE_ROOT,'package.json');const p=JSON.parse(fs.readFileSync(file,'utf8'));p.version='4.19.1';fs.writeFileSync(file,JSON.stringify(p));process.exit(0);},350);}",
      "else{process.exit(2);}",
    ].join(''), 'utf8');
    writeFileSync(path.join(packageRoot, '.aiden-install.json'), JSON.stringify({
      schemaVersion: 1,
      global: true,
      prefix,
      npmCli,
      nodeExecutable: supportedNode,
      installedAt: Date.now(),
    }), 'utf8');
    for (const file of ['aiden-bootstrap.cjs', 'aiden-updater.cjs']) {
      writeFileSync(path.join(binDir, file), readFileSync(path.join(repoRoot, 'bin', file), 'utf8'), 'utf8');
    }

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        'dist-tags': { latest: '4.19.1' },
        versions: { '4.18.0': {}, '4.19.0': {}, '4.19.1': {} },
      }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing registry address');

    const child = pty.spawn(supportedNode, [path.join(binDir, 'aiden-bootstrap.cjs')], {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: root,
      env: {
        ...process.env,
        AIDEN_HOME: aidenHome,
        AIDEN_UPDATE_REGISTRY_URL: `http://127.0.0.1:${address.port}/aiden-runtime`,
        FIXTURE_PREFIX: prefix,
        FIXTURE_PACKAGE_ROOT: packageRoot,
        npm_execpath: npmCli,
        NPM_EXECPATH: npmCli,
        npm_command: '',
        NPM_COMMAND: '',
        TEMP: tempRoot,
        TMP: tempRoot,
        FORCE_COLOR: '1',
        NO_COLOR: '',
      },
    });
    let raw = '';
    let exitCode: number | null = null;
    const dataSubscription = child.onData((chunk) => { raw += chunk; });
    const exitSubscription = child.onExit((event) => { exitCode = event.exitCode; });
    try {
      await waitFor(() => raw.includes('A new Aiden update is available'), () => raw);
      child.write('u');
      await waitFor(() => raw.includes('Installing package'), () => raw);
      child.resize(44, 20);
      child.resize(100, 30);
      await waitFor(() => raw.includes('Aiden was updated successfully'), () => raw);
      await waitFor(() => exitCode !== null, () => raw);
      expect(exitCode).toBe(0);
      expect(JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version).toBe('4.19.1');
      expect(raw.match(/Aiden was updated successfully/g)).toHaveLength(1);
      expect(raw).toContain('Installation verified');
      expect(raw).toContain('Restart Aiden');
      expect(raw).not.toContain('MAIN_STARTED');
      expect(raw).not.toMatch(/NODE_MODULE_VERSION|at Module\._/);
      expect(readFileSync(path.join(aidenHome, 'preserved-workspace-marker.txt'), 'utf8')).toBe('preserve-me');
      expect(readdirSync(tempRoot).filter((name) => name.startsWith('aiden-update-'))).toHaveLength(0);
    } finally {
      dataSubscription.dispose();
      exitSubscription.dispose();
      if (exitCode === null) child.kill();
    }
    },
    30_000,
  );
});
