// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/whatsapp.ts — WhatsApp channel adapter.
//
// Uses whatsapp-web.js (WebSocket-based, no business API required).
// On first run, a QR code is printed to the terminal — scan it with
// the WhatsApp mobile app. The session is then persisted so subsequent
// launches connect automatically.
//
// ⚠️  TERMS OF SERVICE NOTE:
//     WhatsApp web automation is for personal use only.
//     For production or commercial scale, use WhatsApp Business API
//     (set WHATSAPP_BUSINESS_API_KEY) which is fully compliant with
//     WhatsApp's terms. Web scraping at scale violates their ToS.
//
// Config (env vars):
//   WHATSAPP_SESSION_PATH      — path to persist session data
//                                (default: workspace/.whatsapp_session)
//   WHATSAPP_ALLOWED_NUMBERS   — optional comma-separated allowlist
//                                (+919812345678 format)
//   WHATSAPP_BUSINESS_API_KEY  — optional; if set, use official Business API
//                                instead of web automation

import path from 'path'
import { gateway } from '../gateway'
import type { ChannelAdapter } from './adapter'
import { noopLogger, type Logger } from '../v4/logger'
import { resolveUserPath } from '../v4/paths'

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = 'whatsapp'


  // Phase v4.1-1.3a — diagnostics route through scope logger.
  private log: Logger = noopLogger()
  private client:          any    = null
  private healthy                 = false
  private sessionPath:     string
  private allowedNumbers:  Set<string>
  private businessApiKey:  string

  constructor() {
    // v4.12.1 — user-supplied path routed through resolveUserPath
    // (quote-strip, ~ expansion, absolute-wins) like every config/env path.
    this.sessionPath    = resolveUserPath(process.env.WHATSAPP_SESSION_PATH)
      ?? path.join(process.cwd(), 'workspace', '.whatsapp_session')
    const raw           = process.env.WHATSAPP_ALLOWED_NUMBERS ?? ''
    this.allowedNumbers = raw ? new Set(raw.split(',').map(s => s.trim()).filter(Boolean)) : new Set()
    this.businessApiKey = process.env.WHATSAPP_BUSINESS_API_KEY ?? ''
  }

  attachLogger(logger: Logger): void { this.log = logger }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    // Opt-in guard — silent unless WHATSAPP_ENABLED=true
    if (!process.env.WHATSAPP_ENABLED || process.env.WHATSAPP_ENABLED.toLowerCase() !== 'true') {
      return
    }

    // Attempt dynamic import — graceful degradation if module not available
    let Client: any, LocalAuth: any
    try {
      const wwebjs = await import('whatsapp-web.js')
      Client    = wwebjs.Client
      LocalAuth = wwebjs.LocalAuth
    } catch (e: any) {
      this.log.info(`Disabled — whatsapp-web.js not available:${e.message}`)
      return
    }

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    })

    // QR code for first-time auth
    this.client.on('qr', (qr: string) => {
      this.log.info('Scan this QR code with your WhatsApp mobile app:')
      try {
        const qrcode = require('qrcode-terminal')
        qrcode.generate(qr, { small: true })
      } catch {
        this.log.info(`QR (raw):${qr}`)
      }
    })

    this.client.on('authenticated', () => {
      this.log.info(`Session authenticated — session persisted at${this.sessionPath}`)
    })

    this.client.on('ready', () => {
      this.healthy = true
      this.log.info('Client ready')
      gateway.registerChannel('whatsapp', async (msg) => {
        await this.send(msg.channelId, msg.text)
        return true
      })
    })

    this.client.on('disconnected', (reason: string) => {
      this.healthy = false
      this.log.info(`Disconnected:${reason}`)
    })

    this.client.on('message', async (msg: any) => {
      // Skip non-text messages and group messages (from field ends with @g.us)
      if (msg.from.endsWith('@g.us')) return
      if (msg.type !== 'chat') return

      const senderNumber = msg.from.replace('@c.us', '').replace(/^0/, '+')
      if (!this.isAllowed(senderNumber)) return

      const response = await this.processMessage(msg.from, senderNumber, msg.body)
      await msg.reply(response).catch((e: Error) =>
        this.log.error(`reply error:${e.message}`),
      )
    })

    try {
      await this.client.initialize()
    } catch (e: any) {
      this.log.info(`Disabled — check WHATSAPP_SESSION_PATH:${e.message}`)
      this.healthy = false
    }
  }

  async stop(): Promise<void> {
    this.healthy = false
    if (this.client) {
      gateway.unregisterChannel('whatsapp')
      await this.client.destroy().catch(() => {})
      this.client = null
    }
    this.log.info('Disconnected')
  }

  async send(target: string, message: string): Promise<void> {
    if (!this.client || !this.healthy) return
    // Ensure target has @c.us suffix
    const chatId = target.includes('@') ? target : `${target.replace('+', '')}@c.us`
    await this.client.sendMessage(chatId, message).catch((e: Error) =>
      this.log.error(`send error:${e.message}`),
    )
  }

  isHealthy(): boolean { return this.healthy }

  // ── Helpers ────────────────────────────────────────────────

  private isAllowed(number: string): boolean {
    if (this.allowedNumbers.size === 0) return true
    return this.allowedNumbers.has(number)
  }

  private async processMessage(chatId: string, userId: string, text: string): Promise<string> {
    try {
      return await gateway.routeMessage({
        channel:   'whatsapp',
        channelId: chatId,
        userId,
        text,
        timestamp: Date.now(),
      })
    } catch (e: any) {
      this.log.error(`routeMessage error:${e.message}`)
      return '❌ Something went wrong. Try again.'
    }
  }
}
