import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeWindowsUpdateResult,
  prepareWindowsUpdateHelper,
} from '../../../../core/v4/update/windowsUpdateHelper';
import type { UpdateInstallPlan } from '../../../../core/v4/update/installPreflight';

const roots: string[] = [];

function plan(): UpdateInstallPlan {
  return {
    provenance: 'npm-global',
    scope: 'user',
    targetVersion: '4.16.0',
    installAllowed: true,
    reason: 'ready',
    npmExecutable: 'C:\\Users\\x\\npm.cmd',
    prefix: 'C:\\Users\\x',
    globalRoot: 'C:\\Users\\x\\node_modules',
    packagePath: 'C:\\Users\\x\\node_modules\\aiden-runtime',
    currentPackagePath: 'C:\\Users\\x\\node_modules\\aiden-runtime',
    guidance: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

describe('Windows update helper', () => {
  it('copies a detached helper outside the running package and passes only file arguments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-updater-helper-'));
    roots.push(root);
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    const prepared = await prepareWindowsUpdateHelper({
      stateDir: root,
      plan: plan(),
      parentPid: 1234,
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      spawnImpl: spawnImpl as never,
    });

    expect(prepared.scheduled).toBe(true);
    expect(prepared.helperPath.startsWith(root)).toBe(true);
    expect(await fs.readFile(prepared.helperPath, 'utf8')).not.toContain('Administrator');
    expect(spawnImpl).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      [prepared.helperPath, prepared.statePath],
      expect.objectContaining({
        detached: true,
        shell: false,
        stdio: 'ignore',
      }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('consumes a sanitized result once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-updater-result-'));
    roots.push(root);
    const resultFile = path.join(root, 'update-result.json');
    await fs.writeFile(resultFile, JSON.stringify({
      success: false,
      kind: 'permission',
      targetVersion: '4.16.0',
      prefix: 'C:\\Users\\Śhiva\\npm',
      completedAt: 42,
      rawOutput: 'must not surface',
    }));
    const result = await consumeWindowsUpdateResult(root);
    expect(result).toEqual({
      success: false,
      kind: 'permission',
      targetVersion: '4.16.0',
      prefix: 'C:\\Users\\Śhiva\\npm',
      completedAt: 42,
    });
    expect(await fs.stat(resultFile).then(() => true, () => false)).toBe(false);
    expect(await consumeWindowsUpdateResult(root)).toBeNull();
  });
});
