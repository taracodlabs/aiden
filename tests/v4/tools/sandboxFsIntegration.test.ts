/**
 * v4.4 Phase 2 — file_* tools sandbox integration tests.
 *
 * Verifies the inline preflight in each of the 7 file tools wires
 * `isPathAllowed` correctly and surfaces a structured
 * `sandbox_violation` envelope when the policy denies.
 *
 * Coverage:
 *   - All 7 tools refuse a denylist path when AIDEN_SANDBOX=1
 *   - Write tools refuse outside the allowlist
 *   - Read tools permit outside the allowlist (read is deny-only)
 *   - Happy path still works under tmpdir (in default allowlist)
 *   - Sandbox disabled (default): zero behavior change
 *   - The `sandbox_violation` envelope has the expected shape
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { fileReadTool   } from '../../../tools/v4/files/fileRead';
import { fileListTool   } from '../../../tools/v4/files/fileList';
import { fileWriteTool  } from '../../../tools/v4/files/fileWrite';
import { filePatchTool  } from '../../../tools/v4/files/filePatch';
import { fileDeleteTool } from '../../../tools/v4/files/fileDelete';
import { fileMoveTool   } from '../../../tools/v4/files/fileMove';
import { fileCopyTool   } from '../../../tools/v4/files/fileCopy';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { _resetSandboxConfigForTests } from '../../../core/v4/sandboxConfig';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let ctx: ToolContext;

interface ViolationEnvelope {
  code: string;
  category: string;
  retryable: false;
  requested_path: string;
  resolved_path:  string;
  matched_policy: string;
}

interface ToolResult {
  success: boolean;
  error?: string;
  sandbox_violation?: ViolationEnvelope;
  [k: string]: unknown;
}

function withSandbox<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.AIDEN_SANDBOX;
  process.env.AIDEN_SANDBOX = '1';
  _resetSandboxConfigForTests();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.AIDEN_SANDBOX;
      else process.env.AIDEN_SANDBOX = prev;
      _resetSandboxConfigForTests();
    });
}

beforeEach(async () => {
  // tmp is under os.tmpdir(), which IS in the default allowlist.
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiden-sbxfs-tool-'));
  tmp = fs.realpathSync(tmp);
  ctx = {
    cwd: tmp,
    paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
  };
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
  _resetSandboxConfigForTests();
});

describe('sandbox disabled via AIDEN_SANDBOX=0 — opt-out path', () => {
  // v4.4 Phase 6 — sandbox is on by default. These tests assert the
  // explicit opt-out (`AIDEN_SANDBOX=0`) restores pre-v4.4 behavior.
  function withSandboxDisabled<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = process.env.AIDEN_SANDBOX;
    process.env.AIDEN_SANDBOX = '0';
    _resetSandboxConfigForTests();
    return Promise.resolve().then(fn).finally(() => {
      if (prev === undefined) delete process.env.AIDEN_SANDBOX;
      else process.env.AIDEN_SANDBOX = prev;
      _resetSandboxConfigForTests();
    });
  }

  it('file_write succeeds under tmpdir with AIDEN_SANDBOX=0', async () => {
    await withSandboxDisabled(async () => {
      const r = (await fileWriteTool.execute(
        { path: path.join(tmp, 'a.txt'), content: 'hi' },
        ctx,
      )) as ToolResult;
      expect(r.success).toBe(true);
      expect(r.sandbox_violation).toBeUndefined();
    });
  });

  it('file_read of /opt/<nonexistent> NOT short-circuited when AIDEN_SANDBOX=0', async () => {
    // Opt-out path: preflight is a no-op, no sandbox_violation surfaced.
    await withSandboxDisabled(async () => {
      const r = (await fileReadTool.execute(
        { path: '/opt/nonexistent-but-policy-permits.txt' },
        ctx,
      )) as ToolResult;
      expect(r.sandbox_violation).toBeUndefined();
    });
  });
});

describe('sandbox enabled — write outside allowlist refused', () => {
  it('file_write to /opt refused with structured envelope', async () => {
    await withSandbox(async () => {
      const r = (await fileWriteTool.execute(
        { path: '/opt/aiden-test-deny.txt', content: 'x' },
        ctx,
      )) as ToolResult;
      expect(r.success).toBe(false);
      expect(r.sandbox_violation).toBeDefined();
      expect(r.sandbox_violation!.code).toBe('fs.write_outside_allowlist');
      expect(r.sandbox_violation!.category).toBe('sandbox_violation');
      expect(r.sandbox_violation!.retryable).toBe(false);
      expect(r.sandbox_violation!.requested_path).toBe('/opt/aiden-test-deny.txt');
    });
  });

  it('file_patch outside allowlist refused', async () => {
    await withSandbox(async () => {
      const r = (await filePatchTool.execute(
        { path: '/opt/aiden-test.txt', find: 'a', replace: 'b' },
        ctx,
      )) as ToolResult;
      expect(r.success).toBe(false);
      expect(r.sandbox_violation?.code).toBe('fs.write_outside_allowlist');
    });
  });

  it('file_delete outside allowlist refused', async () => {
    await withSandbox(async () => {
      const r = (await fileDeleteTool.execute(
        { path: '/opt/aiden-test.txt' },
        ctx,
      )) as ToolResult;
      expect(r.success).toBe(false);
      expect(r.sandbox_violation?.code).toBe('fs.write_outside_allowlist');
    });
  });

  it('file_move destination outside allowlist refused', async () => {
    await withSandbox(async () => {
      const src = path.join(tmp, 'src.txt');
      await fsp.writeFile(src, 'data');
      const r = (await fileMoveTool.execute(
        { from: src, to: '/opt/aiden-test-mv.txt' },
        ctx,
      )) as ToolResult;
      expect(r.success).toBe(false);
      expect(r.sandbox_violation?.code).toBe('fs.write_outside_allowlist');
    });
  });

  it('file_copy destination outside allowlist refused', async () => {
    await withSandbox(async () => {
      const src = path.join(tmp, 'src.txt');
      await fsp.writeFile(src, 'data');
      const r = (await fileCopyTool.execute(
        { from: src, to: '/opt/aiden-test-cp.txt' },
        ctx,
      )) as ToolResult;
      expect(r.success).toBe(false);
      expect(r.sandbox_violation?.code).toBe('fs.write_outside_allowlist');
    });
  });
});

describe('sandbox enabled — denylist wins for read & write', () => {
  it('file_read of /etc/hosts refused with fs.sensitive_path', async () => {
    await withSandbox(async () => {
      const r = (await fileReadTool.execute(
        { path: '/etc/hosts' },
        ctx,
      )) as ToolResult;
      expect(r.success).toBe(false);
      // /etc could be hit by either DENY_PATTERNS (none) or sandbox.
      // Sandbox should trigger here because /etc isn't in DENY_PATTERNS.
      expect(r.sandbox_violation?.code).toBe('fs.sensitive_path');
    });
  });

  it('file_list of /etc refused', async () => {
    await withSandbox(async () => {
      const r = (await fileListTool.execute({ path: '/etc' }, ctx)) as ToolResult;
      expect(r.success).toBe(false);
      expect(r.sandbox_violation?.code).toBe('fs.sensitive_path');
    });
  });
});

describe('sandbox enabled — happy path under allowlist', () => {
  it('file_write inside tmpdir succeeds', async () => {
    await withSandbox(async () => {
      const target = path.join(tmp, 'ok.txt');
      const r = (await fileWriteTool.execute(
        { path: target, content: 'hi' },
        ctx,
      )) as ToolResult;
      expect(r.success).toBe(true);
      expect(r.sandbox_violation).toBeUndefined();
    });
  });

  it('file_read inside tmpdir succeeds', async () => {
    await withSandbox(async () => {
      const target = path.join(tmp, 'ok.txt');
      await fsp.writeFile(target, 'hello');
      const r = (await fileReadTool.execute({ path: target }, ctx)) as ToolResult;
      expect(r.success).toBe(true);
      expect(r.sandbox_violation).toBeUndefined();
    });
  });

  it('file_list inside tmpdir succeeds', async () => {
    await withSandbox(async () => {
      const r = (await fileListTool.execute({ path: tmp }, ctx)) as ToolResult;
      expect(r.success).toBe(true);
    });
  });

  it('file_copy within tmpdir succeeds', async () => {
    await withSandbox(async () => {
      const src = path.join(tmp, 'src.txt');
      const dst = path.join(tmp, 'dst.txt');
      await fsp.writeFile(src, 'x');
      const r = (await fileCopyTool.execute({ from: src, to: dst }, ctx)) as ToolResult;
      expect(r.success).toBe(true);
    });
  });
});

describe('sandbox enabled — read outside allowlist permitted (deny-only)', () => {
  it('file_read of /opt/<some-file> not refused on policy alone', async () => {
    await withSandbox(async () => {
      // Read of a non-denylist outside-allowlist path: policy permits,
      // but the file doesn't exist so we get an ENOENT — no
      // sandbox_violation should appear.
      const r = (await fileReadTool.execute(
        { path: '/opt/aiden-noent.txt' },
        ctx,
      )) as ToolResult;
      expect(r.sandbox_violation).toBeUndefined();
    });
  });
});
