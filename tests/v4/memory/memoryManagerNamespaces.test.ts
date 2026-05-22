/**
 * tests/v4/memory/memoryManagerNamespaces.test.ts — v4.9.0 Slice 11.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../../../core/v4/memoryManager';
import { resolveAidenPaths } from '../../../core/v4/paths';

let root: string, projectRoot: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-ns-mm-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-ns-proj-'));
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
});

describe('MemoryManager namespace integration — Slice 11', () => {
  it('writes to memory + user (legacy behavior preserved)', async () => {
    const mgr = new MemoryManager({ paths: resolveAidenPaths({ rootOverride: root }) });
    expect((await mgr.add('memory', 'mem entry')).ok).toBe(true);
    expect((await mgr.add('user',   'user pref')).ok).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toContain('mem entry');
    expect(snap.userMd).toContain('user pref');
  });

  it('writes to project namespace when projectRoot set', async () => {
    const paths = resolveAidenPaths({ rootOverride: root });
    const mgr = new MemoryManager({ paths, projectRoot });
    expect((await mgr.add('project', 'this repo uses TS')).ok).toBe(true);
    const filePath = path.join(projectRoot, '.aiden', 'PROJECT.md');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('this repo uses TS');
  });

  it('project namespace without root throws', async () => {
    const mgr = new MemoryManager({ paths: resolveAidenPaths({ rootOverride: root }) });
    await expect(mgr.add('project', 'no root')).rejects.toThrow(/requires a project root/);
  });

  it('snapshot.files map contains entries for available namespaces', async () => {
    const paths = resolveAidenPaths({ rootOverride: root });
    const mgr = new MemoryManager({ paths, projectRoot });
    await mgr.add('memory',  'm');
    await mgr.add('user',    'u');
    await mgr.add('project', 'p');
    const snap = await mgr.loadSnapshot();
    expect(snap.files).toBeDefined();
    expect(Object.keys(snap.files!).sort()).toEqual(['memory', 'project', 'user']);
    expect(snap.files!['project'].charLimit).toBe(1800);
  });

  it('snapshot.files omits project when no projectRoot', async () => {
    const mgr = new MemoryManager({ paths: resolveAidenPaths({ rootOverride: root }) });
    await mgr.add('memory', 'm');
    const snap = await mgr.loadSnapshot();
    expect(Object.keys(snap.files!).sort()).toEqual(['memory', 'user']);
  });

  it('charLimitFor returns the registry-defined caps', () => {
    const mgr = new MemoryManager({ paths: resolveAidenPaths({ rootOverride: root }), projectRoot });
    expect(mgr.charLimitFor('memory')).toBe(2200);
    expect(mgr.charLimitFor('user')).toBe(1375);
    expect(mgr.charLimitFor('project')).toBe(1800);
  });

  it('backward-compat: legacy constructor (AidenPaths) still works', async () => {
    const mgr = new MemoryManager(resolveAidenPaths({ rootOverride: root }));
    expect((await mgr.add('memory', 'legacy')).ok).toBe(true);
    expect(mgr.projectRoot).toBeNull();
  });

  it('legacy memoryMd / userMd snapshot fields stay populated', async () => {
    const mgr = new MemoryManager({ paths: resolveAidenPaths({ rootOverride: root }) });
    await mgr.add('memory', 'M');
    await mgr.add('user',   'U');
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toBe('M');
    expect(snap.userMd).toBe('U');
  });
});
