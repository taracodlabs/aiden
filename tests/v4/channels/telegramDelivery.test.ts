/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 DC.2 — Telegram migrated onto the DeliveryContext seam, BYTE-IDENTICAL.
 *
 * The migration is a re-wire, not a re-implementation: the Telegram delivery
 * driver routes 'final' (and 'status') text through the UNCHANGED deliverToChat
 * (chunkAtBoundary + parse_mode + 429/parse retry). This test proves the driver
 * delegates to deliverToChat verbatim, declares honest capabilities, and
 * rejects not-yet-wired kinds instead of silently dropping them. Chunking-
 * boundary byte-identity is covered by the existing chunkAtBoundary smoke
 * (that method is untouched).
 */
import { describe, it, expect, vi } from 'vitest';
import { TelegramAdapter } from '../../../core/channels/telegram';

function mkAdapter() {
  const a = new TelegramAdapter() as any;
  // v4.15 — deliverToChat now returns a structured result (ok + chunk/terminal
  // detail) so the seam can retire dead targets and report partial delivery.
  const deliverToChat = vi.fn(async () => ({ ok: true, sent: 1, total: 1 }));
  a.deliverToChat = deliverToChat;               // spy the primitive
  return { a, deliverToChat };
}

describe('DC.2 — Telegram delivery binding (byte-identical re-wire)', () => {
  it('declares honest capabilities (chunkLongMessages true; media/voice/edit not yet wired)', () => {
    const { a } = mkAdapter();
    const binding = a.buildDeliveryBinding('CHAT1');
    expect(binding.capabilities).toEqual({
      edit: false,
      chunkLongMessages: true,
      media: [],
      voiceBubble: false,
      reactions: false,
    });
  });

  it('carries the exact pre-migration first-message tip (byte-identical text)', () => {
    const { a } = mkAdapter();
    const binding = a.buildDeliveryBinding('CHAT1');
    expect(binding.firstMessageHint).toBe(
      '_Tip: Continue this conversation on your desktop dashboard with full context._',
    );
  });

  it("★ driver 'final' routes verbatim through the unchanged deliverToChat", async () => {
    const { a, deliverToChat } = mkAdapter();
    const binding = a.buildDeliveryBinding('CHAT1');
    const r = await binding.driver.deliver('final', { text: 'hello *world*' });
    expect(deliverToChat).toHaveBeenCalledWith('CHAT1', 'hello *world*');
    expect(r).toEqual({ ok: true, kind: 'final' });
  });

  it("'status' also routes through deliverToChat (same text primitive)", async () => {
    const { a, deliverToChat } = mkAdapter();
    const binding = a.buildDeliveryBinding('CHAT1');
    await binding.driver.deliver('status', { text: 'ok' });
    expect(deliverToChat).toHaveBeenCalledWith('CHAT1', 'ok');
  });

  it('★ not-yet-wired kinds (media/progress/approval) return an honest not-supported receipt, never silently drop', async () => {
    const { a, deliverToChat } = mkAdapter();
    const binding = a.buildDeliveryBinding('CHAT1');
    for (const kind of ['media', 'progress', 'approval'] as const) {
      const r = await binding.driver.deliver(kind, { text: 'x' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(new RegExp(kind, 'i'));
    }
    expect(deliverToChat).not.toHaveBeenCalled();
  });
});
