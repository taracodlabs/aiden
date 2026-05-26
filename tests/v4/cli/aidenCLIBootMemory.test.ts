/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 SLICE 10.1b — REPL boot-wire integration test.
 *
 * THE bug this guards: Slice 10.1 added the `project` memory namespace
 * to the tool surface but the REPL boot site at aidenCLI.ts:1130
 * constructed `new MemoryManager(paths)` without a projectRoot. Every
 * chat-time `memory_add file=project` call hit projectRoot=null and
 * threw via namespaceRegistry.resolve. Manual smoke caught it;
 * Slice 10.1's unit tests didn't, because each test explicitly
 * constructed `new MemoryManager({ paths, projectRoot: tmpDir })` —
 * the production boot site was never exercised.
 *
 * Slice 10.1b extracts `createBootMemoryManager(paths, cwd)` as the
 * single source of truth for the REPL's MemoryManager construction.
 * Production calls it with no cwd arg (defaults to process.cwd()).
 * This test calls it with explicit cwds.
 *
 * Discipline: this test MUST NOT use `new MemoryManager({ paths,
 * projectRoot })` anywhere. The whole point is to exercise the
 * boot wire. If a future refactor severs the wire — e.g. someone
 * reverts to `new MemoryManager(paths)` inline at the boot site, or
 * extracts a different helper that forgets to call findProjectRoot —
 * these tests fail.
 *
 * The mock-blindness lesson recurring three times this sprint
 * (v4.9.1, Slice 1, Slice 10.1) is the reason this test exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBootMemoryManager } from '../../../cli/v4/aidenCLI';
import { MemoryGuard } from '../../../moat/memoryGuard';
import { memoryAddTool } from '../../../tools/v4/memory/memoryAdd';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { _resetProjectRootCacheForTests } from '../../../core/v4/memory/projectRoot';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let aidenRoot: string;
let repoA: string;
let repoB: string;
let noProjectCwd: string;

beforeEach(async () => {
  aidenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-boot-mem-root-'));
  repoA = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-boot-mem-repoA-'));
  repoB = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-boot-mem-repoB-'));
  noProjectCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-boot-mem-bare-'));
  // Mark each repo dir as a git project (matches the standard anchor
  // findProjectRoot probes — .git is the first ANCHOR in projectRoot.ts).
  await fs.mkdir(path.join(repoA, '.git'), { recursive: true });
  await fs.mkdir(path.join(repoB, '.git'), { recursive: true });
  // noProjectCwd deliberately has NO anchor — bare directory.

  // Reset the per-process projectRoot cache so test ordering doesn't
  // contaminate detection results across cases.
  _resetProjectRootCacheForTests();
});

afterEach(async () => {
  await Promise.all([
    fs.rm(aidenRoot, { recursive: true, force: true }),
    fs.rm(repoA, { recursive: true, force: true }),
    fs.rm(repoB, { recursive: true, force: true }),
    fs.rm(noProjectCwd, { recursive: true, force: true }),
  ]);
});

/** Build a real ToolContext from a boot-constructed MemoryManager. */
function ctxFor(cwd: string): ToolContext {
  const paths = resolveAidenPaths({ rootOverride: aidenRoot });
  // ── THIS IS THE CODE PATH UNDER TEST ──
  // Identical signature to the production boot site at
  // cli/v4/aidenCLI.ts:1130. If a future refactor severs the
  // projectRoot wiring inside this helper, every test in this file
  // fails. That's the intended regression layer.
  const memoryManager = createBootMemoryManager(paths, cwd);
  const memoryGuard = new MemoryGuard(memoryManager);
  return {
    cwd,
    paths,
    memoryGuard,
    memory: memoryManager,
  };
}

