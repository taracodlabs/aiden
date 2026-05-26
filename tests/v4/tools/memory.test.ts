import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryManager } from '../../../core/v4/memoryManager';
import { MemoryGuard } from '../../../moat/memoryGuard';
import { memoryAddTool } from '../../../tools/v4/memory/memoryAdd';
import { memoryReplaceTool } from '../../../tools/v4/memory/memoryReplace';
import { memoryRemoveTool } from '../../../tools/v4/memory/memoryRemove';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let projectDir: string;
let mgr: MemoryManager;
let mgrNoProject: MemoryManager;
let ctx: ToolContext;
let ctxNoProject: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mem-tool-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mem-tool-proj-'));
  const paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
  // v4.10 Slice 10.1 — mgr with projectRoot wired so 'project' resolves
  // to <projectDir>/.aiden/PROJECT.md.
  mgr = new MemoryManager({ paths, projectRoot: projectDir });
  // Separate manager with NO projectRoot — used to verify the synthetic
  // failure path on `file: 'project'` calls (no throw, structured error).
  mgrNoProject = new MemoryManager(paths);
  ctx = {
    cwd: tmp,
    paths,
    memoryGuard: new MemoryGuard(mgr),
    memory: mgr,
  };
  ctxNoProject = {
    cwd: tmp,
    paths,
    memoryGuard: new MemoryGuard(mgrNoProject),
    memory: mgrNoProject,
  };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('memory tool wrappers — file=memory and file=user (legacy coverage)', () => {
  it('1. memory_add writes + returns verified=true', async () => {
    const r = (await memoryAddTool.execute(
      { file: 'memory', content: 'hello aiden' },
      ctx,
    )) as { success: boolean; verified: boolean };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toMatch(/hello aiden/);
  });

  it('2. memory_replace updates content', async () => {
    await memoryAddTool.execute(
      { file: 'memory', content: 'tea' },
      ctx,
    );
    const r = (await memoryReplaceTool.execute(
      { file: 'memory', old_text: 'tea', new_text: 'coffee' },
      ctx,
    )) as { success: boolean; verified: boolean };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toMatch(/coffee/);
    expect(snap.memoryMd).not.toMatch(/^tea$/m);
  });

  it('3. memory_remove deletes entry', async () => {
    await memoryAddTool.execute(
      { file: 'user', content: 'remove me' },
      ctx,
    );
    const r = (await memoryRemoveTool.execute(
      { file: 'user', text: 'remove me' },
      ctx,
    )) as { success: boolean; verified: boolean };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.userMd).not.toMatch(/remove me/);
  });

  it('4. all three tools accept memory, user, AND project file values (v4.10 Slice 10.1)', () => {
    for (const tool of [memoryAddTool, memoryReplaceTool, memoryRemoveTool]) {
      const fileSpec = (
        tool.schema.inputSchema.properties as Record<string, { enum?: string[] }>
      ).file;
      expect(fileSpec?.enum).toEqual(['memory', 'user', 'project']);
    }
  });

  it('5. errors propagate cleanly when memoryGuard missing', async () => {
    const noGuardCtx: ToolContext = { cwd: tmp, paths: ctx.paths };
    const r = (await memoryAddTool.execute(
      { file: 'memory', content: 'x' },
      noGuardCtx,
    )) as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('6. all three are write/mutates and live in the memory toolset', () => {
    for (const tool of [memoryAddTool, memoryReplaceTool, memoryRemoveTool]) {
      expect(tool.category).toBe('write');
      expect(tool.mutates).toBe(true);
      expect(tool.toolset).toBe('memory');
    }
  });
});

// ── v4.10 Slice 10.1 — project namespace, parameterized over branches ──

describe('memory tool wrappers — parameterized add/replace/remove over file branches', () => {
  // The full add → replace → remove cycle, exercised for each first-class
  // namespace. This is the v4.10 Slice 10.1 mock-blindness guard: tests
  // must drive REAL runtime branches (each file path written + verified
  // on disk through MemoryManager), not just unit-test the helper.
  const BRANCHES: Array<{ file: 'memory' | 'user' | 'project'; pathKey: 'memoryMd' | 'userMd' | 'project' }> = [
    { file: 'memory',  pathKey: 'memoryMd' },
    { file: 'user',    pathKey: 'userMd' },
    { file: 'project', pathKey: 'project' },
  ];

  for (const { file, pathKey } of BRANCHES) {
    it(`add → replace → remove cycle works for file='${file}'`, async () => {
      // ADD
      const addR = (await memoryAddTool.execute(
        { file, content: `${file}-original` },
        ctx,
      )) as { success: boolean; verified: boolean; file: string };
      expect(addR.success, `add ${file}`).toBe(true);
      expect(addR.verified).toBe(true);
      expect(addR.file).toBe(file);

      // REPLACE
      const replR = (await memoryReplaceTool.execute(
        { file, old_text: `${file}-original`, new_text: `${file}-updated` },
        ctx,
      )) as { success: boolean; verified: boolean };
      expect(replR.success, `replace ${file}`).toBe(true);
      expect(replR.verified).toBe(true);

      // Verify via snapshot (uses MemoryManager → registry → resolves
      // to the correct namespace file on disk).
      const snapMid = await mgr.loadSnapshot();
      const midContent = pathKey === 'memoryMd'
        ? snapMid.memoryMd
        : pathKey === 'userMd'
          ? snapMid.userMd
          : snapMid.files?.[file]?.content ?? '';
      expect(midContent).toContain(`${file}-updated`);
      expect(midContent).not.toContain(`${file}-original`);

      // REMOVE
      const remR = (await memoryRemoveTool.execute(
        { file, text: `${file}-updated` },
        ctx,
      )) as { success: boolean; verified: boolean };
      expect(remR.success, `remove ${file}`).toBe(true);
      expect(remR.verified).toBe(true);

      const snapFinal = await mgr.loadSnapshot();
      const finalContent = pathKey === 'memoryMd'
        ? snapFinal.memoryMd
        : pathKey === 'userMd'
          ? snapFinal.userMd
          : snapFinal.files?.[file]?.content ?? '';
      expect(finalContent).not.toContain(`${file}-updated`);
    });
  }

  it('project writes land at <projectRoot>/.aiden/PROJECT.md (separate from global)', async () => {
    await memoryAddTool.execute({ file: 'project', content: 'in-project' }, ctx);
    await memoryAddTool.execute({ file: 'memory',  content: 'in-global'  }, ctx);

    // Project file lives under projectDir, NOT under tmp (the aiden root).
    const projectFile = path.join(projectDir, '.aiden', 'PROJECT.md');
    const projectContent = await fs.readFile(projectFile, 'utf8');
    expect(projectContent).toContain('in-project');
    expect(projectContent).not.toContain('in-global');

    const globalFile = ctx.paths!.memoryMd;
    const globalContent = await fs.readFile(globalFile, 'utf8');
    expect(globalContent).toContain('in-global');
    expect(globalContent).not.toContain('in-project');

    // Paths must be distinct — distinct repos get distinct PROJECT.md
    // (the acceptance criterion: "running aiden in two different repos
    // shows different PROJECT.md files").
    expect(projectFile).not.toBe(globalFile);
  });
});

// ── v4.10 Slice 10.1 — durable-facts protection scope ──

describe('memory_remove — durable-facts protection', () => {
  it('blocks autonomous removal of MEMORY.md `## Durable facts` entries', async () => {
    // Seed MEMORY.md with a durable-facts section directly on disk.
    const memPath = ctx.paths!.memoryMd;
    await fs.writeFile(memPath, '## Durable facts\nuser prefers tea\n', 'utf8');

    const r = (await memoryRemoveTool.execute(
      { file: 'memory', text: 'user prefers tea' },
      ctx,
    )) as { success: boolean; error?: string; protectedSection?: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Durable facts/i);
    expect(r.protectedSection).toBe('## Durable facts');

    // File should be unchanged.
    const after = await fs.readFile(memPath, 'utf8');
    expect(after).toContain('user prefers tea');
  });

  it('does NOT block project-namespace removal even with a `## Durable facts` section', async () => {
    // PROJECT.md is intentionally iteration-friendly — the durable-facts
    // guard is scoped to global MEMORY.md only per v4.10 Slice 10.1 design.
    await memoryAddTool.execute(
      { file: 'project', content: '## Durable facts\nproject-fact-A' },
      ctx,
    );

    const r = (await memoryRemoveTool.execute(
      { file: 'project', text: 'project-fact-A' },
      ctx,
    )) as { success: boolean; verified: boolean; protectedSection?: string };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.protectedSection).toBeUndefined();
  });
});

// ── v4.10 Slice 10.1 — synthetic failure for unresolvable project root ──

describe('memory tools — project namespace without project root', () => {
  it('add returns synthetic failure (not throw) when projectRoot is null', async () => {
    const r = (await memoryAddTool.execute(
      { file: 'project', content: 'orphan' },
      ctxNoProject,
    )) as { success: boolean; error?: string; file?: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/project namespace requires a project root/i);
    expect(r.file).toBe('project');
  });

  it('replace returns synthetic failure (not throw) when projectRoot is null', async () => {
    const r = (await memoryReplaceTool.execute(
      { file: 'project', old_text: 'a', new_text: 'b' },
      ctxNoProject,
    )) as { success: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/project namespace requires a project root/i);
  });

  it('remove returns synthetic failure (not throw) when projectRoot is null', async () => {
    const r = (await memoryRemoveTool.execute(
      { file: 'project', text: 'a' },
      ctxNoProject,
    )) as { success: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/project namespace requires a project root/i);
  });
});
