import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';

import {
  executeCodeTool,
  _resetPythonCache,
} from '../../../tools/v4/executeCode';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const ctx: ToolContext = {
  cwd: process.cwd(),
  paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-exec-code-test' }),
};

function pythonAvailable(): boolean {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'print(1)'], { timeout: 3000, stdio: 'pipe' });
      if (r.status === 0) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

const skipNoPython = !pythonAvailable();

beforeEach(() => {
  _resetPythonCache();
});

describe('execute_code', () => {
  it('1. is registered as an execute toolset, mutates=false', () => {
    expect(executeCodeTool.schema.name).toBe('execute_code');
    expect(executeCodeTool.category).toBe('execute');
    expect(executeCodeTool.mutates).toBe(true);
    expect(executeCodeTool.toolset).toBe('execute');
  });

  it.skipIf(skipNoPython)('2. runs simple print(1+1) -> stdout "2"', async () => {
    const r = (await executeCodeTool.execute(
      { code: 'print(1+1)' },
      ctx,
    )) as { success: boolean; stdout: string };
    expect(r.success).toBe(true);
    expect(r.stdout.trim()).toBe('2');
  });

  it.skipIf(skipNoPython)('3. captures stdout', async () => {
    const r = (await executeCodeTool.execute(
      { code: 'print("hello-py")' },
      ctx,
    )) as { stdout: string };
    expect(r.stdout).toMatch(/hello-py/);
  });

  it.skipIf(skipNoPython)('4. captures stderr on error', async () => {
    const r = (await executeCodeTool.execute(
      { code: 'raise ValueError("boom")' },
      ctx,
    )) as { success: boolean; stderr: string; exitCode: number };
    expect(r.success).toBe(false);
    expect(r.stderr).toMatch(/ValueError/);
    expect(r.exitCode).not.toBe(0);
  });

  it.skipIf(skipNoPython)('5. timeout kills hung script', async () => {
    const r = (await executeCodeTool.execute(
      {
        code: 'import time; time.sleep(30)',
        timeoutMs: 500,
      },
      ctx,
    )) as { success: boolean; timedOut: boolean };
    expect(r.success).toBe(false);
    expect(r.timedOut).toBe(true);
  }, 10_000);

  it('6. empty code returns no-op result', async () => {
    const r = (await executeCodeTool.execute({ code: '   ' }, ctx)) as {
      success: boolean;
      note: string;
    };
    expect(r.success).toBe(true);
    expect(r.note).toMatch(/empty/i);
  });
});
