/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 DC.3 — Discord migrated onto the DeliveryContext seam.
 *
 * ★ The payoff: Discord used to hard-truncate at substring(0, 2000), losing
 * everything past 2000 chars. Adopting the seam gives it proper chunking — the
 * bug is fixed by the shared capability, not a hand-patch. These tests prove a
 * >2000-char reply is CHUNKED (full content delivered, nothing cut off), a
 * short reply is one message, capabilities are declared honestly, unrouted
 * kinds return honest receipts, and concurrent Telegram+Discord turns each
 * route to their own platform via their own immutable ctx.
 */
import { describe, it, expect, vi } from 'vitest';
import { DiscordAdapter } from '../../../core/channels/discord';
import { gateway, type IncomingMessage } from '../../../core/gateway';
import type { DeliveryBinding } from '../../../core/deliveryContext';

let seq = 0;
const uid = () => `u_${Date.now()}_${seq++}`;

function mkAdapter() { return new DiscordAdapter() as any; }

describe('DC.3 — Discord delivery binding (chunking replaces truncation)', () => {
  it('stays disabled when no bot token is configured', async () => {
    const previousToken = process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;

    try {
      const adapter = new DiscordAdapter();
      await adapter.start();
      expect(adapter.isHealthy()).toBe(false);
    } finally {
      if (previousToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = previousToken;
    }
  });

  it('declares honest capabilities (chunkLongMessages true; edit/media/etc not wired)', () => {
    const a = mkAdapter();
    const binding: DeliveryBinding = a.buildDeliveryBinding(async () => {});
    expect(binding.capabilities).toEqual({
      edit: false,
      chunkLongMessages: true,
      media: [],
      voiceBubble: false,
      reactions: false,
    });
    expect(binding.firstMessageHint).toBeUndefined();   // no telegram-style tip
  });

  it('★ a >2000-char reply is CHUNKED — full content delivered, nothing truncated', async () => {
    const a = mkAdapter();
    const sent: string[] = [];
    const idx: number[] = [];
    const binding: DeliveryBinding = a.buildDeliveryBinding(async (chunk: string, i: number) => {
      sent.push(chunk); idx.push(i);
    });
    // 4500 chars, no whitespace → deterministic hard-cut chunks; the trailing
    // 'C'*500 is exactly what the old substring(0,2000) would have DROPPED.
    const long = 'A'.repeat(2000) + 'B'.repeat(2000) + 'C'.repeat(500);
    const r = await binding.driver.deliver('final', { text: long });

    expect(r).toEqual({ ok: true, kind: 'final', chunks: 3 });
    expect(sent).toHaveLength(3);
    expect(idx).toEqual([0, 1, 2]);                       // sink gets chunk indices
    expect(sent.every((c) => c.length <= 2000)).toBe(true);
    expect(sent.join('')).toBe(long);                     // nothing lost
    expect(sent.join('')).toContain('C'.repeat(500));     // the truncated tail is now delivered
  });

  it('a short reply sends as exactly one message (no chunking, no double-send)', async () => {
    const a = mkAdapter();
    const sent: string[] = [];
    const binding: DeliveryBinding = a.buildDeliveryBinding(async (chunk: string) => { sent.push(chunk); });
    const r = await binding.driver.deliver('final', { text: 'hi there' });
    expect(sent).toEqual(['hi there']);
    expect(r).toEqual({ ok: true, kind: 'final', chunks: 1 });
  });

  it('★ unrouted kinds (media/progress/approval) → honest not-supported receipt, sink untouched', async () => {
    const a = mkAdapter();
    const sent: string[] = [];
    const binding: DeliveryBinding = a.buildDeliveryBinding(async (c: string) => { sent.push(c); });
    for (const kind of ['media', 'progress', 'approval'] as const) {
      const r = await binding.driver.deliver(kind, { text: 'x' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(new RegExp(kind, 'i'));
    }
    expect(sent).toHaveLength(0);
  });

  it("'status' also chunks through the same sink", async () => {
    const a = mkAdapter();
    const sent: string[] = [];
    const binding: DeliveryBinding = a.buildDeliveryBinding(async (c: string) => { sent.push(c); });
    await binding.driver.deliver('status', { text: 'D'.repeat(2100) });
    expect(sent).toHaveLength(2);
    expect(sent.join('')).toBe('D'.repeat(2100));
  });
});

describe('DC.3 — concurrent Telegram + Discord route to their own platform', () => {
  const msg = (channel: IncomingMessage['channel'], channelId: string): IncomingMessage =>
    ({ channel, channelId, userId: uid(), text: 'x', timestamp: 0 });

  it('★ interleaved turns on two platforms each deliver to their own ctx (no cross-routing)', async () => {
    gateway.setProcessor(async (_m, ctx) => {
      await new Promise((r) => setTimeout(r, 5));
      return `R:${ctx?.platform}:${ctx?.chatId}`;
    });

    const tgSent: string[] = [];
    const tgBinding: DeliveryBinding = {
      capabilities: { edit: false, chunkLongMessages: true, media: [], voiceBubble: false, reactions: false },
      driver: { deliver: async (kind, payload) => { tgSent.push(payload.text ?? ''); return { ok: true, kind }; } },
    };
    const a = mkAdapter();
    const dcSent: string[] = [];
    const dcBinding: DeliveryBinding = a.buildDeliveryBinding(async (c: string) => { dcSent.push(c); });

    const [rt, rd] = await Promise.all([
      gateway.routeMessage(msg('telegram', 'TG1'), tgBinding),
      gateway.routeMessage(msg('discord', 'DC1'), dcBinding),
    ]);

    expect(rt).toBe('R:telegram:TG1');
    expect(tgSent).toEqual(['R:telegram:TG1']);
    expect(rd).toBe('R:discord:DC1');
    expect(dcSent).toEqual(['R:discord:DC1']);   // discord's own ctx, no bleed from telegram
  });
});
