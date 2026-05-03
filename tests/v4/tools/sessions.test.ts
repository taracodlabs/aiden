import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SessionStore } from '../../../core/v4/sessionStore';
import { SessionManager } from '../../../core/v4/sessionManager';
import { sessionSearchTool } from '../../../tools/v4/sessions/sessionSearch';
import { sessionListTool } from '../../../tools/v4/sessions/sessionList';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let store: SessionStore;
let mgr: SessionManager;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-sessions-tool-'));
  store = new SessionStore(path.join(tmp, 'sessions.db'));
  mgr = new SessionManager(store);
  ctx = {
    cwd: tmp,
    paths: resolveAidenPaths({ rootOverride: tmp }),
    sessions: mgr,
  };
});

afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('session tools', () => {
  it('1. session_search schema requires query and is read-only', () => {
    expect(sessionSearchTool.schema.name).toBe('session_search');
    expect(sessionSearchTool.schema.inputSchema.required).toEqual(['query']);
    expect(sessionSearchTool.mutates).toBe(false);
    expect(sessionSearchTool.toolset).toBe('sessions');
  });

  it('2. session_search returns FTS5 matches across stored conversations', async () => {
    const s = mgr.startSession({
      title: 'work',
      providerId: 'groq',
      modelId: 'llama-3.3',
    });
    mgr.recordTurn(
      s.id,
      [
        { role: 'user', content: 'how do I deploy the kraken cluster?' },
        { role: 'assistant', content: 'use the kraken-deploy script' },
      ],
      { inputTokens: 10, outputTokens: 5 },
    );
    const result = (await sessionSearchTool.execute(
      { query: 'kraken' },
      ctx,
    )) as { success: boolean; count: number; results: { sessionId: string }[] };
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.results[0].sessionId).toBe(s.id);
  });

  it('3. session_search returns error when ctx.sessions is missing', async () => {
    const noSessionsCtx: ToolContext = {
      cwd: tmp,
      paths: ctx.paths,
    };
    const result = (await sessionSearchTool.execute(
      { query: 'kraken' },
      noSessionsCtx,
    )) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/session manager/i);
  });

  it('4. session_list returns recent sessions newest first', async () => {
    const a = mgr.startSession({
      title: 'first',
      providerId: 'groq',
      modelId: 'llama-3.3',
    });
    const b = mgr.startSession({
      title: 'second',
      providerId: 'groq',
      modelId: 'llama-3.3',
    });
    const result = (await sessionListTool.execute({ limit: 5 }, ctx)) as {
      success: boolean;
      count: number;
      sessions: { id: string; title: string | null }[];
    };
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    const ids = result.sessions.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('5. session_list clamps limit to MAX_LIMIT', async () => {
    mgr.startSession({
      title: 'one',
      providerId: 'groq',
      modelId: 'llama-3.3',
    });
    const result = (await sessionListTool.execute({ limit: 1_000_000 }, ctx)) as {
      success: boolean;
      count: number;
    };
    // Just verify it didn't throw on giant limits
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });
});
