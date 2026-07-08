/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.15 delivery-isolation — Phase 8.
 *
 * Three guarantees:
 *   1. ALL nine channels carry a SEALED per-turn address — every channel routes
 *      its reply through a DeliveryBinding whose driver delivers to the exact
 *      target it was built with (never a shared / global "current recipient").
 *   2. DEAD TARGETS are remembered at the ctx.send choke-point: a terminal
 *      403/404 retires the target, the next send is skipped (no hammering), and
 *      a fresh inbound revives it.
 *   3. A multi-chunk delivery no longer ABANDONS the rest on a transient chunk
 *      failure — it steps past and reports `partial`; a terminal chunk failure
 *      stops and signals the dead-target guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDeliveryContext,
  isTargetDead,
  reviveTarget,
  markTargetDead,
  _resetDeadTargets,
  TEXT_DELIVERY_CAPABILITIES,
  type DeliveryBinding,
} from '../../../core/deliveryContext';
import { gateway } from '../../../core/gateway';

import { TelegramAdapter } from '../../../core/channels/telegram';
import { DiscordAdapter } from '../../../core/channels/discord';
import { SlackAdapter } from '../../../core/channels/slack';
import { SignalAdapter } from '../../../core/channels/signal';
import { IMessageAdapter } from '../../../core/channels/imessage';
import { WhatsAppAdapter } from '../../../core/channels/whatsapp';
import { EmailAdapter } from '../../../core/channels/email';
import { TwilioAdapter } from '../../../core/channels/twilio';
import { WebhookAdapter } from '../../../core/channels/webhook';

beforeEach(() => { _resetDeadTargets(); });

// ── 1. All nine channels carry a sealed address ──────────────────────────────
//
// For every channel we build its per-turn binding for a DISTINCT target, wrap it
// in a DeliveryContext, and prove ctx.send('final', …) reaches THAT target's send
// primitive — and that the routing is frozen.

describe('sealed address — every channel routes to its own frozen target', () => {
  it('createDeliveryContext freezes the routing for any channel binding', () => {
    const deliver = vi.fn(async (kind: string) => ({ ok: true, kind }));
    const binding: DeliveryBinding = { driver: { deliver: deliver as any }, capabilities: TEXT_DELIVERY_CAPABILITIES };
    const ctx = createDeliveryContext({ platform: 'signal', chatId: '+15551234567' }, binding);
    expect(ctx.platform).toBe('signal');
    expect(ctx.chatId).toBe('+15551234567');
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => { (ctx as any).chatId = 'HIJACK'; }).toThrow();
  });

  it('telegram → deliverToChat(chatId)', async () => {
    const a = new TelegramAdapter() as any;
    a.deliverToChat = vi.fn(async () => ({ ok: true, sent: 1, total: 1 }));
    const ctx = createDeliveryContext({ platform: 'telegram', chatId: 'TG_CHAT' }, a.buildDeliveryBinding('TG_CHAT'));
    await ctx.send('final', 'hi');
    expect(a.deliverToChat).toHaveBeenCalledWith('TG_CHAT', 'hi');
  });

  it('signal → deliverSealed(target)', async () => {
    const a = new SignalAdapter() as any;
    a.deliverSealed = vi.fn(async () => ({ ok: true }));
    const ctx = createDeliveryContext({ platform: 'signal', chatId: 'SIG_1' }, a.buildDeliveryBinding('SIG_1'));
    await ctx.send('final', 'hi');
    expect(a.deliverSealed).toHaveBeenCalledWith('SIG_1', 'hi');
  });

  it('imessage → deliverSealed(target)', async () => {
    const a = new IMessageAdapter() as any;
    a.deliverSealed = vi.fn(async () => ({ ok: true }));
    const ctx = createDeliveryContext({ platform: 'imessage', chatId: 'IM_1' }, a.buildDeliveryBinding('IM_1'));
    await ctx.send('final', 'hi');
    expect(a.deliverSealed).toHaveBeenCalledWith('IM_1', 'hi');
  });

  it('whatsapp → deliverSealed(target)', async () => {
    const a = new WhatsAppAdapter() as any;
    a.deliverSealed = vi.fn(async () => ({ ok: true }));
    const ctx = createDeliveryContext({ platform: 'whatsapp', chatId: 'WA_1@c.us' }, a.buildDeliveryBinding('WA_1@c.us'));
    await ctx.send('final', 'hi');
    expect(a.deliverSealed).toHaveBeenCalledWith('WA_1@c.us', 'hi');
  });

  it('slack → deliverSealed(channel, threadTs)', async () => {
    const a = new SlackAdapter() as any;
    a.deliverSealed = vi.fn(async () => ({ ok: true }));
    const ctx = createDeliveryContext({ platform: 'slack', chatId: 'SL_C', threadId: 'TS9' }, a.buildDeliveryBinding('SL_C', 'TS9'));
    await ctx.send('final', 'hi');
    expect(a.deliverSealed).toHaveBeenCalledWith('SL_C', 'hi', 'TS9');
  });

  it('email → replyEmail(to, subject) (threaded)', async () => {
    const a = new EmailAdapter() as any;
    a.replyEmail = vi.fn(async () => ({ ok: true }));
    const ctx = createDeliveryContext({ platform: 'email', chatId: 'a@b.com' }, a.buildDeliveryBinding('a@b.com', 'Hello'));
    await ctx.send('final', 'hi');
    expect(a.replyEmail).toHaveBeenCalledWith('a@b.com', 'Hello', 'hi');
  });

  it('discord → sink(chunk) (already sealed)', async () => {
    const a = new DiscordAdapter() as any;
    const sink = vi.fn(async () => undefined);
    const ctx = createDeliveryContext({ platform: 'discord', chatId: 'DC_1' }, a.buildDeliveryBinding(sink));
    await ctx.send('final', 'hi');
    expect(sink).toHaveBeenCalledWith('hi', 0);
  });

  it('twilio → writes TwiML to THIS request/response', async () => {
    const a = new TwilioAdapter() as any;
    const res = { headersSent: false, send: vi.fn(), json: vi.fn() };
    const ctx = createDeliveryContext({ platform: 'sms', chatId: '+15550001111' }, a.buildResponseBinding(res));
    await ctx.send('final', 'hi there');
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(String(res.send.mock.calls[0][0])).toContain('hi there');
    expect(String(res.send.mock.calls[0][0])).toContain('<Message>');
  });

  it('webhook → writes JSON to THIS request/response', async () => {
    const a = new WebhookAdapter() as any;
    const res = { headersSent: false, send: vi.fn(), json: vi.fn() };
    const ctx = createDeliveryContext({ platform: 'api', chatId: 'webhook' }, a.buildResponseBinding(res));
    await ctx.send('final', 'hi there');
    expect(res.json).toHaveBeenCalledWith({ response: 'hi there' });
  });
});

