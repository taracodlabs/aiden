// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/telegram.ts — Telegram channel adapter (Phase v4.1-1.2).
//
// Config (env vars):
//   TELEGRAM_BOT_TOKEN          — required; adapter stays disabled if absent
//   TELEGRAM_ALLOWED_CHATS      — optional comma-separated chat IDs allowlist
//
// Phase v4.1-1.2 fixes:
//   - All adapter logs route through an injectable AidenFileLogger
//     (~/.aiden/logs/telegram.log) instead of console.log / console.warn
//     so polling-error spam never leaks into the CLI's chat REPL stdout.
//   - 409 Conflict (concurrent-poller) is detected and counted; after
//     CONFLICT_THRESHOLD consecutive 409s the adapter stops polling and
//     transitions to a `conflict` state surfaced in the boot card and
//     /channel telegram status.
//
// Phase 1 scope:
//   - Long-polling mode only (webhooks land in Phase 2)
//   - Direct messages only — group chats are politely ignored
//   - Plain-text messages — voice / files / inline mode are Phase 2
//   - Outbound chunked at 4096 chars (Telegram hard limit on text messages)
//   - Per-chat memory isolation routed via gateway.routeMessage(channelId)
//   - Bot replies suppressed (no bot loops)
//   - Token never logged or surfaced in error messages

import TelegramBotApi, { type Message, type MessageEntity } from 'node-telegram-bot-api'
import { promises as fsPromises, createWriteStream } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { gateway } from '../gateway'
import type { ChannelAdapter } from './adapter'
import type { DeliveryBinding, DeliveryCapabilities, DeliveryReceipt } from '../deliveryContext'
import { isTerminalDeliveryError } from '../deliveryContext'
import { noopLogger, type Logger } from '../v4/logger'
import { TelegramRateLimiter } from './telegram-rate-limit'
import { TelegramGroupStore } from './telegram-groups'
import { TelegramCommandRouter } from './telegram-commands'
import { resolveAidenPaths } from '../v4/paths'
import {
  transcribeForChannel as defaultTranscribeForChannel,
  type TranscribeOptions,
  type TranscriptionResult,
} from './whisper-transcribe'
import {
  analyzePhotoForChannel as defaultAnalyzePhotoForChannel,
  type PhotoOptions,
  type PhotoResult,
} from './photo-vision'
import {
  extractPdfForChannel as defaultExtractPdfForChannel,
  type PdfOptions,
  type PdfResult,
} from './pdf-extract'

// Telegram Bot API constants — public spec, see core.telegram.org/bots/api
const MAX_MESSAGE_CHARS  = 4096
const POLLING_TIMEOUT_S  = 50          // long-poll window; Telegram caps at 50
const POLLING_INTERVAL_MS = 300        // surfaced as a constant so the
                                       // liveness log can publish it.
const DEFAULT_PARSE_MODE = 'Markdown'  // Aiden agent answers are markdown-friendly
const CONFLICT_THRESHOLD = 3           // consecutive 409s before we surrender

// v4.12 DC.2 — Telegram's declared delivery capabilities, the shared home for
// its delivery quirks. Declared HONESTLY per what the seam actually routes
// today (SH.1 discipline): the 'final' text path is wired and chunks via the
// UTF-16-aware chunkAtBoundary, so `chunkLongMessages: true`. Edit / outbound
// media / voice-bubble / reactions are NOT yet routed through ctx.send, so they
// stay false/[] until a future slice wires them (flip them on then, not now).
const TELEGRAM_DELIVERY_CAPABILITIES: DeliveryCapabilities = {
  edit:              false,
  chunkLongMessages: true,   // deliverToChat → chunkAtBoundary(text, 4096), UTF-16 length
  media:             [],
  voiceBubble:       false,
  reactions:         false,
}

// v4.12 DC.2 — the per-platform first-message hint (was a hardcoded
// `channel === 'telegram'` branch in the generic gateway; DC.1 moved it here).
// Byte-identical text to the pre-migration tip.
const TELEGRAM_FIRST_MESSAGE_HINT =
  '_Tip: Continue this conversation on your desktop dashboard with full context._'

// v4.15 delivery-isolation — the outcome of a multi-chunk delivery. `partial`
// means some chunks landed and some didn't (a transient failure no longer
// abandons the rest); `terminal` means the target is unreachable (403/blocked).
interface DeliverToChatResult {
  ok:        boolean
  sent:      number
  total:     number
  partial?:  boolean
  terminal?: boolean
}

/**
 * Phase v4.1-3.2 — build fingerprint.
 *
 * Bumped manually per phase. Surfaced in the `polling launched` log
 * so live tests can grep one line and confirm the running binary
 * matches the expected phase. Today's example: live test of v4.1-3.1
 * silently failed because the user ran an older `dist/` build —
 * watching for the fingerprint in the log would have flagged that
 * in seconds instead of hours.
 */
export const TELEGRAM_ADAPTER_BUILD = 'v4.1-4.2'

// Phase v4.1-3 — voice cache + janitor knobs. Constants rather than
// env vars because they're maintenance defaults; if the cache grows
// past 500 MB on a long-running deployment the janitor fires once on
// startup. Real TTL system parks at v4.2.
const VOICE_CACHE_DIR_NAME      = 'audio'
const VOICE_CACHE_PARENT        = 'cache'
const JANITOR_THRESHOLD_BYTES   = 500 * 1024 * 1024  // 500 MB
const JANITOR_AGE_THRESHOLD_MS  = 7 * 24 * 60 * 60 * 1000  // 7 days
const DEFAULT_CONFIDENCE_FLOOR  = -0.5

// Phase v4.1-4 — photo + document cache subdirs (siblings of `audio`).
const PHOTO_CACHE_DIR_NAME      = 'photos'
const DOCUMENT_CACHE_DIR_NAME   = 'documents'

/**
 * Phase v4.1-4 — supported document MIME map. Extension → MIME.
 * Anything outside this map gets a friendly reject reply. The list
 * is intentionally tight for v4.1-4 (PDF + the four common image
 * formats sent as files); we expand in a later sub-phase as demand
 * surfaces. Keep the values lowercase to compare against
 * `msg.document.mime_type` directly.
 */
const SUPPORTED_DOC_MIME: Readonly<Record<string, string>> = {
  '.pdf':  'application/pdf',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
}

/**
 * Phase v4.1-4 — pluggable photo + pdf functions. Production wires
 * the modules under `./photo-vision` and `./pdf-extract`. Smokes
 * inject stubs so they don't hit Anthropic / OpenAI / pdf-parse.
 */
export type AnalyzePhotoFn  = (opts: PhotoOptions) => Promise<PhotoResult>
export type ExtractPdfFn    = (opts: PdfOptions)   => Promise<PdfResult>

/**
 * Phase v4.1-3 — pluggable transcription contract. Production wires
 * `transcribeForChannel` from `./whisper-transcribe`. Smokes inject a
 * stub so they don't need a live Groq key.
 */
export type TranscribeFn = (opts: TranscribeOptions) => Promise<TranscriptionResult>

/** Bot lifecycle state — drives the boot card pill + /channel status. */
export type TelegramAdapterState =
  | 'inactive'   // no token / not started
  | 'connecting' // start() in flight, getMe pending
  | 'active'     // polling cleanly
  | 'degraded'   // intermittent errors, still trying
  | 'conflict'   // 409s — another poller is holding this bot

// ── TelegramAdapter ────────────────────────────────────────────

export interface TelegramAdapterOptions {
  /**
   * Phase v4.1-1.3a — injected `Logger` from `core/v4/logger`. Replaces
   * the v4.1-1.2 `AidenFileLogger` shim with the unified Logger
   * contract used everywhere else in v4.1. ChannelManager.register
   * will also inject one via `attachLogger` if no constructor logger
   * is provided, so most call sites don't need to pass this.
   */
  logger?: Logger | null
  /**
   * Phase v4.1-3 — test seam. Smokes pass a stub that returns canned
   * `TranscriptionResult`s without hitting Groq / OpenAI. Production
   * leaves this unset; the adapter falls back to
   * `transcribeForChannel` from `./whisper-transcribe`.
   */
  transcribe?: TranscribeFn
  /**
   * Phase v4.1-3.2 — test seam for the bot client constructor. Smokes
   * inject a fake `EventEmitter`-backed bot so the G-section liveness-
   * log assertions can drive `start()` end-to-end without a real
   * polling loop. Production leaves this unset; we construct a real
   * `TelegramBotApi`.
   */
  clientFactory?: (token: string, opts: unknown) => unknown
  /**
   * Phase v4.1-4 — test seam for the photo-vision pipeline. Smokes
   * inject a stub returning canned `PhotoResult` so they don't hit
   * Anthropic / OpenAI. Production leaves this unset.
   */
  analyzePhoto?: AnalyzePhotoFn
  /**
   * Phase v4.1-4 — test seam for the pdf-extract pipeline. Smokes
   * inject a stub returning canned `PdfResult` so they don't run
   * `pdf-parse` against a real PDF. Production leaves this unset.
   */
  extractPdf?: ExtractPdfFn
  /**
   * Phase v4.1-4 — used by the channel adapter to compute the
   * `supportsVision` flag and the PDF truncation budget at runtime.
   * Defaults to a closure returning `null` when missing — vision
   * routing falls back to `'text'` mode and PDFs use the hard 50 KB
   * char cap.
   */
  activeModelInfo?: () => { providerId?: string; modelId?: string; contextWindow?: number } | null
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram'

