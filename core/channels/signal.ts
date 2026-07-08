// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/signal.ts — Signal channel adapter.
//
// Uses signal-cli-rest-api — a standalone REST wrapper around the
// official signal-cli Java tool. Users run it separately:
//   https://github.com/bbernhard/signal-cli-rest-api
//
// Setup (one-time, outside Aiden):
//   docker run -p 8080:8080 -v ~/.local/share/signal-cli:/home/.local/share/signal-cli \
//     bbernhard/signal-cli-rest-api
//   # then register your number at http://localhost:8080/v1/register/<number>
//
// Config (env vars):
//   SIGNAL_CLI_URL          — REST API base URL (default: http://localhost:8080)
//   SIGNAL_PHONE_NUMBER     — your registered Signal number (+15551234567)
//   SIGNAL_ALLOWED_NUMBERS  — optional comma-separated allowlist

import axios from 'axios'
import { gateway } from '../gateway'
import type { ChannelAdapter } from './adapter'
import { noopLogger, type Logger } from '../v4/logger'
import {
  buildTextDeliveryBinding,
  isTerminalDeliveryError,
  type DeliveryBinding,
} from '../deliveryContext'

export class SignalAdapter implements ChannelAdapter {
  readonly name = 'signal'


  // Phase v4.1-1.3a — diagnostics route through scope logger.
  private log: Logger = noopLogger()
  private healthy          = false
  private baseUrl:  string
  private myNumber: string
  private allowedNumbers: Set<string>
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastReceived = 0

  constructor() {
    this.baseUrl    = (process.env.SIGNAL_CLI_URL ?? 'http://localhost:8080').replace(/\/$/, '')
    this.myNumber   = process.env.SIGNAL_PHONE_NUMBER ?? ''
    const raw       = process.env.SIGNAL_ALLOWED_NUMBERS ?? ''
    this.allowedNumbers = raw ? new Set(raw.split(',').map(s => s.trim()).filter(Boolean)) : new Set()
  }

  attachLogger(logger: Logger): void { this.log = logger }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.myNumber) {
      this.log.info('Disabled — set SIGNAL_PHONE_NUMBER to enable')
      return
    }

    // Verify signal-cli is reachable
    const reachable = await this.checkHealth()
    if (!reachable) {
      this.log.info('Disabled — signal-cli-rest-api not reachable at ${this.baseUrl}')
      return
    }

    this.healthy = true
    this.lastReceived = Date.now()
    this.log.info('Connected — polling ${this.baseUrl}')

    // Register outbound delivery
    gateway.registerChannel('signal', async (msg) => {
      await this.send(msg.channelId, msg.text)
      return true
    })

    // Poll for new messages every 2 seconds
    this.pollTimer = setInterval(() => this.poll(), 2000)
  }

  async stop(): Promise<void> {
    this.healthy = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    gateway.unregisterChannel('signal')
    this.log.info('Disconnected')
  }

  async send(target: string, message: string): Promise<void> {
    await this.deliverSealed(target, message)
  }

  // v4.15 delivery-isolation — the real send primitive: reports ok + whether the
  // failure was TERMINAL (target unreachable) so the seam can retire it.
  private async deliverSealed(target: string, message: string): Promise<{ ok: boolean; terminal?: boolean }> {
    if (!this.healthy) return { ok: false }
    try {
      await axios.post(
        `${this.baseUrl}/v2/send`,
        { message, number: this.myNumber, recipients: [target] },
        { timeout: 10000 },
      )
      return { ok: true }
    } catch (e: any) {
      this.log.error(`send error:${e.message}`)
      return { ok: false, terminal: isTerminalDeliveryError(e) }
    }
  }

  // v4.15 — the sealed per-turn delivery binding: 'final'/'status' text routes to
  // the frozen `target` (never a shared "current recipient").
  private buildDeliveryBinding(target: string): DeliveryBinding {
    return buildTextDeliveryBinding((text) => this.deliverSealed(target, text))
  }

  isHealthy(): boolean { return this.healthy }

  // ── Helpers ────────────────────────────────────────────────

  private async checkHealth(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/v1/health`, { timeout: 3000 })
      return true
    } catch {
      return false
    }
  }

  private async poll(): Promise<void> {
    if (!this.healthy) return
    try {
      const res = await axios.get<any[]>(
        `${this.baseUrl}/v1/receive/${encodeURIComponent(this.myNumber)}`,
        { timeout: 5000 },
      )
      const messages: any[] = Array.isArray(res.data) ? res.data : []

      for (const item of messages) {
        const envelope = item.envelope
        if (!envelope) continue
        const dm = envelope.dataMessage
        if (!dm?.message) continue

        const sender = envelope.source ?? envelope.sourceNumber ?? ''
        if (!this.isAllowed(sender)) continue

        // v4.15 — deliver THROUGH the seam: the reply carries its own frozen
        // sealed address (sender), so the return string is no longer self-sent.
        await this.processMessage(sender, sender, dm.message, this.buildDeliveryBinding(sender))
      }
    } catch (e: any) {
      // Don't spam logs on transient poll errors
      if (this.healthy) {
        this.log.error(`poll error:${e.message}`)
      }
    }
  }

  private isAllowed(number: string): boolean {
    if (this.allowedNumbers.size === 0) return true
    return this.allowedNumbers.has(number)
  }

  private async processMessage(channelId: string, userId: string, text: string, delivery?: DeliveryBinding): Promise<string> {
    try {
      return await gateway.routeMessage({
        channel:   'signal',
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
