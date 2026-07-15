import { describe, expect, it, vi } from 'vitest';
import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { ToolRegistry, type ToolHandler } from '../../../core/v4/toolRegistry';
import { computeTaskFinalization } from '../../../core/v4/taskVerification';
import {
  mapTaskOutcomePresentation,
  taskOutcomeInputFromFinalization,
} from '../../../core/v4/taskOutcomePresentation';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { HonestyEnforcement } from '../../../moat/honestyEnforcement';
import { resolveAidenPaths } from '../../../core/v4/paths';

describe('approval decision projection', () => {
  it('preserves explicit denial through the live registry, trace, finalization, and presentation path', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const handler: ToolHandler = {
      schema: {
        name: 'shell_exec',
        description: 'Execute a command.',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      category: 'execute',
      mutates: true,
      execute,
    };
    const registry = new ToolRegistry();
    registry.register(handler);
    const approvalEngine = new ApprovalEngine('manual', {
      promptUser: async () => 'deny',
    });
    const registryExecutor = registry.buildExecutor({
      cwd: process.cwd(),
      paths: resolveAidenPaths({ rootOverride: process.cwd() }),
      approvalEngine,
    });
    const projectedExecutor: ToolExecutor = async (...args) => ({
      ...await registryExecutor(...args),
    });
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{
        id: 'deny-shell',
        name: 'shell_exec',
        arguments: { command: 'must-not-run' },
      }]),
      MockProviderAdapter.stop('The command was denied and did not run.'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: projectedExecutor,
      tools: [handler.schema],
      resolveMutates: (name) => registry.get(name)?.mutates,
      honestyEnforcement: new HonestyEnforcement('enforce'),
    });

    const result = await agent.runConversation([{ role: 'user', content: 'run the command' }]);
    const finalization = computeTaskFinalization({
      finishReason: result.finishReason,
      toolCallTrace: result.toolCallTrace,
    });
    const input = taskOutcomeInputFromFinalization({
      finalization,
      trace: result.toolCallTrace,
      finishReason: result.finishReason,
    });
    const presentation = mapTaskOutcomePresentation(input);

    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCallTrace).toHaveLength(1);
    expect(result.toolCallTrace[0].approvalDecision).toMatchObject({
      state: 'denied',
      approved: false,
    });
    expect(input).toMatchObject({
      denied: true,
      executionStarted: false,
      requiredDeniedCount: 1,
      requiredFailedCount: 0,
    });
    expect(presentation).toMatchObject({ kind: 'denied', label: 'Denied' });
  });
});
