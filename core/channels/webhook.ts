// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/webhook.ts — Generic HMAC-signed HTTP webhook adapter.
//
// Config (env vars):
//   WEBHOOK_SECRET           — required; HMAC-SHA256 signing key
//   WEBHOOK_ALLOWED_ORIGINS  — optional comma-separated IP prefixes/addresses
//
// Registers endpoint:  POST /api/webhook
//
// Request format:
//   Headers:  X-Aiden-Signature: sha256=<HMAC-SHA256 of raw body using WEBHOOK_SECRET>
//   Body:     { "message": "string", "context": {...}, "callbackUrl": "https://..." }
//
// Response modes:
//   Sync  (no callbackUrl):  waits for agent response, returns { response: "..." }
//   Async (callbackUrl set): responds { status: "queued" } then POSTs result to callbackUrl
//
// Security:
//   - HMAC-SHA256 signature required on every request (timing-safe compare)
//   - Optional origin IP allowlist (WEBHOOK_ALLOWED_ORIGINS)
//   - No WEBHOOK_SECRET → 503 "Webhook disabled"
//
// No external SDK — uses Node.js built-in crypto only.

import * as crypto from 'crypto'
import type { Express, Request, Response } from 'express'
import { gateway } from '../gateway'
import type { ChannelAdapter } from './adapter'
import { noopLogger, type Logger } from '../v4/logger'
import {
  argsHashOf,
  guardContentAddressedSend,
  type SideEffectLedger,
} from '../v4/sideEffectLedger'

export class WebhookAdapter implements ChannelAdapter {
  readonly name = 'webhook'


  // Phase v4.1-1.3a — diagnostics route through scope logger.
  private log: Logger = noopLogger()
  private secret:         string
  private allowedOrigins: string[]
  private healthy         = false
  private app:            Express | null

  constructor(app?: Express) {
    this.secret         = process.env.WEBHOOK_SECRET            ?? ''
    const rawOrigins    = process.env.WEBHOOK_ALLOWED_ORIGINS   ?? ''
    this.allowedOrigins = rawOrigins
      ? rawOrigins.split(',').map(s => s.trim()).filter(Boolean)
      : []
    this.app = app ?? null
  }

  attachLogger(logger: Logger): void { this.log = logger }

  // v4.12.1 Pillar 1 — optional durable idempotency ledger. When set (by the
  // daemon boot, which owns the sqlite db), the outbound async callback POST
  // is guarded so an identical callback is never delivered twice across a
  // crash/resume. Unset (the default) → callbacks fire directly, as before.
  private idempotencyLedger: SideEffectLedger | null = null
  setIdempotencyLedger(ledger: SideEffectLedger): void { this.idempotencyLedger = ledger }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.app) {
      this.log.warn('No Express app provided — endpoint not registered')
      return
    }

    if (!this.secret) {
      this.log.info('Disabled — set WEBHOOK_SECRET to enable')
      // Register the route but return 503 so callers get a clear error
      this.app.post('/api/webhook', (_req: Request, res: Response) => {
        res.status(503).json({ error: 'Webhook disabled — set WEBHOOK_SECRET to enable' })
      })
      return
    }

    // ── POST /api/webhook ──────────────────────────────────
    this.app.post('/api/webhook', async (req: Request, res: Response) => {
      // 1. Origin check
      if (this.allowedOrigins.length > 0) {
        const forwarded = req.headers['x-forwarded-for']
        const remote    = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? req.socket.remoteAddress ?? '')
        if (!this.isAllowedOrigin(remote)) {
          return res.status(403).json({ error: 'Origin not in WEBHOOK_ALLOWED_ORIGINS' })
        }
      }

      // 2. Signature verification
      const signature = req.headers['x-aiden-signature'] as string | undefined
      if (!this.verifySignature(req.body, signature)) {
        return res.status(401).json({ error: 'Invalid or missing X-Aiden-Signature' })
      }

      // 3. Parse body
      const { message, context, callbackUrl } = (req.body ?? {}) as {
        message?:     string
        context?:     Record<string, unknown>
        callbackUrl?: string
      }

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: '"message" field is required and must be a string' })
      }

      const contextNote = context
        ? `\nContext: ${JSON.stringify(context)}`
        : ''
      const fullMessage = message + contextNote

      if (callbackUrl) {
        // ── Async mode ─────────────────────────────────────
        res.json({ status: 'queued' })
        this.runAndCallback(fullMessage, callbackUrl, context).catch(() => {})
      } else {
        // ── Sync mode ──────────────────────────────────────
        try {
          const response = await gateway.routeMessage({
            channel:   'api',
            channelId: 'webhook',
            userId:    'webhook',
            text:      fullMessage,
            timestamp: Date.now(),
          })
          res.json({ response })
        } catch (e: any) {
          res.status(500).json({ error: e.message ?? 'Internal error' })
        }
      }
    })

    this.healthy = true
    this.log.info('Enabled — POST /api/webhook (HMAC-SHA256 required)')
  }

  async stop(): Promise<void> {
    this.healthy = false
    // Express routes cannot be unregistered at runtime; we simply mark unhealthy
    this.log.info('Stopped')
  }

  /** Not applicable — webhook is request-response, not push-based */
  async send(_target: string, _message: string): Promise<void> {}

  isHealthy(): boolean { return this.healthy }

  // ── Helpers ────────────────────────────────────────────────

  private verifySignature(body: unknown, signature: string | undefined): boolean {
    if (!signature) return false
    const payload  = typeof body === 'string' ? body : JSON.stringify(body)
    const expected = 'sha256=' + crypto.createHmac('sha256', this.secret).update(payload).digest('hex')
    try {
      // timing-safe comparison — both buffers must be same length
      if (signature.length !== expected.length) return false
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    } catch {
      return false
    }
  }

  private isAllowedOrigin(origin: string): boolean {
    return this.allowedOrigins.some(allowed =>
      origin === allowed || origin.startsWith(allowed),
    )
  }

  private async runAndCallback(
    message:     string,
    callbackUrl: string,
    context?:    Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await gateway.routeMessage({
        channel:   'api',
        channelId: 'webhook',
        userId:    'webhook',
        text:      message,
        timestamp: Date.now(),
      })
      const body = JSON.stringify({ response, context })
      const postOnce = () => fetch(callbackUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      // v4.12.1 — when a durable ledger is wired, dedup the callback POST by
      // (destination URL + payload) so a resume never double-delivers it.
      if (this.idempotencyLedger) {
        const outcome = await guardContentAddressedSend(
          this.idempotencyLedger,
          { scope: `webhook:${callbackUrl}`, tool: 'webhook', contentHash: argsHashOf({ callbackUrl, response, context }), target: callbackUrl },
          { send: postOnce },
        )
        if (outcome.kind === 'skipped') {
          this.log.info(`callback skipped (idempotent replay): ${callbackUrl}`)
        } else if (outcome.kind === 'needs_confirmation') {
          this.log.warn(`callback not re-fired (interrupted, needs confirmation): ${callbackUrl}`)
        }
      } else {
        await postOnce()
      }
    } catch (e: any) {
      this.log.error(`Async callback failed:${e.message}`)
    }
  }
}
