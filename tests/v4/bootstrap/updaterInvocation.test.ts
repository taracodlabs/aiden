import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const updater = require(path.join(root, 'bin', 'aiden-updater.cjs'));

describe('package-manager invocation', () => {
  it('passes an exact package spec and a prefix containing spaces as separate arguments', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiden npm fixture '));
    const log = path.join(dir, 'args.json');
    const npmCli = path.join(dir, 'fake npm cli.js');
    writeFileSync(npmCli, `require('node:fs').writeFileSync(process.env.ARG_LOG, JSON.stringify({ args: process.argv.slice(2), path: process.env.Path || process.env.PATH }));`, 'utf8');
    const prefix = path.join(dir, 'isolated prefix with spaces');
    const result = await updater.installVersion({
      nodeExecutable: process.execPath,
      npmCli,
      prefix,
      packageName: 'aiden-runtime',
    }, '4.19.1', { signal: new AbortController().signal, env: { ...process.env, ARG_LOG: log } });
    expect(result).toMatchObject({ ok: true });
    const invocation = JSON.parse(readFileSync(log, 'utf8'));
    expect(invocation.args).toEqual([
      'install',
      '--global',
      '--prefix',
      prefix,
      'aiden-runtime@4.19.1',
      '--no-audit',
      '--no-fund',
    ]);
    expect(invocation.path.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
  });

  it('rejects an injected package version before a child process starts', async () => {
    const result = await updater.installVersion({
      nodeExecutable: process.execPath,
      npmCli: path.join(tmpdir(), 'should-not-run.js'),
      prefix: tmpdir(),
      packageName: 'aiden-runtime',
    }, '4.19.1 && whoami');
    expect(result).toEqual({ ok: false, kind: 'invalid-version' });
  });

  it('terminates a timed-out child without leaving its timer active', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiden child cleanup '));
    const script = path.join(dir, 'wait.js');
    writeFileSync(script, 'setInterval(() => {}, 1000);', 'utf8');
    const started = Date.now();
    const result = await updater.runChild(process.execPath, [script], { timeoutMs: 100 });
    expect(result).toMatchObject({ code: -1, timeout: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
