// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/twilio.ts — SMS channel adapter via Twilio.
//
// Inbound SMS requires a publicly reachable webhook URL pointing to
//   POST /api/channels/sms/inbound
// Use ngrok or similar for local dev: ngrok http 4200
// Then set WEBHOOK_URL=https://<your-ngrok-id>.ngrok.io
//
// Config (env vars):
//   TWILIO_ACCOUNT_SID    — required
//   TWILIO_AUTH_TOKEN     — required
//   TWILIO_PHONE_NUMBER   — your Twilio-owned number (+15551234567)
//   TWILIO_ALLOWED_NUMBERS — optional comma-separated inbound allowlist
//   WEBHOOK_URL           — base URL for inbound webhook registration

import { gateway } from '../gateway'
import type { ChannelAdapter } from './adapter'
import { noopLogger, type Logger } from '../v4/logger'
import { buildTextDeliveryBinding, type DeliveryBinding } from '../deliveryContext'
import type { Application, Response } from 'express'

// SMS max segment length per GSM spec
const SMS_CHUNK_SIZE = 160

/** Split a message into ≤160-character segments */
function chunkSms(text: string): string[] {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    chunks.push(remaining.substring(0, SMS_CHUNK_SIZE))
    remaining = remaining.substring(SMS_CHUNK_SIZE)
  }
  return chunks
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

/** Render a reply as TwiML — Twilio turns each <Message> into an SMS segment. */
function toTwiml(text: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    ...chunkSms(text).map(chunk =>
      `  <Message>${chunk.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message>`,
    ),
    '</Response>',
  ].join('\n')
}

export class TwilioAdapter implements ChannelAdapter {
  readonly name = 'sms'


  // Phase v4.1-1.3a — diagnostics route through scope logger.
  private log: Logger = noopLogger()
  private twilioClient:    any    = null
  private healthy                 = false
  private accountSid:      string
  private authToken:       string
  private fromNumber:      string
  private allowedNumbers:  Set<string>
  private webhookUrl:      string
  private app:             Application | null = null

  constructor(app?: Application) {
    this.accountSid     = process.env.TWILIO_ACCOUNT_SID      ?? ''
    this.authToken      = process.env.TWILIO_AUTH_TOKEN       ?? ''
    this.fromNumber     = process.env.TWILIO_PHONE_NUMBER     ?? ''
    const raw           = process.env.TWILIO_ALLOWED_NUMBERS  ?? ''
    this.allowedNumbers = raw ? new Set(raw.split(',').map(s => s.trim()).filter(Boolean)) : new Set()
    this.webhookUrl     = process.env.WEBHOOK_URL             ?? ''
    this.app            = app ?? null
  }

  attachLogger(logger: Logger): void { this.log = logger }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      this.log.info('Disabled — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER to enable')
      return
    }

    let twilio: any
    try {
      twilio = require('twilio')
    } catch (e: any) {
      this.log.info(`Disabled — twilio package not available:${e.message}`)
      return
    }

    this.twilioClient = twilio(this.accountSid, this.authToken)

    // Register outbound delivery
    gateway.registerChannel('sms', async (msg) => {
      await this.send(msg.channelId, msg.text)
      return true
    })

    // Register inbound webhook handler on the express app
    if (this.app) {
      this.app.post('/api/channels/sms/inbound', async (req: any, res: any) => {
        res.set('Content-Type', 'text/xml')
        const from  = req.body?.From ?? ''
        const body  = req.body?.Body ?? ''

        if (!this.isAllowed(from)) {
          res.send(EMPTY_TWIML)
          return
        }

        // v4.15 — deliver THROUGH the seam: the TwiML reply is written by the
        // driver bound to THIS request/response, not returned-then-sent.
        await this.processMessage(from, from, body, this.buildResponseBinding(res))
        // Safety net — if the seam never wrote (e.g. processor error swallowed
        // upstream), close the request with an empty TwiML so it never hangs.
        if (!res.headersSent) res.send(EMPTY_TWIML)
      })
    }

    if (!this.webhookUrl) {
      this.log.info('Outbound ready — inbound SMS requires public webhook URL (set WEBHOOK_URL env or use ngrok)')
    } else {
      this.log.info('Ready — inbound webhook: ${this.webhookUrl}/api/channels/sms/inbound')
    }

    this.healthy = true
  }

  async stop(): Promise<void> {
    this.healthy = false
    gateway.unregisterChannel('sms')
    this.twilioClient = null
    this.log.info('Disconnected')
  }

  async send(target: string, message: string): Promise<void> {
    if (!this.twilioClient || !this.healthy) return
    const chunks = chunkSms(message)
    for (const chunk of chunks) {
      try {
        await this.twilioClient.messages.create({
          body: chunk,
          from: this.fromNumber,
          to:   target,
        })
      } catch (e: any) {
        this.log.error(`send error:${e.message}`)
        break
      }
    }
  }

  isHealthy(): boolean { return this.healthy }

  // ── Helpers ────────────────────────────────────────────────

  private isAllowed(number: string): boolean {
    if (this.allowedNumbers.size === 0) return true
    return this.allowedNumbers.has(number)
  }

  // v4.15 — the sealed per-request delivery binding: the driver writes the TwiML
  // reply to THIS response object (a per-request local, never shared state).
  private buildResponseBinding(res: Response): DeliveryBinding {
    return buildTextDeliveryBinding((text) => {
      if (!res.headersSent) res.send(toTwiml(text))
      return Promise.resolve({ ok: true })
    })
  }

  private async processMessage(channelId: string, userId: string, text: string, delivery?: DeliveryBinding): Promise<string> {
    try {
      return await gateway.routeMessage({
        channel:   'sms',
        channelId,
        userId,
        text,
        timestamp: Date.now(),
      }, delivery)
    } catch (e: any) {
      this.log.error(`routeMessage error:${e.message}`)
      return 'Something went wrong. Try again.'
    }
  }
}
