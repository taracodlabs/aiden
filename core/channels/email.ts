// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/email.ts — Email-as-interface channel adapter.
//
// Aiden acts as an email assistant: users send messages TO a dedicated
// inbox and Aiden replies via SMTP. Configure a Gmail, Fastmail, or any
// IMAP/SMTP-capable account. Use an app-specific password for Gmail.
//
// Loop prevention:
//   - Skips messages where From matches EMAIL_SMTP_USER (self-sent)
//   - Skips messages that already have an X-Aiden-Reply header
//   - Only processes subjects that don't start with "Re: " already
//     replied by Aiden
//
// Config (env vars):
//   EMAIL_IMAP_HOST         — e.g. imap.gmail.com
//   EMAIL_IMAP_PORT         — default 993 (TLS)
//   EMAIL_IMAP_USER         — your email address
//   EMAIL_IMAP_PASSWORD     — account or app-specific password
//   EMAIL_SMTP_HOST         — e.g. smtp.gmail.com
//   EMAIL_SMTP_PORT         — default 587 (STARTTLS)
//   EMAIL_SMTP_USER         — usually same as IMAP user
//   EMAIL_SMTP_PASSWORD     — usually same as IMAP password
//   EMAIL_ALLOWED_SENDERS   — optional comma-separated from-address allowlist
//   EMAIL_POLL_INTERVAL     — polling interval in seconds (default 60)

import nodemailer from 'nodemailer'
import { gateway } from '../gateway'
import type { ChannelAdapter } from './adapter'
import { noopLogger, type Logger } from '../v4/logger'
import {
  buildTextDeliveryBinding,
  isTerminalDeliveryError,
  type DeliveryBinding,
} from '../deliveryContext'

interface RawEmail {
  messageId: string
  from:      string
  subject:   string
  body:      string
  date:      Date
}

export class EmailAdapter implements ChannelAdapter {
  readonly name = 'email'


  // Phase v4.1-1.3a — diagnostics route through scope logger.
  private log: Logger = noopLogger()
  private healthy          = false
  private imapHost:        string
  private imapPort:        number
  private imapUser:        string
  private imapPassword:    string
  private smtpHost:        string
  private smtpPort:        number
  private smtpUser:        string
  private smtpPassword:    string
  private allowedSenders:  Set<string>
  private pollIntervalMs:  number
  private pollTimer:       ReturnType<typeof setInterval> | null = null
  private processedIds:    Set<string> = new Set()
  private transporter:     any = null

