/**
 * Phase 16d: AidenAgent memory-snapshot refresh on mutation.
 *
 * Strategy (b) per docs/sprint/hermes-memory-refresh-audit.md:
 *   - System prompt frozen by default for prefix-cache stability
 *   - `markMemoryDirty()` flips a dirty bit
 *   - Next `runConversation` reloads MEMORY.md / USER.md, rebuilds slot 3+4
 *   - Bit clears so subsequent turns hit the cache again
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AidenAgent, type ToolExecutor } from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import { PromptBuilder } from '../../core/v4/promptBuilder';
import type { AidenPaths } from '../../core/v4/paths';
import type { MemorySnapshot } from '../../core/v4/memoryProvider';
import type { Message, ToolSchema } from '../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];
const noopExec: ToolExecutor = async (call) => ({
  id: call.id,
  name: call.name,
  result: { ok: true },
});
const userMsg = (c: string): Message => ({ role: 'user', content: c });

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'MEMORY.md'),
    userMd: path.join(root, 'USER.md'),
    skillsDir: path.join(root, 'skills'),
  } as AidenPaths;
}

function snap(memory: string, user: string): MemorySnapshot {
  return {
    memoryMd: memory,
    userMd: user,
    loadedAt: Date.now(),
    isEmpty: !memory.trim() && !user.trim(),
  };
}

describe('AidenAgent — Phase 16d memory snapshot refresh', () => {
  it('1. clean run: cached system prompt reused across turns (no rebuild)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('one'),
      MockProviderAdapter.stop('two'),
    ]);
    const pb = new PromptBuilder();
    const buildSpy = vi.spyOn(pb, 'build');
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
        memorySnapshot: snap('I prefer pnpm', ''),
      },
      refreshMemorySnapshot: async () => snap('SHOULD NOT BE CALLED', ''),
    });
    await agent.runConversation([userMsg('hi')]);
    await agent.runConversation([userMsg('hi again')]);
    // System prompt built exactly once — second turn hit the cache.
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('2. markMemoryDirty triggers refresh and rebuild on next runConversation', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('first'),
      MockProviderAdapter.stop('second'),
    ]);
    const pb = new PromptBuilder();
    const buildSpy = vi.spyOn(pb, 'build');
    const refreshes: number[] = [];
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
        memorySnapshot: snap('initial', ''),
      },
      refreshMemorySnapshot: async () => {
        refreshes.push(1);
        return snap('updated', '');
      },
    });
    await agent.runConversation([userMsg('turn 1')]);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(provider.capturedInputs[0].messages[0].content).toContain('initial');

    agent.markMemoryDirty('memory');
    expect(agent.getMemoryDirtyState()).toBe('memory');

    await agent.runConversation([userMsg('turn 2')]);
    // Rebuild happened: build called twice, refresh called once.
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(refreshes.length).toBe(1);
    // Dirty bit cleared post-rebuild.
    expect(agent.getMemoryDirtyState()).toBeNull();
    // Slot 3 reflects the fresh content.
    expect(provider.capturedInputs[1].messages[0].content).toContain('updated');
    expect(provider.capturedInputs[1].messages[0].content).not.toContain('initial');
  });

  it('3. memory_add → next-turn prompt contains new entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('a'),
      MockProviderAdapter.stop('b'),
    ]);
    const pb = new PromptBuilder();
    let liveSnap = snap('', '');
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
        memorySnapshot: liveSnap,
      },
      refreshMemorySnapshot: async () => liveSnap,
    });
    await agent.runConversation([userMsg('hello')]);
    // Simulate memory_add wired through MemoryManager.onMutation:
    liveSnap = snap('I prefer concise answers', '');
    agent.markMemoryDirty('memory');
    await agent.runConversation([userMsg('what about me?')]);
    expect(provider.capturedInputs[1].messages[0].content).toContain(
      'I prefer concise answers',
    );
  });

  it('4. memory_replace → next-turn prompt contains replacement (not old)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('a'),
      MockProviderAdapter.stop('b'),
    ]);
    const pb = new PromptBuilder();
    let liveSnap = snap('I prefer pnpm', '');
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
        memorySnapshot: liveSnap,
      },
      refreshMemorySnapshot: async () => liveSnap,
    });
    await agent.runConversation([userMsg('hi')]);
    liveSnap = snap('I prefer bun', '');
    agent.markMemoryDirty('memory');
    await agent.runConversation([userMsg('hi again')]);
    const sys = provider.capturedInputs[1].messages[0].content as string;
    expect(sys).toContain('I prefer bun');
    expect(sys).not.toContain('I prefer pnpm');
  });

  it('5. memory_remove → next-turn prompt excludes removed entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('a'),
      MockProviderAdapter.stop('b'),
    ]);
    const pb = new PromptBuilder();
    let liveSnap = snap('to be removed', 'kept');
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
        memorySnapshot: liveSnap,
      },
      refreshMemorySnapshot: async () => liveSnap,
    });
    await agent.runConversation([userMsg('hi')]);
    liveSnap = snap('', 'kept');
    agent.markMemoryDirty('memory');
    await agent.runConversation([userMsg('hi 2')]);
    const sys = provider.capturedInputs[1].messages[0].content as string;
    expect(sys).not.toContain('to be removed');
    expect(sys).toContain('kept');
  });

  it('6. markMemoryDirty is no-op when refreshMemorySnapshot is not configured', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('a'),
      MockProviderAdapter.stop('b'),
    ]);
    const pb = new PromptBuilder();
    const buildSpy = vi.spyOn(pb, 'build');
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
        memorySnapshot: snap('initial', ''),
      },
      // refreshMemorySnapshot omitted on purpose.
    });
    await agent.runConversation([userMsg('hi')]);
    agent.markMemoryDirty('memory');
    expect(agent.getMemoryDirtyState()).toBeNull(); // no-op without refresh callback
    await agent.runConversation([userMsg('hi 2')]);
    // Frozen-snapshot semantics retained — only one build.
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('7. multiple writes between turns escalate single-file → "both"', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('a'),
      MockProviderAdapter.stop('b'),
    ]);
    const pb = new PromptBuilder();
    const refreshObserved: Array<'memory' | 'user' | 'both'> = [];
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
        memorySnapshot: snap('m', 'u'),
      },
      refreshMemorySnapshot: async () => snap('m2', 'u2'),
      onMemoryRefresh: (which) => refreshObserved.push(which),
    });
    await agent.runConversation([userMsg('hi')]);
    agent.markMemoryDirty('memory');
    agent.markMemoryDirty('user');
    expect(agent.getMemoryDirtyState()).toBe('both');
    await agent.runConversation([userMsg('hi 2')]);
    expect(refreshObserved).toEqual(['both']);
    expect(agent.getMemoryDirtyState()).toBeNull();
  });

  it('8. refresh callback failure leaves dirty bit set (retry next turn)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('a'),
      MockProviderAdapter.stop('b'),
      MockProviderAdapter.stop('c'),
    ]);
    const pb = new PromptBuilder();
    const buildSpy = vi.spyOn(pb, 'build');
    let allowRefresh = false;
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
        memorySnapshot: snap('initial', ''),
      },
      refreshMemorySnapshot: async () => {
        if (!allowRefresh) throw new Error('disk EBUSY');
        return snap('updated', '');
      },
    });
    await agent.runConversation([userMsg('hi')]);
    agent.markMemoryDirty('memory');
    // Refresh fails — agent must NOT crash, dirty bit stays set so the next
    // turn retries the refresh.
    await agent.runConversation([userMsg('hi 2')]);
    expect(provider.capturedInputs[1].messages[0].content).toContain('initial');
    expect(agent.getMemoryDirtyState()).toBe('memory');

    // Now allow refresh — the still-set dirty bit should drive a retry on the
    // next turn without needing another markMemoryDirty call.
    allowRefresh = true;
    await agent.runConversation([userMsg('hi 3')]);
    expect(provider.capturedInputs[2].messages[0].content).toContain('updated');
    expect(agent.getMemoryDirtyState()).toBeNull();
    expect(buildSpy).toHaveBeenCalled();
  });
});