// ── 2. Dead-target memory at the choke-point ─────────────────────────────────

describe('dead-target memory — skip on terminal, revive on inbound', () => {
  function mkCtx(deliverImpl: (kind: string) => Promise<any>) {
    const deliver = vi.fn(deliverImpl);
    const binding: DeliveryBinding = { driver: { deliver: deliver as any }, capabilities: TEXT_DELIVERY_CAPABILITIES };
    return { ctx: createDeliveryContext({ platform: 'telegram', chatId: 'DEADCHAT' }, binding), deliver };
  }

  it('★ terminal failure retires the target; the NEXT send is skipped (no hammering); revive re-enables', async () => {
    const { ctx, deliver } = mkCtx(async (kind) => ({ ok: false, kind, terminal: true })); // bot blocked → 403

    const r1 = await ctx.send('final', 'one');
    expect(r1.terminal).toBe(true);
    expect(isTargetDead('telegram', 'DEADCHAT')).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);

    const r2 = await ctx.send('final', 'two');           // dead → skipped
    expect(r2.skippedDead).toBe(true);
    expect(r2.ok).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);            // driver NOT hit again

    reviveTarget('telegram', 'DEADCHAT');                 // e.g. a fresh inbound
    await ctx.send('final', 'three');
    expect(deliver).toHaveBeenCalledTimes(2);             // attempted once more
  });

  it('a healthy send never marks the target dead', async () => {
    const { ctx } = mkCtx(async (kind) => ({ ok: true, kind }));
    await ctx.send('final', 'ok');
    expect(isTargetDead('telegram', 'DEADCHAT')).toBe(false);
  });

  it('★ a fresh inbound revives a dead target (gateway.routeMessage → reviveTarget)', async () => {
    markTargetDead('telegram', 'C1', 'bot was blocked');
    expect(isTargetDead('telegram', 'C1')).toBe(true);
    gateway.setProcessor(async () => 'ok');
    await gateway.routeMessage({ channel: 'telegram', channelId: 'C1', userId: 'u', text: 'hi', timestamp: 0 });
    expect(isTargetDead('telegram', 'C1')).toBe(false);   // inbound proved reachability
  });
});

// ── 3. Chunk-loop: a transient failure doesn't abandon the rest ──────────────

describe('telegram deliverToChat — partial delivery, no abandonment', () => {
  const LONG = 'x'.repeat(4096 * 3);   // guarantees ≥ 3 chunks at the 4096 boundary

  it('★ a TRANSIENT mid-message chunk failure steps past — the rest still send (partial)', async () => {
    const a = new TelegramAdapter() as any;
    let call = 0;
    const sendMessage = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error('temporary network blip');   // transient: not parse/429/403
      return {};
    });
    a.client = { sendMessage };

    const r = await a.deliverToChat('C1', LONG);
    expect(r.total).toBeGreaterThanOrEqual(3);
    expect(sendMessage).toHaveBeenCalledTimes(r.total);   // did NOT abandon after chunk 2
    expect(r.sent).toBe(r.total - 1);
    expect(r.partial).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.terminal).toBeFalsy();
  });

  it('a TERMINAL chunk failure (403 blocked) stops and signals terminal for the dead-target guard', async () => {
    const a = new TelegramAdapter() as any;
    const sendMessage = vi.fn(async () => {
      const e: any = new Error('Forbidden');
      e.response = { body: { error_code: 403, description: 'bot was blocked by the user' } };
      throw e;
    });
    a.client = { sendMessage };

    const r = await a.deliverToChat('C1', LONG);
    expect(sendMessage).toHaveBeenCalledTimes(1);          // stopped at the dead target
    expect(r.terminal).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(0);
  });

  it('all chunks succeed → ok, not partial, not terminal', async () => {
    const a = new TelegramAdapter() as any;
    a.client = { sendMessage: vi.fn(async () => ({})) };
    const r = await a.deliverToChat('C1', LONG);
    expect(r.ok).toBe(true);
    expect(r.partial).toBeFalsy();
    expect(r.terminal).toBeFalsy();
    expect(r.sent).toBe(r.total);
  });
});
