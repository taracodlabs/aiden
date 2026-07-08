// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/imessage.ts — iMessage channel adapter via BlueBubbles.
//
// BlueBubbles is a Mac app that exposes iMessage via REST + WebSocket.
// A Mac running the BlueBubbles server is REQUIRED — iMessage is an
// Apple-exclusive service.
//
// Setup (one-time, on a Mac):
//   1. Install BlueBubbles from https://bluebubbles.app
//   2. Open BlueBubbles, set a server password, note the URL/port
//   3. Set BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD in Aiden's .env
//
// Config (env vars):
//   BLUEBUBBLES_URL              — e.g. http://192.168.1.5:1234
//   BLUEBUBBLES_PASSWORD         — set in BlueBubbles server settings
//   BLUEBUBBLES_ALLOWED_NUMBERS  — optional comma-separated allowlist

import axios from 'axios'
import { WebSocket } from 'ws'
import { gateway } from '../gateway'
import type { ChannelAdapter } from './adapter'
import { noopLogger, type Logger } from '../v4/logger'
import {
  buildTextDeliveryBinding,
  isTerminalDeliveryError,
  type DeliveryBinding,
} from '../deliveryContext'

export class IMessageAdapter implements ChannelAdapter {
  readonly name = 'imessage'


  // Phase v4.1-1.3a — diagnostics route through scope logger.
  private log: Logger = noopLogger()
  private healthy          = false
  private baseUrl:  string
  private password: string
  private allowedNumbers: Set<string>
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.baseUrl  = (process.env.BLUEBUBBLES_URL ?? '').replace(/\/$/, '')
    this.password = process.env.BLUEBUBBLES_PASSWORD ?? ''
    const raw     = process.env.BLUEBUBBLES_ALLOWED_NUMBERS ?? ''
    this.allowedNumbers = raw ? new Set(raw.split(',').map(s => s.trim()).filter(Boolean)) : new Set()
  }

  attachLogger(logger: Logger): void { this.log = logger }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.baseUrl || !this.password) {
      this.log.info('Disabled — set BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD to enable')
      return
    }

    // Verify BlueBubbles is reachable
    const reachable = await this.checkHealth()
    if (!reachable) {
      this.log.info('Disabled — BlueBubbles server not reachable at ${this.baseUrl}')
      return
    }

    this.healthy = true
    this.log.info('Connected to BlueBubbles at ${this.baseUrl}')

    // Register outbound delivery
    gateway.registerChannel('imessage', async (msg) => {
      await this.send(msg.channelId, msg.text)
      return true
    })

    // Connect WebSocket for real-time inbound messages
    this.connectWebSocket()
  }

  async stop(): Promise<void> {
    this.healthy = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    gateway.unregisterChannel('imessage')
    this.log.info('Disconnected')
  }

  async send(target: string, message: string): Promise<void> {
    await this.deliverSealed(target, message)
  }

  // v4.15 delivery-isolation — the real send primitive: reports ok + terminal.
  private async deliverSealed(target: string, message: string): Promise<{ ok: boolean; terminal?: boolean }> {
    if (!this.healthy) return { ok: false }
    try {
      await axios.post(
        `${this.baseUrl}/api/v1/message/text`,
        { chatGuid: target, message, tempGuid: `aiden-${Date.now()}` },
        {
          params:  { password: this.password },
          timeout: 10000,
        },
      )
      return { ok: true }
    } catch (e: any) {
      this.log.error(`send error:${e.message}`)
      return { ok: false, terminal: isTerminalDeliveryError(e) }
    }
  }

  // v4.15 — the sealed per-turn delivery binding (frozen target).
  private buildDeliveryBinding(target: string): DeliveryBinding {
    return buildTextDeliveryBinding((text) => this.deliverSealed(target, text))
  }

  isHealthy(): boolean { return this.healthy }

  // ── Helpers ────────────────────────────────────────────────

  private async checkHealth(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/api/v1/ping`, {
        params:  { password: this.password },
        timeout: 3000,
      })
      return true
    } catch {
      return false
    }
  }

  private connectWebSocket(): void {
    if (!this.healthy) return

    const wsUrl = this.baseUrl.replace(/^http/, 'ws')
    this.ws     = new WebSocket(`${wsUrl}?password=${encodeURIComponent(this.password)}`)

    this.ws.on('open', () => {
      this.log.info('WebSocket connected')
    })

    this.ws.on('message', async (raw: Buffer) => {
      try {
        const event = JSON.parse(raw.toString())
        if (event.type !== 'new-message') return

        const msg = event.data
        // Only handle inbound (not self-sent) chat messages
        if (!msg || msg.isFromMe) return
        if (msg.attributedBody === null && !msg.text) return

        const text   = msg.text ?? ''
        const chatId = msg.chats?.[0]?.guid ?? ''
        const sender = msg.handle?.address ?? ''

        if (!this.isAllowed(sender)) return

        // v4.15 — deliver THROUGH the seam (frozen sealed address), no self-send.
        const target = chatId || sender
        await this.processMessage(target, sender, text, this.buildDeliveryBinding(target))
      } catch (e: any) {
        this.log.error(`message parse error:${e.message}`)
      }
    })

    this.ws.on('error', (e) => {
      this.log.error(`WebSocket error:${e.message}`)
    })

    this.ws.on('close', () => {
      if (this.healthy) {
        // Reconnect after 5 seconds
        this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 5000)
      }
    })
  }

  private isAllowed(number: string): boolean {
    if (this.allowedNumbers.size === 0) return true
    return this.allowedNumbers.has(number)
  }

  private async processMessage(channelId: string, userId: string, text: string, delivery?: DeliveryBinding): Promise<string> {
    try {
      return await gateway.routeMessage({
        channel:   'imessage',
        channelId,
        userId,
        text,
        timestamp: Date.now(),
      }, delivery)
    } catch (e: any) {
      this.log.error(`routeMessage error:${e.message}`)
      return '❌ Something went wrong. Try again.'
    }
  }
}
