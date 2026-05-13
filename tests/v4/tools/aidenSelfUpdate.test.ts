/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-update — `aiden_self_update` tool coverage.
 *
 * Drives the tool against a real (temp-rooted) AidenPaths layout so
 * checkForUpdate's cache I/O works, but mocks the network probe so
 * tests are deterministic. Spawn is NOT mocked at the tool level —
 * confirm:true → calls executeInstall which would spawn npm in real
 * usage; we cover that path via the dedicated executeInstall test.
 * Here we focus on the gate behavior: status-only vs install-stage,
 * and the description regression guards for the two-step contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { aidenSelfUpdateTool } from '../../../tools/v4/system/aidenSelfUpdate';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-update-tool-'));
  const paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.root, { recursive: true });
  ctx = { cwd: tmp, paths };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Stub the network probe checkForUpdate uses to a fixed version reply. */
function stubFetchToVersion(version: string | null): typeof globalThis.fetch {
  return vi.fn(async () => {
    if (version === null) throw new Error('network unreachable');
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
}

describe('aiden_self_update — confirm:false (status only, never spawns)', () => {
  it('reports update available when latest > installed', async () => {
    // Swap global fetch so checkForUpdate's default fetchImpl uses our stub.
    const original = globalThis.fetch;
    globalThis.fetch = stubFetchToVersion('99.99.99');
    try {
      const r = await aidenSelfUpdateTool.execute({ confirm: false }, ctx) as {
        success: boolean; stage: string; message: string; updateAvailable: boolean;
      };
      expect(r.success).toBe(true);
      expect(r.stage).toBe('status');
      expect(r.updateAvailable).toBe(true);
      expect(r.message).toContain('Update available');
      expect(r.message).toContain('99.99.99');
      expect(r.message).toContain('Confirm by saying');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports "on latest" when installed >= latest', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetchToVersion('0.0.1');     // older than installed → no update
    try {
      const r = await aidenSelfUpdateTool.execute({ confirm: false }, ctx) as {
        success: boolean; stage: string; updateAvailable: boolean; message: string;
      };
      expect(r.success).toBe(true);
      expect(r.updateAvailable).toBe(false);
      expect(r.message).toContain('Nothing to update');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports honest "registry unreachable" when network probe fails', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetchToVersion(null);
    try {
      const r = await aidenSelfUpdateTool.execute({ confirm: false }, ctx) as {
        success: boolean; latest: string | null; message: string;
      };
      expect(r.success).toBe(true);
      expect(r.latest).toBeNull();
      expect(r.message).toContain('Couldn');
      expect(r.message).toContain('registry unreachable');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('confirm:false returns stage="status" — the no-spawn branch (defense in depth)', async () => {
    // The implementation contract: confirm:false ALWAYS routes through
    // the status-only path (returns before any executeInstall call).
    // Stage assertion + completion timing (< 1 s, no npm spawn would
    // be that fast) is the behavioral proof. vi.spyOn on
    // child_process.spawn doesn't work on modern Node (property is
    // non-configurable), so we anchor on the stage label instead.
    const original = globalThis.fetch;
    globalThis.fetch = stubFetchToVersion('99.99.99');
    try {
      const t0 = Date.now();
      const r = await aidenSelfUpdateTool.execute({ confirm: false }, ctx) as {
        stage: string;
      };
      const elapsed = Date.now() - t0;
      expect(r.stage).toBe('status');
      // Sanity: stage:status path completes within ~1 s (a real npm
      // install would take many seconds even on cache hit).
      expect(elapsed).toBeLessThan(1000);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('aiden_self_update — confirm:true (install stage gate)', () => {
  it('short-circuits with stage="install" + "Nothing to install" when latest equals installed', async () => {
    // confirm:true but no update available → tool returns the
    // already-on-latest message and never reaches executeInstall.
    // Same vi.spyOn-on-spawn limitation; same stage-based proof.
    const original = globalThis.fetch;
    globalThis.fetch = stubFetchToVersion('0.0.1');     // no update
    try {
      const t0 = Date.now();
      const r = await aidenSelfUpdateTool.execute({ confirm: true }, ctx) as {
        success: boolean; stage: string; message: string;
      };
      const elapsed = Date.now() - t0;
      expect(r.success).toBe(true);
      expect(r.stage).toBe('install');
      expect(r.message).toContain('Nothing to install');
      // Short-circuit timing — actual install would be slow.
      expect(elapsed).toBeLessThan(1000);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('short-circuits with success:false when registry is unreachable on confirm:true', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetchToVersion(null);
    try {
      const t0 = Date.now();
      const r = await aidenSelfUpdateTool.execute({ confirm: true }, ctx) as {
        success: boolean; error: string;
      };
      const elapsed = Date.now() - t0;
      expect(r.success).toBe(false);
      expect(r.error).toContain('registry unreachable');
      expect(elapsed).toBeLessThan(1000);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('aiden_self_update — missing context', () => {
  it('returns error when paths is not wired', async () => {
    const r = await aidenSelfUpdateTool.execute(
      { confirm: false },
      { cwd: tmp } as ToolContext,
    ) as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toContain('paths');
  });
});

describe('aiden_self_update — schema + two-step contract regression guards', () => {
  it('description carries the two-step / confirm-true rule', () => {
    const desc = aidenSelfUpdateTool.schema.description;
    expect(desc).toContain('TWO-STEP CONFIRMATION REQUIRED');
    expect(desc).toContain('NEVER call with confirm:true autonomously');
    expect(desc).toContain('explicitly agrees');
  });

  it('description carries natural-language call/skip examples', () => {
    const desc = aidenSelfUpdateTool.schema.description;
    expect(desc).toContain('update yourself');
    expect(desc).toContain('upgrade to the latest');
    expect(desc).toContain('DO NOT call when');
    expect(desc).toContain('OTHER software');
  });

  it('schema requires the confirm boolean', () => {
    const schema = aidenSelfUpdateTool.schema.inputSchema as {
      properties: { confirm: { type: string } };
      required:   string[];
    };
    expect(schema.properties.confirm.type).toBe('boolean');
    expect(schema.required).toEqual(['confirm']);
  });

  it('is registered under the system toolset with mutates=true', () => {
    expect(aidenSelfUpdateTool.toolset).toBe('system');
    expect(aidenSelfUpdateTool.mutates).toBe(true);
    expect(aidenSelfUpdateTool.category).toBe('write');
  });
});
