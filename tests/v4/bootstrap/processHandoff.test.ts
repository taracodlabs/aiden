import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const bootstrap = path.join(root, 'bin', 'aiden-bootstrap.cjs');
const currentNodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
const localNode22 = path.join(process.env.LOCALAPPDATA ?? '', 'node-v22.23.1-win-x64', 'node.exe');
const supportedNode = currentNodeMajor === 20 || currentNodeMajor === 22 ? process.execPath : localNode22;

function fixture(cliSource: string): string {
  const packageRoot = mkdtempSync(path.join(tmpdir(), 'aiden-handoff-'));
  mkdirSync(path.join(packageRoot, 'dist', 'cli', 'v4'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'dist', 'core'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'aiden-runtime', version: '4.19.0' }));
  writeFileSync(path.join(packageRoot, 'dist', 'core', 'version.js'), '', 'utf8');
  writeFileSync(path.join(packageRoot, 'bin', 'aiden-updater.cjs'), '', 'utf8');
  writeFileSync(path.join(packageRoot, 'dist', 'cli', 'v4', 'aidenCLI.js'), cliSource, 'utf8');
  return packageRoot;
}

function runFixture(packageRoot: string, args: string[], cwd = tmpdir()) {
  const driver = [
    `const bootstrap=require(${JSON.stringify(bootstrap)});`,
    `bootstrap.runBootstrap({packageRoot:${JSON.stringify(packageRoot)},args:${JSON.stringify(args)},cwd:${JSON.stringify(cwd)},env:{...process.env,AIDEN_BOOTSTRAP_SKIP_UPDATE:'1',AIDEN_NO_UPDATE_CHECK:'1'}})`,
    `.then(code=>{process.exitCode=code});`,
  ].join('');
  return spawnSync(supportedNode, ['-e', driver], { encoding: 'utf8', cwd, timeout: 20_000 });
}

describe('bootstrap process handoff', () => {
  it('forwards arguments, working directory, and child exit code exactly', () => {
    const unrelated = mkdtempSync(path.join(tmpdir(), 'aiden unrelated path '));
    const packageRoot = fixture([
      "if(process.send)process.send({type:'aiden-bootstrap-ready'});",
      "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));",
      'process.exitCode=7;',
    ].join(''));
    const result = runFixture(packageRoot, ['--flag', 'value with spaces', '--', 'literal'], unrelated);
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['--flag', 'value with spaces', '--', 'literal'],
      cwd: realpathSync.native(unrelated),
    });
  });

  it('translates a pre-ready ABI crash and suppresses its raw stack by default', () => {
    const packageRoot = fixture([
      "process.stderr.write('Error: better_sqlite3.node was compiled against NODE_MODULE_VERSION 137. This version requires NODE_MODULE_VERSION 127.\\n at native-loader:1\\n');",
      'process.exitCode=1;',
    ].join(''));
    const result = runFixture(packageRoot, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('installed using a different Node version');
    expect(result.stderr).toContain('npm install -g aiden-runtime@latest');
    expect(result.stderr).not.toContain('native-loader');
  });

  it('forwards an intentional command failure without inventing a startup diagnostic', () => {
    const packageRoot = fixture("process.stdout.write('doctor found a configuration problem\\n');process.exitCode=1;");
    const result = runFixture(packageRoot, ['doctor']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('configuration problem');
    expect(result.stderr).toBe('');
  });

  it('preserves unknown diagnostics only when debug output is explicitly enabled', () => {
    const packageRoot = fixture("process.stderr.write('Error: unusual startup failure\\n at hidden-detail:1\\n');process.exitCode=1;");
    const normal = runFixture(packageRoot, []);
    expect(normal.stderr).toMatch(/Diagnostic:/);
    expect(normal.stderr).not.toContain('hidden-detail');

    const driver = [
      `const bootstrap=require(${JSON.stringify(bootstrap)});`,
      `bootstrap.runBootstrap({packageRoot:${JSON.stringify(packageRoot)},args:[],env:{...process.env,AIDEN_BOOTSTRAP_SKIP_UPDATE:'1',AIDEN_NO_UPDATE_CHECK:'1',AIDEN_BOOTSTRAP_DEBUG:'1'}})`,
      `.then(code=>{process.exitCode=code});`,
    ].join('');
    const debug = spawnSync(supportedNode, ['-e', driver], { encoding: 'utf8', timeout: 20_000 });
    expect(debug.stderr).toContain('hidden-detail');
  });
});
