// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/gateway.ts — Unified channel router.
// All inbound messages (dashboard, Telegram, API, future channels)
// are routed through a single processor so they share the same
// memory, context, and tool pipeline.
//
// Phase v4.1-1.3a — replaced direct console.* writes with the
// Logger contract from `core/v4/logger`. The CLI's REPL is sacred:
// in cli-interactive mode the boot logger has no stdout sink, so
// route/register lines go to ~/.aiden/logs/aiden.log instead of
// corrupting the chat prompt. The legacy code path remains
// available — until `attachLogger()` is called the noopLogger
// silently drops every record (better than console.log for the
// REPL invariant). api/server.ts in serve mode wires a logger
// that writes NDJSON to stdout, preserving the daemon trace.

import { sessionRouter } from './sessionRouter'
import { noopLogger, type Logger } from './v4/logger'
import {
  createDeliveryContext,
  type DeliveryBinding,
  type DeliveryContext,
} from './deliveryContext'
import {
  withIdempotentDelivery,
  type IdempotentDeliveryIdent,
} from './v4/idempotentDelivery'
import type { SideEffectLedger } from './v4/sideEffectLedger'

// ── Types ──────────────────────────────────────────────────────

export type ChannelType =
  | 'dashboard'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'whatsapp'
  | 'signal'
  | 'sms'
  | 'imessage'
  | 'email'
  | 'api'
  | 'tui'

export interface IncomingMessage {
  channel:      ChannelType
  channelId:    string          // chat ID, user ID, etc.
  userId:       string          // unique user identifier
  text:         string
  attachments?: string[]
  timestamp:    number
  replyTo?:     string          // message ID being replied to
  threadId?:    string          // platform thread/topic id (e.g. forum topic); optional
  sessionId?:   string          // stable cross-channel session ID (set by routeMessage)
}

export interface OutgoingMessage {
  channel:   ChannelType
  channelId: string
  text:      string
  metadata?: {
    toolsUsed?: string[]
    cost?:      number
    duration?:  number
  }
}

// DC.1 — the processor receives the immutable per-turn DeliveryContext (when a
// caller bound one) so future mid-run delivery (progress/status) routes to the
// frozen target. Existing processors ignore the second arg — back-compatible.
export type MessageHandler  = (message: IncomingMessage, ctx?: DeliveryContext) => Promise<string>
export type DeliveryHandler = (message: OutgoingMessage) => Promise<boolean>

// ── Gateway class ──────────────────────────────────────────────

class Gateway {
  private handlers:         Map<ChannelType, DeliveryHandler> = new Map()
  private messageProcessor: MessageHandler | null             = null
  private activeChannels:   Set<ChannelType>                  = new Set()
  private log:              Logger = noopLogger()

  // ── Logger injection ─────────────────────────────────────────
  //
  // Phase v4.1-1.3a — boot wires this once before any registerChannel
  // / routeMessage call. Until then, noopLogger drops everything so
  // accidentally-imported gateway code in tests / scripts can't leak
  // anything to stdout.

  attachLogger(logger: Logger): void {
    this.log = logger
  }

  // ── Register the central message processor (Aiden's brain) ───

  setProcessor(handler: MessageHandler): void {
    this.messageProcessor = handler
  }

  // ── Register a channel's outbound delivery method ─────────────

  registerChannel(channel: ChannelType, deliveryHandler: DeliveryHandler): void {
    this.handlers.set(channel, deliveryHandler)
    this.activeChannels.add(channel)
    this.log.info(`channel registered: ${channel}`)
  }

  // ── Unregister a channel ──────────────────────────────────────

  unregisterChannel(channel: ChannelType): void {
    this.handlers.delete(channel)
    this.activeChannels.delete(channel)
    this.log.info(`channel unregistered: ${channel}`)
  }

  // ── Route an incoming message through Aiden ───────────────────