  private client:       TelegramBotApi | null = null
  private token:        string
  private allowedChats: Set<string>
  private healthy       = false
  // Phase v4.1-1.1 — populated by getMe() on a successful connect so
  // /channel list and /channel telegram status can show the live name.
  private botUsername:  string | null = null
  // Wall-clock of the last inbound message — surfaced in /channel
  // telegram status so the user can confirm polling is actually
  // delivering messages, not just connected.
  private lastMessageAt: number | null = null
  private errorCount:    number        = 0
  // Phase v4.1-1.2 — 409 Conflict tracking. Telegram only allows one
  // concurrent poller per bot; if a second instance starts, both get
  // 409s every poll cycle. We count consecutive 409s and surrender
  // (stop polling) once we cross CONFLICT_THRESHOLD so we don't spam.
  private state:               TelegramAdapterState = 'inactive'
  private consecutiveConflicts = 0
  private log:                 Logger
  // Phase v4.1-2 — group machinery. Lazily constructed in start() so
  // tests that bypass start() don't need a paths fixture.
  private groupStore:          TelegramGroupStore | null = null
  private rateLimiter:         TelegramRateLimiter | null = null
  private commandRouter:       TelegramCommandRouter | null = null
  private allowedGroups:       Set<string> = new Set()
  /** When true, groups respond to every message — overrides mention-only. */
  private groupsRespondAll:    boolean = false
  // Phase v4.1-3 — voice transcription state.
  /**
   * Pluggable transcription function. Production: the channel-side
   * Whisper adapter from `./whisper-transcribe`. Smokes: a stub.
   */
  private transcribeFn:        TranscribeFn
  /** Number of voice messages successfully transcribed since adapter start. */
  private voiceTranscribedCount: number = 0
  /** Number of voice messages received (any outcome) since adapter start. */
  private voiceReceivedCount:    number = 0
  // Phase v4.1-3.1 — idempotency guard for the defensive secondary
  // subscriptions. NTBA always fires 'message' AND the type-specific
  // event ('voice', 'audio') for media attachments; we subscribe to
  // both so the bot stays alive even if a future lib version stops
  // emitting 'message' for some media type. The dedup key is
  // `${chat_id}:${message_id}` — Telegram guarantees uniqueness within
  // a chat. Tiny 256-entry FIFO; eviction order is insertion order so
  // we don't need a real LRU policy.
  private static readonly RECENT_MSG_LIMIT     = 256
  private recentMessageIds:    Set<string>  = new Set()
  private recentMessageOrder:  string[]     = []
  /**
   * Phase v4.1-3.2 — first-inbound sentinel. Logs once per adapter
   * lifecycle (reset on each `start()`). If "polling launched" fires
   * but "polling first inbound" never does, polling is stalled at
   * the network layer — the cheapest "is the loop alive?" tell.
   */
  private firstInboundLogged:  boolean = false
  /**
   * Phase v4.1-4.2 — outbound delivery dedup. `${chat_id}:${msg_id}`
   * keys for messages that have already had `deliverAgentReply` fire.
   * Same FIFO shape as `recentMessageIds`; protects against any path
   * (race, future regression in dispatch dedup, multi-handler bug)
   * that could double-fire a reply for the same inbound message.
   */
  private static readonly REPLIED_MSG_LIMIT = 256
  private repliedMessageIds:   Set<string>  = new Set()
  private repliedMessageOrder: string[]     = []
  /**
   * Phase v4.1-4.2 — Telegram delivery-split coalesce slot. When a
   * Telegram client splits a single "send caption + photo" action
   * into two separate updates (text-only + photo-with-caption, ~1ms
   * apart in the same poll batch), the photo handler synchronously
   * records the caption here BEFORE awaiting the download. The text
   * fall-through then checks this slot and suppresses dispatch when
   * the text matches a recent caption — the agent only sees the
   * photo annotation, never the orphaned text. Per-chat single-slot
   * because the only legitimate collision is on consecutive photos
   * from the same chat (the latest one wins).
   */
  private recentPhotoCaptions: Map<string, { caption: string; ts: number }> = new Map()
  /**
   * Phase v4.1-3.2 — captured polling params so the smoke can
   * inspect them via `getDiagnostics()` without hitting NTBA's
   * internal `_polling.options` shape. Set once per `start()`.
   */
  private lastPollingParams: { interval: number; timeout: number; allowedUpdates: readonly string[] } | null = null
  /** Phase v4.1-3.2 — stored client factory (test seam). */
  private clientFactory: ((token: string, opts: unknown) => unknown) | null = null
  // Phase v4.1-4 — photo + document state.
  private analyzePhotoFn:        AnalyzePhotoFn
  private extractPdfFn:          ExtractPdfFn
  private activeModelInfo:       () => { providerId?: string; modelId?: string; contextWindow?: number } | null
  /** Number of photos handled (any outcome) since adapter start. */
  private photoReceivedCount:    number = 0
  /** Number of photos successfully described / attached since adapter start. */
  private photoProcessedCount:   number = 0
  /** Number of documents handled (any outcome) since adapter start. */
  private documentReceivedCount: number = 0
  /** Number of documents successfully extracted / routed since adapter start. */
  private documentProcessedCount: number = 0

  constructor(opts: TelegramAdapterOptions = {}) {
    // Snapshot env at construction so tests that bypass start() (stubbing
    // the bot client directly) still see the configured token + allowlist.
    // start() re-snapshots — that's the path that makes
    // channelManager.restart('telegram') pick up a freshly-written .env.
    this.token        = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
    const rawChats    = process.env.TELEGRAM_ALLOWED_CHATS ?? ''
    this.allowedChats = rawChats
      ? new Set(rawChats.split(',').map(s => s.trim()).filter(Boolean))
      : new Set()
    // Phase v4.1-1.3a — default to noopLogger so REPL stays clean
    // even if nobody calls attachLogger. ChannelManager.register
    // overrides with a scoped child logger.
    this.log = opts.logger ?? noopLogger()
    // Phase v4.1-3 — production wiring of the channel-side Whisper adapter.
    this.transcribeFn = opts.transcribe ?? defaultTranscribeForChannel
    this.clientFactory = opts.clientFactory ?? null
    // Phase v4.1-4 — production wiring of the photo + pdf adapters.
    this.analyzePhotoFn = opts.analyzePhoto ?? defaultAnalyzePhotoForChannel
    this.extractPdfFn   = opts.extractPdf   ?? defaultExtractPdfForChannel
    this.activeModelInfo = opts.activeModelInfo ?? (() => null)
  }

  attachLogger(logger: Logger): void {
    this.log = logger
  }

  // ── Logging shims — kept for the file-internal call sites that
  // were touched in v4.1-1.2. Each routes through the injected logger;
  // there is no console.* fallback any more — REPL is sacred.
  // Phase v4.1-2 — accept an optional structured context payload so
  // group-routing diagnostics can include { chatId, userId, ... } that
  // the FileSink renders as JSON after the message body.

  private logInfo(msg: string, ctx?: Record<string, unknown>):  void { this.log.info(msg, ctx)  }
  private logWarn(msg: string, ctx?: Record<string, unknown>):  void { this.log.warn(msg, ctx)  }

  // ── Phase v4.1-preship-cleanup: local-machine polling lock ───────
  // A small lock file under <aidenHome>/telegram-polling.lock keyed
  // on the bot token (truncated). Same-machine rivals see the lock
  // and bail out with a clear message instead of racing for 409s.
  // Stale locks (>60s past last refresh) are treated as abandoned —
  // a crashed or kill -9'd aiden won't permanently block restarts.
  private static readonly LOCK_STALE_MS = 60_000;

