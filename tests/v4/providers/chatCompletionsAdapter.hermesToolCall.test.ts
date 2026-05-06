import { describe, it, expect } from 'vitest';

import { extractHermesToolCalls } from '../../../providers/v4/chatCompletionsAdapter';

/**
 * Phase 21 #4 — Hermes/Qwen `<tool_call>` extraction parity tests.
 *
 * Direct port of Hermes hermes_parser.py behaviour. Each Aiden test
 * mirrors a scenario that exists in
 *   references/hermes-agent/tests/test_tool_call_parsers.py
 * (or is implied by the parser's regex contract). If a future model
 * subtly diverges from the Hermes format we want this suite to fail
 * loudly so we can fork the parser, not silently regress.
 */
describe('Phase 21 #4 — extractHermesToolCalls (Hermes parity)', () => {
  it('1. closed <tool_call> tag → synthesizes ToolCallRequest, strips from content', () => {
    const text =
      'Reasoning aside.\n<tool_call>{"name": "memory_read", "arguments": {"path": "USER.md"}}</tool_call>';
    const r = extractHermesToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls.length).toBe(1);
    expect(r!.toolCalls[0].name).toBe('memory_read');
    expect(r!.toolCalls[0].arguments).toEqual({ path: 'USER.md' });
    expect(r!.content).toBe('Reasoning aside.');
  });

  it('2. unclosed <tool_call> (truncated generation) is recovered', () => {
    const text = '<tool_call>{"name": "web_search", "arguments": {"query": "weather"}}';
    const r = extractHermesToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls[0].name).toBe('web_search');
    expect(r!.toolCalls[0].arguments).toEqual({ query: 'weather' });
    expect(r!.content).toBeNull(); // nothing before the tag
  });

  it('3. content without <tool_call> tag → null (no extraction, no false positive)', () => {
    expect(extractHermesToolCalls('Just regular text. {"foo": "bar"}')).toBeNull();
    expect(extractHermesToolCalls('')).toBeNull();
    expect(extractHermesToolCalls(null)).toBeNull();
    expect(extractHermesToolCalls(undefined)).toBeNull();
  });

  it('4. malformed JSON inside tag → null (no crash, no spurious tool call)', () => {
    const text = '<tool_call>not json at all</tool_call>';
    expect(extractHermesToolCalls(text)).toBeNull();
  });

  it('5. tag with name missing → skipped silently', () => {
    const text = '<tool_call>{"arguments": {"path": "x"}}</tool_call>';
    expect(extractHermesToolCalls(text)).toBeNull();
  });

  it('6. multiple tool_calls in one content → all extracted, content is everything before first tag', () => {
    const text =
      'Plan:\n<tool_call>{"name": "a", "arguments": {}}</tool_call><tool_call>{"name": "b", "arguments": {"k": 1}}</tool_call>';
    const r = extractHermesToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls.map((tc) => tc.name)).toEqual(['a', 'b']);
    expect(r!.toolCalls[1].arguments).toEqual({ k: 1 });
    expect(r!.content).toBe('Plan:');
  });

  it('7. exactly the user-reported leak shape (verbatim) extracts cleanly', () => {
    // From the user's bug report:
    //   "arguments": {"path": "USER.md"}}
    // The full leak looks like a partial Hermes tag — verify the
    // closed-form full string the model SHOULD have emitted parses to
    // a clean tool call with no leaked text.
    const text = '<tool_call>{"name": "memory_read", "arguments": {"path": "USER.md"}}</tool_call>';
    const r = extractHermesToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.content).toBeNull();
    expect(r!.toolCalls[0]).toEqual({
      id: expect.stringMatching(/^tc-hermes-/),
      name: 'memory_read',
      arguments: { path: 'USER.md' },
    });
  });
});
