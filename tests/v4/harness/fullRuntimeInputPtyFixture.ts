import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { CliCallbacks } from '../../../cli/v4/callbacks';
import { ChatSession, type ChatSessionOptions } from '../../../cli/v4/chatSession';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { CLARIFY_SCHEMA, makeClarifyTool } from '../../../tools/v4/clarify/clarifyTool';
import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ToolCallRequest,
} from '../../../providers/v4/types';

const usage = { inputTokens: 1, outputTokens: 1 };

class ScriptedProvider implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  callCount = 0;
  private readonly outputs: ProviderCallOutput[] = [
    {
      content: '', finishReason: 'tool_calls', usage,
      toolCalls: [{
        id: 'clarify-format', name: 'clarify',
        arguments: {
          question: 'Which format would you like for the report?',
          options: ['Markdown', 'Plain text'],
        },
      }],
    },
    {
      content: '', finishReason: 'tool_calls', usage,
      toolCalls: [{
        id: 'clarify-topic', name: 'clarify',
        arguments: { question: 'What topic should the Markdown report cover?' },
      }],
    },
    { content: 'Clarifications completed.', toolCalls: [], finishReason: 'stop', usage },
    { content: 'Normal input completed.', toolCalls: [], finishReason: 'stop', usage },
  ];

  async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.callCount += 1;
    diagnostic('PROVIDER_CALL', { count: this.callCount });
    const output = this.outputs.shift();
    if (!output) throw new Error('scripted provider exhausted');
    return output;
  }
}

function diagnostic(name: string, value: unknown): void {
  process.stdout.write(`\n[P2A_FULL:${name}]${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('full-runtime input regression requires a TTY');
  }

  const skin = new SkinEngine({ forceMono: true });
  const display = new Display({ skin, stdout: process.stdout, stderr: process.stderr });
  const callbacks = new CliCallbacks({ display });
  const provider = new ScriptedProvider();
  const clarify = makeClarifyTool();
  const executor: ToolExecutor = async (call: ToolCallRequest) => {
    diagnostic('TOOL_EXECUTE', { id: call.id, name: call.name });
    if (call.name !== 'clarify') {
      return { id: call.id, name: call.name, result: { ok: true } };
    }
    const result = await clarify.execute(call.arguments, {
      clarify: callbacks.promptClarify,
    } as never);
    return { id: call.id, name: call.name, result };
  };
  const agent = new AidenAgent({
    provider,
    tools: [CLARIFY_SCHEMA],
    toolExecutor: executor,
    onToolCall: callbacks.onToolCall,
    resolveMutates: () => false,
    resolveUiOnly: () => false,
  });

  const sessionManager = {
    startSession: () => ({ id: 'p2a-full-runtime', title: null, providerId: 'scripted', modelId: 'scripted' }),
    recordTurn: () => undefined,
    resumeLatest: () => undefined,
    resumeById: () => undefined,
    listSessions: () => [],
    setSessionTitle: () => undefined,
    search: () => [],
  };
  const approvalEngine = {
    setMode: () => undefined,
    getMode: () => 'manual',
    checkApproval: async () => true,
    allowForSession: () => undefined,
    allowAlways: () => undefined,
    resetSession: () => undefined,
  };
  const toolRegistry = {
    list: () => ['clarify'],
    get: () => ({ schema: CLARIFY_SCHEMA, mutates: false, category: 'read', toolset: 'clarify' }),
    getSchemas: () => [CLARIFY_SCHEMA],
    register: () => undefined,
    unregister: () => undefined,
    byCategory: () => [],
    buildExecutor: () => executor,
  };
  const commands = new CommandRegistry();
  commands.register({
    name: 'p2a-result',
    description: 'Finish the P2A runtime fixture.',
    category: 'system',
    hidden: true,
    handler: async () => ({ exit: true }),
  });
  const options: ChatSessionOptions = {
    agent,
    display,
    commandRegistry: commands,
    callbacks,
    sessionManager: sessionManager as never,
    approvalEngine: approvalEngine as never,
    skin,
    toolRegistry: toolRegistry as never,
    skillLoader: {
      list: async () => [], load: async () => undefined,
      loadAll: async () => [], readSkillFile: async () => undefined,
    } as never,
    resolver: {
      resolve: async () => provider,
      describe: () => undefined,
      listProviders: () => [],
      listModels: () => [],
    } as never,
    config: {} as never,
    initialProviderId: 'scripted',
    initialModelId: 'scripted',
    installSignalHandler: false,
  };

  const session = new ChatSession(options);
  await session.run();
  diagnostic('RESULT', {
    providerCalls: provider.callCount,
    queue: session.listQueue(),
    activityCount: callbacks.activeActivityCount(),
    activityTimers: callbacks.activityTimerCount(),
    stdin: {
      paused: process.stdin.isPaused(),
      flowing: process.stdin.readableFlowing,
      raw: process.stdin.isRaw === true,
      data: process.stdin.listenerCount('data'),
      keypress: process.stdin.listenerCount('keypress'),
      readable: process.stdin.listenerCount('readable'),
    },
  });
}

main().then(
  () => process.exit(0),
  (error) => {
    diagnostic('ERROR', { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