  constructor() {
    this.imapHost       = process.env.EMAIL_IMAP_HOST      ?? ''
    this.imapPort       = parseInt(process.env.EMAIL_IMAP_PORT  ?? '993', 10)
    this.imapUser       = process.env.EMAIL_IMAP_USER      ?? ''
    this.imapPassword   = process.env.EMAIL_IMAP_PASSWORD  ?? ''
    this.smtpHost       = process.env.EMAIL_SMTP_HOST      ?? ''
    this.smtpPort       = parseInt(process.env.EMAIL_SMTP_PORT  ?? '587', 10)
    this.smtpUser       = process.env.EMAIL_SMTP_USER      ?? ''
    this.smtpPassword   = process.env.EMAIL_SMTP_PASSWORD  ?? ''
    const raw           = process.env.EMAIL_ALLOWED_SENDERS ?? ''
    this.allowedSenders = raw ? new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) : new Set()
    this.pollIntervalMs = parseInt(process.env.EMAIL_POLL_INTERVAL ?? '60', 10) * 1000
  }

  attachLogger(logger: Logger): void { this.log = logger }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.imapHost || !this.imapUser || !this.imapPassword) {
      this.log.info('Disabled — set EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASSWORD to enable')
      return
    }
    if (!this.smtpHost || !this.smtpUser || !this.smtpPassword) {
      this.log.info('Disabled — set EMAIL_SMTP_HOST, EMAIL_SMTP_USER, EMAIL_SMTP_PASSWORD to enable')
      return
    }

    // Set up SMTP transporter
    this.transporter = nodemailer.createTransport({
      host:   this.smtpHost,
      port:   this.smtpPort,
      secure: this.smtpPort === 465,
      auth: {
        user: this.smtpUser,
        pass: this.smtpPassword,
      },
    })

    // Verify SMTP connection
    const smtpOk = await this.transporter.verify().then(() => true).catch(() => false)
    if (!smtpOk) {
      this.log.info('Disabled — SMTP connection failed. Check EMAIL_SMTP_* settings.')
      return
    }

    this.healthy = true
    this.log.info('Ready — polling ${this.imapUser} every ${this.pollIntervalMs / 1000}s')

    // Register outbound delivery
    gateway.registerChannel('email', async (msg) => {
      await this.send(msg.channelId, msg.text)
      return true
    })

    // Initial poll then start interval
    await this.poll()
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.healthy = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.transporter = null
    gateway.unregisterChannel('email')
    this.log.info('Disconnected')
  }

  async send(target: string, message: string): Promise<void> {
    if (!this.transporter) return
    try {
      await this.transporter.sendMail({
        from:    this.smtpUser,
        to:      target,
        subject: 'Message from Aiden',
        text:    message,
        headers: { 'X-Aiden-Reply': '1' },
      })
    } catch (e: any) {
      this.log.error(`send error:${e.message}`)
    }
  }

  isHealthy(): boolean { return this.healthy }

  // ── Polling ────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.healthy) return

    let imapSimple: any
    try {
      imapSimple = require('imap-simple')
    } catch {
      return
    }

    let connection: any = null
    try {
      const config = {
        imap: {
          host:           this.imapHost,
          port:           this.imapPort,
          tls:            true,
          tlsOptions:     { rejectUnauthorized: false }, // user-configured IMAP server may use self-signed cert
          user:           this.imapUser,
          password:       this.imapPassword,
          authTimeout:    5000,
        },
      }

      connection = await imapSimple.connect(config)
      await connection.openBox('INBOX')

      // Fetch unseen messages
      const messages: any[] = await connection.search(
        ['UNSEEN'],
        { bodies: ['HEADER', 'TEXT'], markSeen: false },
      )

      for (const item of messages) {
        const all      = item.parts.find((p: any) => p.which === 'TEXT')
        const header   = item.parts.find((p: any) => p.which === 'HEADER')
        const msgId    = item.attributes.uid?.toString() ?? ''

        if (this.processedIds.has(msgId)) continue

        const headers   = imapSimple.getParts ? {} : (header?.body ?? {})
        const fromRaw   = (headers['from']?.[0] ?? '').toLowerCase()
        const subject   = (headers['subject']?.[0] ?? '')
        const aidenHdr  = headers['x-aiden-reply']?.[0]

        // ── Loop prevention ──────────────────────────────────
        // 1. Skip messages from ourselves
        if (fromRaw.includes(this.smtpUser.toLowerCase())) {
          this.processedIds.add(msgId)
          continue
        }
        // 2. Skip if already tagged as an Aiden reply
        if (aidenHdr) {
          this.processedIds.add(msgId)
          continue
        }

        // Extract sender email
        const senderMatch = fromRaw.match(/<([^>]+)>/) ?? [null, fromRaw.trim()]
        const senderEmail = senderMatch[1] ?? fromRaw.trim()

        if (!this.isAllowed(senderEmail)) {
          this.processedIds.add(msgId)
          continue
        }

        const body = all?.body ?? ''
        if (!body.trim()) {
          this.processedIds.add(msgId)
          continue
        }

        this.processedIds.add(msgId)

        // v4.15 — route + deliver THROUGH the seam: the threaded SMTP reply
        // carries its own frozen sealed address (recipient + subject).
        await this.processMessage(
          senderEmail, senderEmail, this.extractText(body),
          this.buildDeliveryBinding(senderEmail, subject),
        )

        // Mark message as seen
        try {
          await connection.addFlags(item.attributes.uid, '\\Seen')
        } catch {}
      }
    } catch (e: any) {
      if (this.healthy) {
        this.log.error(`poll error:${e.message}`)
      }
    } finally {
      if (connection) {
        try { connection.end() } catch {}
      }
    }
  }

  // v4.15 delivery-isolation — threaded reply primitive: reports ok + terminal
  // (a bounced/rejected recipient is terminal so the seam retires it).
  private async replyEmail(to: string, originalSubject: string, body: string): Promise<{ ok: boolean; terminal?: boolean }> {
    if (!this.transporter) return { ok: false }
    const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`
    try {
      await this.transporter.sendMail({
        from:    this.smtpUser,
        to,
        subject,
        text:    body,
        headers: { 'X-Aiden-Reply': '1' },
      })
      return { ok: true }
    } catch (e: any) {
      this.log.error(`reply error:${e.message}`)
      return { ok: false, terminal: isTerminalDeliveryError(e) }
    }
  }

  // v4.15 — the sealed per-turn delivery binding: the reply carries its own
  // frozen recipient + threaded subject (never a shared "current sender").
  private buildDeliveryBinding(to: string, subject: string): DeliveryBinding {
    return buildTextDeliveryBinding((text) => this.replyEmail(to, subject, text))
  }

  private extractText(raw: string): string {
    // Strip quoted reply sections and HTML tags for clean prompt
    return raw
      .replace(/<[^>]+>/g, '')     // remove HTML tags
      .replace(/^>.*$/gm, '')      // remove email quote lines
      .replace(/\r\n/g, '\n')
      .trim()
      .substring(0, 4000)           // cap at 4KB
  }

  private isAllowed(email: string): boolean {
    if (this.allowedSenders.size === 0) return true
    return this.allowedSenders.has(email.toLowerCase())
  }

  private async processMessage(channelId: string, userId: string, text: string, delivery?: DeliveryBinding): Promise<string> {
    try {
      return await gateway.routeMessage({
        channel:   'email',
        channelId,
        userId,
        text,
        timestamp: Date.now(),
      }, delivery)
    } catch (e: any) {
      this.log.error(`routeMessage error:${e.message}`)
      return 'Something went wrong processing your email. Please try again.'
    }
  }
}
