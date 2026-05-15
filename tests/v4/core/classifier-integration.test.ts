/**
 * v4.2 Phase 2 — Failure classifier integration tests.
 *
 * Drives a real AidenAgent with LoopingMockProvider + failing executors
 * that produce distinct failure shapes, then asserts:
 *
 *   1. AIDEN_TCE=0 default: zero classification surface on traces,
 *      no behavioural change vs v4.1.6.
 *   2. AIDEN_TCE=1 + executor returning permission errors: every
 *      failed entry has classification.category === 'permission'.
 *   3. AIDEN_TCE=1 + executor returning timeouts: every failed entry
 *      has classification.category === 'timeout'.
 *   4. AIDEN_TCE=1 + mix of ok + failed: only failed entries have
 *      classification populated; ok entries have it undefined.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import type { Message, ToolCallRequest, ToolCallResult, ToolSchema } from '../../../providers/v4/types';
import { LoopingMockProvider } from '../_helpers/loopingMockProvider';

const STUB_TOOLS: ToolSchema[] = [
  { name: 'file_read',  description: 'read a file',    inputSchema: {} },
  { name: 'web_fetch',  description: 'fetch a URL',    inputSchema: {} },
  { name: 'shell_exec', description: 'run a command',  inputSchema: {} },
];

function permissionExecutor(): (call: ToolCallRequest) => Promise<ToolCallResult> {
  return async (call) => ({
    id:     call.id,
    name:   call.name,
    result: { success: false, error: 'Access denied: protected path (credentials/keys/.env)' },
  });
}

function timeoutExecutor(): (call: ToolCallRequest) => Promise<ToolCallResult> {
  return async (call) => ({
    id:     call.id,
    name:   call.name,
    result: { success: false, error: 'Operation timed out after 30 seconds' },
  });
}

function alternatingOkFailExecutor(): (call: ToolCallRequest) => Promise<ToolCallResult> {
  let n = 0;
  return async (call) => {
    n += 1;
    if (n % 2 === 1) {
      return { id: call.id, name: call.name, result: { success: true, content: 'A'.repeat(100) } };
    }
    return { id: call.id, name: call.name, result: { success: false, error: 'Rate limit exceeded, try again in 60s' } };
  };
}

describe('v4.2 Phase 2 — classifier integration', () => {
  beforeEach(() => { delete process.env.AIDEN_TCE; });
  afterEach(()  => { delete process.env.AIDEN_TCE; });

  it('AIDEN_TCE=0 opt-out: zero classification surface on trace', async () => {
    // v4.2 Phase 6 — TCE is ON by default; explicit `=0` opts out.
    process.env.AIDEN_TCE = '0';
    const provider = new LoopingMockProvider({
      mode: 'same-name-diff-args', loopTool: 'file_read', loopCount: 4,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: permissionExecutor(), maxTurns: 10,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'try' }] as Message[],
    );
    for (const entry of result.toolCallTrace) {
      expect(entry.classification).toBeUndefined();
      expect(entry.verification).toBeUndefined();
    }
  });

  it('v4.2 Phase 6 — default ON (env unset): classifier categorises failed entries', async () => {
    // Default-on sentinel. No env var → TCE active → classifier
    // fires on every verifier-failed call. permissionExecutor
    // returns `success: false` with the canonical access-denied
    // string, which the default classifier maps to `permission`.
    delete process.env.AIDEN_TCE;
    const provider = new LoopingMockProvider({
      mode: 'same-name-diff-args', loopTool: 'file_read', loopCount: 3,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: permissionExecutor(), maxTurns: 10,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'try' }] as Message[],
    );
    expect(result.toolCallTrace.length).toBeGreaterThan(0);
    for (const entry of result.toolCallTrace) {
      expect(entry.classification).toBeDefined();
      expect(entry.classification!.category).toBe('permission');
    }
  });

  it('AIDEN_TCE=1 + permission errors: classifier categorises every failed entry as permission', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode: 'same-name-diff-args', loopTool: 'file_read', loopCount: 4,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: permissionExecutor(), maxTurns: 10,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'try' }] as Message[],
    );
    expect(result.toolCallTrace.length).toBeGreaterThan(0);
    for (const entry of result.toolCallTrace) {
      expect(entry.verification).toBeDefined();
      expect(entry.verification!.ok).toBe(false);
      expect(entry.classification).toBeDefined();
      expect(entry.classification!.category).toBe('permission');
      expect(entry.classification!.recoverable).toBe(false);
    }
  });

  it('AIDEN_TCE=1 + timeout errors: classifier categorises every failed entry as timeout', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode: 'same-name-diff-args', loopTool: 'web_fetch', loopCount: 4,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: timeoutExecutor(), maxTurns: 10,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'fetch' }] as Message[],
    );
    expect(result.toolCallTrace.length).toBeGreaterThan(0);
    for (const entry of result.toolCallTrace) {
      expect(entry.classification).toBeDefined();
      expect(entry.classification!.category).toBe('timeout');
      expect(entry.classification!.recoverable).toBe(true);
      expect(entry.classification!.recoveryHint?.action).toBe('retry_with_backoff');
    }
  });

  it('AIDEN_TCE=1 + mixed ok/failed: classification only on failed entries', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode: 'same-name-diff-args', loopTool: 'web_fetch', loopCount: 6,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: alternatingOkFailExecutor(), maxTurns: 15,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'do stuff' }] as Message[],
    );
    expect(result.toolCallTrace.length).toBeGreaterThan(0);
    let okSeen = false, failSeen = false;
    for (const entry of result.toolCallTrace) {
      expect(entry.verification).toBeDefined();
      if (entry.verification!.ok) {
        okSeen = true;
        // ok entries have NO classification — saves cycles.
        expect(entry.classification).toBeUndefined();
      } else {
        failSeen = true;
        expect(entry.classification).toBeDefined();
        expect(entry.classification!.category).toBe('rate_limit');
      }
    }
    expect(okSeen).toBe(true);
    expect(failSeen).toBe(true);
  });
});
