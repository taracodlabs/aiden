import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalToolResultArtifactStore,
  serializeToolResultForModel,
} from '../../../core/v4/toolResultBoundary';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('model-visible tool result boundary', () => {
  it('passes small results through byte-for-byte', async () => {
    const result = await serializeToolResultForModel('unchanged', { toolName: 'example' });
    expect(result.content).toBe('unchanged');
    expect(result.metadata).toMatchObject({ rawSize: 9, transmittedSize: 9, truncated: false });
  });

  it('bounds large external results and preserves one recoverable result envelope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-tool-results-'));
    roots.push(root);
    const store = new LocalToolResultArtifactStore(root);
    const raw = `head-signature\n${'x'.repeat(50_000)}\ntail-signature`;

    const result = await serializeToolResultForModel(raw, {
      toolName: 'mcp_external_read',
      toolCallId: 'call-1',
      capBytes: 8_000,
      artifactStore: store,
    });

    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.rawSize).toBeGreaterThan(50_000);
    expect(result.metadata.transmittedSize).toBeLessThan(result.metadata.rawSize * 0.3);
    expect(result.metadata.artifactHandle).toMatch(/^tool-result:\/\/[a-f0-9]{64}$/);
    expect(result.content).toContain('head-signature');
    expect(result.content).toContain('tail-signature');
    expect(result.content).toContain('call-1');

    const restored = await store.read(result.metadata.artifactHandle!, 0, 100_000);
    expect(restored.content).toBe(raw);
    expect(restored.complete).toBe(true);
  });

  it('redacts secrets before durable artifact storage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-tool-results-'));
    roots.push(root);
    const store = new LocalToolResultArtifactStore(root);
    const secret = 'token=private-value-that-must-not-persist';
    const result = await serializeToolResultForModel(`${secret}\n${'z'.repeat(20_000)}`, {
      toolName: 'shell_exec',
      capBytes: 1_000,
      artifactStore: store,
    });

    const file = path.join(root, `${result.metadata.contentHash}.txt`);
    expect(await readFile(file, 'utf8')).not.toContain(secret);
  });

  it.each(['browser_snapshot', 'mcp_external_read', 'shell_exec'])(
    'applies the same cap to %s',
    async (toolName) => {
      const result = await serializeToolResultForModel('a'.repeat(30_000), {
        toolName,
        capBytes: 4_000,
      });
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.transmittedSize).toBeLessThan(6_000);
    },
  );

  it('preserves the assistant-call/tool-result protocol after externalization', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 'large-1', name: 'external_read', arguments: {} }]),
      MockProviderAdapter.stop('done'),
    ]);
    const agent = new AidenAgent({
      provider,
      tools: [{ name: 'external_read', description: 'read', inputSchema: { type: 'object', properties: {} } }],
      toolExecutor: async (call) => ({ id: call.id, name: call.name, result: 'z'.repeat(50_000) }),
    });

    await agent.runConversation([{ role: 'user', content: 'read it' }]);
    const nextRequest = provider.capturedInputs[1].messages;
    const assistant = nextRequest.find((message) => message.role === 'assistant' && message.toolCalls?.[0]?.id === 'large-1');
    const tool = nextRequest.find((message) => message.role === 'tool' && message.toolCallId === 'large-1');
    expect(assistant).toBeDefined();
    expect(tool).toBeDefined();
    expect(tool?.content).toContain('large-1');
    expect(Buffer.byteLength(tool?.content ?? '', 'utf8')).toBeLessThan(12_000);
  });
});
