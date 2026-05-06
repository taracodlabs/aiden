/**
 * core/v4/promptCaching.ts — Aiden v4.0.0 (Phase 13)
 *
 * Anthropic prefix-cache breakpoint manager. We attach `cache_control`
 * markers to the system message so the Anthropic adapter can serialise
 * them to wire format (`{type: 'ephemeral'}`).
 *
 * Other providers' caching is implicit (OpenAI prefix cache, Groq cache)
 * and needs no markers — `applyMarkers` is a no-op for them.
 *
 * Hermes reference: agent/anthropic_adapter.py — _attach_cache_control()
 * and _ephemeral_blocks(). Aiden v4.0.0 only marks the system message
 * (the most-stable prefix); marking the last-tool-result for incremental
 * cache extension lands in v4.1.
 */

import type { Message } from '../../providers/v4/types';

interface CachedSystemMessage {
  role: 'system';
  content: string;
  /** Anthropic-only metadata, dropped by other adapters. */
  cache_control?: { type: 'ephemeral' };
}

export class PromptCaching {
  /** True when this provider supports prefix caching markers (Anthropic only for v4.0.0). */
  isSupported(providerId: string, _modelId: string): boolean {
    // Phase 21 #5: legacy `claude_subscription` removed; canonical OAuth
    // ID is `claude-pro` (the only Claude OAuth route through the Phase 18
    // tokenStore).
    return providerId === 'anthropic' || providerId === 'claude-pro';
  }

  /**
   * Attach cache markers to the leading system message. Returns a new
   * messages array; never mutates input. No-op for non-Anthropic providers.
   */
  applyMarkers(messages: Message[], providerId: string): Message[] {
    if (!this.isSupported(providerId, '')) return messages.slice();

    const out: Message[] = messages.slice();
    const sysIdx = out.findIndex((m) => m.role === 'system');
    if (sysIdx === -1) return out;

    const sys = out[sysIdx] as Message & { cache_control?: { type: 'ephemeral' } };
    const marked: CachedSystemMessage = {
      role: 'system',
      content: sys.content,
      cache_control: { type: 'ephemeral' },
    };
    out[sysIdx] = marked as unknown as Message;
    return out;
  }

  /**
   * Strip cache markers from any message that carries them. Used when
   * switching providers mid-session so a non-Anthropic adapter doesn't
   * see fields it can't serialise.
   */
  stripMarkers(messages: Message[]): Message[] {
    return messages.map((m) => {
      const withMarker = m as Message & { cache_control?: unknown };
      if (withMarker.cache_control === undefined) return m;
      const { cache_control: _drop, ...rest } = withMarker as Record<string, unknown> & Message;
      return rest as Message;
    });
  }
}
