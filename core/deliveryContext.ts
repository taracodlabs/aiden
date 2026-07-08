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
  /**
   * v4.15 delivery-isolation — the driver sets this when the failure means the
   * TARGET is permanently unreachable (bot blocked, chat/user deleted → 403/404),
   * not a transient hiccup. The seam reads it at the choke-point to retire the
   * target (markTargetDead) so proactive / multi-chunk sends stop hammering it.
   */
  terminal?: boolean
  /**
   * v4.15 delivery-isolation — true when the seam SKIPPED this send because the
   * target is currently marked dead. Nothing was handed to the driver. Reversible:
   * the next inbound from the target revives it.
   */
  skippedDead?: boolean
  /**
   * v4.15 delivery-isolation — true when a multi-chunk delivery sent SOME but not
   * all chunks (a transient chunk failure no longer abandons the rest). `ok` is
   * false, but the message was partially delivered.
   */
  partial?: boolean
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

// ── Dead-target memory (v4.15 — delivery isolation) ──────────────────────────
//
// A target that returns a TERMINAL failure (bot blocked / chat gone → 403/404)
// is remembered so proactive or multi-chunk sends stop hammering it. REVERSIBLE:
// a fresh inbound from the target revives it (gateway.routeMessage calls
// reviveTarget). In-memory only — a durable dead-letter store is intentionally
// deferred (the focused slice keeps the choke-point, not the persistence).

const deadTargets = new Map<string, { reason: string; since: number }>()
const targetKey = (platform: string, chatId: string): string => `${platform}:${chatId}`

/** Retire a target after a terminal failure — future sends to it are skipped. */
export function markTargetDead(platform: string, chatId: string, reason: string): void {
  deadTargets.set(targetKey(platform, chatId), { reason, since: Date.now() })
}
/** True while a target is retired. */
export function isTargetDead(platform: string, chatId: string): boolean {
  return deadTargets.has(targetKey(platform, chatId))
}
/** The reason a target was retired, if it is. */
export function deadTargetReason(platform: string, chatId: string): string | undefined {
  return deadTargets.get(targetKey(platform, chatId))?.reason
}
/** Revive a target — called on every fresh inbound (proves reachability again).
 *  Returns true if it had been dead. */
export function reviveTarget(platform: string, chatId: string): boolean {
  return deadTargets.delete(targetKey(platform, chatId))
}
/** Test-only — clear the dead-target registry between cases. */
export function _resetDeadTargets(): void {
  deadTargets.clear()
}

/**
 * Classify a caught send error as TERMINAL for its target — i.e. the target is
 * permanently unreachable (bot blocked, chat/user deleted): HTTP 403/404 or a
 * platform equivalent. Transient errors (timeouts, 429, 5xx) are NOT terminal,
 * so they never retire a target. Shared by every channel's deliver primitive so
 * the classification is uniform.
 */
export function isTerminalDeliveryError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Record<string, any>
  const status =
    e.status ?? e.statusCode ?? e.code ??
    e.response?.status ?? e.response?.statusCode ??
    e.response?.body?.error_code ?? e.error_code
  if (status === 403 || status === 404 || status === '403' || status === '404') return true
  const msg = String(e.message ?? e.response?.body?.description ?? '').toLowerCase()
  return /\b(403|404)\b|forbidden|not found|blocked by the user|bot was blocked|chat not found|user is deactivated/.test(msg)
}

/** Capabilities for a plain-text push channel (no chunking/media/edit wired). */
export const TEXT_DELIVERY_CAPABILITIES: DeliveryCapabilities = {
  edit: false, chunkLongMessages: false, media: [], voiceBubble: false, reactions: false,
}

/**
 * Shared binding factory for text channels (signal, imessage, whatsapp, email,
 * slack, twilio, webhook). The channel supplies ONE `deliver(text)` primitive
 * that sends to its already-bound target and reports terminal reachability; this
 * wraps it into a DeliveryBinding whose driver routes 'final'/'status' text and
 * rejects not-yet-wired kinds honestly. Mirrors Telegram's buildDeliveryBinding,
 * minus the platform-specific chunking/first-message hint.
 */
export function buildTextDeliveryBinding(
  deliver: (text: string) => Promise<{ ok: boolean; terminal?: boolean }>,
  opts: { capabilities?: DeliveryCapabilities; firstMessageHint?: string } = {},
): DeliveryBinding {
  return {
    capabilities:     opts.capabilities ?? TEXT_DELIVERY_CAPABILITIES,
    firstMessageHint: opts.firstMessageHint,
    driver: {
      deliver: async (kind, payload) => {
        if (kind === 'final' || kind === 'status') {
          const r = await deliver(payload.text ?? '')
          return { ok: r.ok, kind, terminal: r.terminal }
        }
        return { ok: false, kind, error: `sealed text delivery does not route '${kind}'` }
      },
    },
  }
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
      // Dead-target skip — a target retired by a prior terminal 403/404 is
      // skipped (nothing reaches the driver) until a fresh inbound revives it.
      if (isTargetDead(routing.platform, routing.chatId)) {
        return Promise.resolve({
          ok: false, kind, skippedDead: true,
          error: `${routing.platform}:${routing.chatId} marked dead — skipped` +
            ` (${deadTargetReason(routing.platform, routing.chatId) ?? 'terminal failure'})`,
        })
      }
      return binding.driver.deliver(kind, p, options).then((receipt) => {
        // A terminal failure retires the target so we stop hammering it —
        // reversible on the next inbound (gateway.routeMessage → reviveTarget).
        if (receipt.terminal) {
          markTargetDead(routing.platform, routing.chatId, receipt.error ?? 'terminal delivery failure')
        }
        return receipt
      })
    },
  }
  return Object.freeze(ctx)
}
