import { describe, it, expect } from 'vitest';

import { AidenAgent, type ToolExecutor } from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import type { CommandId, CommandRecord } from '../../core/v4/executionContract';
import type { Message, ToolCallRequest, ToolSchema } from '../../providers/v4/types';

const userMsg = (content: string): Message => ({ role: 'user', content });
const tc = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({ id, name, arguments: args });
const schema = (name: string): ToolSchema => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });

/**
 * The shadow-collect is NON-AUTHORITATIVE: injected turn-local ledger, no
 * production consumer, no I/O. These prove the seam actually populates it from
 * a real dispatch, and that production (no ledger) is untouched.
 */
describe('shadow-collect at the dispatch seam (non-authoritative)', () => {
  it('populates the injected ledger with one record per tool call, keyed by a minted CommandId', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('prov-1', 'file_read', { path: 'a.txt' })]),
      MockProviderAdapter.stop('done'),
    ]);
    const executor: ToolExecutor = async (call) => ({ id: call.id, name: call.name, result: { ok: true } });
    const agent = new AidenAgent({ provider, toolExecutor: executor, tools: [schema('file_read')] });

    const shadowCommands = new Map<CommandId, CommandRecord>();
    await agent.runConversation([userMsg('read a.txt')], { shadowCommands });

    expect(shadowCommands.size).toBe(1);
    const [key] = [...shadowCommands.keys()];
    const record = shadowCommands.get(key)!;
    expect(record.proposal.tool).toBe('file_read');
    // Provider id stored separately; the KEY is an Aiden-minted CommandId.
    expect(record.proposal.providerCallId).toBe('prov-1');
    expect(key).toMatch(/^cmd_/);
    expect(key).not.toBe('prov-1');
    expect(record.execution.state).toBe('succeeded');
  });

  it('a genuine execution error lands as execution=errored (not swallowed, not verified)', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('prov-2', 'file_read', {})]),
      MockProviderAdapter.stop('done'),
    ]);
    const executor: ToolExecutor = async () => { throw new Error('boom'); };
    const agent = new AidenAgent({ provider, toolExecutor: executor, tools: [schema('file_read')] });

    const shadowCommands = new Map<CommandId, CommandRecord>();
    await agent.runConversation([userMsg('read')], { shadowCommands });

    const record = [...shadowCommands.values()][0];
    expect(record.execution.state).toBe('errored');
    expect(record.execution.error).toMatch(/boom/);
  });

  it('production default (no ledger injected) collects nothing and dispatch is unaffected', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('prov-3', 'file_read', {})]),
      MockProviderAdapter.stop('done'),
    ]);
    const executor: ToolExecutor = async (call) => ({ id: call.id, name: call.name, result: null });
    const agent = new AidenAgent({ provider, toolExecutor: executor, tools: [schema('file_read')] });

    const result = await agent.runConversation([userMsg('read')]);
    expect(result.toolCallCount).toBe(1);   // dispatch still works with no ledger
  });
});
