/**
 * aidenAgent.promptCache.test.ts — Phase 16b.4
 *
 * Covers the new cache-invalidation surface added in 16b.4:
 *   - invalidateSystemPromptCache() forces a rebuild on the next turn.
 *   - setPersonalityOverlay() updates the option in place AND invalidates.
 *   - getSystemPromptForDebug() builds (or returns the cached) prompt
 *     without triggering an LLM call.
 *   - runConversation prepends the cached system prompt when wired (the
 *     regression that produced the 16b.4 bug).
 */
import { describe, it, expect, vi } from 'vitest';
import { AidenAgent } from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import { PromptBuilder } from '../../core/v4/promptBuilder';
import type { AidenPaths } from '../../core/v4/paths';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

async function mkPaths(): Promise<AidenPaths> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pcache-'));
  await fs.writeFile(path.join(root, 'SOUL.md'), 'I am Aiden — slot 1.', 'utf8');
  return {
    root,
    sessionsDb: '',
    authJson: '',
    configYaml: '',
    envFile: '',
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: '',
    userMd: '',
    skillsDir: '',
  } as AidenPaths;
}

describe('AidenAgent · system prompt cache (Phase 16b.4)', () => {
  it('getSystemPromptForDebug returns the SOUL.md content', async () => {
    const paths = await mkPaths();
    const agent = new AidenAgent({
      provider: new MockProviderAdapter([]),
      tools: [],
      toolExecutor: async () => ({ id: '1', name: 'noop', result: null }),
      promptBuilder: new PromptBuilder(),
      promptBuilderOptions: { paths, platform: 'linux' },
    });
    const prompt = await agent.getSystemPromptForDebug();
    expect(prompt).toContain('slot 1');
    // Returns the same string on second call (cached).
    const again = await agent.getSystemPromptForDebug();
    expect(again).toBe(prompt);
  });

  it('returns null when no PromptBuilder is wired', async () => {
    const agent = new AidenAgent({
      provider: new MockProviderAdapter([]),
      tools: [],
      toolExecutor: async () => ({ id: '1', name: 'noop', result: null }),
    });
    expect(await agent.getSystemPromptForDebug()).toBeNull();
  });

  it('setPersonalityOverlay swaps slot 2 and triggers a rebuild', async () => {
    const paths = await mkPaths();
    const agent = new AidenAgent({
      provider: new MockProviderAdapter([]),
      tools: [],
      toolExecutor: async () => ({ id: '1', name: 'noop', result: null }),
      promptBuilder: new PromptBuilder(),
      promptBuilderOptions: {
        paths,
        platform: 'linux',
        personalityOverlay: 'OLD-OVERLAY',
      },
    });
    const before = await agent.getSystemPromptForDebug();
    expect(before).toContain('OLD-OVERLAY');

    const changed = agent.setPersonalityOverlay('NEW-OVERLAY');
    expect(changed).toBe(true);

    const after = await agent.getSystemPromptForDebug();
    expect(after).toContain('NEW-OVERLAY');
    expect(after).not.toContain('OLD-OVERLAY');
    // SOUL.md (slot 1) survived the swap — overlay never replaces identity.
    expect(after).toContain('slot 1');
  });

  it('setPersonalityOverlay returns false when no change', async () => {
    const paths = await mkPaths();
    const agent = new AidenAgent({
      provider: new MockProviderAdapter([]),
      tools: [],
      toolExecutor: async () => ({ id: '1', name: 'noop', result: null }),
      promptBuilder: new PromptBuilder(),
      promptBuilderOptions: {
        paths,
        platform: 'linux',
        personalityOverlay: 'X',
      },
    });
    expect(agent.setPersonalityOverlay('X')).toBe(false);
  });

  it('invalidateSystemPromptCache forces the next runConversation to rebuild', async () => {
    const paths = await mkPaths();
    const builder = new PromptBuilder();
    const buildSpy = vi.spyOn(builder, 'build');
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('a'),
      MockProviderAdapter.stop('b'),
      MockProviderAdapter.stop('c'),
    ]);
    const agent = new AidenAgent({
      provider,
      tools: [],
      toolExecutor: async () => ({ id: '1', name: 'noop', result: null }),
      promptBuilder: builder,
      promptBuilderOptions: { paths, platform: 'linux' },
    });
    await agent.runConversation([{ role: 'user', content: 'hi' }]);
    await agent.runConversation([{ role: 'user', content: 'hi again' }]);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    agent.invalidateSystemPromptCache();
    await agent.runConversation([{ role: 'user', content: 'hi #3' }]);
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it('runConversation prepends the cached system prompt as message[0]', async () => {
    const paths = await mkPaths();
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hello'),
    ]);
    const agent = new AidenAgent({
      provider,
      tools: [],
      toolExecutor: async () => ({ id: '1', name: 'noop', result: null }),
      promptBuilder: new PromptBuilder(),
      promptBuilderOptions: { paths, platform: 'linux' },
    });
    await agent.runConversation([{ role: 'user', content: 'who are you' }]);
    expect(provider.capturedInputs).toHaveLength(1);
    const sent = provider.capturedInputs[0].messages;
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).toContain('slot 1');
    expect(sent[1]).toEqual({ role: 'user', content: 'who are you' });
  });
});
