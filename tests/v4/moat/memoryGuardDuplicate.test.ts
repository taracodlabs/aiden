import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import { MemoryManager } from '../../../core/v4/memoryManager';
import { MemoryGuard } from '../../../moat/memoryGuard';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mguard-dup-'));
});

/**
 * Phase 21 #2 — duplicate memory_add must produce verified=true so
 * `renderMemoryConfirmations` does not fire the spurious "attempted
 * but not verified" warning when the model re-issues the same write
 * inside one turn.
 */
describe('Phase 21 #2 — MemoryGuard on duplicate add', () => {
  it('1. memory_add returns verified=true on first successful write', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const mgr = new MemoryManager(paths);
    const guard = new MemoryGuard(mgr);
    const r = await guard.guardedAdd('user', 'I prefer concise answers');
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('2. duplicate memory_add still returns verified=true (no spurious warning)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const mgr = new MemoryManager(paths);
    const guard = new MemoryGuard(mgr);
    await guard.guardedAdd('user', 'I prefer concise answers');
    // Same content, same turn — model re-issued. The post-write state
    // matches user intent (content is in the file), so verified=true.
    const r2 = await guard.guardedAdd('user', 'I prefer concise answers');
    expect(r2.ok).toBe(true);
    expect(r2.verified).toBe(true);
  });
});