describe('REPL boot wire — createBootMemoryManager (v4.10 Slice 10.1b regression layer)', () => {
  it('memory_add file=project writes to <cwd>/.aiden/PROJECT.md when cwd has a .git anchor', async () => {
    const ctx = ctxFor(repoA);
    const r = (await memoryAddTool.execute(
      { file: 'project', content: 'repo-a-note' },
      ctx,
    )) as { success: boolean; verified: boolean; error?: string };

    expect(r.success, `add failed: ${r.error}`).toBe(true);
    expect(r.verified).toBe(true);

    const projectFile = path.join(repoA, '.aiden', 'PROJECT.md');
    const onDisk = await fs.readFile(projectFile, 'utf8');
    expect(onDisk).toContain('repo-a-note');
  });

  it('two different cwds produce two different PROJECT.md files (project isolation)', async () => {
    // Acceptance criterion: "running aiden in two different repos shows
    // different PROJECT.md files." Each boot picks up the cwd's project
    // root; writes must land on distinct disk paths.
    const ctxA = ctxFor(repoA);
    const ctxB = ctxFor(repoB);

    await memoryAddTool.execute({ file: 'project', content: 'note-from-A' }, ctxA);
    await memoryAddTool.execute({ file: 'project', content: 'note-from-B' }, ctxB);

    const pathA = path.join(repoA, '.aiden', 'PROJECT.md');
    const pathB = path.join(repoB, '.aiden', 'PROJECT.md');

    const contentA = await fs.readFile(pathA, 'utf8');
    const contentB = await fs.readFile(pathB, 'utf8');

    expect(contentA).toContain('note-from-A');
    expect(contentA).not.toContain('note-from-B');
    expect(contentB).toContain('note-from-B');
    expect(contentB).not.toContain('note-from-A');

    // Disk paths must differ — the whole point of project isolation.
    expect(pathA).not.toBe(pathB);
  });

  it('returns synthetic failure (not throw) when cwd has no project anchor', async () => {
    // noProjectCwd is a bare tmpdir — no .git, no package.json, no
    // .aiden/PROJECT.md. createBootMemoryManager resolves projectRoot
    // to null; memoryAdd must return a structured error, not crash.
    const ctx = ctxFor(noProjectCwd);
    const r = (await memoryAddTool.execute(
      { file: 'project', content: 'should-fail' },
      ctx,
    )) as { success: boolean; error?: string };

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/project namespace requires a project root/i);
    // And NOTHING should have been written to disk anywhere.
    await expect(fs.access(path.join(noProjectCwd, '.aiden', 'PROJECT.md')))
      .rejects.toThrow();
  });

  it('detects parent directory anchors (walk-up matches projectRoot.ts contract)', async () => {
    // findProjectRoot walks UP from cwd looking for anchors. A
    // subdirectory of a git repo should resolve to the repo root.
    const subdir = path.join(repoA, 'src', 'nested');
    await fs.mkdir(subdir, { recursive: true });

    const ctx = ctxFor(subdir);
    const r = (await memoryAddTool.execute(
      { file: 'project', content: 'from-subdir' },
      ctx,
    )) as { success: boolean; verified: boolean; error?: string };

    expect(r.success, `add failed: ${r.error}`).toBe(true);
    // File should land at the REPO ROOT, not the subdir.
    const repoPath = path.join(repoA, '.aiden', 'PROJECT.md');
    const subdirPath = path.join(subdir, '.aiden', 'PROJECT.md');
    const repoContent = await fs.readFile(repoPath, 'utf8');
    expect(repoContent).toContain('from-subdir');
    await expect(fs.access(subdirPath)).rejects.toThrow();
  });

  it('user + global memory still work when cwd has no project root (no regression)', async () => {
    // The boot wire should not break the existing memory + user
    // namespaces. They don't depend on projectRoot, so a null
    // projectRoot must not break them.
    const ctx = ctxFor(noProjectCwd);

    const r1 = (await memoryAddTool.execute(
      { file: 'memory', content: 'global-note' },
      ctx,
    )) as { success: boolean; error?: string };
    expect(r1.success, `memory add failed: ${r1.error}`).toBe(true);

    const r2 = (await memoryAddTool.execute(
      { file: 'user', content: 'user-pref' },
      ctx,
    )) as { success: boolean; error?: string };
    expect(r2.success, `user add failed: ${r2.error}`).toBe(true);

    // Both land under aidenRoot (the AidenPaths root), NOT noProjectCwd.
    const memoryContent = await fs.readFile(ctx.paths!.memoryMd, 'utf8');
    const userContent   = await fs.readFile(ctx.paths!.userMd,   'utf8');
    expect(memoryContent).toContain('global-note');
    expect(userContent).toContain('user-pref');
  });
});

// ─── Helper contract checks ──────────────────────────────────────────

describe('createBootMemoryManager — helper contract', () => {
  it('defaults cwd to process.cwd() (production callers omit the arg)', () => {
    // Production calls `createBootMemoryManager(paths)` at
    // aidenCLI.ts:1130. We can't assert on the resolved projectRoot
    // here (process.cwd() in vitest is the repo root, which IS a
    // project — would just be a tautology), but we CAN assert the
    // helper accepts a no-cwd call and returns a MemoryManager.
    const paths = resolveAidenPaths({ rootOverride: aidenRoot });
    const mgr = createBootMemoryManager(paths);
    expect(mgr).toBeDefined();
    // projectRoot may be null or a string depending on test cwd —
    // both are valid per the contract. We just verify no throw.
  });
});
