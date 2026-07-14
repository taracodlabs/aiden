import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// THE load-bearing invariant: a snapshot must NEVER affect command execution.
// Here `fileSnapshot` is forced to THROW (synchronously) — the pathological
// worst case — and we prove the command still runs to completion and returns its
// normal result, with no snapshot pair emitted. `snapshotTargetsForTool` and
// `resourceIdForPath` stay real, so the executor's capture wiring runs for real.
const state = vi.hoisted(() => ({ mode: 'throw' as 'throw' | 'pre-ok-post-throw', calls: 0 }));

vi.mock('../../core/v4/fsSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/v4/fsSnapshot')>();
  return {
    ...actual,
    fileSnapshot: () => {
      state.calls += 1;
      if (state.mode === 'throw') throw new Error('capture boom (synchronous)');
      // pre-ok-post-throw: the 1st call (pre) resolves; later calls (post) throw
      if (state.calls >= 2) throw new Error('post-capture boom (synchronous)');
      return Promise.resolve({ kind: 'absent' as const });
    },
  };
});

import { ToolRegistry, type ToolContext, type ToolHandler } from '../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../core/v4/paths';
import type { SnapshotPair } from '../../core/v4/temporalEvidence';
import type { ToolCallRequest, ToolSchema } from '../../providers/v4/types';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'aiden-snapfail-')); state.calls = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

const schema = (name: string): ToolSchema => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const call = (name: string, args: Record<string, unknown>): ToolCallRequest => ({ id: `call-${name}`, name, arguments: args });
const writeHandler = (): ToolHandler => ({
  schema: schema('file_write'),
  category: 'write' as ToolHandler['category'],
  mutates: true,
  toolset: 'files',
  async execute(args: Record<string, unknown>) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(String(args.path), String(args.content ?? ''));
    return { path: args.path, ok: true };
  },
});

function ctx(sink: (p: SnapshotPair) => void): ToolContext {
  return { cwd: dir, paths: resolveAidenPaths({ rootOverride: dir }), attempt: 1, snapshotSink: sink };
}

describe('fail-safe — a throwing capture NEVER affects command execution', () => {
  it('pre-capture throws synchronously → command STILL RUNS, returns normal result, no pair', async () => {
    state.mode = 'throw';
    const pairs: SnapshotPair[] = [];
    const reg = new ToolRegistry(); reg.register(writeHandler());
    const target = path.join(dir, 'out.txt');

    const out = await reg.buildExecutor(ctx((p) => pairs.push(p)))(call('file_write', { path: target, content: 'DATA' }));

    // the command completed exactly as it does today
    expect((out.result as { ok?: boolean }).ok).toBe(true);
    expect(existsSync(target)).toBe(true);                 // real side effect happened
    expect(readFileSync(target, 'utf8')).toBe('DATA');
    // capture faulted → no pair, but the command was untouched
    await new Promise((r) => setTimeout(r, 30));
    expect(pairs).toHaveLength(0);
    expect(state.calls).toBeGreaterThan(0);                // it really did attempt (and throw)
  });

  it('post-capture throws synchronously → command result is untouched (never flips to error)', async () => {
    state.mode = 'pre-ok-post-throw';
    const pairs: SnapshotPair[] = [];
    const reg = new ToolRegistry(); reg.register(writeHandler());
    const target = path.join(dir, 'out2.txt');

    // must RESOLVE (not reject): a post-capture throw sits inside the handler try,
    // and without the inner guard it would flip this success into the error path.
    const out = await reg.buildExecutor(ctx((p) => pairs.push(p)))(call('file_write', { path: target, content: 'D2' }));

    expect((out.result as { ok?: boolean }).ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(pairs).toHaveLength(0);                          // post threw before the sink → no pair
  });
});