  // DC.1 — an optional `delivery` binding (platform driver + capabilities +
  // first-message hint) lets the gateway construct the immutable per-turn
  // DeliveryContext, thread it to the processor, and route the final reply
  // through the seam (`ctx.send('final', …)`). When omitted, behaviour is
  // exactly as before: the string is returned and the caller delivers it.
  // v4.12.1 Pillar 1 — an optional `idempotency` binding wraps the per-turn
  // DeliveryContext with the durable side-effect ledger, so a resumed task
  // never re-delivers a 'final' message that already went out. Absent (the
  // interactive REPL default) → delivery is exactly as before: live sends,
  // no ledger. Present (a durable/daemon task that can be re-driven) → the
  // committed send is idempotent against (taskId, step, content).
  async routeMessage(
    message: IncomingMessage,
    delivery?: DeliveryBinding,
    idempotency?: { ledger: SideEffectLedger } & IdempotentDeliveryIdent,
  ): Promise<string> {
    if (!this.messageProcessor) {
      throw new Error('No message processor registered')
    }

    // Resolve stable cross-channel session and attach sessionId
    const session        = sessionRouter.getSession(message.userId, message.channel)
    session.messageCount++
    message.sessionId    = session.sessionId

    // DC.1 — build the immutable-per-turn delivery context from the inbound
    // message. Routing authority (platform/chatId/threadId) is frozen here and
    // never sourced from mutable/global state. Concurrent turns each get their
    // own ctx, so replies can never cross-route.
    let ctx: DeliveryContext | undefined = delivery
      ? createDeliveryContext(
          {
            platform:    message.channel,
            chatId:      message.channelId,
            threadId:    message.threadId,
            replyAnchor: message.replyTo,
          },
          delivery,
        )
      : undefined

    // DC + v4.12.1 — wrap the seam with the idempotency ledger when this turn
    // belongs to a resumable task. `ctx.send('final', …)` is now guarded.
    if (ctx && idempotency) {
      const { ledger, ...ident } = idempotency
      ctx = withIdempotentDelivery(ctx, ledger, ident)
    }

    this.log.debug(
      `${message.channel}:${message.channelId} → "${message.text.substring(0, 60)}"`,
      { sessionId: session.sessionId },
    )

    const start = Date.now()

    let response: string
    try {
      response = await this.messageProcessor(message, ctx)
      const duration = Date.now() - start
      this.log.debug(`response ready → ${message.channel}`, { durationMs: duration })

      // DC.1 — first-message hint is now a per-platform capability supplied via
      // the binding, not a hardcoded `channel === 'telegram'` branch. The
      // generic layer no longer knows any platform's specifics.
      if (ctx?.firstMessageHint && session.messageCount === 1) {
        response += '\n\n' + ctx.firstMessageHint
      }
    } catch (error) {
      this.log.error(
        `processing failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      response = 'Something went wrong processing your message. Try again.'
    }

    // DC.1 — when bound, the final reply is delivered through the seam (the same
    // message to the same chat, just via ctx.send). Delivery failures are logged
    // by the driver and surfaced in the receipt; they never throw here.
    if (ctx) {
      try {
        const receipt = await ctx.send('final', response)
        if (!receipt.ok) {
          this.log.warn(`final delivery not ok → ${message.channel}`, { error: receipt.error })
        }
      } catch (error) {
        this.log.error(
          `final delivery threw → ${message.channel}: ` +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    }

    return response
  }

  // ── Deliver a message to a specific channel ───────────────────

  async deliver(message: OutgoingMessage): Promise<boolean> {
    const handler = this.handlers.get(message.channel)
    if (!handler) {
      this.log.warn(`no handler for channel: ${message.channel}`)
      return false
    }

    try {
      return await handler(message)
    } catch (error) {
      this.log.error(
        `delivery failed to ${message.channel}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
      return false
    }
  }

  // ── Broadcast to all active channels ─────────────────────────

  async broadcast(text: string, exclude?: ChannelType): Promise<void> {
    for (const channel of this.activeChannels) {
      if (channel === exclude) continue
      await this.deliver({ channel, channelId: 'broadcast', text })
    }
  }

  // ── Channel status list ────────────────────────────────────────

  getStatus(): Array<{ channel: ChannelType; active: boolean }> {
    const allChannels: ChannelType[] = [
      'dashboard', 'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'sms', 'imessage', 'email', 'api',
    ]
    return allChannels.map(ch => ({
      channel: ch,
      active:  this.activeChannels.has(ch),
    }))
  }
}

export const gateway = new Gateway()