  private lockPath(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveAidenPaths } = require('../v4/paths') as typeof import('../v4/paths');
    return path.join(resolveAidenPaths().root, 'telegram-polling.lock');
  }

  private acquireLocalLock(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    const p = this.lockPath();
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(raw) as { pid?: number; ts?: number; token?: string };
      const tokenTag = (this.token ?? '').slice(0, 8);
      const sameToken = obj.token === tokenTag;
      const fresh     = typeof obj.ts === 'number' && (Date.now() - obj.ts) < TelegramAdapter.LOCK_STALE_MS;
      const sameProcess = typeof obj.pid === 'number' && obj.pid === process.pid;
      if (sameProcess) {
        // Re-acquire after our own restart — refresh and proceed.
        this.writeLockFile(p);
        return true;
      }
      if (sameToken && fresh) {
        return false; // another aiden on this box, this token, recent.
      }
      // Stale or different-token — overwrite.
      this.writeLockFile(p);
      return true;
    } catch {
      // No lock file yet (or unreadable) — ours now.
      this.writeLockFile(p);
      return true;
    }
  }

  private writeLockFile(p: string): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    try {
      const dir = require('node:path').dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify({
        pid: process.pid,
        ts:  Date.now(),
        token: (this.token ?? '').slice(0, 8),
      }), 'utf8');
    } catch {
      // Lock-write failure is non-fatal — fall through and let the
      // 409 detection handle any actual conflict at runtime.
    }
  }

  private releaseLocalLock(): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    try {
      const p = this.lockPath();
      const raw = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(raw) as { pid?: number };
      // Only release a lock we own — don't unlink a sibling's claim.
      if (obj.pid === process.pid) fs.unlinkSync(p);
    } catch {
      /* lock not present or unreadable — nothing to release */
    }
  }
  private logError(msg: string, ctx?: Record<string, unknown>): void { this.log.error(msg, ctx) }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    // Phase v4.1-1.1: re-read env on every start() so the slash-command
    // path can rotate the token by writing .env then calling
    // channelManager.restart('telegram'). The earlier implementation
    // only read env in the constructor, which froze the token for the
    // adapter's lifetime.
    this.token        = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
    const rawChats    = process.env.TELEGRAM_ALLOWED_CHATS ?? ''
    this.allowedChats = rawChats
      ? new Set(rawChats.split(',').map(s => s.trim()).filter(Boolean))
      : new Set()
    this.botUsername          = null
    this.errorCount           = 0
    this.lastMessageAt        = null
    this.consecutiveConflicts = 0
    this.state                = 'inactive'
    this.firstInboundLogged   = false
    this.lastPollingParams    = null

    // Phase v4.1-2 — read group-side env knobs alongside the token.
    const rawAllowedGroups = process.env.TELEGRAM_ALLOWED_GROUPS ?? ''
    this.allowedGroups = rawAllowedGroups
      ? new Set(rawAllowedGroups.split(',').map(s => s.trim()).filter(Boolean))
      : new Set()
    this.groupsRespondAll =
      (process.env.TELEGRAM_GROUPS_RESPOND_ALL ?? '').toLowerCase() === 'true'

    if (!this.token) {
      this.logInfo('Disabled — set TELEGRAM_BOT_TOKEN to enable')
      return
    }

    // Phase v4.1-3 — voice cache janitor runs once at adapter start.
    // No background timer (defer real TTL to v4.2). Best-effort: a
    // janitor failure must not block polling.
    this.runVoiceCacheJanitor().catch((e: any) => {
      this.logWarn(`voice cache janitor failed: ${e?.message ?? String(e)}`)
    })

    // Phase v4.1-2 — construct group machinery (one rate limiter + one
    // store + one command router shared across all groups). Failure
    // here is non-fatal: the adapter falls back to DM-only.
    if (!this.groupStore) {
      try {
        this.groupStore   = new TelegramGroupStore({
          paths:  resolveAidenPaths(),
          logger: this.log.child('groups'),
        })
        this.rateLimiter  = new TelegramRateLimiter({ logger: this.log.child('ratelimit') })
        this.commandRouter = new TelegramCommandRouter({
          store:       this.groupStore,
          logger:      this.log.child('commands'),
          botUsername: () => this.botUsername,
          fetchGroupAdmins: async (chatId) => {
            if (!this.client) return []
            try {
              const admins = await this.client.getChatAdministrators(chatId)
              return admins.map((a: any) => String(a?.user?.id ?? '')).filter(Boolean)
            } catch { return [] }
          },
        })
        await this.groupStore.load()
      } catch (e: any) {
        this.logWarn(`group machinery init failed: ${this.scrubToken(e?.message)}`)
        this.groupStore    = null
        this.rateLimiter   = null
        this.commandRouter = null
      }
    }

    // Phase v4.1-preship-cleanup — local same-machine lock so two
    // aiden processes on the same dev box don't both start polling
    // the same bot and trigger 409s. Lock file at
    // <aidenHome>/telegram-polling.lock contains pid + timestamp.
    // Stale locks (>60s old) are auto-released. Cross-machine /
    // shared-token conflicts are NOT covered here — those still
    // surface via the existing 409 detection + /channel telegram
    // takeover path.
    if (!this.acquireLocalLock()) {
      this.state = 'conflict';
      this.healthy = false;
      this.logWarn(
        'Skipping polling — another aiden process on THIS machine is already holding the Telegram bot. ' +
          'Run `tasklist | grep node` (Windows) or `pgrep node` (POSIX) to see the rival, ' +
          'or stop the other instance and re-run /channel telegram takeover here.',
      );
      return;
    }

    this.state = 'connecting'

    // Phase v4.1-3.2 — explicit allowed_updates defends against
    // Telegram's "sticky filter" behaviour (getUpdates spec: "If
    // not specified, the previous setting will be used."). Empty
    // list means "all default update types" per the same spec.
    // Operators can override via TELEGRAM_ALLOWED_UPDATES (CSV) if
    // they need exotic kinds like chat_member.
    const allowedUpdates = readAllowedUpdates()
    this.lastPollingParams = {
      interval:       POLLING_INTERVAL_MS,
      timeout:        POLLING_TIMEOUT_S,
      allowedUpdates,
    }

    try {
      const factory = this.clientFactory ?? ((t: string, o: unknown) => new TelegramBotApi(t, o as any))
      this.client = factory(this.token, {
        polling: {
          interval:  POLLING_INTERVAL_MS,
          autoStart: true,
          params: {
            timeout:         POLLING_TIMEOUT_S,
            allowed_updates: allowedUpdates,
          },
        },
      }) as TelegramBotApi
    } catch (e: any) {
      // Constructor failure (rare — usually a malformed token shape).
      // Strip any echoed token from the message defensively.
      this.logError(`Failed to construct client: ${this.scrubToken(e?.message)}`)
      this.healthy = false
      this.state   = 'inactive'
      return
    }

    // Phase v4.1-3.2 — liveness log. Fires AFTER client construction
    // and BEFORE getMe so a getMe-stall (auth failure, network) is
    // distinguishable from a "never even tried polling" situation.
    // The fingerprint here is the smoking-gun for build-staleness:
    // grep this line in the live log, compare against the expected
    // phase number; mismatch = user is running old compiled JS.
    this.logInfo('polling launched', {
      fingerprint:   TELEGRAM_ADAPTER_BUILD,
      interval:      POLLING_INTERVAL_MS,
      timeout:       POLLING_TIMEOUT_S,
      allowedUpdates: allowedUpdates.length === 0 ? '[] (all default types)' : allowedUpdates,
    })

    this.client.on('polling_error', (err: Error) => {
      this.errorCount += 1
      const message = this.scrubToken(err?.message ?? '')
      const is409 = isConflictError(err)

      if (is409) {
        this.consecutiveConflicts += 1
        // Phase v4.1-1.2 — log the FIRST 409 visibly (so /channel
        // telegram status reflects reality), then go quiet to avoid
        // spamming the file. After threshold, stop polling cleanly.
        if (this.consecutiveConflicts === 1) {
          this.logWarn(
            'Polling 409 Conflict — another aiden instance is holding this bot. ' +
              'Will stop polling after ' + CONFLICT_THRESHOLD + ' consecutive 409s.',
          )
        }
        if (this.consecutiveConflicts >= CONFLICT_THRESHOLD) {
          this.state   = 'conflict'
          this.healthy = false
          this.logWarn(
            `Surrendering after ${CONFLICT_THRESHOLD} consecutive 409s. ` +
              'Run /channel telegram status — use /channel telegram takeover ' +
              'if you want this instance to take over the bot.',
          )
          // Stop polling without awaiting — the event handler must return
          // promptly. node-telegram-bot-api accepts stopPolling() repeatedly.
          this.client?.stopPolling({ cancel: true }).catch(() => undefined)
        }
        return
      }

      // Non-409: regular transient (502/504 storms etc.) — counted but
      // not threshold-tripping. Reset conflict streak so we don't OR
      // with stale 409s.
      this.consecutiveConflicts = 0
      // Mark degraded only if previously active so the pill flips to
      // "degraded" rather than masking a healthy state.
      if (this.state === 'active') this.state = 'degraded'
      this.logWarn(`Polling error: ${message}`)
    })

    this.client.on('webhook_error', (err: Error) => {
      // Defensive: not active in polling mode but could fire if a stale
      // webhook URL is registered against this bot.
      this.logWarn(`Webhook error: ${this.scrubToken(err?.message)}`)
    })

    // Phase v4.1-3.1 — extracted into wireMessageHandlers() so the
    // smoke can drive the same code path with a stub EventEmitter-
    // backed client (no real polling loop needed). This subscribes
    // to 'message' AND defensive secondary subscriptions for 'voice'
    // and 'audio' to make sure media never gets silently dropped if
    // NTBA's emit policy ever shifts.
    this.wireMessageHandlers()

    // Identify self so the boot log is honest about which bot is alive.
    try {
      const me = await this.client.getMe()
      this.botUsername = me.username ?? me.first_name ?? null
      // Phase v4.1-3.2 — second liveness log. If "polling launched"
      // fires but "polling getMe ok" doesn't, getMe is hanging
      // (auth issue, network filter, or DNS).
      this.logInfo('polling getMe ok', {
        fingerprint: TELEGRAM_ADAPTER_BUILD,
        botUsername: this.botUsername,
      })
      this.logInfo(`Connected as @${this.botUsername ?? 'bot'}`)
      this.healthy = true
      this.state   = 'active'
    } catch (e: any) {
      // 401 here means the token is rejected — keep adapter inert
      // rather than retry-storming.
      this.logError(`getMe failed: ${this.scrubToken(e?.message)}`)
      this.healthy = false
      this.state   = 'inactive'
      try { await this.client.stopPolling() } catch { /* nothing to clean */ }
      this.client = null
      return
    }

    // Register outbound delivery so gateway.deliver() / broadcast() work.
    gateway.registerChannel('telegram', async (msg) => {
      return (await this.deliverToChat(msg.channelId, msg.text)).ok
    })

    // Surface bot commands in the Telegram client's `/` menu. Best-effort —
    // a 429 here doesn't block startup.
    this.publishBotCommands().catch((e: Error) =>
      this.logWarn(`setMyCommands failed: ${this.scrubToken(e.message)}`),
    )
  }

  async stop(): Promise<void> {
    this.healthy = false
    this.state   = 'inactive'

    // Phase v4.1-2 — flush group state + dispose rate-limiter timers.
    // Best-effort; never let cleanup throw stop the shutdown chain.
    try { await this.groupStore?.flushNow() } catch { /* ignore */ }
    try { this.rateLimiter?.dispose() } catch { /* ignore */ }

    if (!this.client) {
      return
    }

    gateway.unregisterChannel('telegram')

    // stopPolling resolves once the in-flight long-poll ends; on a 50s
    // poll window we wait at most that long. Wrap in try/catch because
    // network errors during shutdown are not interesting.
    try {
      await this.client.stopPolling({ cancel: true })
    } catch {
      /* shutdown best-effort */
    }
    this.client = null
    // Phase v4.1-preship-cleanup — release the local-machine lock
    // so a follow-up adapter restart (or another aiden process)
    // can acquire polling immediately rather than waiting for the
    // 60s staleness timeout.
    this.releaseLocalLock();
    this.logInfo('Disconnected')
  }

  async send(chatId: string, message: string): Promise<void> {
    await this.deliverToChat(chatId, message)
  }

  isHealthy(): boolean {
    return this.healthy
  }

  // ── Status accessors (Phase v4.1-1.1 — used by /channel commands) ──

  /** Bot username from the last successful getMe() call, or null. */
  getBotUsername(): string | null {
    return this.botUsername
  }

  /** True when a token was found in the environment at last start(). */
  hasToken(): boolean {
    return this.token.length > 0
  }

  /** Phase v4.1-1.2 — coarse adapter state, drives boot pill + status. */
  getState(): TelegramAdapterState {
    return this.state
  }

  /** Phase v4.1-2 — read-only group store accessor for CLI commands. */
  getGroupStore(): TelegramGroupStore | null {
    return this.groupStore
  }

  /** Phase v4.1-2 — read-only allowlist accessor for CLI commands. */
  getAllowedGroups(): ReadonlySet<string> {
    return this.allowedGroups
  }

  /**
   * Phase v4.1-3 — voice diagnostics for `/channel telegram voice
   * status`. Safe to call any time; returns the in-memory counters
   * (reset on adapter start) plus the cache footprint on disk.
   */
  async getVoiceDiagnostics(): Promise<{
    enabled:           boolean
    threshold:         number
    language:          string | null
    cacheDir:          string
    cacheBytes:        number
    cacheFileCount:    number
    transcribedCount:  number
    receivedCount:     number
  }> {
    const cacheDir = this.getVoiceCacheDir()
    let cacheBytes = 0
    let cacheFileCount = 0
    try {
      const entries = await fsPromises.readdir(cacheDir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile()) continue
        try {
          const st = await fsPromises.stat(path.join(cacheDir, e.name))
          cacheBytes += st.size
          cacheFileCount += 1
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir missing — ok, just zero */ }
    return {
      enabled:          isVoiceEnabled(),
      threshold:        readConfidenceThreshold(),
      language:         (process.env.TELEGRAM_VOICE_LANGUAGE ?? '').trim() || null,
      cacheDir,
      cacheBytes,
      cacheFileCount,
      transcribedCount: this.voiceTranscribedCount,
      receivedCount:    this.voiceReceivedCount,
    }
  }

  /**
   * Phase v4.1-3 — public hook for tests + the CLI. Returns the
   * absolute path to where voice notes are cached on disk.
   */
  getVoiceCacheDir(): string {
    return path.join(resolveAidenPaths().root, VOICE_CACHE_PARENT, VOICE_CACHE_DIR_NAME)
  }

  /**
   * Phase v4.1-4 — media (voice + photos + documents) aggregate
   * diagnostics for `/channel telegram media status`. Walks the
   * three cache subdirs, totals their sizes + file counts, returns
   * the supported-types table.
   */
  async getMediaDiagnostics(): Promise<{
    enabled:           boolean
    supportedDocTypes: readonly string[]
    voice:    { dir: string; bytes: number; files: number }
    photos:   { dir: string; bytes: number; files: number; receivedCount: number; processedCount: number }
    documents:{ dir: string; bytes: number; files: number; receivedCount: number; processedCount: number }
  }> {
    return {
      enabled:           isMediaEnabled(),
      supportedDocTypes: Object.keys(SUPPORTED_DOC_MIME).map((k) => k.replace(/^\./, '')),
      voice:     await this.summarizeCacheDir(this.getVoiceCacheDir()),
      photos:    {
        ...(await this.summarizeCacheDir(this.getPhotoCacheDir())),
        receivedCount:  this.photoReceivedCount,
        processedCount: this.photoProcessedCount,
      },
      documents: {
        ...(await this.summarizeCacheDir(this.getDocumentCacheDir())),
        receivedCount:  this.documentReceivedCount,
        processedCount: this.documentProcessedCount,
      },
    }
  }

  private async summarizeCacheDir(dir: string): Promise<{ dir: string; bytes: number; files: number }> {
    let bytes = 0
    let files = 0
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile()) continue
        try {
          const st = await fsPromises.stat(path.join(dir, e.name))
          bytes += st.size
          files += 1
        } catch { /* skip */ }
      }
    } catch { /* dir missing — ok */ }
    return { dir, bytes, files }
  }

  getDiagnostics(): {
    healthy: boolean
    hasToken: boolean
    botUsername: string | null
    lastMessageAt: number | null
    errorCount: number
    pollingActive: boolean
    state: TelegramAdapterState
    consecutiveConflicts: number
    /** Phase v4.1-3.2 — fingerprint of the running adapter binary. */
    buildFingerprint: string
    /** Phase v4.1-3.2 — params handed to NTBA at last `start()`. */
    pollingParams: { interval: number; timeout: number; allowedUpdates: readonly string[] } | null
  } {
    return {
      healthy:              this.healthy,
      hasToken:             this.hasToken(),
      botUsername:          this.botUsername,
      lastMessageAt:        this.lastMessageAt,
      errorCount:           this.errorCount,
      // node-telegram-bot-api exposes isPolling() — guard for the lib being
      // mid-construction in early start() failures.
      pollingActive:        this.client?.isPolling?.() === true,
      state:                this.state,
      consecutiveConflicts: this.consecutiveConflicts,
      buildFingerprint:     TELEGRAM_ADAPTER_BUILD,
      pollingParams:        this.lastPollingParams,
    }
  }

  /**
   * Phase v4.1-1.2 — `/channel telegram takeover` reaches the network
   * directly to evict the other poller. Two-step:
   *   1. POST /deleteWebhook?drop_pending_updates=true — clears any
   *      stale webhook AND drops the buffered update queue.
   *   2. GET /getUpdates?offset=-1 — Telegram's documented way to
   *      "kick" the other concurrent long-poll. The other instance's
   *      in-flight getUpdates returns 409 + closes; on its retry it
   *      hits 409 too and (in adapters that detect it) surrenders.
   * Returns ok/error so the slash command can render diagnostics.
   */
  async takeoverPolling(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.token) return { ok: false, reason: 'no token configured' }
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const base  = `https://api.telegram.org/bot${this.token}`
    try {
      // 1. Clear webhook + pending updates so we start from a clean queue.
      const dw = await fetch(
        `${base}/deleteWebhook?drop_pending_updates=true`,
        { signal: ctrl.signal, method: 'POST' },
      )
      if (!dw.ok) {
        return { ok: false, reason: `deleteWebhook HTTP ${dw.status}` }
      }
      // 2. Issue a synthetic getUpdates with offset=-1 to interrupt the
      //    rival poll and reserve the slot for us.
      const gu = await fetch(
        `${base}/getUpdates?offset=-1&limit=1&timeout=0`,
        { signal: ctrl.signal },
      )
      if (!gu.ok) {
        return { ok: false, reason: `getUpdates HTTP ${gu.status}` }
      }
      this.consecutiveConflicts = 0
      // After takeover we want a clean restart so polling resumes with
      // fresh client state + the 409 counter zeroed.
      await this.stop()
      await this.start()
      return { ok: this.healthy }
    } catch (err: any) {
      return {
        ok: false,
        reason: err?.name === 'AbortError'
          ? 'request timed out (10s)'
          : (err?.message ?? 'network error'),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Inbound ──────────────────────────────────────────────────

  /**
   * Phase v4.1-3.1 — extracted message-event wiring. Subscribes to
   * the primary `'message'` event AND defensive secondaries `'voice'`
   * and `'audio'`. Idempotency via `markMessageSeen` so a message
   * that fires both events (NTBA's normal behaviour) only runs the
   * pipeline once.
   *
   * Marked `protected` so smoke harnesses can drive this directly
   * against a stub EventEmitter without standing up a real polling
   * loop. Tests do `(adapter as never).wireMessageHandlers()` after
   * patching `client` to a fake bot.
   */
  protected wireMessageHandlers(): void {
    if (!this.client) return
    const dispatch = (source: 'message' | 'voice' | 'audio' | 'photo' | 'document') =>
      async (msg: Message): Promise<void> => {
        // Phase v4.1-3.2 — third liveness log. Fires once per process
        // on the first inbound message regardless of content type. If
        // "polling launched" + "polling getMe ok" fired but this never
        // does, the polling loop is alive in the SDK sense but no
        // messages are reaching us — likely a server-side filter,
        // sticky `allowed_updates`, or a Telegram throttle.
        if (!this.firstInboundLogged) {
          this.firstInboundLogged = true
          this.logInfo('polling first inbound', {
            fingerprint: TELEGRAM_ADAPTER_BUILD,
            source,
            chatType:    msg.chat?.type,
            hasVoice:    !!(msg as any).voice,
            hasAudio:    !!(msg as any).audio,
            hasText:     !!(msg.text ?? '').trim(),
          })
        }
        // Idempotency: defensive 'voice' / 'audio' subs would otherwise
        // double-process the same payload after 'message' already ran.
        if (!this.markMessageSeen(msg)) {
          this.logInfo('duplicate event suppressed', {
            source,
            messageId: msg.message_id,
          })
          return
        }
        // A successful message means we're alive — clear the degraded
        // flag and reset the 409 streak (something else is polling but
        // we got through, or the conflict resolved).
        this.consecutiveConflicts = 0
        if (this.state === 'degraded') this.state = 'active'
        try {
          await this.handleIncoming(msg)
        } catch (e: any) {
          this.logError(`Handler error: ${this.scrubToken(e?.message)}`, { source })
        }
      }
    this.client.on('message', dispatch('message'))
    // Defensive secondary subscriptions — Phase v4.1-3.1 + v4.1-4.
    // NTBA emits both 'message' AND the type-specific event for media
    // attachments. The 'message' handler is the primary path; these
    // catch the same payload if the primary somehow misses it. The
    // dedup guard on dispatch() makes this idempotent.
    this.client.on('voice',    dispatch('voice'))
    this.client.on('audio',    dispatch('audio'))
    this.client.on('photo',    dispatch('photo'))
    this.client.on('document', dispatch('document'))
  }

  /**
   * Phase v4.1-3.1 — message-id dedup. Returns true if this is the
   * first time we've seen `${chat_id}:${message_id}` (caller should
   * process), false if we've already handled it (caller should skip).
   * Bounded FIFO of 256 entries — older keys get evicted.
   */
  private markMessageSeen(msg: Message): boolean {
    const chatId    = msg.chat?.id
    const messageId = msg.message_id
    if (chatId === undefined || messageId === undefined) {
      // Shape we don't recognize — let it through; handleIncoming will
      // log and drop on the unrecognized-shape guard.
      return true
    }
    const key = `${chatId}:${messageId}`
    if (this.recentMessageIds.has(key)) return false
    this.recentMessageIds.add(key)
    this.recentMessageOrder.push(key)
    if (this.recentMessageOrder.length > TelegramAdapter.RECENT_MSG_LIMIT) {
      const evicted = this.recentMessageOrder.shift()
      if (evicted !== undefined) this.recentMessageIds.delete(evicted)
    }
    return true
  }

  private async handleIncoming(msg: Message): Promise<void> {
    this.lastMessageAt = Date.now()

    // Phase v4.1-3.1 — shape fingerprint at the dispatch boundary.
    // Logs at info so the live test can see "we received the update,
    // and here's what fields it has" before any gate or handler runs.
    // Pure shape only — no payload contents, no PII beyond chat type.
    const shape = {
      chatType:     msg.chat?.type,
      messageId:    msg.message_id,
      hasText:      !!(msg.text ?? '').trim(),
      hasCaption:   !!((msg as any).caption ?? '').trim(),
      hasVoice:     !!(msg as any).voice,
      hasAudio:     !!(msg as any).audio,
      hasPhoto:     !!(msg as any).photo,
      hasDocument:  !!(msg as any).document,
      hasVideo:     !!(msg as any).video,
      hasVideoNote: !!(msg as any).video_note,
      hasSticker:   !!(msg as any).sticker,
      isReply:      !!msg.reply_to_message,
      isBot:        !!msg.from?.is_bot,
    }
    this.logInfo('inbound update', shape)

    // Skip bot-authored messages — prevents loops if another bot is
    // also in the conversation, and avoids replying to our own forwards.
    if (msg.from?.is_bot) return

    // Phase v4.1-3 — detect voice/audio attachment up front so we
    // don't drop voice messages on the empty-text early-return.
    const voiceFile = (msg as any).voice as TelegramVoiceFile | undefined
    const audioFile = (msg as any).audio as TelegramAudioFile | undefined
    const hasVoice  = !!voiceFile
    const hasAudio  = !!audioFile

    // Phase v4.1-4 — photo + document detection. msg.photo is an
    // array of PhotoSize objects sorted small→large; we always pick
    // the largest. msg.document is a single object with optional
    // file_name / mime_type. Either signals "user sent media."
    const photoArr     = (msg as any).photo as TelegramPhotoSize[] | undefined
    const documentFile = (msg as any).document as TelegramDocumentFile | undefined
    const hasPhoto     = Array.isArray(photoArr) && photoArr.length > 0
    const hasDocument  = !!documentFile

    // Plain text path retains the old guard — but only when no voice
    // attachment is present. Captions are handled separately below.
    const text    = (msg.text ?? '').trim()
    const caption = ((msg as any).caption ?? '').trim()
    if (!text && !caption && !hasVoice && !hasAudio && !hasPhoto && !hasDocument) {
      // Phase v4.1-3.1 — log the dropped shape so the live test can
      // see "we got an update we didn't know how to handle." Includes
      // the field-keys list so unrecognized media (`video_note`,
      // `document` with audio MIME, future Telegram update kinds)
      // shows up loudly in the log instead of being silently swallowed.
      const shapeKeys = Object.keys(msg as unknown as Record<string, unknown>)
        .filter((k) => k !== 'chat' && k !== 'from' && k !== 'date'
                       && k !== 'message_id' && (msg as any)[k] !== undefined)
      this.logInfo('dropped: unrecognized message shape', {
        chatType: msg.chat?.type,
        keys:     shapeKeys,
      })
      return
    }

    const chatId   = String(msg.chat.id)
    const chatType = msg.chat.type
    const userId   = msg.from?.id ? String(msg.from.id) : chatId

    // ── Group routing (Phase v4.1-2 + v4.1-3) ───────────────────────
    if (chatType !== 'private') {
      // Allowlist gate. Empty allowlist = open (default behaviour;
      // works out of the box). Populated allowlist = strict opt-in.
      if (this.allowedGroups.size > 0 && !this.allowedGroups.has(chatId)) {
        this.logInfo(`group not on allowlist — ignored`, { chatId })
        return
      }
      // Rate-limit applies BEFORE all other gates so a spammer's
      // commands (and voice notes) also get suppressed.
      if (this.rateLimiter?.shouldThrottle(userId)) return

      // Cache title + bump lastMessageAt so /channel telegram groups list works.
      this.groupStore?.observeMessage(chatId, { title: msg.chat.title })

      // Slash commands only matter for the text path. Voice/audio
      // attachments never carry a slash command.
      if (text) {
        const outcome = await this.routeCommand(msg, chatId, userId)
        if (outcome) return
      }

      // Pause gate — admin can /pause without removing the bot.
      // Applied AFTER command routing so /resume can break the spell.
      if (this.groupStore?.isPaused(chatId)) {
        this.logInfo(`group paused — ignored`, { chatId })
        return
      }
      // Per-group user allowlist (set by /allowusers).
      if (this.groupStore && !this.groupStore.userIsAllowed(chatId, userId)) {
        this.logInfo(`user not on group allowlist — ignored`, { chatId, userId })
        return
      }

      // Mention gate. In groups the bot only replies when explicitly
      // addressed (mention or reply-to-bot), unless the operator has
      // flipped TELEGRAM_GROUPS_RESPOND_ALL. For voice/audio with no
      // text, the caption serves the same role; reply-to-bot also
      // counts as an address even without a caption.
      const addressedText = text || caption
      if (!this.groupsRespondAll && !this.isAddressedToBot(msg, addressedText)) {
        this.logInfo(`group message not addressed to bot — ignored`, { chatId })
        return
      }

      // Voice/audio path — gates passed, hand off to the voice handler.
      if (hasVoice || hasAudio) {
        const groupCaption = this.stripBotMention(caption)
        await this.handleVoiceMessage(
          msg,
          (voiceFile ?? audioFile) as TelegramVoiceFile,
          hasAudio,
          chatId,
          userId,
          groupCaption,
          true,
        )
        return
      }

      // Phase v4.1-4 — photo path (group).
      if (hasPhoto) {
        const groupCaption = this.stripBotMention(caption)
        await this.handlePhotoMessage(
          msg,
          photoArr as TelegramPhotoSize[],
          chatId,
          userId,
          groupCaption,
          true,
        )
        return
      }

      // Phase v4.1-4 — document path (group).
      if (hasDocument) {
        const groupCaption = this.stripBotMention(caption)
        await this.handleDocumentMessage(
          msg,
          documentFile as TelegramDocumentFile,
          chatId,
          userId,
          groupCaption,
          true,
        )
        return
      }

      const stripped = this.stripBotMention(text)
      // Phase v4.1-4.2 — same Telegram-split coalesce as the DM path
      // below. Compare the stripped text (post-mention) against the
      // recent caption, since groups require an @mention but the
      // caption is what the photo handler recorded.
      if (this.shouldSuppressAsTelegramSplit(chatId, stripped)) {
        return
      }
      const wrapped = this.wrapGroupMessage(msg, stripped)
      await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
      return
    }

    // ── Direct message path (Phase 1 behaviour preserved) ───────────
    if (!this.isAllowed(chatId)) {
      this.logInfo(`Blocked unauthorized chat: ${chatId}`)
      await this.deliverToChat(
        chatId,
        '⚠️ This chat is not on the allowlist. Add its ID to TELEGRAM_ALLOWED_CHATS to enable.',
      ).catch(() => undefined)
      return
    }

    // Rate-limit DMs too — same per-user budget across DMs and groups.
    if (this.rateLimiter?.shouldThrottle(userId)) return

    // Slash commands first (text only).
    if (text) {
      const dmOutcome = await this.routeCommand(msg, chatId, userId)
      if (dmOutcome) return
    }

    // Voice/audio DM path.
    if (hasVoice || hasAudio) {
      await this.handleVoiceMessage(
        msg,
        (voiceFile ?? audioFile) as TelegramVoiceFile,
        hasAudio,
        chatId,
        userId,
        caption,
        false,
      )
      return
    }

    // Phase v4.1-4 — photo DM path.
    if (hasPhoto) {
      await this.handlePhotoMessage(
        msg,
        photoArr as TelegramPhotoSize[],
        chatId,
        userId,
        caption,
        false,
      )
      return
    }

    // Phase v4.1-4 — document DM path.
    if (hasDocument) {
      await this.handleDocumentMessage(
        msg,
        documentFile as TelegramDocumentFile,
        chatId,
        userId,
        caption,
        false,
      )
      return
    }

    // Phase v4.1-4.2 — Telegram delivery-split coalesce. When a
    // client splits a single "send caption + photo" action into a
    // standalone text update + a photo-with-matching-caption update
    // arriving 1-10ms apart in the same poll batch, the photo's
    // `handlePhotoMessage` synchronously records its caption (BEFORE
    // any await) into `recentPhotoCaptions`. By the time this text
    // microtask resumes, the caption is in the slot — we suppress
    // the orphaned text dispatch so the user gets ONE reply (the
    // photo's annotated description), not two.
    if (this.shouldSuppressAsTelegramSplit(chatId, text)) {
      return
    }

    await this.deliverAgentReply(chatId, userId, text, msg.message_id)
  }

  /**
   * Phase v4.1-3 — voice/audio handler. Called only after the gate
   * chain (allowlist → mention → pause → user-allow → rate-limit) has
   * cleared, so we know we're allowed to spend bandwidth on getFile().
   *
   * Routing:
   *   - voice disabled (TELEGRAM_VOICE_ENABLED=false) → friendly reject
   *   - file_size > 25 MB → friendly reject (size cap)
   *   - download failure → friendly reject
   *   - transcription failure → smuggle [error annotation] into the agent
   *   - hallucination     → smuggle [noise annotation] into the agent
   *   - low confidence    → echo "🎤 _heard:_ ..." THEN smuggle transcript
   *   - confident         → silent smuggle of [transcript: "X"]
   *
   * Caption (when present) is concatenated after the transcript
   * annotation so the agent sees both signals on one user turn.
   */
  private async handleVoiceMessage(
    msg:        Message,
    file:       TelegramVoiceFile,
    isAudio:    boolean,
    chatId:     string,
    userId:     string,
    caption:    string,
    isGroup:    boolean,
  ): Promise<void> {
    this.voiceReceivedCount += 1

    // Phase v4.1-3.1 — entry-point log. If this fires, dispatch made
    // it through every gate; if it doesn't fire, the silent drop is
    // upstream in handleIncoming and the inbound-update + drop logs
    // tell us where.
    this.logInfo('voice handler entered', {
      isAudio,
      isGroup,
      fileSize:   file.file_size,
      hasCaption: caption.length > 0,
      chatId,
    })

    if (!isVoiceEnabled()) {
      await this.deliverToChat(
        chatId,
        '🎤 Voice messages are disabled. Re-enable with /channel telegram voice enable.',
      ).catch(() => undefined)
      return
    }

    // Pre-check the size hint Telegram supplies on the file. The
    // whisper-transcribe module also size-checks the on-disk file,
    // but rejecting here avoids the download round-trip when we
    // already know the payload is too big.
    const fileSize = typeof file.file_size === 'number' ? file.file_size : undefined
    if (fileSize !== undefined && fileSize > 25 * 1024 * 1024) {
      await this.deliverToChat(
        chatId,
        `🎤 Voice message is too large (${(fileSize / (1024 * 1024)).toFixed(1)} MB; cap is 25 MB). Please record a shorter clip.`,
      ).catch(() => undefined)
      return
    }

    // Download to local cache.
    let cachePath: string | null
    try {
      cachePath = await this.downloadVoiceToCache(file.file_id, isAudio)
    } catch (e: any) {
      this.logError(`voice download failed: ${this.scrubToken(e?.message)}`)
      cachePath = null
    }
    if (!cachePath) {
      await this.deliverToChat(
        chatId,
        '🎤 I couldn\'t download your voice message. Please try sending it again.',
      ).catch(() => undefined)
      return
    }

    // Transcribe via the injected (or default) Whisper chain.
    const language = (process.env.TELEGRAM_VOICE_LANGUAGE ?? '').trim() || undefined
    const transcribeOpts: TranscribeOptions = {
      filePath: cachePath,
      logger:   this.log.child('whisper'),
    }
    if (language) transcribeOpts.language = language
    let result: TranscriptionResult
    try {
      result = await this.transcribeFn(transcribeOpts)
    } catch (e: any) {
      result = {
        success: false,
        error:   `transcribe threw: ${e?.message ?? String(e)}`,
      }
    }

    // Failure / hallucination: hand the agent an "I heard noise" cue
    // so it composes the apology in its own voice. Don't echo to the
    // user directly — that's the agent's job.
    if (!result.success || result.isHallucination) {
      const reason = result.isHallucination
        ? 'the audio was unintelligible (Whisper returned a known noise pattern)'
        : (result.error ?? 'unknown error')
      const annotation =
        `[The user sent a voice message but transcription failed: ${reason}. ` +
        `Apologize briefly and ask them to type the message instead.]`
      const wrapped = isGroup ? this.wrapGroupMessage(msg, annotation) : annotation
      await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
      return
    }

    this.voiceTranscribedCount += 1
    const transcript = (result.text ?? '').trim()
    const threshold  = readConfidenceThreshold()
    // `avgLogprob` is negative; closer to 0 = more confident. Missing
    // = treat as confident (provider didn't surface logprobs at all,
    // most commonly the local Whisper.cpp path).
    const confident = result.avgLogprob === undefined
      ? true
      : result.avgLogprob >= threshold

    // Low-confidence echo lands BEFORE the agent reply so the user
    // sees what the bot heard while the agent is still thinking.
    if (!confident) {
      await this.deliverToChat(
        chatId,
        `🎤 _heard:_ "${escapeMarkdownItalic(transcript)}"`,
      ).catch(() => undefined)
    }

    const annotation = caption
      ? `[The user sent a voice message. Transcript: "${transcript}"]\n\n${caption}`
      : `[The user sent a voice message. Transcript: "${transcript}"]`
    const wrapped = isGroup ? this.wrapGroupMessage(msg, annotation) : annotation
    await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
  }

  /**
   * Phase v4.1-3 — pull the file off Telegram and write it under
   * `<aiden_root>/cache/audio/audio_<uuid12>.<ext>`. Returns the
   * absolute path on success, null on any failure (logged).
   */
  private async downloadVoiceToCache(fileId: string, isAudio: boolean): Promise<string | null> {
    if (!this.client) return null
    const cacheDir = this.getVoiceCacheDir()
    await fsPromises.mkdir(cacheDir, { recursive: true })
    const ext = isAudio ? '.mp3' : '.ogg'
    const id  = randomUUID().replace(/-/g, '').slice(0, 12)
    const outPath = path.join(cacheDir, `audio_${id}${ext}`)

    // Phase v4.1-3.1 — visible "starting download" log so a hung
    // getFileStream() (silent network stall, partial response, etc.)
    // is distinguishable from "never tried" in the live log.
    this.logInfo('downloading voice file', {
      fileIdPrefix: fileId.slice(0, 12),
      ext,
      outPath,
    })

    try {
      const stream = this.client.getFileStream(fileId)
      const writer = createWriteStream(outPath)
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject)
        writer.on('error', reject)
        writer.on('finish', () => resolve())
        stream.pipe(writer)
      })
      return outPath
    } catch (e: any) {
      this.logError(`getFileStream failed: ${this.scrubToken(e?.message)}`)
      try { await fsPromises.unlink(outPath) } catch { /* ignore */ }
      return null
    }
  }

  /**
   * Phase v4.1-3 + v4.1-4 — startup-only cache janitor. Sweeps the
   * voice / photo / document cache subdirs. For each: if the dir is
   * over 500 MB, delete files older than 7 days. No background timer;
   * defer real TTL to v4.2.
   *
   * `protected` so the smoke can construct an adapter without start()
   * and invoke the janitor directly to verify it on pre-seeded dirs.
   */
  protected async runVoiceCacheJanitor(): Promise<void> {
    await this.sweepCacheDir('voice',     this.getVoiceCacheDir())
    await this.sweepCacheDir('photos',    this.getPhotoCacheDir())
    await this.sweepCacheDir('documents', this.getDocumentCacheDir())
  }

  /**
   * Phase v4.1-4 — generic cache-dir sweep. Extracted so each media
   * type's directory uses identical policy.
   */
  private async sweepCacheDir(label: string, dir: string): Promise<void> {
    try {
      await fsPromises.mkdir(dir, { recursive: true })
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      let totalBytes = 0
      const fileInfos: Array<{ path: string; mtimeMs: number; size: number }> = []
      for (const e of entries) {
        if (!e.isFile()) continue
        const full = path.join(dir, e.name)
        try {
          const st = await fsPromises.stat(full)
          totalBytes += st.size
          fileInfos.push({ path: full, mtimeMs: st.mtimeMs, size: st.size })
        } catch { /* skip unreadable */ }
      }
      if (totalBytes <= JANITOR_THRESHOLD_BYTES) {
        this.logInfo(`${label} cache: under threshold`, {
          bytes: totalBytes,
          files: fileInfos.length,
        })
        return
      }
      const cutoff = Date.now() - JANITOR_AGE_THRESHOLD_MS
      let cleaned = 0
      let freed   = 0
      for (const f of fileInfos) {
        if (f.mtimeMs < cutoff) {
          try {
            await fsPromises.unlink(f.path)
            cleaned += 1
            freed   += f.size
          } catch { /* ignore */ }
        }
      }
      this.logInfo(
        `${label} cache: cleaned ${cleaned} files, freed ${(freed / 1024 / 1024).toFixed(1)} MB`,
        { cleaned, freedBytes: freed, totalBefore: totalBytes },
      )
    } catch (e: any) {
      this.logWarn(`${label} cache janitor: ${e?.message ?? String(e)}`)
    }
  }

  /** Phase v4.1-4 — photo cache directory. */
  getPhotoCacheDir(): string {
    return path.join(resolveAidenPaths().root, VOICE_CACHE_PARENT, PHOTO_CACHE_DIR_NAME)
  }
  /** Phase v4.1-4 — document cache directory. */
  getDocumentCacheDir(): string {
    return path.join(resolveAidenPaths().root, VOICE_CACHE_PARENT, DOCUMENT_CACHE_DIR_NAME)
  }

  /**
   * Phase v4.1-4 — photo handler. Called only after the gate chain
   * has cleared. Mirrors `handleVoiceMessage`'s shape: download to
   * cache, hand off to the photo-vision adapter, smuggle the result
   * into the agent's user turn (native attachment hint OR description
   * annotation), concat caption when present.
   */
  private async handlePhotoMessage(
    msg:        Message,
    photoArr:   TelegramPhotoSize[],
    chatId:     string,
    userId:     string,
    caption:    string,
    isGroup:    boolean,
  ): Promise<void> {
    this.photoReceivedCount += 1

    // Phase v4.1-4.2 — record caption synchronously BEFORE any await
    // so a paired text-only message (Telegram delivery split) that
    // arrived ~1ms before this photo can detect the split when its
    // microtask resumes, and suppress its dispatch. Per-chat slot;
    // the latest photo wins which is fine — we only care about the
    // most recent caption when looking for a match.
    if (caption) {
      this.recentPhotoCaptions.set(chatId, {
        caption: normalizeText(caption),
        ts:      Date.now(),
      })
    }

    if (!isMediaEnabled()) {
      await this.deliverToChat(
        chatId,
        '📎 Media (photos + documents) is disabled. Re-enable with /channel telegram media enable.',
      ).catch(() => undefined)
      return
    }

    // Pick the largest PhotoSize variant Telegram offered us.
    const largest = photoArr[photoArr.length - 1]
    const fileSize = typeof largest?.file_size === 'number' ? largest.file_size : undefined

    this.logInfo('photo handler entered', {
      isGroup,
      fileSize,
      hasCaption: caption.length > 0,
      chatId,
      width:  largest?.width,
      height: largest?.height,
    })

    if (fileSize !== undefined && fileSize > 25 * 1024 * 1024) {
      await this.deliverToChat(
        chatId,
        `📎 Photo is too large (${(fileSize / (1024 * 1024)).toFixed(1)} MB; cap is 25 MB). Please send a smaller image.`,
      ).catch(() => undefined)
      return
    }

    const cachePath = await this.downloadMediaToCache(
      largest.file_id,
      this.getPhotoCacheDir(),
      photoExtFor(largest),
      'photo',
    )
    if (!cachePath) {
      await this.deliverToChat(
        chatId,
        '📎 I couldn\'t download your photo. Please try sending it again.',
      ).catch(() => undefined)
      return
    }

    const modelInfo = this.activeModelInfo() ?? {}
    const photoOpts: PhotoOptions = {
      filePath:  cachePath,
      logger:    this.log.child('vision'),
    }
    if (modelInfo.providerId) photoOpts.providerId = modelInfo.providerId
    if (modelInfo.modelId)    photoOpts.modelId    = modelInfo.modelId

    let result: PhotoResult
    try {
      result = await this.analyzePhotoFn(photoOpts)
    } catch (e: any) {
      result = { success: false, mode: 'text', error: `analyzePhoto threw: ${e?.message ?? String(e)}` }
    }

    if (!result.success) {
      // Phase v4.1-4.2 — preserve caption on the failure path so the
      // agent still sees what the user wanted to ask about even when
      // vision couldn't describe the image.
      const baseAnnotation =
        `[The user sent a photo but description failed: ${result.error ?? 'unknown error'}. ` +
        `Apologize briefly and ask them to type the question instead.]`
      const annotation = caption ? `${baseAnnotation}\n\n${caption}` : baseAnnotation
      const wrapped = isGroup ? this.wrapGroupMessage(msg, annotation) : annotation
      await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
      return
    }

    this.photoProcessedCount += 1

    // Build the smuggled annotation. In native mode the agent loop is
    // responsible for actually attaching pixels to the user turn —
    // for v4.1-4 we hand it the cache path so it can do so. In text
    // mode we splice the auxiliary description directly.
    let annotation: string
    if (result.mode === 'native' && result.nativePath) {
      annotation = caption
        ? `[The user sent a photo. The local cache path is "${result.nativePath}". The active model supports vision — attach the photo on the user turn.]\n\n${caption}`
        : `[The user sent a photo. The local cache path is "${result.nativePath}". The active model supports vision — attach the photo on the user turn.]`
    } else {
      annotation = caption
        ? `[The user sent a photo. Description: ${result.description}]\n\n${caption}`
        : `[The user sent a photo. Description: ${result.description}]`
    }

    const wrapped = isGroup ? this.wrapGroupMessage(msg, annotation) : annotation
    await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
  }

  /**
   * Phase v4.1-4 — document handler. Splits inbound documents on
   * MIME type:
   *   - PDF → extract text, smuggle truncated content
   *   - PNG / JPG / GIF / WEBP (image-as-document) → route through
   *     the photo-vision pipeline
   *   - Anything else → friendly reject reply
   */
  private async handleDocumentMessage(
    msg:        Message,
    file:       TelegramDocumentFile,
    chatId:     string,
    userId:     string,
    caption:    string,
    isGroup:    boolean,
  ): Promise<void> {
    this.documentReceivedCount += 1

    // Phase v4.1-4.2 — same coalesce-record as photos. Documents
    // (PDFs + image-as-document) get caption-bundled annotations
    // too, so a paired text update with matching caption should be
    // suppressed.
    if (caption) {
      this.recentPhotoCaptions.set(chatId, {
        caption: normalizeText(caption),
        ts:      Date.now(),
      })
    }

    if (!isMediaEnabled()) {
      await this.deliverToChat(
        chatId,
        '📎 Media (photos + documents) is disabled. Re-enable with /channel telegram media enable.',
      ).catch(() => undefined)
      return
    }

    const ext = guessDocumentExtension(file)
    this.logInfo('document handler entered', {
      isGroup,
      fileName:   file.file_name,
      mimeType:   file.mime_type,
      fileSize:   file.file_size,
      ext,
      hasCaption: caption.length > 0,
      chatId,
    })

    if (!ext || !(ext in SUPPORTED_DOC_MIME)) {
      const supportedList = Object.keys(SUPPORTED_DOC_MIME).map((k) => k.replace(/^\./, '')).join(', ')
      await this.deliverToChat(
        chatId,
        `📎 Unsupported document type. Supported: ${supportedList}.`,
      ).catch(() => undefined)
      return
    }

    const fileSize = file.file_size
    if (typeof fileSize === 'number' && ext === '.pdf' && fileSize > 20 * 1024 * 1024) {
      await this.deliverToChat(
        chatId,
        `📎 PDF too large (${(fileSize / (1024 * 1024)).toFixed(1)} MB; cap is 20 MB). Please send a smaller file.`,
      ).catch(() => undefined)
      return
    }
    if (typeof fileSize === 'number' && ext !== '.pdf' && fileSize > 25 * 1024 * 1024) {
      await this.deliverToChat(
        chatId,
        `📎 Image-as-document too large (${(fileSize / (1024 * 1024)).toFixed(1)} MB; cap is 25 MB). Please send a smaller file.`,
      ).catch(() => undefined)
      return
    }

    const sanitizedName = sanitizeDocumentName(file.file_name ?? `document${ext}`)
    const cachePath = await this.downloadDocumentToCache(
      file.file_id,
      sanitizedName,
    )
    if (!cachePath) {
      await this.deliverToChat(
        chatId,
        '📎 I couldn\'t download your document. Please try sending it again.',
      ).catch(() => undefined)
      return
    }

    // Route image-as-document through the photo-vision pipeline so
    // the agent gets the same UX whether the user sent a photo or a
    // PNG-as-file.
    if (ext !== '.pdf') {
      const modelInfo = this.activeModelInfo() ?? {}
      const photoOpts: PhotoOptions = {
        filePath:  cachePath,
        logger:    this.log.child('vision'),
      }
      if (modelInfo.providerId) photoOpts.providerId = modelInfo.providerId
      if (modelInfo.modelId)    photoOpts.modelId    = modelInfo.modelId

      let result: PhotoResult
      try {
        result = await this.analyzePhotoFn(photoOpts)
      } catch (e: any) {
        result = { success: false, mode: 'text', error: `analyzePhoto threw: ${e?.message ?? String(e)}` }
      }
      if (!result.success) {
        // Phase v4.1-4.2 — preserve caption on the failure path.
        const baseAnnotation =
          `[The user sent an image (as a document) but description failed: ${result.error ?? 'unknown error'}. ` +
          `Apologize briefly.]`
        const annotation = caption ? `${baseAnnotation}\n\n${caption}` : baseAnnotation
        const wrapped = isGroup ? this.wrapGroupMessage(msg, annotation) : annotation
        await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
        return
      }
      this.documentProcessedCount += 1
      const baseLabel = `image (as document, "${sanitizedName}")`
      let annotation: string
      if (result.mode === 'native' && result.nativePath) {
        annotation = caption
          ? `[The user sent an ${baseLabel}. Local path: "${result.nativePath}". The active model supports vision — attach on the user turn.]\n\n${caption}`
          : `[The user sent an ${baseLabel}. Local path: "${result.nativePath}". The active model supports vision — attach on the user turn.]`
      } else {
        annotation = caption
          ? `[The user sent an ${baseLabel}. Description: ${result.description}]\n\n${caption}`
          : `[The user sent an ${baseLabel}. Description: ${result.description}]`
      }
      const wrapped = isGroup ? this.wrapGroupMessage(msg, annotation) : annotation
      await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
      return
    }

    // PDF path — extract text, truncate to budget, smuggle.
    const modelInfo = this.activeModelInfo() ?? {}
    const pdfOpts: PdfOptions = {
      filePath: cachePath,
      logger:   this.log.child('pdf'),
    }
    if (typeof modelInfo.contextWindow === 'number') pdfOpts.modelContextWindow = modelInfo.contextWindow

    let pdfResult: PdfResult
    try {
      pdfResult = await this.extractPdfFn(pdfOpts)
    } catch (e: any) {
      pdfResult = { success: false, truncated: false, error: `extractPdf threw: ${e?.message ?? String(e)}` }
    }
    if (!pdfResult.success) {
      // Phase v4.1-4.2 — preserve caption on PDF failure path.
      const baseAnnotation =
        `[The user sent a PDF "${sanitizedName}" but extraction failed: ${pdfResult.error ?? 'unknown error'}. ` +
        `Apologize briefly and ask them to retry or paste the relevant text.]`
      const annotation = caption ? `${baseAnnotation}\n\n${caption}` : baseAnnotation
      const wrapped = isGroup ? this.wrapGroupMessage(msg, annotation) : annotation
      await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
      return
    }
    this.documentProcessedCount += 1

    const truncationNote = pdfResult.truncated
      ? ` Note: PDF truncated to fit context. Original was ${pdfResult.originalChars ?? '?'} chars.`
      : ''
    let annotation =
      `[The user sent a PDF "${sanitizedName}". Extracted text:\n${pdfResult.text ?? ''}` +
      (truncationNote ? `\n${truncationNote.trim()}` : '') +
      `]`
    if (caption) annotation = `${annotation}\n\n${caption}`
    const wrapped = isGroup ? this.wrapGroupMessage(msg, annotation) : annotation
    await this.deliverAgentReply(chatId, userId, wrapped, msg.message_id)
  }

  /**
   * Phase v4.1-4 — generic media downloader. Streams the file from
   * Telegram into the given cache directory under
   * `audio_<uuid12>.<ext>` for voice and `photo_<uuid12>.<ext>` for
   * photos, etc. Returns absolute path on success or null on failure.
   */
  private async downloadMediaToCache(
    fileId:   string,
    cacheDir: string,
    ext:      string,
    label:    string,
  ): Promise<string | null> {
    if (!this.client) return null
    await fsPromises.mkdir(cacheDir, { recursive: true })
    const id = randomUUID().replace(/-/g, '').slice(0, 12)
    const outPath = path.join(cacheDir, `${label}_${id}${ext}`)
    this.logInfo(`downloading ${label} file`, {
      fileIdPrefix: fileId.slice(0, 12),
      ext,
      outPath,
    })
    try {
      const stream = this.client.getFileStream(fileId)
      const writer = createWriteStream(outPath)
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject)
        writer.on('error', reject)
        writer.on('finish', () => resolve())
        stream.pipe(writer)
      })
      return outPath
    } catch (e: any) {
      this.logError(`getFileStream failed (${label}): ${this.scrubToken(e?.message)}`)
      try { await fsPromises.unlink(outPath) } catch { /* ignore */ }
      return null
    }
  }

  /**
   * Phase v4.1-4 — document download with original-name preservation.
   * `doc_<uuid12>_<sanitized_filename>` so log lines and agent
   * annotations carry a human-readable name.
   */
  private async downloadDocumentToCache(
    fileId:        string,
    sanitizedName: string,
  ): Promise<string | null> {
    if (!this.client) return null
    const cacheDir = this.getDocumentCacheDir()
    await fsPromises.mkdir(cacheDir, { recursive: true })
    const id = randomUUID().replace(/-/g, '').slice(0, 12)
    const outPath = path.join(cacheDir, `doc_${id}_${sanitizedName}`)
    this.logInfo('downloading document file', {
      fileIdPrefix: fileId.slice(0, 12),
      sanitizedName,
      outPath,
    })
    try {
      const stream = this.client.getFileStream(fileId)
      const writer = createWriteStream(outPath)
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject)
        writer.on('error', reject)
        writer.on('finish', () => resolve())
        stream.pipe(writer)
      })
      return outPath
    } catch (e: any) {
      this.logError(`getFileStream failed (document): ${this.scrubToken(e?.message)}`)
      try { await fsPromises.unlink(outPath) } catch { /* ignore */ }
      return null
    }
  }

  /**
   * Send a typing indicator + route through the agent + deliver reply.
   * Extracted from the original handleIncoming so DMs and groups share
   * the same outbound path.
   */
  private async deliverAgentReply(
    chatId: string,
    userId: string,
    text: string,
    msgIdForDedup?: number,
  ): Promise<void> {
    // Phase v4.1-4.2 — outbound delivery dedup. When `msgIdForDedup`
    // is provided, ensure exactly one reply ever fires for that
    // `${chat_id}:${msg_id}` regardless of how the call landed here
    // (race, future regression in dispatch dedup, multi-handler
    // bug). Bounded FIFO of 256 keys; eviction order = insertion.
    if (typeof msgIdForDedup === 'number') {
      const key = `${chatId}:${msgIdForDedup}`
      if (this.repliedMessageIds.has(key)) {
        this.logInfo('duplicate delivery suppressed', { chatId, msgId: msgIdForDedup })
        return
      }
      this.repliedMessageIds.add(key)
      this.repliedMessageOrder.push(key)
      if (this.repliedMessageOrder.length > TelegramAdapter.REPLIED_MSG_LIMIT) {
        const evicted = this.repliedMessageOrder.shift()
        if (evicted !== undefined) this.repliedMessageIds.delete(evicted)
      }
    }
    try {
      await this.client?.sendChatAction(chatId, 'typing')
    } catch {
      /* non-fatal — proceed with the answer */
    }
    // v4.12 DC.2 — the agent reply is now delivered THROUGH the DeliveryContext
    // seam: processMessage passes a delivery binding to gateway.routeMessage,
    // which constructs the immutable per-turn ctx and calls ctx.send('final',…).
    // ctx.send routes to the driver below → the UNCHANGED deliverToChat, so
    // chunking/parse_mode/429-retry are byte-identical. The old direct
    // deliverToChat call here is removed (the seam owns delivery; keeping it
    // would double-send).
    await this.processMessage(chatId, userId, text, this.buildDeliveryBinding(chatId))
  }

  /**
   * v4.12 DC.2 — the Telegram DeliveryDriver + declared capabilities for a
   * given chat. `deliver('final' | 'status')` routes plain text through the
   * UNCHANGED `deliverToChat` (chunkAtBoundary + parse_mode + 429/parse retry),
   * guaranteeing byte-identical behaviour. Media/voice/edit/progress kinds are
   * not wired through the seam yet — they return an honest not-supported
   * receipt rather than silently dropping (nothing calls them in DC.2).
   */
  private buildDeliveryBinding(chatId: string): DeliveryBinding {
    return {
      capabilities:     TELEGRAM_DELIVERY_CAPABILITIES,
      firstMessageHint: TELEGRAM_FIRST_MESSAGE_HINT,
      driver: {
        deliver: async (kind, payload) => {
          if (kind === 'final' || kind === 'status') {
            const r = await this.deliverToChat(chatId, payload.text ?? '')
            const receipt: DeliveryReceipt = { ok: r.ok, kind }
            if (r.terminal) receipt.terminal = true   // → seam retires the target
            if (r.partial)  receipt.partial  = true   // → some chunks landed, some didn't
            return receipt
          }
          return {
            ok:    false,
            kind,
            error: `Telegram DC.2 does not yet route '${kind}' delivery through the seam`,
          }
        },
      },
    }
  }

  /**
   * Phase v4.1-4.2 — Telegram delivery-split detector. Returns true
   * when the given text matches a recent photo caption from the same
   * chat (within `TELEGRAM_PHOTO_COALESCE_MS`, default 500ms). The
   * text fall-through paths in `handleIncoming` use this to suppress
   * orphaned text dispatches that some clients emit alongside a
   * photo+caption upload. Logs the suppression with the time delta
   * so the live test can verify the coalesce window is sized right.
   */
  private shouldSuppressAsTelegramSplit(chatId: string, text: string): boolean {
    const recent = this.recentPhotoCaptions.get(chatId)
    if (!recent) return false
    const windowMs = readCoalesceWindowMs()
    const delta = Date.now() - recent.ts
    if (delta >= windowMs) return false
    if (normalizeText(text) !== recent.caption) return false
    this.logInfo('text suppressed: matches recent photo caption (telegram delivery split)', {
      chatId,
      delta,
      window: windowMs,
    })
    return true
  }

  /**
   * Phase v4.1-2 — command routing. Returns true when the message was
   * consumed as a slash command (caller skips the agent dispatch).
   * Pulls out admin-only states (pause / resume / clear / allowusers)
   * and surfaces the right user-visible reply when one is needed.
   */
  private async routeCommand(
    msg: Message,
    chatId: string,
    userId: string,
  ): Promise<boolean> {
    if (!this.commandRouter) {
      // Fallback to the legacy handler when the router didn't init —
      // preserves Phase 1 behaviour for DMs even if group machinery
      // bricked at start().
      const text = msg.text ?? ''
      if (!text.startsWith('/')) return false
      return this.handleSlashCommand(chatId, text)
    }
    const text = msg.text ?? ''
    if (!text.startsWith('/')) return false

    const outcome = await this.commandRouter.route(msg)
    switch (outcome.kind) {
      case 'agent':    return false
      case 'handled':  return true
      case 'reply':
        await this.deliverToChat(chatId, outcome.text)
        return true
      case 'cleared':
        await this.processMessage(chatId, userId, '/clear')
        await this.deliverToChat(chatId, '✓ Memory cleared for this chat.')
        return true
      case 'paused':
        await this.deliverToChat(chatId, '⏸ Bot paused in this group. Run /resume to re-enable.')
        return true
      case 'resumed':
        await this.deliverToChat(chatId, '▶ Bot resumed in this group.')
        return true
    }
  }

  /**
   * True when the group message is explicitly addressed to the bot:
   *   - The text begins with `@bot_username`.
   *   - The message is a reply to one of the bot's own messages.
   * Both signals come from Telegram natively — we don't try to NLP
   * "hey aiden" or similar; that's a Phase 3 add-on.
   *
   * Phase v4.1-3 — also honours `caption_entities` so a voice message
   * with `@bot_username summarise this` in its caption counts as an
   * address. Voice/audio without text uses the caption (or
   * reply-to-bot) as its mention signal.
   */
  private isAddressedToBot(msg: Message, text: string): boolean {
    const username = (this.botUsername ?? '').toLowerCase()
    if (username && text.toLowerCase().startsWith(`@${username}`)) return true
    // Telegram exposes `entities` (text messages) and `caption_entities`
    // (media messages with captions). Check both — for voice messages
    // in groups, the mention lives on the caption.
    const entitySources = [
      msg.entities,
      (msg as any).caption_entities as MessageEntity[] | undefined,
    ]
    for (const entities of entitySources) {
      if (!entities) continue
      for (const e of entities) {
        if (e.type === 'mention') {
          const slice = text.slice(e.offset, e.offset + e.length).toLowerCase()
          if (username && slice === `@${username}`) return true
        }
      }
    }
    if (msg.reply_to_message?.from?.is_bot && msg.reply_to_message.from.username
        && msg.reply_to_message.from.username.toLowerCase() === username) {
      return true
    }
    return false
  }

  /** Strip a leading `@bot_username ` so the agent sees a clean prompt. */
  private stripBotMention(text: string): string {
    const username = (this.botUsername ?? '').toLowerCase()
    if (!username) return text
    const m = text.match(new RegExp(`^@${username}\\s+`, 'i'))
    return m ? text.slice(m[0].length) : text
  }

  /**
   * Phase v4.1-2 prompt-injection defence-in-depth. Wrap group
   * messages in a delimiter that clearly separates the model's system
   * persona from user-supplied content. The agent's prompt stack treats
   * this as a quoted user payload — a malicious "ignore all previous
   * instructions" lands inside `<message>...</message>` rather than as
   * an apparent system override.
   */
  private wrapGroupMessage(msg: Message, content: string): string {
    const username = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name ?? 'unknown')
    const groupName = msg.chat.title ?? `chat ${msg.chat.id}`
    return (
      `<message from="${escapeForXml(username)}" group="${escapeForXml(groupName)}">\n` +
      `${content}\n` +
      `</message>`
    )
  }

  // v4.12 DC.2 — optional `delivery` binding. When present (the agent-reply
  // path via deliverAgentReply), gateway.routeMessage constructs the immutable
  // per-turn ctx and delivers the final through the seam. When absent (internal
  // forwards like the /clear command), behaviour is exactly as before: the
  // string is returned and the caller decides what to send.
  private async processMessage(
    chatId: string,
    userId: string,
    text: string,
    delivery?: DeliveryBinding,
  ): Promise<string> {
    try {
      return await gateway.routeMessage({
        channel:   'telegram',
        channelId: chatId,
        userId,
        text,
        timestamp: Date.now(),
      }, delivery)
    } catch (e: any) {
      this.logError(`routeMessage error: ${this.scrubToken(e?.message)}`)
      return '❌ Something went wrong. Try again.'
    }
  }

  // In-channel slash commands. Returns true when handled — caller skips
  // the agent loop. Agent-style prompts (e.g. "/summarize this") fall
  // through and reach the agent unchanged.
  private async handleSlashCommand(chatId: string, raw: string): Promise<boolean> {
    const cmd = raw.split(/\s+/)[0]?.toLowerCase().split('@')[0]
    if (!cmd) return false

    if (cmd === '/start' || cmd === '/help') {
      await this.deliverToChat(
        chatId,
        '*Aiden* — your local AI assistant.\n\n' +
          'Send any message to start. Built-in commands:\n' +
          '`/help`    show this message\n' +
          '`/status`  bot health check\n' +
          '`/clear`   wipe this chat\'s memory',
      )
      return true
    }
    if (cmd === '/status') {
      await this.deliverToChat(chatId, this.healthy ? '✓ Online' : '⚠ Degraded')
      return true
    }
    if (cmd === '/clear') {
      // Per-chat memory isolation hangs off `gateway.routeMessage` resolving
      // a stable session id from `(channel, channelId)`. Forward the clear
      // intent through the agent path so the existing /clear handler runs;
      // tolerates absence (early Phase 2 will give us a direct hook).
      await this.processMessage(chatId, chatId, '/clear')
      await this.deliverToChat(chatId, '✓ Memory cleared for this chat.')
      return true
    }
    return false
  }

  // Phase v4.1-2 — `replyToGroup` retired. Groups are now first-class
  // (mention-only by default, allowlist-gated, rate-limited). The
  // legacy refusal stub no longer fires.

  // ── Outbound ─────────────────────────────────────────────────

  private async deliverToChat(chatId: string, text: string): Promise<DeliverToChatResult> {
    if (!this.client) return { ok: false, sent: 0, total: 0 }

    const chunks = this.chunkAtBoundary(text, MAX_MESSAGE_CHARS)
    let sent = 0
    let terminal = false
    for (const chunk of chunks) {
      const outcome = await this.sendChunk(chatId, chunk)
      if (outcome === 'sent') { sent++; continue }
      if (outcome === 'terminal') {
        // Target is gone (bot blocked / chat deleted) — every remaining chunk
        // would fail identically, so stop and signal the dead-target guard.
        terminal = true
        break
      }
      // v4.15 — a TRANSIENT chunk failure no longer abandons the rest: log it
      // and keep going so a single bad chunk can't swallow the whole reply.
    }
    const total = chunks.length
    // ok when every chunk landed (0 chunks = empty reply = vacuously ok, as before).
    return { ok: sent === total, partial: sent > 0 && sent < total, terminal, sent, total }
  }

  // Send ONE chunk with the unchanged parse-mode + bounded 429 retries. Returns
  // 'sent', 'terminal' (target unreachable — 403/blocked/chat-gone), or
  // 'transient' (a recoverable failure the caller should step past).
  private async sendChunk(chatId: string, chunk: string): Promise<'sent' | 'terminal' | 'transient'> {
    try {
      await this.client!.sendMessage(chatId, chunk, { parse_mode: DEFAULT_PARSE_MODE })
      return 'sent'
    } catch (e: any) {
      // Retry once without parse_mode in case the chunk's markdown is malformed
      // (Telegram is strict about Markdown V1). Keeps replies visible even when
      // the model emits broken backticks.
      const message = (e?.message ?? '').toLowerCase()
      if (message.includes('parse')) {
        try {
          await this.client!.sendMessage(chatId, chunk)
          return 'sent'
        } catch (inner: any) {
          this.logError(`sendMessage retry failed: ${this.scrubToken(inner?.message)}`)
          return isTerminalDeliveryError(inner) ? 'terminal' : 'transient'
        }
      }
      // Telegram returns 429 with a `parameters.retry_after` field surfaced by
      // node-telegram-bot-api as `e.response.parameters`.
      const retryAfter = e?.response?.body?.parameters?.retry_after
      if (typeof retryAfter === 'number' && retryAfter > 0 && retryAfter <= 10) {
        await new Promise(r => setTimeout(r, retryAfter * 1000))
        try {
          await this.client!.sendMessage(chatId, chunk, { parse_mode: DEFAULT_PARSE_MODE })
          return 'sent'
        } catch (inner: any) {
          this.logError(`sendMessage post-429 failed: ${this.scrubToken(inner?.message)}`)
          return isTerminalDeliveryError(inner) ? 'terminal' : 'transient'
        }
      }
      this.logError(`sendMessage failed: ${this.scrubToken(e?.message)}`)
      return isTerminalDeliveryError(e) ? 'terminal' : 'transient'
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  private isAllowed(chatId: string): boolean {
    if (this.allowedChats.size === 0) return true
    return this.allowedChats.has(chatId)
  }

  /**
   * Split `text` into pieces no larger than `limit` bytes, preferring
   * to break at a newline, falling back to a space, finally a hard cut.
   * The split point must fall in the second half of the chunk so a long
   * URL near the start doesn't force a tiny chunk.
   */
  private chunkAtBoundary(text: string, limit: number): string[] {
    if (text.length <= limit) return [text]

    const out: string[] = []
    let cursor = text
    while (cursor.length > 0) {
      if (cursor.length <= limit) {
        out.push(cursor)
        break
      }
      let cut = cursor.lastIndexOf('\n', limit)
      if (cut < limit / 2) cut = cursor.lastIndexOf(' ', limit)
      if (cut < limit / 2) cut = limit
      out.push(cursor.slice(0, cut))
      cursor = cursor.slice(cut).replace(/^\s+/, '')
    }
    return out
  }

  /**
   * Telegram tokens take the form `<bot_id>:<secret>` and travel through
   * the request URL. A leaked token in stack traces / log lines is the
   * single biggest credential risk for this adapter, so every error
   * message gets scrubbed before it reaches the console.
   */
  private scrubToken(message: unknown): string {
    if (typeof message !== 'string') return String(message ?? '')
    if (!this.token) return message
    return message.split(this.token).join('[redacted]')
  }

  /** Best-effort `setMyCommands` so the `/` menu in Telegram is helpful. */
  private async publishBotCommands(): Promise<void> {
    if (!this.client) return
    await this.client.setMyCommands([
      { command: 'help',   description: 'Show available commands' },
      { command: 'status', description: 'Bot health check' },
      { command: 'clear',  description: 'Wipe this chat\'s memory' },
    ])
  }
}

/**
 * Phase v4.1-2 — minimal XML attribute escape so usernames /
 * group titles can't close the wrap-message envelope. Only the five
 * predefined entities — XML 1.0 doesn't need anything else.
 */
function escapeForXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Phase v4.1-1.2 — peek at a polling-error to see if it's the 409
 * Conflict that signals "another instance is already polling this bot".
 * `node-telegram-bot-api` surfaces these as `ETELEGRAM` errors with the
 * Telegram API description in `err.message`. We match a few shapes
 * conservatively — better to miss-classify a 409 as a regular polling
 * error (one extra log line) than the reverse (silently lose 409
 * detection because the lib changed its message shape).
 */
/**
 * Phase v4.1-3 — minimal shape for `msg.voice` / `msg.audio`. The NTBA
 * type bindings don't always export these consistently, so we declare
 * exactly the fields we touch here. Anything else can ride on `as any`
 * at the call site.
 */
interface TelegramVoiceFile {
  file_id:    string
  file_size?: number
  mime_type?: string
}

interface TelegramAudioFile extends TelegramVoiceFile {
  duration?: number
}

/**
 * Phase v4.1-4 — minimal shapes for `msg.photo[]` and `msg.document`.
 * Telegram Bot API spec: `Message.photo` is an array of `PhotoSize`
 * objects sorted small→large; `Message.document` is a single `Document`.
 */
interface TelegramPhotoSize {
  file_id:    string
  file_size?: number
  width?:     number
  height?:    number
}

interface TelegramDocumentFile {
  file_id:    string
  file_name?: string
  mime_type?: string
  file_size?: number
}

/**
 * Phase v4.1-4 — TELEGRAM_MEDIA_ENABLED gate. Controls photos +
 * documents; voice retains its own TELEGRAM_VOICE_ENABLED so
 * operators can disable one without the other. Default true.
 */
function isMediaEnabled(): boolean {
  const raw = (process.env.TELEGRAM_MEDIA_ENABLED ?? '').trim().toLowerCase()
  return raw !== 'false'
}

/**
 * Phase v4.1-4 — derive a sane file extension for a `PhotoSize` blob.
 * PhotoSize doesn't carry MIME or filename, so we default to .jpg
 * (Telegram's photo flow always re-encodes to JPEG).
 */
function photoExtFor(_p: TelegramPhotoSize): string {
  return '.jpg'
}

/**
 * Phase v4.1-4 — pick `.<ext>` for a document. Order:
 *   1. file_name extension if present and recognised
 *   2. mime_type reverse-lookup
 *   3. undefined (caller will reject as unsupported)
 */
function guessDocumentExtension(file: TelegramDocumentFile): string | undefined {
  const name = file.file_name ?? ''
  const dotIdx = name.lastIndexOf('.')
  if (dotIdx >= 0) {
    const ext = name.slice(dotIdx).toLowerCase()
    if (ext in SUPPORTED_DOC_MIME) return ext
  }
  const mime = (file.mime_type ?? '').toLowerCase().trim()
  if (!mime) return undefined
  for (const [k, v] of Object.entries(SUPPORTED_DOC_MIME)) {
    if (v === mime) return k
  }
  return undefined
}

/**
 * Phase v4.1-4 — sanitize a filename for safe use on the local cache
 * path AND inside agent annotations / log lines. Strip everything
 * outside `[A-Za-z0-9_.\- ]`, collapse whitespace, cap at 80 chars.
 * Empty result falls back to "file" so we never end up with an empty
 * cache filename.
 */
function sanitizeDocumentName(name: string): string {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || 'file'
}

/**
 * Phase v4.1-3 — read TELEGRAM_VOICE_ENABLED at call time. Default is
 * true ("works out of the box"); only the literal string "false"
 * (case-insensitive) disables it. Anything else (empty, missing,
 * "true", "1") leaves voice on.
 */
/**
 * Phase v4.1-3.2 — `allowed_updates` parser. Empty string / unset env
 * returns `[]` which Telegram interprets as "all default types"
 * (everything except chat_member, message_reaction,
 * message_reaction_count). Operators who want those exotic types
 * pass a CSV via `TELEGRAM_ALLOWED_UPDATES`.
 *
 * Whitelist of valid Telegram update types — anything the user
 * passes that we don't recognise is silently dropped (with the rest
 * of the list still applied). Better than crashing the adapter on
 * a typo.
 */
const VALID_UPDATE_TYPES: ReadonlySet<string> = new Set([
  'message', 'edited_message', 'channel_post', 'edited_channel_post',
  'business_connection', 'business_message', 'edited_business_message',
  'deleted_business_messages', 'message_reaction', 'message_reaction_count',
  'inline_query', 'chosen_inline_result', 'callback_query',
  'shipping_query', 'pre_checkout_query', 'poll', 'poll_answer',
  'my_chat_member', 'chat_member', 'chat_join_request',
  'chat_boost', 'removed_chat_boost', 'purchased_paid_media',
])

function readAllowedUpdates(): string[] {
  const raw = (process.env.TELEGRAM_ALLOWED_UPDATES ?? '').trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => VALID_UPDATE_TYPES.has(s))
}

