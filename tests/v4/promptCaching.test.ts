import { describe, it, expect } from 'vitest';
import { PromptCaching } from '../../core/v4/promptCaching';
import type { Message } from '../../providers/v4/types';

describe('PromptCaching', () => {
  const pc = new PromptCaching();

  it('1. isSupported returns true for anthropic', () => {
    expect(pc.isSupported('anthropic', 'claude-opus-4-7')).toBe(true);
  });

  it('2. isSupported returns false for non-anthropic', () => {
    expect(pc.isSupported('groq', 'llama-3.1-8b-instant')).toBe(false);
    expect(pc.isSupported('openai', 'gpt-5.4')).toBe(false);
    // The removed Claude subscription provider is no longer cache-eligible.
    expect(pc.isSupported('claude-pro', 'claude-opus-4-7')).toBe(false);
  });

  it('3. applyMarkers adds cache_control to system message (anthropic)', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const out = pc.applyMarkers(messages, 'anthropic');
    expect((out[0] as { cache_control?: { type: string } }).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('4. applyMarkers no-op for non-anthropic', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const out = pc.applyMarkers(messages, 'groq');
    expect((out[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it('5. stripMarkers removes cache_control fields', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys', cache_control: { type: 'ephemeral' } } as unknown as Message,
      { role: 'user', content: 'hi' },
    ];
    const out = pc.stripMarkers(messages);
    expect((out[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect(out[0].content).toBe('sys');
  });

  it('6. round-trip: apply then strip preserves content', () => {
    const messages: Message[] = [
      { role: 'system', content: 'IDENTITY' },
      { role: 'user', content: 'hello' },
    ];
    const marked = pc.applyMarkers(messages, 'anthropic');
    const stripped = pc.stripMarkers(marked);
    expect(stripped[0].content).toBe('IDENTITY');
    expect(stripped[1].content).toBe('hello');
    expect((stripped[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it('7. applyMarkers does not mutate input array', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const before = JSON.stringify(messages);
    pc.applyMarkers(messages, 'anthropic');
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('8. handles missing system message gracefully', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const out = pc.applyMarkers(messages, 'anthropic');
    expect(out).toEqual(messages);
  });
});
