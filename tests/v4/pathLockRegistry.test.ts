import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import {
  PathConflictError,
  PathLockRegistry,
  lockRequestsForTool,
  normalizeLockPath,
  processPathLocks,
} from '../../core/v4/pathLockRegistry';
import { ToolRegistry, type ToolContext, type ToolHandler } from '../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../core/v4/paths';
import type { ToolCallRequest } from '../../providers/v4/types';

const holder = (owner: string) => ({ owner, label: `tool call ${owner}` });

describe('PathLockRegistry', () => {
  it('rejects write-write on the same path', () => {
    const reg = new PathLockRegistry();
    reg.acquire([{ path: '/a', mode: 'write' }], holder('A'));
    expect(() => reg.acquire([{ path: '/a', mode: 'write' }], holder('B'))).toThrow(PathConflictError);
  });

  it('rejects read-write and write-read', () => {
    const reg = new PathLockRegistry();
    const releaseRead = reg.acquire([{ path: '/a', mode: 'read' }], holder('A'));
    expect(() => reg.acquire([{ path: '/a', mode: 'write' }], holder('B'))).toThrow(PathConflictError);
    releaseRead();
    reg.acquire([{ path: '/a', mode: 'write' }], holder('B'));
    expect(() => reg.acquire([{ path: '/a', mode: 'read' }], holder('C'))).toThrow(PathConflictError);
  });

  it('allows read-read', () => {
    const reg = new PathLockRegistry();
    reg.acquire([{ path: '/a', mode: 'read' }], holder('A'));
    expect(() => reg.acquire([{ path: '/a', mode: 'read' }], holder('B'))).not.toThrow();
  });

  it('allows different paths in parallel', () => {
    const reg = new PathLockRegistry();
    reg.acquire([{ path: '/a', mode: 'write' }], holder('A'));
    expect(() => reg.acquire([{ path: '/b', mode: 'write' }], holder('B'))).not.toThrow();
  });

  it('release frees the path and is idempotent', () => {
    const reg = new PathLockRegistry();
    const release = reg.acquire([{ path: '/a', mode: 'write' }], holder('A'));
    release();
    release();
    expect(reg.activePathCount()).toBe(0);
    expect(() => reg.acquire([{ path: '/a', mode: 'write' }], holder('B'))).not.toThrow();
  });

  it('is all-or-nothing: a conflict on one path leaves no partial claims', () => {
    const reg = new PathLockRegistry();
    reg.acquire([{ path: '/b', mode: 'write' }], holder('A'));
    expect(() =>
      reg.acquire([{ path: '/a', mode: 'write' }, { path: '/b', mode: 'write' }], holder('B')),
    ).toThrow(PathConflictError);
    // '/a' must still be free.
    expect(() => reg.acquire([{ path: '/a', mode: 'write' }], holder('C'))).not.toThrow();
  });

  it('does not conflict with itself and write wins over read for duplicates', () => {
    const reg = new PathLockRegistry();
    expect(() =>
      reg.acquire([{ path: '/a', mode: 'read' }, { path: '/a', mode: 'write' }], holder('A')),
    ).not.toThrow();
    expect(() => reg.acquire([{ path: '/a', mode: 'read' }], holder('B'))).toThrow(PathConflictError);
  });

  it('names the holder in the error message', () => {
    const reg = new PathLockRegistry();
    reg.acquire([{ path: '/a', mode: 'write' }], holder('A'));
    try {
      reg.acquire([{ path: '/a', mode: 'write' }], holder('B'));
      throw new Error('expected conflict');
    } catch (e) {
      expect((e as Error).message).toContain('tool call A');
      expect((e as Error).message).toContain('/a');
    }
  });
});

describe('normalizeLockPath', () => {
  it('treats ./a.txt and a.txt as the same key', () => {
    const cwd = os.tmpdir();
    expect(normalizeLockPath('./a.txt', cwd)).toBe(normalizeLockPath('a.txt', cwd));
    expect(normalizeLockPath(path.join(cwd, 'a.txt'), '/somewhere/else')).toBe(normalizeLockPath('a.txt', cwd));
  });
});

describe('lockRequestsForTool', () => {
  it('classifies file tools and honours argument aliases', () => {
    expect(lockRequestsForTool('file_write', { path: 'x' })).toEqual([{ path: 'x', mode: 'write' }]);
    expect(lockRequestsForTool('file_write', { file: 'x' })).toEqual([{ path: 'x', mode: 'write' }]);
    expect(lockRequestsForTool('file_patch', { path: 'x' })).toEqual([{ path: 'x', mode: 'write' }]);
    expect(lockRequestsForTool('file_read', { path: 'x' })).toEqual([{ path: 'x', mode: 'read' }]);
    expect(lockRequestsForTool('file_copy', { source: 'a', dest: 'b' })).toEqual([
      { path: 'a', mode: 'read' },
      { path: 'b', mode: 'write' },
    ]);
    expect(lockRequestsForTool('file_move', { from: 'a', to: 'b' })).toEqual([
      { path: 'a', mode: 'write' },
      { path: 'b', mode: 'write' },
    ]);
  });

  it('ignores non-file tools and empty arguments', () => {
    expect(lockRequestsForTool('shell_exec', { path: 'x' })).toEqual([]);
    expect(lockRequestsForTool('file_write', {})).toEqual([]);
    expect(lockRequestsForTool('file_write', { path: '   ' })).toEqual([]);
  });
});

describe('buildExecutor path-overlap guard', () => {
  const makeContext = (sessionId: string): ToolContext => ({
    cwd: os.tmpdir(),
    paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-test-root' }),
    sessionId,
  });
  const call = (id: string, name: string, args: Record<string, unknown>): ToolCallRequest => ({
    id,
    name,
    arguments: args,
  });
  const slowHandler = (name: string, mutates: boolean, gate: Promise<void>): ToolHandler => ({
    schema: { name, description: name, inputSchema: { type: 'object', properties: {} } },
    category: mutates ? 'write' : 'read',
    mutates,
    toolset: 'files',
    async execute() {
      await gate;
      return { success: true };
    },
  });

  it('blocks a second concurrent write to the same path, then frees the lock', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const registry = new ToolRegistry();
    registry.register(slowHandler('file_write', true, gate));
    const childA = registry.buildExecutor(makeContext('child-a'));
    const childB = registry.buildExecutor(makeContext('child-b'));

    const first = childA(call('c1', 'file_write', { path: 'overlap-test.txt', content: '1' }));
    await new Promise((r) => setTimeout(r, 20)); // let first reach the handler
    const second = await childB(call('c2', 'file_write', { path: 'overlap-test.txt', content: '2' }));

    expect(second.error).toContain('Path conflict');
    expect(second.error).toContain('child-a');
    expect(second.activityTiming?.terminalClassification).toBe('blocked');

    open();
    expect((await first).error).toBeUndefined();
    expect(processPathLocks.activePathCount()).toBe(0);

    const third = await childB(call('c3', 'file_write', { path: 'overlap-test.txt', content: '3' }));
    expect(third.error).toBeUndefined();
  });

  it('releases the lock when the handler throws', async () => {
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: 'file_write', description: 'w', inputSchema: { type: 'object', properties: {} } },
      category: 'write',
      mutates: true,
      toolset: 'files',
      async execute() { throw new Error('disk exploded'); },
    });
    const exec = registry.buildExecutor(makeContext('s'));
    const r = await exec(call('c1', 'file_write', { path: 'throw-test.txt', content: 'x' }));
    expect(r.error).toContain('disk exploded');
    expect(processPathLocks.activePathCount()).toBe(0);
  });
});
