import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const updater = require(path.join(root, 'bin', 'aiden-updater.cjs'));

function state(overrides: Record<string, unknown> = {}) {
  return {
    targetVersion: '4.19.1',
    previousVersion: '4.19.0',
    packageName: 'aiden-runtime',
    nodeExecutable: process.execPath,
    npmCli: process.execPath,
    prefix: path.join(root, 'tmp prefix'),
    globalRoot: path.join(root, 'tmp prefix', 'node_modules'),
    packagePath: path.join(root, 'tmp prefix', 'node_modules', 'aiden-runtime'),
    tty: false,
    color: false,
    ...overrides,
  };
}

function outputSink() {
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk.toString(); });
  return { output, text: () => text };
}

describe('external update helper', () => {
  it('requires the permanent bootstrap for new releases but can verify a restored 4.19.0 layout', () => {
    const packagePath = mkdtempSync(path.join(tmpdir(), 'aiden-updater-files-'));
    mkdirSync(path.join(packagePath, 'dist', 'cli', 'v4'), { recursive: true });
    mkdirSync(path.join(packagePath, 'dist', 'core'), { recursive: true });
    writeFileSync(path.join(packagePath, 'dist', 'cli', 'v4', 'aidenCLI.js'), '');
    writeFileSync(path.join(packagePath, 'dist', 'core', 'version.js'), '');
    writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name: 'aiden-runtime', version: '4.19.0' }));
    expect(updater.verifyFiles(state({ packagePath, targetVersion: '4.19.0' }))).toMatchObject({ ok: true });
    writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name: 'aiden-runtime', version: '4.19.1' }));
    expect(updater.verifyFiles(state({ packagePath, targetVersion: '4.19.1' }))).toMatchObject({
      ok: false,
      kind: 'file-verification',
    });
  });

  it('rejects unsafe versions before invoking the package manager', async () => {
    const install = vi.fn();
    const sink = outputSink();
    const code = await updater.runUpdater(state({ targetVersion: '4.19.1 & whoami' }), {
      output: sink.output,
      installVersion: install,
    });
    expect(code).toBe(2);
    expect(install).not.toHaveBeenCalled();
  });

  it('installs an exact version, verifies it, and settles one receipt', async () => {
    const install = vi.fn(async () => ({ ok: true }));
    const verify = vi.fn(async () => ({ ok: true }));
    const sink = outputSink();
    const code = await updater.runUpdater(state(), {
      output: sink.output,
      installVersion: install,
      verifyInstalledPackage: verify,
    });
    expect(code).toBe(0);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0][1]).toBe('4.19.1');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(sink.text().match(/Aiden was updated successfully/g)).toHaveLength(1);
    expect(sink.text()).toContain('Restart Aiden');
    expect(sink.text()).not.toContain('\x1b');
  });

  it('attempts a verified rollback and does not claim target success when installation fails', async () => {
    const install = vi.fn()
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce({ ok: true });
    const sink = outputSink();
    const code = await updater.runUpdater(state(), {
      output: sink.output,
      installVersion: install,
      verifyInstalledPackage: vi.fn(async () => ({ ok: true })),
    });
    expect(code).toBe(1);
    expect(install).toHaveBeenNthCalledWith(2, expect.anything(), '4.19.0', { signal: expect.any(AbortSignal) });
    expect(sink.text()).toContain('Installation failed (network)');
    expect(sink.text()).toContain('4.19.0 was restored and verified');
    expect(sink.text()).not.toContain('Aiden was updated successfully');
  });

  it('reports repair required when installation and rollback both fail', async () => {
    const sink = outputSink();
    const code = await updater.runUpdater(state(), {
      output: sink.output,
      installVersion: vi.fn(async () => ({ ok: false, kind: 'package-manager' })),
      verifyInstalledPackage: vi.fn(async () => ({ ok: true })),
    });
    expect(code).toBe(1);
    expect(sink.text()).toContain('The previous version could not be verified.');
    expect(sink.text()).toContain('npm install -g aiden-runtime@latest');
    expect(sink.text()).not.toContain('Aiden was updated successfully');
  });

  it('attempts a verified rollback after target verification fails', async () => {
    const install = vi.fn(async () => ({ ok: true }));
    const verify = vi.fn()
      .mockResolvedValueOnce({ ok: false, kind: 'native-verification' })
      .mockResolvedValueOnce({ ok: true });
    const sink = outputSink();
    const code = await updater.runUpdater(state(), {
      output: sink.output,
      installVersion: install,
      verifyInstalledPackage: verify,
    });
    expect(code).toBe(1);
    expect(install).toHaveBeenNthCalledWith(1, expect.anything(), '4.19.1', { signal: expect.any(AbortSignal) });
    expect(install).toHaveBeenNthCalledWith(2, expect.anything(), '4.19.0', { signal: expect.any(AbortSignal) });
    expect(sink.text()).toContain('4.19.0 was restored and verified');
    expect(sink.text()).not.toContain('Aiden was updated successfully');
  });

  it('uses one shared animation timer and restores the cursor on settlement', () => {
    vi.useFakeTimers();
    const sink = outputSink();
    Object.assign(sink.output, { isTTY: true });
    const renderer = updater.createRenderer({ output: sink.output, tty: true, color: true });
    renderer.start('Installing package');
    expect(renderer.hasTimer()).toBe(true);
    vi.advanceTimersByTime(400);
    renderer.settle('Installation complete');
    expect(renderer.hasTimer()).toBe(false);
    renderer.stop();
    expect(sink.text()).toContain('\x1b[?25h');
    vi.useRealTimers();
  });

  it('uses stable text without ANSI or duplicate settlement when color is disabled', () => {
    const sink = outputSink();
    Object.assign(sink.output, { isTTY: true });
    const renderer = updater.createRenderer({ output: sink.output, tty: true, color: false });
    renderer.start('Verifying installation');
    renderer.settle('Verification complete');
    renderer.settle('Verification complete');
    renderer.stop();
    expect(sink.text()).not.toContain('\x1b');
    expect(sink.text().match(/Verification complete/g)).toHaveLength(1);
    expect(renderer.hasTimer()).toBe(false);
  });
});
