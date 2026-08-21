/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it, vi } from 'vitest';

import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import type { Message, ToolCallRequest, ToolSchema } from '../../../providers/v4/types';

const user = (content: string): Message => ({ role: 'user', content });
const call = (id: string, name: string): ToolCallRequest => ({ id, name, arguments: {} });
const schema = (name: string): ToolSchema => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
});

describe('explicit external coding authority', () => {
  it('fails before provider dispatch when the explicitly required capability is unavailable', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([call('write', 'file_write')]),
    ]);
    const executor = vi.fn<ToolExecutor>(async (toolCall) => ({
      id: toolCall.id, name: toolCall.name, result: { success: true },
    }));
    const agent = new AidenAgent({
      provider,
      toolExecutor: executor,
      tools: [schema('external_coding'), schema('file_write')],
      externalCodingRequirement: {
        health: async () => ({ ready: false, reason: 'External coding model is not configured.' }),
      },
    });

    const result = await agent.runConversation([
      user('Use the external coding agent capability to fix this. If unavailable, stop.'),
    ]);

    expect(result.finishReason).toBe('error');
    expect(result.finalContent).toContain('External coding model is not configured.');
    expect(result.finalContent).toMatch(/no alternative tool path/i);
    expect(provider.capturedInputs).toHaveLength(0);
    expect(executor).not.toHaveBeenCalled();
  });

  it('blocks substitute tools and executes only external_coding for an explicit request', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([call('write', 'file_write')]),
      MockProviderAdapter.toolUse([call('coding', 'external_coding')]),
      MockProviderAdapter.stop('The isolated coding session is ready for review.'),
    ]);
    const executed: string[] = [];
    const executor: ToolExecutor = async (toolCall) => {
      executed.push(toolCall.name);
      return { id: toolCall.id, name: toolCall.name, result: { success: true } };
    };
    const agent = new AidenAgent({
      provider,
      toolExecutor: executor,
      tools: [schema('external_coding'), schema('file_write')],
      resolveMutates: (name) => name === 'file_write' || name === 'external_coding',
      externalCodingRequirement: { health: async () => ({ ready: true, reason: 'Ready.' }) },
    });

    const result = await agent.runConversation([
      user('You must use external_coding for this change. Do not edit directly.'),
    ]);

    expect(executed).toEqual(['external_coding']);
    expect(result.toolCallTrace.map((entry) => entry.name)).toEqual(['external_coding']);
    expect(result.finalContent).toContain('ready for review');
  });

  it('admits only one authoritative external coding invocation for one explicit user turn', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([call('coding-one', 'external_coding')]),
      MockProviderAdapter.toolUse([call('coding-two', 'external_coding')]),
      MockProviderAdapter.stop('The first isolated candidate is ready for review.'),
    ]);
    const executor = vi.fn<ToolExecutor>(async (toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      result: {
        success: true,
        status: 'completed',
        codingSessionId: 'coding_session_one',
        promotion: { promotionId: 'coding_promotion_one', state: 'prepared' },
      },
    }));
    const agent = new AidenAgent({
      provider,
      toolExecutor: executor,
      tools: [schema('external_coding')],
      resolveMutates: (name) => name === 'external_coding',
      externalCodingRequirement: { health: async () => ({ ready: true, reason: 'Ready.' }) },
    });

    const result = await agent.runConversation([
      user('Use the external coding capability to prepare one isolated candidate.'),
    ]);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.toolCallTrace.map((entry) => entry.name)).toEqual(['external_coding']);
    expect(provider.capturedInputs[1]?.tools).toEqual([]);
    expect(result.finalContent).toContain('first isolated candidate');
  });
});
