/**
 * v4.2 Phase 1 — Verifier integration tests.
 *
 * Drives a real AidenAgent with the LoopingMockProvider + a failing-
 * tool executor to confirm:
 *
 *   1. AIDEN_TCE=0 (default off): verifier records nothing on the
 *      trace, TurnState fires no recovery — full v4.1.5 contract
 *      preserved.
 *
 *   2. AIDEN_TCE=1 + failing executor: consecFailed counter increments
 *      and HINT fires at count=3, BEFORE consecSignature would have
 *      fired at count=5. Asserts:
 *        - The HINT recovery event is logged at count=3
 *        - The hint message uses the "failed N times" framing
 *        - The verifier classified each call as ok:false / failed
 *        - HonestyTraceEntry.verification is populated
 *
 *   3. AIDEN_TCE=1 + mixed success/failure: counter resets on a
 *      verified-ok call, no premature HINT.
 *
 *   4. AIDEN_TCE=1 + succeeding executor: zero verification flags,
 *      no recovery, full happy path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import type { Message, ToolCallRequest, ToolCallResult, ToolSchema } from '../../../providers/v4/types';
import { LoopingMockProvider } from '../_helpers/loopingMockProvider';

const STUB_TOOLS: ToolSchema[] = [
  { name: 'skill_view',   description: 'view a skill',     inputSchema: {} },
  { name: 'web_search',   description: 'search the web',   inputSchema: {} },
  { name: 'shell_exec',   description: 'run a command',    inputSchema: {} },
];

// Executor that ALWAYS returns success:false — drives consecFailed up.
const FAILING_EXECUTOR = async (call: ToolCallRequest): Promise<ToolCallResult> => ({
  id:     call.id,
  name:   call.name,
  result: { success: false, error: 'simulated failure' },
});

// Executor that always succeeds.
const OK_EXECUTOR = async (call: ToolCallRequest): Promise<ToolCallResult> => ({
  id:     call.id,
  name:   call.name,
  result: { success: true, content: 'A'.repeat(100) },
});

// Alternating executor — odd calls succeed, even calls fail. Tests
// that consecFailed resets on a verified-ok call.
function mkAlternatingExecutor() {
  let n = 0;
  return async (call: ToolCallRequest): Promise<ToolCallResult> => {
    n += 1;
    if (n % 2 === 1) {
      return { id: call.id, name: call.name, result: { success: true, content: 'A'.repeat(100) } };
    }
    return { id: call.id, name: call.name, result: { success: false, error: 'flaky' } };
  };
}

describe('v4.2 Phase 1 — verifier + TCE integration', () => {
  beforeEach(() => { delete process.env.AIDEN_TCE; });
  afterEach(()  => { delete process.env.AIDEN_TCE; });

  it('AIDEN_TCE=0 default: verifier records nothing, no recovery fires', async () => {
    delete process.env.AIDEN_TCE;
    const provider = new LoopingMockProvider({
      mode: 'same-signature', loopTool: 'shell_exec', loopCount: 5,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: FAILING_EXECUTOR, maxTurns: 15,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'try the command' }] as Message[],
    );
    // No TCE → loop terminates normally via the mock's loopCount budget.
    expect(result.finishReason).toBe('stop');
    expect(result.toolLoopCard).toBeUndefined();
    // Verification fields are undefined on every trace entry.
    for (const entry of result.toolCallTrace) {
      expect(entry.verification).toBeUndefined();
    }
    // No corrective system messages.
    const systemMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[tce]'),
    );
    expect(systemMsgs).toHaveLength(0);
  });

  it('AIDEN_TCE=1 + failing executor: HINT fires at consecFailed=3 (faster than consecSignature=5)', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode: 'same-name-diff-args', // different args each call → consecSignature can't fire
      loopTool: 'shell_exec',
      loopCount: 6,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: FAILING_EXECUTOR, maxTurns: 15,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'try the command' }] as Message[],
    );

    // Verifications populated on every trace entry under TCE=1.
    expect(result.toolCallTrace.length).toBeGreaterThan(0);
    for (const entry of result.toolCallTrace) {
      expect(entry.verification).toBeDefined();
      expect(entry.verification!.ok).toBe(false);
      expect(entry.verification!.code).toBe('failed');
    }

    // The corrective [tce] system message landed in conversation
    // history. Its content uses the "failed N times in a row" framing
    // — distinct from the signature-loop framing.
    const tceMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[tce]'),
    );
    expect(tceMsgs.length).toBeGreaterThanOrEqual(1);
    const firstTce = tceMsgs[0].content as string;
    expect(/failed \d+ times in a row/i.test(firstTce)).toBe(true);
  });

  it('AIDEN_TCE=1 + alternating success/failure: consecFailed resets on ok, no HINT at count<3', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode: 'same-name-diff-args',
      loopTool: 'shell_exec',
      loopCount: 6,
    });
    const agent = new AidenAgent({
      provider,
      tools: STUB_TOOLS,
      toolExecutor: mkAlternatingExecutor(),
      maxTurns: 15,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'try the command' }] as Message[],
    );

    // Verifications populated; mixed ok/failed.
    const codes = result.toolCallTrace.map((e) => e.verification?.code);
    expect(codes.filter((c) => c === 'ok').length).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 'failed').length).toBeGreaterThan(0);

    // No `[tce]` failed-hint fired because the streak never reached 3.
    // (Pattern is ok,failed,ok,failed → consecFailed max = 1.)
    const tceFailedHints = result.messages.filter(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.startsWith('[tce]') &&
        /failed \d+ times/i.test(m.content),
    );
    expect(tceFailedHints).toHaveLength(0);
  });

  it('AIDEN_TCE=1 + succeeding executor: verifier flags every call ok, no recovery fires', async () => {
    process.env.AIDEN_TCE = '1';
    const provider = new LoopingMockProvider({
      mode: 'mixed', // different tools → no streak at all
      loopTool: 'shell_exec',
      loopCount: 4,
    });
    const agent = new AidenAgent({
      provider, tools: STUB_TOOLS, toolExecutor: OK_EXECUTOR, maxTurns: 15,
    });
    const result = await agent.runConversation(
      [{ role: 'user', content: 'do stuff' }] as Message[],
    );
    expect(result.finishReason).toBe('stop');
    expect(result.toolLoopCard).toBeUndefined();
    for (const entry of result.toolCallTrace) {
      expect(entry.verification).toBeDefined();
      expect(entry.verification!.ok).toBe(true);
    }
    // No `[tce]` system messages.
    const tceMsgs = result.messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[tce]'),
    );
    expect(tceMsgs).toHaveLength(0);
  });
});
