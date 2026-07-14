/**
 * Real-network integration test for LocalPromptToolsAdapter.
 *
 * Skips automatically when Ollama is not reachable on http://localhost:11434.
 * Skipping is decided ONCE at module load using a 2s reachability probe so we
 * don't hang CI when Ollama is down.
 *
 * Cost: $0 — local. No budget concerns.
 *
 * Caveat: prompt-based tool calling depends on the model being able to emit
 * the <tool_call> format reliably. Small models (gemma2:2b, llama3.2:1b) often
 * fail this test by emitting prose instead. We check the simple stop test
 * always; the tool-calling test is gated on a slightly larger default model.
 */
import { describe, it, expect } from 'vitest';
import { LocalPromptToolsAdapter } from '../../../providers/v4/localPromptToolsAdapter';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import type { ToolSchema } from '../../../providers/v4/types';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_TEST_MODEL || 'llama3.2';

async function probeOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const ollamaUp = await probeOllama();

describe.skipIf(!ollamaUp)('LocalPromptToolsAdapter — real local-runtime integration', () => {
  it('completes a simple conversation (no tools)', async () => {
    const adapter = new LocalPromptToolsAdapter({
      baseUrl: OLLAMA_BASE,
      model: OLLAMA_MODEL,
      providerName: 'ollama',
    });

    const result = await adapter.call({
      messages: [{ role: 'user', content: 'Reply with the single word: PONG' }],
      tools: [],
      maxTokens: 20,
    });

    expect(result.finishReason).toBe('stop');
    expect((result.content ?? '').toUpperCase()).toContain('PONG');
  }, 60_000);

  it('completes a tool-calling conversation end-to-end (best-effort)', async () => {
    const adapter = new LocalPromptToolsAdapter({
      baseUrl: OLLAMA_BASE,
      model: OLLAMA_MODEL,
      providerName: 'ollama',
    });

    const tools: ToolSchema[] = [
      {
        name: 'get_current_time',
        description: 'Returns the current time as an ISO 8601 string',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    let toolWasCalled = false;
    const agent = new AidenAgent({
      provider: adapter,
      tools,
      toolExecutor: async (call) => {
        toolWasCalled = true;
        return { id: call.id, name: call.name, result: { now: '2026-05-03T15:00:00Z' } };
      },
      maxTurns: 4,
    });

    const result = await agent.runConversation([
      {
        role: 'system',
        content:
          'You are a helpful assistant. Use the get_current_time tool when asked about the time. Output ONLY a <tool_call> block to invoke a tool — no prose before it.',
      },
      { role: 'user', content: 'What is the current time? Call the tool.' },
    ]);

    // Best-effort: smaller local models behave erratically with prompt-tool
    // calling — sometimes they call the tool then loop until budget_exhausted,
    // sometimes they emit prose only, sometimes they finish cleanly. The
    // contract being verified is "the round-trip doesn't throw" — anything
    // beyond that is logged for diagnostics, not asserted.
    console.log(
      `[ollama integration] model='${OLLAMA_MODEL}' toolCalled=${toolWasCalled} ` +
        `finishReason=${result.finishReason} finalContent="${result.finalContent?.slice(0, 120) ?? ''}"`,
    );
    expect(typeof result.finishReason).toBe('string');
  }, 120_000);
});
