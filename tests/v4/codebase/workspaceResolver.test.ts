import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { isSameWorkspacePath, resolveWorkspace } from '../../../core/v4/codebase/workspaceResolver';

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-workspace-'));
  roots.push(root);
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('canonical workspace resolution', () => {
  it('realpaths existing aliases and safely appends a non-existing child', async () => {
    const root = await temp();
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    await mkdir(actual);
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const existing = await resolveWorkspace(alias);
    const missing = await resolveWorkspace(path.join(alias, 'future', 'file.ts'));
    expect(existing.canonicalPath).toBe(await (await import('node:fs/promises')).realpath(actual));
    expect(missing.canonicalPath).toBe(path.join(existing.canonicalPath, 'future', 'file.ts'));
    expect(existing.id).toBe((await resolveWorkspace(actual)).id);
    expect(isSameWorkspacePath(alias, actual)).toBe(true);
    expect(existing.id).not.toBe(missing.id);
  });

  it('identifies nested repositories and linked worktree metadata', async () => {
    const root = await temp();
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(root, 'README.md'), 'root');
    execFileSync('git', ['-C', root, 'add', 'README.md']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    execFileSync('git', ['init', '-q', nested]);
    expect((await resolveWorkspace(nested)).outerRepositoryRoot).toBe(await (await import('node:fs/promises')).realpath(root));

    const linked = path.join(await temp(), 'linked');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'linked-test', linked]);
    const descriptor = await resolveWorkspace(linked);
    expect(descriptor.repositoryRoot).toBe(await (await import('node:fs/promises')).realpath(linked));
    expect(descriptor.gitDirectory).not.toBe(descriptor.gitCommonDirectory);
  });

  it.runIf(process.platform === 'win32')('normalizes Windows case and separator aliases', async () => {
    const root = await temp();
    const alternate = root.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
    expect((await resolveWorkspace(root)).id).toBe((await resolveWorkspace(alternate)).id);
  });

  it('distinguishes requested subdirectory from the nearest Git root', async () => {
    const root = await temp();
    execFileSync('git', ['init', '-q', root]);
    const child = path.join(root, 'src');
    await mkdir(child);
    const descriptor = await resolveWorkspace(child);
    expect(descriptor.vcsKind).toBe('git');
    expect(descriptor.repositoryRoot).toBe(await (await import('node:fs/promises')).realpath(root));
    expect(descriptor.canonicalPath).toBe(await (await import('node:fs/promises')).realpath(child));
  });

  it('supports deterministic non-Git folders', async () => {
    const root = await temp();
    await writeFile(path.join(root, 'package.json'), '{}');
    const first = await resolveWorkspace(root);
    const second = await resolveWorkspace(root);
    expect(first).toEqual(second);
    expect(first.vcsKind).toBe('none');
  });
});
