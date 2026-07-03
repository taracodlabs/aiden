/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/idempotentDelivery.ts — v4.12.1 Pillar 1: the idempotency ledger
 * wired into the channel send seam (DeliveryContext).
 *
 * `withIdempotentDelivery` decorates any DeliveryContext so that COMMITTED
 * outbound kinds ('final', 'media') route through `guardExternalSend` before
 * they reach the platform driver. Same interface in, same interface out —
 * it is a drop-in wrapper applied ONCE at the seam, so no adapter (Discord,
 * Telegram, email, …) duplicates the idempotency logic.
 *
 * Ephemeral kinds ('progress', 'status', 'approval') pass straight through:
 * re-emitting a progress ping on resume is harmless, and gating it would add
 * ledger rows for output nobody double-counts.
 *
 * Determinism across re-drives: the committed-send ORDINAL is a counter local
 * to this wrapper, starting at `stepBase` and incrementing per committed send
 * — NOT per ephemeral send. A faithful re-drive issues the Nth committed send
 * at the same ordinal, so its ledger key matches the original and the send is
 * skipped. (Content drift at that ordinal is caught by the guard's
 * same-ordinal / different-hash ambiguity rule → needs-confirmation.)
 */

import type { DeliveryContext, DeliveryKind, DeliveryPayload, DeliveryReceipt } from '../deliveryContext';
import { argsHashOf, guardExternalSend, type SideEffectLedger } from './sideEffectLedger';
import { emitNeedsConfirmation, type PillarEventSink } from './pillarEvents';

/** Kinds that COMMIT an irreversible external send — these are ledger-gated. */
const COMMITTED_KINDS: ReadonlySet<DeliveryKind> = new Set<DeliveryKind>(['final', 'media']);

/** A ledger-skipped or needs-confirmation delivery, surfaced to the caller so
 *  the task's finalization can record it (→ evidence.skipped[] / block). */
export interface DeliverySideEffectNote {
  tool:   string;   // 'channel_send'
  target: string;   // 'platform:chatId'
  reason: string;
  key:    string;
}

export interface IdempotentDeliveryIdent {
  /** The durable task this delivery belongs to — the resume unit + ledger key. */
  taskId: string;
  /** Ordinal of the first committed send in this context (default 0). */
  stepBase?: number;
  /** Called when a committed send is SKIPPED as an idempotent replay. */
  onSkip?: (note: DeliverySideEffectNote) => void;
  /** Called when a committed send cannot be safely replayed (crash mid-send
   *  or ambiguous ordinal) — the caller should block the task for the user. */
  onNeedsConfirmation?: (note: DeliverySideEffectNote) => void;
  /** Optional: verify an interrupted send's recorded receipt actually landed. */
  verify?: (receipt: unknown) => Promise<boolean>;
  /**
   * v4.14 Pillar 5 Slice C — when present, a needs-confirmation surface also
   * emits the `needs_confirmation` pillar event (live + durable run_events).
   * Optional so channels that don't run under a durable run just omit it.
   */
  pillarSink?: PillarEventSink;
}

/**
 * Wrap `ctx` so committed sends are idempotent against the durable ledger.
 * Returns a new DeliveryContext with identical routing/capabilities; only
 * `send` is decorated. The original `ctx` is never mutated (it is frozen).
 */
export function withIdempotentDelivery(
  ctx: DeliveryContext,
  ledger: SideEffectLedger,
  ident: IdempotentDeliveryIdent,
): DeliveryContext {
  let ordinal = ident.stepBase ?? 0;

  const send = async (
    kind: DeliveryKind,
    payload: string | DeliveryPayload,
    options?: Record<string, unknown>,
  ): Promise<DeliveryReceipt> => {
    if (!COMMITTED_KINDS.has(kind)) {
      return ctx.send(kind, payload, options);           // ephemeral — pass through
    }
    const p: DeliveryPayload = typeof payload === 'string' ? { text: payload } : payload;
    const step = ordinal++;                              // consume an ordinal per committed send
    const target = `${ctx.platform}:${ctx.chatId}`;
    const argsHash = argsHashOf({
      platform: ctx.platform, chatId: ctx.chatId, threadId: ctx.threadId,
      kind, text: p.text ?? '',
    });

    const outcome = await guardExternalSend<DeliveryReceipt>(
      ledger,
      { taskId: ident.taskId, step, tool: 'channel_send', argsHash, target },
      {
        send: () => ctx.send(kind, p, options),
        verify: ident.verify,
        // The DeliveryReceipt has no provider id; persist a compact shape.
        receiptOf: (r) => ({ ok: r.ok, kind: r.kind, chunks: r.chunks ?? 0 }),
      },
    );

    if (outcome.kind === 'sent') {
      return outcome.receipt as DeliveryReceipt;
    }
    if (outcome.kind === 'skipped') {
      ident.onSkip?.({ tool: 'channel_send', target, reason: outcome.reason ?? 'idempotent_replay', key: outcome.key });
      // Delivered on a prior run — report ok WITHOUT re-sending.
      return { ok: true, kind, replayed: true, chunks: 0 };
    }
    // needs_confirmation — do NOT send; surface for the user.
    ident.onNeedsConfirmation?.({ tool: 'channel_send', target, reason: outcome.reason ?? 'needs confirmation', key: outcome.key });
    // v4.14 — observability: also emit the pillar event when a sink is wired.
    // emitPillarEvent never throws, but wrap defensively — telemetry must never
    // break a delivery decision.
    if (ident.pillarSink) {
      try {
        emitNeedsConfirmation(ident.pillarSink, {
          tool: 'channel_send', target, reason: outcome.reason ?? 'needs confirmation',
        });
      } catch { /* telemetry failure must never break delivery */ }
    }
    return { ok: false, kind, error: outcome.reason ?? 'external send needs confirmation' };
  };

  return Object.freeze({
    platform:         ctx.platform,
    chatId:           ctx.chatId,
    threadId:         ctx.threadId,
    replyAnchor:      ctx.replyAnchor,
    capabilities:     ctx.capabilities,
    firstMessageHint: ctx.firstMessageHint,
    send,
  });
}
