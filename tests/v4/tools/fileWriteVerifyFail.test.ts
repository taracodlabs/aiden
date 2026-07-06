/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14.x — when the shared verified-write helper reports the write can't be
 * trusted (throws), BOTH file_write and file_patch must surface an honest
 * failure, never a false success. Mocks writeFileVerified to throw and asserts
 * the tools return { success: false } with the error passed through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The shared choke-point throws → the tools must fail loudly.
vi.mock('../../../core/v4/writeFileVerified', () => ({
  writeFileVerified: vi.fn(async () => { throw new Error('simulated verification failure'); }),
  WriteVerificationError: class WriteVerificationError extends Error {},
}));

import { fileWriteTool } from '../../../tools/v4/files/fileWrite';
import { filePatchTool } from '../../../tools/v4/files/filePatch';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let ctx: ToolContext;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-verify-fail-'));
  ctx = { cwd: tmp, paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }) };
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('verification failure surfaces as an honest error (no false success)', () => {
  it('file_write returns success:false when writeFileVerified throws', async () => {
    const r = (await fileWriteTool.execute(
      { path: path.join(tmp, 'x.txt'), content: 'data' },
      ctx,
    )) as { success: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/simulated verification failure/);
  });

  it('file_patch returns success:false when writeFileVerified throws', async () => {
    const target = path.join(tmp, 'y.txt');
    await fs.writeFile(target, 'find-me here');   // exists + find string present → reaches the write
    const r = (await filePatchTool.execute(
      { path: target, find: 'find-me', replace: 'replaced' },
      ctx,
    )) as { success: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/simulated verification failure/);
  });
});
