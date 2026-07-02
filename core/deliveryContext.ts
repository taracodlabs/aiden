// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/deliveryContext.ts — v4.12 DC.1: the platform-agnostic delivery seam.
//
// A DeliveryContext is the single route for user-visible channel output. It is
// constructed IMMUTABLE-PER-TURN by `gateway.routeMessage` from the inbound
// IncomingMessage, so the routing authority (platform, chatId, threadId) is
// frozen for the turn and threaded through the processor — never read from a
// mutable/global "current target".
//
// ★ Why immutable-per-turn matters: process-global routing state can misroute
// concurrent messages to the wrong chat — hence an immutable per-turn delivery
// context. Routing is already per-message-safe today because every send threads
// a local chatId. This seam
// KEEPS that property when richer delivery lands. The future gated feature —
// mid-run progress streamed to a chat while other chats run concurrently — is
// exactly where a mutable/global "current chat" would route notifications to
// the WRONG thread. Freezing the routing here from day one forecloses that bug.
//
// PLATFORM-AGNOSTIC (here): the routing fields, the capability model, the
// send() intent kinds. PER-PLATFORM (the DeliveryDriver an adapter supplies):
// chunking, parse mode, media/voice rules, edit-vs-send, reactions.

/** Delivery intents the seam can carry. DC.2 wires 'final' (+ 'status'); the
 *  rest are declared for future slices and rejected honestly until wired. */
export type DeliveryKind = 'final' | 'progress' | 'status' | 'media' | 'approval'

/**
 * What a platform CAN do through the seam. Adapters declare this honestly:
 * a capability is true only when the seam actually routes it for that platform
 * (SH.1 anti-overpromise discipline — do not advertise a capability the driver
 * cannot yet deliver).
 */
export interface DeliveryCapabilities {
  /** Can edit a previously-sent message in place (vs send-new). */
  edit:              boolean
  /** Splits over-limit text at boundaries (platform-specific length rules). */
  chunkLongMessages: boolean
  /** Outbound media kinds wired through the seam; [] = none wired yet. */
  media:             string[]
  /** Can render a native voice bubble (vs an audio file attachment). */
  voiceBubble:       boolean
  /** Can react to a message (emoji reaction) instead of replying. */
  reactions:         boolean
}

/** Structured payload for a send. DC.2 uses `text`; media fields land later. */
export interface DeliveryPayload {
  text?: string
}

/** Outcome of one delivery attempt. */
export interface DeliveryReceipt {
  ok:      boolean
  kind:    DeliveryKind
  /** Number of platform messages emitted (e.g. chunk count). */
  chunks?: number
  error?:  string
  /**
   * v4.12.1 — true when the idempotency ledger SHORT-CIRCUITED this send: the
   * same logical delivery already landed on a prior run, so nothing went out
   * this time. `ok` is still true (the message is delivered — just not by this
   * attempt). Absent on normal live sends.
   */
  replayed?: boolean
}

/**
 * The per-platform primitive. An adapter supplies this; it owns the platform
 * quirks (chunking, parse mode, media rules). The seam never inspects these —
 * it just calls `deliver`.
 */
export interface DeliveryDriver {
  deliver(
    kind:     DeliveryKind,
    payload:  DeliveryPayload,
    options?: Record<string, unknown>,
  ): Promise<DeliveryReceipt>
}

/**
 * What an adapter hands the gateway so a DeliveryContext can be built for the
 * turn: the platform driver, its declared capabilities, and an optional
 * first-message hint (the per-platform home for what used to be a hardcoded
 * Telegram branch in the generic gateway).
 */
export interface DeliveryBinding {
  driver:            DeliveryDriver
  capabilities:      DeliveryCapabilities
  /** Appended to the first delivered reply of a session (platform-specific). */
  firstMessageHint?: string
}

/** Immutable routing authority for the turn — frozen at construction. */
export interface DeliveryRouting {
  platform:     string
  chatId:       string
  threadId?:    string
  replyAnchor?: string
}

/** The seam consumers use as the only route for user-visible output. */
export interface DeliveryContext {
  readonly platform:          string
  readonly chatId:            string
  readonly threadId?:         string
  readonly replyAnchor?:      string
  readonly capabilities:      DeliveryCapabilities
  readonly firstMessageHint?: string
  send(
    kind:     DeliveryKind,
    payload:  string | DeliveryPayload,
    options?: Record<string, unknown>,
  ): Promise<DeliveryReceipt>
}

/**
 * Construct an immutable-per-turn DeliveryContext. Called by
 * `gateway.routeMessage` from the inbound IncomingMessage. The returned object
 * (and its capabilities) is frozen so routing authority cannot be mutated
 * mid-turn by any downstream code.
 */
export function createDeliveryContext(
  routing: DeliveryRouting,
  binding: DeliveryBinding,
): DeliveryContext {
  const capabilities = Object.freeze({ ...binding.capabilities, media: Object.freeze([...binding.capabilities.media]) as unknown as string[] })
  const ctx: DeliveryContext = {
    platform:         routing.platform,
    chatId:           routing.chatId,
    threadId:         routing.threadId,
    replyAnchor:      routing.replyAnchor,
    capabilities,
    firstMessageHint: binding.firstMessageHint,
    send(kind, payload, options) {
      const p: DeliveryPayload = typeof payload === 'string' ? { text: payload } : payload
      return binding.driver.deliver(kind, p, options)
    },
  }
  return Object.freeze(ctx)
}