/**
 * Phase v4.1-4.2 — normalize text for the delivery-split coalesce
 * comparison. Trim, lowercase, collapse all whitespace runs to a
 * single space. Matches the user's "what image is this " typed
 * with trailing space against the photo caption "what image is this".
 */
function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Phase v4.1-4.2 — coalesce window for the Telegram delivery-split
 * detector. Default 500 ms covers the observed ~1 ms split + any
 * client/network jitter without inflating false-positive risk.
 * Operators can override via `TELEGRAM_PHOTO_COALESCE_MS`.
 */
function readCoalesceWindowMs(): number {
  const raw = (process.env.TELEGRAM_PHOTO_COALESCE_MS ?? '').trim()
  if (!raw) return 500
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 500
}

function isVoiceEnabled(): boolean {
  const raw = (process.env.TELEGRAM_VOICE_ENABLED ?? '').trim().toLowerCase()
  return raw !== 'false'
}

/**
 * Phase v4.1-3 — confidence threshold (avg_logprob floor) below
 * which the adapter echoes the heard transcript before answering.
 * Default −0.5 matches Whisper's empirical "borderline" point — at
 * −0.7 transcripts are usually mostly-right but with a wobble.
 */
function readConfidenceThreshold(): number {
  const raw = (process.env.TELEGRAM_VOICE_CONFIDENCE_THRESHOLD ?? '').trim()
  if (!raw) return DEFAULT_CONFIDENCE_FLOOR
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : DEFAULT_CONFIDENCE_FLOOR
}

/**
 * Phase v4.1-3 — escape characters that would close a Markdown italic
 * span in our `🎤 _heard:_ "..."` echo. Also trims leading/trailing
 * whitespace. Conservative — we just need the underscore to render.
 */
function escapeMarkdownItalic(s: string): string {
  return s.replace(/_/g, '\\_')
}

function isConflictError(err: unknown): boolean {
  if (!err) return false
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase()
  // Common shapes:
  //   "ETELEGRAM: 409 Conflict: terminated by other getUpdates request"
  //   "Conflict: terminated by other getUpdates"
  //   { code: 'ETELEGRAM', response: { statusCode: 409 } }
  if (msg.includes('409') && msg.includes('conflict')) return true
  if (msg.includes('terminated by other getupdates')) return true
  const status = (err as { response?: { statusCode?: number } })?.response?.statusCode
  if (status === 409) return true
  return false
}
