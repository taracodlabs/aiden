// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/telegram-commands.ts — Phase v4.1-2.
//
// Slash-command router for Telegram, intercepting `/cmd`-style
// messages BEFORE they reach the agent loop. Handles:
//
//   /help            — show help text (anyone)
//   /status          — bot health (anyone)
//   /clear           — wipe this chat's memory (admin in groups; anyone in DM)
//   /pause           — pause bot in this group (admin only)
//   /resume          — unpause this group (admin only)
//   /allowusers ...  — restrict who may chat with the bot here (admin only)
//
// Admin model:
//   - The "owner" is whoever set TELEGRAM_OWNER_ID (preferred) OR the
//     Telegram user id present in the bot's token's owner field
//     (Telegram doesn't expose that — so TELEGRAM_OWNER_ID is the
//     only first-class signal).
//   - Optional TELEGRAM_ADMIN_USERS env var (CSV of user ids) escalates
//     additional users to admin.
//   - Optional Telegram-side group admin escalation: when
//     TELEGRAM_TRUST_GROUP_ADMINS is true, the bot accepts admin
//     commands from anyone Telegram reports as a group administrator.
//     Default: OFF — owner-only is the safest baseline.
//
// Non-admin admin-command attempts: silent ignore. Don't leak the
// admin list by replying "you are not an admin"; just don't react.
// All diagnostics route through the v4.1-1.3a Logger contract.

import type { Message } from 'node-telegram-bot-api'
import { noopLogger, type Logger } from '../v4/logger'
import { TelegramGroupStore } from './telegram-groups'

export type ChatType = 'private' | 'group' | 'supergroup'

/** Outcome of `route()` — drives the adapter's handleIncoming flow. */
export type RouteOutcome =
  | { kind: 'agent' }                       // not a slash command, fall through to agent
  | { kind: 'handled' }                     // command consumed; nothing more to do
  | { kind: 'reply';   text: string }       // command consumed; send this reply
  | { kind: 'cleared' }                     // /clear — caller forwards to agent's clear path
  | { kind: 'paused';  groupId: string }    // /pause — caller stops responding here
  | { kind: 'resumed'; groupId: string }    // /resume — caller resumes responding

export interface TelegramCommandRouterOptions {
  store:    TelegramGroupStore
  logger?:  Logger
  /** Bot username — drives the `/cmd@bot_username` mention strip. */
  botUsername?: () => string | null
  /**
   * Telegram-side group admin probe. Caller wires this to the
   * underlying bot client's `getChatAdministrators` so we can
   * upgrade group admins to bot admins when
   * `TELEGRAM_TRUST_GROUP_ADMINS=true`. Optional — owner-only mode
   * never calls this.
   */
  fetchGroupAdmins?: (chatId: number | string) => Promise<string[]>
}

export class TelegramCommandRouter {
  private readonly store: TelegramGroupStore
  private readonly log:   Logger
  private readonly botUsername: () => string | null
  private readonly fetchGroupAdmins?: (chatId: number | string) => Promise<string[]>

  constructor(opts: TelegramCommandRouterOptions) {
    this.store           = opts.store
    this.log             = opts.logger ?? noopLogger()
    this.botUsername     = opts.botUsername ?? (() => null)
    this.fetchGroupAdmins = opts.fetchGroupAdmins
  }

