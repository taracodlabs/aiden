import { describe, it, expect } from 'vitest';
import {
  ModelMetadata,
  tokenizerAvailable,
  _allCatalogIds,
} from '../../core/v4/modelMetadata';
import type { Message, ToolSchema } from '../../providers/v4/types';

describe('ModelMetadata', () => {
  const md = new ModelMetadata();

  it('1. getLimits returns known catalog model', () => {
    const limits = md.getLimits('groq', 'llama-3.1-8b-instant');
    expect(limits.contextLength).toBe(131_072);
    expect(limits.maxOutputTokens).toBe(8_192);
    expect(limits.compressionThreshold).toBe(0.5);
  });

  it('2. getLimits falls back to defaults for unknown', () => {
    const limits = md.getLimits('does-not-exist', 'phantom-model');
    const defaults = md.getDefaults();
    expect(limits.contextLength).toBe(defaults.contextLength);
    expect(limits.maxOutputTokens).toBe(defaults.maxOutputTokens);
  });

  it('3. estimateTokens uses tiktoken when available', () => {
    if (!tokenizerAvailable()) {
      // Fallback path — char/4
      expect(md.estimateTokens('hello world')).toBe(Math.ceil(11 / 4));
      return;
    }
    // tiktoken should give ~2-3 tokens for "hello world"
    const n = md.estimateTokens('hello world');
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
  });

  it('4. estimateTokens char/4 fallback handles empty + short strings', () => {
    expect(md.estimateTokens('')).toBe(0);
    // Whatever the path, single chars are at least 1 token.
    expect(md.estimateTokens('a')).toBeGreaterThanOrEqual(1);
  });

  it('5. estimateMessageTokens accounts for per-message envelope', () => {
    const m: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    // At least 10 tokens overhead per message → ≥ 20 even before content.
    expect(md.estimateMessageTokens(m)).toBeGreaterThanOrEqual(20);
  });

  it('6. estimateToolTokens scales with tool count', () => {
    const tools: ToolSchema[] = [
      {
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    ];
    const single = md.estimateToolTokens(tools);
    const triple = md.estimateToolTokens([...tools, ...tools, ...tools]);
    expect(triple).toBeGreaterThan(single * 2);
  });

  it('7. compressionThreshold default is 0.5', () => {
    expect(md.getDefaults().compressionThreshold).toBe(0.5);
  });

  it('8. reservedForOutput is sensible (positive, ≤ contextLength)', () => {
    for (const { providerId, modelId } of _allCatalogIds()) {
      const lim = md.getLimits(providerId, modelId);
      expect(lim.reservedForOutput).toBeGreaterThan(0);
      expect(lim.reservedForOutput).toBeLessThanOrEqual(lim.contextLength);
    }
  });

  it('9. all catalog models have valid limits', () => {
    for (const { providerId, modelId } of _allCatalogIds()) {
      const lim = md.getLimits(providerId, modelId);
      expect(lim.contextLength).toBeGreaterThanOrEqual(8_192);
      expect(lim.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('10. token estimation is deterministic (same input → same output)', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(5);
    const a = md.estimateTokens(text);
    const b = md.estimateTokens(text);
    expect(a).toBe(b);
  });

  it('11. assistant message with toolCalls counts call envelope', () => {
    const m: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'web_search', arguments: { q: 'aiden v4' } },
        ],
      },
    ];
    expect(md.estimateMessageTokens(m)).toBeGreaterThan(PER_OVERHEAD);
  });
});

const PER_OVERHEAD = 10;