  /**
   * Inspect a Telegram message and decide whether to consume it as a
   * command or pass it through to the agent. Pure dispatch — never
   * sends messages itself; the caller renders the reply text and
   * applies state changes.
   */
  async route(msg: Message): Promise<RouteOutcome> {
    const text = (msg.text ?? '').trim()
    if (!text.startsWith('/')) return { kind: 'agent' }

    const { cmd, args } = this.parseCommand(text)
    if (!cmd) return { kind: 'agent' }

    const chatId   = String(msg.chat.id)
    const chatType = msg.chat.type as ChatType
    const senderId = msg.from?.id ? String(msg.from.id) : ''

    switch (cmd) {
      case '/help':
      case '/start':
        return { kind: 'reply', text: this.helpText(chatType) }

      case '/status':
        return { kind: 'reply', text: '✓ Online' }

      case '/clear': {
        // DMs: anyone may /clear their own chat. Groups: admin only.
        if (chatType !== 'private' && !(await this.isAdmin(senderId, chatId))) {
          this.log.info(`/clear ignored — non-admin in group`, { chatId, senderId })
          return { kind: 'handled' }
        }
        if (chatType !== 'private') this.store.recordAdminAction(chatId, 'clear', senderId)
        return { kind: 'cleared' }
      }

      case '/pause': {
        if (!this.requireGroup(chatType) || !(await this.isAdmin(senderId, chatId))) {
          this.log.info(`/pause ignored`, { chatId, senderId, chatType })
          return { kind: 'handled' }
        }
        this.store.setPaused(chatId, true, senderId)
        return { kind: 'paused', groupId: chatId }
      }

      case '/resume': {
        if (!this.requireGroup(chatType) || !(await this.isAdmin(senderId, chatId))) {
          this.log.info(`/resume ignored`, { chatId, senderId, chatType })
          return { kind: 'handled' }
        }
        this.store.setPaused(chatId, false, senderId)
        return { kind: 'resumed', groupId: chatId }
      }

      case '/allowusers': {
        if (!this.requireGroup(chatType) || !(await this.isAdmin(senderId, chatId))) {
          this.log.info(`/allowusers ignored`, { chatId, senderId, chatType })
          return { kind: 'handled' }
        }
        // Comma- or space-separated. `/allowusers reset` clears the list.
        const raw = args.join(' ').trim()
        if (raw === '' || raw === 'reset' || raw === 'clear') {
          this.store.setAllowedUsers(chatId, [], senderId)
          return { kind: 'reply', text: '✓ Cleared user allowlist for this group.' }
        }
        const ids = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
        this.store.setAllowedUsers(chatId, ids, senderId)
        return {
          kind: 'reply',
          text: `✓ User allowlist updated: ${ids.length} id(s) — only these users may chat with the bot here.`,
        }
      }

      default:
        // Unknown slash command — fall through to the agent. The
        // model can decide whether to interpret it as natural input.
        return { kind: 'agent' }
    }
  }

  // ── Admin checks ────────────────────────────────────────────────

  /**
   * True when `senderId` is allowed to issue admin-only commands here.
   * Owner takes priority; TELEGRAM_ADMIN_USERS escalates additional
   * ids; TELEGRAM_TRUST_GROUP_ADMINS=true (off by default) accepts
   * Telegram-side group admins.
   */
  async isAdmin(senderId: string, chatId: string): Promise<boolean> {
    if (!senderId) return false
    const ownerId = (process.env.TELEGRAM_OWNER_ID ?? '').trim()
    if (ownerId && senderId === ownerId) return true

    const adminCsv = (process.env.TELEGRAM_ADMIN_USERS ?? '').trim()
    if (adminCsv) {
      const admins = adminCsv.split(',').map((s) => s.trim()).filter(Boolean)
      if (admins.includes(senderId)) return true
    }

    const trustGroupAdmins = (process.env.TELEGRAM_TRUST_GROUP_ADMINS ?? '').toLowerCase() === 'true'
    if (trustGroupAdmins && this.fetchGroupAdmins) {
      try {
        const admins = await this.fetchGroupAdmins(chatId)
        if (admins.includes(senderId)) return true
      } catch (err: any) {
        this.log.warn(`getChatAdministrators failed: ${err?.message ?? err}`, { chatId })
      }
    }
    return false
  }

  // ── Internals ───────────────────────────────────────────────────

  /**
   * Extract `/cmd` and the args list from raw text.
   * Strips `@bot_username` suffixes Telegram appends in groups so
   * `/clear@aiden_test_bot` resolves to `/clear`.
   */
  private parseCommand(raw: string): { cmd: string | null; args: string[] } {
    const parts = raw.split(/\s+/)
    if (!parts[0] || !parts[0].startsWith('/')) return { cmd: null, args: [] }
    const username = (this.botUsername() ?? '').toLowerCase()
    let head = parts[0].toLowerCase()
    if (username && head.endsWith(`@${username}`)) {
      head = head.slice(0, head.length - username.length - 1)
    }
    return { cmd: head, args: parts.slice(1) }
  }

  private requireGroup(chatType: ChatType): boolean {
    return chatType === 'group' || chatType === 'supergroup'
  }

  private helpText(chatType: ChatType): string {
    const groupExtras = chatType !== 'private'
      ? '`/pause`       admin: stop bot in this group\n' +
        '`/resume`      admin: resume bot\n' +
        '`/allowusers`  admin: restrict who may chat\n'
      : ''
    return (
      '*Aiden* — your local AI assistant.\n\n' +
      'Send any message (or @mention me in a group) to start. Built-in commands:\n' +
      '`/help`        show this message\n' +
      '`/status`      bot health check\n' +
      '`/clear`       wipe this chat\'s memory\n' +
      groupExtras
    )
  }
}
